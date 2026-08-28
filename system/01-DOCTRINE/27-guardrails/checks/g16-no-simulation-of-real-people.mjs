// G16 — No simulation of real people in code/comments/prompts.
//
// HRE doctrine: never write "as <real person> would say…" or "channeling
// <real person>" in source or prompt files. We sweep markdown and code.

import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const SIMULATION_PATTERNS = [
  /as\s+(?:elon|jobs|steve\s+jobs|sam\s+altman|bezos|musk|altman|dario|anthropic\s+ceo|atom\s+mccree)[^.\n]{0,40}\s+would\s+say/i,
  /channel(?:ing|s)\s+(?:elon|jobs|steve\s+jobs|sam\s+altman|bezos|musk|altman|dario)/i,
  /in\s+the\s+voice\s+of\s+(?:elon|jobs|steve\s+jobs|sam\s+altman|bezos|musk|altman|dario)/i,
  /pretend(?:ing)?\s+to\s+be\s+(?:elon|jobs|steve\s+jobs|sam\s+altman|bezos|musk|altman|dario)/i,
];

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".md", ".mjs", ".js", ".ts", ".tsx", ".py", ".txt", ".prompt"],
    maxFiles: 6000,
  });
  const offenders = [];
  for (const f of files) {
    if (f.replaceAll("\\", "/").includes("/01-DOCTRINE/27-guardrails/")) continue;
    const body = readSafe(f);
    if (!body) continue;
    for (const re of SIMULATION_PATTERNS) {
      if (re.test(body)) {
        offenders.push({ file: f, pattern: re.source.slice(0, 60) });
        break;
      }
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "simulation-of-real-person phrasing found",
        offenders: offenders.slice(0, 5),
      },
    };
  }
  return { pass: true, details: { scanned_files: files.length } };
}
