// G23 — Misfit beta is governed; no silent canon drift.
//
// We check that 18-HELD or a misfit/ subdir exists with a README or
// governance manifest declaring the frontier scope. Absence of governance
// while misfit artifacts exist is a violation.

import { existsSync, readdirSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";

const MISFIT_ROOTS = [
  resolve(ORANGE5_ROOT, "18-HELD"),
  resolve(ORANGE5_ROOT, "misfit"),
  resolve(ORANGE5_ROOT, "19-ARCHIVE/misfit"),
];

function hasContent(p) {
  if (!existsSync(p)) return false;
  try {
    return readdirSync(p).some((f) => f !== ".gitkeep");
  } catch {
    return false;
  }
}

function hasGovernance(p) {
  const candidates = ["README.md", "GOVERNANCE.md", "SCOPE.md", "MANIFEST.md"];
  return candidates.some((c) => existsSync(join(p, c)));
}

export async function run() {
  const offenders = [];
  for (const root of MISFIT_ROOTS) {
    if (!existsSync(root)) continue;
    if (hasContent(root) && !hasGovernance(root)) {
      offenders.push(root);
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "misfit beta directory has content but no governance manifest",
        offenders,
      },
    };
  }
  return { pass: true, details: { checked: MISFIT_ROOTS } };
}
