// 07-VISUAL/structural/axes/persistent-homology-axis.mjs
//
// TOPOLOGICAL SIGNATURE — persistent homology summary as region descriptor.
//
// Sole surviving axis of Phase A (spine seq 105).
// Fix under GPT doctrine v2 (spine seq 107): switched from R-channel-only to
// LUMINANCE (rec709) because R-only failed on lighting-transformed images
// (moon r*=0.28, crt r*=0.28) — R range collapsed below phBind uniform threshold,
// causing 97.8% of wide-IT cache to have zero PH output.
//
// Extended output: global (6 scalars, backward-compat) + per-cell (54 scalars
// across 3×3 grid, 6 attrs × 9 cells) + _cells structured records.
//
// Zero learned parameters. Deterministic. Bun-native.

import { bind as phBind } from "../binders/persistent-homology-lite.mjs";

const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;

// Extract luminance region — rec709 weighted L
function extractRegionL(R, G, B, width, height, region) {
  const [x0, y0, w, h] = region;
  const x1 = Math.min(width, x0 + w), y1 = Math.min(height, y0 + h);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const rw = x1 - xs, rh = y1 - ys;
  if (rw < 4 || rh < 4) return null;
  const out = new Float32Array(rw * rh);
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const srcIdx = (ys + y) * width + (xs + x);
      out[y * rw + x] = REC709_R * R[srcIdx] + REC709_G * G[srcIdx] + REC709_B * B[srcIdx];
    }
  }
  return { L: out, w: rw, h: rh };
}

// Compute 6-scalar summary from a persistences array
function summarizeBarcode(entities) {
  const persistences = (entities || []).map(e => e.persistence ?? 0).filter(v => v > 0);
  if (!persistences.length) return { num_components: 0, mean_persistence: 0, max_persistence: 0, entropy: 0, top1: 0, top2: 0 };
  persistences.sort((a, b) => b - a);
  const num = persistences.length;
  const sum = persistences.reduce((a, b) => a + b, 0);
  const mean = sum / num;
  const max = persistences[0];
  let entropy = 0;
  for (const p of persistences) {
    const norm = p / sum;
    if (norm > 0) entropy -= norm * Math.log(norm);
  }
  return {
    num_components: num,
    mean_persistence: mean,
    max_persistence: max,
    entropy,
    top1: persistences[0] ?? 0,
    top2: persistences[1] ?? 0,
  };
}

/**
 * Persistent-homology axis summary for a region.
 * Emits 6 global scalars (backward-compat) + 54 per-cell scalars (6×9) + _cells structured records.
 */
export function persistentHomologySummary(R, G, B, width, height, region) {
  // Empty-output template — return when region invalid or extraction fails
  const emptyOutput = () => {
    const out = {
      ph_num_components: 0, ph_mean_persistence: 0, ph_max_persistence: 0,
      ph_entropy: 0, ph_top1: 0, ph_top2: 0,
    };
    const emptyCells = [];
    for (let c = 0; c < 9; c++) {
      const row = Math.floor(c / 3), col = c % 3;
      const dRow = row - 1, dCol = col - 1;
      const eccentricity = Math.sqrt(dRow * dRow + dCol * dCol) / Math.sqrt(2);
      out[`cell${String(c).padStart(2, "0")}_ph_num_components`] = 0;
      out[`cell${String(c).padStart(2, "0")}_ph_mean_persistence`] = 0;
      out[`cell${String(c).padStart(2, "0")}_ph_max_persistence`] = 0;
      out[`cell${String(c).padStart(2, "0")}_ph_entropy`] = 0;
      out[`cell${String(c).padStart(2, "0")}_ph_top1`] = 0;
      out[`cell${String(c).padStart(2, "0")}_ph_top2`] = 0;
      emptyCells.push({ cellId: c, row, column: col, eccentricity, num_components: 0, mean_persistence: 0, max_persistence: 0, entropy: 0, top1: 0, top2: 0 });
    }
    out._cells = emptyCells;
    return out;
  };

  const roi = extractRegionL(R, G, B, width, height, region);
  if (!roi) return emptyOutput();

  // ---- GLOBAL PH ----
  const globalResult = phBind(roi.L, roi.w, roi.h, { quantLevels: 24, tauFrac: 0.05, maxEntities: 32 });
  const globalSummary = summarizeBarcode(globalResult.entities);

  const out = {
    ph_num_components: globalSummary.num_components,
    ph_mean_persistence: globalSummary.mean_persistence,
    ph_max_persistence: globalSummary.max_persistence,
    ph_entropy: globalSummary.entropy,
    ph_top1: globalSummary.top1,
    ph_top2: globalSummary.top2,
  };

  // ---- PER-CELL PH (3×3 grid matching spatial-color) ----
  const cellW = roi.w / 3, cellH = roi.h / 3;
  const cells = [];

  for (let c = 0; c < 9; c++) {
    const row = Math.floor(c / 3), col = c % 3;
    const cx0 = Math.floor(col * cellW), cy0 = Math.floor(row * cellH);
    const cx1 = Math.floor((col + 1) * cellW), cy1 = Math.floor((row + 1) * cellH);
    const crw = cx1 - cx0, crh = cy1 - cy0;
    const dRow = row - 1, dCol = col - 1;
    const eccentricity = Math.sqrt(dRow * dRow + dCol * dCol) / Math.sqrt(2);

    let cellSummary;
    if (crw < 4 || crh < 4) {
      cellSummary = { num_components: 0, mean_persistence: 0, max_persistence: 0, entropy: 0, top1: 0, top2: 0 };
    } else {
      // Extract cell as Float32Array
      const cellL = new Float32Array(crw * crh);
      for (let y = 0; y < crh; y++) {
        for (let x = 0; x < crw; x++) {
          cellL[y * crw + x] = roi.L[(cy0 + y) * roi.w + (cx0 + x)];
        }
      }
      const cellResult = phBind(cellL, crw, crh, { quantLevels: 16, tauFrac: 0.05, maxEntities: 16 });
      cellSummary = summarizeBarcode(cellResult.entities);
    }

    out[`cell${String(c).padStart(2, "0")}_ph_num_components`] = cellSummary.num_components;
    out[`cell${String(c).padStart(2, "0")}_ph_mean_persistence`] = cellSummary.mean_persistence;
    out[`cell${String(c).padStart(2, "0")}_ph_max_persistence`] = cellSummary.max_persistence;
    out[`cell${String(c).padStart(2, "0")}_ph_entropy`] = cellSummary.entropy;
    out[`cell${String(c).padStart(2, "0")}_ph_top1`] = cellSummary.top1;
    out[`cell${String(c).padStart(2, "0")}_ph_top2`] = cellSummary.top2;

    cells.push({
      cellId: c, row, column: col, eccentricity,
      num_components: cellSummary.num_components,
      mean_persistence: cellSummary.mean_persistence,
      max_persistence: cellSummary.max_persistence,
      entropy: cellSummary.entropy,
      top1: cellSummary.top1,
      top2: cellSummary.top2,
    });
  }

  out._cells = cells;
  return out;
}
