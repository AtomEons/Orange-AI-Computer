// 07-VISUAL/structural/mono-depth.mjs
//
// Classical monocular depth heuristics.
//
// MiDaS and similar learned monocular estimators use scene priors trained on
// millions of images. We don't have that. What we CAN do honestly without
// training data is combine three classical depth cues:
//
//   1. Sharpness / defocus — sharper regions are closer to the focal plane.
//      Under a fixed-aperture camera, sharpness ∝ inverse distance from
//      focal plane. Computed as local Laplacian variance.
//   2. Ground-plane prior — objects near the bottom of the frame are usually
//      closer (assumes horizontally-mounted camera looking forward or down).
//      Gives a monotonic y → depth mapping.
//   3. Aerial perspective — distant objects lose saturation and contrast
//      due to atmospheric scattering. Local RGB saturation is a weak but
//      real depth cue for outdoor scenes.
//
// None are as strong as a learned monocular estimator. They are honest,
// deterministic, no external checkpoints. Weight them and combine.

/**
 * Per-pixel sharpness map via local Laplacian variance.
 * High values = sharp = near focal plane. Low values = blurred = far.
 *
 * @param {Float32Array} L  luminance [0,1]
 * @param {number} width
 * @param {number} height
 * @param {number} [windowSize]  default 5
 * @returns {Float32Array}  same shape, normalized to [0,1]
 */
export function sharpnessMap(L, width, height, windowSize = 5) {
  const N = width * height;
  const lap = new Float32Array(N);
  // Compute Laplacian via 3x3 kernel [0 1 0; 1 -4 1; 0 1 0]
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const i = y * width + x;
      lap[i] = L[i - width] + L[i + width] + L[i - 1] + L[i + 1] - 4 * L[i];
    }
  }
  // Local variance of |lap| in window
  const half = windowSize >> 1;
  const out = new Float32Array(N);
  let maxSharp = 0;
  for (let y = half; y < height - half; y++) {
    for (let x = half; x < width - half; x++) {
      let sum = 0, sum2 = 0, count = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const v = Math.abs(lap[(y + dy) * width + (x + dx)]);
          sum += v; sum2 += v * v; count++;
        }
      }
      const mean = sum / count;
      const varv = Math.max(0, sum2 / count - mean * mean);
      const i = y * width + x;
      out[i] = varv;
      if (varv > maxSharp) maxSharp = varv;
    }
  }
  if (maxSharp > 0) for (let i = 0; i < N; i++) out[i] /= maxSharp;
  return out;
}

/**
 * Ground-plane depth prior. Bottom of frame = closer (depth ~ 0).
 * Top of frame = farther (depth ~ 1). Assumes horizontally-mounted camera.
 * Optional horizon at some y_fraction — depth is 0 below, ramps to 1 at top.
 */
export function groundPlanePrior(width, height, opts = {}) {
  const horizon = opts.horizonFrac ?? 0.4;  // where does depth start increasing
  const N = width * height;
  const out = new Float32Array(N);
  for (let y = 0; y < height; y++) {
    const yFrac = y / (height - 1);
    let depth;
    if (yFrac >= horizon) depth = 0;  // ground, near camera
    else depth = (horizon - yFrac) / horizon; // above horizon, farther
    for (let x = 0; x < width; x++) out[y * width + x] = depth;
  }
  return out;
}

/**
 * Aerial-perspective depth prior. Distant objects lose saturation
 * (atmospheric haze). Depth ∝ 1 - saturation.
 * Only meaningful for outdoor scenes; for indoor / closeup, contributes
 * noise. Low weight recommended in fusion.
 */
export function aerialPerspectiveMap(R, G, B) {
  const N = R.length;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const mx = Math.max(R[i], G[i], B[i]);
    const mn = Math.min(R[i], G[i], B[i]);
    const sat = mx > 0 ? (mx - mn) / mx : 0;
    out[i] = 1 - sat;
  }
  return out;
}

/**
 * Weighted fusion of monocular depth cues + optional OF-derived depth.
 * All input maps must be [0,1] normalized and same size.
 *
 * @param {Array<{map: Float32Array, weight: number}>} cues
 * @returns {Float32Array}  fused depth in [0,1]
 */
export function fuseDepthCues(cues) {
  if (!cues.length) throw new Error("fuseDepthCues: need at least one cue");
  const N = cues[0].map.length;
  let totalW = 0;
  for (const c of cues) totalW += c.weight;
  if (totalW === 0) throw new Error("fuseDepthCues: total weight is zero");
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let sum = 0;
    for (const c of cues) sum += c.weight * c.map[i];
    out[i] = sum / totalW;
  }
  return out;
}

/**
 * Depth summary statistics for reporting.
 */
export function depthSummary(depth) {
  let sum = 0, sum2 = 0, mn = Infinity, mx = -Infinity;
  for (let i = 0; i < depth.length; i++) {
    sum += depth[i]; sum2 += depth[i] * depth[i];
    if (depth[i] < mn) mn = depth[i];
    if (depth[i] > mx) mx = depth[i];
  }
  const mean = sum / depth.length;
  const std = Math.sqrt(Math.max(0, sum2 / depth.length - mean * mean));
  return { mean, std, min: mn, max: mx, range: mx - mn };
}

/**
 * Mean depth within a region — for per-entity depth reporting.
 */
export function entityMeanDepth(region, depth, width, height) {
  const [x0, y0, w, h] = region;
  const x1 = Math.min(width, x0 + w);
  const y1 = Math.min(height, y0 + h);
  const xs = Math.max(0, x0);
  const ys = Math.max(0, y0);
  let sum = 0, count = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      sum += depth[y * width + x];
      count++;
    }
  }
  return count ? sum / count : 0.5;
}
