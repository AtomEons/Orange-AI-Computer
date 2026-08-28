// 07-VISUAL/structural/axes/specular-axis.mjs
//
// Specular / diffuse ratio channel. Glossy surfaces have small bright
// highlights (high pixel variance around a moderate mean). Matte surfaces
// scatter light more uniformly (low variance, similar mean).
//
// Cheap proxy: coefficient of variation (σ_L / μ_L) inside a region.
//   glossy: CoV high because specular highlights push σ up
//   matte:  CoV low because L is uniform
//
// Not as precise as a full BRDF fit but zero-parameter and fits our
// doctrine.

export function specularSummaryForRegion(L, w, h, region) {
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(w, x0 + rw), y1 = Math.min(h, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  let sum = 0, sum2 = 0, count = 0;
  let brightCount = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const v = L[y * w + x];
      sum += v; sum2 += v * v; count++;
      if (v > 0.85) brightCount++;
    }
  }
  if (!count) return { cov: 0, brightFraction: 0, glossinessScore: 0 };
  const mean = sum / count;
  const varv = Math.max(0, sum2 / count - mean * mean);
  const std = Math.sqrt(varv);
  const cov = mean > 0 ? std / mean : 0;
  const brightFraction = brightCount / count;
  // Glossiness score: high CoV AND some bright pixels present.
  const glossinessScore = Math.min(1, cov * 3) * Math.min(1, brightFraction * 20);
  return { cov, brightFraction, glossinessScore };
}
