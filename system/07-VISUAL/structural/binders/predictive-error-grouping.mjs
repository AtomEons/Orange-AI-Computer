// 07-VISUAL/structural/binders/predictive-error-grouping.mjs
//
// Object-binder for AE Eyes — predictive-error grouping (free-energy-lite).
//
// Doctrine:
//   The retina/cortex predicts the visual field from local neighbors. Where the
//   prediction is good (low residual |eps|), the region is "explanatorily
//   complete" — a smooth object interior. Where the prediction is bad
//   (high |eps|), the pixel is a SURPRISE — an object boundary or a texture
//   discontinuity. We group the smooth-interior connected components and emit
//   their bounding boxes as candidate object footprints.
//
// This is a lite version of Karl Friston's predictive-coding / free-energy
// framework: minimize surprise. Pixels that surprise a smooth-neighbor
// predictor lie on structural boundaries; pixels that don't are inside an
// object surface.
//
// Determinism: pure function of (R, width, height, opts). No RNG. No wall clock.
// Bun-only pure JS. Backend only. No paid deps.

export const DISCIPLINE = "predictive-error-grouping";

const DEFAULTS = Object.freeze({
  // Local predictor kernel side (must be odd). Prediction of R(x,y) is the
  // MEAN of the KxK neighborhood centered on (x,y) with the CENTER PIXEL
  // EXCLUDED (leave-one-out). K=3 → 8 neighbors, K=5 → 24 neighbors.
  kernel: 3,

  // Percentile of the |eps| distribution BELOW which a pixel counts as
  // "smoothly predicted" (object interior). 0.50 = pick pixels whose
  // residual is in the lower half of the frame's residual distribution.
  smoothPercentile: 0.50,

  // Percentile ABOVE which a pixel counts as a boundary "surprise". Used
  // only for notes/diagnostics — the binder emits smooth interiors as
  // entities, not surprise contours.
  surprisePercentile: 0.90,

  // Minimum area (pixels) for a smooth region to be emitted as an entity.
  // Anything smaller is noise-scale and discarded.
  minArea: 400,

  // Maximum number of entities to emit (largest by area). Prevents an
  // over-fragmented image from swamping the aggregator.
  maxEntities: 50,
});

/**
 * @param {Float32Array} R      photoreceptor-processed luminance, 0..1, w*h
 * @param {number} width
 * @param {number} height
 * @param {object} opts
 * @returns {{ discipline, entities, notes }}
 */
export function bind(R, width, height, opts = {}) {
  const cfg = { ...DEFAULTS, ...opts };
  const notes = [];

  // Coerce kernel to odd >= 3.
  let K = cfg.kernel | 0;
  if (K < 3) K = 3;
  if ((K & 1) === 0) K += 1;
  const half = (K - 1) >> 1;
  const neighborCount = K * K - 1;

  if (!R || R.length !== width * height) {
    return {
      discipline: DISCIPLINE,
      entities: [],
      notes: [
        `input mismatch: R.length=${R ? R.length : "null"} vs width*height=${width * height}`,
      ],
    };
  }

  const N = width * height;

  // --- Step 1 & 2: compute leave-one-out neighborhood mean and residual eps.
  // Border pixels (within `half` of the edge) get eps=0 — the predictor cannot
  // form a full kernel there, and we don't want spurious boundaries at the
  // image edge polluting the residual distribution.
  const eps = new Float32Array(N);
  const epsMask = new Uint8Array(N); // 1 = pixel has a valid residual

  for (let y = half; y < height - half; y++) {
    for (let x = half; x < width - half; x++) {
      let sum = 0;
      const centerIdx = y * width + x;
      const centerVal = R[centerIdx];
      for (let dy = -half; dy <= half; dy++) {
        const yy = y + dy;
        const rowBase = yy * width;
        for (let dx = -half; dx <= half; dx++) {
          if (dx === 0 && dy === 0) continue;
          sum += R[rowBase + x + dx];
        }
      }
      const predicted = sum / neighborCount;
      const residual = centerVal - predicted;
      const absRes = residual < 0 ? -residual : residual;
      eps[centerIdx] = absRes;
      epsMask[centerIdx] = 1;
    }
  }

  // --- Step 3: pick data-driven thresholds from the |eps| distribution.
  // Percentile-based, so thresholds adapt to the frame's contrast without
  // any magic constant tuned per-image.
  const validEps = [];
  for (let i = 0; i < N; i++) {
    if (epsMask[i]) validEps.push(eps[i]);
  }
  if (validEps.length === 0) {
    return {
      discipline: DISCIPLINE,
      entities: [],
      notes: [
        `no valid residuals — image smaller than kernel (${width}x${height}, K=${K})`,
      ],
    };
  }

  // Deterministic sort of a copy — validEps is already a fresh array.
  validEps.sort((a, b) => a - b);
  const pIdx = (p) => {
    const idx = Math.floor(p * (validEps.length - 1));
    return validEps[idx];
  };
  const lowTau = pIdx(cfg.smoothPercentile);
  const highTau = pIdx(cfg.surprisePercentile);
  const meanEps = validEps.reduce((a, b) => a + b, 0) / validEps.length;

  // Uniform-R case: if the whole |eps| distribution is essentially zero, the
  // frame is entirely predictable — one entity is the whole frame.
  const UNIFORM_EPS = 1e-6;
  const uniformFrame = validEps[validEps.length - 1] < UNIFORM_EPS;
  if (uniformFrame) {
    notes.push(
      `predictor kernel ${K}x${K} (leave-one-out); frame is uniform (max|eps|<${UNIFORM_EPS}) — emitting the whole frame as one entity`,
      `low-|eps| threshold: N/A (uniform); high-|eps| threshold: N/A (uniform)`,
      `known-fail cases: highly textured objects (grass, wood grain, fabric) will have high internal |eps| and fragment; specular highlights will register as boundaries`,
    );
    return {
      discipline: DISCIPLINE,
      entities: [
        { id: 1, region: [0, 0, width, height], notes: ["uniform-R frame"] },
      ],
      notes,
    };
  }

  // --- Step 4: connected components of the "smooth interior" mask.
  //   smoothMask[i] = 1 iff pixel i has a valid residual AND |eps| <= lowTau.
  const smoothMask = new Uint8Array(N);
  for (let i = 0; i < N; i++) {
    if (epsMask[i] && eps[i] <= lowTau) smoothMask[i] = 1;
  }

  const labels = new Int32Array(N); // 0 = unlabeled/background
  let nextLabel = 0;
  const stack = new Int32Array(N); // BFS queue reused; stores pixel indices
  // Per-component bounding-box accumulators; index [label] = {x0,y0,x1,y1,area}
  const bboxX0 = [];
  const bboxY0 = [];
  const bboxX1 = [];
  const bboxY1 = [];
  const bboxArea = [];

  for (let sy = 0; sy < height; sy++) {
    for (let sx = 0; sx < width; sx++) {
      const seed = sy * width + sx;
      if (!smoothMask[seed] || labels[seed] !== 0) continue;
      nextLabel++;
      let head = 0;
      let tail = 0;
      stack[tail++] = seed;
      labels[seed] = nextLabel;
      let x0 = sx, y0 = sy, x1 = sx, y1 = sy, area = 0;

      while (head < tail) {
        const p = stack[head++];
        const py = (p / width) | 0;
        const px = p - py * width;
        area++;
        if (px < x0) x0 = px;
        if (py < y0) y0 = py;
        if (px > x1) x1 = px;
        if (py > y1) y1 = py;

        // 4-connectivity for a clean, deterministic flood.
        // left
        if (px > 0) {
          const q = p - 1;
          if (smoothMask[q] && labels[q] === 0) {
            labels[q] = nextLabel;
            stack[tail++] = q;
          }
        }
        // right
        if (px < width - 1) {
          const q = p + 1;
          if (smoothMask[q] && labels[q] === 0) {
            labels[q] = nextLabel;
            stack[tail++] = q;
          }
        }
        // up
        if (py > 0) {
          const q = p - width;
          if (smoothMask[q] && labels[q] === 0) {
            labels[q] = nextLabel;
            stack[tail++] = q;
          }
        }
        // down
        if (py < height - 1) {
          const q = p + width;
          if (smoothMask[q] && labels[q] === 0) {
            labels[q] = nextLabel;
            stack[tail++] = q;
          }
        }
      }

      bboxX0.push(x0);
      bboxY0.push(y0);
      bboxX1.push(x1);
      bboxY1.push(y1);
      bboxArea.push(area);
    }
  }

  // --- Step 5: filter tiny regions, sort by area desc, cap count.
  const kept = [];
  for (let i = 0; i < bboxArea.length; i++) {
    if (bboxArea[i] >= cfg.minArea) {
      kept.push({
        label: i + 1,
        x: bboxX0[i],
        y: bboxY0[i],
        w: bboxX1[i] - bboxX0[i] + 1,
        h: bboxY1[i] - bboxY0[i] + 1,
        area: bboxArea[i],
      });
    }
  }
  kept.sort((a, b) => b.area - a.area);
  const trimmed = kept.slice(0, cfg.maxEntities);
  const droppedForCap = kept.length - trimmed.length;

  const entities = trimmed.map((k, idx) => ({
    id: idx + 1,
    region: [k.x, k.y, k.w, k.h],
    notes: [`interior area=${k.area}px`],
  }));

  // --- Step 6: honest notes.
  notes.push(
    `predictor kernel: ${K}x${K} mean-of-neighbors, leave-one-out (${neighborCount} neighbors)`,
    `smooth-interior threshold (low |eps|): ${lowTau.toFixed(6)} (${(cfg.smoothPercentile * 100).toFixed(0)}th percentile of residuals)`,
    `surprise threshold (high |eps|): ${highTau.toFixed(6)} (${(cfg.surprisePercentile * 100).toFixed(0)}th percentile)`,
    `mean |eps| across frame: ${meanEps.toFixed(6)}`,
    `raw smooth-interior components: ${bboxArea.length}; kept after minArea=${cfg.minArea}: ${kept.length}; emitted after cap=${cfg.maxEntities}: ${trimmed.length}${droppedForCap > 0 ? ` (${droppedForCap} dropped by cap)` : ""}`,
    `known-fail cases: highly textured objects (grass, wood grain, fabric, dense foliage) have high INTERNAL |eps| and will fragment into many small interiors or be discarded by minArea; specular highlights and object edges register as boundaries and are correctly excluded from interiors; objects whose interior gradient (slow shading) exceeds lowTau will not bind as one component`,
    `border strip of width ${half}px on each side has eps=0 (predictor cannot form a full kernel there); those pixels are excluded from residual statistics`,
  );

  return {
    discipline: DISCIPLINE,
    entities,
    notes,
  };
}
