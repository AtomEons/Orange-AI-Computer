// G03 — Gate 0 LatticeIntegrityGate (LBCE) is first in every gate chain.
//
// We scan for any module that defines a gate chain (a const/array named
// gates / GATE_CHAIN / GATES or a class field with similar name). The first
// entry must reference LatticeIntegrityGate / LBCE.

import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const CHAIN_DECL = /(?:const|let|var|export\s+const)\s+(GATE_CHAIN|GATES|gates|gateChain)\s*=\s*\[([\s\S]*?)\]/g;
const LBCE = /(LatticeIntegrityGate|LBCE|Gate0|GATE_0_LBCE|gate-0-lbce)/i;

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".mjs", ".js", ".ts", ".tsx"],
    maxFiles: 5000,
  });
  const offenders = [];
  let chainsSeen = 0;
  for (const f of files) {
    const fp = f.replaceAll("\\", "/");
    if (fp.includes("/tests/")) continue;
    const body = readSafe(f);
    if (!body) continue;
    let m;
    CHAIN_DECL.lastIndex = 0;
    while ((m = CHAIN_DECL.exec(body)) !== null) {
      const arrayBody = m[2];
      if (!arrayBody.trim()) continue;
      if (/^(?:GATES|gates)$/.test(m[1]) && !fp.includes("nine-gate-stack")) continue;
      chainsSeen += 1;
      // Split on commas not inside parens — naive but fine for our codebase
      const first = arrayBody.split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean)[0] || "";
      if (!LBCE.test(first)) {
        offenders.push({ file: f, first });
      }
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "gate chain found whose first entry is not Gate 0 (LBCE)",
        offenders: offenders.slice(0, 5),
        chains_seen: chainsSeen,
      },
    };
  }
  return { pass: true, details: { chains_seen: chainsSeen } };
}
