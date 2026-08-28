// 07-VISUAL/structural/multi-axis-attention.mjs
//
// DEPRECATED (v1) — 3-axis (Y+RG+BY). See multi-axis-attention-v2.mjs
// for the axis-list-parametric successor. New code SHOULD use v2.
//
// The tri-axis attention combo — the "three regimes" the 5000-experiment
// sweep identified: Y (achromatic), RG (red-green opponent), BY (blue-yellow
// opponent). Y wins 16/20 images. RG wins on chromatic scenes (3/20). BY
// wins on 1/20. Instead of picking one, run all three in parallel and merge
// via IoU voting so each axis's specialty contributes.
//
// This is the empirical light-string upgraded to tri-axis:
//   axis in {Y, RG, BY}:
//     photoreceptor → density-cluster → merge_overlap
//   → voting merge across axes
//
// Deterministic. No RNG. Bun-only.

import { prismDecompose, opponentToUnit } from "./prism.mjs";
import { initAdaptationState, photoreceptorResponse } from "./photoreceptor.mjs";
import { preprocess } from "./binders/preprocessing.mjs";
import { postprocess } from "./binders/post-processing.mjs";
import { bind as densityBind } from "./binders/density-cluster.mjs";

function iou(a, b) {
  const [ax, ay, aw, ah] = a;
  const [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx);
  const y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw);
  const y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  const union = aw * ah + bw * bh - inter;
  return union > 0 ? inter / union : 0;
}

function bboxUnion(regions) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of regions) {
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x + w > x1) x1 = x + w;
    if (y + h > y1) y1 = y + h;
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

/**
 * Run attention per axis and merge across axes.
 *
 * @param {Float32Array} R  red channel [0,1]
 * @param {Float32Array} G  green channel [0,1]
 * @param {Float32Array} B  blue channel [0,1]
 * @param {number} width
 * @param {number} height
 * @param {object} [opts]
 *   opts.preproc     preprocessor name (default "gaussian_2")
 *   opts.minVotes    min axes voting for a combo entity (default 1 = union)
 *   opts.iouThresh   IoU for cross-axis grouping (default 0.4)
 * @returns {{entities: Array<{region, votes, axes}>, perAxis: object}}
 */
export function attentionMultiAxis(R, G, B, width, height, opts = {}) {
  const preprocName = opts.preproc ?? "gaussian_2";
  const minVotes = opts.minVotes ?? 1;
  const iouThresh = opts.iouThresh ?? 0.4;

  const { A, RG, BY } = prismDecompose(R, G, B);
  const RGu = opponentToUnit(RG);
  const BYu = opponentToUnit(BY);

  const axes = [
    { name: "Y",  channel: A },
    { name: "RG", channel: RGu },
    { name: "BY", channel: BYu },
  ];

  const perAxis = {};
  const allCandidates = [];

  for (const { name, channel } of axes) {
    const pre = preprocess(preprocName, photoreceptorResponse(channel, initAdaptationState(), null).R, width, height);
    const raw = densityBind(pre.R2, width, height, {}).entities || [];
    const { entities } = postprocess("merge_overlap", raw, { frameArea: width * height });
    perAxis[name] = entities;
    for (const e of entities) allCandidates.push({ region: e.region, axis: name });
  }

  // Cluster candidates by IoU. Each cluster gets a set of contributing axes.
  const used = new Array(allCandidates.length).fill(false);
  const combined = [];
  for (let i = 0; i < allCandidates.length; i++) {
    if (used[i]) continue;
    const cluster = [allCandidates[i]];
    used[i] = true;
    for (let j = i + 1; j < allCandidates.length; j++) {
      if (used[j]) continue;
      // Check IoU against the current cluster's union bbox (not just first — allows chained agreement)
      const clusterBbox = bboxUnion(cluster.map((c) => c.region));
      if (iou(clusterBbox, allCandidates[j].region) >= iouThresh) {
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

  // Sort by votes desc, then area desc
  combined.sort((a, b) => (b.votes - a.votes) || ((b.region[2] * b.region[3]) - (a.region[2] * a.region[3])));

  return { entities: combined, perAxis };
}
