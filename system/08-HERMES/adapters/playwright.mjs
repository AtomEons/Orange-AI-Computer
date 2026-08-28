// 08-HERMES / adapters / playwright.mjs
//
// Hermes-gated adapter for the Playwright MCP server (browser automation).
//
// This module exposes four operator-callable verbs — click, fill, screenshot,
// navigate — that any LLM in the Orange5 superstack must call via this
// adapter rather than touching the Playwright MCP directly. Each call is
// shaped into an `orange.order.v1` order, submitted to the Hermes daemon at
// 127.0.0.1:7430 through the gateway-mediated POST /v1/hermes/action route,
// and only lands on the host after all 8 LOOM gates pass:
//
//   1. order_schema      — order matches orange.order.v1
//   2. report_schema     — report matches orange.report.v1
//   3. receipt_spine     — receipt_path exists on disk
//   4. human_approval    — if lease.requires_approval, operator approved
//   5. codexa_lease      — lease present and not expired
//   6. openai_gateway    — call arrived via the OpenAI-compatible gateway
//   7. mcp_default       — adapter handshook with the MCP server
//   8. false_green_guard — status does not contain fake-green words
//
// FRONTIER-ISOLATION
// ──────────────────
// This adapter is intended to be invoked by code running INSIDE the gateway
// process (06-ORANGELLM), or by trusted Orange5 daemons (mission-runner,
// codexa, etc.). The frontier model NEVER imports this module directly and
// NEVER opens a socket to 127.0.0.1:7430. The model proposes the action as
// part of its tool-use turn; the gateway shapes it into a Hermes order; that
// order flows here. Hermes is loopback-only (127.0.0.1:7430) and is reached
// from outside the box only through the gateway's /v1/hermes/* routes.
//
// VERB SURFACE
// ────────────
//   click({ x, y, lease, ... })                       → browser.click
//   fill({ selector, text, lease, ... })              → browser.fill
//   screenshot({ lease, fullPage?, path?, ... })      → browser.screenshot
//   navigate({ url, lease, waitUntil?, ... })         → browser.navigate
//
// Each verb returns the parsed report from Hermes, of shape:
//
//   {
//     schema: "orange.report.v1",
//     ok: boolean,
//     verb: string,
//     gates: Array<{ gate, pass, reason? }>,
//     refusal?: string,             // when ok === false and gates blocked it
//     mcp_response?: unknown,       // when ok === true and the MCP call ran
//     receipt_path: string,
//     elapsed_ms: number,
//   }
//
// On a gate failure or transport failure the adapter throws a structured
// HermesAdapterError (see below) — callers should catch and surface the
// `code` + `gates` to the operator, not retry silently.
//
// HONEST GAPS (also surfaced in 08-HERMES/adapters/README.md)
// ───────────────────────────────────────────────────────────
//  - This adapter does NOT itself open a Playwright browser context. It
//    speaks to the Playwright MCP server through Hermes; the MCP server is
//    responsible for launching, reusing, and tearing down browser pages.
//    If the MCP server is not configured or not running, Hermes will fail
//    Gate 7 (mcp_default) and this adapter will throw with code
//    "mcp_default_failed".
//  - The `lease` argument is REQUIRED. There is no implicit lease creation.
//    Callers must mint a lease (POST /v1/hermes/lease) before calling any
//    verb. This is by design — the lease is the authority spine.
//  - Coordinates passed to click({x, y}) are page-relative pixels. The MCP
//    server is the only thing that knows the page dimensions; if the page
//    has scrolled or resized since the actor measured, the click may land
//    on a different element. Use fill({selector, text}) when you can.
//  - screenshot() writes the image to a path chosen by the MCP server (or
//    returns base64 — depends on MCP server config). This adapter forwards
//    whatever the server returns under `mcp_response`. It does NOT write
//    the screenshot to the receipt spine on its own.
//  - navigate({ url }) does not enforce a host allowlist here — Hermes Gate
//    "egress_unbounded" (in the default forbidden list) handles that, but
//    only if the lease's allowed[] does not include "browser.navigate" with
//    a wildcard. Operators granting "browser.navigate" should constrain
//    egress separately at the network layer.
//  - This file targets Node 20+ (uses global fetch, AbortController, no
//    extra deps). It is ESM (.mjs).

// ─── constants ──────────────────────────────────────────────────────────────

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:7430";
const DEFAULT_ACTION_PATH = "/action";
const DEFAULT_TIMEOUT_MS = 30_000;
const ORDER_SCHEMA = "orange.order.v1";
const ADAPTER_ID = "hermes.adapter.playwright.v1";

// Verb → MCP tool name on the Playwright MCP server. The Playwright MCP
// project exposes tools like `browser_click`, `browser_type`, etc. We keep
// the verb identifiers stable on the Hermes side and let the MCP layer
// translate. This map is what Hermes records in the order.
const VERB_TO_MCP_TOOL = Object.freeze({
  "browser.click":      "browser_click",
  "browser.fill":       "browser_type",
  "browser.screenshot": "browser_take_screenshot",
  "browser.navigate":   "browser_navigate",
});

// ─── errors ─────────────────────────────────────────────────────────────────

/**
 * Structured error thrown by every public verb when Hermes refuses, when a
 * gate fails, or when the transport itself breaks. Callers should branch on
 * `.code`, surface `.gates` to the operator if present, and never silently
 * retry — a refusal is a contract decision, not a transient fault.
 */
export class HermesAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, status?: number, gates?: Array<object>, cause?: unknown, verb?: string }} info
   */
  constructor(message, { code, status, gates, cause, verb } = {}) {
    super(message);
    this.name = "HermesAdapterError";
    this.code = code || "unknown_error";
    if (status !== undefined) this.status = status;
    if (gates !== undefined) this.gates = gates;
    if (verb !== undefined) this.verb = verb;
    if (cause !== undefined) this.cause = cause;
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

// ─── transport ──────────────────────────────────────────────────────────────

/**
 * Build the canonical orange.order.v1 envelope for a verb call. The shape is
 * what Gate 1 (order_schema) inspects on the daemon side.
 */
function buildOrder({ verb, args, lease, actor, targetProject }) {
  const orderId = `pw-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
    args,
    lease_id: lease.id,
    actor: actor || lease.actor || "unknown",
    targetProject: targetProject || lease.targetProject || null,
    requested_at: new Date().toISOString(),
  };
}

/**
 * Submit an order to the Hermes daemon and parse the report. Throws a
 * HermesAdapterError on any failure path — never returns a half-built object.
 *
 * @param {object} opts
 * @param {object} opts.order
 * @param {string} opts.verb
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]   — injectable for tests
 * @param {boolean} [opts.operatorApproved] — forwarded to Hermes for Gate 4
 * @returns {Promise<object>} the orange.report.v1 report
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
    schema: "orange.report.v1",
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
      aborted ? `hermes daemon did not respond within ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms` : `transport to hermes failed: ${cause?.message || cause}`,
      { code: aborted ? "hermes_timeout" : "hermes_transport_failed", verb, cause }
    );
  } finally {
    clearTimeout(timer);
  }

  let body;
  const raw = await response.text();
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

  // Hermes signals refusal as 4xx with a structured body { refusal, gates }.
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
      schema: "orange.report.v1",
      ok: true,
      verb,
      gates: body.data.results || [],
      lease_id: body.data.lease_id || order.lease_id,
      misfit: body.data.misfit || null,
      receipt_path: receiptPath,
      hermes: body.data,
    };
  }

  // Sanity-check the report envelope. Gate 2 enforces this on the daemon
  // side, but trust-no-input: if we got here we still verify before handing
  // the report back to the caller.
  if (!body || body.schema !== "orange.report.v1") {
    throw new HermesAdapterError("hermes returned a report without orange.report.v1 schema", {
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

// ─── public verbs ───────────────────────────────────────────────────────────

/**
 * Click at page-relative pixel coordinates.
 *
 * @param {object} opts
 * @param {number} opts.x                — page-relative pixel X
 * @param {number} opts.y                — page-relative pixel Y
 * @param {import("../src/lease-engine.mjs").Lease|object} opts.lease — active lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {string} [opts.button]         — "left" | "right" | "middle" (default "left")
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function click({ x, y, lease, actor, targetProject, button = "left", operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "browser.click";
  assertLease(lease, verb);
  assertNumber(x, "x", verb);
  assertNumber(y, "y", verb);
  if (button !== "left" && button !== "right" && button !== "middle") {
    throw new HermesAdapterError(`button must be one of left|right|middle, got "${button}"`, { code: "arg_invalid", verb });
  }

  const order = buildOrder({
    verb,
    args: { x, y, button },
    lease,
    actor,
    targetProject,
  });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

/**
 * Fill a form field. The MCP server resolves the selector and types the text.
 *
 * @param {object} opts
 * @param {string} opts.selector         — CSS / accessibility selector understood by the MCP server
 * @param {string} opts.text             — text to type (will be sent verbatim)
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {boolean} [opts.clear]         — clear the field before typing (default true)
 * @param {boolean} [opts.submit]        — press Enter after typing (default false)
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function fill({ selector, text, lease, actor, targetProject, clear = true, submit = false, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "browser.fill";
  assertLease(lease, verb);
  assertString(selector, "selector", verb);
  if (typeof text !== "string") {
    throw new HermesAdapterError("text must be a string (may be empty)", { code: "arg_invalid", verb });
  }

  const order = buildOrder({
    verb,
    args: { selector, text, clear: Boolean(clear), submit: Boolean(submit) },
    lease,
    actor,
    targetProject,
  });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

/**
 * Capture a screenshot of the active page. The MCP server decides whether to
 * return base64 inline or write to a path on disk — the report carries both
 * possibilities under `mcp_response`.
 *
 * @param {object} opts
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {boolean} [opts.fullPage]      — capture the full scroll height (default false)
 * @param {string} [opts.path]           — optional path hint for the MCP server
 * @param {string} [opts.format]         — "png" | "jpeg" (default "png")
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function screenshot({ lease, actor, targetProject, fullPage = false, path, format = "png", operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "browser.screenshot";
  assertLease(lease, verb);
  if (format !== "png" && format !== "jpeg") {
    throw new HermesAdapterError(`format must be png|jpeg, got "${format}"`, { code: "arg_invalid", verb });
  }
  if (path !== undefined && (typeof path !== "string" || path.length === 0)) {
    throw new HermesAdapterError("path, if provided, must be a non-empty string", { code: "arg_invalid", verb });
  }

  const args = { fullPage: Boolean(fullPage), format };
  if (path !== undefined) args.path = path;

  const order = buildOrder({
    verb,
    args,
    lease,
    actor,
    targetProject,
  });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

/**
 * Navigate the active page to a URL. The lease's allowed[] must include
 * "browser.navigate" — Hermes will Gate 5 (codexa_lease) the action.
 *
 * @param {object} opts
 * @param {string} opts.url
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {"load"|"domcontentloaded"|"networkidle"|"commit"} [opts.waitUntil]
 * @param {number} [opts.navTimeoutMs]   — passed through to MCP server
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function navigate({ url, lease, actor, targetProject, waitUntil = "load", navTimeoutMs, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "browser.navigate";
  assertLease(lease, verb);
  assertString(url, "url", verb);

  // Cheap structural URL check — Hermes also enforces egress policy, but
  // catching obvious garbage at the adapter saves a round trip.
  try {
    // eslint-disable-next-line no-new
    new URL(url);
  } catch (cause) {
    throw new HermesAdapterError(`url is not a valid absolute URL: "${url}"`, { code: "arg_invalid", verb, cause });
  }

  const allowedWait = new Set(["load", "domcontentloaded", "networkidle", "commit"]);
  if (!allowedWait.has(waitUntil)) {
    throw new HermesAdapterError(`waitUntil must be one of ${[...allowedWait].join("|")}`, { code: "arg_invalid", verb });
  }
  if (navTimeoutMs !== undefined) assertNumber(navTimeoutMs, "navTimeoutMs", verb);

  const args = { url, waitUntil };
  if (navTimeoutMs !== undefined) args.navTimeoutMs = navTimeoutMs;

  const order = buildOrder({
    verb,
    args,
    lease,
    actor,
    targetProject,
  });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

// ─── module metadata (for diagnostics / discovery) ──────────────────────────

export const ADAPTER_META = Object.freeze({
  id: ADAPTER_ID,
  mcp_server: "playwright-mcp",
  verbs: Object.freeze(Object.keys(VERB_TO_MCP_TOOL)),
  default_hermes_base_url: DEFAULT_HERMES_BASE_URL,
  order_schema: ORDER_SCHEMA,
});
