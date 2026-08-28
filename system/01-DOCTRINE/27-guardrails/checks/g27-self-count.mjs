// G27 — Self-referential invariant: registry must declare exactly 27 entries
// and the checks/ directory must contain exactly 27 g*.mjs files.

import { readdirSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { GUARDRAILS } from "../registry.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export async function run() {
  const registryCount = GUARDRAILS.length;
  let fileCount = 0;
  if (existsSync(HERE)) {
    fileCount = readdirSync(HERE).filter((f) => /^g\d{2}-.+\.mjs$/.test(f)).length;
  }
  if (registryCount !== 27) {
    return {
      pass: false,
      details: { reason: "registry has wrong number of entries", registryCount, expected: 27 },
    };
  }
  if (fileCount !== 27) {
    return {
      pass: false,
      details: { reason: "checks dir has wrong number of g??-*.mjs files", fileCount, expected: 27 },
    };
  }
  return { pass: true, details: { registryCount, fileCount } };
}
