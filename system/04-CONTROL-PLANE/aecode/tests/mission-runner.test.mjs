#!/usr/bin/env node
// AECode mission-runner tests — drives the runner with an injected Hermes
// and an injected gauntlet adapter, in a temp working dir + temp receipt dir.
// No network, no real filesystem outside os.tmpdir().

import { compileSource } from "../compiler.mjs";
import {
  runMission, stepOnce, initialState,
  applyPatch, runGauntlet, mintReceipt, writeReceipt,
  verifyReceiptChain, checkScope,
  MISSION_STATUS, STEP_STATUS, RunnerError, __internal,
} from "../mission-runner.mjs";

import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";

let pass = 0, fail = 0;
const assert = (c, m) => c
  ? (pass++, console.log(`  PASS ${m}`))
  : (fail++, console.log(`  FAIL ${m}`));

process.env.AECODE_DETERMINISTIC_IDS = "1";

// ─── fixtures ───────────────────────────────────────────────────────────────

function aecodeFixture() {
  return {
    identity: { id: "orange5.runner", project: "Orange5", name: "Runner Test" },
    product_intent: "test the mission runner end-to-end",
    operator_laws: ["receipts only", "no theater"],
    scope: {
      summary: "patch under sandbox/",
      allowed_paths: ["sandbox/"],
      forbidden_paths: ["10-RECEIPTS/", ".git/"],
      risk: "low",
    },
    target_matrix: { targets: [{ lang: "javascript", runtime: "node>=20" }] },
    artifact_contracts: [{ name: "sandbox/hello.txt", target: "all" }],
    data_contracts: [{ name: "noop", target: "all" }],
    behavior_graph: {
      nodes: [
        { id: "create_hello", kind: "create", files: ["sandbox/hello.txt"] },
        { id: "amend_hello",  kind: "edit",   files: ["sandbox/hello.txt"] },
      ],
      edges: [{ from: "create_hello", to: "amend_hello" }],
    },
    permissions: { allow_read: true, allow_write: true, require_human_approval: false },
    model_roles: { lane: "subscription_cli", default_adapter: "mock-local-deterministic" },
    gauntlets: [{
      id: "smoke",
      gates: [
        { id: "file_exists", name: "file_exists", kind: "deterministic", blocking: true },
      ],
    }],
    receipts: { required: true, emit_on: ["compile", "patch", "gauntlet", "promote"], writer: "test" },
    rollback: { strategy: "git_reset_hard", checkpoint: "pre", verify: "smoke",
      triggers: ["gauntlet_fail", "scope_violation"] },
  };
}

function makeHermes(plan) {
  // plan is keyed by step.node → response
  return {
    async action(payload) {
      const node = payload.step?.node;
      const resp = plan[node] || plan.__default;
      if (!resp) {
        return { ok: true, action: { kind: "noop" }, proof: { model: "mock" } };
      }
      if (typeof resp === "function") return resp(payload);
      return resp;
    },
  };
}

function passingGauntlet() {
  return {
    async evaluateGate(step, ctx) {
      return { pass: true, evidence: [{ note: `gate ${step.gate_id} forced pass` }] };
    },
  };
}

function failingGauntlet(failingGateId) {
  return {
    async evaluateGate(step, ctx) {
      if (step.gate_id === failingGateId) return { pass: false, reason: "forced_fail" };
      return { pass: true };
    },
  };
}

// ─── 1. checkScope ──────────────────────────────────────────────────────────
console.log("\n[checkScope]");
{
  const mission = { allowed_paths: ["sandbox/"], forbidden_paths: ["10-RECEIPTS/"] };
  assert(checkScope("sandbox/hello.txt", mission).ok, "path inside allowed scope");
  assert(!checkScope("../etc/passwd", mission).ok, "parent traversal blocked");
  assert(!checkScope("10-RECEIPTS/x.json", mission).ok, "path in forbidden list blocked");
  assert(!checkScope("other/x", mission).ok, "path outside any allow blocked");
  assert(!checkScope("sandbox/inner", { allowed_paths: [], forbidden_paths: [] }).ok,
    "empty allow list blocks everything");
}

// ─── 2. canonical + sha256 (internal) ───────────────────────────────────────
console.log("\n[canonical/hash]");
{
  const a = __internal.canonical({ b: 1, a: 2 });
  const b = __internal.canonical({ a: 2, b: 1 });
  assert(a === b, "canonical JSON is key-order independent");
  assert(__internal.sha256("x").length === 64, "sha256 returns 64 hex");
}

// ─── 3. applyPatch ──────────────────────────────────────────────────────────
console.log("\n[applyPatch]");
{
  const work = mkdtempSync(join(tmpdir(), "ae-runner-work-"));
  const mission = { allowed_paths: ["sandbox/"], forbidden_paths: [] };
  const out = applyPatch({ kind: "patch", files: [
    { path: "sandbox/hello.txt", op: "create", content: "hi" },
  ]}, mission, { workingDir: work });
  assert(out.ok && out.changed.length === 1, "create writes one file");
  assert(existsSync(join(work, "sandbox", "hello.txt")), "file landed on disk");

  const bad = applyPatch({ kind: "patch", files: [
    { path: "etc/passwd", op: "create", content: "root" },
  ]}, mission, { workingDir: work });
  assert(!bad.ok && /allowed|scope/.test(bad.reason), "out-of-scope write refused");

  const malformed = applyPatch({ kind: "patch", files: [{ path: "sandbox/x", op: "edit" }]},
    mission, { workingDir: work });
  assert(!malformed.ok && malformed.reason.includes("string_content"),
    "edit without content refused");

  const noop = applyPatch({ kind: "noop" }, mission);
  assert(noop.ok && noop.noop, "noop applied cleanly");

  const abort = applyPatch({ kind: "abort", reason: "hermes_said_so" }, mission);
  assert(!abort.ok && abort.abort, "abort surfaces abort flag");
}

// ─── 4. runGauntlet ─────────────────────────────────────────────────────────
console.log("\n[runGauntlet]");
{
  const gates = [
    { gate_id: "g1", name: "g1", blocking: true },
    { gate_id: "g2", name: "g2", blocking: true },
  ];
  const r1 = await runGauntlet(gates, {}, passingGauntlet());
  assert(r1.ok && r1.gates.length === 2, "all gates pass → ok");
  const r2 = await runGauntlet(gates, {}, failingGauntlet("g2"));
  assert(!r2.ok, "one failing blocking gate → not ok");
  assert(r2.gates[1].pass === false, "failing gate reported");
}

// ─── 5. mintReceipt + verifyReceiptChain ────────────────────────────────────
console.log("\n[receipt-chain]");
{
  const dir = mkdtempSync(join(tmpdir(), "ae-runner-rcpt-"));
  const mission = { mission_id: "m1", rollback_plan: { strategy: "git_reset_hard" },
    receipt_plan: { writer: "test" } };
  const r1 = mintReceipt({
    mission, step: { step_id: "s1", node: "n", kind: "edit" },
    action_outcome: { ok: true, changed: [] }, gauntlet_result: null,
    prior_receipt: null, hash_chain: 1, status: "ok", confidence: 1,
  });
  const r2 = mintReceipt({
    mission, step: { step_id: "s2", node: "n", kind: "edit" },
    action_outcome: { ok: true, changed: [] }, gauntlet_result: null,
    prior_receipt: r1.chain_hash, hash_chain: 2, status: "ok", confidence: 1,
  });
  const p1 = writeReceipt(r1, dir);
  const p2 = writeReceipt(r2, dir);
  const v = verifyReceiptChain([p1, p2]);
  assert(v.ok && v.length === 2, "chain of 2 receipts verifies");
}

// ─── 6. runMission — happy path ─────────────────────────────────────────────
console.log("\n[runMission/happy]");
{
  const work = mkdtempSync(join(tmpdir(), "ae-runner-work-"));
  const rdir = mkdtempSync(join(tmpdir(), "ae-runner-rcpt-"));
  const bundle = compileSource(aecodeFixture());

  const hermes = makeHermes({
    create_hello: { ok: true, action: { kind: "patch", files: [
      { path: "sandbox/hello.txt", op: "create", content: "hello" },
    ]}, proof: { model: "mock", latency_ms: 1 } },
    amend_hello: { ok: true, action: { kind: "patch", files: [
      { path: "sandbox/hello.txt", op: "edit", content: "hello world" },
    ]}, proof: { model: "mock", latency_ms: 1 } },
    __default: { ok: true, action: { kind: "noop" }, proof: { model: "mock" } },
  });

  const result = await runMission(bundle, {
    hermes, gauntlet: passingGauntlet(),
    workingDir: work, receiptDir: rdir,
  });
  assert(result.status === MISSION_STATUS.DONE, "mission reaches DONE");
  assert(result.receipts.length >= 3, "≥3 receipts emitted (per step + final gauntlet)");
  const v = verifyReceiptChain(result.receipts);
  assert(v.ok, "receipt chain verifies end-to-end");
  assert(readFileSync(join(work, "sandbox", "hello.txt"), "utf8") === "hello world",
    "final file content reflects last patch");
}

// ─── 7. runMission — scope violation blocks ─────────────────────────────────
console.log("\n[runMission/scope-violation]");
{
  const work = mkdtempSync(join(tmpdir(), "ae-runner-work-"));
  const rdir = mkdtempSync(join(tmpdir(), "ae-runner-rcpt-"));
  const bundle = compileSource(aecodeFixture());
  const hermes = makeHermes({
    create_hello: { ok: true, action: { kind: "patch", files: [
      { path: "etc/passwd", op: "create", content: "root:x:0:0" },
    ]}, proof: { model: "evil" } },
  });
  const result = await runMission(bundle, {
    hermes, gauntlet: passingGauntlet(),
    workingDir: work, receiptDir: rdir, maxSteps: 5,
  });
  assert(result.status === MISSION_STATUS.ROLLED_BACK || result.status === MISSION_STATUS.BLOCKED,
    "out-of-scope patch lands in BLOCKED or ROLLED_BACK");
  assert(result.blockers.some(b => b.code === STEP_STATUS.SCOPE_VIOLATION),
    "blocker names scope_violation");
  assert(!existsSync(join(work, "etc", "passwd")), "no out-of-scope file written");
}

// ─── 8. runMission — gauntlet failure → rollback ───────────────────────────
console.log("\n[runMission/gauntlet-fail]");
{
  const work = mkdtempSync(join(tmpdir(), "ae-runner-work-"));
  const rdir = mkdtempSync(join(tmpdir(), "ae-runner-rcpt-"));
  const bundle = compileSource(aecodeFixture());
  const hermes = makeHermes({
    __default: { ok: true, action: { kind: "patch", files: [
      { path: "sandbox/hello.txt", op: "create", content: "hi" },
    ]}, proof: {} },
  });
  let rollbackCalled = false;
  const result = await runMission(bundle, {
    hermes,
    gauntlet: failingGauntlet("file_exists"),
    workingDir: work, receiptDir: rdir,
    rollbackAdapter: {
      async execute(plan, state) {
        rollbackCalled = true;
        return { ok: true, note: "rollback executed" };
      },
    },
  });
  assert(result.status === MISSION_STATUS.ROLLED_BACK, "gauntlet fail → ROLLED_BACK");
  assert(rollbackCalled, "rollback adapter was invoked");
  assert(result.blockers.some(b => b.code === "gauntlet_fail"),
    "blocker names gauntlet_fail");
}

// ─── 9. runMission — Hermes unreachable ─────────────────────────────────────
console.log("\n[runMission/hermes-fail]");
{
  const work = mkdtempSync(join(tmpdir(), "ae-runner-work-"));
  const rdir = mkdtempSync(join(tmpdir(), "ae-runner-rcpt-"));
  const bundle = compileSource(aecodeFixture());
  const hermes = { async action() { throw new RunnerError("boom", { code: "hermes_unreachable" }); } };
  const result = await runMission(bundle, {
    hermes, gauntlet: passingGauntlet(),
    workingDir: work, receiptDir: rdir,
  });
  assert(result.status === MISSION_STATUS.BLOCKED, "Hermes failure → BLOCKED");
  assert(result.blockers.some(b => b.code === "hermes_fail"),
    "blocker names hermes_fail");
}

// ─── 10. stepOnce idempotency on terminal states ────────────────────────────
console.log("\n[stepOnce/terminal]");
{
  const bundle = compileSource(aecodeFixture());
  const state = initialState(bundle, {});
  state.status = MISSION_STATUS.DONE;
  const r = await stepOnce(state, {});
  assert(r.terminal === true && r.receipt === null,
    "stepOnce on terminal state is a no-op");
}

// ─── summary ────────────────────────────────────────────────────────────────
console.log(`\n[aecode-mission-runner-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
