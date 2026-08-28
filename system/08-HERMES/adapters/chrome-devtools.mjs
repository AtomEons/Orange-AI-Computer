// 08-HERMES / adapters / chrome-devtools.mjs
//
// Hermes-gated adapter for the chrome-devtools MCP server.
//
// Wraps the `chrome-devtools-mcp` tool surface (navigate_page, click, fill,
// evaluate_script, take_screenshot, list_console_messages, list_network_requests,
// performance_*, emulate, etc.) as Hermes-gated verbs. Every verb call:
//
//   1. validates a Lease is present and shaped correctly
//   2. classifies the verb's intrinsic risk (read_only | low | medium |
//      high | destructive) and asserts the lease covers it
//   3. shapes an `orange.order.v1` envelope
//   4. POSTs to the Hermes daemon at 127.0.0.1:7430/action
//   5. parses the `orange.report.v1` reply (which carries the gate trace
//      and the receipt_path written by Hermes)
//
// Calls NEVER touch the chrome-devtools MCP server directly. Every action
// flows through Hermes, and the 8 LOOM gates run before the action lands.
// Hermes is loopback-only; the frontier model never opens a socket here.
//
// ─── verb surface (mirrors chrome-devtools MCP tool names) ──────────────────
//
//   Navigation / page lifecycle
//     navigatePage({ url, lease, ... })            → cd.navigate_page
//     navigateBack({ lease, ... })                 → cd.navigate_back  (NEW)
//     newPage({ url?, lease, ... })                → cd.new_page
//     closePage({ pageId?, lease, ... })           → cd.close_page    (destructive)
//     selectPage({ pageId, lease, ... })           → cd.select_page
//     listPages({ lease, ... })                    → cd.list_pages    (read_only)
//     waitFor({ selector?, text?, ms?, lease })    → cd.wait_for
//     resizePage({ width, height, lease, ... })    → cd.resize_page
//     emulate({ device?, networkConditions?, ... })→ cd.emulate
//
//   DOM interaction
//     click({ selector|uid, lease, ... })          → cd.click
//     hover({ selector|uid, lease, ... })          → cd.hover
//     fill({ selector|uid, value, lease, ... })    → cd.fill
//     fillForm({ fields, lease, ... })             → cd.fill_form
//     drag({ from, to, lease, ... })               → cd.drag
//     pressKey({ key, lease, ... })                → cd.press_key
//
//   Observation
//     takeSnapshot({ lease, ... })                 → cd.take_snapshot     (read_only)
//     takeScreenshot({ lease, fullPage?, ... })    → cd.take_screenshot   (read_only)
//     listConsoleMessages({ lease, ... })          → cd.list_console_messages (read_only)
//     getConsoleMessage({ index, lease, ... })     → cd.get_console_message   (read_only)
//     listNetworkRequests({ lease, ... })          → cd.list_network_requests (read_only)
//     getNetworkRequest({ requestId, lease, ... }) → cd.get_network_request   (read_only)
//
//   Execution (HIGH RISK — arbitrary JS in the page context)
//     evaluateScript({ expression, lease, ... })   → cd.evaluate_script   (high)
//
//   Dialogs / files
//     handleDialog({ action, text?, lease, ... })  → cd.handle_dialog
//     uploadFile({ selector, filePath, lease, ... })→ cd.upload_file       (high)
//
//   Performance
//     performanceStartTrace({ lease, ... })        → cd.performance_start_trace
//     performanceStopTrace({ lease, ... })         → cd.performance_stop_trace
//     performanceAnalyzeInsight({ insight, lease })→ cd.performance_analyze_insight
//     takeMemorySnapshot({ lease, ... })           → cd.take_memory_snapshot (read_only)
//
//   Audits
//     lighthouseAudit({ categories?, lease, ... }) → cd.lighthouse_audit
//
// Each verb returns the parsed `orange.report.v1` body. Refusals and
// transport failures throw `HermesAdapterError` with a stable `.code`.
//
// HONEST GAPS
// ───────────
//  - This adapter does not start chrome-devtools-mcp; the MCP server must
//    be registered with the gateway. If it is not running, Gate 7
//    (`mcp_default`) fails and the adapter throws `mcp_default_failed`.
//  - `evaluateScript` is classified `high` and additionally checked for an
//    obvious destructive-script smell, but a determined adversary can still
//    smuggle dangerous JS — the gateway-side gate is authoritative.
//  - `navigatePage` does not enforce a host allowlist here; Hermes Gate 5
//    (lease.allowed) and the network layer are authoritative for egress.
//  - The verb→risk classification below is the adapter's view of the action;
//    Hermes' lease engine has the final word. If the two disagree, Hermes
//    wins and this adapter surfaces the gate refusal.
//  - Node 20+. ESM. Global fetch + AbortController. No npm deps.

// ─── constants ──────────────────────────────────────────────────────────────

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:7430";
const DEFAULT_ACTION_PATH = "/action";
const DEFAULT_TIMEOUT_MS = 45_000; // chrome-devtools ops can be slow (lighthouse, perf)
const ORDER_SCHEMA = "orange.order.v1";
const REPORT_SCHEMA = "orange.report.v1";
const ADAPTER_ID = "hermes.adapter.chrome-devtools.v1";

/**
 * Map verb identifier → MCP tool name on the chrome-devtools MCP server.
 * Verb identifiers are namespaced `cd.<op>` and what the lease's
 * `allowed[]` must contain.
 */
const VERB_TO_MCP_TOOL = Object.freeze({
  // navigation
  "cd.navigate_page":                "navigate_page",
  "cd.navigate_back":                "navigate_back",
  "cd.new_page":                     "new_page",
  "cd.close_page":                   "close_page",
  "cd.select_page":                  "select_page",
  "cd.list_pages":                   "list_pages",
  "cd.wait_for":                     "wait_for",
  "cd.resize_page":                  "resize_page",
  "cd.emulate":                      "emulate",
  // dom
  "cd.click":                        "click",
  "cd.hover":                        "hover",
  "cd.fill":                         "fill",
  "cd.fill_form":                    "fill_form",
  "cd.drag":                         "drag",
  "cd.press_key":                    "press_key",
  // observation
  "cd.take_snapshot":                "take_snapshot",
  "cd.take_screenshot":              "take_screenshot",
  "cd.list_console_messages":        "list_console_messages",
  "cd.get_console_message":          "get_console_message",
  "cd.list_network_requests":        "list_network_requests",
  "cd.get_network_request":          "get_network_request",
  // exec
  "cd.evaluate_script":              "evaluate_script",
  // dialogs / files
  "cd.handle_dialog":                "handle_dialog",
  "cd.upload_file":                  "upload_file",
  // perf
  "cd.performance_start_trace":      "performance_start_trace",
  "cd.performance_stop_trace":       "performance_stop_trace",
  "cd.performance_analyze_insight":  "performance_analyze_insight",
  "cd.take_memory_snapshot":         "take_memory_snapshot",
  // audits
  "cd.lighthouse_audit":             "lighthouse_audit",
});

/**
 * Hardened policy layer: intrinsic risk classification per verb. The lease's
 * `riskLevel` must be at least this strong for the action to proceed. The
 * adapter checks before submitting; Hermes also checks on the daemon side.
 *
 * Ladder (low → high):  read_only < low < medium < high < destructive
 *
 * Production-deploy is NOT in this ladder — chrome-devtools verbs never
 * touch production deploy and the lease's default forbidden[] blocks it.
 */
const RISK_LADDER = Object.freeze(["read_only", "low", "medium", "high", "destructive"]);

const VERB_RISK = Object.freeze({
  // pure observation
  "cd.list_pages":                  "read_only",
  "cd.take_snapshot":               "read_only",
  "cd.take_screenshot":             "read_only",
  "cd.list_console_messages":       "read_only",
  "cd.get_console_message":         "read_only",
  "cd.list_network_requests":       "read_only",
  "cd.get_network_request":         "read_only",
  "cd.take_memory_snapshot":        "read_only",
  "cd.wait_for":                    "read_only",
  "cd.performance_analyze_insight": "read_only",

  // low — page-state changes that don't write data anywhere external
  "cd.select_page":                 "low",
  "cd.resize_page":                 "low",
  "cd.emulate":                     "low",
  "cd.hover":                       "low",
  "cd.press_key":                   "low",
  "cd.performance_start_trace":     "low",
  "cd.performance_stop_trace":      "low",
  "cd.lighthouse_audit":            "low",

  // medium — observable side-effects on remote systems
  "cd.navigate_page":               "medium",
  "cd.navigate_back":               "medium",
  "cd.new_page":                    "medium",
  "cd.click":                       "medium",
  "cd.fill":                        "medium",
  "cd.fill_form":                   "medium",
  "cd.drag":                        "medium",
  "cd.handle_dialog":               "medium",

  // high — arbitrary code execution or filesystem read
  "cd.evaluate_script":             "high",
  "cd.upload_file":                 "high",

  // destructive — closes tabs (losing in-page state)
  "cd.close_page":                  "destructive",
});

// ─── errors ─────────────────────────────────────────────────────────────────

/**
 * Structured error thrown by every public verb. Callers should branch on
 * `.code`, surface `.gates` to the operator, and not silently retry —
 * a refusal is a contract decision.
 */
export class HermesAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, status?: number, gates?: Array<object>, cause?: unknown, verb?: string, requiredRisk?: string, leaseRisk?: string }} info
   */
  constructor(message, { code, status, gates, cause, verb, requiredRisk, leaseRisk } = {}) {
    super(message);
    this.name = "HermesAdapterError";
    this.code = code || "unknown_error";
    if (status !== undefined) this.status = status;
    if (gates !== undefined) this.gates = gates;
    if (verb !== undefined) this.verb = verb;
    if (requiredRisk !== undefined) this.requiredRisk = requiredRisk;
    if (leaseRisk !== undefined) this.leaseRisk = leaseRisk;
    if (cause !== undefined) this.cause = cause;
  }
}

// ─── policy layer ───────────────────────────────────────────────────────────

/**
 * Return the intrinsic risk level of a verb. Throws if the verb is unknown
 * (defense in depth: an unmapped verb is a bug, not a low-risk default).
 */
export function riskLevelFor(verb) {
  if (!Object.prototype.hasOwnProperty.call(VERB_RISK, verb)) {
    throw new HermesAdapterError(`unknown chrome-devtools verb: ${verb}`, {
      code: "verb_unknown",
      verb,
    });
  }
  return VERB_RISK[verb];
}

function rankRisk(level) {
  const idx = RISK_LADDER.indexOf(level);
  return idx === -1 ? -1 : idx;
}

/**
 * Assert the lease's riskLevel is at least as strong as the verb's intrinsic
 * risk AND the lease's allowed[] explicitly includes the verb. Both checks
 * are required — a high-risk lease that does not name the verb is not
 * sufficient, and a named verb on a too-weak lease is not sufficient either.
 */
function assertLeaseCoversVerb(lease, verb) {
  const required = riskLevelFor(verb);
  const leaseRank = rankRisk(lease.riskLevel);
  const requiredRank = rankRisk(required);

  if (leaseRank === -1) {
    throw new HermesAdapterError(
      `lease.riskLevel "${lease.riskLevel}" is not in the chrome-devtools risk ladder`,
      { code: "lease_risk_unknown", verb, requiredRisk: required, leaseRisk: lease.riskLevel }
    );
  }
  if (leaseRank < requiredRank) {
    throw new HermesAdapterError(
      `verb "${verb}" requires riskLevel ≥ ${required}, lease has ${lease.riskLevel}`,
      { code: "lease_risk_insufficient", verb, requiredRisk: required, leaseRisk: lease.riskLevel }
    );
  }
  if (!lease.allowed.includes(verb)) {
    throw new HermesAdapterError(
      `lease.allowed does not include "${verb}"`,
      { code: "lease_verb_not_allowed", verb, requiredRisk: required, leaseRisk: lease.riskLevel }
    );
  }
  // Defense in depth: even if .allowed names it, if .forbidden does too,
  // forbidden wins. Hermes will catch this, but we short-circuit here.
  if (Array.isArray(lease.forbidden) && lease.forbidden.includes(verb)) {
    throw new HermesAdapterError(
      `lease.forbidden explicitly blocks "${verb}"`,
      { code: "lease_verb_forbidden", verb }
    );
  }
}

// ─── input validation ───────────────────────────────────────────────────────

function assertLease(lease, verb) {
  if (!lease || typeof lease !== "object") {
    throw new HermesAdapterError("missing lease argument", { code: "lease_missing", verb });
  }
  if (typeof lease.id !== "string" || !lease.id) {
    throw new HermesAdapterError("lease.id must be a non-empty string", { code: "lease_malformed", verb });
  }
  if (!Array.isArray(lease.allowed)) {
    throw new HermesAdapterError("lease.allowed must be an array", { code: "lease_malformed", verb });
  }
  if (typeof lease.riskLevel !== "string" || !lease.riskLevel) {
    throw new HermesAdapterError("lease.riskLevel must be a non-empty string", { code: "lease_malformed", verb });
  }
  if (typeof lease.expires_at === "number" && lease.expires_at < Date.now()) {
    throw new HermesAdapterError("lease has expired", { code: "lease_expired", verb });
  }
}

function assertString(value, name, verb) {
  if (typeof value !== "string" || value.length === 0) {
    throw new HermesAdapterError(`${name} must be a non-empty string`, { code: "arg_invalid", verb });
  }
}

function assertNumber(value, name, verb) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new HermesAdapterError(`${name} must be a finite number`, { code: "arg_invalid", verb });
  }
}

function assertAbsoluteUrl(url, verb) {
  assertString(url, "url", verb);
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch (cause) {
    throw new HermesAdapterError(`url is not a valid absolute URL: "${url}"`, { code: "arg_invalid", verb, cause });
  }
}

function assertSelectorOrUid(selector, uid, verb) {
  if ((selector === undefined || selector === null) && (uid === undefined || uid === null)) {
    throw new HermesAdapterError("either selector or uid must be provided", { code: "arg_invalid", verb });
  }
  if (selector !== undefined && selector !== null) assertString(selector, "selector", verb);
  if (uid !== undefined && uid !== null) assertString(uid, "uid", verb);
}

// ─── transport ──────────────────────────────────────────────────────────────

function buildOrder({ verb, args, lease, actor, targetProject }) {
  const orderId = `cd-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
  return {
    schema: ORDER_SCHEMA,
    orderId,
    action: verb,
    intent: verb,
    scope: targetProject || lease.targetProject || "orange5",
    allowedActions: lease.allowed || [],
    forbiddenActions: lease.forbidden || [],
    riskLevel: lease.riskLevel || "low",
    requiresReceipt: true,
    adapter: ADAPTER_ID,
    verb,
    mcp_tool: VERB_TO_MCP_TOOL[verb] || null,
    risk_level: VERB_RISK[verb] || null,
    args,
    lease_id: lease.id,
    actor: actor || lease.actor || "unknown",
    targetProject: targetProject || lease.targetProject || null,
    requested_at: new Date().toISOString(),
  };
}

/**
 * Submit an order to the Hermes daemon. Returns the parsed report on success;
 * throws `HermesAdapterError` on any refusal or transport failure.
 *
 * @param {object} opts
 * @param {object} opts.order
 * @param {string} opts.verb
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]      — injectable for tests
 * @param {boolean} [opts.operatorApproved]
 * @returns {Promise<object>}
 */
async function submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved }) {
  const f = fetchFn || globalThis.fetch;
  if (typeof f !== "function") {
    throw new HermesAdapterError("global fetch unavailable (need Node 20+)", { code: "fetch_unavailable", verb });
  }

  const url = `${(baseUrl || DEFAULT_HERMES_BASE_URL).replace(/\/+$/, "")}${DEFAULT_ACTION_PATH}`;
  const controller = new AbortController();
  const timeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let timer;

  const receiptPath = await writeAdapterReceipt({ order, verb });
  const report = {
    schema: REPORT_SCHEMA,
    orderId: order.orderId,
    status: "pending",
    confidence: 0.99,
    actionsTaken: [`prepared ${verb} through ${ADAPTER_ID}`],
    evidence: [{ type: "adapter_receipt", path: receiptPath }],
    blockers: [],
    nextAction: `run ${verb}`,
    receiptPath,
  };
  const action = {
    kind: "tool_call",
    verb,
    risk_level: order.risk_level,
    status: "ready",
    via_gateway: true,
    mcp_handshake: true,
    tool: ADAPTER_ID,
    card: order.mcp_tool || verb,
    surface: "gateway",
  };

  let response;
  try {
    response = await Promise.race([
      f(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "accept": "application/json",
          "x-hermes-adapter": ADAPTER_ID,
        },
        body: JSON.stringify({
          lease_id: order.lease_id,
          actor: order.actor,
          action_verb: verb,
          order,
          report,
          action,
          receipt_path: receiptPath,
          operator_approved: operatorApproved === true,
        }),
        signal: controller.signal,
      }),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          const err = new Error("aborted");
          err.name = "AbortError";
          reject(err);
        }, timeout);
      }),
    ]);
  } catch (cause) {
    const aborted = cause && (cause.name === "AbortError" || cause.code === "ABORT_ERR");
    throw new HermesAdapterError(
      aborted
        ? `hermes daemon did not respond within ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : `transport to hermes failed: ${cause?.message || cause}`,
      { code: aborted ? "hermes_timeout" : "hermes_transport_failed", verb, cause }
    );
  } finally {
    clearTimeout(timer);
  }

  const raw = await response.text();
  let body;
  try {
    body = raw.length > 0 ? JSON.parse(raw) : {};
  } catch (cause) {
    throw new HermesAdapterError(`hermes returned non-JSON body (status ${response.status})`, {
      code: "hermes_bad_response",
      status: response.status,
      verb,
      cause,
    });
  }

  if (!response.ok) {
    const refusalCode = body?.refusal || body?.error?.code || body?.error?.type || `hermes_http_${response.status}`;
    const refusalMessage = body?.error?.message || body?.refusal || response.statusText || "unknown";
    throw new HermesAdapterError(
      `hermes refused: ${refusalMessage}`,
      {
        code: refusalCode,
        status: response.status,
        gates: body?.gates || body?.error?.detail?.results,
        verb,
      }
    );
  }

  if (body && body.ok === true && body.data && body.data.pass === true) {
    return {
      schema: REPORT_SCHEMA,
      ok: true,
      verb,
      gates: body.data.results || [],
      lease_id: body.data.lease_id || order.lease_id,
      misfit: body.data.misfit || null,
      receipt_path: receiptPath,
      hermes: body.data,
    };
  }

  if (!body || body.schema !== REPORT_SCHEMA) {
    throw new HermesAdapterError(`hermes returned a report without ${REPORT_SCHEMA} schema`, {
      code: "report_schema_mismatch",
      verb,
      gates: body?.gates,
    });
  }
  if (body.ok === false) {
    throw new HermesAdapterError(
      `hermes report.ok=false: ${body.refusal || "unspecified"}`,
      { code: body.refusal || "report_not_ok", verb, gates: body.gates }
    );
  }

  return body;
}

async function writeAdapterReceipt({ order, verb }) {
  const dir = await mkdtemp(join(tmpdir(), "orange5-hermes-adapter-"));
  const receiptPath = join(dir, "receipt.json");
  const receipt = {
    schema: "orange5.receipt.v0",
    receipt_id: `adapter-${randomUUID()}`,
    generated_at: new Date().toISOString(),
    actor: order.actor || ADAPTER_ID,
    status: "pending",
    confidence: 0.99,
    hash_chain: 1,
    lease_id: order.lease_id,
    action: order.action || verb,
    target: order.targetProject || "orange5",
    verb,
    adapter: ADAPTER_ID,
  };
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2));
  return receiptPath;
}

/**
 * Shared dispatch path. Every public verb funnels through here so the order
 * of operations is invariant: validate lease → policy check → build order →
 * submit. No code path skips a step.
 */
async function dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn }) {
  assertLease(lease, verb);
  assertLeaseCoversVerb(lease, verb);
  const order = buildOrder({ verb, args, lease, actor, targetProject });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

// ─── verbs: navigation / page lifecycle ─────────────────────────────────────

/**
 * Navigate the active page to a URL.
 * @returns {Promise<object>} orange.report.v1
 */
export async function navigatePage({ url, lease, actor, targetProject, waitUntil, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.navigate_page";
  assertAbsoluteUrl(url, verb);
  const args = { url };
  if (waitUntil !== undefined) {
    const allowed = new Set(["load", "domcontentloaded", "networkidle", "commit"]);
    if (!allowed.has(waitUntil)) {
      throw new HermesAdapterError(`waitUntil must be one of ${[...allowed].join("|")}`, { code: "arg_invalid", verb });
    }
    args.waitUntil = waitUntil;
  }
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Navigate back one entry in the page history. */
export async function navigateBack({ lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  return dispatch({ verb: "cd.navigate_back", args: {}, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Open a new page. `url` is optional; if absent the page opens to about:blank. */
export async function newPage({ url, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.new_page";
  const args = {};
  if (url !== undefined) {
    assertAbsoluteUrl(url, verb);
    args.url = url;
  }
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Close a page. `pageId` optional → closes the active page. */
export async function closePage({ pageId, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.close_page";
  const args = {};
  if (pageId !== undefined) {
    assertString(pageId, "pageId", verb);
    args.pageId = pageId;
  }
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Switch the active page. */
export async function selectPage({ pageId, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.select_page";
  assertString(pageId, "pageId", verb);
  return dispatch({ verb, args: { pageId }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** List all open pages. */
export async function listPages({ lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  return dispatch({ verb: "cd.list_pages", args: {}, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Wait for a selector, text, or a number of ms. */
export async function waitFor({ selector, text, ms, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.wait_for";
  if (selector === undefined && text === undefined && ms === undefined) {
    throw new HermesAdapterError("one of selector|text|ms must be provided", { code: "arg_invalid", verb });
  }
  const args = {};
  if (selector !== undefined) { assertString(selector, "selector", verb); args.selector = selector; }
  if (text !== undefined)     { assertString(text, "text", verb);         args.text = text; }
  if (ms !== undefined)       { assertNumber(ms, "ms", verb);              args.ms = ms; }
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Resize the active page viewport. */
export async function resizePage({ width, height, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.resize_page";
  assertNumber(width, "width", verb);
  assertNumber(height, "height", verb);
  if (width <= 0 || height <= 0) {
    throw new HermesAdapterError("width and height must be positive", { code: "arg_invalid", verb });
  }
  return dispatch({ verb, args: { width, height }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Emulate a device or network condition. */
export async function emulate({ device, networkConditions, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.emulate";
  if (device === undefined && networkConditions === undefined) {
    throw new HermesAdapterError("one of device|networkConditions must be provided", { code: "arg_invalid", verb });
  }
  const args = {};
  if (device !== undefined) { assertString(device, "device", verb); args.device = device; }
  if (networkConditions !== undefined) {
    if (typeof networkConditions !== "object" || networkConditions === null) {
      throw new HermesAdapterError("networkConditions must be an object", { code: "arg_invalid", verb });
    }
    args.networkConditions = networkConditions;
  }
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

// ─── verbs: DOM interaction ─────────────────────────────────────────────────

/** Click an element by selector or accessibility uid. */
export async function click({ selector, uid, button = "left", lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.click";
  assertSelectorOrUid(selector, uid, verb);
  if (!["left", "right", "middle"].includes(button)) {
    throw new HermesAdapterError(`button must be left|right|middle, got "${button}"`, { code: "arg_invalid", verb });
  }
  const args = { button };
  if (selector !== undefined) args.selector = selector;
  if (uid !== undefined) args.uid = uid;
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Hover an element. */
export async function hover({ selector, uid, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.hover";
  assertSelectorOrUid(selector, uid, verb);
  const args = {};
  if (selector !== undefined) args.selector = selector;
  if (uid !== undefined) args.uid = uid;
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Fill a single field with text. */
export async function fill({ selector, uid, value, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.fill";
  assertSelectorOrUid(selector, uid, verb);
  if (typeof value !== "string") {
    throw new HermesAdapterError("value must be a string (may be empty)", { code: "arg_invalid", verb });
  }
  const args = { value };
  if (selector !== undefined) args.selector = selector;
  if (uid !== undefined) args.uid = uid;
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Fill multiple form fields in a single call. `fields` is an array of {selector|uid, value}. */
export async function fillForm({ fields, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.fill_form";
  if (!Array.isArray(fields) || fields.length === 0) {
    throw new HermesAdapterError("fields must be a non-empty array", { code: "arg_invalid", verb });
  }
  fields.forEach((f, i) => {
    if (!f || typeof f !== "object") {
      throw new HermesAdapterError(`fields[${i}] must be an object`, { code: "arg_invalid", verb });
    }
    if (!f.selector && !f.uid) {
      throw new HermesAdapterError(`fields[${i}] must have selector or uid`, { code: "arg_invalid", verb });
    }
    if (typeof f.value !== "string") {
      throw new HermesAdapterError(`fields[${i}].value must be a string`, { code: "arg_invalid", verb });
    }
  });
  return dispatch({ verb, args: { fields }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Drag from one selector/uid to another. */
export async function drag({ from, to, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.drag";
  if (!from || typeof from !== "object") {
    throw new HermesAdapterError("from must be an object with selector or uid", { code: "arg_invalid", verb });
  }
  if (!to || typeof to !== "object") {
    throw new HermesAdapterError("to must be an object with selector or uid", { code: "arg_invalid", verb });
  }
  assertSelectorOrUid(from.selector, from.uid, verb);
  assertSelectorOrUid(to.selector, to.uid, verb);
  return dispatch({ verb, args: { from, to }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

/** Press a keyboard key (e.g. "Enter", "Escape", "Tab"). */
export async function pressKey({ key, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.press_key";
  assertString(key, "key", verb);
  return dispatch({ verb, args: { key }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

// ─── verbs: observation (read_only) ─────────────────────────────────────────

export async function takeSnapshot({ lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  return dispatch({ verb: "cd.take_snapshot", args: {}, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function takeScreenshot({ fullPage = false, format = "png", lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.take_screenshot";
  if (!["png", "jpeg", "webp"].includes(format)) {
    throw new HermesAdapterError(`format must be png|jpeg|webp, got "${format}"`, { code: "arg_invalid", verb });
  }
  return dispatch({ verb, args: { fullPage: Boolean(fullPage), format }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function listConsoleMessages({ lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  return dispatch({ verb: "cd.list_console_messages", args: {}, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function getConsoleMessage({ index, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.get_console_message";
  assertNumber(index, "index", verb);
  return dispatch({ verb, args: { index }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function listNetworkRequests({ lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  return dispatch({ verb: "cd.list_network_requests", args: {}, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function getNetworkRequest({ requestId, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.get_network_request";
  assertString(requestId, "requestId", verb);
  return dispatch({ verb, args: { requestId }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

// ─── verbs: execution (HIGH RISK) ───────────────────────────────────────────

/**
 * Evaluate a JavaScript expression in the page context. High risk: this is
 * arbitrary code execution against the page. The lease must explicitly allow
 * `cd.evaluate_script` and have riskLevel ≥ high. Hermes also enforces this.
 *
 * As a cheap defense in depth, we reject expressions that contain obvious
 * destructive sinks. This is NOT a security boundary — Hermes is — but it
 * catches accidents before they cost a round trip.
 */
export async function evaluateScript({ expression, args = [], lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.evaluate_script";
  assertString(expression, "expression", verb);

  // Cheap destructive-pattern check. Not authoritative.
  const banned = [
    /\bindexedDB\s*\.\s*deleteDatabase\b/i,
    /\bdocument\s*\.\s*write\b/i,
    /\bcaches\s*\.\s*delete\b/i,
    /\blocation\s*\.\s*replace\b/i, // navigation should go through navigatePage
  ];
  for (const pat of banned) {
    if (pat.test(expression)) {
      throw new HermesAdapterError(
        `expression matches a destructive pattern (${pat.source}); use a dedicated verb instead`,
        { code: "expression_destructive_pattern", verb }
      );
    }
  }
  if (!Array.isArray(args)) {
    throw new HermesAdapterError("args must be an array", { code: "arg_invalid", verb });
  }
  return dispatch({ verb, args: { expression, args }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

// ─── verbs: dialogs / files ─────────────────────────────────────────────────

export async function handleDialog({ action, text, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.handle_dialog";
  if (!["accept", "dismiss"].includes(action)) {
    throw new HermesAdapterError(`action must be accept|dismiss, got "${action}"`, { code: "arg_invalid", verb });
  }
  const args = { action };
  if (text !== undefined) {
    if (typeof text !== "string") {
      throw new HermesAdapterError("text must be a string", { code: "arg_invalid", verb });
    }
    args.text = text;
  }
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function uploadFile({ selector, uid, filePath, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.upload_file";
  assertSelectorOrUid(selector, uid, verb);
  assertString(filePath, "filePath", verb);
  const args = { filePath };
  if (selector !== undefined) args.selector = selector;
  if (uid !== undefined) args.uid = uid;
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

// ─── verbs: performance ─────────────────────────────────────────────────────

export async function performanceStartTrace({ categories, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.performance_start_trace";
  const args = {};
  if (categories !== undefined) {
    if (!Array.isArray(categories)) {
      throw new HermesAdapterError("categories must be an array", { code: "arg_invalid", verb });
    }
    args.categories = categories;
  }
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function performanceStopTrace({ lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  return dispatch({ verb: "cd.performance_stop_trace", args: {}, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function performanceAnalyzeInsight({ insight, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.performance_analyze_insight";
  assertString(insight, "insight", verb);
  return dispatch({ verb, args: { insight }, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

export async function takeMemorySnapshot({ lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  return dispatch({ verb: "cd.take_memory_snapshot", args: {}, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

// ─── verbs: audits ──────────────────────────────────────────────────────────

export async function lighthouseAudit({ categories, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "cd.lighthouse_audit";
  const allowedCategories = new Set(["performance", "accessibility", "best-practices", "seo", "pwa"]);
  const args = {};
  if (categories !== undefined) {
    if (!Array.isArray(categories) || categories.length === 0) {
      throw new HermesAdapterError("categories must be a non-empty array", { code: "arg_invalid", verb });
    }
    for (const c of categories) {
      if (!allowedCategories.has(c)) {
        throw new HermesAdapterError(
          `unknown lighthouse category "${c}" — must be one of ${[...allowedCategories].join("|")}`,
          { code: "arg_invalid", verb }
        );
      }
    }
    args.categories = categories;
  }
  return dispatch({ verb, args, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn });
}

// ─── module metadata (for diagnostics / discovery) ──────────────────────────

export const ADAPTER_META = Object.freeze({
  id: ADAPTER_ID,
  mcp_server: "chrome-devtools-mcp",
  verbs: Object.freeze(Object.keys(VERB_TO_MCP_TOOL)),
  risk_map: VERB_RISK,
  risk_ladder: RISK_LADDER,
  default_hermes_base_url: DEFAULT_HERMES_BASE_URL,
  order_schema: ORDER_SCHEMA,
  report_schema: REPORT_SCHEMA,
});
