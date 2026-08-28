// 07-VISUAL/structural/axes/photon-histogram-axis.mjs
//
// PHOTON HISTOGRAM SIGNATURE — the missing axis.
//
// Every earlier axis reduced the photon flux over a region to a MEAN
// (mean_R, mean_G, mean_BY, texture_var, etc). Means collapse two very
// different photon distributions that happen to have the same average.
//
// A tomato and a watermelon slice both have mean-R ≈ 0.75, but:
//   - tomato R histogram: sharp unimodal peak at 0.8
//   - watermelon R histogram: bimodal (rind low, flesh high)
//   - strawberry R histogram: bimodal (flesh high, seed pits low)
//   - orange R histogram: uniform-ish in 0.6-0.9
//
// The DISTRIBUTION SHAPE is the concept identity signal that the mean
// discards. This module computes the per-channel histogram as a
// low-parameter shape descriptor.
//
// Design principles:
//   - 16 bins per channel (compact, distinguishes ~20 concepts easily)
//   - Normalized to unit-sum (photon-COUNT invariant to region size)
//   - Channels: R, G, B, luminance, log(R/G), log(G/B)
//     — the last two are illumination-invariant per Land's retinex
//   - Zero learned parameters
//   - Bun-native, Float32-only

const NUM_BINS = 16;

function normalizeHist(hist) {
  let s = 0;
  for (let i = 0; i < hist.length; i++) s += hist[i];
  if (s <= 0) return hist;
  const out = new Float32Array(hist.length);
  for (let i = 0; i < hist.length; i++) out[i] = hist[i] / s;
  return out;
}

/**
 * Bin a scalar in [0,1] into NUM_BINS bins.
 */
function binOf01(v) {
  const i = Math.floor(v * NUM_BINS);
  return i < 0 ? 0 : (i >= NUM_BINS ? NUM_BINS - 1 : i);
}

/**
 * Bin a log-ratio (typically in [-3, 3]) into NUM_BINS bins.
 */
function binOfLogRatio(v) {
  const t = (v + 3) / 6;   // map [-3, 3] → [0, 1]
  return binOf01(t);
}

/**
 * Compute per-channel photon histograms over a region.
 * Returns { hist_R, hist_G, hist_B, hist_L, hist_logRG, hist_logGB }
 * each a Float32Array of length NUM_BINS, unit-summed.
 */
export function photonHistogramsForRegion(R, G, B, width, height, region) {
  const [x0, y0, w, h] = region;
  const x1 = Math.min(width, x0 + w), y1 = Math.min(height, y0 + h);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const hR = new Float32Array(NUM_BINS);
  const hG = new Float32Array(NUM_BINS);
  const hB = new Float32Array(NUM_BINS);
  const hL = new Float32Array(NUM_BINS);
  const hRG = new Float32Array(NUM_BINS);
  const hGB = new Float32Array(NUM_BINS);
  let count = 0;
  for (let y = ys; y < y1; y++) {
    for (let x = xs; x < x1; x++) {
      const i = y * width + x;
      const r = R[i], g = G[i], b = B[i];
      hR[binOf01(r)]++;
      hG[binOf01(g)]++;
      hB[binOf01(b)]++;
      const lum = 0.30 * r + 0.59 * g + 0.11 * b;
      hL[binOf01(lum)]++;
      const logRG = Math.log((r + 0.01) / (g + 0.01));
      const logGB = Math.log((g + 0.01) / (b + 0.01));
      hRG[binOfLogRatio(logRG)]++;
      hGB[binOfLogRatio(logGB)]++;
      count++;
    }
  }
  if (count === 0) {
    return { hist_R: hR, hist_G: hG, hist_B: hB, hist_L: hL, hist_logRG: hRG, hist_logGB: hGB, count: 0 };
  }
  return {
    hist_R: normalizeHist(hR),
    hist_G: normalizeHist(hG),
    hist_B: normalizeHist(hB),
    hist_L: normalizeHist(hL),
    hist_logRG: normalizeHist(hRG),
    hist_logGB: normalizeHist(hGB),
    count,
  };
}

/**
 * Distribution-shape moments — 4 scalars per histogram that summarize
 * the shape (entropy, skewness, kurtosis-like, peak-index) so a query
 * can quickly compare to stored ones without transporting all 16 bins.
 */
export function histogramShapeMoments(hist) {
  const N = hist.length;
  // Entropy (0 = single peak, log(N) = uniform)
  let H = 0;
  for (let i = 0; i < N; i++) if (hist[i] > 0) H -= hist[i] * Math.log(hist[i]);
  // Mean bin index (in [0, N-1])
  let mean = 0;
  for (let i = 0; i < N; i++) mean += i * hist[i];
  // Variance of bin index
  let variance = 0;
  for (let i = 0; i < N; i++) { const d = i - mean; variance += d * d * hist[i]; }
  // Peak bin (argmax)
  let peak = 0, peakVal = 0;
  for (let i = 0; i < N; i++) if (hist[i] > peakVal) { peak = i; peakVal = hist[i]; }
  return { entropy: H, mean_bin: mean, variance: variance, peak_bin: peak, peak_value: peakVal };
}

/**
 * Compact summary of all 6 histograms — 6 × 5 = 30 scalars total.
 * This is the sizing that gets fed into the flattened signature.
 */
export function photonHistogramSummary(R, G, B, width, height, region) {
  const h = photonHistogramsForRegion(R, G, B, width, height, region);
  const keys = ["hist_R", "hist_G", "hist_B", "hist_L", "hist_logRG", "hist_logGB"];
  const out = {};
  for (const k of keys) {
    const moments = histogramShapeMoments(h[k]);
    const base = k.replace("hist_", "phot_");
    out[base + "_entropy"] = moments.entropy;
    out[base + "_mean_bin"] = moments.mean_bin;
    out[base + "_variance"] = moments.variance;
    out[base + "_peak_bin"] = moments.peak_bin;
    out[base + "_peak_value"] = moments.peak_value;
  }
  // Also carry the raw hist_L for anyone who wants full-distribution matching
  out.raw_hist_L = Array.from(h.hist_L);
  return out;
}
