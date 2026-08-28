// 07-VISUAL/structural/axes/hu-moments-axis.mjs
//
// SHAPE INVARIANT signature — the seven Hu moment invariants.
//
// Hu (1962) showed that seven specific combinations of 2D image moments
// are simultaneously invariant to translation, rotation, and scale. They
// characterize the SHAPE of a binary/grayscale region without depending
// on where the region is, how it's oriented, or how big it is in pixels.
//
// This module computes the seven invariants on a warm-mask region:
//   Round objects (orange, tomato, watermelon slice): mostly M1 (spread),
//     tiny M2..M7 (asymmetry / higher-order shape complexity)
//   Elongated objects (banana, carrot): high M1, high M2
//   Heart / lobed (strawberry): higher M3, M4
//   Complex / branched (tree, chair): high M5..M7
//
// Zero learned parameters. Deterministic. Bun-native, Float32-only.

/**
 * Compute a warm-mask over a region.
 * A pixel is "in" the shape if it's inside the region bbox AND its
 * chromaticity is warm (R > B, R + G > 0.5). This binary mask defines
 * the shape whose moments we take.
 */
function warmMask(R, G, B, width, height, region) {
  const [x0, y0, w, h] = region;
  const x1 = Math.min(width, x0 + w), y1 = Math.min(height, y0 + h);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const mask = new Uint8Array(w * h);
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * width + x;
      const r = R[i], g = G[i], b = B[i];
      if (r > b + 0.03 && r + g > 0.5) {
        mask[(y - ys) * w + (x - xs)] = 1;
      }
    }
  }
  return { mask, mw: w, mh: h };
}

/**
 * Compute raw geometric moment m_{pq} = Σ x^p × y^q × I(x,y) over the mask.
 */
function rawMoment(mask, mw, mh, p, q) {
  let s = 0;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (mask[y * mw + x]) s += Math.pow(x, p) * Math.pow(y, q);
    }
  }
  return s;
}

/**
 * Central moment μ_{pq} — translation-invariant.
 */
function centralMoment(mask, mw, mh, p, q, xbar, ybar) {
  let s = 0;
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      if (mask[y * mw + x]) s += Math.pow(x - xbar, p) * Math.pow(y - ybar, q);
    }
  }
  return s;
}

/**
 * Compute Hu's seven invariant moments (log-scaled sign-preserving) for a
 * warm-mask region. Returns { hu: [h1..h7], area, aspect_ratio_from_moments }.
 *
 * Log-scaling: h_log = sign(h) × log(|h| + eps). Better numerical dynamic
 * range across small and large moments.
 */
export function huMomentsForRegion(R, G, B, width, height, region) {
  const { mask, mw, mh } = warmMask(R, G, B, width, height, region);
  // Raw moments up to order 3
  const m00 = rawMoment(mask, mw, mh, 0, 0);
  if (m00 <= 0) return { hu: new Float32Array(7), area: 0, aspect_from_moments: 0 };
  const m10 = rawMoment(mask, mw, mh, 1, 0);
  const m01 = rawMoment(mask, mw, mh, 0, 1);
  const xbar = m10 / m00;
  const ybar = m01 / m00;
  // Central moments
  const mu20 = centralMoment(mask, mw, mh, 2, 0, xbar, ybar);
  const mu02 = centralMoment(mask, mw, mh, 0, 2, xbar, ybar);
  const mu11 = centralMoment(mask, mw, mh, 1, 1, xbar, ybar);
  const mu30 = centralMoment(mask, mw, mh, 3, 0, xbar, ybar);
  const mu03 = centralMoment(mask, mw, mh, 0, 3, xbar, ybar);
  const mu21 = centralMoment(mask, mw, mh, 2, 1, xbar, ybar);
  const mu12 = centralMoment(mask, mw, mh, 1, 2, xbar, ybar);

  // Scale-normalized central moments η_{pq} = μ_{pq} / μ_{00}^((p+q)/2 + 1)
  function eta(mu, p, q) {
    const power = (p + q) / 2 + 1;
    return mu / Math.pow(m00, power);
  }
  const e20 = eta(mu20, 2, 0);
  const e02 = eta(mu02, 0, 2);
  const e11 = eta(mu11, 1, 1);
  const e30 = eta(mu30, 3, 0);
  const e03 = eta(mu03, 0, 3);
  const e21 = eta(mu21, 2, 1);
  const e12 = eta(mu12, 1, 2);

  // The seven Hu invariants
  const h1 = e20 + e02;
  const h2 = (e20 - e02) ** 2 + 4 * e11 * e11;
  const h3 = (e30 - 3 * e12) ** 2 + (3 * e21 - e03) ** 2;
  const h4 = (e30 + e12) ** 2 + (e21 + e03) ** 2;
  const h5 = (e30 - 3 * e12) * (e30 + e12) * ((e30 + e12) ** 2 - 3 * (e21 + e03) ** 2)
           + (3 * e21 - e03) * (e21 + e03) * (3 * (e30 + e12) ** 2 - (e21 + e03) ** 2);
  const h6 = (e20 - e02) * ((e30 + e12) ** 2 - (e21 + e03) ** 2)
           + 4 * e11 * (e30 + e12) * (e21 + e03);
  const h7 = (3 * e21 - e03) * (e30 + e12) * ((e30 + e12) ** 2 - 3 * (e21 + e03) ** 2)
           - (e30 - 3 * e12) * (e21 + e03) * (3 * (e30 + e12) ** 2 - (e21 + e03) ** 2);

  // Log-transform with sign preservation for better dynamic range
  const eps = 1e-12;
  function signLog(x) { return x >= 0 ? Math.log(x + eps) : -Math.log(-x + eps); }

  const hu = new Float32Array([
    signLog(h1), signLog(h2), signLog(h3), signLog(h4),
    signLog(h5), signLog(h6), signLog(h7),
  ]);

  const aspect = mu02 > 0 ? Math.log((mu20 + eps) / (mu02 + eps)) : 0;
  return { hu, area: m00, aspect_from_moments: aspect };
}
