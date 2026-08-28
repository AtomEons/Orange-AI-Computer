// 07-VISUAL/adapters/aeyes-spine-adapter.mjs
//
// AE12 Wave 1d — spine adapter for AEyes¹ human-grade recognizer.
//
// Wraps recognizeHumanGradeImage() to emit an orange.report.v1 envelope
// compatible with the Orange5 spine. The recognizer becomes an executor
// for the action `aeyes.recognize.v1` — spine can route, receipt, replay.
//
// Also seeds concept-graph SIMILAR_TO edges on successful recognition
// (populateSimilarToEdges) so identity results warm the graph.

import path from "node:path";
import { recognizeHumanGradeImage } from "../structural/identity/recognize-human-grade.mjs";
import { populateSimilarToEdges } from "../structural/graph/graph-writers.mjs";

/**
 * Executor for spine action `aeyes.recognize.v1`.
 *
 * Order payload:
 *   image_path : string (required)
 *   store      : identity-store-v2 (required)
 *   opts       : {useLoose, ceiling, maxEntities} (optional)
 *   graph      : concept graph (optional — if present, we write SIMILAR_TO edges)
 *   cylinderIndex : (optional — for graph writer)
 *
 * Emits orange.report.v1:
 *   {schema, action, status, summary, output:{winner, dist, confidence, ...}, mistakes_surfaced}
 */
export async function executeAeyesRecognize(order) {
  const { image_path, store, opts = {}, graph, cylinderIndex } = order.payload || {};
  if (!image_path) throw new Error("aeyes.recognize.v1 requires payload.image_path");
  if (!store) throw new Error("aeyes.recognize.v1 requires payload.store");

  const r = await recognizeHumanGradeImage(image_path, store, opts);

  const status = r.emit_action === "recognized_as" ? "ok" : "needs_review";
  const summary = r.emit_action === "recognized_as"
    ? `recognized_as ${r.winner} (dist=${r.dist.toFixed(3)}, confidence=${r.confidence.toFixed(3)}, ceiling=${r.ceiling_used})`
    : `needs_review — no concept within ceiling (nearest=${r.nearest_candidate || 'none'}, dist=${r.dist === Infinity ? '∞' : r.dist.toFixed(3)})`;

  // If graph + cylinder are present and recognition succeeded, seed SIMILAR_TO edges
  if (r.emit_action === "recognized_as" && graph && cylinderIndex && r.winner) {
    try {
      populateSimilarToEdges(graph, r.winner, cylinderIndex, /*newSig*/ null, /*k*/ 5, /*minWeight*/ 0.3);
    } catch (_) { /* graph write is best-effort; don't break the recognition path */ }
  }

  return {
    schema: "orange.report.v1",
    action: "aeyes.recognize.v1",
    status,
    summary,
    lane: "reflex",
    output: {
      winner: r.winner,
      nearest_candidate: r.nearest_candidate,
      dist: r.dist,
      match_kind: r.match_kind,
      second_dist: r.second_dist,
      second_winner: r.second_winner,
      confidence: r.confidence,
      ceiling_used: r.ceiling_used,
      emit_action: r.emit_action,
      entities_examined: r.entities_examined,
    },
    mistakes_surfaced: 0,
  };
}

/**
 * Spine action registrar — call this at spine boot to register the executor.
 * The spine's dispatcher will call `executeAeyesRecognize(order)` for any
 * order with action == "aeyes.recognize.v1".
 */
export const AEYES_RECOGNIZE_ACTION = "aeyes.recognize.v1";

export function registerWithSpine(spineDispatcher) {
  if (typeof spineDispatcher?.register !== "function") return false;
  spineDispatcher.register(AEYES_RECOGNIZE_ACTION, executeAeyesRecognize);
  return true;
}
