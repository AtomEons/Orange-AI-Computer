// 07-VISUAL/structural/taps/texture-tap.mjs
//
// Pre-pooling tap for texture axis (KNOWN FAILURE, Phase A 0P/5W/7C).
// GPT: "Texture may have a broken pooling law."
// GPT: "Preserve filter-response maps, orientation/scale response maps, local energy cells, pooled texture vector."
//
// T0 source     — luminance L field over region (input to LBP + variance)
// T1 local      — variance-field cell means + per-cell 256-bin LBP histograms
// T2 pooled     — current 2 scalars: textureMeanVariance, lbpEntropy (+ top16 indices as flags/metadata not features)
// T3 aggregate  — position in axis-bundle + it80 contribution ref

import { localVariance, lbpCodes, textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { buildTap } from "../axis-tap.mjs";

const AXIS_VERSION = "texture-2.0.0";

export function textureTapForRegion(R, G, B, w, h, region) {
  const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;
  const N = w * h;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = REC709_R * R[i] + REC709_G * G[i] + REC709_B * B[i];

  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(w, x0 + rw), y1 = Math.min(h, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const rw2 = x1 - xs, rh2 = y1 - ys;

  // T0: luminance field over region
  const t0Data = new Float32Array(rw2 * rh2);
  for (let y = 0; y < rh2; y++) {
    for (let x = 0; x < rw2; x++) {
      t0Data[y * rw2 + x] = L[(ys + y) * w + (xs + x)];
    }
  }

  // Compute variance field + LBP codes (same as textureSummaryForRegion internals)
  const varField = localVariance(L, w, h, 5);
  const lbp = lbpCodes(L, w, h);

  // T1: per-cell variance-mean + per-cell 256-bin LBP histogram
  const cellW = rw2 / 3, cellH = rh2 / 3;
  const cellVarSum = new Array(9).fill(0);
  const cellCount = new Array(9).fill(0);
  const cellHist = Array.from({ length: 9 }, () => new Float32Array(256));
  for (let y = 0; y < rh2; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    for (let x = 0; x < rw2; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const src = (ys + y) * w + (xs + x);
      cellVarSum[c] += varField[src];
      cellHist[c][lbp[src]]++;
      cellCount[c]++;
    }
  }
  // Local layout: 9 cells × 257 scalars each (256 bins + 1 mean-var) = 2313 dims
  const t1Data = new Float32Array(9 * 257);
  const t1Cells = [];
  for (let c = 0; c < 9; c++) {
    const n = cellCount[c] || 1;
    const meanVar = cellVarSum[c] / n;
    t1Data[c * 257] = meanVar;
    // Normalize per-cell histogram
    for (let b = 0; b < 256; b++) {
      const nv = cellHist[c][b] / n;
      cellHist[c][b] = nv;
      t1Data[c * 257 + 1 + b] = nv;
    }
    // Top-16 for structured cell (not for T1 numeric — those are the full 257 dims)
    const entries = Array.from(cellHist[c]).map((v, i) => ({ v, i })).sort((a, b) => b.v - a.v).slice(0, 16);
    t1Cells.push({
      cellId: c, row: Math.floor(c / 3), col: c % 3,
      meanVariance: meanVar,
      lbpTopCodes: entries.map(e => e.i),
      lbpTopFractions: entries.map(e => e.v),
      pixelCount: cellCount[c],
    });
  }

  // T2: current pooled axis output — only 2 numeric scalars
  const pooled = textureSummaryForRegion(L, w, h, region);
  const t2Data = new Float32Array(2);
  t2Data[0] = pooled.textureMeanVariance;
  t2Data[1] = pooled.lbpEntropy;

  // T3: aggregate contribution (same 2 scalars — texture pools very hard)
  const t3Data = t2Data;

  return buildTap({
    axisId: "texture",
    axisVersion: AXIS_VERSION,
    coordinateFrame: "region-local",
    units: "L in [0,1]; T2 variance normalized; T2 entropy in bits",
    taps: {
      source: { shape: [rh2, rw2], dtype: "float32", data: t0Data, layout: "luminance field" },
      local: { shape: [9, 257], dtype: "float32", data: t1Data, layout: "grid-3x3, per-cell [meanVar, hist_0..255]", cells: t1Cells },
      pooled: { shape: [2], dtype: "float32", data: t2Data, layout: "[textureMeanVariance, lbpEntropy]", keys: ["textureMeanVariance", "lbpEntropy"] },
      aggregate: { shape: [2], dtype: "float32", data: t3Data, layout: "same as pooled" },
    },
    flags: {
      poolingLaw: "T1_per_cell_257 -> global_mean_variance + global_lbp_entropy = MASSIVE pool collapse (2313 -> 2 numeric dims). Top-16 LBP codes NOT numeric; kept as metadata.",
    },
    metadata: {
      pooledKeys: ["textureMeanVariance", "lbpEntropy"],
      lbpTopCodesTotal: pooled.lbpTopCodes,   // indices — NOT numeric features
    },
  });
}
