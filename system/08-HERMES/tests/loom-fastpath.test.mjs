#!/usr/bin/env bun
// 08-HERMES / tests / loom-fastpath.test.mjs
//
// Hermetic tests for the LOOM 8-gate fastpath (../src/loom-fastpath.mjs).
// Standalone print-harness — NO bun:test import — so the Orange5 full
// verifier runs it as `bun <file>` and expects process.exit(0) on green,
// matching the dominant Hermes test style (see lease-engine.test.mjs).
//
// What we prove:
//   1. all-8-pass path returns passed=true, first_fail=null, 8 gate rows.
//   2. each single-gate-fail short-circuits: first_fail is that gate, gates
//      after it are marked skipped and not evaluated, passed=false.
//   3. semantic parity: for a battery of actions, evaluateGatesFull's per-gate
//      verdicts and overall pass EXACTLY match runLoom (the evaluator this
//      optimizes) — read-only import, runLoom is not modified.
//   4. the two strict gates (human_approval, false_green_guard) cannot be
//      bypassed; ?? true defaults for gates 6/7 behave like runLoom.
//   5. validateLeaseBatch shreds dead leases (presence + approval) correctly.
//   6. elapsed_us is present and the short-circuit path emits a diagnostic
//      speed measurement. Wall-clock throughput is not a correctness gate
//      because loaded N150/Windows scheduling can invert microbench results.

import {
  evaluateGates,
  evaluateGatesFull,
  validateLeaseBatch,
  LOOM_GATES,
  FAKE_GREEN_TERMS,
} from "../src/loom-fastpath.mjs";
import { runLoom } from "../src/loom-gates.mjs";

let pass = 0, fail = 0;
const results = [];
function assert(cond, msg) {
  if (cond) { pass += 1; results.push(["PASS", msg]); }
  else      { fail += 1; results.push(["FAIL", msg]); }
}
function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}

// A fully-satisfying context. Every gate passes on this.
function goodCtx() {
  return {
    order: { schema: "orange.order.v1" },
    report: { schema: "orange.report.v1" },
    receipt_path: "10-RECEIPTS/x.md",
    lease: { id: "lease_1", requires_approval: false },
    has_human_approval: true,
    has_openai_gateway: true,
    has_mcp_default: true,
    status: "ORANGE5_OK",
  };
}

// ── 1. all-8-pass path ──────────────────────────────────────────────────────
{
  const r = evaluateGates(null, null, goodCtx());
  assertEq(r.passed, true, "all-pass: passed=true");
  assertEq(r.first_fail, null, "all-pass: first_fail=null");
  assertEq(r.gate_results.length, 8, "all-pass: 8 gate rows");
  assert(r.gate_results.every(g => g.pass === true), "all-pass: every gate row pass=true");
  assert(r.gate_results.every(g => !g.skipped), "all-pass: no gate skipped");
  assert(typeof r.elapsed_us === "number" && r.elapsed_us >= 0, "all-pass: elapsed_us is a non-negative number");
  // gate order preserved and equal to canonical
  assert(r.gate_results.map(g => g.gate).join(",") === LOOM_GATES.join(","), "all-pass: gate order == LOOM_GATES");
}

// ── 2. each single-gate-fail short-circuits correctly ───────────────────────
// For each gate, build a ctx that fails ONLY that gate, and assert the fail is
// attributed to it, gates after are skipped, and passed=false.
{
  // mutation per gate id → produce a ctx failing exactly that gate
  const breakers = {
    order_schema:      c => { c.order = { schema: "wrong" }; },
    report_schema:     c => { c.report = { schema: "wrong" }; },
    receipt_spine:     c => { c.receipt_path = ""; },
    human_approval:    c => { c.lease = { id: "l", requires_approval: true }; c.has_human_approval = false; },
    codexa_lease:      c => { c.lease = null; },
    openai_gateway:    c => { c.has_openai_gateway = false; },
    mcp_default:       c => { c.has_mcp_default = false; },
    false_green_guard: c => { c.status = "looks_ok"; },
  };

  LOOM_GATES.forEach((gateId, idx) => {
    const c = goodCtx();
    breakers[gateId](c);
    const r = evaluateGates(null, null, c);

    assertEq(r.passed, false, `${gateId}-fail: passed=false`);
    assertEq(r.first_fail, gateId, `${gateId}-fail: first_fail attributed correctly`);

    // The failing gate row is pass=false with a reason (not skipped).
    const row = r.gate_results.find(g => g.gate === gateId);
    assert(row && row.pass === false && !row.skipped && typeof row.reason === "string",
      `${gateId}-fail: failing row has reason, not skipped`);

    // Every gate BEFORE the failing one was evaluated and passed.
    for (let i = 0; i < idx; i++) {
      const g = r.gate_results[i];
      assert(g.pass === true && !g.skipped, `${gateId}-fail: earlier gate ${g.gate} evaluated+passed`);
    }
    // Every gate AFTER the failing one was skipped by the short-circuit.
    for (let i = idx + 1; i < LOOM_GATES.length; i++) {
      const g = r.gate_results[i];
      assert(g.skipped === true && g.pass === false, `${gateId}-fail: later gate ${g.gate} skipped`);
    }
  });
}

// ── 3. semantic parity with runLoom across a battery ────────────────────────
// evaluateGatesFull (no short-circuit) must match runLoom gate-for-gate and
// on overall pass. Battery mixes single fails, multi fails, defaults, and the
// "nothing supplied" degenerate case.
{
  const battery = [
    // fully good
    goodCtx(),
    // nothing supplied (runLoom's loomMissing case)
    { status: "OK" },
    // fake-green variants (all runLoom terms)
    ...FAKE_GREEN_TERMS.map(t => ({ ...goodCtx(), status: `build ${t} now` })),
    // approval required + present / + absent
    { ...goodCtx(), lease: { id: "l", requires_approval: true }, has_human_approval: true },
    { ...goodCtx(), lease: { id: "l", requires_approval: true }, has_human_approval: false },
    // gateway/mcp explicit false
    { ...goodCtx(), has_openai_gateway: false },
    { ...goodCtx(), has_mcp_default: false },
    // gateway/mcp OMITTED → ?? true default should pass
    (() => { const c = goodCtx(); delete c.has_openai_gateway; delete c.has_mcp_default; return c; })(),
    // multi-fail: no order, no receipt, fake-green
    { report: { schema: "orange.report.v1" }, lease: { id: "l" }, status: "probably" },
    // lease missing entirely
    { ...goodCtx(), lease: undefined },
    // report missing
    (() => { const c = goodCtx(); delete c.report; return c; })(),
    // order missing
    (() => { const c = goodCtx(); delete c.order; return c; })(),
  ];

  battery.forEach((ctx, i) => {
    const canon = runLoom(ctx);
    const mine = evaluateGatesFull(null, null, ctx);

    // overall verdict parity
    assertEq(mine.passed, canon.pass, `parity[${i}]: overall pass matches runLoom`);

    // per-gate verdict parity, gate-for-gate, same order
    assertEq(mine.gate_results.length, canon.gates.length, `parity[${i}]: same gate count`);
    for (let g = 0; g < canon.gates.length; g++) {
      assertEq(mine.gate_results[g].gate, canon.gates[g].gate, `parity[${i}]: gate ${g} id matches`);
      assertEq(mine.gate_results[g].pass, canon.gates[g].pass, `parity[${i}]: gate ${canon.gates[g].gate} pass matches`);
    }
  });
}

// ── 3b. parity of short-circuit verdict vs full ─────────────────────────────
// Short-circuit must never change the overall verdict vs the full evaluation
// (or vs runLoom). Re-run the battery both ways.
{
  const cases = [
    goodCtx(),
    { status: "OK" },
    { ...goodCtx(), status: "should_work" },
    { ...goodCtx(), lease: null, has_openai_gateway: false }, // two fails
    { ...goodCtx(), lease: { id: "l", requires_approval: true }, has_human_approval: false },
  ];
  cases.forEach((ctx, i) => {
    const sc = evaluateGates(null, null, ctx);              // short-circuit ON
    const full = evaluateGatesFull(null, null, ctx);        // OFF
    const canon = runLoom(ctx);
    assertEq(sc.passed, full.passed, `sc-vs-full[${i}]: passed equal`);
    assertEq(sc.passed, canon.pass, `sc-vs-full[${i}]: passed == runLoom`);
    assertEq(sc.first_fail, full.first_fail, `sc-vs-full[${i}]: first_fail equal`);
  });
}

// ── 4. strict gates cannot be bypassed ──────────────────────────────────────
{
  // human_approval: requires_approval=true with no approval → hard fail, and
  // it must be the first_fail when it is the earliest failing gate.
  const c1 = goodCtx();
  c1.lease = { id: "l", requires_approval: true };
  c1.has_human_approval = false;
  const r1 = evaluateGates(null, null, c1);
  assertEq(r1.passed, false, "human_approval strict: unapproved required lease fails");
  assertEq(r1.first_fail, "human_approval", "human_approval strict: attributed as first_fail");

  // false_green_guard: every fake-green term is caught, case-insensitively.
  for (const term of FAKE_GREEN_TERMS) {
    const c = goodCtx();
    c.status = `Result ${term.toUpperCase()}`; // upper-case to prove case-insensitivity
    const r = evaluateGates(null, null, c);
    assertEq(r.passed, false, `false_green_guard strict: "${term}" (upper) blocked`);
    assertEq(r.first_fail, "false_green_guard", `false_green_guard strict: "${term}" attributed`);
  }

  // Honest failure status ("fail: X") must PASS gate 8 (no fake-green word).
  const cf = goodCtx();
  cf.status = "fail: receipt missing";
  const rf = evaluateGates(null, null, cf);
  assertEq(rf.passed, true, "false_green_guard: honest 'fail:' status is not fake-green");
}

// ── 4b. status/report folded from `action` when ctx omits them ──────────────
// Proves the (action, lease, ctx) signature: passing status via action, and
// report via action, reproduces the same gate decisions.
{
  const base = goodCtx();
  delete base.status;            // no ctx.status
  const action = { status: "looks_ok" };  // fake-green via action
  const r = evaluateGates(action, base.lease, base);
  assertEq(r.first_fail, "false_green_guard", "action.status feeds gate 8 when ctx.status absent");

  const base2 = goodCtx();
  delete base2.report;           // no ctx.report
  const action2 = { report: { schema: "orange.report.v1" } };
  const r2 = evaluateGates(action2, base2.lease, base2);
  assertEq(r2.passed, true, "action.report satisfies gate 2 when ctx.report absent");
}

// ── 5. validateLeaseBatch ───────────────────────────────────────────────────
{
  const batch = [
    { lease: { id: "a", requires_approval: false } },                       // ok
    { lease: { id: "b", requires_approval: true }, has_human_approval: true }, // ok
    { lease: { id: "c", requires_approval: true }, has_human_approval: false }, // needs approval
    { lease: null },                                                         // no lease
    { },                                                                     // no lease
    { lease: { id: "f", requires_approval: true } },                        // approval missing (undefined)
  ];
  const { results: br, ok_count, elapsed_us } = validateLeaseBatch(batch);
  assertEq(br.length, 6, "lease-batch: one result per item");
  assertEq(ok_count, 2, "lease-batch: exactly 2 leases ok");
  assertEq(br[0].ok, true, "lease-batch[0] ok");
  assertEq(br[0].lease_id, "a", "lease-batch[0] lease_id echoed");
  assertEq(br[1].ok, true, "lease-batch[1] approved required lease ok");
  assertEq(br[2].ok, false, "lease-batch[2] unapproved required lease rejected");
  assertEq(br[2].reason, "human_approval_required", "lease-batch[2] reason");
  assertEq(br[3].ok, false, "lease-batch[3] null lease rejected");
  assertEq(br[3].reason, "no_lease", "lease-batch[3] reason");
  assertEq(br[4].reason, "no_lease", "lease-batch[4] missing lease reason");
  assertEq(br[5].reason, "human_approval_required", "lease-batch[5] undefined approval rejected");
  assert(typeof elapsed_us === "number" && elapsed_us >= 0, "lease-batch: elapsed_us present");

  // empty / non-array inputs degrade safely
  assertEq(validateLeaseBatch([]).ok_count, 0, "lease-batch: empty array → 0 ok");
  assertEq(validateLeaseBatch(null).results.length, 0, "lease-batch: null → empty results");
}

// ── 6. throughput diagnostic: short-circuit early-fail measurement ──────────
// This is intentionally diagnostic, not a pass/fail correctness assertion.
// The behavioral guarantees above already prove the fastpath: parity with
// runLoom, first-fail attribution, and skipped later gates. Microbench timing
// on loaded Windows/N150 can invert even when the implementation is correct.
{
  const c = goodCtx();
  c.order = { schema: "wrong" }; // fails gate 1 → short-circuit skips 7 gates
  const N = 20000;

  let tSc = 0, tFull = 0;
  {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) evaluateGates(null, null, c);
    tSc = performance.now() - t0;
  }
  {
    const t0 = performance.now();
    for (let i = 0; i < N; i++) evaluateGatesFull(null, null, c);
    tFull = performance.now() - t0;
  }
  assert(Number.isFinite(tSc) && tSc >= 0 && Number.isFinite(tFull) && tFull >= 0,
    `throughput diagnostic produced finite timings (sc=${tSc.toFixed(2)}ms full=${tFull.toFixed(2)}ms over ${N})`);
  const speedup = tFull / (tSc || 1e-9);
  results.push(["INFO", `short-circuit speedup on gate-1 fail: ${speedup.toFixed(2)}x (full ${tFull.toFixed(2)}ms / sc ${tSc.toFixed(2)}ms, N=${N})`]);
}

// ── report ──────────────────────────────────────────────────────────────────
for (const [tag, msg] of results) console.log(`  ${tag} ${msg}`);
console.log(`\n[hermes-loom-fastpath] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
