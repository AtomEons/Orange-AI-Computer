#!/usr/bin/env node
// Tests for 08-HERMES/audit-tracer.mjs
//
// Real fs (uses an injected writer to keep tests hermetic and avoid touching
// /mnt/ae_flux). Real sha256, real lease + policy assertion, real exceptions.

import {
  AuditTracerError,
  ERROR_CODES,
  RECEIPT_SCHEMA,
  RECEIPT_KIND,
  RECEIPT_ORIGIN,
  TRACER_META,
  canonicalJSON,
  hashPayload,
  assertLeaseCovers,
  buildReceiptBody,
  writeReceipt,
  traceMcpCall,
  wrapDispatch,
} from "../audit-tracer.mjs";

import { classifyToolCall } from "../policy/mcp-tool-policy.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else      { fail++; console.log(`  FAIL ${msg}`); }
}
function eq(a, b, msg) { assert(a === b, `${msg} (got=${JSON.stringify(a)} want=${JSON.stringify(b)})`); }

async function rejects(fn, code, msg) {
  try {
    await fn();
    fail++; console.log(`  FAIL ${msg} (expected throw with code=${code}, got resolve)`);
  } catch (err) {
    if (err instanceof AuditTracerError && err.code === code) {
      pass++; console.log(`  PASS ${msg}`);
    } else {
      fail++; console.log(`  FAIL ${msg} (got ${err?.name}/${err?.code}: ${err?.message})`);
    }
  }
}

// ── helpers ─────────────────────────────────────────────────────────────────

function makeMockWriter() {
  const records = [];
  return {
    records,
    fn: async ({ origin, event, fluxRoot }) => {
      // Mimic the Cobra writer return shape closely enough for the tracer.
      const ts = Date.now();
      const sha = "sha256:" + Math.random().toString(36).slice(2);
      const record = {
        ts,
        sha256: sha,
        prior_sha256: records.length === 0 ? "GENESIS" : records[records.length - 1].sha256,
        origin,
        lane: "reality",
        event,
        fluxRoot: fluxRoot || null,
      };
      records.push(record);
      return record;
    },
  };
}

function goodLease(overrides = {}) {
  return {
    id: "lease_test_1",
    actor: "test_actor",
    allowed: ["cd.navigate_page", "browser.click", "desktop.left_click", "cd.click"],
    forbidden: ["browser_run_code_unsafe"],
    targetProject: "orange5",
    riskLevel: "medium",
    expires_at: Date.now() + 60_000,
    requires_approval: false,
    ...overrides,
  };
}

// ── 1. canonicalJSON + hashing ──────────────────────────────────────────────

console.log("\n[canonicalJSON]");
eq(canonicalJSON({ b: 1, a: 2 }), '{"a":2,"b":1}', "sorts keys");
eq(canonicalJSON([3, "x", null, true]), '[3,"x",null,true]', "arrays preserved");
eq(canonicalJSON({ a: undefined, b: 1 }), '{"b":1}', "drops undefined");
try {
  canonicalJSON(NaN);
  fail++; console.log("  FAIL rejects NaN");
} catch (e) {
  assert(e instanceof AuditTracerError && e.code === ERROR_CODES.CANONICALIZE_FAILED, "rejects NaN");
}
try {
  canonicalJSON(1n);
  fail++; console.log("  FAIL rejects bigint");
} catch (e) {
  assert(e instanceof AuditTracerError && e.code === ERROR_CODES.CANONICALIZE_FAILED, "rejects bigint");
}

console.log("\n[hashPayload]");
const h1 = hashPayload({ a: 1, b: 2 });
const h2 = hashPayload({ b: 2, a: 1 });
eq(h1, h2, "key order doesn't affect hash");
assert(/^sha256:[0-9a-f]{64}$/.test(h1), "hashPayload format is sha256:<64hex>");
const h3 = hashPayload({ a: 1, b: 3 });
assert(h1 !== h3, "different payloads produce different hashes");

// ── 2. assertLeaseCovers ────────────────────────────────────────────────────

console.log("\n[assertLeaseCovers]");
{
  const cls = classifyToolCall("mcp__chrome-devtools__navigate_page");
  const { verbKey } = assertLeaseCovers(goodLease(), cls);
  eq(verbKey, "cd.navigate_page", "navigate_page → cd.navigate_page");
}
try {
  assertLeaseCovers(null, classifyToolCall("mcp__chrome-devtools__navigate_page"));
  fail++; console.log("  FAIL missing lease");
} catch (e) {
  assert(e instanceof AuditTracerError && e.code === ERROR_CODES.LEASE_MISSING, "rejects missing lease");
}
try {
  assertLeaseCovers({ id: "x" }, classifyToolCall("mcp__chrome-devtools__navigate_page"));
  fail++; console.log("  FAIL malformed lease");
} catch (e) {
  assert(e.code === ERROR_CODES.LEASE_MALFORMED, "rejects malformed lease (no allowed[])");
}
try {
  assertLeaseCovers(
    goodLease({ expires_at: Date.now() - 1000 }),
    classifyToolCall("mcp__chrome-devtools__navigate_page"),
  );
  fail++; console.log("  FAIL expired");
} catch (e) {
  assert(e.code === ERROR_CODES.LEASE_EXPIRED, "rejects expired lease");
}
try {
  // policy fail-closed via an unknown server::tool combo
  assertLeaseCovers(goodLease(), classifyToolCall("mcp__nonexistent__zzz_tool"));
  fail++; console.log("  FAIL unknown tool");
} catch (e) {
  assert(e.code === ERROR_CODES.POLICY_UNKNOWN_TOOL, "rejects unknown tool (fail-closed)");
}
try {
  // computer-use.write_clipboard is medium — bump lease to read_only to fail
  assertLeaseCovers(
    goodLease({ riskLevel: "read_only", allowed: ["desktop.write_clipboard"] }),
    classifyToolCall("mcp__computer-use__write_clipboard"),
  );
  fail++; console.log("  FAIL risk overflow");
} catch (e) {
  assert(e.code === ERROR_CODES.RISK_EXCEEDS_LEASE, "rejects when risk exceeds lease");
}
try {
  assertLeaseCovers(
    goodLease({ allowed: ["something.else"] }),
    classifyToolCall("mcp__chrome-devtools__navigate_page"),
  );
  fail++; console.log("  FAIL not allowed");
} catch (e) {
  assert(e.code === ERROR_CODES.VERB_NOT_ALLOWED, "rejects verb not in allowed[]");
}
try {
  assertLeaseCovers(
    goodLease({ allowed: ["cd.navigate_page"], forbidden: ["cd.navigate_page"] }),
    classifyToolCall("mcp__chrome-devtools__navigate_page"),
  );
  fail++; console.log("  FAIL forbidden wins");
} catch (e) {
  assert(e.code === ERROR_CODES.VERB_FORBIDDEN, "forbidden[] beats allowed[]");
}
{
  // requires_approval — chrome-devtools.evaluate_script is high
  const cls = classifyToolCall("mcp__chrome-devtools__evaluate_script");
  assert(cls.requires_approval === true, "evaluate_script.requires_approval === true");
  try {
    assertLeaseCovers(
      goodLease({ allowed: ["cd.evaluate_script"], riskLevel: "high" }),
      cls,
      { operatorApproved: false },
    );
    fail++; console.log("  FAIL approval required");
  } catch (e) {
    assert(e.code === ERROR_CODES.APPROVAL_REQUIRED, "rejects when approval required and absent");
  }
  // operator approved → OK
  const { verbKey } = assertLeaseCovers(
    goodLease({ allowed: ["cd.evaluate_script"], riskLevel: "high" }),
    cls,
    { operatorApproved: true },
  );
  eq(verbKey, "cd.evaluate_script", "passes when operatorApproved=true");
}

// ── 3. buildReceiptBody ─────────────────────────────────────────────────────

console.log("\n[buildReceiptBody]");
{
  const cls = classifyToolCall("mcp__chrome-devtools__navigate_page");
  const body = buildReceiptBody({
    leaseId: "lease_42",
    classification: cls,
    args: { url: "https://example.com" },
    result: { ok: true, page_id: "p1" },
    outcome: "ok",
    refusal: null,
    elapsedMs: 12.5,
    actor: "frontier",
    targetProject: "orange5",
    adapterId: "hermes.adapter.chrome-devtools.v1",
  });
  eq(body.schema, RECEIPT_SCHEMA, "schema set");
  eq(body.lease_id, "lease_42", "lease_id set");
  eq(body.mcp_server, "chrome-devtools", "mcp_server set");
  eq(body.mcp_tool, "navigate_page", "mcp_tool set");
  eq(body.verb, "cd.navigate_page", "verb set");
  eq(body.risk_level, "medium", "risk_level captured");
  assert(/^sha256:[0-9a-f]{64}$/.test(body.args_hash), "args_hash format");
  assert(/^sha256:[0-9a-f]{64}$/.test(body.result_hash), "result_hash format on ok");
  eq(body.outcome, "ok", "outcome ok");
  eq(body.refusal, null, "no refusal on ok");
  eq(body.elapsed_ms, 12.5, "elapsed_ms preserved");
  eq(body.actor, "frontier", "actor set");
}
{
  // refused → no result_hash
  const cls = classifyToolCall("mcp__chrome-devtools__navigate_page");
  const body = buildReceiptBody({
    leaseId: "lease_42",
    classification: cls,
    args: { url: "x" },
    result: undefined,
    outcome: "refused",
    refusal: "verb_not_in_lease_allowlist",
    elapsedMs: 1,
    adapterId: "hermes.adapter.chrome-devtools.v1",
  });
  eq(body.result_hash, null, "result_hash null on refused");
  eq(body.refusal, "verb_not_in_lease_allowlist", "refusal recorded");
  eq(body.outcome, "refused", "outcome refused");
}

// ── 4. writeReceipt (with injected writer) ──────────────────────────────────

console.log("\n[writeReceipt]");
{
  const mw = makeMockWriter();
  const cls = classifyToolCall("mcp__chrome-devtools__navigate_page");
  const body = buildReceiptBody({
    leaseId: "lease_x",
    classification: cls,
    args: { url: "https://example.com" },
    result: { ok: true },
    outcome: "ok",
    refusal: null,
    elapsedMs: 5,
    adapterId: "hermes.adapter.chrome-devtools.v1",
  });
  const { record, receipt } = await writeReceipt(body, { writer: mw.fn });
  eq(mw.records.length, 1, "writer was called once");
  eq(record.origin, "hermes_mcp", "envelope origin is hermes_mcp");
  eq(record.lane, "reality", "lane is reality");
  eq(receipt.kind, RECEIPT_KIND, "event.kind === receipt");
  eq(receipt.origin, RECEIPT_ORIGIN, "event.origin === hermes_mcp");
  eq(receipt.body.lease_id, "lease_x", "body.lease_id propagated");
  eq(receipt.body.mcp_server, "chrome-devtools", "body.mcp_server propagated");
  eq(receipt.body.mcp_tool, "navigate_page", "body.mcp_tool propagated");
  assert(/^sha256:/.test(receipt.body.args_hash), "args_hash present");
  assert(/^sha256:/.test(receipt.body.result_hash), "result_hash present on ok");
}
{
  // failed writer → TRACE_WRITE_FAILED
  const badWriter = async () => { throw new Error("disk on fire"); };
  const cls = classifyToolCall("mcp__chrome-devtools__navigate_page");
  const body = buildReceiptBody({
    leaseId: "lease_x", classification: cls, args: null, result: null,
    outcome: "ok", refusal: null, elapsedMs: 0, adapterId: "x",
  });
  await rejects(
    () => writeReceipt(body, { writer: badWriter }),
    ERROR_CODES.TRACE_WRITE_FAILED,
    "surfaces writer failure as TRACE_WRITE_FAILED"
  );
}

// ── 5. traceMcpCall ─────────────────────────────────────────────────────────

console.log("\n[traceMcpCall]");
{
  const mw = makeMockWriter();
  const lease = goodLease();
  const { receipt, record, classification } = await traceMcpCall({
    toolRef: "mcp__chrome-devtools__navigate_page",
    args: { url: "https://example.com" },
    lease,
    result: { ok: true, page_id: "p1" },
    elapsedMs: 4.2,
    actor: "frontier",
    adapterId: "hermes.adapter.chrome-devtools.v1",
    writer: mw.fn,
  });
  eq(mw.records.length, 1, "one receipt written");
  eq(receipt.body.outcome, "ok", "ok outcome");
  eq(classification.server, "chrome-devtools", "classification.server populated");
  eq(record.event.body.lease_id, "lease_test_1", "lease_id in event.body");
}
{
  // refusal path — lease.allowed does not cover the verb
  const mw = makeMockWriter();
  const lease = goodLease({ allowed: ["something_else"] });
  await rejects(
    () => traceMcpCall({
      toolRef: "mcp__chrome-devtools__navigate_page",
      args: { url: "x" },
      lease,
      result: { ok: true },
      writer: mw.fn,
    }),
    ERROR_CODES.VERB_NOT_ALLOWED,
    "traceMcpCall throws when lease doesn't cover verb"
  );
}
{
  // skipLeaseCheck:true + refusal=string → records refusal even with bad lease
  const mw = makeMockWriter();
  const { receipt } = await traceMcpCall({
    toolRef: "mcp__chrome-devtools__navigate_page",
    args: { url: "x" },
    lease: { id: "lease_refused", allowed: [] },
    refusal: "policy_unknown_tool",
    elapsedMs: 0,
    skipLeaseCheck: true,
    writer: mw.fn,
  });
  eq(mw.records.length, 1, "refusal trace was recorded");
  eq(receipt.body.outcome, "refused", "outcome=refused");
  eq(receipt.body.refusal, "policy_unknown_tool", "refusal reason recorded");
}

// ── 6. wrapDispatch ─────────────────────────────────────────────────────────

console.log("\n[wrapDispatch]");
{
  // happy path
  const mw = makeMockWriter();
  const traced = wrapDispatch({ adapterId: "hermes.adapter.chrome-devtools.v1", writer: mw.fn });
  let dispatchedWith;
  const { ok, result, receipt } = await traced({
    toolRef: "mcp__chrome-devtools__navigate_page",
    args: { url: "https://example.com" },
    lease: goodLease(),
    dispatch: async (args) => { dispatchedWith = args; return { ok: true, page_id: "p1", order_id: "ord_99" }; },
  });
  eq(ok, true, "tracedCall returns ok=true");
  eq(result.page_id, "p1", "result propagated");
  eq(dispatchedWith.url, "https://example.com", "dispatch received args");
  eq(mw.records.length, 1, "one receipt written");
  eq(receipt.body.outcome, "ok", "outcome=ok");
  eq(receipt.body.order_id, "ord_99", "order_id picked up from dispatch result");
  assert(receipt.body.elapsed_ms >= 0, "elapsed_ms recorded");
}
{
  // policy refusal — dispatch must NOT be called, and a refused receipt
  // must still land in the spine
  const mw = makeMockWriter();
  const traced = wrapDispatch({ adapterId: "hermes.adapter.chrome-devtools.v1", writer: mw.fn });
  let dispatchCalled = false;
  await rejects(
    () => traced({
      toolRef: "mcp__chrome-devtools__navigate_page",
      args: { url: "x" },
      lease: goodLease({ allowed: ["other"] }),
      dispatch: async () => { dispatchCalled = true; return {}; },
    }),
    ERROR_CODES.VERB_NOT_ALLOWED,
    "refuses + throws when lease doesn't cover"
  );
  eq(dispatchCalled, false, "dispatch NOT called on policy refusal");
  eq(mw.records.length, 1, "refusal still written");
  eq(mw.records[0].event.body.outcome, "refused", "spine has outcome=refused");
}
{
  // dispatch throws — receipt should still be written, original error rethrown
  const mw = makeMockWriter();
  const traced = wrapDispatch({ adapterId: "hermes.adapter.chrome-devtools.v1", writer: mw.fn });
  let caught;
  try {
    await traced({
      toolRef: "mcp__chrome-devtools__navigate_page",
      args: { url: "x" },
      lease: goodLease(),
      dispatch: async () => { const e = new Error("hermes refused"); e.code = "hermes_timeout"; throw e; },
    });
  } catch (e) { caught = e; }
  assert(!!caught, "dispatch error propagated");
  eq(caught.code, "hermes_timeout", "original code preserved");
  eq(mw.records.length, 1, "receipt still written on dispatch error");
  eq(mw.records[0].event.body.outcome, "error", "outcome=error");
  eq(mw.records[0].event.body.refusal, "hermes_timeout", "refusal carries error code");
  assert(!!caught.receipt, "receipt attached to thrown error");
}
{
  // wrapDispatch arg validation
  try { wrapDispatch({}); fail++; console.log("  FAIL adapterId required"); }
  catch (e) { assert(e instanceof AuditTracerError && e.code === ERROR_CODES.ARG_INVALID, "wrapDispatch requires adapterId"); }
}
{
  const mw = makeMockWriter();
  const traced = wrapDispatch({ adapterId: "hermes.adapter.computer-use.v1", writer: mw.fn });
  await rejects(
    () => traced({ toolRef: "mcp__computer-use__left_click", lease: goodLease(), dispatch: "not-a-fn" }),
    ERROR_CODES.DISPATCH_NOT_CALLABLE,
    "tracedCall requires dispatch:function"
  );
}

// ── 7. meta / constants ─────────────────────────────────────────────────────

console.log("\n[meta]");
eq(TRACER_META.schema, "orange5.hermes.mcp_receipt.v1", "schema id stable");
eq(TRACER_META.kind, "receipt", "kind stable");
eq(TRACER_META.origin, "hermes_mcp", "origin stable");
eq(TRACER_META.lane, "reality", "lane stable");

// ── done ────────────────────────────────────────────────────────────────────

console.log(`\n${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
