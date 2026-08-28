// 08-HERMES / mcp-router.mjs
//
// Single entry point for any MCP tool call across all Hermes adapters.
//
// POST /v1/hermes/mcp/{server}/{tool}
//     ──> routeMcpCall({ server, tool, args, lease, ... })
//        ──> policy classification (risk_level, allow/forbid match)
//        ──> lease assertion (riskLevel covers, expires_at in future)
//        ──> adapter dispatch (which itself POSTs to /v1/hermes/action)
//        ──> structured report (orange.report.v1 with receipt_path)
//
// Frontier-Isolation invariant (PR-14):
//   - Adapters never call MCP servers directly. Every adapter call shapes an
//     orange.order.v1 envelope and submits to Hermes /action so all 8 LOOM
//     gates run before the action lands. This router DOES NOT bypass that —
//     it dispatches into the adapter functions, which carry the existing
//     submitToHermes path.
//   - The frontier model itself never imports this router and never opens a
//     socket to 127.0.0.1:7430. The router lives inside the gateway / a
//     trusted Orange5 daemon. The frontier proposes the MCP call in a
//     tool-use turn; the gateway shapes (server, tool, args) and calls
//     `routeMcpCall(...)`.
//
// Why a router on top of the per-adapter modules:
//   - The Hermes adapter surface has grown (playwright, chrome-devtools,
//     computer-use) and will grow further. Each adapter has its own verb
//     names, arg shapes, and risk maps. Without a router, every caller has
//     to know which file to import and which function signature to use —
//     that knowledge leaks the boundary the lease was supposed to compress.
//   - The router gives the gateway a single, stable function:
//     `routeMcpCall({ server, tool, args, lease })` and a single HTTP shape:
//     `POST /v1/hermes/mcp/{server}/{tool}` with body `{ args, lease, ... }`.
//   - The router is also the place where the HARDENED POLICY LAYER lives.
//     Every adapter has its own per-verb risk map; the router unifies them,
//     classifies each (server, tool) call, and asserts the lease covers it
//     BEFORE the adapter runs its own verification. Defense in depth: the
//     adapter still verifies; Hermes still verifies; the router is the
//     fail-fast outermost ring.
//
// Output shape on success:
//   {
//     schema: "orange.report.v1",
//     ok: true,
//     verb: "<adapter verb id>",
//     server: "<mcp server>",
//     tool: "<mcp tool>",
//     risk_level: "<read_only|low|medium|high|destructive>",
//     gates: [ ... ],
//     mcp_response: ...,
//     receipt_path: "<absolute path to receipt JSON on the spine>",
//     elapsed_ms: <number>,
//     router_elapsed_ms: <number>,   // wall time spent inside this module
//   }
//
// Output shape on refusal: a thrown `McpRouterError` carrying
//   { code, status, server, tool, verb, risk_level, requiredRisk, leaseRisk,
//     gates, cause }
// Callers must surface .code to the operator; the router never silently
// retries.
//
// Honest gaps:
//   - This file does NOT register a network listener. It exports a pure
//     async function `routeMcpCall` and an Express-style HTTP handler
//     `mcpRouterHandler(req, res)` that the parent server (src/server.mjs)
//     wires up. We keep the network surface in src/server.mjs so the
//     loopback contract stays in one place.
//   - The (server, tool) → adapter verb mapping below is exhaustive for the
//     three adapters that exist in 08-HERMES/adapters/ as of Wave 3. Adding
//     a new adapter is mechanical: define a row in ADAPTERS, list its
//     verbs in TOOL_ROUTES, and add tests.
//   - There is no caching layer. Every call walks the policy + adapter
//     dispatch from scratch. At expected lease/action rates (handfuls per
//     second per actor) this is fine; caching would only obscure the
//     deterministic gate trace.
//   - Node 20+. ESM. No npm deps. Uses global fetch via the adapters.

import {
  // playwright adapter
  click as pw_click,
  fill as pw_fill,
  screenshot as pw_screenshot,
  navigate as pw_navigate,
} from "./adapters/playwright.mjs";

import {
  // chrome-devtools adapter
  navigatePage as cd_navigatePage,
  navigateBack as cd_navigateBack,
  newPage as cd_newPage,
  closePage as cd_closePage,
  selectPage as cd_selectPage,
  listPages as cd_listPages,
  waitFor as cd_waitFor,
  resizePage as cd_resizePage,
  emulate as cd_emulate,
  click as cd_click,
  hover as cd_hover,
  fill as cd_fill,
  fillForm as cd_fillForm,
  drag as cd_drag,
  pressKey as cd_pressKey,
  takeSnapshot as cd_takeSnapshot,
  takeScreenshot as cd_takeScreenshot,
  listConsoleMessages as cd_listConsoleMessages,
  getConsoleMessage as cd_getConsoleMessage,
  listNetworkRequests as cd_listNetworkRequests,
  getNetworkRequest as cd_getNetworkRequest,
  evaluateScript as cd_evaluateScript,
  handleDialog as cd_handleDialog,
  uploadFile as cd_uploadFile,
  performanceStartTrace as cd_perfStart,
  performanceStopTrace as cd_perfStop,
  performanceAnalyzeInsight as cd_perfAnalyze,
  takeMemorySnapshot as cd_memorySnap,
  lighthouseAudit as cd_lighthouse,
  HermesAdapterError as CdHermesAdapterError,
} from "./adapters/chrome-devtools.mjs";

import {
  // computer-use adapter
  screenshot as cu_screenshot,
  left_click as cu_left_click,
  right_click as cu_right_click,
  type as cu_type,
  key as cu_key,
  scroll as cu_scroll,
  HermesAdapterError as CuHermesAdapterError,
} from "./adapters/computer-use.mjs";

// ─── constants ──────────────────────────────────────────────────────────────

const ROUTER_ID = "hermes.mcp-router.v1";
const REPORT_SCHEMA = "orange.report.v1";

/**
 * Unified risk ladder across the router. The chrome-devtools and computer-use
 * adapters use slightly different ladders (computer-use includes "production"
 * for symmetry with the lease engine; chrome-devtools does not). The router
 * uses the superset and normalizes upward: any adapter's "destructive" still
 * ranks 4 here, and computer-use's "production" ranks 5.
 *
 *   read_only(0) < low(1) < medium(2) < high(3) < destructive(4) < production(5)
 */
const RISK_LADDER = Object.freeze([
  "read_only",
  "low",
  "medium",
  "high",
  "destructive",
  "production",
]);

/**
 * Wide forbidden tokens that the Hermes lease engine treats as fatal
 * regardless of which verb they appear next to. If the lease's forbidden[]
 * contains any of these AND the (server, tool) call would trigger them, the
 * router refuses before dispatch.
 */
const HERMES_WIDE_FORBIDDEN = Object.freeze([
  "destructive_write",
  "production_deploy",
  "scope_expansion",
  "egress_unbounded",
]);

/**
 * Registry of adapters this router knows how to dispatch to. Adding a new
 * adapter is mechanical: append a row with the canonical server name (as the
 * frontier model / MCP registry sees it) and the module-level adapter id (as
 * recorded in the order envelope).
 */
const ADAPTERS = Object.freeze({
  "playwright-mcp":      { adapter_id: "hermes.adapter.playwright.v1" },
  "chrome-devtools-mcp": { adapter_id: "hermes.adapter.chrome-devtools.v1" },
  "computer-use-mcp":    { adapter_id: "hermes.adapter.computer-use.v1" },
});

/**
 * (server, tool) → { verb, risk_level, dispatch }.
 *
 * `tool` is the MCP tool name as the frontier sees it (e.g. `navigate_page`,
 * `left_click`, `browser_click`). The router records both the canonical verb
 * id (`cd.navigate_page`) and the per-adapter risk classification so the
 * unified policy check has a single source of truth.
 *
 * `dispatch(args, options)` returns a Promise<orange.report.v1>. It ALWAYS
 * goes through the adapter's submitToHermes path; nothing here bypasses
 * Hermes.
 */
const TOOL_ROUTES = Object.freeze({
  // ── playwright-mcp ────────────────────────────────────────────────────────
  // The playwright adapter predates the per-adapter risk map; we classify
  // every verb here so policy enforcement is uniform across servers.
  "playwright-mcp": Object.freeze({
    browser_click: {
      verb: "browser.click",
      risk_level: "medium",
      dispatch: (args, opt) => pw_click({ ...args, ...opt }),
    },
    browser_type: {
      verb: "browser.fill",
      risk_level: "medium",
      dispatch: (args, opt) => pw_fill({ ...args, ...opt }),
    },
    browser_fill: {
      verb: "browser.fill",
      risk_level: "medium",
      dispatch: (args, opt) => pw_fill({ ...args, ...opt }),
    },
    browser_take_screenshot: {
      verb: "browser.screenshot",
      risk_level: "read_only",
      dispatch: (args, opt) => pw_screenshot({ ...args, ...opt }),
    },
    browser_screenshot: {
      verb: "browser.screenshot",
      risk_level: "read_only",
      dispatch: (args, opt) => pw_screenshot({ ...args, ...opt }),
    },
    browser_navigate: {
      verb: "browser.navigate",
      risk_level: "medium",
      dispatch: (args, opt) => pw_navigate({ ...args, ...opt }),
    },
  }),

  // ── chrome-devtools-mcp ───────────────────────────────────────────────────
  "chrome-devtools-mcp": Object.freeze({
    navigate_page:                { verb: "cd.navigate_page",              risk_level: "medium",      dispatch: (a, o) => cd_navigatePage({ ...a, ...o }) },
    navigate_back:                { verb: "cd.navigate_back",              risk_level: "medium",      dispatch: (a, o) => cd_navigateBack({ ...a, ...o }) },
    new_page:                     { verb: "cd.new_page",                   risk_level: "medium",      dispatch: (a, o) => cd_newPage({ ...a, ...o }) },
    close_page:                   { verb: "cd.close_page",                 risk_level: "destructive", dispatch: (a, o) => cd_closePage({ ...a, ...o }) },
    select_page:                  { verb: "cd.select_page",                risk_level: "low",         dispatch: (a, o) => cd_selectPage({ ...a, ...o }) },
    list_pages:                   { verb: "cd.list_pages",                 risk_level: "read_only",   dispatch: (a, o) => cd_listPages({ ...a, ...o }) },
    wait_for:                     { verb: "cd.wait_for",                   risk_level: "read_only",   dispatch: (a, o) => cd_waitFor({ ...a, ...o }) },
    resize_page:                  { verb: "cd.resize_page",                risk_level: "low",         dispatch: (a, o) => cd_resizePage({ ...a, ...o }) },
    emulate:                      { verb: "cd.emulate",                    risk_level: "low",         dispatch: (a, o) => cd_emulate({ ...a, ...o }) },
    click:                        { verb: "cd.click",                      risk_level: "medium",      dispatch: (a, o) => cd_click({ ...a, ...o }) },
    hover:                        { verb: "cd.hover",                      risk_level: "low",         dispatch: (a, o) => cd_hover({ ...a, ...o }) },
    fill:                         { verb: "cd.fill",                       risk_level: "medium",      dispatch: (a, o) => cd_fill({ ...a, ...o }) },
    fill_form:                    { verb: "cd.fill_form",                  risk_level: "medium",      dispatch: (a, o) => cd_fillForm({ ...a, ...o }) },
    drag:                         { verb: "cd.drag",                       risk_level: "medium",      dispatch: (a, o) => cd_drag({ ...a, ...o }) },
    press_key:                    { verb: "cd.press_key",                  risk_level: "low",         dispatch: (a, o) => cd_pressKey({ ...a, ...o }) },
    take_snapshot:                { verb: "cd.take_snapshot",              risk_level: "read_only",   dispatch: (a, o) => cd_takeSnapshot({ ...a, ...o }) },
    take_screenshot:              { verb: "cd.take_screenshot",            risk_level: "read_only",   dispatch: (a, o) => cd_takeScreenshot({ ...a, ...o }) },
    list_console_messages:        { verb: "cd.list_console_messages",      risk_level: "read_only",   dispatch: (a, o) => cd_listConsoleMessages({ ...a, ...o }) },
    get_console_message:          { verb: "cd.get_console_message",        risk_level: "read_only",   dispatch: (a, o) => cd_getConsoleMessage({ ...a, ...o }) },
    list_network_requests:        { verb: "cd.list_network_requests",      risk_level: "read_only",   dispatch: (a, o) => cd_listNetworkRequests({ ...a, ...o }) },
    get_network_request:          { verb: "cd.get_network_request",        risk_level: "read_only",   dispatch: (a, o) => cd_getNetworkRequest({ ...a, ...o }) },
    evaluate_script:              { verb: "cd.evaluate_script",            risk_level: "high",        dispatch: (a, o) => cd_evaluateScript({ ...a, ...o }) },
    handle_dialog:                { verb: "cd.handle_dialog",              risk_level: "medium",      dispatch: (a, o) => cd_handleDialog({ ...a, ...o }) },
    upload_file:                  { verb: "cd.upload_file",                risk_level: "high",        dispatch: (a, o) => cd_uploadFile({ ...a, ...o }) },
    performance_start_trace:      { verb: "cd.performance_start_trace",    risk_level: "low",         dispatch: (a, o) => cd_perfStart({ ...a, ...o }) },
    performance_stop_trace:       { verb: "cd.performance_stop_trace",     risk_level: "low",         dispatch: (a, o) => cd_perfStop({ ...a, ...o }) },
    performance_analyze_insight:  { verb: "cd.performance_analyze_insight",risk_level: "read_only",   dispatch: (a, o) => cd_perfAnalyze({ ...a, ...o }) },
    take_memory_snapshot:         { verb: "cd.take_memory_snapshot",       risk_level: "read_only",   dispatch: (a, o) => cd_memorySnap({ ...a, ...o }) },
    lighthouse_audit:             { verb: "cd.lighthouse_audit",           risk_level: "low",         dispatch: (a, o) => cd_lighthouse({ ...a, ...o }) },
  }),

  // ── computer-use-mcp ──────────────────────────────────────────────────────
  // Desktop control. Materially scarier than browser automation: a click here
  // can move money, send DMs, or trigger an admin prompt. The risk map is
  // identical to the per-adapter map; the router restates it so a single
  // grep over this file is the source of truth for what is exposed.
  "computer-use-mcp": Object.freeze({
    screenshot:   { verb: "desktop.screenshot",  risk_level: "low",    dispatch: (a, o) => cu_screenshot({ ...a, ...o }) },
    left_click:   { verb: "desktop.left_click",  risk_level: "medium", dispatch: (a, o) => cu_left_click({ ...a, ...o }) },
    right_click:  { verb: "desktop.right_click", risk_level: "medium", dispatch: (a, o) => cu_right_click({ ...a, ...o }) },
    type:         { verb: "desktop.type",        risk_level: "medium", dispatch: (a, o) => cu_type({ ...a, ...o }) },
    key:          { verb: "desktop.key",         risk_level: "medium", dispatch: (a, o) => cu_key({ ...a, ...o }) },
    scroll:       { verb: "desktop.scroll",      risk_level: "low",    dispatch: (a, o) => cu_scroll({ ...a, ...o }) },
  }),
});

// ─── errors ─────────────────────────────────────────────────────────────────

/**
 * Structured error thrown by `routeMcpCall` on any refusal path. Callers must
 * branch on `.code`. The router NEVER silently retries — every refusal is a
 * contract decision that the operator must see.
 *
 * Stable `.code` values (router-owned):
 *   "router_arg_invalid"        — missing/malformed (server, tool, args, lease)
 *   "router_unknown_server"     — server not in ADAPTERS
 *   "router_unknown_tool"       — (server, tool) not in TOOL_ROUTES
 *   "router_lease_missing"      — lease not provided
 *   "router_lease_malformed"    — lease missing required fields
 *   "router_lease_expired"      — lease.expires_at < now
 *   "router_lease_risk_unknown" — lease.riskLevel not in RISK_LADDER
 *   "router_lease_risk_insufficient" — lease.riskLevel < verb's risk_level
 *   "router_lease_verb_not_allowed"  — verb not in lease.allowed[]
 *   "router_lease_verb_forbidden"    — verb explicitly forbidden
 *   "router_lease_wide_forbidden"    — wide token blocks this risk level
 *
 * Plus the adapter's own .code values bubble up through `.cause`.
 */
export class McpRouterError extends Error {
  /**
   * @param {string} message
   * @param {object} info
   */
  constructor(message, info = {}) {
    super(message);
    this.name = "McpRouterError";
    this.code = info.code || "router_unknown_error";
    if (info.status !== undefined) this.status = info.status;
    if (info.server !== undefined) this.server = info.server;
    if (info.tool !== undefined) this.tool = info.tool;
    if (info.verb !== undefined) this.verb = info.verb;
    if (info.risk_level !== undefined) this.risk_level = info.risk_level;
    if (info.requiredRisk !== undefined) this.requiredRisk = info.requiredRisk;
    if (info.leaseRisk !== undefined) this.leaseRisk = info.leaseRisk;
    if (info.gates !== undefined) this.gates = info.gates;
    if (info.cause !== undefined) this.cause = info.cause;
  }
}

// ─── validation helpers ─────────────────────────────────────────────────────

function assertNonEmptyString(value, name, ctx) {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpRouterError(`${name} must be a non-empty string`, {
      code: "router_arg_invalid",
      ...ctx,
    });
  }
}

function assertObject(value, name, ctx) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpRouterError(`${name} must be a plain object`, {
      code: "router_arg_invalid",
      ...ctx,
    });
  }
}

function assertLease(lease, ctx) {
  if (lease === undefined || lease === null) {
    throw new McpRouterError("lease is required", { code: "router_lease_missing", ...ctx });
  }
  if (typeof lease !== "object" || Array.isArray(lease)) {
    throw new McpRouterError("lease must be an object", { code: "router_lease_malformed", ...ctx });
  }
  if (typeof lease.id !== "string" || !lease.id) {
    throw new McpRouterError("lease.id must be a non-empty string", { code: "router_lease_malformed", ...ctx });
  }
  if (!Array.isArray(lease.allowed)) {
    throw new McpRouterError("lease.allowed must be an array", { code: "router_lease_malformed", ...ctx });
  }
  if (typeof lease.riskLevel !== "string" || !lease.riskLevel) {
    throw new McpRouterError("lease.riskLevel must be a non-empty string", { code: "router_lease_malformed", ...ctx });
  }
  if (lease.forbidden !== undefined && !Array.isArray(lease.forbidden)) {
    throw new McpRouterError("lease.forbidden, if present, must be an array", { code: "router_lease_malformed", ...ctx });
  }
  if (lease.expires_at !== undefined) {
    if (typeof lease.expires_at !== "number" || !Number.isFinite(lease.expires_at)) {
      throw new McpRouterError("lease.expires_at, if present, must be a finite number (epoch ms)", {
        code: "router_lease_malformed",
        ...ctx,
      });
    }
    if (lease.expires_at < Date.now()) {
      throw new McpRouterError("lease has expired", { code: "router_lease_expired", ...ctx });
    }
  }
}

// ─── policy layer (hardened, deterministic) ─────────────────────────────────

/**
 * Look up the (server, tool) route. Throws on unknown server/tool so an
 * unmapped call cannot silently default to a lower risk.
 *
 * @param {string} server
 * @param {string} tool
 * @returns {{ verb: string, risk_level: string, dispatch: Function }}
 */
export function lookupRoute(server, tool) {
  const serverRoutes = TOOL_ROUTES[server];
  if (!serverRoutes) {
    if (!Object.prototype.hasOwnProperty.call(ADAPTERS, server)) {
      throw new McpRouterError(`unknown mcp server: "${server}"`, {
        code: "router_unknown_server",
        server,
        tool,
      });
    }
    // Adapter is registered but has no routes — config bug.
    throw new McpRouterError(`mcp server "${server}" has no tool routes registered`, {
      code: "router_unknown_server",
      server,
      tool,
    });
  }
  const route = serverRoutes[tool];
  if (!route) {
    throw new McpRouterError(`unknown mcp tool: "${server}/${tool}"`, {
      code: "router_unknown_tool",
      server,
      tool,
    });
  }
  return route;
}

function rankRisk(level) {
  const idx = RISK_LADDER.indexOf(level);
  return idx === -1 ? -1 : idx;
}

/**
 * Hardened policy check. Runs BEFORE the adapter dispatch so a doomed call
 * never costs a Hermes round trip. Order is invariant:
 *
 *   1. lease shape (id, allowed, riskLevel, expires_at)
 *   2. lease.riskLevel is in the known ladder
 *   3. lease.riskLevel ≥ route.risk_level (the verb's intrinsic risk)
 *   4. route.verb appears in lease.allowed[]
 *   5. route.verb is NOT in lease.forbidden[]
 *   6. wide-forbidden tokens do not block this risk level
 *      (e.g. "destructive_write" blocks risk ≥ "destructive";
 *       "production_deploy" blocks risk ≥ "production")
 *
 * All four checks must pass. The adapter will also run its own check; Hermes
 * will also run its own check on the daemon side; this is the outermost ring.
 *
 * @param {object} lease
 * @param {{ verb: string, risk_level: string }} route
 * @param {{ server: string, tool: string }} ctx
 */
function assertLeaseCoversRoute(lease, route, ctx) {
  const required = route.risk_level;
  const requiredRank = rankRisk(required);
  const leaseRank = rankRisk(lease.riskLevel);

  if (leaseRank === -1) {
    throw new McpRouterError(
      `lease.riskLevel "${lease.riskLevel}" is not in the known risk ladder`,
      {
        code: "router_lease_risk_unknown",
        ...ctx,
        verb: route.verb,
        risk_level: required,
        leaseRisk: lease.riskLevel,
      }
    );
  }
  if (leaseRank < requiredRank) {
    throw new McpRouterError(
      `tool "${ctx.server}/${ctx.tool}" requires riskLevel ≥ ${required}, lease has ${lease.riskLevel}`,
      {
        code: "router_lease_risk_insufficient",
        ...ctx,
        verb: route.verb,
        risk_level: required,
        requiredRisk: required,
        leaseRisk: lease.riskLevel,
      }
    );
  }
  if (!lease.allowed.includes(route.verb)) {
    throw new McpRouterError(
      `verb "${route.verb}" is not in lease.allowed[]`,
      {
        code: "router_lease_verb_not_allowed",
        ...ctx,
        verb: route.verb,
        risk_level: required,
      }
    );
  }
  if (Array.isArray(lease.forbidden)) {
    if (lease.forbidden.includes(route.verb)) {
      throw new McpRouterError(
        `verb "${route.verb}" is explicitly blocked by lease.forbidden[]`,
        {
          code: "router_lease_verb_forbidden",
          ...ctx,
          verb: route.verb,
          risk_level: required,
        }
      );
    }
    // Wide-forbidden tokens: production_deploy blocks anything at production
    // risk; destructive_write blocks anything at destructive or production
    // risk; egress_unbounded blocks navigate-style verbs (handled by lease
    // engine, but we double-check the obvious case here).
    if (lease.forbidden.includes("production_deploy") && requiredRank >= rankRisk("production")) {
      throw new McpRouterError(
        `verb "${route.verb}" requires "production" risk but lease.forbidden includes "production_deploy"`,
        { code: "router_lease_wide_forbidden", ...ctx, verb: route.verb, risk_level: required }
      );
    }
    if (lease.forbidden.includes("destructive_write") && requiredRank >= rankRisk("destructive")) {
      throw new McpRouterError(
        `verb "${route.verb}" requires "${required}" risk but lease.forbidden includes "destructive_write"`,
        { code: "router_lease_wide_forbidden", ...ctx, verb: route.verb, risk_level: required }
      );
    }
  }
}

/**
 * Pure classification entry point. Returns the route record + a verdict.
 * Does NOT touch the network. Exposed so the gateway can pre-screen MCP
 * proposals from the model before showing them to the operator for approval.
 *
 * @param {object} input
 * @param {string} input.server
 * @param {string} input.tool
 * @param {object} input.lease
 * @returns {{ ok: true, server, tool, verb, risk_level } | { ok: false, code, ... }}
 */
export function classifyCall({ server, tool, lease }) {
  try {
    assertNonEmptyString(server, "server", {});
    assertNonEmptyString(tool, "tool", { server });
    const route = lookupRoute(server, tool);
    assertLease(lease, { server, tool, verb: route.verb });
    assertLeaseCoversRoute(lease, route, { server, tool });
    return Object.freeze({
      ok: true,
      server,
      tool,
      verb: route.verb,
      risk_level: route.risk_level,
    });
  } catch (err) {
    if (err instanceof McpRouterError) {
      return Object.freeze({
        ok: false,
        code: err.code,
        message: err.message,
        server: err.server,
        tool: err.tool,
        verb: err.verb,
        risk_level: err.risk_level,
        requiredRisk: err.requiredRisk,
        leaseRisk: err.leaseRisk,
      });
    }
    throw err;
  }
}

// ─── core dispatch ──────────────────────────────────────────────────────────

/**
 * Route a single MCP tool call through the policy layer and into the
 * appropriate Hermes adapter. The adapter — not this router — is what
 * actually POSTs the orange.order.v1 to /v1/hermes/action.
 *
 * @param {object} input
 * @param {string}  input.server                MCP server name (e.g. "chrome-devtools-mcp")
 * @param {string}  input.tool                  MCP tool name (e.g. "navigate_page")
 * @param {object} [input.args={}]              Tool arguments
 * @param {object}  input.lease                 Active lease record
 * @param {string} [input.actor]                Optional actor override (else lease.actor)
 * @param {string} [input.targetProject]        Optional project override
 * @param {boolean}[input.operatorApproved]     If the operator pre-approved
 * @param {string} [input.baseUrl]              Override Hermes base URL (tests)
 * @param {number} [input.timeoutMs]            Override per-call timeout
 * @param {Function}[input.fetchFn]             Inject fetch (tests)
 * @returns {Promise<object>} orange.report.v1 augmented with server/tool/risk_level/router_elapsed_ms
 * @throws {McpRouterError} on any refusal or transport failure
 */
export async function routeMcpCall(input) {
  const t0 = Date.now();

  if (!input || typeof input !== "object") {
    throw new McpRouterError("routeMcpCall requires an options object", { code: "router_arg_invalid" });
  }

  const {
    server,
    tool,
    args = {},
    lease,
    actor,
    targetProject,
    operatorApproved,
    baseUrl,
    timeoutMs,
    fetchFn,
  } = input;

  assertNonEmptyString(server, "server", {});
  assertNonEmptyString(tool, "tool", { server });
  if (args !== undefined && args !== null) assertObject(args, "args", { server, tool });

  const route = lookupRoute(server, tool);
  const ctx = { server, tool, verb: route.verb, risk_level: route.risk_level };

  assertLease(lease, ctx);
  assertLeaseCoversRoute(lease, route, ctx);

  // Dispatch through the adapter. The adapter's submitToHermes path is the
  // only thing that opens a socket to 127.0.0.1:7430.
  let report;
  try {
    report = await route.dispatch(args, {
      lease,
      actor,
      targetProject,
      operatorApproved,
      baseUrl,
      timeoutMs,
      fetchFn,
    });
  } catch (err) {
    // Adapter errors carry their own .code; preserve it on .cause and lift
    // the most useful fields onto the router error so the gateway has a
    // single shape to log.
    const adapterCode = err && typeof err.code === "string" ? err.code : "adapter_unknown_error";
    const gates = err && err.gates;
    const status = err && err.status;
    throw new McpRouterError(
      `adapter refused ${server}/${tool} (${route.verb}): ${err && err.message ? err.message : adapterCode}`,
      {
        code: adapterCode,
        ...ctx,
        gates,
        status,
        cause: err,
      }
    );
  }

  // Defensive: re-verify the report shape. The adapter does this too, but a
  // unified router contract is the place to harden the contract one more
  // time before handing the report to the gateway.
  if (!report || report.schema !== REPORT_SCHEMA) {
    throw new McpRouterError(
      `adapter returned a report without ${REPORT_SCHEMA} schema`,
      { code: "router_report_schema_mismatch", ...ctx, gates: report?.gates }
    );
  }
  if (report.ok === false) {
    throw new McpRouterError(
      `adapter report.ok=false: ${report.refusal || "unspecified"}`,
      { code: report.refusal || "router_report_not_ok", ...ctx, gates: report.gates }
    );
  }

  const router_elapsed_ms = Date.now() - t0;
  return {
    ...report,
    server,
    tool,
    risk_level: route.risk_level,
    router_elapsed_ms,
  };
}

// ─── HTTP handler ───────────────────────────────────────────────────────────

/**
 * Parse `{server}` and `{tool}` out of a `/v1/hermes/mcp/{server}/{tool}`
 * path. Returns null if the path does not match. Exported so the parent
 * server can use the same path grammar without re-implementing it.
 *
 * @param {string} pathname
 * @returns {{ server: string, tool: string } | null}
 */
export function parseMcpPath(pathname) {
  if (typeof pathname !== "string" || !pathname) return null;
  // Accept both with and without /v1 prefix so the handler is reusable
  // regardless of which mount point the server uses.
  const match = pathname.match(
    /^(?:\/v1)?\/hermes\/mcp\/([^/]+)\/([^/?#]+)\/?$/
  );
  if (!match) return null;
  const server = decodeURIComponent(match[1]);
  const tool = decodeURIComponent(match[2]);
  if (!server || !tool) return null;
  return { server, tool };
}

/**
 * Express-style HTTP handler for `POST /v1/hermes/mcp/{server}/{tool}`.
 *
 * Request body (JSON):
 *   {
 *     args: { ... },
 *     lease: { id, allowed, riskLevel, forbidden?, expires_at?, ... },
 *     actor?: string,
 *     targetProject?: string,
 *     operatorApproved?: boolean
 *   }
 *
 * Response:
 *   200 + orange.report.v1 on success (augmented as documented at the top
 *         of this file)
 *   400 on input validation / lookup failure
 *   403 on policy/lease refusal
 *   409 on adapter-side / Hermes-side refusal
 *   504 on Hermes transport timeout
 *   500 on anything unexpected
 *
 * The parent server (src/server.mjs) wires this in as
 *   if (method === "POST" && path.startsWith("/v1/hermes/mcp/"))
 *     return mcpRouterHandler(req, res);
 *
 * @param {object} req — must expose .url and an async .text() or pre-parsed .body
 * @param {object} res — must expose .writeHead, .end
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]    Override Hermes base URL passed through
 * @param {Function}[opts.fetchFn]   Inject fetch (tests)
 */
export async function mcpRouterHandler(req, res, opts = {}) {
  let parsed;
  try {
    const url = new URL(req.url, "http://127.0.0.1");
    parsed = parseMcpPath(url.pathname);
  } catch {
    return writeError(res, 400, { code: "router_arg_invalid", message: "could not parse request URL" });
  }
  if (!parsed) {
    return writeError(res, 404, {
      code: "router_unknown_route",
      message: "path must be /v1/hermes/mcp/{server}/{tool}",
    });
  }
  if (req.method && req.method.toUpperCase() !== "POST") {
    return writeError(res, 405, { code: "router_method_not_allowed", message: "only POST is supported" });
  }

  let body;
  try {
    if (req.body && typeof req.body === "object") {
      body = req.body;
    } else if (typeof req.text === "function") {
      const raw = await req.text();
      body = raw && raw.length > 0 ? JSON.parse(raw) : {};
    } else {
      // Node http server: read the stream.
      body = await readJsonBody(req);
    }
  } catch (err) {
    return writeError(res, 400, {
      code: "router_body_unparseable",
      message: `request body is not valid JSON: ${err && err.message}`,
    });
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return writeError(res, 400, {
      code: "router_arg_invalid",
      message: "request body must be a JSON object with { args, lease, ... }",
    });
  }

  try {
    const report = await routeMcpCall({
      server: parsed.server,
      tool: parsed.tool,
      args: body.args || {},
      lease: body.lease,
      actor: body.actor,
      targetProject: body.targetProject,
      operatorApproved: body.operatorApproved === true,
      baseUrl: opts.baseUrl,
      fetchFn: opts.fetchFn,
    });
    return writeJson(res, 200, report);
  } catch (err) {
    if (err instanceof McpRouterError) {
      const status = mapErrorToHttpStatus(err);
      return writeError(res, status, {
        code: err.code,
        message: err.message,
        server: err.server,
        tool: err.tool,
        verb: err.verb,
        risk_level: err.risk_level,
        requiredRisk: err.requiredRisk,
        leaseRisk: err.leaseRisk,
        gates: err.gates,
      });
    }
    return writeError(res, 500, {
      code: "router_unexpected_error",
      message: err && err.message ? err.message : String(err),
    });
  }
}

function mapErrorToHttpStatus(err) {
  // Lookup / arg failures → 400 (client got the request shape wrong)
  // Lease policy refusals → 403 (request is shaped right; policy says no)
  // Adapter / Hermes refusals → 409 (would conflict with lease/gate state)
  // Timeouts → 504
  // Unknown → 500
  if (typeof err.status === "number" && err.status >= 400 && err.status < 600) {
    return err.status;
  }
  switch (err.code) {
    case "router_arg_invalid":
    case "router_unknown_server":
    case "router_unknown_tool":
    case "router_body_unparseable":
      return 400;
    case "router_lease_missing":
    case "router_lease_malformed":
    case "router_lease_expired":
    case "router_lease_risk_unknown":
    case "router_lease_risk_insufficient":
    case "router_lease_verb_not_allowed":
    case "router_lease_verb_forbidden":
    case "router_lease_wide_forbidden":
      return 403;
    case "hermes_timeout":
      return 504;
    case "report_schema_mismatch":
    case "router_report_schema_mismatch":
    case "router_report_not_ok":
    case "hermes_bad_response":
      return 502;
    default:
      // Adapter/Hermes refusal codes (lease_*, gate_*, mcp_*, etc.) → 409
      return 409;
  }
}

function writeJson(res, status, body) {
  const payload = JSON.stringify(body);
  if (typeof res.writeHead === "function") {
    res.writeHead(status, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(payload),
    });
  } else if (typeof res.status === "function") {
    res.status(status);
    res.set?.("content-type", "application/json");
  }
  res.end(payload);
}

function writeError(res, status, body) {
  return writeJson(res, status, { ok: false, ...body });
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    const LIMIT = 1_000_000; // 1 MB — orders are tiny; protect the daemon
    req.on("data", (chunk) => {
      total += chunk.length;
      if (total > LIMIT) {
        reject(new Error(`request body exceeded ${LIMIT} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      try {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve(raw.length === 0 ? {} : JSON.parse(raw));
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

// ─── module metadata (for diagnostics / discovery) ──────────────────────────

export const ROUTER_META = Object.freeze({
  id: ROUTER_ID,
  report_schema: REPORT_SCHEMA,
  risk_ladder: RISK_LADDER,
  hermes_wide_forbidden: HERMES_WIDE_FORBIDDEN,
  adapters: Object.freeze(Object.keys(ADAPTERS)),
  servers: Object.freeze(Object.keys(TOOL_ROUTES)),
  // Snapshot of every (server, tool) → verb/risk_level the router exposes.
  // Frozen so a downstream observer can rely on it without defensive copy.
  routes: Object.freeze(
    Object.fromEntries(
      Object.entries(TOOL_ROUTES).map(([srv, toolMap]) => [
        srv,
        Object.freeze(
          Object.fromEntries(
            Object.entries(toolMap).map(([tool, route]) => [
              tool,
              Object.freeze({ verb: route.verb, risk_level: route.risk_level }),
            ])
          )
        ),
      ])
    )
  ),
});

// Re-export the adapter error classes so callers that want to do `instanceof`
// matching on the cause can do so without reaching into adapters/.
export { CdHermesAdapterError, CuHermesAdapterError };
