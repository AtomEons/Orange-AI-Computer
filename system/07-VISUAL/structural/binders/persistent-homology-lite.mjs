// AE Eyes object-binder — persistent-homology-lite
//
// 0-dimensional persistent homology on a superlevel-set filtration of R.
// Sweeps activation from high R to low R. Maintains union-find over active
// pixels. Each connected component has a "birth" (R when it first appeared)
// and a "death" (R when it merged into an older component, or 0 at end).
// Persistence = birth - death. Keep only components with persistence > tau.
//
// Deterministic. Pure JS. Bun. Backend only. No paid deps.

export const DISCIPLINE = "persistent-homology-lite";

/**
 * @param {Float32Array} R      photoreceptor-processed luminance, 0..1, w*h
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 *   opts.quantLevels  int, default 32 — sweep levels top-down
 *   opts.tauMode      "range" (default) | "otsu" | "abs"
 *   opts.tauFrac      when tauMode="range": tau = tauFrac * (Rmax-Rmin), default 0.05
 *   opts.tauAbs       when tauMode="abs":   tau = tauAbs, default 0.05
 *   opts.maxEntities  int, default 64 — safety cap; keep highest persistence
 * @returns {{ discipline, entities, notes }}
 */
export function bind(R, width, height, opts = {}) {
  const notes = [];

  const N = R.length;
  if (N !== width * height) {
    return {
      discipline: DISCIPLINE,
      entities: [],
      notes: [`input mismatch: R.length=${N} vs width*height=${width * height}`],
    };
  }

  const quantLevels = Math.max(2, opts.quantLevels | 0 || 32);
  const tauMode = opts.tauMode || "range";
  const tauFrac = typeof opts.tauFrac === "number" ? opts.tauFrac : 0.05;
  const tauAbs = typeof opts.tauAbs === "number" ? opts.tauAbs : 0.05;
  const maxEntities = Math.max(1, opts.maxEntities | 0 || 64);

  // --- range of R ---
  let rMin = Infinity;
  let rMax = -Infinity;
  for (let i = 0; i < N; i++) {
    const v = R[i];
    if (v < rMin) rMin = v;
    if (v > rMax) rMax = v;
  }
  const rRange = rMax - rMin;

  // Uniform-R case: no filtration structure. Explicit note, zero entities.
  if (rRange < 1e-8) {
    notes.push(`uniform R (min=${rMin.toFixed(4)} max=${rMax.toFixed(4)}); no superlevel structure; 0 entities`);
    notes.push(`quantLevels=${quantLevels}, tauMode=${tauMode}`);
    notes.push(`fails on: images with uniform luminance (no structure to bind)`);
    return { discipline: DISCIPLINE, entities: [], notes };
  }

  // --- quantize R into level indices (0=lowest, quantLevels-1=highest) ---
  // Deterministic bucketing. Ties broken by pixel index (stable).
  const levels = new Int32Array(N);
  const invRange = 1 / rRange;
  for (let i = 0; i < N; i++) {
    let lvl = Math.floor(((R[i] - rMin) * invRange) * quantLevels);
    if (lvl >= quantLevels) lvl = quantLevels - 1;
    if (lvl < 0) lvl = 0;
    levels[i] = lvl;
  }

  // Group pixel indices by level for top-down sweep.
  const levelBuckets = new Array(quantLevels);
  for (let l = 0; l < quantLevels; l++) levelBuckets[l] = [];
  for (let i = 0; i < N; i++) levelBuckets[levels[i]].push(i);

  // --- union-find over pixel indices ---
  // parent[i] = i means root. -1 means not yet activated.
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = -1;

  // Per-component (rooted at root pixel) bookkeeping.
  // birthLevel[root] = filtration level at which root was born.
  // size[root]       = current pixel count.
  // bbox[root]       = [minX, minY, maxX, maxY].
  const birthLevel = new Int32Array(N);
  const compSize = new Int32Array(N);
  // Bounding boxes stored in a Map to avoid 4*N allocation.
  const bboxMap = new Map(); // root -> [minX, minY, maxX, maxY]
  // Basin snapshot: at the first merge a root participates in, we freeze its
  // tight local-hill bbox. Later background flooding doesn't spread this box.
  // Only the survivor cares — losers' basin = their current bbox at merge time.
  const basinBBox = new Map(); // root -> [minX, minY, maxX, maxY] frozen at first merge

  function find(x) {
    // iterative with path compression
    let r = x;
    while (parent[r] !== r) r = parent[r];
    let cur = x;
    while (parent[cur] !== cur) {
      const nxt = parent[cur];
      parent[cur] = r;
      cur = nxt;
    }
    return r;
  }

  /** @type {Array<{birthLvl:number, deathLvl:number, root:number, bbox:number[]}>} */
  const bars = []; // persistence bars for components that died via merge

  const stillAlive = new Set(); // roots alive at end

  // Sweep from top level down to level 0.
  for (let lvl = quantLevels - 1; lvl >= 0; lvl--) {
    const bucket = levelBuckets[lvl];
    // Deterministic order: pixel index ascending.
    // (Array.prototype.push preserves index order; that is our tie-break.)
    for (let bi = 0; bi < bucket.length; bi++) {
      const idx = bucket[bi];
      // Activate this pixel.
      parent[idx] = idx;
      birthLevel[idx] = lvl;
      compSize[idx] = 1;
      const x = idx % width;
      const y = (idx - x) / width;
      bboxMap.set(idx, [x, y, x, y]);
      stillAlive.add(idx);

      // 4-neighbors, only those already active.
      const neigh = [];
      if (x > 0) {
        const j = idx - 1;
        if (parent[j] !== -1) neigh.push(j);
      }
      if (x < width - 1) {
        const j = idx + 1;
        if (parent[j] !== -1) neigh.push(j);
      }
      if (y > 0) {
        const j = idx - width;
        if (parent[j] !== -1) neigh.push(j);
      }
      if (y < height - 1) {
        const j = idx + width;
        if (parent[j] !== -1) neigh.push(j);
      }

      if (neigh.length === 0) continue; // brand new component; already set up

      // Collect unique roots among active neighbors.
      const rootsSeen = new Set();
      for (let k = 0; k < neigh.length; k++) {
        rootsSeen.add(find(neigh[k]));
      }
      const roots = [...rootsSeen];

      if (roots.length === 1) {
        // Extend the one existing component.
        const r = roots[0];
        parent[idx] = r;
        compSize[r] += 1;
        const bb = bboxMap.get(r);
        if (x < bb[0]) bb[0] = x;
        if (y < bb[1]) bb[1] = y;
        if (x > bb[2]) bb[2] = x;
        if (y > bb[3]) bb[3] = y;
        // Also fold idx's own singleton bbox: idx is now non-root, drop its entry
        bboxMap.delete(idx);
        stillAlive.delete(idx);
      } else {
        // Merge two or more components. The idx pixel joins them all.
        // Elder rule: older (higher birthLevel — remember we sweep top-down,
        // so higher birthLevel = born earlier in the filtration) survives.
        // Deterministic tie-break: smaller root index survives.
        let survivor = roots[0];
        for (let k = 1; k < roots.length; k++) {
          const r = roots[k];
          if (
            birthLevel[r] > birthLevel[survivor] ||
            (birthLevel[r] === birthLevel[survivor] && r < survivor)
          ) {
            survivor = r;
          }
        }
        // Freeze the survivor's basin bbox at its FIRST merge — this is its
        // tight local-hill hull. Later floods don't grow this box.
        if (!basinBBox.has(survivor)) {
          const sb0 = bboxMap.get(survivor);
          basinBBox.set(survivor, [sb0[0], sb0[1], sb0[2], sb0[3]]);
        }
        // idx itself is a fresh singleton component; unify it into survivor.
        // Then kill the other roots and record their persistence bars.
        // First fold idx into survivor.
        parent[idx] = survivor;
        compSize[survivor] += 1;
        const sb = bboxMap.get(survivor);
        if (x < sb[0]) sb[0] = x;
        if (y < sb[1]) sb[1] = y;
        if (x > sb[2]) sb[2] = x;
        if (y > sb[3]) sb[3] = y;
        bboxMap.delete(idx);
        stillAlive.delete(idx);

        for (let k = 0; k < roots.length; k++) {
          const r = roots[k];
          if (r === survivor) continue;
          // r dies at current lvl. Record its bar with its BASIN bbox
          // (the bbox as it stood before the merge — the tight local hull
          // of the sub-hill r represents).
          const rb = bboxMap.get(r);
          bars.push({
            birthLvl: birthLevel[r],
            deathLvl: lvl,
            root: r,
            bbox: [rb[0], rb[1], rb[2], rb[3]],
          });
          // Union-find merge for connectivity, but DO NOT fold r's bbox into
          // the survivor. Each entity's region is the basin of attraction of
          // its own peak, not the absorbing hull. The survivor keeps growing
          // its own bbox pixel-by-pixel as its own basin expands.
          compSize[survivor] += compSize[r];
          parent[r] = survivor;
          bboxMap.delete(r);
          stillAlive.delete(r);
        }
      }
    }
  }

  // Every still-alive component dies at level -1 (below the filtration).
  // Their persistence = birthLevel - (-1) = birthLevel + 1.
  // Prefer the frozen basin bbox (from its first merge) if we have one,
  // otherwise use current bbox (component never merged, i.e., a lone peak).
  for (const r of stillAlive) {
    const rb = basinBBox.get(r) || bboxMap.get(r);
    bars.push({
      birthLvl: birthLevel[r],
      deathLvl: -1,
      root: r,
      bbox: [rb[0], rb[1], rb[2], rb[3]],
    });
  }

  // --- convert level-based bars to R-space persistence values ---
  // level l corresponds roughly to R = rMin + (l+0.5)/quantLevels * rRange.
  const levelToR = (l) => {
    if (l < 0) return rMin - 0.5 * (rRange / quantLevels);
    return rMin + ((l + 0.5) / quantLevels) * rRange;
  };
  for (const b of bars) {
    b.birthR = levelToR(b.birthLvl);
    b.deathR = levelToR(b.deathLvl);
    b.persistence = b.birthR - b.deathR;
  }

  // --- pick tau ---
  let tau;
  let tauRationale;
  if (tauMode === "abs") {
    tau = tauAbs;
    tauRationale = `abs tau=${tau.toFixed(4)}`;
  } else if (tauMode === "otsu") {
    // 1D Otsu on the persistence histogram to split noise from signal.
    tau = otsuThreshold(bars.map((b) => b.persistence), 64);
    tauRationale = `otsu tau=${tau.toFixed(4)} on persistence histogram`;
  } else {
    tau = tauFrac * rRange;
    tauRationale = `range tau=${tau.toFixed(4)} (${(tauFrac * 100).toFixed(1)}% of R range ${rRange.toFixed(4)})`;
  }

  // Keep bars with persistence > tau. Sort by persistence desc, then cap.
  const kept = bars.filter((b) => b.persistence > tau);
  kept.sort((a, b) => b.persistence - a.persistence || a.root - b.root);
  const finalBars = kept.slice(0, maxEntities);

  // --- emit entities ---
  // Persistence values exposed as numeric fields alongside legacy notes string,
  // so downstream code doesn't need to regex the notes to score bars.
  const entities = finalBars.map((b, i) => {
    const [minX, minY, maxX, maxY] = b.bbox;
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    return {
      id: i + 1,
      region: [minX, minY, w, h],
      persistence: b.persistence,
      birthR: b.birthR,
      deathR: b.deathR,
      notes: [
        `birthR=${b.birthR.toFixed(3)}, deathR=${b.deathR.toFixed(3)}, persistence=${b.persistence.toFixed(3)}`,
      ],
    };
  });

  // --- honest notes ---
  notes.push(`quantLevels=${quantLevels} (superlevel-set sweep top-down)`);
  notes.push(`R range: [${rMin.toFixed(3)}, ${rMax.toFixed(3)}] span=${rRange.toFixed(3)}`);
  notes.push(`persistence threshold: ${tauRationale}`);
  notes.push(`bars before filter: ${bars.length}; after tau: ${kept.length}; emitted: ${entities.length} (cap=${maxEntities})`);
  notes.push(
    `fails on: nested bright regions with equal persistence (topological ambiguity — hole in a donut). ` +
    `bbox is axis-aligned envelope; concave / crescent shapes will over-cover their tight hull. ` +
    `quantization to ${quantLevels} levels merges pixels within ~${(rRange / quantLevels).toFixed(3)} R apart.`
  );
  if (entities.length === 0) {
    notes.push(`no components survived persistence filter; likely tau too aggressive or scene too flat`);
  }

  return { discipline: DISCIPLINE, entities, notes };
}

// --- Otsu's method on a numeric array, quantized into `bins` histogram bins.
function otsuThreshold(values, bins = 64) {
  if (!values.length) return 0;
  let vMin = Infinity;
  let vMax = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v < vMin) vMin = v;
    if (v > vMax) vMax = v;
  }
  if (vMax - vMin < 1e-12) return vMin;
  const hist = new Float64Array(bins);
  const invRange = 1 / (vMax - vMin);
  for (let i = 0; i < values.length; i++) {
    let b = Math.floor((values[i] - vMin) * invRange * bins);
    if (b >= bins) b = bins - 1;
    if (b < 0) b = 0;
    hist[b] += 1;
  }
  const total = values.length;
  let sumAll = 0;
  for (let b = 0; b < bins; b++) sumAll += b * hist[b];
  let sumB = 0;
  let wB = 0;
  let maxVar = -1;
  let bestBin = 0;
  for (let b = 0; b < bins; b++) {
    wB += hist[b];
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += b * hist[b];
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) {
      maxVar = between;
      bestBin = b;
    }
  }
  return vMin + ((bestBin + 1) / bins) * (vMax - vMin);
}
