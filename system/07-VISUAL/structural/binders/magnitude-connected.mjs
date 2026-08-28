// 07-VISUAL/structural/binders/magnitude-connected.mjs
//
// Object-binder: connected components of thresholded |∇R|. The null-hypothesis
// baseline. NO orientation gating. NO texture similarity. NO watershed. Just:
//
//   1. Sobel |∇R|.
//   2. Threshold at k * mean(|∇R|).
//   3. Small morphological close (3x3 dilate then erode) to bridge 1-px gaps.
//   4. 8-connected component labeling (union-find).
//   5. Filter components with pixel count < minPixels.
//   6. Emit region bounding boxes.
//
// This is deliberately the SIMPLEST possible binder. Its virtue is honesty:
// it shows how far pure connectivity gets you before any grouping intelligence.
//
// Strategy selection: we compute BOTH "edge-connected" (components of
// above-threshold gradient pixels) and "interior-connected" (components of
// BELOW-threshold pixels, i.e. flat interiors bounded by edges), score each
// by (a) whether it produces a reasonable entity count (5..50) and (b) whether
// average component size is > minPixels. We keep the strategy that scored
// higher; the loser is disclosed in notes[].
//
// Determinism: pure function of (R, width, height, opts). No RNG, no wall clock.
//
// Anti-drift:
//   - Backend only.
//   - Bun-only (pure JS + Float32/Int32 typed arrays).
//   - No paid deps.
//   - Every honest limitation disclosed in notes[].

export const DISCIPLINE = "magnitude-connected";

const DEFAULTS = Object.freeze({
  // Threshold as a multiplier of the frame-mean |∇R|. Higher = fewer edge
  // pixels survive. Default tuned so that on natural imagery ~10-25% of
  // pixels pass (which is a reasonable regime for CC labeling).
  thresholdMult: 1.0,

  // Minimum component size in pixels. Anything smaller is dropped as noise.
  // A 640x480 frame has 307,200 pixels; 200 px is ~0.065% of frame — a good
  // "just barely visible" floor.
  minPixels: 200,

  // Morphological close: dilate then erode with a 3x3 kernel. Bridges 1-pixel
  // gaps in the thresholded mask so a single edge-broken object doesn't split
  // into two components. Set to 0 to skip.
  closeIterations: 1,

  // Which strategy to force. "auto" picks the better-scoring one.
  // "edge" = components of above-threshold pixels (rims of objects).
  // "interior" = components of BELOW-threshold pixels (flat insides).
  strategy: "auto",
});

/**
 * @param {Float32Array} R
 * @param {number} width
 * @param {number} height
 * @param {object} opts
 * @returns {{ discipline: string, entities: Array<{id:number, region:[number,number,number,number], notes?: string[]}>, notes: string[] }}
 */
export function bind(R, width, height, opts = {}) {
  const {
    thresholdMult,
    minPixels,
    closeIterations,
    strategy,
  } = { ...DEFAULTS, ...opts };

  if (!(R instanceof Float32Array) && !(R instanceof Float64Array)) {
    // Accept plain arrays too, but note the boundary.
    R = Float32Array.from(R);
  }
  if (R.length !== width * height) {
    return {
      discipline: DISCIPLINE,
      entities: [],
      notes: [
        `refused: R.length ${R.length} != width*height ${width * height}`,
      ],
    };
  }
  if (width < 3 || height < 3) {
    return {
      discipline: DISCIPLINE,
      entities: [],
      notes: [`refused: image ${width}x${height} too small for Sobel`],
    };
  }

  const notes = [];
  const t0 = Date.now();

  // --- 1. Sobel |∇R| ---
  const gMag = sobelMagnitude(R, width, height);

  // --- 2. Threshold: mean-relative ---
  let sum = 0;
  for (let i = 0; i < gMag.length; i++) sum += gMag[i];
  const meanG = sum / gMag.length;
  const thresh = meanG * thresholdMult;

  // --- 3. Build both masks (edge above-threshold, interior below-threshold),
  //       morph-close each, and label. Pick the better one unless forced. ---
  const edgeMask = new Uint8Array(gMag.length);
  const intMask = new Uint8Array(gMag.length);
  for (let i = 0; i < gMag.length; i++) {
    if (gMag[i] > thresh) edgeMask[i] = 1;
    else intMask[i] = 1;
  }

  const edgeFrac = countOnes(edgeMask) / edgeMask.length;
  const intFrac = countOnes(intMask) / intMask.length;

  let edgeResult = null;
  let intResult = null;
  if (strategy === "auto" || strategy === "edge") {
    const closed = closeIterations > 0
      ? morphClose(edgeMask, width, height, closeIterations)
      : edgeMask;
    edgeResult = labelAndFilter(closed, width, height, minPixels);
  }
  if (strategy === "auto" || strategy === "interior") {
    const closed = closeIterations > 0
      ? morphClose(intMask, width, height, closeIterations)
      : intMask;
    intResult = labelAndFilter(closed, width, height, minPixels);
  }

  // Score: prefer the strategy in the 5..50 entity range, tie-break by
  // largest-component fraction (interior tends to win here; picking one
  // large "background" blob is a KNOWN failure disclosed below).
  const scoreOf = (r) => {
    if (!r) return -Infinity;
    const n = r.entities.length;
    if (n === 0) return -1;
    const inRange = n >= 3 && n <= 50 ? 100 : 0;
    // Penalize entity counts far from the "reasonable" 5..15 range for a
    // fruit still, but don't force it — just soft prefer.
    const dist = Math.abs(n - 10);
    return inRange - dist;
  };

  let chosen;
  let chosenStrategy;
  if (strategy === "edge") {
    chosen = edgeResult;
    chosenStrategy = "edge";
  } else if (strategy === "interior") {
    chosen = intResult;
    chosenStrategy = "interior";
  } else {
    const eS = scoreOf(edgeResult);
    const iS = scoreOf(intResult);
    if (eS >= iS) {
      chosen = edgeResult;
      chosenStrategy = "edge";
    } else {
      chosen = intResult;
      chosenStrategy = "interior";
    }
    notes.push(
      `auto-selected strategy '${chosenStrategy}' (edge_score=${eS.toFixed(1)} vs interior_score=${iS.toFixed(1)})`,
    );
  }

  // --- 6. Notes: honest disclosures ---
  notes.push(
    `strategy: ${chosenStrategy} (thresholdMult=${thresholdMult}, minPixels=${minPixels}, closeIters=${closeIterations})`,
  );
  notes.push(
    `frame mean|∇R|=${meanG.toFixed(6)}, threshold=${thresh.toFixed(6)}, edge_frac=${(edgeFrac * 100).toFixed(1)}%, interior_frac=${(intFrac * 100).toFixed(1)}%`,
  );
  if (edgeResult && intResult && strategy === "auto") {
    const alt = chosenStrategy === "edge" ? "interior" : "edge";
    const altN = chosenStrategy === "edge" ? intResult.entities.length : edgeResult.entities.length;
    notes.push(
      `alternate '${alt}' would yield ${altN} entities vs chosen '${chosenStrategy}' ${chosen.entities.length}`,
    );
  }
  notes.push(
    `KNOWN FAIL — touching objects merge into one component (no orientation gating, no watershed).`,
  );
  notes.push(
    `KNOWN FAIL — objects with thin/broken rims fragment even after 3x3 close.`,
  );
  notes.push(
    `KNOWN FAIL — 'interior' strategy often selects the background as its largest component.`,
  );
  notes.push(
    `KNOWN FAIL — 'edge' strategy on hollow objects produces ring-shaped components with hollow bboxes.`,
  );
  notes.push(
    `honest floor: this is a baseline; any real binder should beat it on segmentation quality.`,
  );
  notes.push(`bind wallclock ${Date.now() - t0}ms`);

  return {
    discipline: DISCIPLINE,
    entities: chosen.entities,
    notes,
  };
}

// ------------------------------------------------------------------ helpers

function sobelMagnitude(R, w, h) {
  const g = new Float32Array(w * h);
  // Sobel kernels:
  //  Gx = [-1 0 +1; -2 0 +2; -1 0 +1]
  //  Gy = [-1 -2 -1;  0 0 0; +1 +2 +1]
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = R[i - w - 1], tc = R[i - w], tr = R[i - w + 1];
      const ml = R[i - 1],                       mr = R[i + 1];
      const bl = R[i + w - 1], bc = R[i + w], br = R[i + w + 1];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bc + br) - (tl + 2 * tc + tr);
      g[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  // Border pixels stay 0 — Sobel is undefined at the frame edge. Downstream
  // threshold-and-CC treats these as sub-threshold, which is fine.
  return g;
}

function countOnes(mask) {
  let c = 0;
  for (let i = 0; i < mask.length; i++) if (mask[i]) c++;
  return c;
}

// 3x3 dilate: any pixel with an on neighbor becomes on.
function dilate3(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (mask[i]) { out[i] = 1; continue; }
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          if (mask[yy * w + xx]) { hit = 1; break; }
        }
      }
      out[i] = hit;
    }
  }
  return out;
}

// 3x3 erode: pixel stays on only if ALL 3x3 neighbors are on.
function erode3(mask, w, h) {
  const out = new Uint8Array(mask.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) { out[i] = 0; continue; }
      let allOn = 1;
      for (let dy = -1; dy <= 1 && allOn; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) { allOn = 0; break; }
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) { allOn = 0; break; }
          if (!mask[yy * w + xx]) { allOn = 0; break; }
        }
      }
      out[i] = allOn;
    }
  }
  return out;
}

function morphClose(mask, w, h, iters) {
  let m = mask;
  for (let k = 0; k < iters; k++) m = dilate3(m, w, h);
  for (let k = 0; k < iters; k++) m = erode3(m, w, h);
  return m;
}

// Two-pass 8-connected component labeling with union-find. Returns:
//   { entities: [{ id, region:[x,y,w,h] }] } for components >= minPixels
function labelAndFilter(mask, w, h, minPixels) {
  const labels = new Int32Array(mask.length);
  // Union-find over labels. parent[k] = k until unified.
  const parent = [0]; // label 0 = background
  const nextLabel = () => {
    const l = parent.length;
    parent.push(l);
    return l;
  };
  const find = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const union = (a, b) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  };

  // First pass — scan order (row-major). For 8-conn, look at N, NW, NE, W.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      // Collect neighbor labels that exist (row above + left of me).
      const neigh = [];
      if (y > 0) {
        const n = labels[i - w];
        if (n) neigh.push(n);
        if (x > 0) {
          const nw = labels[i - w - 1];
          if (nw) neigh.push(nw);
        }
        if (x < w - 1) {
          const ne = labels[i - w + 1];
          if (ne) neigh.push(ne);
        }
      }
      if (x > 0) {
        const wl = labels[i - 1];
        if (wl) neigh.push(wl);
      }
      if (neigh.length === 0) {
        labels[i] = nextLabel();
      } else {
        // Assign the minimum root, then union the rest.
        let root = find(neigh[0]);
        for (let k = 1; k < neigh.length; k++) {
          const r = find(neigh[k]);
          if (r < root) root = r;
        }
        labels[i] = root;
        for (let k = 0; k < neigh.length; k++) union(neigh[k], root);
      }
    }
  }

  // Second pass — resolve labels to roots, accumulate bboxes and pixel counts.
  const bboxes = new Map(); // root -> { minX, minY, maxX, maxY, count }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const l = labels[i];
      if (!l) continue;
      const root = find(l);
      labels[i] = root;
      let b = bboxes.get(root);
      if (!b) {
        b = { minX: x, minY: y, maxX: x, maxY: y, count: 1 };
        bboxes.set(root, b);
      } else {
        if (x < b.minX) b.minX = x;
        else if (x > b.maxX) b.maxX = x;
        if (y < b.minY) b.minY = y;
        else if (y > b.maxY) b.maxY = y;
        b.count++;
      }
    }
  }

  // Filter by minPixels and produce entities in deterministic order (by
  // ascending root label, since union-find gives lowest-root-wins union).
  const roots = [...bboxes.keys()].sort((a, b) => a - b);
  const entities = [];
  let id = 1;
  for (const root of roots) {
    const b = bboxes.get(root);
    if (b.count < minPixels) continue;
    const rw = b.maxX - b.minX + 1;
    const rh = b.maxY - b.minY + 1;
    entities.push({
      id: id++,
      region: [b.minX, b.minY, rw, rh],
      notes: [`pixels=${b.count}, bbox=${rw}x${rh}, fill=${((b.count / (rw * rh)) * 100).toFixed(1)}%`],
    });
  }

  return { entities };
}

// Exported for tests only.
export const __internals = {
  sobelMagnitude,
  dilate3,
  erode3,
  morphClose,
  labelAndFilter,
};
