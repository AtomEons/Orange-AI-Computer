// 07-VISUAL/structural/taps/spatial-color-tap.mjs
//
// Pre-pooling tap for spatial_color axis (CONTROL, Phase A 12P/0W/0C).
// Emits T0/T1/T2/T3 per GPT doctrine v4 (spine seq 112).
//
// T0 source     — raw R, G, B, and computed luminance L over the region (flattened + region-mean)
// T1 local      — 9-cell × 3-channel (RGB) means BEFORE any log-ratio or ratio
// T2 pooled     — 45 named scalars (5 attrs × 9 cells) from spatialColorSummaryForRegion
// T3 aggregate  — position in axis-bundle (start dim, end dim) + it80 contribution ref (not the value)

import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { buildTap } from "../axis-tap.mjs";

const AXIS_VERSION = "spatial_color-2.0.0";

export function spatialColorTapForRegion(R, G, B, w, h, region) {
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(w, x0 + rw), y1 = Math.min(h, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const rw2 = x1 - xs, rh2 = y1 - ys;

  // T0: raw source field — region R + G + B concatenated + region L
  const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;
  const t0Len = rw2 * rh2;
  const t0Data = new Float32Array(t0Len * 4);   // [R, G, B, L] concatenated
  for (let y = 0; y < rh2; y++) {
    for (let x = 0; x < rw2; x++) {
      const src = (ys + y) * w + (xs + x);
      const dst = y * rw2 + x;
      const r = R[src], g = G[src], b = B[src];
      t0Data[dst] = r;
      t0Data[t0Len + dst] = g;
      t0Data[t0Len * 2 + dst] = b;
      t0Data[t0Len * 3 + dst] = REC709_R * r + REC709_G * g + REC709_B * b;
    }
  }

  // T1: per-cell 3-channel means BEFORE any log-ratio or opponent transform
  const cellW = rw2 / 3, cellH = rh2 / 3;
  const sumR = new Array(9).fill(0), sumG = new Array(9).fill(0), sumB = new Array(9).fill(0);
  const cnt = new Array(9).fill(0);
  for (let y = 0; y < rh2; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    for (let x = 0; x < rw2; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const src = (ys + y) * w + (xs + x);
      sumR[c] += R[src]; sumG[c] += G[src]; sumB[c] += B[src];
      cnt[c]++;
    }
  }
  const t1Data = new Float32Array(27);   // 9 cells × 3 channels
  const t1Cells = [];
  for (let c = 0; c < 9; c++) {
    const n = cnt[c] || 1;
    const mR = sumR[c] / n, mG = sumG[c] / n, mB = sumB[c] / n;
    t1Data[c * 3 + 0] = mR;
    t1Data[c * 3 + 1] = mG;
    t1Data[c * 3 + 2] = mB;
    t1Cells.push({
      cellId: c, row: Math.floor(c / 3), col: c % 3,
      meanR: mR, meanG: mG, meanB: mB, pixelCount: cnt[c],
    });
  }

  // T2: current pooled axis output (45 named scalars + _cells)
  const pooled = spatialColorSummaryForRegion(R, G, B, w, h, region);
  const t2Data = new Float32Array(45);
  const t2Keys = Object.keys(pooled).filter(k => !k.startsWith("_")).sort();
  for (let i = 0; i < t2Keys.length; i++) t2Data[i] = pooled[t2Keys[i]];

  // T3: aggregate contribution — where these 45 scalars land in axis_bundle,
  // and pointer to it80 (which axis lanes feed it80 via IT projection).
  const t3Data = t2Data;   // aggregate contribution IS these 45 scalars (unmodified by axis_bundle assembly)

  return buildTap({
    axisId: "spatial_color",
    axisVersion: AXIS_VERSION,
    coordinateFrame: "region-local",
    units: "normalized-[0,1]-RGB then log-ratio-opponent for T2",
    taps: {
      source: { shape: [4, rh2, rw2], dtype: "float32", data: t0Data, layout: "channels-first: R,G,B,L" },
      local: { shape: [9, 3], dtype: "float32", data: t1Data, layout: "grid-3x3-then-channels-RGB", cells: t1Cells },
      pooled: { shape: [45], dtype: "float32", data: t2Data, layout: "cell00_lum, cell00_rg, ...", cells: pooled._cells, keys: t2Keys },
      aggregate: { shape: [45], dtype: "float32", data: t3Data, layout: "same as pooled — spatial_color unmodified by axis_bundle assembly" },
    },
    flags: {
      poolingLaw: "T1_cell_means -> log-ratio-luminance + opponent-ratios per cell -> 45 named scalars",
    },
    metadata: {
      pooledKeys: t2Keys,
      cellCount: 9,
    },
  });
}
