// 07-VISUAL/structural/temporal-luminance-w1.mjs
//
// W+1 temporal luminance contrast — GPT doctrine v6 + v7 (spine seqs 122, 125).
// SIGNED luminance-difference channel (not motion). Interpretation comes later.
//
// Δ_Y_t(x, y) = Y_t(x, y) − Y_{t-1}(x, y)  with rec709 luminance
//
// v1.1 (per doctrine v7): extended with spatial/global event metadata so
// downstream pathways can distinguish (motion vs exposure vs lighting vs flicker vs codec).
// Emitted fields:
//   signedMean, meanAbsolute, rms
//   positiveEnergy, negativeEnergy, activeFraction
//   globality              — |mean(ΔY)| / (meanAbs(ΔY) + eps)
//   spatialCentroid        — {x, y} of |ΔY|-weighted mean position
//   boundingBox            — tight axis-aligned bbox of thresholded |ΔY|
//   borderActivity         — fraction of hot pixels on frame boundary
//   connectedRegionCount   — connected components of thresholded |ΔY|
//   localCellMap           — 3×3 per-cell meanDeltaY
//   fullFieldRef           — hash of deltaY (lineage)
//   positiveMap            — max(ΔY, 0) field (prepares W+2)
//   negativeMap            — max(-ΔY, 0) field (prepares W+3)

import { hashField } from "./axis-tap.mjs";

export const CHANNEL_ID = "W+1_luminance_transient";
export const CHANNEL_VERSION = "1.1";   // bumped: extended metadata per doctrine v7

const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;

// Threshold for "active" pixel (above sub-JND null noise floor ~2.1e-3)
const ACTIVE_THRESHOLD = 0.005;

/**
 * Compute delta luminance field for a single frame transition (t-1 → t).
 * Returns rich metadata per GPT v7 spec.
 */
export function computeLuminanceTransient(prevRgb, currRgb) {
  if (!prevRgb || !currRgb) {
    return { valid: false, availability: "TEMPORAL_INPUT_UNAVAILABLE", reason: "MISSING_FRAME" };
  }
  if (prevRgb.width !== currRgb.width || prevRgb.height !== currRgb.height) {
    return { valid: false, availability: "TEMPORAL_INVALID", reason: "FRAME_SIZE_MISMATCH" };
  }

  const w = currRgb.width, h = currRgb.height, N = w * h;
  const deltaY = new Float32Array(N);
  const positiveMap = new Float32Array(N);
  const negativeMap = new Float32Array(N);

  // Global stats + energy
  let sum = 0, sumAbs = 0, sumSq = 0, maxD = -Infinity, minD = Infinity;
  let positiveEnergy = 0, negativeEnergy = 0;

  // Spatial centroid of |deltaY|
  let centroidNumX = 0, centroidNumY = 0, centroidDenom = 0;

  // Bounding box of thresholded |deltaY|
  let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;
  let activeCount = 0, borderActiveCount = 0, borderTotal = 0;

  // Per-cell (3×3 grid)
  const cellW = w / 3, cellH = h / 3;
  const cellSum = new Array(9).fill(0);
  const cellSumAbs = new Array(9).fill(0);
  const cellCount = new Array(9).fill(0);

  for (let y = 0; y < h; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    const isBorderY = (y === 0 || y === h - 1);
    for (let x = 0; x < w; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const i = y * w + x;
      const prevY = REC709_R * prevRgb.R[i] + REC709_G * prevRgb.G[i] + REC709_B * prevRgb.B[i];
      const currY = REC709_R * currRgb.R[i] + REC709_G * currRgb.G[i] + REC709_B * currRgb.B[i];
      const d = currY - prevY;
      deltaY[i] = d;
      const absD = Math.abs(d);
      positiveMap[i] = d > 0 ? d : 0;
      negativeMap[i] = d < 0 ? -d : 0;

      sum += d;
      sumAbs += absD;
      sumSq += d * d;
      if (d > maxD) maxD = d;
      if (d < minD) minD = d;
      if (d > 0) positiveEnergy += d;
      else negativeEnergy += -d;

      cellSum[c] += d;
      cellSumAbs[c] += absD;
      cellCount[c]++;

      // Active pixel + spatial stats
      if (absD > ACTIVE_THRESHOLD) {
        activeCount++;
        centroidNumX += x * absD;
        centroidNumY += y * absD;
        centroidDenom += absD;
        if (x < bbMinX) bbMinX = x;
        if (y < bbMinY) bbMinY = y;
        if (x > bbMaxX) bbMaxX = x;
        if (y > bbMaxY) bbMaxY = y;
      }

      const isBorderX = (x === 0 || x === w - 1);
      if (isBorderX || isBorderY) {
        borderTotal++;
        if (absD > ACTIVE_THRESHOLD) borderActiveCount++;
      }
    }
  }

  const mean = sum / N;
  const meanAbs = sumAbs / N;
  const variance = Math.max(0, sumSq / N - mean * mean);
  const rms = Math.sqrt(sumSq / N);
  const std = Math.sqrt(variance);

  // Globality: |mean| / (meanAbs + eps) — 1 = coherent exposure, 0 = balanced local
  const globality = meanAbs > 0 ? Math.abs(mean) / (meanAbs + 1e-12) : 0;

  // Global luminance shift + residual (mean-subtracted meanAbs)
  const globalLuminanceShift = mean;
  let residualMeanAbs = 0;
  for (let i = 0; i < N; i++) residualMeanAbs += Math.abs(deltaY[i] - globalLuminanceShift);
  residualMeanAbs /= N;

  // Spatial centroid
  const spatialCentroid = centroidDenom > 0
    ? { x: centroidNumX / centroidDenom, y: centroidNumY / centroidDenom }
    : { x: null, y: null };

  // Bounding box
  const boundingBox = activeCount > 0
    ? { minX: bbMinX, minY: bbMinY, maxX: bbMaxX, maxY: bbMaxY, activeCount, framW: w, frameH: h }
    : null;

  // Border activity fraction
  const borderActivity = borderTotal > 0 ? borderActiveCount / borderTotal : 0;

  // Active fraction
  const activeFraction = N > 0 ? activeCount / N : 0;

  // Connected region count via simple union-find on active mask
  const connectedRegionCount = countConnectedRegions(deltaY, w, h, ACTIVE_THRESHOLD);

  // Per-cell records
  const cells = [];
  for (let c = 0; c < 9; c++) {
    const n = cellCount[c] || 1;
    cells.push({
      cellId: c,
      row: Math.floor(c / 3),
      column: c % 3,
      meanDeltaY: cellSum[c] / n,
      meanAbsDeltaY: cellSumAbs[c] / n,
      pixelCount: cellCount[c],
    });
  }

  // fullFieldRef — lineage hash of the deltaY field
  const fullFieldRef = hashField(deltaY);

  return {
    valid: true,
    availability: "TEMPORAL_MEASURED",
    channelId: CHANNEL_ID,
    channelVersion: CHANNEL_VERSION,

    // Raw fields for downstream pathways (W+2/W+3 read positive/negative directly)
    deltaY,
    positiveMap,
    negativeMap,
    fullFieldRef,

    // Scalar summaries per GPT v7 spec
    signedMean: mean,
    meanAbsolute: meanAbs,
    rms,
    positiveEnergy,
    negativeEnergy,
    activeFraction,
    globality,
    spatialCentroid,
    boundingBox,
    borderActivity,
    connectedRegionCount,
    localCellMap: cells,

    // Compatibility with prior code paths
    mean, meanAbs, std, max: maxD, min: minD,
    globalLuminanceShift, residualMeanAbs,
    cells,

    // Interpretation HINTS (metadata, not authoritative)
    interpretation: {
      probable_global_exposure_shift: globality > 0.7 && Math.abs(globalLuminanceShift) > 0.02,
      probable_local_motion: globality < 0.3 && meanAbs > 0.005,
      probable_static: meanAbs < ACTIVE_THRESHOLD,
      probable_border_dominant_camera_motion: borderActivity > 0.5 && activeFraction > 0.05,
    },
  };
}

// 4-connectivity component count via union-find. Deterministic.
function countConnectedRegions(deltaY, w, h, threshold) {
  const N = w * h;
  const parent = new Int32Array(N);
  for (let i = 0; i < N; i++) parent[i] = -1;

  function find(x) {
    let r = x;
    while (parent[r] !== r) r = parent[r];
    while (parent[x] !== x) { const n = parent[x]; parent[x] = r; x = n; }
    return r;
  }
  function union(a, b) {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent[Math.max(ra, rb)] = Math.min(ra, rb);
  }

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (Math.abs(deltaY[i]) <= threshold) continue;
      parent[i] = i;
      // 4-neighbors already-active
      if (x > 0 && parent[i - 1] !== -1) union(i, i - 1);
      if (y > 0 && parent[i - w] !== -1) union(i, i - w);
    }
  }

  const roots = new Set();
  for (let i = 0; i < N; i++) {
    if (parent[i] === -1) continue;
    roots.add(find(i));
  }
  return roots.size;
}

/**
 * Aggregate temporal luminance across causal (prev→curr) and optional next (curr→next).
 */
export function buildW1LuminanceLane({ previous, current, next = null, mode = "CAUSAL" }) {
  const backward = computeLuminanceTransient(previous, current);
  const forward = next ? computeLuminanceTransient(current, next) : null;
  return {
    channelId: CHANNEL_ID,
    channelVersion: CHANNEL_VERSION,
    mode,
    backward,
    forward,
    valid: backward.valid && (mode === "CAUSAL" || (forward && forward.valid)),
  };
}
