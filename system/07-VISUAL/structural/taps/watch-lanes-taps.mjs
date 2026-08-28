// 07-VISUAL/structural/taps/watch-lanes-taps.mjs
//
// Pre-pooling taps for the 5 remaining questionable axes per GPT doctrine v4.
// Emits T0/T1/T2/T3 arrays per axis for the pilot's L2-normed distance test.
// Each function returns { T0, T1, T2, T3 } — raw Float32Array levels (no metadata wrapping),
// matching the pattern used by scLevels/txLevels in phase-a-tap-pilot.mjs.
//
// Axes wired:
//   - photon_histogram
//   - photon_correlation
//   - color_ratio
//   - dichromatic
//   - hu_moments

import {
  photonHistogramsForRegion, histogramShapeMoments, photonHistogramSummary,
} from "../axes/photon-histogram-axis.mjs";
import { photonCorrelationsForRegion } from "../axes/photon-correlation-axis.mjs";
import { colorRatioSummaryForRegion } from "../axes/color-ratio-axis.mjs";
import { dichromaticFit, dichromaticSummaryForRegion } from "../axes/dichromatic-axis.mjs";
import { huMomentsForRegion } from "../axes/hu-moments-axis.mjs";

const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;

function cropRGB(R, G, B, w, h, region) {
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(w, x0 + rw), y1 = Math.min(h, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const rw2 = x1 - xs, rh2 = y1 - ys;
  const N = rw2 * rh2;
  const cR = new Float32Array(N), cG = new Float32Array(N), cB = new Float32Array(N);
  for (let y = 0; y < rh2; y++) {
    for (let x = 0; x < rw2; x++) {
      const src = (ys + y) * w + (xs + x);
      const dst = y * rw2 + x;
      cR[dst] = R[src]; cG[dst] = G[src]; cB[dst] = B[src];
    }
  }
  return { R: cR, G: cG, B: cB, w: rw2, h: rh2 };
}

// ---- photon_histogram ----
// T0: [R, G, B] cropped, flattened  (source field the axis reads)
// T1: 6 channel × 16 bin histograms (96 dims — the localized distributions before shape moment reduction)
// T2: 30 shape-moment scalars (5 moments × 6 histograms — current pooled output; drops raw_hist_L array)
// T3: same as T2 (axis not modified by aggregate assembly)
export function phLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  // T0
  const T0 = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { T0[i] = R[i]; T0[N + i] = G[i]; T0[N * 2 + i] = B[i]; }
  // T1: full 6-histogram field
  const hists = photonHistogramsForRegion(R, G, B, w, h, [0, 0, w, h]);
  const T1 = new Float32Array(6 * 16);
  const histKeys = ["hist_R", "hist_G", "hist_B", "hist_L", "hist_logRG", "hist_logGB"];
  for (let k = 0; k < 6; k++) {
    const hk = hists[histKeys[k]];
    for (let b = 0; b < 16; b++) T1[k * 16 + b] = hk[b] ?? 0;
  }
  // T2: 30 shape-moment scalars (current pool)
  const pool = photonHistogramSummary(R, G, B, w, h, [0, 0, w, h]);
  const T2keys = Object.keys(pool).filter(k => k !== "raw_hist_L").sort();
  const T2 = new Float32Array(T2keys.length);
  for (let i = 0; i < T2keys.length; i++) T2[i] = pool[T2keys[i]];
  return { T0, T1, T2, T3: T2 };
}

// ---- photon_correlation ----
// T0: [R, G, B] cropped
// T1: 6 correlations per cell (3x3 grid) — 54 dims
// T2: 6 global correlations — current pooled
// T3: same as T2
export function pcLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const T0 = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { T0[i] = R[i]; T0[N + i] = G[i]; T0[N * 2 + i] = B[i]; }
  // T1: per-cell 6 correlations
  const cellW = w / 3, cellH = h / 3;
  const T1 = new Float32Array(9 * 6);
  for (let c = 0; c < 9; c++) {
    const row = Math.floor(c / 3), col = c % 3;
    const cx0 = Math.floor(col * cellW), cy0 = Math.floor(row * cellH);
    const cx1 = Math.floor((col + 1) * cellW), cy1 = Math.floor((row + 1) * cellH);
    const cw = cx1 - cx0, ch = cy1 - cy0;
    if (cw < 4 || ch < 4) continue;
    const cc = photonCorrelationsForRegion(R, G, B, w, h, [cx0, cy0, cw, ch]);
    T1[c * 6 + 0] = cc.corr_RG;
    T1[c * 6 + 1] = cc.corr_RB;
    T1[c * 6 + 2] = cc.corr_GB;
    T1[c * 6 + 3] = cc.corr_RL;
    T1[c * 6 + 4] = cc.corr_GL;
    T1[c * 6 + 5] = cc.corr_BL;
  }
  // T2: 6 global correlations
  const pool = photonCorrelationsForRegion(R, G, B, w, h, [0, 0, w, h]);
  const T2 = new Float32Array([
    pool.corr_RG, pool.corr_RB, pool.corr_GB, pool.corr_RL, pool.corr_GL, pool.corr_BL,
  ]);
  return { T0, T1, T2, T3: T2 };
}

// ---- color_ratio ----
// T0: [R, G, B] cropped
// T1: 3-channel means per cell before any ratio (9 cells × 3 = 27 dims)
// T2: 9 pooled scalars (R/G, G/B, R/B, chromR, chromG, chromB, logRG, logGB, logRB) — the boolean flag is NOT a numeric feature
// T3: same as T2
export function crLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const T0 = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { T0[i] = R[i]; T0[N + i] = G[i]; T0[N * 2 + i] = B[i]; }
  // T1: per-cell 3 means
  const cellW = w / 3, cellH = h / 3;
  const T1 = new Float32Array(27);
  const sumR = new Array(9).fill(0), sumG = new Array(9).fill(0), sumB = new Array(9).fill(0), cnt = new Array(9).fill(0);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const src = y * w + x;
      sumR[c] += R[src]; sumG[c] += G[src]; sumB[c] += B[src]; cnt[c]++;
    }
  }
  for (let c = 0; c < 9; c++) {
    const n = cnt[c] || 1;
    T1[c * 3] = sumR[c] / n; T1[c * 3 + 1] = sumG[c] / n; T1[c * 3 + 2] = sumB[c] / n;
  }
  // T2: current 9 pooled scalars (boolean after_illuminant_subtract stays in metadata, not numeric)
  const pool = colorRatioSummaryForRegion(R, G, B, w, h, [0, 0, w, h]);
  const T2 = new Float32Array([
    pool.R_over_G, pool.G_over_B, pool.R_over_B,
    pool.normalized_chromaticity_r, pool.normalized_chromaticity_g, pool.normalized_chromaticity_b,
    pool.log_R_over_G, pool.log_G_over_B, pool.log_R_over_B,
  ]);
  return { T0, T1, T2, T3: T2 };
}

// ---- dichromatic ----
// T0: [R, G, B] cropped
// T1: per-cell 3 body-mean values + 3 illuminant-chroma values (54 dims total)
// T2: current 11 pooled scalars
// T3: same as T2
export function dcLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const T0 = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { T0[i] = R[i]; T0[N + i] = G[i]; T0[N * 2 + i] = B[i]; }
  // T1: per-cell dichromatic fit (body means + illuminant chroma)
  const cellW = w / 3, cellH = h / 3;
  const T1 = new Float32Array(9 * 6);
  for (let c = 0; c < 9; c++) {
    const row = Math.floor(c / 3), col = c % 3;
    const cx0 = Math.floor(col * cellW), cy0 = Math.floor(row * cellH);
    const cx1 = Math.floor((col + 1) * cellW), cy1 = Math.floor((row + 1) * cellH);
    const cw = cx1 - cx0, ch = cy1 - cy0;
    if (cw < 4 || ch < 4) continue;
    const fit = dichromaticFit(R, G, B, w, h, [cx0, cy0, cw, ch]);
    if (!fit) continue;
    T1[c * 6 + 0] = fit.bodyMean_r;
    T1[c * 6 + 1] = fit.bodyMean_g;
    T1[c * 6 + 2] = fit.bodyMean_b;
    T1[c * 6 + 3] = fit.illuminant_r;
    T1[c * 6 + 4] = fit.illuminant_g;
    T1[c * 6 + 5] = fit.illuminant_b;
  }
  // T2: current pooled scalars — EXCLUDE n_pixels (image-size metadata, not feature).
  // Would otherwise dominate L2 norm since n_pixels ~ 147k while other dims are [0,1].
  // GPT doctrine v4: implementation state / metadata must not enter the numeric vector.
  const METADATA_KEYS = new Set(["n_pixels"]);
  const pool = dichromaticSummaryForRegion(R, G, B, w, h, [0, 0, w, h]);
  const keys = Object.keys(pool).filter(k => typeof pool[k] === "number" && !METADATA_KEYS.has(k)).sort();
  const T2 = new Float32Array(keys.length);
  for (let i = 0; i < keys.length; i++) T2[i] = pool[keys[i]];
  return { T0, T1, T2, T3: T2 };
}

// ---- hu_moments ----
// T0: [R, G, B] cropped
// T1: warm-mask flattened (binary) — the SOURCE OF THE MOMENTS
// T2: 7 Hu invariants + area + aspect (9 scalars pooled)
// T3: same as T2
export function huLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const T0 = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) { T0[i] = R[i]; T0[N + i] = G[i]; T0[N * 2 + i] = B[i]; }
  // T1: reconstruct the warm mask that hu_moments consumes
  const T1 = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (R[i] > B[i] + 0.03 && R[i] + G[i] > 0.5) T1[i] = 1;
  }
  // T2: pooled 7 Hu + area + aspect
  const hu = huMomentsForRegion(R, G, B, w, h, [0, 0, w, h]);
  const T2 = new Float32Array(9);
  for (let i = 0; i < 7; i++) T2[i] = hu.hu[i];
  T2[7] = hu.area;
  T2[8] = hu.aspect_from_moments;
  return { T0, T1, T2, T3: T2 };
}
