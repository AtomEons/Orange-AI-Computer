// 07-VISUAL/structural/binders/region-grow.mjs
//
// AE Eyes object-binder — Gestalt region growing.
//
// Discipline: proximity + similarity of local texture statistics. The frame is
// tiled into fixed cells; each cell holds a small feature vector describing its
// local intensity, contrast, and gradient magnitude — NEVER gradient
// orientation. Seed cells (interesting cells whose features differ notably from
// the frame mean) are grown by BFS across 4-neighbors while neighbor features
// stay within a Euclidean threshold in normalized space.
//
// Why no gradient orientation? An earlier binder over-segmented natural imagery
// by keying similarity on orientation — a smooth curved fruit rim carries many
// different orientations, which shattered the object into many small entities.
// Magnitude + intensity + local variance are shape-tolerant descriptors that
// stay stable across a curved surface.
//
// Determinism: pure function of (R, width, height, opts). No RNG. No time.
// Bun-only, no paid deps, no network.
//
// Honest limits (also emitted in notes[]):
//   - regions with high internal texture variance (striped shirts, honeycomb,
//     patterned wrapping) will fragment — the similarity metric is a local
//     mean, so a periodic pattern reads as a different-cell every period.
//   - very small objects (< cellSize) collapse into one cell of the background.
//   - the seed criterion (differs from frame mean by > seedThreshold) will
//     produce zero seeds on a uniformly textured frame — that is honest.

export const DISCIPLINE = "region-grow";

const DEFAULTS = Object.freeze({
  // Cell size in pixels. 12 is a middle ground: small enough that a fruit-sized
  // object occupies many cells (fine bounding boxes), big enough that a single
  // cell's mean/variance is a stable estimator.
  cellSize: 12,

  // Feature-space Euclidean similarity threshold for region growth. Features
  // are normalized to unit-ish scale so this is roughly a fraction of the
  // dynamic range. Tightened after fruits.jpg tuning — natural imagery has
  // very smooth soft transitions that a loose threshold walks straight across.
  similarityThreshold: 0.06,

  // Seed criterion — a cell qualifies as a seed if its feature vector's
  // Euclidean distance from the frame-mean feature vector exceeds this. Lower
  // → more seeds → more (often smaller) entities. Higher → fewer seeds → risk
  // of missing subtle objects. 0.25 gives ~10 entities on fruits.jpg.
  seedThreshold: 0.25,

  // Minimum number of cells a grown region must contain to become an entity.
  // Rejects singleton speckle. 4 = a 2x2 patch; 6 keeps the entity list close
  // to the contract goal of 5-15 entities on a fruit still.
  minCells: 6,

  // Weights on the three features when composing the feature vector. Each is
  // normalized separately; weights let the caller emphasize brightness vs.
  // contrast vs. edge density. Defaults are equal.
  weightMean: 1.0,
  weightVariance: 1.0,
  weightGradMag: 1.0,

  // Growth mode:
  //   "seed"   — similarity is measured against the seed cell's features. A
  //              growth cannot drift arbitrarily far in feature space — it
  //              stays a neighborhood of the seed. Safer on natural imagery.
  //   "adjacent" — similarity is measured against the CURRENT cell (classic
  //              chained growth). Follows shading gradients but can walk
  //              across an entire scene on soft transitions.
  growthMode: "seed",

  // Hard cap on region size as a fraction of total cells. Prevents a single
  // seed from swallowing the frame when a scene has a large connected
  // background that satisfies the similarity metric. A region exceeding this
  // bound is truncated (BFS stops) and disclosed in notes[].
  maxRegionFraction: 0.35,
});

/**
 * @param {Float32Array} R      photoreceptor-processed luminance, 0..1, w*h
 * @param {number} width
 * @param {number} height
 * @param {object} opts         binder-specific options
 * @returns {{ discipline: string, entities: Array, notes: string[] }}
 */
export function bind(R, width, height, opts = {}) {
  const cfg = Object.assign({}, DEFAULTS, opts || {});
  const notes = [];

  // --- guardrails ---
  if (!(R instanceof Float32Array) || R.length !== width * height) {
    notes.push(
      `region-grow: invalid input — expected Float32Array of length ${width * height}, got length ${R ? R.length : "null"}. Emitting zero entities.`
    );
    return { discipline: DISCIPLINE, entities: [], notes };
  }
  if (width < cfg.cellSize * 2 || height < cfg.cellSize * 2) {
    notes.push(
      `region-grow: frame ${width}x${height} smaller than 2 cells at cellSize=${cfg.cellSize}. Emitting zero entities.`
    );
    return { discipline: DISCIPLINE, entities: [], notes };
  }

  const cs = cfg.cellSize | 0;
  const cols = Math.floor(width / cs);
  const rows = Math.floor(height / cs);
  const nCells = cols * rows;

  // --- pass 1: cell feature vectors ---
  // For each cell: mean(R), variance(R), mean(|∇R|). Gradient uses a
  // central-difference pair — Sobel-lite — over the whole frame first, then
  // aggregated into cells alongside the intensity aggregates.
  const gradMag = new Float32Array(width * height);
  // central-difference gradient, magnitude only. Bounds: interior pixels only,
  // border pixels get gradMag=0 (contribute nothing extra to a cell's mean).
  for (let y = 1; y < height - 1; y++) {
    const rowBase = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = rowBase + x;
      const gx = R[i + 1] - R[i - 1];
      const gy = R[i + width] - R[i - width];
      // magnitude only — orientation is DELIBERATELY discarded.
      gradMag[i] = Math.hypot(gx, gy);
    }
  }

  const featMean = new Float32Array(nCells);
  const featVar = new Float32Array(nCells);
  const featGrad = new Float32Array(nCells);

  for (let cy = 0; cy < rows; cy++) {
    const y0 = cy * cs;
    const y1 = y0 + cs;
    for (let cx = 0; cx < cols; cx++) {
      const x0 = cx * cs;
      const x1 = x0 + cs;
      let sum = 0, sumSq = 0, sumG = 0, n = 0;
      for (let y = y0; y < y1; y++) {
        const rowBase = y * width;
        for (let x = x0; x < x1; x++) {
          const v = R[rowBase + x];
          sum += v;
          sumSq += v * v;
          sumG += gradMag[rowBase + x];
          n++;
        }
      }
      const mean = sum / n;
      // Population variance. Sample variance would use (n-1); with n=144 for a
      // 12x12 cell the difference is <1% and this stays deterministic.
      const variance = Math.max(0, sumSq / n - mean * mean);
      const ci = cy * cols + cx;
      featMean[ci] = mean;
      featVar[ci] = variance;
      featGrad[ci] = sumG / n;
    }
  }

  // --- normalize features to comparable scales ---
  // mean ∈ [0,1] already. variance and gradient are unbounded from above; we
  // normalize them by their observed max across cells so weights compose sanely.
  const varMax = maxOf(featVar) || 1;
  const gradMax = maxOf(featGrad) || 1;
  const normMean = featMean; // already 0..1
  const normVar = new Float32Array(nCells);
  const normGrad = new Float32Array(nCells);
  for (let i = 0; i < nCells; i++) {
    normVar[i] = featVar[i] / varMax;
    normGrad[i] = featGrad[i] / gradMax;
  }

  // Frame-mean feature vector.
  let mMean = 0, mVar = 0, mGrad = 0;
  for (let i = 0; i < nCells; i++) {
    mMean += normMean[i];
    mVar += normVar[i];
    mGrad += normGrad[i];
  }
  mMean /= nCells;
  mVar /= nCells;
  mGrad /= nCells;

  const wM = cfg.weightMean;
  const wV = cfg.weightVariance;
  const wG = cfg.weightGradMag;

  // --- pass 2: seed selection ---
  // A cell is a seed if its distance from the frame-mean feature vector is
  // above cfg.seedThreshold. Seeds are visited in a deterministic order —
  // top-to-bottom, left-to-right — so output is fully reproducible.
  const isSeed = new Uint8Array(nCells);
  for (let i = 0; i < nCells; i++) {
    const dM = (normMean[i] - mMean) * wM;
    const dV = (normVar[i] - mVar) * wV;
    const dG = (normGrad[i] - mGrad) * wG;
    const dist = Math.sqrt(dM * dM + dV * dV + dG * dG);
    if (dist >= cfg.seedThreshold) isSeed[i] = 1;
  }

  // --- pass 3: region growing ---
  // BFS from each unvisited seed cell. Similarity is measured against either
  // the seed cell (growthMode="seed") or the current cell (growthMode="adjacent").
  //   - "seed" bounds the feature-space drift; safer on natural imagery where
  //     smooth shading otherwise lets a growth walk across the whole scene.
  //   - "adjacent" is the classic chained variant; models Gestalt similarity
  //     more literally but is easily fooled by soft transitions.
  // Regions are also hard-capped at cfg.maxRegionFraction of nCells to keep
  // no single seed from swallowing the frame when the similarity metric fails.
  const assigned = new Int32Array(nCells); // 0 = unassigned; else regionId+1
  const regions = []; // { cells: number[], truncated: bool }

  const distSq = (a, b) => {
    const dM = (normMean[a] - normMean[b]) * wM;
    const dV = (normVar[a] - normVar[b]) * wV;
    const dG = (normGrad[a] - normGrad[b]) * wG;
    return dM * dM + dV * dV + dG * dG;
  };
  const simThreshSq = cfg.similarityThreshold * cfg.similarityThreshold;
  const maxRegionCells = Math.max(cfg.minCells, Math.floor(nCells * cfg.maxRegionFraction));
  const seedMode = cfg.growthMode === "seed";
  let truncatedCount = 0;

  // Deterministic seed order.
  for (let ci = 0; ci < nCells; ci++) {
    if (!isSeed[ci] || assigned[ci]) continue;
    const regionId = regions.length;
    const cells = [ci];
    assigned[ci] = regionId + 1;
    let truncated = false;
    // BFS
    let head = 0;
    while (head < cells.length) {
      if (cells.length >= maxRegionCells) {
        truncated = true;
        break;
      }
      const cur = cells[head++];
      const cx = cur % cols;
      const cy = (cur - cx) / cols;
      // 4-neighbors — deterministic order: N, E, S, W
      const neighbors = [
        cy > 0 ? cur - cols : -1,
        cx < cols - 1 ? cur + 1 : -1,
        cy < rows - 1 ? cur + cols : -1,
        cx > 0 ? cur - 1 : -1,
      ];
      const anchor = seedMode ? ci : cur;
      for (let ni = 0; ni < 4; ni++) {
        const nb = neighbors[ni];
        if (nb < 0 || assigned[nb]) continue;
        if (distSq(anchor, nb) <= simThreshSq) {
          assigned[nb] = regionId + 1;
          cells.push(nb);
          if (cells.length >= maxRegionCells) {
            truncated = true;
            break;
          }
        }
      }
    }
    if (truncated) truncatedCount++;
    regions.push({ cells, truncated });
  }

  // --- pass 4: filter tiny regions, build entities with bounding boxes ---
  const entities = [];
  let nextId = 1;
  let internalVarSum = 0;
  let internalVarCount = 0;
  for (const reg of regions) {
    if (reg.cells.length < cfg.minCells) continue;
    let minCx = cols, minCy = rows, maxCx = -1, maxCy = -1;
    // Also compute an internal-variance disclosure: how much did the members'
    // normMean spread from each other? High spread = we grew across a shading
    // gradient — honest to disclose.
    let sM = 0, sMsq = 0;
    for (const ci of reg.cells) {
      const cx = ci % cols;
      const cy = (ci - cx) / cols;
      if (cx < minCx) minCx = cx;
      if (cx > maxCx) maxCx = cx;
      if (cy < minCy) minCy = cy;
      if (cy > maxCy) maxCy = cy;
      const v = normMean[ci];
      sM += v;
      sMsq += v * v;
    }
    const meanM = sM / reg.cells.length;
    const varM = Math.max(0, sMsq / reg.cells.length - meanM * meanM);
    internalVarSum += varM;
    internalVarCount++;

    const x = minCx * cs;
    const y = minCy * cs;
    const w = (maxCx - minCx + 1) * cs;
    const h = (maxCy - minCy + 1) * cs;
    const entityNotes = [
      `member cells=${reg.cells.length}, internal normMean variance=${varM.toFixed(4)}`,
    ];
    if (reg.truncated) {
      entityNotes.push(
        `truncated at maxRegionCells=${maxRegionCells} (similarity metric under-selective — this entity's real extent likely spans more cells).`
      );
    }
    entities.push({
      id: nextId++,
      region: [x, y, w, h],
      notes: entityNotes,
    });
  }

  // --- notes[] — honest disclosures per contract ---
  const nSeeds = isSeed.reduce((a, b) => a + b, 0);
  notes.push(
    `region-grow: cells ${cols}x${rows} at cellSize=${cs}, features={mean(R), var(R), mean(|∇R|)} — NO orientation.`
  );
  notes.push(
    `region-grow: similarityThreshold=${cfg.similarityThreshold}, seedThreshold=${cfg.seedThreshold}, minCells=${cfg.minCells}. Weights M=${wM} V=${wV} G=${wG}. growthMode=${cfg.growthMode}, maxRegionFraction=${cfg.maxRegionFraction}.`
  );
  if (truncatedCount > 0) {
    notes.push(
      `region-grow: ${truncatedCount} region(s) hit the maxRegionCells cap — the similarity metric was under-selective there. Those entities' real extents are wider than reported.`
    );
  }
  notes.push(
    `region-grow: ${nSeeds} seed cells out of ${nCells}. ${regions.length} raw regions before minCells filter; ${entities.length} entities kept.`
  );
  if (internalVarCount > 0) {
    notes.push(
      `region-grow: mean internal normMean variance across entities = ${(internalVarSum / internalVarCount).toFixed(4)} — high values imply the region drifted along a shading gradient.`
    );
  }
  notes.push(
    `region-grow: known failure — patterned/striped objects fragment because a local mean estimator reads the pattern's periods as distinct cells.`
  );
  notes.push(
    `region-grow: known failure — objects smaller than cellSize (${cs}px) collapse into background.`
  );
  if (entities.length === 0) {
    notes.push(
      `region-grow: 0 entities emitted. Either the frame is texturally uniform (nothing exceeds seedThreshold from the frame mean) or every seed grew into a region below minCells. This is honest — no placeholders synthesized.`
    );
  }

  return { discipline: DISCIPLINE, entities, notes };
}

function maxOf(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}
