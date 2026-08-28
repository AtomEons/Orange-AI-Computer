#!/usr/bin/env node
// Boundary test runner — exercises boundary.mjs directly (no HTTP needed).
// Run: node C:/AtomEons/Orange5/06-ORANGELLM/tests/run-boundary-tests.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { boundary } from "../server/boundary.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const fixturesPath = join(__dirname, "boundary-fixtures.json");
const fixtures = JSON.parse(readFileSync(fixturesPath, "utf8"));

let pass = 0;
let fail = 0;
const failures = [];

console.log(`[boundary-tests] running ${fixtures.fixtures.allowed.length + fixtures.fixtures.rejected.length} fixtures`);

for (const f of fixtures.fixtures.allowed) {
  const result = boundary({ method: f.method, path: f.path, headers: f.headers || {} });
  if (result.reject) {
    fail++;
    failures.push({ id: f.id, kind: "should-allow-but-rejected", reason: result.reason, status: result.status });
  } else {
    pass++;
    console.log(`  PASS ${f.id} — allowed`);
  }
}

for (const f of fixtures.fixtures.rejected) {
  const result = boundary({ method: f.method, path: f.path, headers: f.headers || {} });
  if (!result.reject) {
    fail++;
    failures.push({ id: f.id, kind: "should-reject-but-allowed", path: f.path });
  } else if (f.expected_status && result.status !== f.expected_status) {
    fail++;
    failures.push({ id: f.id, kind: "wrong-status", expected: f.expected_status, got: result.status, reason: result.reason });
  } else if (f.expected_reason_includes && !result.reason.includes(f.expected_reason_includes)) {
    fail++;
    failures.push({ id: f.id, kind: "wrong-reason", expected_includes: f.expected_reason_includes, got: result.reason });
  } else {
    pass++;
    console.log(`  PASS ${f.id} — rejected as expected (${result.status} ${result.reason})`);
  }
}

console.log(`\n[boundary-tests] ${pass} passed / ${fail} failed`);

if (fail > 0) {
  console.error(`[boundary-tests] FAILURES:`);
  for (const f of failures) console.error(`  - ${JSON.stringify(f)}`);
  process.exit(1);
}

console.log(`[boundary-tests] ALL GREEN — Frontier-Isolation Boundary holds.`);
process.exit(0);
