// 07-VISUAL/structural/temporal-on-off-w2-w3.mjs
//
// W+2 ON events — max(deltaY, 0) — POSITIVE temporal luminance events
// W+3 OFF events — max(-deltaY, 0) — NEGATIVE temporal luminance events
//
// GPT doctrine v7 (spine seq 125) SEMANTIC BOUNDARY:
//   DO NOT label W+2 as "object appears" or W+3 as "object disappears".
//   These are downstream INTERPRETATIONS requiring spatial support,
//   contour continuity, camera-motion compensation, color evidence.
//   W+2 and W+3 are rectified halves of the SIGNED luminance derivative.
//
// Both channels are computed FROM the already-emitted positiveMap/negativeMap
// in the W+1 output — they do not touch the raw frames again, only consume
// the derived evidence. This preserves single-source-of-truth for delta Y.

import { hashField } from "./axis-tap.mjs";

export const W2_CHANNEL_ID = "W+2_ON_events";
export const W2_CHANNEL_VERSION = "1.0";
export const W3_CHANNEL_ID = "W+3_OFF_events";
export const W3_CHANNEL_VERSION = "1.0";

const ACTIVE_THRESHOLD = 0.005;

/**
 * Compute rich metadata over a rectified (non-negative) field.
 * Used identically for W+2 (positiveMap) and W+3 (negativeMap).
 */
function computeRectifiedChannelMetadata(rectMap, w, h, channelId, channelVersion) {
  const N = rectMap.length;
  let sum = 0, sumSq = 0, maxV = 0;
  let centroidNumX = 0, centroidNumY = 0, centroidDenom = 0;
  let activeCount = 0, borderActiveCount = 0, borderTotal = 0;
  let bbMinX = Infinity, bbMinY = Infinity, bbMaxX = -Infinity, bbMaxY = -Infinity;

  const cellW = w / 3, cellH = h / 3;
  const cellSum = new Array(9).fill(0);
  const cellCount = new Array(9).fill(0);

  for (let y = 0; y < h; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    const isBorderY = (y === 0 || y === h - 1);
    for (let x = 0; x < w; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const i = y * w + x;
      const v = rectMap[i];
      sum += v;
      sumSq += v * v;
      if (v > maxV) maxV = v;
      cellSum[c] += v;
      cellCount[c]++;

      if (v > ACTIVE_THRESHOLD) {
        activeCount++;
        centroidNumX += x * v;
        centroidNumY += y * v;
        centroidDenom += v;
        if (x < bbMinX) bbMinX = x;
        if (y < bbMinY) bbMinY = y;
        if (x > bbMaxX) bbMaxX = x;
        if (y > bbMaxY) bbMaxY = y;
      }
      const isBorderX = (x === 0 || x === w - 1);
      if (isBorderX || isBorderY) {
        borderTotal++;
        if (v > ACTIVE_THRESHOLD) borderActiveCount++;
      }
    }
  }

  const mean = sum / N;
  const rms = Math.sqrt(sumSq / N);
  const energy = sum;   // sum of rectified values

  const spatialCentroid = centroidDenom > 0
    ? { x: centroidNumX / centroidDenom, y: centroidNumY / centroidDenom }
    : { x: null, y: null };

  const boundingBox = activeCount > 0
    ? { minX: bbMinX, minY: bbMinY, maxX: bbMaxX, maxY: bbMaxY, activeCount, frameW: w, frameH: h }
    : null;

  const activeFraction = activeCount / N;
  const borderActivity = borderTotal > 0 ? borderActiveCount / borderTotal : 0;

  // Connected regions
  const connectedRegionCount = countConnectedRegionsPositive(rectMap, w, h, ACTIVE_THRESHOLD);

  const cells = [];
  for (let c = 0; c < 9; c++) {
    const n = cellCount[c] || 1;
    cells.push({
      cellId: c,
      row: Math.floor(c / 3),
      column: c % 3,
      meanValue: cellSum[c] / n,
      pixelCount: cellCount[c],
    });
  }

  return {
    valid: true,
    channelId, channelVersion,
    availability: "TEMPORAL_MEASURED",
    mean, rms, max: maxV, energy,
    activeFraction, borderActivity, connectedRegionCount,
    spatialCentroid, boundingBox,
    localCellMap: cells,
    fullFieldRef: hashField(rectMap),
  };
}

function countConnectedRegionsPositive(rectMap, w, h, threshold) {
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
      if (rectMap[i] <= threshold) continue;
      parent[i] = i;
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

/** W+2 — consumes W+1's positiveMap. */
export function computeOnEvents(w1Backward, w) {
  if (!w1Backward || !w1Backward.valid) {
    return { valid: false, availability: w1Backward?.availability ?? "TEMPORAL_INPUT_UNAVAILABLE", channelId: W2_CHANNEL_ID };
  }
  const h = w1Backward.deltaY.length / w;
  return computeRectifiedChannelMetadata(w1Backward.positiveMap, w, h, W2_CHANNEL_ID, W2_CHANNEL_VERSION);
}

/** W+3 — consumes W+1's negativeMap. */
export function computeOffEvents(w1Backward, w) {
  if (!w1Backward || !w1Backward.valid) {
    return { valid: false, availability: w1Backward?.availability ?? "TEMPORAL_INPUT_UNAVAILABLE", channelId: W3_CHANNEL_ID };
  }
  const h = w1Backward.deltaY.length / w;
  return computeRectifiedChannelMetadata(w1Backward.negativeMap, w, h, W3_CHANNEL_ID, W3_CHANNEL_VERSION);
}
