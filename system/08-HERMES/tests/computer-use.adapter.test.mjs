#!/usr/bin/env node
// Tests for 08-HERMES/adapters/computer-use.mjs
//
// Three concerns get exercised here:
//   1. Local policy layer: classifyVerb, leaseCoversRisk, enforceLocalPolicy
//      reject every bad-lease path BEFORE any HTTP round-trip happens.
//   2. Argument validation on every public verb.
//   3. Transport happy path with an injected fetch — order envelope is
//      correctly shaped (orange.order.v1 + risk_level + verb + lease_id),
//      and the parsed orange.report.v1 is returned to the caller.
//
// No real Hermes daemon, no real MCP server. fetchFn is injected.

import {
  HermesAdapterError,
  ADAPTER_META,
  ADAPTER_ID,
  RISK_LADDER,
  RISK_BY_VERB,
  classifyVerb,
  leaseCoversRisk,
  enforceLocalPolicy,
  screenshot,
  left_click,
  right_click,
  type,
  key,
  scroll,
} from "../adapters/computer-use.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else      { fail++; console.log(`  FAIL ${msg}`); }
}
function eq(a, b, msg) { assert(a === b, `${msg} (got=${JSON.stringify(a)} want=${JSON.stringify(b)})`); }
function deepEq(a, b, msg) { assert(JSON.stringify(a) === JSON.stringify(b), `${msg} (got=${JSON.stringify(a)} want=${JSON.stringify(b)})`); }

async function rejects(fn, code, msg) {
  try {
    await fn();
    fail++; console.log(`  FAIL ${msg} (expected throw with code=${code}, got resolve)`);
  } catch (err) {
    if (err instanceof HermesAdapterError && err.code === code) {
      pass++; console.log(`  PASS ${msg}`);
    } else {
      fail++; console.log(`  FAIL ${msg} (got ${err?.name}/${err?.code}: ${err?.message})`);
    }
  }
}

// Helper: a known-good lease with all six verbs granted and risk=high.
function fullLease(overrides = {}) {
  return {
    id: "lease_test_001",
    actor: "test-runner",
    allowed: [
      "desktop.screenshot",
      "desktop.left_click",
      "desktop.right_click",
      "desktop.type",
      "desktop.key",
      "desktop.scroll",
    ],
    forbidden: [],
    targetProject: "Orange5",
    riskLevel: "high",
    expires_at: Date.now() + 60_000,
    requires_approval: false,
    ...overrides,
  };
}

// Helper: build a fetch mock that records calls and replies with a valid
// orange.report.v1 body. Optionally override the response builder.
function mockFetch({ status = 200, buildBody, capture } = {}) {
  return async (url, init) => {
    if (capture) {
      capture.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
    }
    const body = buildBody ? buildBody(capture?.[capture.length - 1]) : {
      schema: "orange.report.v1",
      ok: true,
      verb: capture?.[capture.length - 1]?.body?.order?.verb,
      gates: RISK_LADDER.map(() => ({ gate: "stub", pass: true })),
      mcp_response: { ok: true },
      receipt_path: "C:/tmp/receipt.json",
      elapsed_ms: 1,
    };
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
}

console.log("computer-use.adapter.test.mjs");

// ---------------------------------------------------------------------------
// Section 1: ADAPTER_META and constants
console.log("\n[1] adapter metadata");

{
  eq(ADAPTER_META.id, "hermes.adapter.computer-use.v1", "ADAPTER_META.id stable");
  eq(ADAPTER_ID, "hermes.adapter.computer-use.v1", "ADAPTER_ID re-export matches");
  eq(ADAPTER_META.mcp_server, "computer-use-mcp", "mcp_server name");
  deepEq([...ADAPTER_META.verbs].sort(), [
    "desktop.key",
    "desktop.left_click",
    "desktop.right_click",
    "desktop.screenshot",
    "desktop.scroll",
    "desktop.type",
  ], "exactly six verbs exposed");
  deepEq([...RISK_LADDER], ["read_only","low","medium","high","destructive","production"], "risk ladder order pinned");
}

// ---------------------------------------------------------------------------
// Section 2: classifyVerb + risk_by_verb mapping (the brief's pinned table)
console.log("\n[2] verb classification per brief");

{
  eq(classifyVerb("desktop.screenshot").risk_level,  "low",    "screenshot=low");
  eq(classifyVerb("desktop.scroll").risk_level,      "low",    "scroll=low");
  eq(classifyVerb("desktop.left_click").risk_level,  "medium", "left_click=medium");
  eq(classifyVerb("desktop.right_click").risk_level, "medium", "right_click=medium");
  eq(classifyVerb("desktop.type").risk_level,        "medium", "type=medium");
  eq(classifyVerb("desktop.key").risk_level,         "medium", "key=medium");

  try {
    classifyVerb("desktop.format_drive");
    fail++; console.log("  FAIL classifyVerb rejects unknown verb (no throw)");
  } catch (err) {
    eq(err.code, "verb_unknown", "classifyVerb throws verb_unknown for unknown verb");
  }
}

// ---------------------------------------------------------------------------
// Section 3: leaseCoversRisk ladder math
console.log("\n[3] leaseCoversRisk ladder");

{
  eq(leaseCoversRisk("high",        "medium"), true,  "high covers medium");
  eq(leaseCoversRisk("medium",      "medium"), true,  "medium covers medium (equal)");
  eq(leaseCoversRisk("low",         "medium"), false, "low does NOT cover medium");
  eq(leaseCoversRisk("read_only",   "low"),    false, "read_only does NOT cover low");
  eq(leaseCoversRisk("destructive", "high"),   true,  "destructive covers high");
  eq(leaseCoversRisk("production",  "destructive"), true, "production covers destructive");
  eq(leaseCoversRisk("garbage",     "low"),    false, "off-ladder actual rejects");
  eq(leaseCoversRisk("low",         "garbage"), false, "off-ladder required rejects");
}

// ---------------------------------------------------------------------------
// Section 4: enforceLocalPolicy — every refusal path
console.log("\n[4] enforceLocalPolicy refusal paths");

{
  // happy path
  const p = enforceLocalPolicy("desktop.left_click", fullLease());
  eq(p.verb, "desktop.left_click", "policy verdict.verb");
  eq(p.risk_level, "medium",       "policy verdict.risk_level");
  eq(p.lease_id, "lease_test_001", "policy verdict.lease_id");
}

{
  try {
    enforceLocalPolicy("desktop.type", null);
  } catch (err) { eq(err.code, "lease_missing", "missing lease -> lease_missing"); }
}

{
  const lease = fullLease({ id: "" });
  try {
    enforceLocalPolicy("desktop.type", lease);
  } catch (err) { eq(err.code, "lease_malformed", "empty lease.id -> lease_malformed"); }
}

{
  const lease = fullLease({ allowed: "not-an-array" });
  try {
    enforceLocalPolicy("desktop.type", lease);
  } catch (err) { eq(err.code, "lease_malformed", "non-array lease.allowed -> lease_malformed"); }
}

{
  const lease = fullLease({ expires_at: Date.now() - 1000 });
  try {
    enforceLocalPolicy("desktop.type", lease);
  } catch (err) { eq(err.code, "lease_expired", "expired lease -> lease_expired"); }
}

{
  const lease = fullLease({ allowed: ["desktop.screenshot"] });  // doesn't include type
  try {
    enforceLocalPolicy("desktop.type", lease);
  } catch (err) { eq(err.code, "verb_not_in_lease", "verb absent from allowed -> verb_not_in_lease"); }
}

{
  const lease = fullLease({ forbidden: ["desktop.type"] });
  try {
    enforceLocalPolicy("desktop.type", lease);
  } catch (err) { eq(err.code, "verb_forbidden_by_lease", "verb in forbidden -> verb_forbidden_by_lease"); }
}

{
  const lease = fullLease({ forbidden: ["production_deploy"] });
  const p = enforceLocalPolicy("desktop.screenshot", lease);
  eq(p.risk_level, "low", "production_deploy does NOT block ordinary desktop mediation");
}

{
  const lease = fullLease({ forbidden: ["destructive_write"] });
  // destructive_write blocks high/destructive/production, not ordinary low/medium desktop mediation.
  const p = enforceLocalPolicy("desktop.screenshot", lease);
  eq(p.risk_level, "low", "destructive_write does NOT block low-risk screenshot");
  const medium = enforceLocalPolicy("desktop.left_click", lease);
  eq(medium.risk_level, "medium", "destructive_write does NOT block medium desktop mediation");
}

{
  const lease = fullLease({ riskLevel: undefined });
  delete lease.riskLevel;
  try {
    enforceLocalPolicy("desktop.screenshot", lease);
  } catch (err) { eq(err.code, "lease_missing_risk_level", "missing lease.riskLevel -> lease_missing_risk_level"); }
}

{
  const lease = fullLease({ riskLevel: "low" });
  try {
    enforceLocalPolicy("desktop.left_click", lease);  // needs medium, has low
  } catch (err) { eq(err.code, "lease_risk_insufficient", "low lease cannot cover medium verb"); }
}

{
  const lease = fullLease({ riskLevel: "low" });
  // low CAN cover low-risk screenshot
  const p = enforceLocalPolicy("desktop.screenshot", lease);
  eq(p.verb, "desktop.screenshot", "low lease covers low screenshot");
}

// ---------------------------------------------------------------------------
// Section 5: verb argument validation (no transport)
console.log("\n[5] verb argument validation");

await rejects(() => screenshot({ lease: fullLease(), format: "gif" }), "arg_invalid", "screenshot: bad format rejected");
await rejects(() => screenshot({ lease: fullLease(), region: { x: 0, y: 0, width: 0, height: 10 } }), "arg_invalid", "screenshot: zero-width region rejected");
await rejects(() => screenshot({ lease: fullLease(), region: { x: "0", y: 0, width: 10, height: 10 } }), "arg_invalid", "screenshot: non-numeric region.x rejected");

await rejects(() => left_click({ x: 100, lease: fullLease() }), "arg_invalid", "left_click: missing y rejected");
await rejects(() => left_click({ x: NaN, y: 0, lease: fullLease() }), "arg_invalid", "left_click: NaN x rejected");
await rejects(() => left_click({ x: 0, y: 0, lease: fullLease(), modifiers: ["lol"] }), "arg_invalid", "left_click: unknown modifier rejected");
await rejects(() => left_click({ x: 0, y: 0, lease: fullLease(), clickCount: 3 }), "arg_invalid", "left_click: clickCount=3 rejected");

await rejects(() => right_click({ x: 0, lease: fullLease() }), "arg_invalid", "right_click: missing y rejected");

await rejects(() => type({ text: 12345, lease: fullLease() }), "arg_invalid", "type: non-string text rejected");
await rejects(() => type({ text: "hi", lease: fullLease(), delayMs: "fast" }), "arg_invalid", "type: non-numeric delayMs rejected");

await rejects(() => key({ lease: fullLease() }), "arg_invalid", "key: missing key rejected");
await rejects(() => key({ key: "", lease: fullLease() }), "arg_invalid", "key: empty key rejected");
await rejects(() => key({ key: "Enter", lease: fullLease(), modifiers: [42] }), "arg_invalid", "key: non-string modifier rejected");

await rejects(() => scroll({ x: 0, y: 0, lease: fullLease() }), "arg_invalid", "scroll: zero deltas rejected");
await rejects(() => scroll({ x: 0, y: 0, deltaY: 5, lease: fullLease(), deltaX: NaN }), "arg_invalid", "scroll: NaN deltaX rejected");

// ---------------------------------------------------------------------------
// Section 6: lease enforcement runs BEFORE arg validation for empty-text type
// (the brief's hardened policy is the first gate; this protects against
// callers learning verb shapes by probing).
console.log("\n[6] policy precedes arg shape");

{
  const lease = fullLease({ allowed: ["desktop.screenshot"] });  // no type granted
  await rejects(
    () => type({ text: "ok", lease }),
    "verb_not_in_lease",
    "type rejects with verb_not_in_lease BEFORE checking text shape"
  );
}

// ---------------------------------------------------------------------------
// Section 7: transport happy path with injected fetch — verifies the order
// envelope shape (orange.order.v1, mcp_tool mapping, risk_level included).
console.log("\n[7] transport happy path");

{
  const capture = [];
  const report = await screenshot({
    lease: fullLease(),
    actor: "test-runner",
    targetProject: "Orange5",
    region: { x: 10, y: 20, width: 300, height: 200 },
    fetchFn: mockFetch({ capture }),
  });

  eq(report.schema, "orange.report.v1", "screenshot returns orange.report.v1");
  eq(report.ok, true, "report.ok=true");
  eq(capture.length, 1, "fetch called exactly once");
  const sent = capture[0].body;
  eq(sent.order.schema, "orange.order.v1", "order.schema = orange.order.v1");
  eq(sent.order.adapter, ADAPTER_ID, "order.adapter = adapter id");
  eq(sent.order.verb, "desktop.screenshot", "order.verb correct");
  eq(sent.order.mcp_tool, "screenshot", "order.mcp_tool maps to short MCP tool name");
  eq(sent.order.risk_level, "low", "order.risk_level included (low for screenshot)");
  eq(sent.order.lease_id, "lease_test_001", "order.lease_id");
  eq(sent.order.actor, "test-runner", "order.actor");
  eq(sent.order.targetProject, "Orange5", "order.targetProject");
  eq(sent.order.args.format, "png", "order.args.format default png");
  deepEq(sent.order.args.region, { x: 10, y: 20, width: 300, height: 200 }, "order.args.region passed through");
  eq(capture[0].init.headers["x-hermes-adapter"], ADAPTER_ID, "x-hermes-adapter header set");
}

{
  const capture = [];
  await left_click({
    x: 500, y: 600,
    lease: fullLease(),
    modifiers: ["Shift", "Ctrl"],
    clickCount: 2,
    fetchFn: mockFetch({ capture }),
  });
  const sent = capture[0].body.order;
  eq(sent.verb, "desktop.left_click", "left_click verb");
  eq(sent.risk_level, "medium", "left_click risk_level=medium");
  eq(sent.args.x, 500, "args.x");
  eq(sent.args.y, 600, "args.y");
  eq(sent.args.clickCount, 2, "args.clickCount");
  deepEq(sent.args.modifiers, ["shift", "ctrl"], "modifiers lowercased + passed through");
}

{
  const capture = [];
  await type({ text: "hello world", lease: fullLease(), delayMs: 12, fetchFn: mockFetch({ capture }) });
  const sent = capture[0].body.order;
  eq(sent.verb, "desktop.type", "type verb");
  eq(sent.args.text, "hello world", "args.text verbatim");
  eq(sent.args.delayMs, 12, "args.delayMs forwarded");
}

{
  const capture = [];
  await key({ key: "Enter", lease: fullLease(), modifiers: ["meta"], fetchFn: mockFetch({ capture }) });
  const sent = capture[0].body.order;
  eq(sent.args.key, "Enter", "args.key forwarded");
  deepEq(sent.args.modifiers, ["meta"], "args.modifiers normalized");
}

{
  const capture = [];
  await scroll({ x: 100, y: 100, deltaY: -240, lease: fullLease(), fetchFn: mockFetch({ capture }) });
  const sent = capture[0].body.order;
  eq(sent.verb, "desktop.scroll", "scroll verb");
  eq(sent.risk_level, "low", "scroll risk_level=low");
  eq(sent.args.deltaY, -240, "args.deltaY forwarded");
  eq(sent.args.deltaX, 0, "args.deltaX defaults 0");
}

{
  const capture = [];
  await right_click({ x: 50, y: 75, lease: fullLease(), fetchFn: mockFetch({ capture }) });
  const sent = capture[0].body.order;
  eq(sent.verb, "desktop.right_click", "right_click verb");
  eq(sent.risk_level, "medium", "right_click risk_level=medium");
}

// ---------------------------------------------------------------------------
// Section 8: transport refusal paths — Hermes 4xx, malformed report, report.ok=false
console.log("\n[8] transport refusal paths");

{
  const fetchFn = async () => new Response(JSON.stringify({
    refusal: "operator_approval_required",
    gates: [{ gate: "human_approval", pass: false, reason: "lease requires approval" }],
  }), { status: 403, headers: { "content-type": "application/json" } });

  await rejects(
    () => screenshot({ lease: fullLease(), fetchFn }),
    "operator_approval_required",
    "hermes 403 with refusal code surfaces as error.code"
  );
}

{
  const fetchFn = async () => new Response("not json at all", {
    status: 500,
    headers: { "content-type": "text/plain" },
  });
  await rejects(
    () => screenshot({ lease: fullLease(), fetchFn }),
    "hermes_bad_response",
    "non-JSON body -> hermes_bad_response"
  );
}

{
  const fetchFn = async () => new Response(JSON.stringify({ schema: "wrong.schema", ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  await rejects(
    () => screenshot({ lease: fullLease(), fetchFn }),
    "report_schema_mismatch",
    "wrong report schema -> report_schema_mismatch"
  );
}

{
  const fetchFn = async () => new Response(JSON.stringify({
    schema: "orange.report.v1",
    ok: false,
    refusal: "false_green_guard",
    gates: [{ gate: "false_green_guard", pass: false }],
  }), { status: 200, headers: { "content-type": "application/json" } });
  await rejects(
    () => screenshot({ lease: fullLease(), fetchFn }),
    "false_green_guard",
    "report.ok=false surfaces refusal code"
  );
}

{
  // AbortController path: a fetch that never resolves should hit the timeout.
  const fetchFn = (url, init) => new Promise((_resolve, reject) => {
    init.signal.addEventListener("abort", () => {
      const err = new Error("aborted");
      err.name = "AbortError";
      reject(err);
    });
  });
  await rejects(
    () => screenshot({ lease: fullLease(), fetchFn, timeoutMs: 25 }),
    "hermes_timeout",
    "AbortController timeout -> hermes_timeout"
  );
}

// ---------------------------------------------------------------------------

console.log(`\nresult: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
