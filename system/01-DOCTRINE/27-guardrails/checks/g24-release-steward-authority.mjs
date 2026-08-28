// G24 — Release-steward authority preserved; no specialist self-upgrades.
//
// We check that authority annotations in agent/role declarations don't claim
// release-steward unless the file is the release-steward agent itself.

import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const SELF_UPGRADE = /(role|authority)\s*[:=]\s*["']?release[_-]?steward["']?/i;

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".mjs", ".js", ".ts", ".tsx", ".md", ".yaml", ".yml", ".json"],
    maxFiles: 6000,
  });
  const offenders = [];
  for (const f of files) {
    const fp = f.replaceAll("\\", "/");
    // Allow the release-steward agent file itself
    if (/release[-_]steward/i.test(fp)) continue;
    if (fp.includes("/01-DOCTRINE/27-guardrails/")) continue;
    if (fp.includes("/.claude/rules/")) continue; // doctrine docs may name it
    if (fp.includes("CLAUDE.md")) continue;
    const body = readSafe(f);
    if (!body) continue;
    if (SELF_UPGRADE.test(body)) {
      offenders.push(f);
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "non-release-steward file claims release-steward authority",
        offenders: offenders.slice(0, 5),
      },
    };
  }
  return { pass: true, details: { scanned_files: files.length } };
}
