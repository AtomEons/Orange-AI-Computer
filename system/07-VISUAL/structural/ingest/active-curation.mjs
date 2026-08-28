// 07-VISUAL/structural/ingest/active-curation.mjs
//
// Active curation — pick the K most-diverse frames from N candidates.
//
// Farthest-point sampling (FPS) in descriptor space:
//   1. Start with a random or first-frame seed.
//   2. Iteratively pick the frame whose minimum distance to any already-
//      picked frame is MAXIMAL. This spreads the picks across descriptor
//      space maximally.
//
// Same library size, better boundary coverage. The doctrine version of
// active learning — no gradients, just information-gain selection.

import { richDistance } from "../identity/identity-store-v2.mjs";

/**
 * Farthest-point sampling on rich signatures.
 * @param {Array<object>} candidateSigs  rich signatures (from buildRichSignature)
 * @param {number} K                      how many to keep
 * @param {object} [opts]
 *   opts.weights channel weights (default balanced)
 * @returns {{ selected: number[], distances_matrix: number[][] }}
 *   selected = indices into candidateSigs
 */
export function activeCurate(candidateSigs, K, opts = {}) {
  const N = candidateSigs.length;
  if (N <= K) return { selected: candidateSigs.map((_, i) => i), distances_matrix: [] };

  const w = opts.weights;
  const selected = [0];
  const minDistToSelected = new Array(N).fill(Infinity);
  for (let j = 0; j < N; j++) minDistToSelected[j] = j === 0 ? 0 : richDistance(candidateSigs[j], candidateSigs[0], w);

  while (selected.length < K) {
    let bestI = -1, bestD = -1;
    for (let j = 0; j < N; j++) {
      if (selected.includes(j)) continue;
      if (minDistToSelected[j] > bestD) { bestD = minDistToSelected[j]; bestI = j; }
    }
    if (bestI === -1) break;
    selected.push(bestI);
    for (let j = 0; j < N; j++) {
      if (selected.includes(j)) continue;
      const d = richDistance(candidateSigs[j], candidateSigs[bestI], w);
      if (d < minDistToSelected[j]) minDistToSelected[j] = d;
    }
  }
  return { selected, min_distances: minDistToSelected };
}

/**
 * Diversity score for a set of signatures — mean pairwise distance.
 * Higher = more diverse coverage.
 */
export function diversityScore(sigs, weights) {
  if (sigs.length < 2) return 0;
  let sum = 0, count = 0;
  for (let i = 0; i < sigs.length; i++) {
    for (let j = i + 1; j < sigs.length; j++) {
      sum += richDistance(sigs[i], sigs[j], weights);
      count++;
    }
  }
  return count ? sum / count : 0;
}
