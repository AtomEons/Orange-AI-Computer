// G12 — Reality Flux lane discipline.
//
// Any code that writes to the Flux ledger with lane: "reality" MUST set
// origin to a terminal/receipt source (origin starts with "receipt." or
// "terminal." or "doctrine." — anything else is thought-lane). Naive but
// catches the obvious misclassifications.

import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const ALLOWED_ORIGIN_PREFIX = /^(receipt|terminal|doctrine|cobra|n150)\./;

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".mjs", ".js", ".ts", ".tsx"],
    maxFiles: 5000,
  });
  const offenders = [];
  for (const f of files) {
    const fp = f.replaceAll("\\", "/");
    if (fp.includes("/_retired/") || fp.includes("/tests/") || /(?:\.test|smoke-test)\.mjs$/.test(fp)) continue;
    const body = readSafe(f);
    if (!body) continue;
    const bad = [];
    for (const match of body.matchAll(/lane\s*:\s*["']reality["']/g)) {
      const start = Math.max(0, match.index - 350);
      const end = Math.min(body.length, match.index + match[0].length + 350);
      const window = body.slice(start, end);
      // Training/schema rows are data, not Flux writes. A production envelope
      // nearby will always declare an origin in the same local object/call.
      const origins = [...window.matchAll(/origin\s*:\s*["']([^"']+)["']/g)].map((m) => m[1]);
      for (const origin of origins) {
        if (!ALLOWED_ORIGIN_PREFIX.test(origin) && !bad.includes(origin)) bad.push(origin);
      }
    }
    if (bad.length > 0) {
      offenders.push({ file: f, bad_origins: bad });
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "reality-lane Flux write with non-reality origin",
        offenders: offenders.slice(0, 5),
      },
    };
  }
  return { pass: true, details: { scanned_files: files.length } };
}
