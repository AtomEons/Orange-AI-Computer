// 07-VISUAL/structural/motion.mjs
//
// Motion field — the temporal derivative of luminance between two frames.
//
//   M(x,y,t) = |L(x,y,t+1) - L(x,y,t)|
//
// Video is motion. Photons arriving in fast succession; what changes between
// them is where events happen. Motion tells us:
//   - what's foreground (moves) vs background (static, under stable camera)
//   - which entities co-move (one object) vs vary independently
//   - where information is arriving fastest (event-density hotspots)
//
// This module provides three primitives:
//   temporalDerivative — per-pixel |ΔL|
//   motionMask         — thresholded binary mask
//   entityMotionRatio  — fraction of an entity's pixels in motion
//
// No RNG. No paid deps. Deterministic.

/**
 * Compute per-pixel |L2 - L1| where L is Rec.601 luminance.
 *
 * @param {{R,G,B}} frame1
 * @param {{R,G,B}} frame2
 * @returns {Float32Array}  same length as R
 */
export function temporalDerivative(frame1, frame2) {
  const { R: R1, G: G1, B: B1 } = frame1;
  const { R: R2, G: G2, B: B2 } = frame2;
  if (R1.length !== R2.length) throw new Error("temporalDerivative: frame size mismatch");
  const N = R1.length;
  const M = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const L1 = 0.30 * R1[i] + 0.59 * G1[i] + 0.11 * B1[i];
    const L2 = 0.30 * R2[i] + 0.59 * G2[i] + 0.11 * B2[i];
    M[i] = Math.abs(L2 - L1);
  }
  return M;
}

/**
 * Threshold a motion field into a binary mask.
 *
 * @param {Float32Array} M
 * @param {number} threshold
 * @returns {Uint8Array}
 */
export function motionMask(M, threshold) {
  const mask = new Uint8Array(M.length);
  for (let i = 0; i < M.length; i++) mask[i] = M[i] > threshold ? 1 : 0;
  return mask;
}

/**
 * Adaptive-threshold motion mask via percentile. Default uses the 75th
 * percentile — the top 25% most-moving pixels survive. This is honest for
 * scenes where camera or object motion is global (rotation, pan).
 *
 * @param {Float32Array} M
 * @param {number} [percentile]  default 0.75
 * @returns {{mask: Uint8Array, threshold: number, mean: number, max: number}}
 */
export function motionMaskAuto(M, percentile = 0.75) {
  let sum = 0, max = 0;
  for (let i = 0; i < M.length; i++) {
    sum += M[i];
    if (M[i] > max) max = M[i];
  }
  const mean = sum / M.length;
  // Percentile via sort — small arrays only, so just copy + sort.
  const sorted = new Float32Array(M);
  sorted.sort();
  const idx = Math.min(sorted.length - 1, Math.floor(sorted.length * percentile));
  const threshold = sorted[idx];
  return { mask: motionMask(M, threshold), threshold, mean, max };
}

/**
 * Fraction of an entity's pixel area that is above the motion mask.
 * Ratio in [0, 1]. Higher = more motion. Use to distinguish moving
 * foreground objects from static background.
 *
 * @param {[number,number,number,number]} region  [x, y, w, h]
 * @param {Uint8Array} mask
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
export function entityMotionRatio(region, mask, width, height) {
  const [x0, y0, w, h] = region;
  const x1 = Math.min(width, x0 + w);
  const y1 = Math.min(height, y0 + h);
  const xs = Math.max(0, x0);
  const ys = Math.max(0, y0);
  let moving = 0, total = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      total++;
      if (mask[y * width + x]) moving++;
    }
  }
  return total ? moving / total : 0;
}

/**
 * Summary statistics for a motion field — for diagnostic output.
 */
export function motionSummary(M) {
  let sum = 0, sum2 = 0, max = 0, nonzero = 0;
  for (let i = 0; i < M.length; i++) {
    sum += M[i];
    sum2 += M[i] * M[i];
    if (M[i] > max) max = M[i];
    if (M[i] > 0.01) nonzero++;
  }
  const mean = sum / M.length;
  const variance = sum2 / M.length - mean * mean;
  return {
    mean, max, std: Math.sqrt(Math.max(0, variance)),
    nonzero_frac: nonzero / M.length,
  };
}
