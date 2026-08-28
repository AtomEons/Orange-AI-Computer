#!/usr/bin/env bun
/**
 * run-all.mjs — spawn every ext test + the frozen baseline validator, collect
 * pass/fail, print a combined report. Not a schema tool; just a convenience
 * harness for CI/this session. Exit non-zero if anything fails.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const schemaDir = join(here, "..", "..");

const suites = [
  ["baseline validate-schemas (frozen v1 intact)", join(schemaDir, "tests", "validate-schemas.mjs")],
  ["envelope-validate", join(here, "test-envelope-validate.mjs")],
  ["order-v2-additions", join(here, "test-order-v2-additions.mjs")],
  ["migrate-v1-v2", join(here, "test-migrate-v1-v2.mjs")],
  ["schema-doc-gen", join(here, "test-schema-doc-gen.mjs")],
  ["schema-lint", join(here, "test-schema-lint.mjs")],
  ["fixtures", join(here, "test-fixtures.mjs")],
];

let anyFail = false;
const lines = [];
for (const [label, file] of suites) {
  const r = spawnSync("bun", [file], { encoding: "utf8" });
  const out = (r.stdout || "") + (r.stderr || "");
  const summary = out.split("\n").reverse().find((l) => /Summary:|passed \/|\[schema-tests\]/.test(l)) || "(no summary line)";
  const ok = r.status === 0;
  if (!ok) anyFail = true;
  lines.push(`${ok ? "PASS" : "FAIL"}  ${label.padEnd(40)}  ${summary.trim()}  [exit ${r.status}]`);
  if (!ok) {
    lines.push("----- output -----");
    lines.push(out.trim());
    lines.push("------------------");
  }
}
console.log(lines.join("\n"));
console.log(`\nALL SUITES: ${anyFail ? "RED" : "GREEN"}`);
process.exit(anyFail ? 1 : 0);
