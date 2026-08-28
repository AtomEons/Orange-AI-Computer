// 07-VISUAL/structural/binders/density-cluster.mjs
//
// Density-based object binder for AE Eyes.
//
// Discipline: HDBSCAN-adjacent — downsample the photoreceptor field R to a
// coarse grid, compute a per-cell feature vector, then cluster cells in
// feature space with DBSCAN (a fixed-eps sibling of HDBSCAN's density-level
// cut). DBSCAN is deterministic given a fixed traversal order and does not
// require a target K. Entities are cluster bounding boxes over member cells.
//
// Feature per cell (6-dim):
//     [x_norm, y_norm, R_mean, grad_mag, sin(2·orient), cos(2·orient)]
//
// * x_norm, y_norm are cell-center coordinates in [0,1] — including position
//   in the feature vector is how spatial coherence enters the clustering.
// * R_mean is the mean photoreceptor response across the cell.
// * grad_mag is the mean |∇R| across the cell.
// * Orientation is doubled and packed as (sin, cos) so a horizontal edge
//   (0 rad) and a horizontal edge (π rad) collapse to the same vector — an
//   edge has no head/tail. The 2× keeps the wrap continuous.
//
// Distance: weighted Euclidean. Position gets ~50% of the squared-distance
// budget (POS_WEIGHT²=2.0 vs each of the other four dims weighted 1.0),
// which matches the contract's guidance and is documented in `notes[]`.
//
// Bun-only, pure JS, deterministic. No RNG. No paid deps. Backend only.

export const DISCIPLINE = "density-cluster";

const DEFAULTS = Object.freeze({
  // Target number of cells across the longer image dimension. 16 is a
  // reasonable middle: coarse enough to be fast (256 cells on a square),
  // fine enough to resolve a handful of fruit-sized regions on a still.
  gridCells: 16,

  // DBSCAN radius in the (weighted) feature space. Chosen so that adjacent
  // cells with similar R + gradient will cluster; documented in notes.
  eps: 0.35,

  // Minimum cluster size (density threshold). DBSCAN calls a point a "core"
  // if at least this many neighbours (including itself) sit within eps.
  minPts: 3,

  // Weight applied to position dimensions in the distance metric. Squared,
  // position occupies posWeight² / (posWeight² + featureWeightSum²) of the
  // squared distance. Default (posW=2, feature dims each weight 1, orient
  // weight 0.4): pos gets 4/(4+1+1+0.32) ≈ 61% of the budget. That satisfies
  // the contract's "~50% position" guidance while leaving room for R + grad
  // to actually influence clustering.
  posWeight: 2.0,

  // Weight for the two orientation dimensions (sin/cos of 2·θ). Kept small
  // because coarse-grid orientation is noisy near blob boundaries — treating
  // it as a hard clustering axis fragments what should be a single object.
  orientWeight: 0.4,

  // R_mean threshold below which a cell is considered "background" and
  // skipped from clustering. Used only in "absolute" mode (see
  // rBackgroundMode). Kept as a fallback.
  rBackgroundThreshold: 0.05,

  // Which background-mask policy to use:
  //   "adaptive" — cell is background if its R_mean falls below the median
  //     R_mean across the grid (or is within `adaptiveMargin` of it).
  //   "absolute" — hard threshold at `rBackgroundThreshold`.
  // Adaptive is the default because natural imagery under photopic
  // conditions has R roughly uniform-high after adaptation, so a hard 0.05
  // threshold accepts the entire scene as foreground.
  rBackgroundMode: "adaptive",
  adaptiveMargin: 0.0,

  // Maximum allowed fraction of image area for a single entity's bounding
  // box. Clusters larger than this are dropped and reported honestly —
  // nothing that big is a "fruit-scale" object; it's a chained cluster of
  // the background. Setting to 1.0 disables the guardrail.
  maxRegionFrac: 0.5,

  // If the standard deviation of R across the whole frame is below this,
  // the image is treated as "essentially uniform" and we return 0 entities
  // with a note. Prevents fake-green clusters on featureless input.
  uniformStdThreshold: 0.01,
});

/**
 * @param {Float32Array} R
 * @param {number} width
 * @param {number} height
 * @param {object} opts
 * @returns {{ discipline: string, entities: Array, notes: string[] }}
 */
export function bind(R, width, height, opts = {}) {
  const cfg = { ...DEFAULTS, ...(opts || {}) };
  const notes = [];

  if (!R || R.length !== width * height) {
    return {
      discipline: DISCIPLINE,
      entities: [],
      notes: [
        `input mismatch: R.length=${R ? R.length : 0} but width*height=${width * height}. No entities emitted.`,
      ],
    };
  }

  // --- 0. Uniformity check ---------------------------------------------
  // If R is essentially flat, do not fabricate density where none exists.
  let sumR = 0;
  for (let i = 0; i < R.length; i++) sumR += R[i];
  const meanR = sumR / R.length;
  let varR = 0;
  for (let i = 0; i < R.length; i++) {
    const d = R[i] - meanR;
    varR += d * d;
  }
  varR /= R.length;
  const stdR = Math.sqrt(varR);
  if (stdR < cfg.uniformStdThreshold) {
    notes.push(
      `uniform-R: std(R)=${stdR.toFixed(5)} < ${cfg.uniformStdThreshold} — image is essentially featureless. 0 entities.`,
    );
    notes.push(...standingNotes(cfg));
    return { discipline: DISCIPLINE, entities: [], notes };
  }

  // --- 1. Grid geometry -------------------------------------------------
  const longer = Math.max(width, height);
  const cellSize = Math.max(2, Math.floor(longer / cfg.gridCells));
  const gridW = Math.max(1, Math.floor(width / cellSize));
  const gridH = Math.max(1, Math.floor(height / cellSize));
  // If gridW*cellSize < width we lose the trailing sliver; documented below.
  const usedW = gridW * cellSize;
  const usedH = gridH * cellSize;
  if (usedW < width || usedH < height) {
    notes.push(
      `grid: dropped trailing sliver (${width - usedW}px right, ${height - usedH}px bottom) so cellSize=${cellSize} divides evenly into a ${gridW}x${gridH} grid.`,
    );
  }

  // --- 2. Per-cell features --------------------------------------------
  // For each cell, compute:
  //   rMean         mean R over the cell
  //   gradMag       mean |∇R| over the cell (central differences on the cell)
  //   orient2Sin    sin(2·orientation) averaged
  //   orient2Cos    cos(2·orientation)
  // Gradient uses cell-scale differences (not pixel-scale), which is the
  // right frequency to feed clustering — pixel gradients are too noisy.
  const nCells = gridW * gridH;
  const rMeans = new Float32Array(nCells);
  const gradMags = new Float32Array(nCells);
  const orientSin = new Float32Array(nCells);
  const orientCos = new Float32Array(nCells);

  // Cell means first (one pass over R).
  for (let cy = 0; cy < gridH; cy++) {
    for (let cx = 0; cx < gridW; cx++) {
      const y0 = cy * cellSize;
      const x0 = cx * cellSize;
      let s = 0;
      let cnt = 0;
      for (let y = y0; y < y0 + cellSize; y++) {
        const row = y * width;
        for (let x = x0; x < x0 + cellSize; x++) {
          s += R[row + x];
          cnt++;
        }
      }
      rMeans[cy * gridW + cx] = cnt > 0 ? s / cnt : 0;
    }
  }

  // Cell-scale gradient via central differences on the mean-image.
  for (let cy = 0; cy < gridH; cy++) {
    for (let cx = 0; cx < gridW; cx++) {
      const iL = cx > 0 ? cy * gridW + (cx - 1) : cy * gridW + cx;
      const iR = cx < gridW - 1 ? cy * gridW + (cx + 1) : cy * gridW + cx;
      const iT = cy > 0 ? (cy - 1) * gridW + cx : cy * gridW + cx;
      const iB = cy < gridH - 1 ? (cy + 1) * gridW + cx : cy * gridW + cx;
      const dx = (rMeans[iR] - rMeans[iL]) * 0.5;
      const dy = (rMeans[iB] - rMeans[iT]) * 0.5;
      const mag = Math.sqrt(dx * dx + dy * dy);
      gradMags[cy * gridW + cx] = mag;
      // orientation angle θ in [-π,π]; use 2θ for edge-invariance (0 == π).
      const theta = Math.atan2(dy, dx);
      const two = 2 * theta;
      orientSin[cy * gridW + cx] = Math.sin(two);
      orientCos[cy * gridW + cx] = Math.cos(two);
    }
  }

  // Normalize gradMags to [0,1] for balanced distances.
  let maxGrad = 0;
  for (let i = 0; i < nCells; i++) if (gradMags[i] > maxGrad) maxGrad = gradMags[i];
  if (maxGrad > 0) {
    const inv = 1 / maxGrad;
    for (let i = 0; i < nCells; i++) gradMags[i] *= inv;
  }

  // --- 3. Assemble feature vectors and background mask ------------------
  // Compute the background threshold according to the chosen mode.
  let bgThreshold;
  let bgMode = cfg.rBackgroundMode;
  if (bgMode === "adaptive") {
    // Median of cell R_means. Copy to sort so we don't mutate rMeans.
    const sorted = Array.from(rMeans).sort((a, b) => a - b);
    const mid = sorted.length >> 1;
    bgThreshold =
      (sorted.length % 2 === 1
        ? sorted[mid]
        : 0.5 * (sorted[mid - 1] + sorted[mid])) + cfg.adaptiveMargin;
  } else {
    bgThreshold = cfg.rBackgroundThreshold;
  }

  // We cluster only cells whose R_mean is above the background threshold.
  // Cells below the threshold are eligible neighbours only if they have a
  // strong gradient — the boundary of a bright object over dark bg.
  const eligible = new Uint8Array(nCells);
  const featX = new Float32Array(nCells);
  const featY = new Float32Array(nCells);
  const featR = new Float32Array(nCells);
  const featG = new Float32Array(nCells);
  const featOS = orientSin; // alias
  const featOC = orientCos; // alias
  let eligibleCount = 0;
  for (let cy = 0; cy < gridH; cy++) {
    for (let cx = 0; cx < gridW; cx++) {
      const i = cy * gridW + cx;
      featX[i] = (cx + 0.5) / gridW;
      featY[i] = (cy + 0.5) / gridH;
      featR[i] = rMeans[i];
      featG[i] = gradMags[i];
      const isBright = rMeans[i] >= bgThreshold;
      // Edge-only inclusion is intentionally strict: normalized gradMags run
      // 0..1, so 0.35 keeps dark-cell entries reserved for genuinely strong
      // object boundaries and avoids sweeping in speckled background.
      const hasEdge = gradMags[i] > 0.35;
      if (isBright || hasEdge) {
        eligible[i] = 1;
        eligibleCount++;
      }
    }
  }
  notes.push(
    `bg-mask: mode=${bgMode}, threshold=${bgThreshold.toFixed(4)}, ${eligibleCount}/${nCells} cells eligible.`,
  );

  if (eligibleCount < cfg.minPts) {
    notes.push(
      `no-cluster: only ${eligibleCount} cells above background (need ${cfg.minPts}). 0 entities.`,
    );
    notes.push(...standingNotes(cfg));
    return { discipline: DISCIPLINE, entities: [], notes };
  }

  // --- 4. DBSCAN --------------------------------------------------------
  // Deterministic: fixed scan order (raster over cells), fixed neighbour
  // order (raster over the eligible set). No RNG.
  const posW2 = cfg.posWeight * cfg.posWeight;
  const orientW2 = cfg.orientWeight * cfg.orientWeight;
  const eps2 = cfg.eps * cfg.eps;

  // Precompute list of eligible cell indices in raster order.
  const eligIdx = new Int32Array(eligibleCount);
  {
    let k = 0;
    for (let i = 0; i < nCells; i++) if (eligible[i]) eligIdx[k++] = i;
  }

  // labels: -1 = unvisited, -2 = noise, >=0 = cluster id
  const labels = new Int32Array(nCells);
  labels.fill(-1);
  for (let i = 0; i < nCells; i++) if (!eligible[i]) labels[i] = -2; // background

  // Distance in weighted feature space.
  const dist2 = (a, b) => {
    const dx = featX[a] - featX[b];
    const dy = featY[a] - featY[b];
    const dr = featR[a] - featR[b];
    const dg = featG[a] - featG[b];
    const dos = featOS[a] - featOS[b];
    const doc = featOC[a] - featOC[b];
    // Position dims weighted so they contribute posW² / (posW²+2+2·orientW²)
    // of the total squared distance. Orientation dims deliberately soft.
    return posW2 * (dx * dx + dy * dy)
      + dr * dr + dg * dg
      + orientW2 * (dos * dos + doc * doc);
  };

  const rangeQuery = (p) => {
    const out = [];
    for (let j = 0; j < eligibleCount; j++) {
      const q = eligIdx[j];
      if (dist2(p, q) <= eps2) out.push(q);
    }
    return out;
  };

  let clusterId = 0;
  for (let ei = 0; ei < eligibleCount; ei++) {
    const p = eligIdx[ei];
    if (labels[p] !== -1) continue;
    const N = rangeQuery(p);
    if (N.length < cfg.minPts) {
      labels[p] = -2; // noise
      continue;
    }
    labels[p] = clusterId;
    // Seed set as a growable queue; deterministic BFS order.
    const seeds = [];
    for (const q of N) if (q !== p) seeds.push(q);
    let head = 0;
    while (head < seeds.length) {
      const q = seeds[head++];
      if (labels[q] === -2) labels[q] = clusterId; // reclaim noise as border
      if (labels[q] !== -1) continue;
      labels[q] = clusterId;
      const Nq = rangeQuery(q);
      if (Nq.length >= cfg.minPts) {
        for (const r of Nq) if (labels[r] === -1 || labels[r] === -2) seeds.push(r);
      }
    }
    clusterId++;
  }

  if (clusterId === 0) {
    notes.push(
      `no-cluster: DBSCAN with eps=${cfg.eps}, minPts=${cfg.minPts} found no dense regions among ${eligibleCount} eligible cells. Try lowering eps or minPts.`,
    );
    notes.push(...standingNotes(cfg));
    return { discipline: DISCIPLINE, entities: [], notes };
  }

  // --- 5. Bounding boxes per cluster in pixel space ---------------------
  // Aggregate {minCx, maxCx, minCy, maxCy, count} per cluster.
  const bxMin = new Int32Array(clusterId).fill(gridW);
  const bxMax = new Int32Array(clusterId).fill(-1);
  const byMin = new Int32Array(clusterId).fill(gridH);
  const byMax = new Int32Array(clusterId).fill(-1);
  const counts = new Int32Array(clusterId);

  for (let cy = 0; cy < gridH; cy++) {
    for (let cx = 0; cx < gridW; cx++) {
      const lbl = labels[cy * gridW + cx];
      if (lbl < 0) continue;
      if (cx < bxMin[lbl]) bxMin[lbl] = cx;
      if (cx > bxMax[lbl]) bxMax[lbl] = cx;
      if (cy < byMin[lbl]) byMin[lbl] = cy;
      if (cy > byMax[lbl]) byMax[lbl] = cy;
      counts[lbl]++;
    }
  }

  const entities = [];
  const imgArea = width * height;
  let prunedGiant = 0;
  for (let id = 0; id < clusterId; id++) {
    if (counts[id] === 0) continue;
    const x = bxMin[id] * cellSize;
    const y = byMin[id] * cellSize;
    const w = (bxMax[id] - bxMin[id] + 1) * cellSize;
    const h = (byMax[id] - byMin[id] + 1) * cellSize;
    // Clamp to image bounds (paranoid; the grid math should already respect them).
    const rx = Math.min(x, width - 1);
    const ry = Math.min(y, height - 1);
    const rw = Math.min(w, width - rx);
    const rh = Math.min(h, height - ry);
    // Prune giant clusters — a bbox that covers the whole frame is a
    // chained-noise cluster, not an object. Honest note preserved.
    if (cfg.maxRegionFrac < 1.0 && (rw * rh) / imgArea > cfg.maxRegionFrac) {
      prunedGiant++;
      continue;
    }
    entities.push({
      id: entities.length,
      region: [rx, ry, rw, rh],
      notes: [`density-cluster id=${id}, ${counts[id]} member cells`],
    });
  }
  if (prunedGiant > 0) {
    notes.push(
      `pruned ${prunedGiant} cluster(s) whose bbox exceeded maxRegionFrac=${cfg.maxRegionFrac} of the frame — DBSCAN chained across background. Not fruit-scale.`,
    );
  }

  // Sort largest-first so callers get a stable order and the top entities
  // are the visually important ones. Ties broken by original raster order.
  entities.sort((a, b) => {
    const areaA = a.region[2] * a.region[3];
    const areaB = b.region[2] * b.region[3];
    if (areaB !== areaA) return areaB - areaA;
    return a.id - b.id;
  });
  // Re-number ids after sort so ids match the reported order.
  entities.forEach((e, i) => { e.id = i; });

  notes.push(
    `grid: ${gridW}x${gridH} cells @ ${cellSize}px (${nCells} total cells).`,
  );
  {
    const posFrac = posW2 / (posW2 + 2 + 2 * orientW2);
    notes.push(
      `dbscan: eps=${cfg.eps}, minPts=${cfg.minPts}, posWeight=${cfg.posWeight}, orientWeight=${cfg.orientWeight} → position contributes ${(posFrac * 100).toFixed(0)}% of squared distance`,
    );
  }
  notes.push(
    `dbscan produced ${clusterId} clusters, ${entities.length} entities emitted after empty/oversize prune.`,
  );
  notes.push(...standingNotes(cfg));

  return { discipline: DISCIPLINE, entities, notes };
}

// Standing honest limits — the shapes and regimes where density clustering
// on a coarse grid is known to fail. Mom's Law channel.
function standingNotes(cfg) {
  return [
    `fails on: long thin objects (single cell wide → smaller than minPts=${cfg.minPts}); very small objects (below cell size); low-contrast objects (R_mean near background); textured objects where local orientation flips across cells; touching same-brightness objects (density will merge them).`,
    `assumes: objects are locally coherent in R_mean AND gradient; background is smoother than foreground; cellSize (~1/${cfg.gridCells} of the longer dim) is smaller than the smallest object of interest.`,
    `deterministic: no RNG. DBSCAN traversal is raster-ordered so output is bit-exact reproducible.`,
  ];
}

// Internals exposed for tests only.
export const __densityClusterInternals = Object.freeze({ DEFAULTS });
