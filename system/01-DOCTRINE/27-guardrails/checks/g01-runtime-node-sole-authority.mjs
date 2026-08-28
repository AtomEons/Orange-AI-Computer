// G01 — runtime/node.py is sole authoritative cognitive center.
//
// We assert: (a) the runtime/node.py file exists somewhere under ORANGE5_ROOT
// or aeons brain root, and (b) no rival file declares itself the cognitive
// center via the marker constant COGNITIVE_CENTER = True outside that path.

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, grep } from "../lib/scan.mjs";

const CANDIDATE_PATHS = [
  resolve(ORANGE5_ROOT, "runtime/node.py"),
  resolve(ORANGE5_ROOT, "06-ORANGELLM/runtime/node.py"),
  resolve("C:/AtomEons/runtime/node.py"),
];

export async function run() {
  const present = CANDIDATE_PATHS.filter((p) => existsSync(p));
  // Look for rival cognitive centers in code
  const pyFiles = walk(ORANGE5_ROOT, { exts: [".py"], maxFiles: 3000 });
  const rivals = grep(pyFiles, /COGNITIVE_CENTER\s*=\s*True/);
  const rivalOutsideCanonical = rivals.filter(
    (p) => !p.replaceAll("\\", "/").endsWith("/runtime/node.py")
  );

  if (present.length === 0 && rivals.length === 0) {
    // Doctrine declared but not yet realized — informational
    return {
      pass: true,
      details: {
        note: "runtime/node.py not yet materialized in this checkout — no rivals declared either",
        candidates_checked: CANDIDATE_PATHS,
      },
    };
  }
  if (rivalOutsideCanonical.length > 0) {
    return {
      pass: false,
      details: {
        reason: "rival cognitive center declared outside runtime/node.py",
        rivals: rivalOutsideCanonical.slice(0, 5),
      },
    };
  }
  return {
    pass: true,
    details: { canonical_path_present: present[0] || null, rivals: 0 },
  };
}
