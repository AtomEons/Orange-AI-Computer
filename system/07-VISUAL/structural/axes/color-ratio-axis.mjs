// 07-VISUAL/structural/axes/color-ratio-axis.mjs
//
// Ratio-based color features + illuminant subtraction.
//
// Photon intensity varies with lighting; photon RATIOS don't. R/G, G/B, R/B
// are illumination-invariant to first order because dimming the light
// multiplies all three channels by the same factor.
//
// Also: illuminant subtraction — given a reference "background" region (or
// the frame mean), subtract it from the object region before computing
// ratios. Removes ambient color cast.
//
// Bun-native, zero-param, deterministic.

/**
 * Compute ratio features for a region.
 *
 * @param {Float32Array} R
 * @param {Float32Array} G
 * @param {Float32Array} B
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number,number]} region
 * @param {object} [opts]
 *   opts.illuminantReference?: {R, G, B}  a mean-color to subtract before ratio-ing
 * @returns {{
 *   R_over_G, G_over_B, R_over_B,
 *   normalized_chromaticity_r, normalized_chromaticity_g, normalized_chromaticity_b,
 *   log_R_over_G, log_G_over_B, log_R_over_B,
 *   after_illuminant_subtract: boolean
 * }}
 */
export function colorRatioSummaryForRegion(R, G, B, width, height, region, opts = {}) {
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(width, x0 + rw), y1 = Math.min(height, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * width + x;
      sumR += R[i]; sumG += G[i]; sumB += B[i]; count++;
    }
  }
  if (!count) return null;
  let mR = sumR / count, mG = sumG / count, mB = sumB / count;

  // Optional illuminant subtraction
  const ref = opts.illuminantReference;
  const after_illuminant_subtract = !!ref;
  if (ref) {
    mR = Math.max(1e-6, mR - ref.R);
    mG = Math.max(1e-6, mG - ref.G);
    mB = Math.max(1e-6, mB - ref.B);
  } else {
    mR = Math.max(1e-6, mR);
    mG = Math.max(1e-6, mG);
    mB = Math.max(1e-6, mB);
  }

  // Ratios — illumination-invariant to first order
  const R_over_G = mR / mG;
  const G_over_B = mG / mB;
  const R_over_B = mR / mB;

  // Normalized chromaticity — sums to 1, illumination-invariant
  const s = mR + mG + mB;
  const nR = mR / s, nG = mG / s, nB = mB / s;

  return {
    R_over_G, G_over_B, R_over_B,
    normalized_chromaticity_r: nR,
    normalized_chromaticity_g: nG,
    normalized_chromaticity_b: nB,
    log_R_over_G: Math.log(R_over_G),
    log_G_over_B: Math.log(G_over_B),
    log_R_over_B: Math.log(R_over_B),
    after_illuminant_subtract,
  };
}

/**
 * Distance between two color-ratio signatures. Uses log-ratios (invariant to
 * multiplicative rescaling) as the primary distance and normalized-
 * chromaticity as secondary.
 */
export function colorRatioDistance(a, b) {
  if (!a || !b) return Infinity;
  let s = 0;
  s += (a.log_R_over_G - b.log_R_over_G) ** 2;
  s += (a.log_G_over_B - b.log_G_over_B) ** 2;
  s += (a.log_R_over_B - b.log_R_over_B) ** 2;
  s += (a.normalized_chromaticity_r - b.normalized_chromaticity_r) ** 2 * 3;
  s += (a.normalized_chromaticity_g - b.normalized_chromaticity_g) ** 2 * 3;
  s += (a.normalized_chromaticity_b - b.normalized_chromaticity_b) ** 2 * 3;
  return Math.sqrt(s);
}

/**
 * Compute frame-wide illuminant estimate — mean color of the whole frame,
 * or a specified background region. Used to feed opts.illuminantReference.
 */
export function estimateIlluminant(R, G, B, width, height, region = null) {
  const r = region ?? [0, 0, width, height];
  const [x0, y0, rw, rh] = r;
  const x1 = Math.min(width, x0 + rw), y1 = Math.min(height, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  let sumR = 0, sumG = 0, sumB = 0, count = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * width + x;
      sumR += R[i]; sumG += G[i]; sumB += B[i]; count++;
    }
  }
  return { R: sumR / count, G: sumG / count, B: sumB / count };
}
