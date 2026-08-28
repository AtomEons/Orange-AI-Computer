// G13 — Frontier loopback :7419 never exposed to non-loopback interface.
//
// Scan gateway/server boundary code for any listen call binding to 0.0.0.0 or
// a non-loopback interface when port 7419 is used. The cobra daemon must bind
// to 127.0.0.1 explicitly.

import { ORANGE5_ROOT } from "../lib/paths.mjs";
import { walk, readSafe } from "../lib/scan.mjs";

const SUSPECT = /(listen|hostname|host)\s*:?\s*\(?\s*["']?(0\.0\.0\.0|::|\[::\]|0:0:0:0:0:0:0:0)["']?[^,)]*[,)\s][^)]*7419/;
const ALT = /7419[^)]*?(host|hostname)\s*[:=]\s*["']?(0\.0\.0\.0|::)/i;

export async function run() {
  const files = walk(ORANGE5_ROOT, {
    exts: [".mjs", ".js", ".ts", ".tsx", ".py", ".toml", ".yml", ".yaml"],
    maxFiles: 6000,
  });
  const offenders = [];
  for (const f of files) {
    const body = readSafe(f);
    if (!body || !body.includes("7419")) continue;
    if (f.replaceAll("\\", "/").includes("/01-DOCTRINE/27-guardrails/")) continue;
    if (SUSPECT.test(body) || ALT.test(body)) {
      offenders.push(f);
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "frontier loopback (:7419) bound to non-loopback interface",
        offenders: offenders.slice(0, 5),
      },
    };
  }
  return { pass: true, details: { scanned_files: files.length } };
}
