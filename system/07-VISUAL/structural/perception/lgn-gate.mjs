// 07-VISUAL/structural/perception/lgn-gate.mjs
//
// DEPRECATED (v1) — 5-channel rich-signature gate. See lgn-gate-12.mjs
// for the 12-vector Werblin channel gate. New code SHOULD use lgn-gate-12.
//
// LGN (Lateral Geniculate Nucleus) gate — memory-primed attention.
//
// The doctrine: perception is not passive. The cortex tells the thalamus
// what to expect, and the LGN gates sensory input toward those expectations.
// When "leash" is active in memory, the visual system primes for "dog"
// before the dog is visible.
//
// In Æyes: active concept nodes in the graph MODULATE the channel weights
// used to build signatures. When "orange" fires, RG/BY axes get boosted.
// When "wood" fires, texture axis gets boosted.
//
// Zero parameters. All modulation lives on concept-node channel weights,
// which we already have per-concept in the identity-store-v2.

import { DEFAULT_CHANNEL_WEIGHTS } from "../identity/identity-store-v2.mjs";
import { neighborsByType, spreadActivation } from "../graph/concept-graph.mjs";

/**
 * Compute the current channel-weight vector given the graph's active-node
 * state. Sums each active concept's preferred channel weights, softmax-ed
 * by activation.
 *
 * @param {object} graph
 * @param {Map<string, number>} activeNodes  nodeId -> activation
 * @returns {object}  channel weights suitable for richDistance()
 */
export function computeGatedWeights(graph, activeNodes) {
  const w = { ...DEFAULT_CHANNEL_WEIGHTS };
  const conceptActivations = new Map();
  for (const [nodeId, act] of activeNodes.entries()) {
    const n = graph.nodes.get(nodeId);
    if (n?.type === "CONCEPT") conceptActivations.set(nodeId, act);
  }
  if (conceptActivations.size === 0) return w;

  // Normalize activations
  let total = 0;
  for (const a of conceptActivations.values()) total += a;
  if (total <= 0) return w;

  // Blend each active concept's channel_weights into the base
  const blended = { color: 0, edge: 0, texture: 0, specular: 0, spatial: 0 };
  for (const [id, act] of conceptActivations) {
    const weight = act / total;
    const cw = graph.nodes.get(id).channel_weights ?? DEFAULT_CHANNEL_WEIGHTS;
    for (const k of Object.keys(blended)) blended[k] += weight * (cw[k] ?? DEFAULT_CHANNEL_WEIGHTS[k]);
  }
  return blended;
}

/**
 * Apply top-down PRIMES edges: if concept A PRIMES concept B, then activating
 * A raises B's activation next tick. This is where "leash → dog" happens.
 */
export function primeGraph(graph, seedActivations, opts = {}) {
  const priming = new Map(seedActivations);
  for (const e of graph.edges) {
    if (e.type !== "PRIMES") continue;
    const seed = seedActivations.get(e.from);
    if (!seed) continue;
    priming.set(e.to, (priming.get(e.to) ?? 0) + seed * e.weight * (opts.strength ?? 0.7));
  }
  return priming;
}

/**
 * One tick of memory-primed perception:
 *   1. Given a recent recognition (winner concept + confidence), seed activations.
 *   2. Propagate through PRIMES edges (top-down expectation).
 *   3. Also spread through CO_OCCURRED / IS_A (associative activation).
 *   4. Compute gated weights for the next frame's signature.
 */
export function tickLGN(graph, recentWinnerId, recentActivation = 1.0) {
  const seed = new Map([[recentWinnerId, recentActivation]]);
  const primed = primeGraph(graph, seed);
  const spread = spreadActivation(graph, primed, { decay: 0.4 });
  const gated = computeGatedWeights(graph, spread);
  return { active: spread, gated };
}
