// 07-VISUAL/structural/axes/spatial-color-axis.mjs
//
// Spatial spectral distribution channel — STRUCTURED per GPT doctrine v2 (spine seq 107).
//
// Prior version emitted { cells: [27 flat numbers] } which was silently dropped by
// build-wide-it.mjs flatten (typeof !== "number"). Phase A named spatial_color as
// second-strongest axis (7P/3W/2C) despite being absent from wide-IT.
//
// This version emits each cell as a STRUCTURED RECORD carrying:
//   cellId, row, column, eccentricity, luminance, redGreen, blueYellow, saturation, confidence
//
// Plus 45 named scalars (5 attrs × 9 cells) that build-wide-it flatten picks up naturally.
// The structured records are preserved under _cells (underscore-prefixed → skipped by flatten,
// available to downstream recognizers).
//
// Illuminant invariance (Fable Move 4):
//   luminance    = log(cell_L + eps) − log(region_L + eps)     — illum cancels under log-subtract
//   redGreen     = (R − G) / (R + G + eps)                     — ratio invariant to mult scaling
//   blueYellow   = (0.5·(R+G) − B) / (R + G + B + eps)         — ratio invariant to mult scaling
//   saturation   = sqrt(redGreen² + blueYellow²)                — chromatic magnitude
//   confidence   = counts[c] / (regionCount / 9)                — 1.0 for balanced cell counts
//
// Zero learned parameters. Deterministic. Bun-native.

const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;

export function spatialColorSummaryForRegion(R, G, B, w, h, region) {
  const [x0, y0, rw, rh] = region;
  const x1 = Math.min(w, x0 + rw), y1 = Math.min(h, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const rx = x1 - xs, ry = y1 - ys;

  // Empty region — emit 45 zero scalars + empty structured cells
  if (rx < 3 || ry < 3) {
    const emptyOut = {};
    const emptyCells = [];
    for (let c = 0; c < 9; c++) {
      const row = Math.floor(c / 3), col = c % 3;
      emptyOut[`cell${String(c).padStart(2, "0")}_luminance`] = 0;
      emptyOut[`cell${String(c).padStart(2, "0")}_redGreen`] = 0;
      emptyOut[`cell${String(c).padStart(2, "0")}_blueYellow`] = 0;
      emptyOut[`cell${String(c).padStart(2, "0")}_saturation`] = 0;
      emptyOut[`cell${String(c).padStart(2, "0")}_confidence`] = 0;
      emptyCells.push({ cellId: c, row, column: col, eccentricity: 0, luminance: 0, redGreen: 0, blueYellow: 0, saturation: 0, confidence: 0 });
    }
    emptyOut._cells = emptyCells;
    return emptyOut;
  }

  const cellW = rx / 3, cellH = ry / 3;
  const sumsR = new Array(9).fill(0);
  const sumsG = new Array(9).fill(0);
  const sumsB = new Array(9).fill(0);
  const counts = new Array(9).fill(0);
  let regionSumR = 0, regionSumG = 0, regionSumB = 0, regionCount = 0;

  for (let y = ys; y < y1; y++) {
    const cy = Math.min(2, Math.floor((y - ys) / cellH));
    for (let x = xs; x < x1; x++) {
      const cx = Math.min(2, Math.floor((x - xs) / cellW));
      const cellIdx = cy * 3 + cx;
      const i = y * w + x;
      sumsR[cellIdx] += R[i];
      sumsG[cellIdx] += G[i];
      sumsB[cellIdx] += B[i];
      regionSumR += R[i];
      regionSumG += G[i];
      regionSumB += B[i];
      counts[cellIdx]++;
      regionCount++;
    }
  }

  const eps = 1e-3;
  // Region-mean luminance (rec709)
  const regionMeanR = regionCount ? regionSumR / regionCount : eps;
  const regionMeanG = regionCount ? regionSumG / regionCount : eps;
  const regionMeanB = regionCount ? regionSumB / regionCount : eps;
  const regionLum = REC709_R * regionMeanR + REC709_G * regionMeanG + REC709_B * regionMeanB;
  const logRegionLum = Math.log(regionLum + eps);
  const expectedCellCount = regionCount / 9;

  const out = {};
  const cells = [];
  // Eccentricity mapping for 3×3 grid: center=(1,1) → 0, corners → 1
  // Distance from center in cell coords: max distance = sqrt(2) for corners
  const cellPos = [
    [0, 0], [0, 1], [0, 2],  // row 0: col 0..2
    [1, 0], [1, 1], [1, 2],
    [2, 0], [2, 1], [2, 2],
  ];

  for (let c = 0; c < 9; c++) {
    const [row, col] = cellPos[c];
    const dRow = row - 1, dCol = col - 1;
    const eccentricity = Math.sqrt(dRow * dRow + dCol * dCol) / Math.sqrt(2);

    if (counts[c] === 0) {
      out[`cell${String(c).padStart(2, "0")}_luminance`] = 0;
      out[`cell${String(c).padStart(2, "0")}_redGreen`] = 0;
      out[`cell${String(c).padStart(2, "0")}_blueYellow`] = 0;
      out[`cell${String(c).padStart(2, "0")}_saturation`] = 0;
      out[`cell${String(c).padStart(2, "0")}_confidence`] = 0;
      cells.push({ cellId: c, row, column: col, eccentricity, luminance: 0, redGreen: 0, blueYellow: 0, saturation: 0, confidence: 0 });
      continue;
    }

    const cR = sumsR[c] / counts[c];
    const cG = sumsG[c] / counts[c];
    const cB = sumsB[c] / counts[c];

    const cellLum = REC709_R * cR + REC709_G * cG + REC709_B * cB;
    // Illuminant-invariant log-ratio for luminance
    const luminance = Math.log(cellLum + eps) - logRegionLum;
    // Ratio opponent channels: invariant to multiplicative illuminant scaling
    const redGreen = (cR - cG) / (cR + cG + eps);
    const blueYellow = (0.5 * (cR + cG) - cB) / (cR + cG + cB + eps);
    const saturation = Math.sqrt(redGreen * redGreen + blueYellow * blueYellow);
    // Confidence: ratio of actual cell count to expected — 1.0 for uniform grids
    const confidence = expectedCellCount > 0 ? counts[c] / expectedCellCount : 0;

    out[`cell${String(c).padStart(2, "0")}_luminance`] = luminance;
    out[`cell${String(c).padStart(2, "0")}_redGreen`] = redGreen;
    out[`cell${String(c).padStart(2, "0")}_blueYellow`] = blueYellow;
    out[`cell${String(c).padStart(2, "0")}_saturation`] = saturation;
    out[`cell${String(c).padStart(2, "0")}_confidence`] = confidence;

    cells.push({
      cellId: c, row, column: col, eccentricity,
      luminance, redGreen, blueYellow, saturation, confidence,
    });
  }

  // Preserve structured cells for downstream recognizers under _cells (skipped by flatten)
  out._cells = cells;

  return out;
}

/**
 * Distance between two spatial-color descriptors.
 * Backward-compatible with prior { cells: [27 flat] } consumers via cellsToLegacy adapter.
 */
export function spatialColorDistance(a, b) {
  if (!a || !b) return Infinity;
  // Use structured cells if present (v2), else legacy flat cells
  const aCells = a._cells || cellsFromLegacy(a.cells);
  const bCells = b._cells || cellsFromLegacy(b.cells);
  if (!aCells || !bCells) return Infinity;
  let s = 0;
  for (let i = 0; i < 9; i++) {
    const ac = aCells[i], bc = bCells[i];
    if (!ac || !bc) continue;
    s += (ac.luminance - bc.luminance) ** 2;
    s += (ac.redGreen - bc.redGreen) ** 2;
    s += (ac.blueYellow - bc.blueYellow) ** 2;
    s += (ac.saturation - bc.saturation) ** 2;
  }
  return Math.sqrt(s);
}

/** Legacy flat-27 → structured-cells adapter (best-effort, drops opponent physics). */
function cellsFromLegacy(flat27) {
  if (!Array.isArray(flat27) || flat27.length !== 27) return null;
  const cells = [];
  for (let c = 0; c < 9; c++) {
    const row = Math.floor(c / 3), col = c % 3;
    const dRow = row - 1, dCol = col - 1;
    const eccentricity = Math.sqrt(dRow * dRow + dCol * dCol) / Math.sqrt(2);
    // Legacy stored [logR-logRegionR, logG-logRegionG, logB-logRegionB] per cell
    const lR = flat27[c * 3 + 0];
    const lG = flat27[c * 3 + 1];
    const lB = flat27[c * 3 + 2];
    const luminance = REC709_R * lR + REC709_G * lG + REC709_B * lB;
    const redGreen = 0.5 * (lR - lG);
    const blueYellow = 0.5 * (lR + lG) - lB;
    const saturation = Math.sqrt(redGreen * redGreen + blueYellow * blueYellow);
    cells.push({ cellId: c, row, column: col, eccentricity, luminance, redGreen, blueYellow, saturation, confidence: 1 });
  }
  return cells;
}
