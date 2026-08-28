#!/usr/bin/env node
// Tests for promote.mjs CLI. Node 20+. No deps.

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseArgs,
  scoreBakeoff,
  decide,
  runCli,
  FORBIDDEN_STATUS_WORDS,
  BAKEOFF_WIN_THRESHOLD,
  BAKEOFF_DIMENSIONS,
} from "../promote.mjs";

let pass = 0;
let fail = 0;
const failures = [];
const assert = (cond, msg) => {
  if (cond) {
    pass++;
    console.log(`  PASS ${msg}`);
  } else {
    fail++;
    failures.push(msg);
    console.log(`  FAIL ${msg}`);
  }
};

// --- workspace ---
const work = mkdtempSync(join(tmpdir(), "promote-test-"));
const receiptPath = join(work, "receipt.md");
writeFileSync(receiptPath, "# receipt\nreal content\n", "utf8");

const winningDims = {
  mission_shape: { candidate: 0.85, baseline: 0.70 },
  doctrine_recall: { candidate: 0.90, baseline: 0.80 },
  topology_recall: { candidate: 0.60, baseline: 0.75 }, // loss
  receipt_grounding: { candidate: 0.88, baseline: 0.70 },
  refusal_discipline: { candidate: 0.92, baseline: 0.65 },
};
const losingDims = {
  mission_shape: { candidate: 0.50, baseline: 0.70 },
  doctrine_recall: { candidate: 0.60, baseline: 0.80 },
  topology_recall: { candidate: 0.55, baseline: 0.75 },
  receipt_grounding: { candidate: 0.65, baseline: 0.70 },
  refusal_discipline: { candidate: 0.92, baseline: 0.65 }, // 1 win
};
const winBakeoff = join(work, "win.json");
writeFileSync(winBakeoff, JSON.stringify({ result: "win", dimensions: winningDims }), "utf8");
const failBakeoff = join(work, "fail.json");
writeFileSync(failBakeoff, JSON.stringify({ result: "fail", dimensions: losingDims }), "utf8");
const flatWinBakeoff = join(work, "flatwin.json");
writeFileSync(flatWinBakeoff, JSON.stringify({ result: "win" }), "utf8");
const losingDimWinResult = join(work, "loss-dims-win-flag.json");
writeFileSync(losingDimWinResult, JSON.stringify({ result: "win", dimensions: losingDims }), "utf8");
const malformed = join(work, "bad.json");
writeFileSync(malformed, "{not json", "utf8");

try {
  // === parseArgs ===
  console.log("\n[parseArgs]");
  let a = parseArgs(["--receipt", "r", "--bakeoff", "b", "--status", "OK", "--risk", "low"]);
  assert(a.receipt === "r" && a.bakeoff === "b" && a.status === "OK" && a.risk === "low", "basic args parsed");
  assert(a.operatorApproved === false, "operatorApproved defaults false");

  a = parseArgs(["--operator-approved", "--json", "--risk", "high"]);
  assert(a.operatorApproved === true, "--operator-approved flag");
  assert(a.json === true, "--json flag");

  a = parseArgs(["--help"]);
  assert(a.help === true, "--help flag");

  a = parseArgs(["--garbage"]);
  assert(a.unknown.includes("--garbage"), "unknown args captured");

  // === scoreBakeoff ===
  console.log("\n[scoreBakeoff]");
  let s = scoreBakeoff({ dimensions: winningDims });
  assert(s.wins === 4 && s.total === 5, "winning bakeoff: 4 of 5");
  assert(s.missingDims.length === 0, "no missing dims when complete");

  s = scoreBakeoff({ dimensions: losingDims });
  assert(s.wins === 1, "losing bakeoff: 1 win");

  s = scoreBakeoff({ result: "win" });
  assert(s.wins === 0 && s.missingDims.length === BAKEOFF_DIMENSIONS.length, "flat win has no dim data");
  assert(s.explicitResult === "win", "explicit result captured");

  // === decide ===
  console.log("\n[decide]");
  let d = decide({
    receiptOk: true,
    bakeoffOk: true,
    bakeoff: { result: "win", dimensions: winningDims },
    status: "ORANGE5_GREEN",
    risk: "low",
    operatorApproved: false,
  });
  assert(d.verdict === "promote", "real green + 4/5 wins -> promote");
  assert(d.reasons.length === 0, "no reasons on promote");

  d = decide({
    receiptOk: false,
    bakeoffOk: true,
    bakeoff: { result: "win", dimensions: winningDims },
    status: "OK",
    risk: "low",
  });
  assert(d.verdict === "hold", "missing receipt -> hold");
  assert(d.reasons.some((r) => r.includes("receipt")), "reason names receipt");

  d = decide({
    receiptOk: true,
    bakeoffOk: false,
    bakeoff: null,
    status: "OK",
    risk: "low",
  });
  assert(d.verdict === "hold", "missing bakeoff -> hold");

  d = decide({
    receiptOk: true,
    bakeoffOk: true,
    bakeoff: { result: "fail" },
    status: "OK",
    risk: "low",
  });
  assert(d.verdict === "reject", "explicit bakeoff fail -> reject");

  d = decide({
    receiptOk: true,
    bakeoffOk: true,
    bakeoff: { dimensions: losingDims },
    status: "OK",
    risk: "low",
  });
  assert(d.verdict === "reject", "candidate wins < threshold -> reject");
  assert(
    d.reasons.some((r) => r.includes(`need >= ${BAKEOFF_WIN_THRESHOLD}`)),
    "reason names threshold",
  );

  for (const word of FORBIDDEN_STATUS_WORDS) {
    d = decide({
      receiptOk: true,
      bakeoffOk: true,
      bakeoff: { result: "win", dimensions: winningDims },
      status: `it ${word} on my box`,
      risk: "low",
    });
    assert(d.verdict === "reject", `fake-green word "${word}" -> reject`);
  }

  d = decide({
    receiptOk: true,
    bakeoffOk: true,
    bakeoff: { result: "win", dimensions: winningDims },
    status: "OK",
    risk: "high",
    operatorApproved: false,
  });
  assert(d.verdict === "hold", "high risk without approval -> hold");

  d = decide({
    receiptOk: true,
    bakeoffOk: true,
    bakeoff: { result: "win", dimensions: winningDims },
    status: "OK",
    risk: "destructive",
    operatorApproved: true,
  });
  assert(d.verdict === "promote", "destructive WITH approval -> promote");

  d = decide({
    receiptOk: true,
    bakeoffOk: true,
    bakeoff: { result: "win", dimensions: winningDims },
    status: "OK",
    risk: "production",
    operatorApproved: false,
  });
  assert(d.verdict === "hold", "production without approval -> hold");

  // Hard-reject beats hold: missing receipt + fake-green -> reject
  d = decide({
    receiptOk: false,
    bakeoffOk: false,
    bakeoff: null,
    status: "green_assumed",
    risk: "low",
  });
  assert(d.verdict === "reject", "hard-reject (fake-green) beats hold");

  // === runCli (smoke + exit codes) ===
  console.log("\n[runCli]");
  let buf = "";
  let err = "";
  const w = (s) => { buf += s; };
  const we = (s) => { err += s; };

  buf = ""; err = "";
  let code = runCli(["--help"], { write: w, errWrite: we });
  assert(code === 0 && buf.includes("Usage:"), "--help prints usage and exits 0");

  buf = ""; err = "";
  code = runCli(["--version"], { write: w, errWrite: we });
  assert(code === 0 && /promote\.mjs \d+\.\d+\.\d+/.test(buf), "--version prints semver");

  buf = ""; err = "";
  code = runCli([], { write: w, errWrite: we });
  assert(code === 3 && err.includes("missing required arg"), "no args -> exit 3 usage");

  buf = ""; err = "";
  code = runCli(["--receipt", "/nope/does/not/exist", "--bakeoff", winBakeoff, "--status", "OK", "--risk", "low"], { write: w, errWrite: we });
  assert(code === 1, "missing receipt file -> exit 1 hold");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", malformed, "--status", "OK", "--risk", "low"], { write: w, errWrite: we });
  assert(code === 1, "malformed bakeoff -> exit 1 hold");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", winBakeoff, "--status", "ORANGE5_GREEN", "--risk", "low"], { write: w, errWrite: we });
  assert(code === 0, "happy-path low risk -> exit 0 promote");
  assert(buf.includes("PROMOTE"), "banner says PROMOTE");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", failBakeoff, "--status", "OK", "--risk", "low"], { write: w, errWrite: we });
  assert(code === 2, "failing bakeoff -> exit 2 reject");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", winBakeoff, "--status", "OK", "--risk", "production"], { write: w, errWrite: we });
  assert(code === 1, "production without approval -> exit 1 hold");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", winBakeoff, "--status", "OK", "--risk", "production", "--operator-approved"], { write: w, errWrite: we });
  assert(code === 0, "production WITH approval -> exit 0 promote");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", winBakeoff, "--status", "looks_ok to me", "--risk", "low"], { write: w, errWrite: we });
  assert(code === 2, "fake-green status -> exit 2 reject");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", winBakeoff, "--status", "OK", "--risk", "low", "--json"], { write: w, errWrite: we });
  assert(code === 0, "--json happy path still exits 0");
  let parsed;
  try { parsed = JSON.parse(buf); } catch { parsed = null; }
  assert(parsed && parsed.verdict === "promote", "--json emits valid JSON with verdict");
  assert(parsed && parsed.bakeoff_score && parsed.bakeoff_score.wins === 4, "JSON includes bakeoff score");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", losingDimWinResult, "--status", "OK", "--risk", "low"], { write: w, errWrite: we });
  assert(code === 2, "explicit win flag does NOT override losing per-dim score");

  buf = ""; err = "";
  code = runCli(["--receipt", receiptPath, "--bakeoff", flatWinBakeoff, "--status", "OK", "--risk", "low"], { write: w, errWrite: we });
  assert(code === 1, "flat win (no dims) -> hold (can't confirm 4-of-5)");

  buf = ""; err = "";
  code = runCli(["--mystery"], { write: w, errWrite: we });
  assert(code === 3 && err.includes("unknown argument"), "unknown arg -> exit 3 usage");

  console.log(`\n[promote-cli-tests] ${pass} passed / ${fail} failed`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const f of failures) console.log(`  - ${f}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

process.exit(fail > 0 ? 1 : 0);
