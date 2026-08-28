// 05 — G-04 — Human Final Stop is reachable from any autonomous-action path.
//
// Two prongs:
//   (a) static: every file marked with `@autonomous` (in a leading comment)
//       must import a symbol named `humanFinalStop`.
//   (b) online: the action DAG (`state.actionDag`) must have a path from
//       every terminal node back to a `humanFinalStop` node. We model the
//       DAG as { nodes: [{id, isTerminal, isStop}], edges: [[from, to], ...] }
//       and BFS upward from `humanFinalStop` to see whether every terminal
//       is in the reachable set.
//
// state.actionDag : { nodes: Array, edges: Array<[string,string]> }
// state.autonomousFiles : string[] — optional list to skip the static scan
//
// opts.scanRoot : string — root for the @autonomous scan (default ORANGE5_ROOT)
// opts.skipStatic / opts.skipDag : booleans to limit scope

import {
  safe,
  result,
  ORANGE5_ROOT,
  walkGrep,
  readTextSafe,
} from "../lib/check-util.mjs";

export const id = "G-04";
export const slug = "human-final-stop-reachable";
export const severity = "block";

const AUTONOMOUS_MARKER = /@autonomous\b/;
const HFS_IMPORT_RX =
  /(import\s+\{[^}]*\bhumanFinalStop\b[^}]*\}|require\(.*humanFinalStop)/;

export const check = safe(async (state, opts) => {
  const evidence = {};

  if (!opts.skipStatic) {
    const scanRoot = opts.scanRoot || ORANGE5_ROOT;
    const offenders = [];
    const seenFiles = new Set();
    for await (const m of walkGrep(scanRoot, AUTONOMOUS_MARKER, {
      extensions: [".js", ".mjs", ".ts", ".tsx", ".py"],
    })) {
      if (seenFiles.has(m.file)) continue;
      seenFiles.add(m.file);
      const text = readTextSafe(m.file);
      if (!text) continue;
      if (!HFS_IMPORT_RX.test(text)) {
        offenders.push({ file: m.file, line: m.line });
        if (offenders.length >= 25) break;
      }
    }
    evidence.autonomous_files_scanned = seenFiles.size;
    if (offenders.length > 0) {
      return result(false, {
        reason: "autonomous_module_without_humanFinalStop_import",
        offenders,
        receipt_trigger: "G04_HFS_UNREACHABLE",
      });
    }
  }

  if (!opts.skipDag) {
    const dag = state.actionDag;
    if (!dag || !Array.isArray(dag.nodes) || !Array.isArray(dag.edges)) {
      return result(false, {
        reason: "no_action_dag",
        receipt_trigger: "G04_HFS_UNREACHABLE",
        remedy:
          "Online prong cannot run without state.actionDag. Boot must populate the DAG before this check.",
      });
    }

    // Build reverse adjacency, BFS from any humanFinalStop node.
    const reverse = new Map();
    for (const [from, to] of dag.edges) {
      if (!reverse.has(to)) reverse.set(to, []);
      reverse.get(to).push(from);
    }
    const stopNodes = dag.nodes
      .filter((n) => n.isStop || n.id === "humanFinalStop")
      .map((n) => n.id);
    if (stopNodes.length === 0) {
      return result(false, {
        reason: "no_humanFinalStop_node_in_dag",
        receipt_trigger: "G04_HFS_UNREACHABLE",
      });
    }
    const reach = new Set();
    const queue = [...stopNodes];
    while (queue.length) {
      const n = queue.shift();
      if (reach.has(n)) continue;
      reach.add(n);
      const preds = reverse.get(n) || [];
      queue.push(...preds);
    }
    const unreachable = dag.nodes
      .filter((n) => n.isTerminal && !reach.has(n.id))
      .map((n) => n.id);
    evidence.terminal_count = dag.nodes.filter((n) => n.isTerminal).length;
    evidence.reachable_count = reach.size;
    if (unreachable.length > 0) {
      return result(false, {
        reason: "terminal_nodes_cannot_reach_humanFinalStop",
        unreachable,
        receipt_trigger: "G04_HFS_UNREACHABLE",
      });
    }
  }

  return result(true, evidence);
});

export default check;
