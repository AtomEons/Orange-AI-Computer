// 07-VISUAL/structural/perception/prediction-error.mjs
//
// Prediction-error learning.
//
// Confirmed prediction: strengthen the edges that predicted the outcome
//   (Hebbian: "cells that fire together wire together").
// Surprise (prediction not confirmed OR unfamiliar signature): mint a new
//   EPISODE node capturing the anomaly.
//
// No gradient descent. The graph learns by weight-adjustment on existing
// edges + episodic node creation for novel content.

import { addNode, addEdge, findOrCreateConcept } from "../graph/concept-graph.mjs";

/**
 * Given a prediction (predicted concept + confidence) and an observation
 * (actual winner + distance), update the graph accordingly.
 *
 * @param {object} graph
 * @param {string} predictedConceptId  what the graph expected
 * @param {string} actualWinnerLabel   what got recognized
 * @param {number} distance            best-distance from richDistance
 * @param {object} opts
 *   opts.surprise_threshold  distance above which we call it surprise (default 0.8)
 *   opts.confirm_threshold   distance below which we call it confirmed (default 0.4)
 *   opts.frame_meta          episode metadata to attach on surprise
 */
export function updateFromObservation(graph, predictedConceptId, actualWinnerLabel, distance, opts = {}) {
  const surpThresh = opts.surprise_threshold ?? 0.8;
  const confThresh = opts.confirm_threshold ?? 0.4;

  const actualConcept = findOrCreateConcept(graph, actualWinnerLabel);

  // Case 1: prediction confirmed — strengthen edges predicting the winner
  if (predictedConceptId && actualConcept.id === predictedConceptId && distance < confThresh) {
    for (const e of graph.edges) {
      if (e.to === predictedConceptId && (e.type === "PRIMES" || e.type === "CO_OCCURRED" || e.type === "PRECEDED")) {
        e.weight = Math.min(2.0, e.weight * 1.1);   // slow strengthening
      }
    }
    return { kind: "confirmed", edge_count_boosted: countMatching(graph, predictedConceptId) };
  }

  // Case 2: predicted concept != actual (surprise) — mint episode + weaken misleading priming
  if (predictedConceptId && actualConcept.id !== predictedConceptId) {
    const episode = addNode(graph, "EPISODE", {
      label: `surprise:${actualWinnerLabel}`,
      expected: predictedConceptId,
      observed: actualConcept.id,
      distance,
      ...opts.frame_meta,
    });
    addEdge(graph, episode.id, "REMINDED_OF", actualConcept.id, 1.0);
    // Weaken any PRIMES edge that misfired
    for (const e of graph.edges) {
      if (e.to === predictedConceptId && e.type === "PRIMES") {
        e.weight = Math.max(0.1, e.weight * 0.9);
      }
    }
    return { kind: "surprise_wrong_prediction", episode_id: episode.id };
  }

  // Case 3: no prediction, novel recognition — new episode + weak edge
  if (!predictedConceptId && distance < confThresh) {
    const episode = addNode(graph, "EPISODE", {
      label: `novel:${actualWinnerLabel}`,
      observed: actualConcept.id,
      distance,
      ...opts.frame_meta,
    });
    addEdge(graph, episode.id, "REMINDED_OF", actualConcept.id, 0.5);
    return { kind: "novel_confirmed", episode_id: episode.id };
  }

  // Case 4: high distance = out-of-distribution — episodic surprise
  if (distance >= surpThresh) {
    const episode = addNode(graph, "EPISODE", {
      label: `unknown:high_distance`,
      distance,
      ...opts.frame_meta,
    });
    return { kind: "out_of_distribution", episode_id: episode.id };
  }

  return { kind: "no_update" };
}

/**
 * Bind two concepts observed near each other (CO_OCCURRED). Called when
 * two concepts appear in the same scene / short-time-window. The edge
 * weight strengthens with repetition.
 */
export function bindCoOccurrence(graph, conceptIdA, conceptIdB) {
  for (const e of graph.edges) {
    if (e.type === "CO_OCCURRED" && ((e.from === conceptIdA && e.to === conceptIdB) || (e.from === conceptIdB && e.to === conceptIdA))) {
      e.weight = Math.min(2.0, e.weight + 0.1);
      return e;
    }
  }
  return addEdge(graph, conceptIdA, "CO_OCCURRED", conceptIdB, 0.5);
}

/**
 * Bind temporal succession (concept T PRECEDED concept T+1). Useful to
 * establish PRIMES from PRECEDED history.
 */
export function bindPreceded(graph, conceptIdT, conceptIdTPlus1) {
  for (const e of graph.edges) {
    if (e.type === "PRECEDED" && e.from === conceptIdT && e.to === conceptIdTPlus1) {
      e.weight = Math.min(2.0, e.weight + 0.1);
      // Promote strong PRECEDED to PRIMES (top-down expectation)
      if (e.weight > 1.0) {
        const existingPrimes = graph.edges.find((x) => x.type === "PRIMES" && x.from === conceptIdT && x.to === conceptIdTPlus1);
        if (!existingPrimes) addEdge(graph, conceptIdT, "PRIMES", conceptIdTPlus1, 0.7);
      }
      return e;
    }
  }
  return addEdge(graph, conceptIdT, "PRECEDED", conceptIdTPlus1, 0.5);
}

function countMatching(graph, toId) {
  return graph.edges.filter((e) => e.to === toId && (e.type === "PRIMES" || e.type === "CO_OCCURRED" || e.type === "PRECEDED")).length;
}
