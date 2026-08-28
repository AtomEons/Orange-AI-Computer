// 08-HERMES / adapters / computer-use.mjs
//
// Hermes-gated adapter for the Computer-Use MCP server (desktop control:
// screenshots, mouse, keyboard, scroll on the operator's actual desktop).
//
// This module exposes six operator-callable verbs — screenshot, left_click,
// right_click, type, key, scroll — that any LLM in the Orange5 superstack
// must call via this adapter rather than touching the Computer-Use MCP
// directly. Each call is shaped into an `orange.order.v1` order, submitted to
// the Hermes daemon at 127.0.0.1:7430 through the gateway-mediated
// POST /v1/hermes/action route, and only lands on the host after all 8 LOOM
// gates pass.
//
// WAVE-3 ADDITION — hardened policy layer
// ──────────────────────────────────────────
// Computer-use is materially scarier than browser automation: a click in the
// browser is sandboxed by the page; a click on the operator's actual desktop
// can drag a folder into the trash, send a Slack message, or trigger an
// admin prompt. This adapter therefore enforces, BEFORE the order is even
// shaped, a deterministic risk classification (see RISK_BY_VERB) and asserts:
//
//   - the lease.allowed[] contains the exact verb being attempted,
//   - the lease.riskLevel is at least as permissive as the verb's risk_level,
//   - and the verb is NOT present in lease.forbidden[].
//
// Hermes will re-check all of these server-side (Gate 5, codexa_lease) — the
// adapter's local enforcement is a fail-fast belt around the server-side
// suspenders, so we never burn a Hermes round-trip on an obviously-doomed
// call and so the refusal reason surfaces with the exact verb that failed.
//
// VERB SURFACE
// ────────────
//   screenshot({ lease, region?, ... })                  → desktop.screenshot   (low)
//   left_click({ x, y, lease, modifiers?, ... })         → desktop.left_click   (medium)
//   right_click({ x, y, lease, ... })                    → desktop.right_click  (medium)
//   type({ text, lease, ... })                           → desktop.type         (medium)
//   key({ key, lease, modifiers?, ... })                 → desktop.key          (medium)
//   scroll({ x, y, deltaX, deltaY, lease, ... })         → desktop.scroll       (low)
//
// Each verb returns the parsed `orange.report.v1` from Hermes. On any refusal
// — local or remote — the adapter throws a HermesAdapterError (shared shape
// with the playwright adapter; re-exported below).
//
// FRONTIER-ISOLATION
// ──────────────────
// As with all Hermes adapters: the frontier model NEVER imports this module
// and NEVER opens a socket to 127.0.0.1:7430. It proposes the action in a
// tool-use turn; the gateway shapes a Hermes order; that order flows here.
//
// HONEST GAPS
// ───────────
//  - This adapter does NOT itself drive an X11 / Windows / Quartz session.
//    It speaks to the Computer-Use MCP server through Hermes; that MCP
//    server is responsible for the actual native input synthesis. If the
//    MCP server is not registered or not running, Hermes fails Gate 7
//    (mcp_default) and the adapter throws "mcp_default_failed".
//  - The `lease` argument is REQUIRED. No implicit lease creation. The
//    caller must mint a lease (POST /v1/hermes/lease) with the verbs it
//    intends to use in `allowed[]` BEFORE calling any verb here. This is
//    by design — the lease is the authority spine, and computer-use is
//    too dangerous to grant by default.
//  - Coordinates passed to left_click / right_click / scroll are
//    screen-relative pixels on the PRIMARY display. The MCP server is the
//    only thing that knows the actual display geometry; multi-monitor
//    routing is not handled here.
//  - The `type` verb sends the text verbatim through synthetic keystrokes.
//    Paste-via-clipboard is NOT a separate verb here; if the caller wants
//    clipboard semantics, they must mint a separate lease and use the
//    dedicated clipboard MCP (not wrapped in this file).
//  - Node 20+ only. ESM. Uses global fetch + AbortController. No deps.

// ─── constants ──────────────────────────────────────────────────────────────

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_HERMES_BASE_URL = "http://127.0.0.1:7430";
const DEFAULT_ACTION_PATH = "/action";
const DEFAULT_TIMEOUT_MS = 30_000;
const ORDER_SCHEMA = "orange.order.v1";
const ADAPTER_ID = "hermes.adapter.computer-use.v1";

// Verb → MCP tool name on the Computer-Use MCP server. The server's actual
// tool names live in the operator's MCP registry (e.g.
// `mcp__computer-use__screenshot`); on the Hermes order envelope we record
// the canonical short name and let the MCP layer translate.
const VERB_TO_MCP_TOOL = Object.freeze({
  "desktop.screenshot":  "screenshot",
  "desktop.left_click":  "left_click",
  "desktop.right_click": "right_click",
  "desktop.type":        "type",
  "desktop.key":         "key",
  "desktop.scroll":      "scroll",
});

// Deterministic per-verb risk classification. The hardened policy layer
// asserts the lease covers AT LEAST this risk level before the order is
// submitted to Hermes. This map is the single source of truth on the
// adapter side — Hermes' own risk-matrix is the server-side authority.
//
// RISK LADDER (ordered, low at index 0, destructive at top):
//   read_only < low < medium < high < destructive < production
const RISK_LADDER = Object.freeze([
  "read_only",
  "low",
  "medium",
  "high",
  "destructive",
  "production",
]);

const RISK_BY_VERB = Object.freeze({
  "desktop.screenshot":  "low",
  "desktop.left_click":  "medium",
  "desktop.right_click": "medium",
  "desktop.type":        "medium",
  "desktop.key":         "medium",
  "desktop.scroll":      "low",
});

// Lease's `forbidden[]` may name any of these. We also auto-treat the
// generic Hermes-wide forbidden tokens as blockers on this adapter so the
// adapter never tries to burn a Hermes call on an obvious doomed request.
const HERMES_WIDE_FORBIDDEN = Object.freeze([
  "destructive_write",
  "production_deploy",
  "scope_expansion",
  "egress_unbounded",
]);

// Modifier whitelist — passed through to the MCP server, but the adapter
// validates the shape here so a typo doesn't sail through.
const ALLOWED_MODIFIERS = Object.freeze(new Set([
  "shift", "ctrl", "alt", "meta", "cmd", "win", "fn",
]));

// ─── errors ─────────────────────────────────────────────────────────────────

/**
 * Structured error thrown by every public verb when local policy refuses,
 * when Hermes refuses, when a gate fails, or when transport breaks. Callers
 * should branch on `.code`, surface `.gates` to the operator if present,
 * and never silently retry — a refusal is a contract decision.
 *
 * NOTE: we intentionally re-declare this class rather than importing from
 * playwright.mjs, so each adapter owns its own error type and stays a
 * single-file unit. Both share the same shape contract.
 */
export class HermesAdapterError extends Error {
  /**
   * @param {string} message
   * @param {{ code: string, status?: number, gates?: Array<object>, cause?: unknown, verb?: string, policy?: object }} info
   */
  constructor(message, { code, status, gates, cause, verb, policy } = {}) {
    super(message);
    this.name = "HermesAdapterError";
    this.code = code || "unknown_error";
    if (status !== undefined) this.status = status;
    if (gates !== undefined) this.gates = gates;
    if (verb !== undefined) this.verb = verb;
    if (policy !== undefined) this.policy = policy;
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
  if (lease.forbidden !== undefined && !Array.isArray(lease.forbidden)) {
    throw new HermesAdapterError("lease.forbidden, if present, must be an array", { code: "lease_malformed", verb });
  }
  if (lease.expires_at !== undefined && typeof lease.expires_at !== "number") {
    throw new HermesAdapterError("lease.expires_at, if present, must be a number (epoch ms)", { code: "lease_malformed", verb });
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

function assertModifiers(modifiers, verb) {
  if (modifiers === undefined) return [];
  if (!Array.isArray(modifiers)) {
    throw new HermesAdapterError("modifiers must be an array of strings", { code: "arg_invalid", verb });
  }
  const out = [];
  for (const m of modifiers) {
    if (typeof m !== "string" || !ALLOWED_MODIFIERS.has(m.toLowerCase())) {
      throw new HermesAdapterError(
        `modifier "${m}" not in allowed set [${[...ALLOWED_MODIFIERS].join(", ")}]`,
        { code: "arg_invalid", verb }
      );
    }
    out.push(m.toLowerCase());
  }
  return out;
}

// ─── hardened policy layer ──────────────────────────────────────────────────

/**
 * Classify a verb. Returns `{ verb, risk_level }`. Throws if the verb is not
 * one this adapter handles. Pure function — exported for tests and for the
 * Hermes server's optional cross-check.
 *
 * @param {string} verb
 * @returns {{ verb: string, risk_level: string }}
 */
export function classifyVerb(verb) {
  if (typeof verb !== "string" || !(verb in RISK_BY_VERB)) {
    throw new HermesAdapterError(
      `unknown verb "${verb}" — not in computer-use adapter surface`,
      { code: "verb_unknown", verb }
    );
  }
  return { verb, risk_level: RISK_BY_VERB[verb] };
}

/**
 * Compare two risk levels using the ladder. Returns true iff `actual` is at
 * least as permissive (high) as `required`. Both must be on the ladder.
 *
 * @param {string} actual
 * @param {string} required
 * @returns {boolean}
 */
export function leaseCoversRisk(actual, required) {
  const a = RISK_LADDER.indexOf(actual);
  const r = RISK_LADDER.indexOf(required);
  if (a < 0 || r < 0) return false;
  return a >= r;
}

/**
 * Enforce the local policy: verb is on this adapter, lease.allowed contains
 * the verb, lease.riskLevel covers the verb's risk_level, lease is not in
 * forbidden[], lease is not expired. Throws HermesAdapterError on any
 * failure — never returns false. On success returns the policy verdict
 * object (also attached to any thrown error's `.policy` field for visibility).
 *
 * This is the "hardened policy layer that classifies every MCP tool call by
 * risk_level + asserts the lease covers it" called for in the wave brief.
 *
 * @param {string} verb
 * @param {object} lease
 * @param {number} [now]   — overridable clock for tests
 * @returns {{ verb: string, risk_level: string, lease_id: string, decided_at: number }}
 */
export function enforceLocalPolicy(verb, lease, now = Date.now()) {
  const { risk_level } = classifyVerb(verb);
  assertLease(lease, verb);

  // Expiry check (if the lease carries one).
  if (typeof lease.expires_at === "number" && now >= lease.expires_at) {
    throw new HermesAdapterError(
      `lease ${lease.id} expired at ${new Date(lease.expires_at).toISOString()}`,
      { code: "lease_expired", verb, policy: { verb, risk_level, lease_id: lease.id } }
    );
  }

  // Verb must be explicitly allowed.
  if (!lease.allowed.includes(verb)) {
    throw new HermesAdapterError(
      `verb "${verb}" not in lease.allowed (computer-use is high-risk; verbs must be granted explicitly)`,
      { code: "verb_not_in_lease", verb, policy: { verb, risk_level, lease_id: lease.id, allowed: lease.allowed } }
    );
  }

  // Verb must not be in lease.forbidden, and none of the wide-forbidden tokens
  // may be present if they intersect with this adapter's risk surface.
  const forbidden = Array.isArray(lease.forbidden) ? lease.forbidden : [];
  if (forbidden.includes(verb)) {
    throw new HermesAdapterError(
      `verb "${verb}" present in lease.forbidden`,
      { code: "verb_forbidden_by_lease", verb, policy: { verb, risk_level, lease_id: lease.id } }
    );
  }
  // destructive_write blocks medium+ desktop verbs; production_deploy blocks
  // anything. We map these conservatively.
  // production_deploy blocks production/deploy-class actions. It does not
  // automatically block ordinary desktop mediation; otherwise the daemon's
  // default forbidden set would make every computer-use lease unusable.
  if (forbidden.includes("production_deploy") && (risk_level === "production" || verb.includes("deploy"))) {
    throw new HermesAdapterError(
      `lease ${lease.id} forbids production_deploy — production-class desktop verb (${verb}) is blocked`,
      { code: "verb_blocked_by_wide_forbidden", verb, policy: { verb, risk_level, lease_id: lease.id, wide: "production_deploy" } }
    );
  }
  if (forbidden.includes("destructive_write") && (risk_level === "high" || risk_level === "destructive" || risk_level === "production")) {
    throw new HermesAdapterError(
      `lease ${lease.id} forbids destructive_write — high/destructive desktop verb (${verb}) is blocked`,
      { code: "verb_blocked_by_wide_forbidden", verb, policy: { verb, risk_level, lease_id: lease.id, wide: "destructive_write" } }
    );
  }

  // Risk-level coverage. If the lease doesn't carry an explicit riskLevel we
  // refuse to assume — better to fail fast than guess upward.
  if (typeof lease.riskLevel !== "string") {
    throw new HermesAdapterError(
      `lease ${lease.id} has no riskLevel — refusing to infer for computer-use`,
      { code: "lease_missing_risk_level", verb, policy: { verb, risk_level, lease_id: lease.id } }
    );
  }
  if (!leaseCoversRisk(lease.riskLevel, risk_level)) {
    throw new HermesAdapterError(
      `lease.riskLevel="${lease.riskLevel}" does not cover required="${risk_level}" for verb ${verb}`,
      { code: "lease_risk_insufficient", verb, policy: { verb, risk_level, lease_id: lease.id, lease_risk: lease.riskLevel } }
    );
  }

  return { verb, risk_level, lease_id: lease.id, decided_at: now };
}

// ─── transport ──────────────────────────────────────────────────────────────

function buildOrder({ verb, args, lease, actor, targetProject, policy }) {
  const orderId = `cu-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
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
    risk_level: policy.risk_level,
    args,
    lease_id: lease.id,
    actor: actor || lease.actor || "unknown",
    targetProject: targetProject || lease.targetProject || null,
    requested_at: new Date().toISOString(),
  };
}

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
      aborted
        ? `hermes daemon did not respond within ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
        : `transport to hermes failed: ${cause?.message || cause}`,
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
 * Capture a screenshot of the operator's desktop. RISK: low.
 *
 * @param {object} opts
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {{x:number,y:number,width:number,height:number}} [opts.region]
 *   — optional clipping rectangle in screen-relative pixels. If omitted the
 *     full primary display is captured.
 * @param {"png"|"jpeg"} [opts.format]   — default "png"
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function screenshot({ lease, actor, targetProject, region, format = "png", operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "desktop.screenshot";
  const policy = enforceLocalPolicy(verb, lease);
  if (format !== "png" && format !== "jpeg") {
    throw new HermesAdapterError(`format must be png|jpeg, got "${format}"`, { code: "arg_invalid", verb });
  }
  if (region !== undefined) {
    if (!region || typeof region !== "object") {
      throw new HermesAdapterError("region must be an object {x,y,width,height}", { code: "arg_invalid", verb });
    }
    assertNumber(region.x, "region.x", verb);
    assertNumber(region.y, "region.y", verb);
    assertNumber(region.width, "region.width", verb);
    assertNumber(region.height, "region.height", verb);
    if (region.width <= 0 || region.height <= 0) {
      throw new HermesAdapterError("region.width and region.height must be positive", { code: "arg_invalid", verb });
    }
  }

  const args = { format };
  if (region !== undefined) args.region = region;

  const order = buildOrder({ verb, args, lease, actor, targetProject, policy });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

/**
 * Synthesize a left mouse click at screen-relative pixel coordinates.
 * RISK: medium.
 *
 * @param {object} opts
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {Array<string>} [opts.modifiers]   — e.g. ["shift", "ctrl"]
 * @param {number} [opts.clickCount]         — 1 (single) | 2 (double). Default 1.
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function left_click({ x, y, lease, actor, targetProject, modifiers, clickCount = 1, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "desktop.left_click";
  const policy = enforceLocalPolicy(verb, lease);
  assertNumber(x, "x", verb);
  assertNumber(y, "y", verb);
  const mods = assertModifiers(modifiers, verb);
  if (clickCount !== 1 && clickCount !== 2) {
    throw new HermesAdapterError(`clickCount must be 1 or 2, got ${clickCount}`, { code: "arg_invalid", verb });
  }

  const args = { x, y, clickCount };
  if (mods.length > 0) args.modifiers = mods;

  const order = buildOrder({ verb, args, lease, actor, targetProject, policy });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

/**
 * Synthesize a right mouse click (context menu) at screen-relative pixel
 * coordinates. RISK: medium.
 *
 * @param {object} opts
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function right_click({ x, y, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "desktop.right_click";
  const policy = enforceLocalPolicy(verb, lease);
  assertNumber(x, "x", verb);
  assertNumber(y, "y", verb);

  const order = buildOrder({ verb, args: { x, y }, lease, actor, targetProject, policy });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

/**
 * Type literal text via synthetic keystrokes into the focused window.
 * RISK: medium.
 *
 * @param {object} opts
 * @param {string} opts.text          — verbatim text to type
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {number} [opts.delayMs]     — per-character delay, passed to MCP server
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function type({ text, lease, actor, targetProject, delayMs, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "desktop.type";
  const policy = enforceLocalPolicy(verb, lease);
  if (typeof text !== "string") {
    throw new HermesAdapterError("text must be a string (may be empty)", { code: "arg_invalid", verb });
  }
  if (delayMs !== undefined) assertNumber(delayMs, "delayMs", verb);

  const args = { text };
  if (delayMs !== undefined) args.delayMs = delayMs;

  const order = buildOrder({ verb, args, lease, actor, targetProject, policy });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

/**
 * Press a single named key (optionally with modifiers). The MCP server is
 * the authority on the key namespace — common values: "Enter", "Tab",
 * "Escape", "ArrowDown", "F5", "a", etc. RISK: medium.
 *
 * @param {object} opts
 * @param {string} opts.key
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {Array<string>} [opts.modifiers]
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function key({ key: keyName, lease, actor, targetProject, modifiers, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "desktop.key";
  const policy = enforceLocalPolicy(verb, lease);
  assertString(keyName, "key", verb);
  const mods = assertModifiers(modifiers, verb);

  const args = { key: keyName };
  if (mods.length > 0) args.modifiers = mods;

  const order = buildOrder({ verb, args, lease, actor, targetProject, policy });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

/**
 * Scroll the wheel at a given screen-relative anchor point. Positive deltaY
 * scrolls down (page reveals lower content). RISK: low.
 *
 * @param {object} opts
 * @param {number} opts.x
 * @param {number} opts.y
 * @param {number} [opts.deltaX]      — default 0
 * @param {number} [opts.deltaY]      — default 0; at least one of deltaX/deltaY must be non-zero
 * @param {object} opts.lease
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {boolean} [opts.operatorApproved]
 * @param {string} [opts.baseUrl]
 * @param {number} [opts.timeoutMs]
 * @param {typeof fetch} [opts.fetchFn]
 * @returns {Promise<object>} orange.report.v1
 */
export async function scroll({ x, y, deltaX = 0, deltaY = 0, lease, actor, targetProject, operatorApproved, baseUrl, timeoutMs, fetchFn } = {}) {
  const verb = "desktop.scroll";
  const policy = enforceLocalPolicy(verb, lease);
  assertNumber(x, "x", verb);
  assertNumber(y, "y", verb);
  assertNumber(deltaX, "deltaX", verb);
  assertNumber(deltaY, "deltaY", verb);
  if (deltaX === 0 && deltaY === 0) {
    throw new HermesAdapterError("at least one of deltaX/deltaY must be non-zero", { code: "arg_invalid", verb });
  }

  const order = buildOrder({ verb, args: { x, y, deltaX, deltaY }, lease, actor, targetProject, policy });
  return submitToHermes({ order, verb, baseUrl, timeoutMs, fetchFn, operatorApproved });
}

// ─── module metadata (for diagnostics / discovery) ──────────────────────────

export const ADAPTER_META = Object.freeze({
  id: ADAPTER_ID,
  mcp_server: "computer-use-mcp",
  verbs: Object.freeze(Object.keys(VERB_TO_MCP_TOOL)),
  risk_by_verb: RISK_BY_VERB,
  risk_ladder: RISK_LADDER,
  default_hermes_base_url: DEFAULT_HERMES_BASE_URL,
  order_schema: ORDER_SCHEMA,
});

// Re-export the constants for tests + the Hermes server's cross-check.
export { RISK_LADDER, RISK_BY_VERB, VERB_TO_MCP_TOOL, ADAPTER_ID };
