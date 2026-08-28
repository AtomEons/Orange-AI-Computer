#!/usr/bin/env node
// 06-ORANGELLM/server/routes/hermes-mcp.test.mjs
//
// Hermetic tests for the Hermes MCP gateway routes. No real network — every
// adapter call is intercepted by passing a stub fetch through the cfg.fetchFn
// override. Covers:
//
//   - parseHermesMcpPath grammar (good, bad, alias resolution)
//   - isHermesMcpPath / isHermesMcpRouteAllowed (boundary predicates)
//   - validateBody (missing lease, malformed lease, wrong shapes)
//   - handleHermesMcp:
//       - happy path on each of the three servers (chrome-devtools,
//         computer-use, playwright)
//       - tool unknown → 400 with policy detail
//       - lease risk insufficient → 403
//       - lease verb not allowed → 403
//       - lease expired → 403
//       - hermes daemon unreachable → 503
//       - hermes returns non-JSON → 502
//       - hermes refuses (4xx with gates) → 409
//   - statusForError mapping is stable
//
// Run:  node 06-ORANGELLM/server/tests/hermes-mcp.test.mjs

import {
  __hermesMcpInternals,
  handleHermesMcp,
  parseHermesMcpPath,
  registerHermesMcpRoutes,
  HERMES_MCP_PATH_PREFIX,
  HERMES_MCP_EXPOSED_SERVERS,
} from "./hermes-mcp.mjs";

import {
  isHermesMcpPath,
  isHermesMcpRouteAllowed,
} from "./hermes-mcp-boundary.mjs";

let pass = 0;
let fail = 0;
const lines = [];

function assert(cond, msg) {
  if (cond) {
    pass += 1;
    lines.push(["PASS", msg]);
  } else {
    fail += 1;
    lines.push(["FAIL", msg]);
  }
}
function assertEq(actual, expected, msg) {
  assert(
    actual === expected,
    `${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`,
  );
}

const happyReport = {
  schema: "orange.report.v1",
  ok: true,
  verb: "(set per call)",
  gates: [{ gate: "order_schema", pass: true }],
  receipt_path: "/tmp/r.json",
  elapsed_ms: 4,
  mcp_response: { result: "ok" },
};

function stubFetch({ status = 200, body, throwError } = {}) {
  const captured = { calls: 0, lastUrl: null, lastBody: null };
  const fn = async (url, init) => {
    captured.calls += 1;
    if (throwError) throw throwError;
    captured.lastUrl = url;
    captured.lastBody = init && init.body ? JSON.parse(init.body) : null;
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: `HTTP ${status}`,
      text: async () => (body === undefined ? "" : typeof body === "string" ? body : JSON.stringify(body)),
    };
  };
  return { fn, captured };
}

function lease(allowed, riskLevel = "medium", extra = {}) {
  return {
    id: "lease_gw_test",
    actor: "gw-test",
    allowed,
    forbidden: ["destructive_write", "production_deploy", "scope_expansion", "egress_unbounded"],
    targetProject: "Orange5",
    riskLevel,
    expires_at: Date.now() + 60_000,
    requires_approval: false,
    ...extra,
  };
}

// ─── 1. path parsing ────────────────────────────────────────────────────────
{
  const p = parseHermesMcpPath("/v1/hermes/mcp/chrome-devtools/navigate_page");
  assert(p !== null, "parses chrome-devtools alias");
  assertEq(p.wireServer, "chrome-devtools", "wireServer is bare name");
  assertEq(p.routerServer, "chrome-devtools-mcp", "routerServer resolves to -mcp suffix");
  assertEq(p.tool, "navigate_page", "tool extracted");

  const p2 = parseHermesMcpPath("/v1/hermes/mcp/computer-use-mcp/left_click");
  assert(p2 !== null, "parses computer-use-mcp suffix form");
  assertEq(p2.routerServer, "computer-use-mcp", "routerServer round-trips");

  const p3 = parseHermesMcpPath("/v1/hermes/mcp/playwright/browser_click/");
  assert(p3 !== null, "parses trailing slash");
  assertEq(p3.tool, "browser_click", "tool extracted with trailing slash");

  assertEq(parseHermesMcpPath("/v1/hermes/mcp/unknown/foo"), null, "rejects unknown server");
  assertEq(parseHermesMcpPath("/hermes/mcp/chrome-devtools/navigate_page"), null, "rejects missing /v1");
  assertEq(parseHermesMcpPath("/v1/hermes/mcp/chrome-devtools"), null, "rejects missing tool");
  assertEq(parseHermesMcpPath("/v1/hermes/action"), null, "rejects unrelated path");
  assertEq(parseHermesMcpPath(""), null, "rejects empty string");
  assertEq(parseHermesMcpPath(123), null, "rejects non-string");
}

// ─── 2. boundary predicates ─────────────────────────────────────────────────
{
  assert(isHermesMcpPath("/v1/hermes/mcp/chrome-devtools/navigate_page"), "boundary admits known server path");
  assert(!isHermesMcpPath("/v1/hermes/mcp/evil/run"), "boundary rejects unknown server");
  assert(!isHermesMcpPath("/v1/hermes/action"), "boundary rejects /v1/hermes/action via mcp predicate");
  assert(isHermesMcpRouteAllowed("POST", "/v1/hermes/mcp/playwright/browser_click"), "POST admitted");
  assert(!isHermesMcpRouteAllowed("GET", "/v1/hermes/mcp/playwright/browser_click"), "GET refused");
  assert(!isHermesMcpRouteAllowed("post", "/v1/hermes/mcp/unknown/foo"), "unknown server refused even with POST");
  assert(HERMES_MCP_EXPOSED_SERVERS.includes("chrome-devtools"), "exposed list contains chrome-devtools");
  assertEq(HERMES_MCP_PATH_PREFIX, "/v1/hermes/mcp", "path prefix is stable");
}

// ─── 3. validateBody ────────────────────────────────────────────────────────
{
  const v = __hermesMcpInternals.validateBody;
  assertEq(v({ lease: lease(["cd.navigate_page"]) }).length, 0, "valid body passes");
  assert(v({}).length > 0, "missing lease fails");
  assert(v({ lease: { id: "x" } }).length > 0, "lease without allowed[] fails");
  assert(v({ lease: { id: "x", allowed: [], riskLevel: "" } }).length > 0, "lease without riskLevel fails");
  assert(v({ lease: lease(["x"]), args: "not-object" }).length > 0, "non-object args fails");
  assert(v({ lease: lease(["x"]), actor: 42 }).length > 0, "numeric actor fails");
  assert(v({ lease: lease(["x"]), operatorApproved: "yes" }).length > 0, "non-bool operatorApproved fails");
}

// ─── 4. handleHermesMcp — bad path / bad body ───────────────────────────────
{
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/unknown/run",
    body: { lease: lease(["x"]) },
  });
  assertEq(r.status, 404, "unknown server → 404");
  assertEq(r.body.error.type, "router_unknown_route", "404 carries router_unknown_route");

  const r2 = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/navigate_page",
    body: null,
  });
  assertEq(r2.status, 400, "null body → 400");

  const r3 = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/navigate_page",
    body: { lease: { id: "x" } }, // malformed lease
  });
  assertEq(r3.status, 400, "malformed lease → 400");
  assertEq(r3.body.error.type, "invalid_request_error", "carries invalid_request_error");
}

// ─── 5. handleHermesMcp — unknown tool ──────────────────────────────────────
{
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/not_a_real_tool",
    body: { lease: lease(["cd.navigate_page"]), args: {} },
  });
  assertEq(r.status, 400, "unknown tool → 400");
  assertEq(r.body.error.type, "router_unknown_tool", "carries router_unknown_tool");
}

// ─── 6. happy path: chrome-devtools navigate_page ──────────────────────────
{
  const { fn, captured } = stubFetch({ status: 200, body: { ...happyReport, verb: "cd.navigate_page" } });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/navigate_page",
    body: {
      lease: lease(["cd.navigate_page"], "medium"),
      args: { url: "https://example.test" },
    },
    opts: { fetchFn: fn, baseUrl: "http://127.0.0.1:7430" },
  });
  assertEq(r.status, 200, "chrome-devtools navigate_page → 200");
  assertEq(r.body.ok, true, "ok:true on success");
  assertEq(r.body.data.verb, "cd.navigate_page", "verb echoed");
  assertEq(r.body.data.risk_level, "medium", "risk_level surfaced");
  assertEq(r.body.data.server, "chrome-devtools", "wire server name surfaced");
  assertEq(captured.calls, 1, "exactly one upstream call to hermes");
  assert(captured.lastUrl.endsWith("/action"), "calls /action on hermes");
}

// ─── 7. computer-use left_click requires approval ──────────────────────────
//
// Computer-use medium desktop input is not allowed to land silently. The
// gateway policy layer refuses before dispatch unless operatorApproved=true.
{
  const { fn } = stubFetch({ status: 200, body: { ...happyReport, verb: "desktop.left_click" } });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/computer-use/left_click",
    body: {
      lease: lease(["desktop.left_click"], "medium", { forbidden: [] }),
      args: { x: 100, y: 100 },
    },
    opts: { fetchFn: fn },
  });
  assertEq(r.status, 403, "computer-use left_click without approval → 403");
  assertEq(r.body.error.code, "operator_approval_required", "desktop verb requires operator approval");
}

// ─── 8. happy path: playwright browser_click ───────────────────────────────
{
  const { fn } = stubFetch({ status: 200, body: { ...happyReport, verb: "browser.click" } });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/playwright/browser_click",
    body: {
      lease: lease(["browser.click"], "medium"),
      args: { x: 50, y: 50 },
    },
    opts: { fetchFn: fn },
  });
  assertEq(r.status, 200, "playwright browser_click → 200");
  assertEq(r.body.data.verb, "browser.click", "browser verb echoed");
}

// ─── 9. lease risk insufficient → 403 ──────────────────────────────────────
{
  // evaluate_script is high; lease only carries "low"
  const { fn } = stubFetch({ status: 200, body: happyReport });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/evaluate_script",
    body: {
      lease: lease(["cd.evaluate_script"], "low"),
      args: { expression: "1+1" },
    },
    opts: { fetchFn: fn },
  });
  assertEq(r.status, 403, "risk insufficient → 403");
  assertEq(r.body.error.type, "router_lease_risk_insufficient", "carries risk_insufficient code");
}

// ─── 10. lease verb not allowed → 403 ──────────────────────────────────────
{
  const { fn } = stubFetch({ status: 200, body: happyReport });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/navigate_page",
    body: {
      lease: lease(["cd.list_pages"], "medium"), // doesn't include navigate_page
      args: { url: "https://example.test" },
    },
    opts: { fetchFn: fn },
  });
  assertEq(r.status, 403, "verb not allowed → 403");
  assertEq(r.body.error.type, "router_lease_verb_not_allowed", "carries verb_not_allowed code");
}

// ─── 11. lease expired → 403 ───────────────────────────────────────────────
{
  const { fn } = stubFetch({ status: 200, body: happyReport });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/navigate_page",
    body: {
      lease: lease(["cd.navigate_page"], "medium", { expires_at: Date.now() - 1000 }),
      args: { url: "https://example.test" },
    },
    opts: { fetchFn: fn },
  });
  assertEq(r.status, 403, "expired lease → 403");
  assertEq(r.body.error.type, "router_lease_expired", "carries lease_expired code");
}

// ─── 12. hermes daemon unreachable → 503 ───────────────────────────────────
{
  const transportError = Object.assign(new Error("ECONNREFUSED 127.0.0.1:7430"), { code: "ECONNREFUSED" });
  const { fn } = stubFetch({ throwError: transportError });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/navigate_page",
    body: {
      lease: lease(["cd.navigate_page"], "medium"),
      args: { url: "https://example.test" },
    },
    opts: { fetchFn: fn },
  });
  // Adapter throws "hermes_transport_failed" which maps to 503
  assertEq(r.status, 503, "transport refused → 503");
  assert(["hermes_transport_failed", "hermes_unreachable"].includes(r.body.error.type),
    "carries an honest transport error code");
}

// ─── 13. hermes returns non-JSON → 502 ─────────────────────────────────────
{
  const { fn } = stubFetch({ status: 200, body: "<html>not-json</html>" });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/navigate_page",
    body: {
      lease: lease(["cd.navigate_page"], "medium"),
      args: { url: "https://example.test" },
    },
    opts: { fetchFn: fn },
  });
  assertEq(r.status, 502, "non-JSON hermes body → 502");
  assertEq(r.body.error.type, "hermes_bad_response", "carries hermes_bad_response");
}

// ─── 14. hermes refuses (4xx) → 409 ────────────────────────────────────────
{
  const { fn } = stubFetch({
    status: 409,
    body: {
      refusal: "gate_fail_codexa_lease",
      gates: [
        { gate: "codexa_lease", pass: false, reason: "lease.allowed missing verb" },
      ],
    },
  });
  const r = await handleHermesMcp({
    pathname: "/v1/hermes/mcp/chrome-devtools/navigate_page",
    body: {
      lease: lease(["cd.navigate_page"], "medium"),
      args: { url: "https://example.test" },
    },
    opts: { fetchFn: fn },
  });
  assertEq(r.status, 409, "hermes 4xx refusal → 409");
  assertEq(r.body.error.type, "gate_fail_codexa_lease", "echoes the daemon refusal code");
  assert(Array.isArray(r.body.error.detail.gates), "carries gate trace in detail");
}

// ─── 15. statusForError mapping is stable ──────────────────────────────────
{
  const s = __hermesMcpInternals.statusForError;
  assertEq(s({ code: "router_arg_invalid" }), 400, "router_arg_invalid → 400");
  assertEq(s({ code: "router_unknown_tool" }), 400, "router_unknown_tool → 400");
  assertEq(s({ code: "router_unknown_route" }), 404, "router_unknown_route → 404");
  assertEq(s({ code: "router_lease_risk_insufficient" }), 403, "risk insufficient → 403");
  assertEq(s({ code: "router_lease_expired" }), 403, "expired → 403");
  assertEq(s({ code: "hermes_unreachable" }), 503, "unreachable → 503");
  assertEq(s({ code: "hermes_timeout" }), 504, "timeout → 504");
  assertEq(s({ code: "hermes_bad_response" }), 502, "bad response → 502");
  assertEq(s({ code: "gate_fail_anything" }), 409, "unknown gate-shaped code → 409");
  assertEq(s({ status: 418 }), 418, "explicit .status passes through");
}

// ─── 16. registerHermesMcpRoutes shape ─────────────────────────────────────
{
  // Stub minimal node:http Server. We don't actually fire a request; the
  // shape contract is what matters here — that the registration returns a
  // stable object and does not throw on wire-up.
  const fakeServer = {
    _listeners: [],
    on() {},
    prependListener(event, fn) {
      this._listeners.push({ event, fn });
    },
  };
  const result = registerHermesMcpRoutes(fakeServer, {});
  assertEq(result.path_prefix, "/v1/hermes/mcp", "result.path_prefix is stable");
  assert(Array.isArray(result.exposed_servers), "result.exposed_servers is an array");
  assertEq(fakeServer._listeners.length, 1, "registers exactly one request listener");
  assertEq(fakeServer._listeners[0].event, "request", "listens on 'request'");

  try {
    registerHermesMcpRoutes(null);
    fail += 1; lines.push(["FAIL", "throws on null server"]);
  } catch (err) {
    if (err instanceof TypeError) {
      pass += 1; lines.push(["PASS", "throws TypeError on null server"]);
    } else {
      fail += 1; lines.push(["FAIL", `wrong throw on null server: ${err && err.name}`]);
    }
  }
}

// ─── report ─────────────────────────────────────────────────────────────────

for (const [tag, msg] of lines) {
  // eslint-disable-next-line no-console
  console.log(`${tag}  ${msg}`);
}
// eslint-disable-next-line no-console
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
