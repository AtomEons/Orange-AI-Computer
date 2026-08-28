// 07-VISUAL/structural/axes/photon-correlation-axis.mjs
//
// CROSS-CHANNEL PHOTON CORRELATION — captures COVARIATION, not just mean.
//
// Two red fruits can have the same mean_R but very different R-G
// covariation across the pixel field:
//   - orange: R and G rise together (both track peel brightness → high +corr)
//   - tomato: R stays high while G varies with lighting → low +corr
//   - strawberry: seeds create dark spots where R AND G drop together (+corr)
//                but rest of flesh is high R, mid G (low corr) → complex
//   - watermelon: rind is green (G high, R low) and flesh red (R high, G low)
//                → NEGATIVE R-G corr
//
// The 6 pairwise Pearson correlations between {R, G, B, L} are 6 more
// discriminative features that don't collapse to means or variance.
// Illumination-invariant (correlation is scale-free).
// Zero learned parameters. Bun-native, Float32.

/**
 * Pearson correlation coefficient between two Float32 arrays over a region.
 */
function pearsonCorr(X, Y, indices) {
  const n = indices.length;
  if (n < 2) return 0;
  let sX = 0, sY = 0;
  for (const i of indices) { sX += X[i]; sY += Y[i]; }
  const mX = sX / n, mY = sY / n;
  let num = 0, sqX = 0, sqY = 0;
  for (const i of indices) {
    const dx = X[i] - mX, dy = Y[i] - mY;
    num += dx * dy; sqX += dx * dx; sqY += dy * dy;
  }
  const denom = Math.sqrt(sqX * sqY);
  return denom > 0 ? num / denom : 0;
}

/**
 * Compute all 6 pairwise cross-channel correlations over a region:
 *   R-G, R-B, G-B, R-L, G-L, B-L
 * where L is per-pixel luminance = 0.30R + 0.59G + 0.11B.
 */
export function photonCorrelationsForRegion(R, G, B, width, height, region) {
  const [x0, y0, w, h] = region;
  const x1 = Math.min(width, x0 + w), y1 = Math.min(height, y0 + h);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const indices = [];
  const L = new Float32Array(R.length);
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * width + x;
      indices.push(i);
      L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
    }
  }
  return {
    corr_RG: pearsonCorr(R, G, indices),
    corr_RB: pearsonCorr(R, B, indices),
    corr_GB: pearsonCorr(G, B, indices),
    corr_RL: pearsonCorr(R, L, indices),
    corr_GL: pearsonCorr(G, L, indices),
    corr_BL: pearsonCorr(B, L, indices),
  };
}
