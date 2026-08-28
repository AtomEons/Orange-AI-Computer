#!/usr/bin/env node
// 08-HERMES / tests / mcp-router.test.mjs
//
// Hermetic tests for the Hermes MCP router. No real network: every adapter
// call is intercepted via the `fetchFn` parameter that the router passes
// down. Covers:
//
//   - module meta / route registry
//   - path parsing (parseMcpPath)
//   - lookupRoute on every known (server, tool)
//   - input validation (server, tool, args, lease shape)
//   - hardened policy layer (risk insufficient, verb not allowed,
//     verb forbidden, wide-forbidden tokens, expired lease)
//   - classifyCall (no network)
//   - routeMcpCall happy path on each adapter (playwright, chrome-devtools,
//     computer-use) — asserts the right verb landed at /action
//   - mcpRouterHandler over a fake req/res — happy path + error mapping
//
// Run:  node 08-HERMES/tests/mcp-router.test.mjs

import {
  McpRouterError,
  ROUTER_META,
  parseMcpPath,
  lookupRoute,
  classifyCall,
  routeMcpCall,
  mcpRouterHandler,
} from "../mcp-router.mjs";

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
    if (err instanceof McpRouterError && err.code === code) {
      pass += 1; results.push(["PASS", msg]);
    } else {
      fail += 1; results.push(["FAIL", `${msg} (got code=${err && err.code}, name=${err && err.name})`]);
    }
  }
}

// ─── helpers ────────────────────────────────────────────────────────────────

function leaseFor(verbs, riskLevel = "medium", extra = {}) {
  return {
    id: "lease_test_router",
    actor: "router-test",
    allowed: verbs,
    forbidden: ["destructive_write", "production_deploy", "scope_expansion", "egress_unbounded"],
    targetProject: "Orange5",
    riskLevel,
    expires_at: Date.now() + 60_000,
    requires_approval: false,
    ...extra,
  };
}

const HAPPY_REPORT = {
  schema: "orange.report.v1",
  ok: true,
  verb: "(set per call)",
  gates: [{ gate: "order_schema", pass: true }],
  receipt_path: "/tmp/receipt_router.json",
  elapsed_ms: 7,
  mcp_response: { result: "ok" },
};

function stubFetch({ status = 200, body, throwError } = {}) {
  const captured = { lastRequest: null, calls: 0 };
  const fn = async (url, init) => {
    captured.calls += 1;
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

// ─── 1. ROUTER_META is stable and frozen ────────────────────────────────────
{
  assertEq(ROUTER_META.id, "hermes.mcp-router.v1", "ROUTER_META.id is stable");
  assertEq(ROUTER_META.report_schema, "orange.report.v1", "report schema is orange.report.v1");
  assert(Object.isFrozen(ROUTER_META), "ROUTER_META is frozen");
  assert(ROUTER_META.servers.includes("playwright-mcp"), "servers includes playwright-mcp");
  assert(ROUTER_META.servers.includes("chrome-devtools-mcp"), "servers includes chrome-devtools-mcp");
  assert(ROUTER_META.servers.includes("computer-use-mcp"), "servers includes computer-use-mcp");
  assert(ROUTER_META.risk_ladder[0] === "read_only" && ROUTER_META.risk_ladder.at(-1) === "production",
    "risk_ladder runs read_only → production");
}

// ─── 2. parseMcpPath ────────────────────────────────────────────────────────
{
  assertEq(JSON.stringify(parseMcpPath("/v1/hermes/mcp/chrome-devtools-mcp/navigate_page")),
    JSON.stringify({ server: "chrome-devtools-mcp", tool: "navigate_page" }),
    "parses /v1/hermes/mcp/{server}/{tool}");
  assertEq(JSON.stringify(parseMcpPath("/hermes/mcp/computer-use-mcp/left_click")),
    JSON.stringify({ server: "computer-use-mcp", tool: "left_click" }),
    "parses without /v1 prefix");
  assertEq(parseMcpPath("/v1/hermes/mcp/chrome-devtools-mcp"), null, "rejects missing tool");
  assertEq(parseMcpPath("/v1/hermes/action"), null, "rejects /action path");
  assertEq(parseMcpPath(""), null, "rejects empty path");
  assertEq(parseMcpPath(123), null, "rejects non-string path");
}

// ─── 3. lookupRoute on every server ─────────────────────────────────────────
{
  const cd = lookupRoute("chrome-devtools-mcp", "evaluate_script");
  assertEq(cd.verb, "cd.evaluate_script", "lookupRoute returns chrome-devtools verb");
  assertEq(cd.risk_level, "high", "evaluate_script is high risk");

  const cu = lookupRoute("computer-use-mcp", "left_click");
  assertEq(cu.verb, "desktop.left_click", "lookupRoute returns desktop verb");
  assertEq(cu.risk_level, "medium", "desktop.left_click is medium risk");

  const pw = lookupRoute("playwright-mcp", "browser_navigate");
  assertEq(pw.verb, "browser.navigate", "lookupRoute returns playwright verb");
  assertEq(pw.risk_level, "medium", "browser.navigate is medium risk");

  await assertThrows(
    async () => lookupRoute("nonexistent-mcp", "x"),
    "router_unknown_server",
    "lookupRoute throws on unknown server"
  );
  await assertThrows(
    async () => lookupRoute("chrome-devtools-mcp", "fake_tool"),
    "router_unknown_tool",
    "lookupRoute throws on unknown tool"
  );
}

// ─── 4. input validation ────────────────────────────────────────────────────
{
  await assertThrows(
    () => routeMcpCall(),
    "router_arg_invalid",
    "routeMcpCall requires an options object"
  );
  await assertThrows(
    () => routeMcpCall({ tool: "list_pages", lease: leaseFor(["cd.list_pages"], "read_only") }),
    "router_arg_invalid",
    "routeMcpCall rejects missing server"
  );
  await assertThrows(
    () => routeMcpCall({ server: "chrome-devtools-mcp", lease: leaseFor(["cd.list_pages"], "read_only") }),
    "router_arg_invalid",
    "routeMcpCall rejects missing tool"
  );
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "list_pages",
      args: "not-an-object",
      lease: leaseFor(["cd.list_pages"], "read_only"),
    }),
    "router_arg_invalid",
    "routeMcpCall rejects non-object args"
  );
  await assertThrows(
    () => routeMcpCall({
      server: "unknown-mcp",
      tool: "list_pages",
      lease: leaseFor(["cd.list_pages"], "read_only"),
    }),
    "router_unknown_server",
    "routeMcpCall rejects unknown server"
  );
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "no_such_tool",
      lease: leaseFor(["cd.list_pages"], "read_only"),
    }),
    "router_unknown_tool",
    "routeMcpCall rejects unknown tool"
  );
}

// ─── 5. lease validation ────────────────────────────────────────────────────
{
  await assertThrows(
    () => routeMcpCall({ server: "chrome-devtools-mcp", tool: "list_pages" }),
    "router_lease_missing",
    "rejects missing lease"
  );
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "list_pages",
      lease: { id: "x" },
    }),
    "router_lease_malformed",
    "rejects lease without allowed[]"
  );
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "list_pages",
      lease: leaseFor(["cd.list_pages"], "read_only", { expires_at: Date.now() - 1 }),
    }),
    "router_lease_expired",
    "rejects expired lease"
  );
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "list_pages",
      lease: leaseFor(["cd.list_pages"], "bogus_level"),
    }),
    "router_lease_risk_unknown",
    "rejects lease with unknown riskLevel"
  );
}

// ─── 6. hardened policy layer ───────────────────────────────────────────────
{
  // riskLevel too weak
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "evaluate_script",
      args: { expression: "1+1" },
      lease: leaseFor(["cd.evaluate_script"], "low"),
    }),
    "router_lease_risk_insufficient",
    "rejects when lease.riskLevel < verb's required risk"
  );

  // verb not in lease.allowed
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "navigate_page",
      args: { url: "https://example.com" },
      lease: leaseFor(["cd.list_pages"], "medium"),
    }),
    "router_lease_verb_not_allowed",
    "rejects when verb not in lease.allowed"
  );

  // verb explicitly forbidden
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "navigate_page",
      args: { url: "https://example.com" },
      lease: leaseFor(["cd.navigate_page"], "medium", { forbidden: ["cd.navigate_page"] }),
    }),
    "router_lease_verb_forbidden",
    "rejects when verb is in lease.forbidden"
  );

  // wide-forbidden: destructive_write blocks destructive risk
  await assertThrows(
    () => routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "close_page",
      args: {},
      lease: leaseFor(["cd.close_page"], "destructive",
        { forbidden: ["destructive_write"] }),
    }),
    "router_lease_wide_forbidden",
    "wide-forbidden destructive_write blocks destructive verb"
  );
}

// ─── 7. classifyCall (no network) ───────────────────────────────────────────
{
  const ok = classifyCall({
    server: "chrome-devtools-mcp",
    tool: "list_pages",
    lease: leaseFor(["cd.list_pages"], "read_only"),
  });
  assert(ok.ok === true && ok.verb === "cd.list_pages" && ok.risk_level === "read_only",
    "classifyCall ok path returns verb+risk_level");
  assert(Object.isFrozen(ok), "classifyCall result is frozen");

  const bad = classifyCall({
    server: "chrome-devtools-mcp",
    tool: "evaluate_script",
    lease: leaseFor(["cd.evaluate_script"], "low"),
  });
  assert(bad.ok === false && bad.code === "router_lease_risk_insufficient",
    "classifyCall surfaces refusal code without throwing");
}

// ─── 8. routeMcpCall happy path: chrome-devtools ────────────────────────────
{
  const { fn, captured } = stubFetch({ body: { ...HAPPY_REPORT, verb: "cd.list_pages" } });
  const report = await routeMcpCall({
    server: "chrome-devtools-mcp",
    tool: "list_pages",
    args: {},
    lease: leaseFor(["cd.list_pages"], "read_only"),
    fetchFn: fn,
  });
  assertEq(report.schema, "orange.report.v1", "happy: chrome-devtools schema preserved");
  assertEq(report.server, "chrome-devtools-mcp", "happy: server attached to report");
  assertEq(report.tool, "list_pages", "happy: tool attached to report");
  assertEq(report.risk_level, "read_only", "happy: risk_level attached to report");
  assert(typeof report.router_elapsed_ms === "number" && report.router_elapsed_ms >= 0,
    "happy: router_elapsed_ms is a non-negative number");

  const reqBody = captured.lastRequest.body;
  assertEq(reqBody.order.action, "cd.list_pages", "happy: canonical action is present");
  assertEq(reqBody.order.verb, "cd.list_pages", "happy: adapter sent the correct verb");
  assertEq(reqBody.order.adapter, "hermes.adapter.chrome-devtools.v1",
    "happy: adapter id present in order");
}

// ─── 9. routeMcpCall happy path: computer-use ───────────────────────────────
{
  const { fn, captured } = stubFetch({ body: { ...HAPPY_REPORT, verb: "desktop.left_click" } });
  // The computer-use adapter has its own stricter local-policy layer that
  // hard-blocks any "production_deploy" or "destructive_write" wide token on
  // medium+ verbs. The router-level happy path test mints a lease without
  // those wide tokens so we exercise the router/adapter handshake without
  // tripping the per-adapter belt.
  const report = await routeMcpCall({
    server: "computer-use-mcp",
    tool: "left_click",
    args: { x: 100, y: 200 },
    lease: leaseFor(["desktop.left_click"], "medium", { forbidden: [] }),
    fetchFn: fn,
  });
  assertEq(report.ok, true, "computer-use happy: ok=true");
  assertEq(report.tool, "left_click", "computer-use happy: tool tag attached");

  const reqBody = captured.lastRequest.body;
  assertEq(reqBody.order.action, "desktop.left_click", "computer-use happy: canonical action is present");
  assertEq(reqBody.order.verb, "desktop.left_click", "computer-use happy: correct verb landed");
  assertEq(reqBody.order.args.x, 100, "computer-use happy: x arg threaded through");
  assertEq(reqBody.order.args.y, 200, "computer-use happy: y arg threaded through");
}

// ─── 10. routeMcpCall happy path: playwright ────────────────────────────────
{
  const { fn, captured } = stubFetch({ body: { ...HAPPY_REPORT, verb: "browser.navigate" } });
  const report = await routeMcpCall({
    server: "playwright-mcp",
    tool: "browser_navigate",
    args: { url: "https://example.com/" },
    lease: leaseFor(["browser.navigate"], "medium"),
    fetchFn: fn,
  });
  assertEq(report.ok, true, "playwright happy: ok=true");
  const reqBody = captured.lastRequest.body;
  assertEq(reqBody.order.action, "browser.navigate", "playwright happy: canonical action is present");
  assertEq(reqBody.order.verb, "browser.navigate", "playwright happy: verb landed");
  assertEq(reqBody.order.args.url, "https://example.com/", "playwright happy: url forwarded");
}

// ─── 11. routeMcpCall surfaces adapter refusal with .code ───────────────────
{
  const { fn } = stubFetch({
    status: 403,
    body: { refusal: "lease_expired", gates: [{ gate: "codexa_lease", pass: false }] },
  });
  let caught = null;
  try {
    await routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "list_pages",
      args: {},
      lease: leaseFor(["cd.list_pages"], "read_only"),
      fetchFn: fn,
    });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof McpRouterError, "adapter refusal: throws McpRouterError");
  assertEq(caught.code, "lease_expired", "adapter refusal: bubbles up adapter code");
  assertEq(caught.server, "chrome-devtools-mcp", "adapter refusal: server attached");
  assertEq(caught.tool, "list_pages", "adapter refusal: tool attached");
  assertEq(caught.verb, "cd.list_pages", "adapter refusal: verb attached");
  assert(Array.isArray(caught.gates), "adapter refusal: gates array preserved");
}

// ─── 12. routeMcpCall flags schema mismatch from adapter ────────────────────
{
  // Adapter receives wrong-schema body → adapter throws report_schema_mismatch,
  // router lifts that .code into McpRouterError.
  const { fn } = stubFetch({ body: { schema: "wrong.schema", ok: true } });
  let caught = null;
  try {
    await routeMcpCall({
      server: "chrome-devtools-mcp",
      tool: "list_pages",
      args: {},
      lease: leaseFor(["cd.list_pages"], "read_only"),
      fetchFn: fn,
    });
  } catch (err) {
    caught = err;
  }
  assert(caught instanceof McpRouterError, "schema mismatch: throws McpRouterError");
  assertEq(caught.code, "report_schema_mismatch", "schema mismatch: code bubbles");
}

// ─── 13. mcpRouterHandler over a fake req/res ──────────────────────────────
{
  // Fake req/res — Node http style. We pre-set req.body to skip the stream read.
  function makeReqRes({ method = "POST", url, body }) {
    const headers = {};
    const res = {
      _status: null,
      _body: null,
      writeHead(s, h) { this._status = s; Object.assign(headers, h || {}); },
      end(payload) { this._body = payload; },
    };
    return {
      req: { method, url, body },
      res,
      headers,
    };
  }

  // 13a. happy 200
  {
    const { req, res } = makeReqRes({
      url: "/v1/hermes/mcp/chrome-devtools-mcp/list_pages",
      body: { args: {}, lease: leaseFor(["cd.list_pages"], "read_only") },
    });
    const { fn } = stubFetch({ body: { ...HAPPY_REPORT, verb: "cd.list_pages" } });
    await mcpRouterHandler(req, res, { fetchFn: fn });
    assertEq(res._status, 200, "handler: 200 on happy path");
    const parsed = JSON.parse(res._body);
    assertEq(parsed.schema, "orange.report.v1", "handler: returns orange.report.v1");
    assertEq(parsed.server, "chrome-devtools-mcp", "handler: server attached");
  }

  // 13b. 404 on bad path
  {
    const { req, res } = makeReqRes({
      url: "/totally/wrong/path",
      body: {},
    });
    await mcpRouterHandler(req, res);
    assertEq(res._status, 404, "handler: 404 on unknown route");
  }

  // 13c. 405 on GET
  {
    const { req, res } = makeReqRes({
      method: "GET",
      url: "/v1/hermes/mcp/chrome-devtools-mcp/list_pages",
      body: {},
    });
    await mcpRouterHandler(req, res);
    assertEq(res._status, 405, "handler: 405 on non-POST");
  }

  // 13d. 403 on lease refusal
  {
    const { req, res } = makeReqRes({
      url: "/v1/hermes/mcp/chrome-devtools-mcp/evaluate_script",
      body: {
        args: { expression: "1+1" },
        lease: leaseFor(["cd.evaluate_script"], "low"),
      },
    });
    await mcpRouterHandler(req, res);
    assertEq(res._status, 403, "handler: 403 on policy refusal");
    const parsed = JSON.parse(res._body);
    assertEq(parsed.code, "router_lease_risk_insufficient",
      "handler: refusal code propagated");
  }

  // 13e. 400 on unknown server
  {
    const { req, res } = makeReqRes({
      url: "/v1/hermes/mcp/no-such-mcp/list_pages",
      body: { lease: leaseFor(["x"], "low") },
    });
    await mcpRouterHandler(req, res);
    assertEq(res._status, 400, "handler: 400 on unknown server");
  }

  // 13f. 400 on non-object body
  {
    const { req, res } = makeReqRes({
      url: "/v1/hermes/mcp/chrome-devtools-mcp/list_pages",
      body: "not-an-object",
    });
    await mcpRouterHandler(req, res);
    assertEq(res._status, 400, "handler: 400 on non-object body");
  }

  // 13g. 409 on adapter refusal (Hermes-side gate failure)
  {
    const { req, res } = makeReqRes({
      url: "/v1/hermes/mcp/chrome-devtools-mcp/list_pages",
      body: { args: {}, lease: leaseFor(["cd.list_pages"], "read_only") },
    });
    const { fn } = stubFetch({
      status: 409,
      body: { refusal: "operator_approval_required", gates: [] },
    });
    await mcpRouterHandler(req, res, { fetchFn: fn });
    assertEq(res._status, 409, "handler: 409 on adapter-side refusal");
    const parsed = JSON.parse(res._body);
    assertEq(parsed.code, "operator_approval_required",
      "handler: adapter refusal code propagated");
  }
}

// ─── 14. every advertised route in ROUTER_META.routes is callable ──────────
{
  // For every (server, tool) the router exposes, classifyCall with a
  // matching lease must succeed. This guards against drift between the
  // ROUTES table and the per-adapter exports.
  let walked = 0;
  for (const [server, toolMap] of Object.entries(ROUTER_META.routes)) {
    for (const [tool, meta] of Object.entries(toolMap)) {
      const verdict = classifyCall({
        server,
        tool,
        // Clean forbidden list so the wide-forbidden check doesn't gate
        // destructive-class verbs. We're testing route discoverability here,
        // not wide-forbidden semantics (that's tested earlier).
        lease: leaseFor(
          [meta.verb],
          meta.risk_level === "read_only" ? "low" : meta.risk_level,
          { forbidden: [] },
        ),
      });
      assert(verdict.ok === true, `route ${server}/${tool} classifies ok with matching lease`);
      walked += 1;
    }
  }
  assert(walked >= 30, `walked ≥ 30 routes (got ${walked})`);
}

// ─── summary ────────────────────────────────────────────────────────────────

const total = pass + fail;
const verdict = fail === 0 ? "GREEN" : "RED";
console.log(`\n[mcp-router.test] ${verdict}: ${pass}/${total} pass, ${fail} fail`);
if (fail > 0) {
  for (const [tag, msg] of results) {
    if (tag === "FAIL") console.log(`  ${tag}  ${msg}`);
  }
  process.exit(1);
}
