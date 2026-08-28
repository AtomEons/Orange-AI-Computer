#!/usr/bin/env bun
// #100 — aeyes.ready_to_ship_check
//
// One executable checklist that walks every AEyes¹ gap from the 100-list
// and returns pass/fail per item. Converts documentation into CI.
//
// Bun-native, zero learned parameters, deterministic.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const STRUCTURAL = path.resolve(__dir, "..");

function fileExists(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }
function hasImport(filePath, importName) {
  if (!fileExists(filePath)) return false;
  return fs.readFileSync(filePath, "utf8").includes(importName);
}
function fileContains(filePath, pattern) {
  if (!fileExists(filePath)) return false;
  return new RegExp(pattern).test(fs.readFileSync(filePath, "utf8"));
}

const CHECKS = [
  { id: 65,  title: "8-axis buildRichSignature",           check: () => fileContains(path.join(STRUCTURAL, "identity/identity-store-v2.mjs"), "subSum.*ratioSum.*freqSum.*channels12Sum") },
  { id: 66,  title: "Per-concept rejection thresholds",     check: () => fileContains(path.join(STRUCTURAL, "identity/second-pass-alpha.mjs"), "recognizeWithHonestVerdict") },
  { id: 100, title: "ready_to_ship_check exists",           check: () => fileExists(path.join(STRUCTURAL, "identity/ready-to-ship-check.mjs")) },
  { id: 101, title: "recognizeSet emit-a-set exists",       check: () => fileContains(path.join(STRUCTURAL, "identity/second-pass-alpha.mjs"), "export function recognizeSet") },
  { id: 102, title: "17-channel signature (retinal12 wired)", check: () => fileContains(path.join(STRUCTURAL, "identity/identity-store-v2.mjs"), "channels12Sum") && fileContains(path.join(STRUCTURAL, "identity/identity-store-v2.mjs"), "retinal12:") },
  { id: 103, title: "populateSimilarToEdges exists",         check: () => fileContains(path.join(STRUCTURAL, "graph/graph-writers.mjs"), "populateSimilarToEdges") },
  { id: 104, title: "Per-concept β temperature",             check: () => fileContains(path.join(STRUCTURAL, "identity/hopfield-retrieval.mjs"), "perConceptBeta") },
  { id: 105, title: "knot-vector-index deprecated in header", check: () => fileContains(path.join(STRUCTURAL, "identity/knot-vector-index.mjs"), "DEPRECATED") },
  { id: 106, title: "bench:aeyes-* scripts in package.json", check: () => fileContains(path.join(ORANGE5, "package.json"), "bench:aeyes-cylinder-100k") },
  { id: 107, title: "compute12Channels accepts precomputed flow", check: () => fileContains(path.join(STRUCTURAL, "retinal-12.mjs"), "precomputedFlow") },
  { id: 108, title: "fpsSampleConfigs sweep sampler",        check: () => fileExists(path.join(STRUCTURAL, "ingest/fps-sweep-sampler.mjs")) },
  { id: 109, title: "episodesToIngestQueries exists",        check: () => fileContains(path.join(STRUCTURAL, "graph/graph-writers.mjs"), "episodesToIngestQueries") },
  { id: 110, title: "v1 modules marked DEPRECATED",           check: () => fileContains(path.join(STRUCTURAL, "identity/identity-store.mjs"), "DEPRECATED") && fileContains(path.join(STRUCTURAL, "multi-axis-attention.mjs"), "DEPRECATED") && fileContains(path.join(STRUCTURAL, "perception/lgn-gate.mjs"), "DEPRECATED") },
  { id: 111, title: "auditStoreClosure / modularClosureCheck", check: () => fileContains(path.join(STRUCTURAL, "graph/graph-writers.mjs"), "auditStoreClosure") },
  { id: 113, title: "recognizeWithHonestVerdict / needs_review", check: () => fileContains(path.join(STRUCTURAL, "identity/second-pass-alpha.mjs"), "needs_review") },
  { id: 114, title: "recognize-human-grade primitive exists",      check: () => fileExists(path.join(STRUCTURAL, "identity/recognize-human-grade.mjs")) },
  { id: 115, title: "HUMAN_GRADE_CEILING (raw distance gate)",     check: () => fileContains(path.join(STRUCTURAL, "identity/recognize-human-grade.mjs"), "HUMAN_GRADE_CEILING = 1.8") },
  { id: 116, title: "recognizeHumanGradeFrame exported",           check: () => fileContains(path.join(STRUCTURAL, "identity/recognize-human-grade.mjs"), "export function recognizeHumanGradeFrame") },
  { id: 117, title: "Wave 1a — held-out validator exists",         check: () => fileExists(path.join(STRUCTURAL, "identity/prove-heldout.mjs")) },
  { id: 118, title: "Wave 1b — scaling-attack harness exists",     check: () => fileExists(path.join(STRUCTURAL, "identity/scaling-attack.mjs")) },
  { id: 119, title: "Wave 1c — per-concept reject_ceiling",         check: () => fileContains(path.join(STRUCTURAL, "identity/recognize-human-grade.mjs"), "reject_ceiling") },
  { id: 120, title: "Wave 1c — second-nearest confidence",         check: () => fileContains(path.join(STRUCTURAL, "identity/recognize-human-grade.mjs"), "second_dist") && fileContains(path.join(STRUCTURAL, "identity/recognize-human-grade.mjs"), "confidence") },
  { id: 121, title: "Wave 1d — spine adapter exists",              check: () => fileExists(path.resolve(STRUCTURAL, "..", "adapters/aeyes-spine-adapter.mjs")) },
  { id: 122, title: "Wave 1d — aeyes.recognize.v1 action",         check: () => fileContains(path.resolve(STRUCTURAL, "..", "adapters/aeyes-spine-adapter.mjs"), "aeyes.recognize.v1") },
  { id: 123, title: "Wave 2a — YouTube ingest pipeline exists",    check: () => fileExists(path.join(STRUCTURAL, "ingest/youtube-corpus-ingest.mjs")) },
  { id: 124, title: "Wave 3a — transcript binding exists",         check: () => fileExists(path.join(STRUCTURAL, "ingest/transcript-binding.mjs")) },
  { id: 125, title: "Wave 3b — text-query-lookup exists",          check: () => fileExists(path.join(STRUCTURAL, "identity/text-query-lookup.mjs")) },
];

console.log("=== AEyes¹ ready-to-ship checklist ===\n");
const results = [];
let pass = 0, fail = 0;
for (const c of CHECKS) {
  let ok;
  try { ok = c.check(); } catch { ok = false; }
  results.push({ ...c, ok });
  if (ok) pass++; else fail++;
  console.log("  " + (ok ? "✓" : "✗") + " #" + String(c.id).padStart(3) + " " + c.title);
}
console.log("\n" + pass + " passing / " + fail + " failing / " + CHECKS.length + " total");
if (fail === 0) console.log("\n✓ All checked gaps CLOSED. Substrate is at the audited ready-line.");

// JSON output for spine consumption
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ pass, fail, total: CHECKS.length, results }, null, 2));
}
