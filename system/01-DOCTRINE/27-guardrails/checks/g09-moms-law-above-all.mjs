// G09 — Mom's Law sits above all other rules.
//
// The canonical text must be present at .claude/rules/00-moms-law.md somewhere
// in the AtomEons tree, and CLAUDE.md must reference it.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { ORANGE5_ROOT } from "../lib/paths.mjs";

const CANDIDATE_MOMS_LAW = [
  resolve("C:/AtomEons/.claude/rules/00-moms-law.md"),
  resolve(ORANGE5_ROOT, "../.claude/rules/00-moms-law.md"),
  resolve(ORANGE5_ROOT, ".claude/rules/00-moms-law.md"),
];

const CANDIDATE_CLAUDE_MD = [
  resolve("C:/AtomEons/CLAUDE.md"),
  resolve(homedir(), ".claude/CLAUDE.md"),
  resolve(ORANGE5_ROOT, "CLAUDE.md"),
];

export async function run() {
  const lawPath = CANDIDATE_MOMS_LAW.find((p) => existsSync(p)) || null;
  if (!lawPath) {
    return {
      pass: false,
      details: { reason: "00-moms-law.md not found", checked: CANDIDATE_MOMS_LAW },
    };
  }
  const lawText = readFileSync(lawPath, "utf8");
  if (!/Give full effort every time/i.test(lawText)) {
    return {
      pass: false,
      details: { reason: "Mom's Law canonical quote missing from law file", path: lawPath },
    };
  }
  const claudeMdPath = CANDIDATE_CLAUDE_MD.find((p) => existsSync(p)) || null;
  if (!claudeMdPath) {
    return {
      pass: true,
      details: { law_path: lawPath, claude_md: "not_found_but_law_present" },
    };
  }
  const md = readFileSync(claudeMdPath, "utf8");
  if (!/Mom['’]s Law/i.test(md)) {
    return {
      pass: false,
      details: {
        reason: "CLAUDE.md does not reference Mom's Law",
        claude_md: claudeMdPath,
      },
    };
  }
  return { pass: true, details: { law_path: lawPath, claude_md: claudeMdPath } };
}
