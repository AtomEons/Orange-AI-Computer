// G26 — Standing routing law honored: Orange3/Orangebox cockpit referenced.
//
// LOW severity: CLAUDE.md should mention Orange3 or Orangebox routing. This
// catches accidental erasure of the Standing Law on session reorg.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";

const CANDIDATES = [
  resolve(homedir(), ".claude", "CLAUDE.md"),
  resolve(ORANGE5_ROOT, "..", "CLAUDE.md"),
  resolve(ORANGE5_ROOT, "CLAUDE.md"),
];

export async function run() {
  const hits = [];
  for (const p of CANDIDATES) {
    if (!existsSync(p)) continue;
    const body = readFileSync(p, "utf8");
    if (/OrangeFive/i.test(body) && /orange\.order\.v1|OrangeBrain|governed spine/i.test(body)) {
      hits.push(p);
    }
  }
  if (hits.length === 0) {
    return {
      pass: false,
      details: { reason: "no CLAUDE.md references the OrangeFive governed routing law", checked: CANDIDATES },
    };
  }
  return { pass: true, details: { found_in: hits } };
}
