#!/usr/bin/env node
// 08-HERMES / tests / chrome-devtools.adapter.test.mjs
//
// Hermetic tests for the chrome-devtools Hermes adapter. No real network: a
// stub `fetch` is injected via the `fetchFn` parameter, so every test runs
// in <50ms and never opens a socket. Covers:
//
//   - input validation (missing lease, bad args, expired lease)
//   - policy layer (risk classification + lease.allowed match)
//   - order shape (the JSON the adapter would have sent)
//   - transport (200/400 paths, timeout, malformed body, schema mismatch)
//   - destructive-pattern guard on evaluateScript
//   - verb coverage smoke (every exported verb dispatches with the right MCP tool)
//
// Run:  node 08-HERMES/tests/chrome-devtools.adapter.test.mjs

import { readFileSync } from "node:fs";
import {
  HermesAdapterError,
  ADAPTER_META,
  riskLevelFor,
  navigatePage,
  navigateBack,
  newPage,
  closePage,
  selectPage,
  listPages,
  waitFor,
  resizePage,
  emulate,
  click,
  hover,
  fill,
  fillForm,
  drag,
  pressKey,
  takeSnapshot,
  takeScreenshot,
  listConsoleMessages,
  getConsoleMessage,
  listNetworkRequests,
  getNetworkRequest,
  evaluateScript,
  handleDialog,
  uploadFile,
  performanceStartTrace,
  performanceStopTrace,
  performanceAnalyzeInsight,
  takeMemorySnapshot,
  lighthouseAudit,
} from "../adapters/chrome-devtools.mjs";

let pass = 0, fail = 0;
const results = [];

function assert(cond, msg) {
  if (cond) { pass += 1; results.push(["PASS", msg]); }
  else      { fail += 1; results.push(["FAIL", msg]); }
}
function assertEq(actual, expected, msg) {
  assert(actual === expected, `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`);
}
async function assertThrows(fn, code, msg) {
  try {
    await fn();
    fail += 1; results.push(["FAIL", `${msg} (no throw)`]);
  } catch (err) {
    if (err instanceof HermesAdapterError && err.code === code) {
      pass += 1; results.push(["PASS", msg]);
    } else {
      fail += 1; results.push(["FAIL", `${msg} (got code=${err.code}, name=${err.name})`]);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function leaseFor(verbs, riskLevel = "medium", extra = {}) {
  return {
    id: "lease_test_abc123",
    actor: "test-actor",
    allowed: verbs,
    forbidden: ["destructive_write", "production_deploy", "scope_expansion", "egress_unbounded"],
    targetProject: "Orange5",
    riskLevel,
    expires_at: Date.now() + 60_000,
    requires_approval: false,
    ...extra,
  };
}

/**
 * Build a stub fetch that captures the request and returns a configurable
 * response. The captured request is exposed via `.lastRequest`.
 */
function stubFetch({ status = 200, body, throwError } = {}) {
  const captured = { lastRequest: null };
  const fn = async (url, init) => {
    if (throwError) throw throwError;
    captured.lastRequest = {
      url,
      method: init.method,
      headers: init.headers,
      body: init.body ? JSON.parse(init.body) : null,
    };
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? "OK" : `HTTP ${status}`,
      text: async () => (body === undefined ? "" : JSON.stringify(body)),
    };
  };
  return { fn, captured };
}

const HAPPY_REPORT = {
  schema: "orange.report.v1",
  ok: true,
  verb: "cd.navigate_page",
  gates: [],
  receipt_path: "/tmp/receipt.json",
  elapsed_ms: 12,
  mcp_response: { result: "ok" },
};

// ─── 1. adapter meta ────────────────────────────────────────────────────────
{
  assertEq(ADAPTER_META.id, "hermes.adapter.chrome-devtools.v1", "ADAPTER_META.id is stable");
  assertEq(ADAPTER_META.mcp_server, "chrome-devtools-mcp", "ADAPTER_META.mcp_server is chrome-devtools-mcp");
  assert(ADAPTER_META.verbs.includes("cd.navigate_page"), "verbs include navigate_page");
  assert(ADAPTER_META.verbs.includes("cd.evaluate_script"), "verbs include evaluate_script");
  assert(Object.isFrozen(ADAPTER_META), "ADAPTER_META is frozen");
}

// ─── 2. risk classification ────────────────────────────────────────────────
{
  assertEq(riskLevelFor("cd.list_pages"), "read_only", "list_pages is read_only");
  assertEq(riskLevelFor("cd.click"), "medium", "click is medium");
  assertEq(riskLevelFor("cd.evaluate_script"), "high", "evaluate_script is high");
  assertEq(riskLevelFor("cd.close_page"), "destructive", "close_page is destructive");
  await assertThrows(
    async () => riskLevelFor("cd.bogus"),
    "verb_unknown",
    "riskLevelFor throws on unknown verb"
  );
}

// ─── 3. lease validation ───────────────────────────────────────────────────
{
  await assertThrows(
    () => navigatePage({ url: "https://example.com" }),
    "lease_missing",
    "navigatePage rejects missing lease"
  );
  await assertThrows(
    () => navigatePage({ url: "https://example.com", lease: { id: "x" } }),
    "lease_malformed",
    "navigatePage rejects lease without allowed[]"
  );
  await assertThrows(
    () => navigatePage({
      url: "https://example.com",
      lease: leaseFor(["cd.navigate_page"], "medium", { expires_at: Date.now() - 1 }),
    }),
    "lease_expired",
    "navigatePage rejects expired lease"
  );
}

// ─── 4. policy layer: lease must cover verb ────────────────────────────────
{
  // Verb not in allowed[]
  await assertThrows(
    () => navigatePage({ url: "https://example.com", lease: leaseFor(["cd.list_pages"]) }),
    "lease_verb_not_allowed",
    "rejects when verb not in lease.allowed"
  );
  // riskLevel too weak for verb
  await assertThrows(
    () => evaluateScript({
      expression: "1+1",
      lease: leaseFor(["cd.evaluate_script"], "low"),
    }),
    "lease_risk_insufficient",
    "rejects when lease.riskLevel < required (low vs high)"
  );
  // Verb is forbidden even though allowed
  await assertThrows(
    () => navigatePage({
      url: "https://example.com",
      lease: leaseFor(["cd.navigate_page"], "medium", { forbidden: ["cd.navigate_page"] }),
    }),
    "lease_verb_forbidden",
    "rejects when verb is in lease.forbidden even if also in allowed"
  );
  // Unknown riskLevel string
  await assertThrows(
    () => navigatePage({
      url: "https://example.com",
      lease: leaseFor(["cd.navigate_page"], "yolo"),
    }),
    "lease_risk_unknown",
    "rejects unknown riskLevel string"
  );
}

// ─── 5. arg validation ─────────────────────────────────────────────────────
{
  const lease = leaseFor(["cd.navigate_page", "cd.click", "cd.fill", "cd.wait_for", "cd.resize_page", "cd.emulate", "cd.fill_form", "cd.drag", "cd.handle_dialog", "cd.upload_file", "cd.get_console_message", "cd.get_network_request", "cd.press_key", "cd.select_page"], "high");

  await assertThrows(() => navigatePage({ url: "not-a-url", lease }), "arg_invalid", "navigatePage rejects non-absolute URL");
  await assertThrows(() => navigatePage({ url: "https://example.com", lease, waitUntil: "bogus" }), "arg_invalid", "navigatePage rejects bad waitUntil");
  await assertThrows(() => click({ lease }), "arg_invalid", "click rejects when neither selector nor uid given");
  await assertThrows(() => click({ selector: "#x", button: "double", lease }), "arg_invalid", "click rejects bad button");
  await assertThrows(() => fill({ selector: "#x", value: 42, lease }), "arg_invalid", "fill rejects non-string value");
  await assertThrows(() => waitFor({ lease }), "arg_invalid", "waitFor rejects when no condition given");
  await assertThrows(() => resizePage({ width: -1, height: 100, lease }), "arg_invalid", "resizePage rejects negative width");
  await assertThrows(() => emulate({ lease }), "arg_invalid", "emulate rejects when no device or network given");
  await assertThrows(() => fillForm({ fields: [], lease }), "arg_invalid", "fillForm rejects empty fields");
  await assertThrows(() => fillForm({ fields: [{ selector: "#a" }], lease }), "arg_invalid", "fillForm rejects field without value");
  await assertThrows(() => handleDialog({ action: "maybe", lease }), "arg_invalid", "handleDialog rejects bad action");
  await assertThrows(() => uploadFile({ selector: "#f", lease }), "arg_invalid", "uploadFile rejects missing filePath");
  await assertThrows(() => pressKey({ lease }), "arg_invalid", "pressKey rejects missing key");
  await assertThrows(() => selectPage({ lease }), "arg_invalid", "selectPage rejects missing pageId");
}

// ─── 6. evaluateScript destructive-pattern guard ───────────────────────────
{
  const lease = leaseFor(["cd.evaluate_script"], "high");
  await assertThrows(
    () => evaluateScript({ expression: "indexedDB.deleteDatabase('x')", lease }),
    "expression_destructive_pattern",
    "evaluateScript blocks indexedDB.deleteDatabase"
  );
  await assertThrows(
    () => evaluateScript({ expression: "document.write('<h1>oops</h1>')", lease }),
    "expression_destructive_pattern",
    "evaluateScript blocks document.write"
  );
  await assertThrows(
    () => evaluateScript({ expression: "location.replace('https://evil.test')", lease }),
    "expression_destructive_pattern",
    "evaluateScript blocks location.replace"
  );
  await assertThrows(
    () => evaluateScript({ expression: "1+1", lease, args: "not-array" }),
    "arg_invalid",
    "evaluateScript rejects non-array args"
  );
}

// ─── 7. transport: happy path order shape ──────────────────────────────────
{
  const lease = leaseFor(["cd.navigate_page"]);
  const { fn, captured } = stubFetch({ body: { ...HAPPY_REPORT, verb: "cd.navigate_page" } });
  const report = await navigatePage({ url: "https://example.com/", lease, fetchFn: fn });
  assertEq(report.ok, true, "happy path returns ok=true");
  assertEq(report.schema, "orange.report.v1", "happy path returns orange.report.v1");

  const req = captured.lastRequest;
  assertEq(req.method, "POST", "request method is POST");
  assertEq(req.url, "http://127.0.0.1:7430/action", "request URL is hermes /action");
  assertEq(req.headers["x-hermes-adapter"], "hermes.adapter.chrome-devtools.v1", "x-hermes-adapter header sent");
  assertEq(req.body.order.schema, "orange.order.v1", "order.schema is orange.order.v1");
  assertEq(req.body.order.action, "cd.navigate_page", "order.action is canonical");
  assertEq(req.body.order.verb, "cd.navigate_page", "order.verb is cd.navigate_page");
  assertEq(req.body.order.mcp_tool, "navigate_page", "order.mcp_tool is mapped");
  assertEq(req.body.order.risk_level, "medium", "order.risk_level is recorded");
  assertEq(req.body.order.lease_id, "lease_test_abc123", "order.lease_id is forwarded");
  assertEq(req.body.order.args.url, "https://example.com/", "order.args.url is forwarded");
  assertEq(req.body.operator_approved, false, "operator_approved defaults false");
  const preActionReceipt = JSON.parse(readFileSync(req.body.receipt_path, "utf8"));
  assertEq(preActionReceipt.status, "pending", "pre-action receipt is settleable");
  assertEq(preActionReceipt.lease_id, "lease_test_abc123", "pre-action receipt binds the lease");
  assertEq(preActionReceipt.action, "cd.navigate_page", "pre-action receipt binds the action");
}

// ─── 8. transport: operatorApproved is forwarded ───────────────────────────
{
  const lease = leaseFor(["cd.close_page"], "destructive");
  const { fn, captured } = stubFetch({ body: { ...HAPPY_REPORT, verb: "cd.close_page" } });
  await closePage({ pageId: "page_1", lease, fetchFn: fn, operatorApproved: true });
  assertEq(captured.lastRequest.body.operator_approved, true, "operator_approved=true forwarded for destructive verb");
}

// ─── 9. transport: 4xx refusal carries gate trace ──────────────────────────
{
  const lease = leaseFor(["cd.navigate_page"]);
  const { fn } = stubFetch({
    status: 403,
    body: {
      refusal: "operator_approval_required",
      gates: [{ gate: "human_approval", pass: false, reason: "lease requires approval" }],
    },
  });
  try {
    await navigatePage({ url: "https://example.com", lease, fetchFn: fn });
    fail += 1; results.push(["FAIL", "403 should throw"]);
  } catch (err) {
    assert(err instanceof HermesAdapterError, "403 throws HermesAdapterError");
    assertEq(err.code, "operator_approval_required", "403 code propagates from body.refusal");
    assertEq(err.status, 403, "403 status preserved");
    assert(Array.isArray(err.gates) && err.gates.length === 1, "gate trace preserved");
  }
}

// ─── 10. transport: malformed body ────────────────────────────────────────
{
  const lease = leaseFor(["cd.navigate_page"]);
  // text() returns non-JSON
  const fn = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "not-json-{",
  });
  await assertThrows(
    () => navigatePage({ url: "https://example.com", lease, fetchFn: fn }),
    "hermes_bad_response",
    "malformed JSON body throws hermes_bad_response"
  );
}

// ─── 11. transport: schema mismatch ───────────────────────────────────────
{
  const lease = leaseFor(["cd.navigate_page"]);
  const { fn } = stubFetch({ body: { schema: "wrong.schema", ok: true } });
  await assertThrows(
    () => navigatePage({ url: "https://example.com", lease, fetchFn: fn }),
    "report_schema_mismatch",
    "wrong report schema throws report_schema_mismatch"
  );
}

// ─── 12. transport: report.ok=false ───────────────────────────────────────
{
  const lease = leaseFor(["cd.navigate_page"]);
  const { fn } = stubFetch({
    body: {
      schema: "orange.report.v1",
      ok: false,
      refusal: "false_green_guard_tripped",
      gates: [{ gate: "false_green_guard", pass: false }],
    },
  });
  await assertThrows(
    () => navigatePage({ url: "https://example.com", lease, fetchFn: fn }),
    "false_green_guard_tripped",
    "report.ok=false throws with refusal code"
  );
}

// ─── 13. transport: timeout ───────────────────────────────────────────────
{
  const lease = leaseFor(["cd.navigate_page"]);
  // A fetch that never resolves — AbortController will fire on timeout.
  const fn = async (_url, init) => {
    return new Promise((_resolve, reject) => {
      init.signal.addEventListener("abort", () => {
        const err = new Error("aborted");
        err.name = "AbortError";
        reject(err);
      });
    });
  };
  await assertThrows(
    () => navigatePage({ url: "https://example.com", lease, fetchFn: fn, timeoutMs: 10 }),
    "hermes_timeout",
    "timeout throws hermes_timeout"
  );
}

// ─── 14. transport failure (network down) ─────────────────────────────────
{
  const lease = leaseFor(["cd.navigate_page"]);
  const { fn } = stubFetch({ throwError: new Error("ECONNREFUSED") });
  await assertThrows(
    () => navigatePage({ url: "https://example.com", lease, fetchFn: fn }),
    "hermes_transport_failed",
    "network failure throws hermes_transport_failed"
  );
}

// ─── 15. verb coverage smoke — every verb dispatches correctly ────────────
{
  // For each verb, mint a lease that names it at sufficient risk, fire it,
  // and confirm the captured order.verb / order.mcp_tool match the map.
  const cases = [
    ["cd.navigate_page",                "navigate_page",                "high", () => navigatePage({ url: "https://e.test" })],
    ["cd.navigate_back",                "navigate_back",                "high", () => navigateBack({})],
    ["cd.new_page",                     "new_page",                     "high", () => newPage({})],
    ["cd.close_page",                   "close_page",                   "destructive", () => closePage({})],
    ["cd.select_page",                  "select_page",                  "low",  () => selectPage({ pageId: "p1" })],
    ["cd.list_pages",                   "list_pages",                   "read_only", () => listPages({})],
    ["cd.wait_for",                     "wait_for",                     "read_only", () => waitFor({ ms: 100 })],
    ["cd.resize_page",                  "resize_page",                  "low",  () => resizePage({ width: 1280, height: 720 })],
    ["cd.emulate",                      "emulate",                      "low",  () => emulate({ device: "iPhone 15" })],
    ["cd.click",                        "click",                        "medium", () => click({ selector: "#go" })],
    ["cd.hover",                        "hover",                        "low",  () => hover({ selector: "#x" })],
    ["cd.fill",                         "fill",                         "medium", () => fill({ selector: "#i", value: "hi" })],
    ["cd.fill_form",                    "fill_form",                    "medium", () => fillForm({ fields: [{ selector: "#a", value: "1" }] })],
    ["cd.drag",                         "drag",                         "medium", () => drag({ from: { selector: "#a" }, to: { selector: "#b" } })],
    ["cd.press_key",                    "press_key",                    "low",  () => pressKey({ key: "Enter" })],
    ["cd.take_snapshot",                "take_snapshot",                "read_only", () => takeSnapshot({})],
    ["cd.take_screenshot",              "take_screenshot",              "read_only", () => takeScreenshot({})],
    ["cd.list_console_messages",        "list_console_messages",        "read_only", () => listConsoleMessages({})],
    ["cd.get_console_message",          "get_console_message",          "read_only", () => getConsoleMessage({ index: 0 })],
    ["cd.list_network_requests",        "list_network_requests",        "read_only", () => listNetworkRequests({})],
    ["cd.get_network_request",          "get_network_request",          "read_only", () => getNetworkRequest({ requestId: "r1" })],
    ["cd.evaluate_script",              "evaluate_script",              "high", () => evaluateScript({ expression: "1+1" })],
    ["cd.handle_dialog",                "handle_dialog",                "medium", () => handleDialog({ action: "accept" })],
    ["cd.upload_file",                  "upload_file",                  "high", () => uploadFile({ selector: "#f", filePath: "/tmp/x.png" })],
    ["cd.performance_start_trace",      "performance_start_trace",      "low",  () => performanceStartTrace({})],
    ["cd.performance_stop_trace",       "performance_stop_trace",       "low",  () => performanceStopTrace({})],
    ["cd.performance_analyze_insight",  "performance_analyze_insight",  "read_only", () => performanceAnalyzeInsight({ insight: "LCPBreakdown" })],
    ["cd.take_memory_snapshot",         "take_memory_snapshot",         "read_only", () => takeMemorySnapshot({})],
    ["cd.lighthouse_audit",             "lighthouse_audit",             "low",  () => lighthouseAudit({})],
  ];

  // Sanity: covers every verb in ADAPTER_META.verbs
  const covered = new Set(cases.map(c => c[0]));
  for (const v of ADAPTER_META.verbs) {
    assert(covered.has(v), `verb coverage smoke includes ${v}`);
  }

  for (const [verbId, expectedMcpTool, requiredRisk, _invoke] of cases) {
    const lease = leaseFor([verbId], requiredRisk);
    const { fn, captured } = stubFetch({
      body: { schema: "orange.report.v1", ok: true, verb: verbId, gates: [], receipt_path: "/tmp/r.json", elapsed_ms: 1 },
    });
    // Re-dispatch with the stub fetch by re-binding the call (the closures
    // above were just for assembling the table; we re-build inline so
    // fetchFn + lease land on the right verb).
    const map = {
      "cd.navigate_page": () => navigatePage({ url: "https://e.test", lease, fetchFn: fn }),
      "cd.navigate_back": () => navigateBack({ lease, fetchFn: fn }),
      "cd.new_page": () => newPage({ lease, fetchFn: fn }),
      "cd.close_page": () => closePage({ lease, fetchFn: fn }),
      "cd.select_page": () => selectPage({ pageId: "p1", lease, fetchFn: fn }),
      "cd.list_pages": () => listPages({ lease, fetchFn: fn }),
      "cd.wait_for": () => waitFor({ ms: 50, lease, fetchFn: fn }),
      "cd.resize_page": () => resizePage({ width: 1280, height: 720, lease, fetchFn: fn }),
      "cd.emulate": () => emulate({ device: "iPhone 15", lease, fetchFn: fn }),
      "cd.click": () => click({ selector: "#go", lease, fetchFn: fn }),
      "cd.hover": () => hover({ selector: "#x", lease, fetchFn: fn }),
      "cd.fill": () => fill({ selector: "#i", value: "hi", lease, fetchFn: fn }),
      "cd.fill_form": () => fillForm({ fields: [{ selector: "#a", value: "1" }], lease, fetchFn: fn }),
      "cd.drag": () => drag({ from: { selector: "#a" }, to: { selector: "#b" }, lease, fetchFn: fn }),
      "cd.press_key": () => pressKey({ key: "Enter", lease, fetchFn: fn }),
      "cd.take_snapshot": () => takeSnapshot({ lease, fetchFn: fn }),
      "cd.take_screenshot": () => takeScreenshot({ lease, fetchFn: fn }),
      "cd.list_console_messages": () => listConsoleMessages({ lease, fetchFn: fn }),
      "cd.get_console_message": () => getConsoleMessage({ index: 0, lease, fetchFn: fn }),
      "cd.list_network_requests": () => listNetworkRequests({ lease, fetchFn: fn }),
      "cd.get_network_request": () => getNetworkRequest({ requestId: "r1", lease, fetchFn: fn }),
      "cd.evaluate_script": () => evaluateScript({ expression: "1+1", lease, fetchFn: fn }),
      "cd.handle_dialog": () => handleDialog({ action: "accept", lease, fetchFn: fn }),
      "cd.upload_file": () => uploadFile({ selector: "#f", filePath: "/tmp/x.png", lease, fetchFn: fn }),
      "cd.performance_start_trace": () => performanceStartTrace({ lease, fetchFn: fn }),
      "cd.performance_stop_trace": () => performanceStopTrace({ lease, fetchFn: fn }),
      "cd.performance_analyze_insight": () => performanceAnalyzeInsight({ insight: "LCPBreakdown", lease, fetchFn: fn }),
      "cd.take_memory_snapshot": () => takeMemorySnapshot({ lease, fetchFn: fn }),
      "cd.lighthouse_audit": () => lighthouseAudit({ lease, fetchFn: fn }),
    };
    await map[verbId]();
    const order = captured.lastRequest.body.order;
    assertEq(order.verb, verbId, `${verbId} order.verb is correct`);
    assertEq(order.mcp_tool, expectedMcpTool, `${verbId} maps to MCP tool ${expectedMcpTool}`);
  }
}

// ─── report ────────────────────────────────────────────────────────────────

const tag = fail === 0 ? "PASS" : "FAIL";
console.log("");
console.log(`chrome-devtools adapter tests: ${pass} passed, ${fail} failed [${tag}]`);
if (fail > 0) {
  console.log("");
  for (const [status, msg] of results) {
    if (status === "FAIL") console.log(`  FAIL  ${msg}`);
  }
  process.exit(1);
} else {
  process.exit(0);
}
