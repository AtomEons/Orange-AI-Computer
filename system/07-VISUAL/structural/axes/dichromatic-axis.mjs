// dichromatic-axis.mjs — physical illuminant estimation + body-reflectance
// recovery per region.
//
// FABLE MOVE 2 (revised): the highest-value new physical primitive.
//
// Physics: under diagonal von Kries illuminant change, pixel = illuminant ⊙ body.
// If we can estimate the illuminant, we recover body reflectance = pixel ⊘ illuminant
// (element-wise divide). The body-reflectance statistics are THE illumination-
// invariant identity carrier — this is exactly "the object's effect on light."
//
// Illuminant estimation is a three-vote consensus:
//   (a) White-patch: 99th-percentile per channel — assumes some bright surface reflects
//       most of the illuminant. Classic (Land, McCann).
//   (b) Gray-edge: mean gradient magnitude per channel — under diagonal illumination
//       change, gradient ratios are proportional to illuminant color (Van de Weijer 2007).
//   (c) Gray-world with specular robustness: mean of top-quartile-luminance pixels.
//
// Median of the three estimates gives a robust per-region illuminant. Then body-
// reflectance stats follow. Zero learned parameters. Bun-native.

function undoGamma(v, gamma = 2.2) {
  // sRGB → linear approximation.
  return v <= 0 ? 0 : Math.pow(v, gamma);
}

/**
 * White-patch illuminant estimate: 99th-percentile of each channel (linearized).
 * Robust against outliers — the sensor may saturate a few pixels; taking
 * the 99th percentile clips those.
 */
export function whitePatchIlluminant(R, G, B, W, H, region, gamma) {
  const [rx, ry, rw, rh] = region;
  const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(W, Math.ceil(rx + rw)), y1 = Math.min(H, Math.ceil(ry + rh));
  const rs = [], gs = [], bs = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * W + x;
      rs.push(undoGamma(R[idx], gamma));
      gs.push(undoGamma(G[idx], gamma));
      bs.push(undoGamma(B[idx], gamma));
    }
  }
  if (!rs.length) return null;
  const p99 = (arr) => {
    arr.sort((a, b) => a - b);
    return arr[Math.floor(arr.length * 0.99)];
  };
  return [p99(rs), p99(gs), p99(bs)];
}

/**
 * Gray-edge illuminant estimate (Van de Weijer): mean per-channel gradient magnitude.
 * Under diagonal illuminant, gradient magnitudes scale with illuminant color.
 */
export function grayEdgeIlluminant(R, G, B, W, H, region, gamma) {
  const [rx, ry, rw, rh] = region;
  const x0 = Math.max(1, Math.floor(rx)), y0 = Math.max(1, Math.floor(ry));
  const x1 = Math.min(W - 1, Math.ceil(rx + rw)), y1 = Math.min(H - 1, Math.ceil(ry + rh));
  let sumR = 0, sumG = 0, sumB = 0, N = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * W + x;
      const dRx = undoGamma(R[idx + 1], gamma) - undoGamma(R[idx - 1], gamma);
      const dRy = undoGamma(R[idx + W], gamma) - undoGamma(R[idx - W], gamma);
      const dGx = undoGamma(G[idx + 1], gamma) - undoGamma(G[idx - 1], gamma);
      const dGy = undoGamma(G[idx + W], gamma) - undoGamma(G[idx - W], gamma);
      const dBx = undoGamma(B[idx + 1], gamma) - undoGamma(B[idx - 1], gamma);
      const dBy = undoGamma(B[idx + W], gamma) - undoGamma(B[idx - W], gamma);
      sumR += Math.sqrt(dRx * dRx + dRy * dRy);
      sumG += Math.sqrt(dGx * dGx + dGy * dGy);
      sumB += Math.sqrt(dBx * dBx + dBy * dBy);
      N++;
    }
  }
  if (!N) return null;
  return [sumR / N, sumG / N, sumB / N];
}

/**
 * Gray-world with specular robustness: mean of pixels in the top luminance quartile.
 * The idea: brightest pixels tend to include specular/near-white content, which
 * reflects the illuminant with less body-color bias than diffuse pixels.
 */
export function brightPixelIlluminant(R, G, B, W, H, region, gamma) {
  const [rx, ry, rw, rh] = region;
  const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(W, Math.ceil(rx + rw)), y1 = Math.min(H, Math.ceil(ry + rh));
  const px = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * W + x;
      const lr = undoGamma(R[idx], gamma);
      const lg = undoGamma(G[idx], gamma);
      const lb = undoGamma(B[idx], gamma);
      const L = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
      px.push({ L, r: lr, g: lg, b: lb });
    }
  }
  if (!px.length) return null;
  px.sort((a, b) => b.L - a.L);
  const top = px.slice(0, Math.max(1, Math.floor(px.length * 0.25)));
  let sr = 0, sg = 0, sb = 0;
  for (const p of top) { sr += p.r; sg += p.g; sb += p.b; }
  return [sr / top.length, sg / top.length, sb / top.length];
}

/**
 * Median-of-three illuminant estimate. Each channel is the median of the
 * corresponding channel across the three methods. More robust than any single one.
 */
export function robustIlluminant(R, G, B, W, H, region, gamma) {
  const a = whitePatchIlluminant(R, G, B, W, H, region, gamma);
  const b = grayEdgeIlluminant(R, G, B, W, H, region, gamma);
  const c = brightPixelIlluminant(R, G, B, W, H, region, gamma);
  if (!a && !b && !c) return null;
  const est = [a, b, c].filter(Boolean);
  // Normalize each to unit chromaticity so we compare chromatic direction only.
  const chromaticize = (v) => {
    const s = v[0] + v[1] + v[2];
    return s > 1e-9 ? [v[0] / s, v[1] / s, v[2] / s] : [1 / 3, 1 / 3, 1 / 3];
  };
  const chromatics = est.map(chromaticize);
  const med = [0, 0, 0];
  for (let ch = 0; ch < 3; ch++) {
    const vals = chromatics.map(c => c[ch]).sort((a, b) => a - b);
    med[ch] = vals[Math.floor(vals.length / 2)];
  }
  // Estimate illuminant MAGNITUDE from white-patch's L or its magnitude
  const magFrom = a || b || c;
  const mag = Math.sqrt(magFrom[0] ** 2 + magFrom[1] ** 2 + magFrom[2] ** 2);
  const chromaSum = med[0] + med[1] + med[2];
  const scale = chromaSum > 1e-9 ? mag / chromaSum : 1;
  return [med[0] * (med[0] + med[1] + med[2]) * scale / (med[0] + med[1] + med[2]),
          med[1] * (med[0] + med[1] + med[2]) * scale / (med[0] + med[1] + med[2]),
          med[2] * (med[0] + med[1] + med[2]) * scale / (med[0] + med[1] + med[2])];
}

/**
 * Compute body-reflectance statistics for a region.
 * @returns {
 *   bodyChroma_r, bodyChroma_g            — illumination-corrected body chromaticity
 *   bodyMean_r, bodyMean_g, bodyMean_b    — mean body reflectance (linear)
 *   bodyLogRG, bodyLogGB, bodyLogRB       — log color ratios (illuminant-invariant)
 *   illuminant_r, illuminant_g, illuminant_b — estimated illuminant chromaticity
 *   illumConfidence                       — spread across the 3 estimators (0=perfect agreement)
 *   specularFraction                      — fraction of pixels above 95th-percentile luminance
 *   n_pixels
 * }
 */
export function dichromaticFit(R, G, B, W, H, region, opts = {}) {
  const gamma = opts.gamma ?? 2.2;
  const illum = robustIlluminant(R, G, B, W, H, region, gamma);
  if (!illum) return null;
  const [iR, iG, iB] = illum;
  const iSum = iR + iG + iB;
  const iChromaR = iSum > 1e-9 ? iR / iSum : 1 / 3;
  const iChromaG = iSum > 1e-9 ? iG / iSum : 1 / 3;
  const iChromaB = iSum > 1e-9 ? iB / iSum : 1 / 3;

  // Confidence: spread among 3 estimators
  const a = whitePatchIlluminant(R, G, B, W, H, region, gamma);
  const b = grayEdgeIlluminant(R, G, B, W, H, region, gamma);
  const c = brightPixelIlluminant(R, G, B, W, H, region, gamma);
  const chromaticize = (v) => {
    const s = v[0] + v[1] + v[2];
    return s > 1e-9 ? [v[0] / s, v[1] / s, v[2] / s] : [1 / 3, 1 / 3, 1 / 3];
  };
  const chromas = [a, b, c].filter(Boolean).map(chromaticize);
  let confSpread = 0;
  if (chromas.length > 1) {
    // Total pairwise chromatic distance
    for (let i = 0; i < chromas.length; i++)
      for (let j = i + 1; j < chromas.length; j++)
        confSpread += Math.sqrt(
          (chromas[i][0] - chromas[j][0]) ** 2 +
          (chromas[i][1] - chromas[j][1]) ** 2 +
          (chromas[i][2] - chromas[j][2]) ** 2);
  }

  // Divide pixels by illuminant to recover body reflectance
  const [rx, ry, rw, rh] = region;
  const x0 = Math.max(0, Math.floor(rx)), y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(W, Math.ceil(rx + rw)), y1 = Math.min(H, Math.ceil(ry + rh));
  const EPS_I = 1e-4;
  const iDivR = 1 / Math.max(EPS_I, iR);
  const iDivG = 1 / Math.max(EPS_I, iG);
  const iDivB = 1 / Math.max(EPS_I, iB);
  let sBR = 0, sBG = 0, sBB = 0, N = 0;
  let sLogRG = 0, sLogGB = 0, sLogRB = 0;
  const lumList = [];
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const idx = y * W + x;
      const lr = undoGamma(R[idx], gamma);
      const lg = undoGamma(G[idx], gamma);
      const lb = undoGamma(B[idx], gamma);
      const bR = lr * iDivR;
      const bG = lg * iDivG;
      const bB = lb * iDivB;
      sBR += bR; sBG += bG; sBB += bB;
      // Log color ratios of BODY-RECOVERED pixels (illuminant divided out).
      // Under von Kries, log(bR/bG) = log(lr/lg) - log(iR/iG) is exactly
      // invariant to illumination color change.
      const eps = 1e-3;
      sLogRG += Math.log((bR + eps) / (bG + eps));
      sLogGB += Math.log((bG + eps) / (bB + eps));
      sLogRB += Math.log((bR + eps) / (bB + eps));
      lumList.push(0.2126 * lr + 0.7152 * lg + 0.0722 * lb);
      N++;
    }
  }
  if (N < 4) return null;
  const bodyMean_r = sBR / N;
  const bodyMean_g = sBG / N;
  const bodyMean_b = sBB / N;
  const bodyLogRG = sLogRG / N;
  const bodyLogGB = sLogGB / N;
  const bodyLogRB = sLogRB / N;
  const bodySum = bodyMean_r + bodyMean_g + bodyMean_b;
  const bodyChroma_r = bodySum > 1e-9 ? bodyMean_r / bodySum : 1 / 3;
  const bodyChroma_g = bodySum > 1e-9 ? bodyMean_g / bodySum : 1 / 3;
  // Specular fraction: pixels above 95th luminance percentile
  lumList.sort((a, b) => a - b);
  const t95 = lumList[Math.floor(N * 0.95)];
  let specCount = 0;
  for (const L of lumList) if (L > t95) specCount++;
  const specularFraction = specCount / N;

  return {
    bodyChroma_r, bodyChroma_g,
    bodyMean_r, bodyMean_g, bodyMean_b,
    bodyLogRG, bodyLogGB, bodyLogRB,
    illuminant_r: iChromaR, illuminant_g: iChromaG, illuminant_b: iChromaB,
    illumConfidence: Math.max(0, 1 - confSpread), // 1 = 3 estimators agree
    specularFraction,
    n_pixels: N,
  };
}

/**
 * Wrapper for the axes/ family: emits a flat scalar-only object suitable
 * for signatureForUnion / signatureForRegion. Returns numeric defaults on failure.
 */
export function dichromaticSummaryForRegion(R, G, B, W, H, region, opts = {}) {
  const fit = dichromaticFit(R, G, B, W, H, region, opts);
  if (!fit) {
    return {
      bodyChroma_r: 1 / 3, bodyChroma_g: 1 / 3,
      bodyMean_r: 0, bodyMean_g: 0, bodyMean_b: 0,
      bodyLogRG: 0, bodyLogGB: 0, bodyLogRB: 0,
      illuminant_r: 1 / 3, illuminant_g: 1 / 3, illuminant_b: 1 / 3,
      illumConfidence: 0,
      specularFraction: 0,
    };
  }
  return fit;
}
