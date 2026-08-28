// 07-VISUAL/structural/axes/subsurface-axis.mjs
//
// Subsurface scattering channel — translucency invariant.
//
// Physical basis: light incident on a translucent material (fruit peel, skin
// under blood + fat, wax, milk) penetrates the surface, scatters within, and
// exits at a nearby point with SOFTENED intensity and REDDENED wavelength
// (because longer wavelengths penetrate deeper).
//
// Signature in a 2D image:
//   1. Edge bleeding — the transition from bright-lit side to shadow side is
//      not sharp; there's a gradient zone where light appears to leak from the
//      bright side into the shadow side. Opaque materials show hard edges.
//   2. Interior glow — the shadow side of a translucent object still has some
//      residual luminance because light re-emerges from within. Opaque
//      objects go dark in shadow.
//   3. Warm-shift at boundaries — the light exiting after subsurface travel
//      is red-shifted vs incident light. Boundary regions become slightly
//      more red-orange than surface interior.
//
// Inspired by Jensen et al 2001 "A Practical Model for Subsurface Light
// Transport" (Stanford) and its dipole diffusion approximation — the
// canonical 3D volumetric BSSRDF reference. Our estimator is a **2D
// image-space projection** of that physics, not a fidelity reproduction:
// we compute cheap statistics that correlate with subsurface-scattering
// signatures rather than solving the BSSRDF integral. Trades accuracy
// for zero-parameter Bun-implementability.
//
// Cheap zero-parameter estimator: for a warm object region, compute
//   - edge-softness = mean of local luminance gradient magnitudes normalized
//     by the max gradient (translucent → lower)
//   - shadow-glow ratio = mean L in dim-half of region / mean L in bright-half
//     (translucent → ratio closer to 1; opaque → ratio → 0)
//   - boundary warm-shift = (mean_R - mean_G) at region boundary − same at
//     interior (translucent → boundary slightly redder)
//
// Combined into a scalar `translucency` in [0, 1].
//
// This is what distinguishes:
//   real orange (translucent peel + reflective flesh) vs plastic orange (opaque)
//   human skin (subsurface + hemoglobin) vs mannequin (matte paint)
//   grape (translucent flesh) vs marble (opaque stone)
//
// Bun-only, zero learned parameters, deterministic.

/**
 * Compute a subsurface-scattering summary for a region.
 *
 * @param {Float32Array} R  red 0..1
 * @param {Float32Array} G  green 0..1
 * @param {Float32Array} B  blue 0..1
 * @param {number} width
 * @param {number} height
 * @param {[number,number,number,number]} region  [x, y, w, h]
 * @returns {{
 *   edgeSoftness: number,       // 0 = sharp opaque, 1 = soft translucent
 *   shadowGlowRatio: number,    // 0 = opaque, → 1 = translucent
 *   boundaryWarmShift: number,  // >0 = light emerges redder (subsurface signature)
 *   translucencyScore: number,  // aggregated 0..1
 * }}
 */
export function subsurfaceSummaryForRegion(R, G, B, width, height, region) {
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(width, x0 + rw), y1 = Math.min(height, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  if (x1 - xs < 4 || y1 - ys < 4) {
    return { edgeSoftness: 0, shadowGlowRatio: 0, boundaryWarmShift: 0, translucencyScore: 0 };
  }

  // 1. Luminance field for the region
  let sumL = 0, count = 0;
  const N = (x1 - xs) * (y1 - ys);
  const L = new Float32Array(N);
  let k = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * width + x;
      const lum = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
      L[k++] = lum;
      sumL += lum;
      count++;
    }
  }
  const meanL = sumL / count;

  // 2. Edge softness — mean gradient magnitude, normalized by max
  const rw2 = x1 - xs, rh2 = y1 - ys;
  let sumGrad = 0, maxGrad = 0, gCount = 0;
  for (let y = 1; y < rh2 - 1; y++) {
    for (let x = 1; x < rw2 - 1; x++) {
      const i = y * rw2 + x;
      const gx = L[i + 1] - L[i - 1];
      const gy = L[i + rw2] - L[i - rw2];
      const mag = Math.hypot(gx, gy);
      sumGrad += mag;
      if (mag > maxGrad) maxGrad = mag;
      gCount++;
    }
  }
  const meanGrad = gCount ? sumGrad / gCount : 0;
  const edgeSoftness = maxGrad > 0 ? 1 - meanGrad / maxGrad : 0;

  // 3. Shadow-glow ratio — mean L in the dim half vs mean L in the bright half
  let sumBright = 0, cBright = 0, sumDim = 0, cDim = 0;
  for (let i = 0; i < N; i++) {
    if (L[i] >= meanL) { sumBright += L[i]; cBright++; }
    else { sumDim += L[i]; cDim++; }
  }
  const meanBright = cBright ? sumBright / cBright : 1;
  const meanDim = cDim ? sumDim / cDim : 0;
  const shadowGlowRatio = meanBright > 0 ? meanDim / meanBright : 0;

  // 4. Boundary warm-shift — sample a 3-pixel-thick boundary ring and interior,
  //    compare (R - G) means. Translucent objects show boundary redder than interior.
  let bR = 0, bG = 0, bCount = 0, iR = 0, iG = 0, iCount = 0;
  const border = 3;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const isBoundary = (x - xs < border) || (x1 - x <= border) || (y - ys < border) || (y1 - y <= border);
      const i = y * width + x;
      if (isBoundary) { bR += R[i]; bG += G[i]; bCount++; }
      else { iR += R[i]; iG += G[i]; iCount++; }
    }
  }
  const boundaryRG = bCount ? bR / bCount - bG / bCount : 0;
  const interiorRG = iCount ? iR / iCount - iG / iCount : 0;
  const boundaryWarmShift = boundaryRG - interiorRG;

  // 5. Aggregate: subsurface score in [0, 1]
  const translucencyScore = Math.max(0, Math.min(1,
    0.45 * edgeSoftness
    + 0.35 * shadowGlowRatio
    + 0.20 * Math.max(0, Math.min(1, 5 * boundaryWarmShift))
  ));

  return {
    edgeSoftness,
    shadowGlowRatio,
    boundaryWarmShift,
    translucencyScore,
  };
}

/**
 * Distance between two subsurface signatures. Small for materials in the
 * same translucency class (fruit vs fruit, skin vs skin), large across
 * classes (real orange vs plastic orange).
 */
export function subsurfaceDistance(a, b) {
  if (!a || !b) return Infinity;
  const dS = a.translucencyScore - b.translucencyScore;
  const dE = a.edgeSoftness - b.edgeSoftness;
  const dG = a.shadowGlowRatio - b.shadowGlowRatio;
  const dW = a.boundaryWarmShift - b.boundaryWarmShift;
  return Math.sqrt(dS * dS + 0.6 * dE * dE + 0.6 * dG * dG + 0.4 * dW * dW);
}
