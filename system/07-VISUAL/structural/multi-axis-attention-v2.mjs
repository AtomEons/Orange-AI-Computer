// 07-VISUAL/structural/multi-axis-attention-v2.mjs
//
// Wide-basis attention. Same empirical light-string per axis
// (photoreceptor → gaussian → density-cluster → merge_overlap), then
// cross-axis IoU-voting merge. What changes vs v1: the axis basis is
// configurable and defaults to the operator's 6-axis layer set.
//
// Axis catalog:
//   R      — raw red channel [0,1]
//   G      — raw green channel [0,1]
//   B      — raw blue channel [0,1]
//   L      — light (Rec.601 luminance) 0.30R + 0.59G + 0.11B
//   M      — mono (unweighted mean) (R+G+B)/3
//   gamma  — gamma-corrected luminance L^0.45 (sRGB display curve inverse)
//   RG     — red-green opponent, unit-rescaled
//   BY     — blue-yellow opponent, unit-rescaled
//
// Default axes: ["R","G","B","L","M","gamma"] — the six the operator named.
// Operator can pass ["R","G","B","L","M","gamma","RG","BY"] for the 8-axis
// superset that keeps chromatic-opponent signals alive.
//
// Deterministic. No RNG. Bun-only.

import { prismDecompose, opponentToUnit } from "./prism.mjs";
import { initAdaptationState, photoreceptorResponse } from "./photoreceptor.mjs";
import { preprocess } from "./binders/preprocessing.mjs";
import { postprocess } from "./binders/post-processing.mjs";
import { bind as densityBind } from "./binders/density-cluster.mjs";

export const DEFAULT_AXES = ["R", "G", "B", "L", "M", "gamma"];
export const WIDE_AXES = ["R", "G", "B", "L", "M", "gamma", "RG", "BY"];

/**
 * Build one axis channel from raw RGB.
 */
export function axisChannel(name, R, G, B) {
  const N = R.length;
  const out = new Float32Array(N);
  if (name === "R") { for (let i = 0; i < N; i++) out[i] = R[i]; return out; }
  if (name === "G") { for (let i = 0; i < N; i++) out[i] = G[i]; return out; }
  if (name === "B") { for (let i = 0; i < N; i++) out[i] = B[i]; return out; }
  if (name === "L") { for (let i = 0; i < N; i++) out[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i]; return out; }
  if (name === "M") { const s = 1 / 3; for (let i = 0; i < N; i++) out[i] = s * (R[i] + G[i] + B[i]); return out; }
  if (name === "gamma") {
    for (let i = 0; i < N; i++) {
      const L = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
      out[i] = Math.pow(Math.max(0, L), 0.45);
    }
    return out;
  }
  if (name === "RG" || name === "BY") {
    const { RG, BY } = prismDecompose(R, G, B);
    return opponentToUnit(name === "RG" ? RG : BY);
  }
  throw new Error(`unknown axis "${name}"`);
}

// --- Cross-axis merge helpers ---
function iou(a, b) {
  const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (aw * ah + bw * bh - inter);
}
function bboxUnion(regions) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of regions) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x + w > x1) x1 = x + w; if (y + h > y1) y1 = y + h;
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * Attention with a configurable axis basis.
 *
 * @param {Float32Array} R  red channel [0,1]
 * @param {Float32Array} G  green channel [0,1]
 * @param {Float32Array} B  blue channel [0,1]
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 *   opts.axes       Array<string> axis names, default DEFAULT_AXES
 *   opts.preproc    preprocessor name (default "gaussian_1")
 *   opts.minVotes   min axes voting for a combo entity (default 1)
 *   opts.iouThresh  IoU for cross-axis grouping (default 0.4)
 * @returns {{entities: Array<{region, votes, axes}>, perAxis: object}}
 */
export function attentionMultiAxisV2(R, G, B, width, height, opts = {}) {
  const axesList = opts.axes ?? DEFAULT_AXES;
  const preprocName = opts.preproc ?? "gaussian_1";
  const minVotes = opts.minVotes ?? 1;
  const iouThresh = opts.iouThresh ?? 0.4;

  const perAxis = {};
  const allCandidates = [];

  for (const name of axesList) {
    const ch = axisChannel(name, R, G, B);
    const pre = preprocess(preprocName, photoreceptorResponse(ch, initAdaptationState(), null).R, width, height);
    const raw = densityBind(pre.R2, width, height, {}).entities || [];
    const { entities } = postprocess("merge_overlap", raw, { frameArea: width * height });
    perAxis[name] = entities;
    for (const e of entities) allCandidates.push({ region: e.region, axis: name });
  }

  const used = new Array(allCandidates.length).fill(false);
  const combined = [];
  for (let i = 0; i < allCandidates.length; i++) {
    if (used[i]) continue;
    const cluster = [allCandidates[i]];
    used[i] = true;
    for (let j = i + 1; j < allCandidates.length; j++) {
      if (used[j]) continue;
      const cb = bboxUnion(cluster.map((c) => c.region));
      if (iou(cb, allCandidates[j].region) >= iouThresh) {
        cluster.push(allCandidates[j]);
        used[j] = true;
      }
    }
    const axesSet = new Set(cluster.map((c) => c.axis));
    if (axesSet.size >= minVotes) {
      combined.push({
        region: bboxUnion(cluster.map((c) => c.region)),
        votes: axesSet.size,
        axes: [...axesSet],
      });
    }
  }

  combined.sort((a, b) => (b.votes - a.votes) || ((b.region[2] * b.region[3]) - (a.region[2] * a.region[3])));

  return { entities: combined, perAxis, axesUsed: axesList };
}
