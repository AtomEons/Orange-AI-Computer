// 07-VISUAL/structural/graph/graph-writers.mjs
//
// Auto-writer helpers that populate the concept-graph from ingest-time
// observations. Sharded per doctrine — NO business logic in the base
// concept-graph.mjs; that stays a pure data structure. This file is the
// automation layer.
//
// Strikes implemented:
//   #103 — Cylinder-nearest → auto-populate SIMILAR_TO edges
//   #109 — Prediction-error EPISODEs → boundary-video ingest queue
//   #111 — modularClosureCheck as post-ingest gate

import { addEdge, addNode, findOrCreateConcept } from "./concept-graph.mjs";
import { turningKeyClose } from "./celtic-graph.mjs";

/**
 * #103 — After each new signature ingest, query the cylinder for k-nearest
 * concepts and auto-populate SIMILAR_TO edges in the graph.
 *
 * @param {object} graph
 * @param {string} sourceConceptLabel  the concept whose new signature triggered this
 * @param {object} cylinderIndex       the CylinderIndex instance
 * @param {object} newSig              the just-added signature
 * @param {number} [k]                 how many neighbors to bind (default 3)
 * @param {number} [minWeight]         minimum edge weight to write (default 0.5)
 * @returns {{edges_added: number, neighbors_found: number}}
 */
export function populateSimilarToEdges(graph, sourceConceptLabel, cylinderIndex, newSig, k = 3, minWeight = 0.5) {
  const src = findOrCreateConcept(graph, sourceConceptLabel);
  const neighbors = cylinderIndex.queryConcepts(newSig, { kProbes: k * 5 }).slice(0, k);
  let edges_added = 0;
  for (const n of neighbors) {
    if (n.label === sourceConceptLabel) continue;
    // Weight from inverse distance — closer = stronger edge
    const weight = 1 / (1 + n.distance);
    if (weight < minWeight) continue;
    const target = findOrCreateConcept(graph, n.label);
    const existing = graph.edges.find((e) => e.type === "SIMILAR_TO" &&
                                             ((e.from === src.id && e.to === target.id) ||
                                              (e.from === target.id && e.to === src.id)));
    if (existing) {
      // Strengthen existing edge with moving average
      existing.weight = 0.7 * existing.weight + 0.3 * weight;
    } else {
      addEdge(graph, src.id, "SIMILAR_TO", target.id, weight);
      edges_added++;
    }
  }
  return { edges_added, neighbors_found: neighbors.length };
}

/**
 * #109 — Extract EPISODE cluster centroids as YouTube search queries.
 * Boundary-video ingest priority: the episodes represent OOD observations
 * that the current concept coverage can't explain. Their cluster centroids
 * point to conceptual gaps.
 *
 * @param {object} graph
 * @param {number} [minEpisodes]  don't cluster below this count
 * @returns {Array<{search_hint: string, cluster_size: number, mean_distance: number}>}
 */
export function episodesToIngestQueries(graph, minEpisodes = 3) {
  const episodes = [...graph.nodes.values()].filter((n) => n.type === "EPISODE");
  if (episodes.length < minEpisodes) return [];
  // Group by their originating expected/observed concepts
  const groups = new Map();
  for (const ep of episodes) {
    const key = (ep.expected ?? "unknown") + "→" + (ep.observed ?? "unknown");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(ep);
  }
  const queries = [];
  for (const [key, group] of groups.entries()) {
    if (group.length < 2) continue;
    const meanDist = group.reduce((a, b) => a + (b.distance ?? 0), 0) / group.length;
    // Search hint: things-that-look-like-X-but-arent-Y
    const [expected, observed] = key.split("→");
    const search_hint = `things that look like ${observed} but are not ${expected}`;
    queries.push({ search_hint, cluster_size: group.length, mean_distance: meanDist });
  }
  return queries;
}

/**
 * #111 — Post-ingest gate: for each concept in the store, run
 * modularClosureCheck (turning-key) and emit gap warnings.
 *
 * @param {object} store  identity-store-v2
 * @param {object} [opts]
 *   opts.keyUnit         canonical curated-sig K (default 8)
 *   opts.targetUnits     target signatures / keyUnit (default 25 for 200 sigs)
 * @returns {Array<{label, sigs, complete_units, missing_to_close, closed}>}
 */
export function auditStoreClosure(store, opts = {}) {
  const keyUnit = opts.keyUnit ?? 8;
  const targetUnits = opts.targetUnits ?? 25;
  return (store.labels ?? []).map((row) => {
    const status = turningKeyClose(row, { keyUnit, targetUnits });
    return {
      label: row.label,
      sigs: status.signatures,
      complete_units: status.complete_units,
      missing_to_close: status.missing_to_close,
      closed: status.closed,
    };
  });
}

/**
 * #111 — Human-readable post-ingest report.
 */
export function closureReport(store, opts = {}) {
  const audit = auditStoreClosure(store, opts);
  const lines = ["=== STORE CLOSURE AUDIT ==="];
  for (const a of audit) {
    const status = a.closed
      ? "✓ CLOSED"
      : a.missing_to_close > 0
        ? `✗ needs +${a.missing_to_close} sigs`
        : `~ closed but under target`;
    lines.push(`  ${a.label.padEnd(20)} ${String(a.sigs).padStart(4)} sigs = ${String(a.complete_units).padStart(3)} key-units    ${status}`);
  }
  return lines.join("\n");
}

/**
 * Alias for #111 — modularClosureCheck is the doctrine-clean name for
 * turningKeyClose. Both call sites work; the doctrine-clean one is
 * preferred in new code. `turningKeyClose` is kept for backwards compat.
 */
export { turningKeyClose as modularClosureCheck } from "./celtic-graph.mjs";
