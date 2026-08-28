// 02 — G-01 — runtime/node.py is the sole authoritative cognitive center.
//
// Two-pronged check:
//   (a) static: the canonical file exists; its sha256 matches the recorded
//       value in state.expectedNodeSha (if provided) or in
//       state.statusDb.guardrails["G-01"].last_evidence_json.sha256.
//   (b) static-grep: no other source file defines a competing cognitive
//       core (class Node / class CognitiveCore / def think(/) outside
//       runtime/node.py.
//
// state shape:
//   state.expectedNodeSha : string|null   — pinned sha256 of runtime/node.py
//   state.nodePath        : string|null   — override path (defaults to
//                                            $ORANGE5_ROOT/runtime/node.py)
//
// opts:
//   opts.scanRoot         : string        — root for grep (default ORANGE5_ROOT)
//   opts.skipGrep         : boolean       — skip prong (b) for fast online use

import { resolve } from "node:path";
import {
  safe,
  result,
  ORANGE5_ROOT,
  fileExists,
  sha256OfFile,
  walkGrep,
} from "../lib/check-util.mjs";

export const id = "G-01";
export const slug = "runtime-node-py-sole-authority";
export const severity = "block";

const COMPETITOR_RX =
  /\b(class\s+Node\b|class\s+CognitiveCore\b|def\s+think\s*\()/;

export const check = safe(async (state, opts) => {
  const nodePath =
    state.nodePath || resolve(ORANGE5_ROOT, "runtime", "node.py");

  if (!fileExists(nodePath)) {
    return result(false, {
      reason: "missing_canonical_node",
      path: nodePath,
      receipt_trigger: "G01_SHADOW_COGNITION",
    });
  }

  const sha = sha256OfFile(nodePath);
  const expected =
    state.expectedNodeSha ||
    (state.statusDb &&
      state.statusDb["G-01"] &&
      state.statusDb["G-01"].sha256) ||
    null;

  if (expected && sha !== expected) {
    return result(false, {
      reason: "node_sha_changed",
      path: nodePath,
      observed_sha256: sha,
      expected_sha256: expected,
      receipt_trigger: "G01_SHADOW_COGNITION",
      remedy:
        "Cognitive center changed without an amendment. Verify the diff, then either revert or pin the new sha through the amendment procedure (spec §9).",
    });
  }

  if (opts.skipGrep) {
    return result(true, { sha256: sha, grep_skipped: true });
  }

  const scanRoot = opts.scanRoot || ORANGE5_ROOT;
  const hits = [];
  for await (const m of walkGrep(scanRoot, COMPETITOR_RX, {
    extensions: [".py"],
  })) {
    // The canonical file is allowed to define class Node / def think.
    if (m.file.replace(/\\/g, "/").endsWith("/runtime/node.py")) continue;
    hits.push({ file: m.file, line: m.line, text: m.text });
    if (hits.length >= 25) break;
  }

  if (hits.length > 0) {
    return result(false, {
      reason: "competing_cognitive_core_defined",
      sha256: sha,
      offenders: hits,
      receipt_trigger: "G01_SHADOW_COGNITION",
    });
  }

  return result(true, { sha256: sha, grep_hits: 0 });
});

export default check;
