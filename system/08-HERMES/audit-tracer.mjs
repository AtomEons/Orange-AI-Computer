// 08-HERMES / audit-tracer.mjs
//
// Hermes MCP audit tracer. Wave 3 ribbon between every MCP-bound adapter call
// (chrome-devtools, computer-use, playwright, supabase, vercel, filesystem,
// github, …) and the Æ Cobra Reality Flux ledger.
//
// MISSION
// ───────
// Every Hermes-mediated MCP tool call MUST land a receipt in Reality Flux. The
// receipt is written via the Æ Cobra writer (06-ORANGELLM/memory/ae-cobra/
// flux/writer.mjs) — the only sanctioned authoring path into the hash-chained
// {reality,thought}.jsonl spine. The receipt shape is:
//
//   {
//     kind: "receipt",
//     origin: "hermes_mcp",                     // canonical origin tag
//     body: {
//       lease_id:        string,                // Hermes lease that authorized the call
//       mcp_server:      string,                // e.g. "chrome-devtools" | "computer-use"
//       mcp_tool:        string,                // short tool name on the server
//       verb:            string|null,           // canonical Hermes verb (e.g. "cd.click")
//       risk_level:      string,                // policy classification (read_only…production)
//       args_hash:       "sha256:<hex>",        // deterministic hash of input args
//       result_hash:     "sha256:<hex>"|null,   // deterministic hash of MCP response
//       outcome:         "ok"|"refused"|"error",
//       refusal:         string|null,
//       elapsed_ms:      number,
//       order_id:        string|null,           // Hermes order id if present
//       actor:           string|null,
//       targetProject:   string|null,
//       adapter_id:      string,                // e.g. "hermes.adapter.chrome-devtools.v1"
//       schema:          "orange5.hermes.mcp_receipt.v1",
//     }
//   }
//
// The Cobra writer wraps that record into the canonical chain envelope
// { ts, sha256, prior_sha256, origin, lane, event } and appends it to
// `${AE_FLUX_ROOT}/reality.jsonl` durably. The wrapper's outer `origin` field
// is also set to "hermes_mcp" so a one-pass `grep '"origin":"hermes_mcp"'`
// over the lane file enumerates every MCP touch.
//
// POLICY LAYER
// ────────────
// Before writing the receipt, `traceMcpCall` (and the higher-order
// `wrapDispatch`) classifies the tool call with the hardened policy from
// 08-HERMES/policy/mcp-tool-policy.mjs and asserts the supplied lease covers
// it. The assertion is strict:
//
//   1. lease must be an object with id:string and allowed:string[]
//   2. lease.expires_at (if present) must not be in the past
//   3. the policy must classify the call (no fail-closed → reject)
//   4. lease.riskLevel (if present) must be >= the classified risk_level
//      (compareRisk ≥ 0)
//   5. lease.allowed[] must contain the canonical verb (or the bare tool
//      name when the server has no verbPrefix)
//   6. lease.forbidden[] must NOT contain the canonical verb
//   7. if the policy says requires_approval, the caller must pass
//      operatorApproved:true (mirrors Hermes Gate 4)
//
// If any check fails, an `AuditTracerError` is thrown WITH `code` set to a
// stable identifier (see ERROR_CODES). The error itself is also recorded as
// a `outcome:"refused"` receipt — the spine sees refusals too.
//
// DISPATCH WRAPPER
// ────────────────
// `wrapDispatch(adapter)` returns a function that, given an adapter call
// descriptor `{server, tool, verb, args, lease, dispatch, ...}`, runs:
//
//   1. policy + lease assertion (refusal → record + throw)
//   2. `dispatch(args)` (the caller-provided thunk that hits /v1/hermes/action)
//   3. on success, write `outcome:"ok"` receipt + return the dispatch result
//   4. on error, write `outcome:"error"` receipt + rethrow
//
// The `dispatch` thunk is the ONLY thing that talks to Hermes / MCP. The
// tracer never opens its own socket. Adapters supply their own dispatch
// (the playwright/chrome-devtools/computer-use modules already POST to
// http://127.0.0.1:7430/action). This separation keeps the tracer pure and
// trivially testable with an injected dispatch.
//
// HONEST GAPS
// ───────────
//  - This module writes to the Æ Cobra writer which appends to
//    `${AE_FLUX_ROOT}/reality.jsonl` (default /mnt/ae_flux). If the flux
//    chain is torn (writer detected an unterminated tail), the receipt
//    write throws. We surface the error to the caller — we do NOT silently
//    fall through to a dropped trace. Loss of audit MUST be visible.
//  - `args_hash` and `result_hash` are SHA-256 over the canonical JSON of
//    the argument and the response. Non-JSON-safe payloads (BigInts,
//    Symbols, functions) are not supported and will throw — surface the
//    failure rather than emit a misleading hash.
//  - The policy table is hand-curated. Unknown tools fail closed; that
//    refusal is itself recorded as a receipt with `outcome:"refused"` and
//    `refusal:"policy_unknown_tool"` so the audit spine never silently
//    misses a call attempt.
//  - The wrapper does NOT mint, refresh, or revoke leases. Lease lifecycle
//    is the lease-engine's job (08-HERMES/src/lease-engine.mjs).
//  - Node 20+. ESM. No deps outside Node stdlib + sibling Hermes modules.

import crypto from "node:crypto";

import {
  classifyToolCall,
  compareRisk,
  RISK_LADDER,
} from "./policy/mcp-tool-policy.mjs";

import { writeReality } from "../06-ORANGELLM/memory/ae-cobra/flux/writer.mjs";

// ─── constants ──────────────────────────────────────────────────────────────

export const TRACER_ID = "hermes.audit-tracer.v1";
export const RECEIPT_SCHEMA = "orange5.hermes.mcp_receipt.v1";
export const RECEIPT_KIND = "receipt";
export const RECEIPT_ORIGIN = "hermes_mcp";
export const FLUX_LANE = "reality";

/**
 * Stable error codes. Callers may branch on these. Every code is also the
 * value placed in `body.refusal` when the receipt is written as a refusal.
 */
export const ERROR_CODES = Object.freeze({
  LEASE_MISSING:        "lease_missing",
  LEASE_MALFORMED:      "lease_malformed",
  LEASE_EXPIRED:        "lease_expired",
  POLICY_UNKNOWN_TOOL:  "policy_unknown_tool",
  RISK_EXCEEDS_LEASE:   "risk_exceeds_lease",
  VERB_NOT_ALLOWED:     "verb_not_in_lease_allowlist",
  VERB_FORBIDDEN:       "verb_in_lease_forbidden_list",
  APPROVAL_REQUIRED:    "operator_approval_required",
  DISPATCH_NOT_CALLABLE:"dispatch_not_callable",
  TRACE_WRITE_FAILED:   "trace_write_failed",
  CANONICALIZE_FAILED:  "canonicalize_failed",
  ARG_INVALID:          "arg_invalid",
});

// ─── errors ─────────────────────────────────────────────────────────────────

/**
 * Structured error thrown by traceMcpCall / wrapDispatch on any refusal or
 * transport failure. The `code` is one of ERROR_CODES; the `receipt` (when
 * present) is the receipt object that was just written to the flux spine.
 */
export class AuditTracerError extends Error {
  constructor(message, { code, receipt, cause, server, tool, verb } = {}) {
    super(message);
    this.name = "AuditTracerError";
    this.code = code || "unknown_error";
    if (receipt !== undefined) this.receipt = receipt;
    if (cause !== undefined) this.cause = cause;
    if (server !== undefined) this.server = server;
    if (tool !== undefined) this.tool = tool;
    if (verb !== undefined) this.verb = verb;
  }
}

// ─── canonical JSON + hashing ───────────────────────────────────────────────

/**
 * Deterministic stringify: sorted keys, no whitespace. Throws on bigint /
 * non-finite numbers / symbols / functions so we never emit a misleading hash.
 */
export function canonicalJSON(value) {
  if (value === undefined) return "null";
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new AuditTracerError(
        `canonicalJSON: non-finite number (${value})`,
        { code: ERROR_CODES.CANONICALIZE_FAILED }
      );
    }
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "bigint") {
    throw new AuditTracerError(
      "canonicalJSON: bigint not supported in receipt payloads",
      { code: ERROR_CODES.CANONICALIZE_FAILED }
    );
  }
  if (typeof value === "function" || typeof value === "symbol") {
    throw new AuditTracerError(
      `canonicalJSON: ${typeof value} not supported in receipt payloads`,
      { code: ERROR_CODES.CANONICALIZE_FAILED }
    );
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalJSON).join(",") + "]";
  }
  if (typeof value === "object") {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined).sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonicalJSON(value[k])).join(",") +
      "}"
    );
  }
  throw new AuditTracerError(
    `canonicalJSON: unsupported value type ${typeof value}`,
    { code: ERROR_CODES.CANONICALIZE_FAILED }
  );
}

/** SHA-256 hex of the canonical JSON of `value`, prefixed "sha256:". */
export function hashPayload(value) {
  const canon = canonicalJSON(value);
  const hex = crypto.createHash("sha256").update(canon, "utf8").digest("hex");
  return `sha256:${hex}`;
}

// ─── lease + policy assertion ───────────────────────────────────────────────

/**
 * Assert the lease is well-formed and covers the classified tool call.
 *
 * @param {object} lease
 * @param {object} classification — output of classifyToolCall(...)
 * @param {{ operatorApproved?: boolean, now?: number }} opts
 * @returns {{ verbKey: string }} the verb-or-tool string actually matched in lease.allowed
 * @throws {AuditTracerError}
 */
export function assertLeaseCovers(lease, classification, { operatorApproved = false, now = Date.now() } = {}) {
  if (!lease || typeof lease !== "object") {
    throw new AuditTracerError("lease missing", {
      code: ERROR_CODES.LEASE_MISSING,
    });
  }
  if (typeof lease.id !== "string" || lease.id.length === 0) {
    throw new AuditTracerError("lease.id must be a non-empty string", {
      code: ERROR_CODES.LEASE_MALFORMED,
    });
  }
  if (!Array.isArray(lease.allowed)) {
    throw new AuditTracerError("lease.allowed must be an array", {
      code: ERROR_CODES.LEASE_MALFORMED,
    });
  }
  if (typeof lease.expires_at === "number" && Number.isFinite(lease.expires_at) && now > lease.expires_at) {
    throw new AuditTracerError(
      `lease ${lease.id} expired at ${new Date(lease.expires_at).toISOString()}`,
      { code: ERROR_CODES.LEASE_EXPIRED }
    );
  }
  if (!classification || classification.match === "default") {
    throw new AuditTracerError(
      `policy fail-closed: ${classification?.reason || "no classification"}`,
      { code: ERROR_CODES.POLICY_UNKNOWN_TOOL }
    );
  }

  // Risk: lease must cover the classified risk_level. If lease.riskLevel is
  // unset we treat the lease as "low" (the conservative default in the
  // lease-engine).
  const leaseRisk = lease.riskLevel || "low";
  if (compareRisk(classification.risk_level, leaseRisk) > 0) {
    throw new AuditTracerError(
      `risk ${classification.risk_level} exceeds lease.riskLevel ${leaseRisk}`,
      { code: ERROR_CODES.RISK_EXCEEDS_LEASE }
    );
  }

  // Allowlist: the canonical verb (preferred) or the bare tool name.
  const verbKey = classification.verb || classification.tool;
  if (typeof verbKey !== "string" || verbKey.length === 0) {
    throw new AuditTracerError(
      "classification produced no verb or tool key",
      { code: ERROR_CODES.POLICY_UNKNOWN_TOOL }
    );
  }
  if (Array.isArray(lease.forbidden) && lease.forbidden.includes(verbKey)) {
    throw new AuditTracerError(
      `verb "${verbKey}" is in lease.forbidden`,
      { code: ERROR_CODES.VERB_FORBIDDEN }
    );
  }
  if (!lease.allowed.includes(verbKey)) {
    throw new AuditTracerError(
      `verb "${verbKey}" not in lease.allowed`,
      { code: ERROR_CODES.VERB_NOT_ALLOWED }
    );
  }

  // Approval (mirrors Hermes Gate 4 — human_approval).
  if (classification.requires_approval && operatorApproved !== true) {
    throw new AuditTracerError(
      `verb "${verbKey}" requires operator approval`,
      { code: ERROR_CODES.APPROVAL_REQUIRED }
    );
  }

  return { verbKey };
}

// ─── receipt assembly + write ───────────────────────────────────────────────

/**
 * Build the receipt body. Pure — does not touch the writer.
 */
export function buildReceiptBody({
  leaseId,
  classification,
  args,
  result,
  outcome,
  refusal,
  elapsedMs,
  orderId,
  actor,
  targetProject,
  adapterId,
}) {
  const args_hash = hashPayload(args ?? null);
  const result_hash = (outcome === "ok" && result !== undefined) ? hashPayload(result) : null;
  return {
    lease_id: leaseId,
    mcp_server: classification.server,
    mcp_tool: classification.tool,
    verb: classification.verb || null,
    risk_level: classification.risk_level,
    args_hash,
    result_hash,
    outcome,
    refusal: refusal || null,
    elapsed_ms: Number.isFinite(elapsedMs) ? elapsedMs : 0,
    order_id: orderId || null,
    actor: actor || null,
    targetProject: targetProject || null,
    adapter_id: adapterId || TRACER_ID,
    schema: RECEIPT_SCHEMA,
  };
}

/**
 * Write a single Hermes MCP receipt to Reality Flux via the Æ Cobra writer.
 *
 * @param {object} body — output of buildReceiptBody (or equivalent shape)
 * @param {object} [opts]
 * @param {string} [opts.fluxRoot] — override Æ Cobra root (test isolation)
 * @param {(args:object)=>Promise<object>} [opts.writer] — injectable writer for tests
 * @returns {Promise<{record:object, receipt:object}>}
 */
export async function writeReceipt(body, { fluxRoot, writer } = {}) {
  const event = {
    kind: RECEIPT_KIND,
    origin: RECEIPT_ORIGIN,
    body,
  };
  const w = writer || writeReality;
  let record;
  try {
    record = await w({ origin: RECEIPT_ORIGIN, event, ...(fluxRoot ? { fluxRoot } : {}) });
  } catch (cause) {
    throw new AuditTracerError(
      `failed to write hermes_mcp receipt to flux: ${cause?.message || cause}`,
      { code: ERROR_CODES.TRACE_WRITE_FAILED, cause }
    );
  }
  return { record, receipt: event };
}

// ─── public API: traceMcpCall ───────────────────────────────────────────────

/**
 * Trace a single MCP tool call. This is the "no-adapter, just record" path —
 * useful when something else (a daemon, a job runner, a test) is going to
 * make the MCP call itself and just needs to land an audit receipt around it.
 *
 * Usage pattern:
 *
 *   const t0 = performance.now();
 *   let result, err;
 *   try { result = await doCall(); } catch (e) { err = e; }
 *   await traceMcpCall({
 *     toolRef: "mcp__chrome-devtools__navigate_page",
 *     args,
 *     lease,
 *     result, err,
 *     elapsedMs: performance.now() - t0,
 *   });
 *
 * For the more common pattern where the tracer ALSO drives the call, use
 * `wrapDispatch(...)` instead — it handles policy / lease / dispatch /
 * receipt in one call.
 *
 * @param {object} opts
 * @param {string|{server:string,tool:string}} opts.toolRef
 * @param {*}      [opts.args]
 * @param {object} opts.lease
 * @param {*}      [opts.result]            — set when outcome is "ok"
 * @param {Error}  [opts.err]               — set when outcome is "error"
 * @param {string} [opts.refusal]           — set when outcome is "refused"
 * @param {number} [opts.elapsedMs=0]
 * @param {string} [opts.orderId]
 * @param {string} [opts.actor]
 * @param {string} [opts.targetProject]
 * @param {string} [opts.adapterId]
 * @param {boolean}[opts.operatorApproved=false]
 * @param {boolean}[opts.skipLeaseCheck=false] — only set true when the caller
 *                                                has already failed the lease
 *                                                check and is recording the
 *                                                refusal *as* the trace
 * @param {string} [opts.fluxRoot]
 * @param {Function}[opts.writer]
 * @returns {Promise<{record:object, receipt:object, classification:object}>}
 */
export async function traceMcpCall(opts = {}) {
  const {
    toolRef,
    args = null,
    lease,
    result,
    err,
    refusal,
    elapsedMs = 0,
    orderId,
    actor,
    targetProject,
    adapterId,
    operatorApproved = false,
    skipLeaseCheck = false,
    fluxRoot,
    writer,
  } = opts;

  if (toolRef === undefined || toolRef === null) {
    throw new AuditTracerError("toolRef required", { code: ERROR_CODES.ARG_INVALID });
  }

  const classification = classifyToolCall(toolRef);

  // Determine outcome from the supplied flags.
  let outcome;
  let resolvedRefusal = refusal || null;
  if (refusal) outcome = "refused";
  else if (err) { outcome = "error"; resolvedRefusal = err.code || err.message || "error"; }
  else outcome = "ok";

  if (!skipLeaseCheck && outcome === "ok") {
    // Only enforce the lease when we're about to record a SUCCESS. A refusal
    // trace is allowed to lack a valid lease (that's the whole point).
    assertLeaseCovers(lease, classification, { operatorApproved });
  }

  const body = buildReceiptBody({
    leaseId: lease?.id || null,
    classification,
    args,
    result,
    outcome,
    refusal: resolvedRefusal,
    elapsedMs,
    orderId,
    actor: actor || lease?.actor || null,
    targetProject: targetProject || lease?.targetProject || null,
    adapterId,
  });

  const { record, receipt } = await writeReceipt(body, { fluxRoot, writer });
  return { record, receipt, classification };
}

// ─── public API: wrapDispatch ───────────────────────────────────────────────

/**
 * Wrap an adapter dispatch so that every call records a Reality Flux receipt
 * AROUND the dispatch. The dispatch thunk is the only thing that talks to
 * Hermes (and therefore to MCP) — this wrapper enforces policy + lease BEFORE
 * the dispatch, runs the dispatch, then writes the receipt AFTER.
 *
 * The wrapper is a higher-order function so adapter modules don't have to
 * sprinkle tracer calls through every verb implementation; they pass their
 * existing dispatch (e.g. the `submitToHermes` function in playwright.mjs)
 * once and get a traced version back.
 *
 * @param {object}   adapterMeta
 * @param {string}   adapterMeta.adapterId — e.g. "hermes.adapter.chrome-devtools.v1"
 * @param {object}  [adapterMeta.writer]   — injectable writer for tests
 * @param {string}  [adapterMeta.fluxRoot] — override Æ Cobra root
 * @returns {(call: object) => Promise<{ok:boolean, result?:any, error?:Error, receipt:object, record:object}>}
 *
 * The returned function takes a `call` object:
 *   {
 *     toolRef:        string|object,           // required
 *     args:           any,                     // forwarded to dispatch
 *     lease:          object,                  // required
 *     dispatch:       (args)=>Promise<any>,    // required — runs the actual /v1/hermes/action POST
 *     operatorApproved?: boolean,
 *     actor?:         string,
 *     targetProject?: string,
 *     orderId?:       string,
 *   }
 *
 * Behaviour:
 *   - Policy + lease check fails  → receipt(refused) written, then throw
 *   - dispatch throws             → receipt(error) written, then throw original
 *   - dispatch resolves           → receipt(ok) written, then return result
 *
 * The receipt is ALWAYS written, even when something downstream throws. This
 * is the audit invariant: no MCP touch goes unwitnessed.
 */
export function wrapDispatch({ adapterId, writer, fluxRoot } = {}) {
  if (typeof adapterId !== "string" || adapterId.length === 0) {
    throw new AuditTracerError("wrapDispatch: adapterId required", { code: ERROR_CODES.ARG_INVALID });
  }

  return async function tracedCall(call = {}) {
    const {
      toolRef,
      args = null,
      lease,
      dispatch,
      operatorApproved = false,
      actor,
      targetProject,
      orderId,
    } = call;

    if (toolRef === undefined || toolRef === null) {
      throw new AuditTracerError("tracedCall: toolRef required", { code: ERROR_CODES.ARG_INVALID });
    }
    if (typeof dispatch !== "function") {
      throw new AuditTracerError("tracedCall: dispatch must be a function", { code: ERROR_CODES.DISPATCH_NOT_CALLABLE });
    }

    const classification = classifyToolCall(toolRef);
    const startNs = process.hrtime.bigint();

    // 1. Policy + lease pre-flight.
    try {
      assertLeaseCovers(lease, classification, { operatorApproved });
    } catch (preErr) {
      const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;
      const body = buildReceiptBody({
        leaseId: lease?.id || null,
        classification,
        args,
        result: undefined,
        outcome: "refused",
        refusal: preErr.code || "policy_refused",
        elapsedMs,
        orderId,
        actor: actor || lease?.actor || null,
        targetProject: targetProject || lease?.targetProject || null,
        adapterId,
      });
      const { record, receipt } = await writeReceipt(body, { fluxRoot, writer });
      throw new AuditTracerError(preErr.message, {
        code: preErr.code || ERROR_CODES.VERB_NOT_ALLOWED,
        receipt,
        cause: preErr,
        server: classification.server,
        tool: classification.tool,
        verb: classification.verb,
      });
    }

    // 2. Dispatch — the ONLY thing that touches Hermes / MCP.
    let result, dispatchErr;
    try {
      result = await dispatch(args);
    } catch (e) {
      dispatchErr = e;
    }
    const elapsedMs = Number(process.hrtime.bigint() - startNs) / 1e6;

    // 3. Receipt.
    const outcome = dispatchErr ? "error" : "ok";
    const refusal = dispatchErr ? (dispatchErr.code || dispatchErr.message || "dispatch_error") : null;
    const body = buildReceiptBody({
      leaseId: lease.id,
      classification,
      args,
      result,
      outcome,
      refusal,
      elapsedMs,
      orderId: orderId || result?.order_id || null,
      actor: actor || lease.actor || null,
      targetProject: targetProject || lease.targetProject || null,
      adapterId,
    });
    const { record, receipt } = await writeReceipt(body, { fluxRoot, writer });

    if (dispatchErr) {
      // Re-throw the original error, but attach the receipt for context.
      if (dispatchErr instanceof Error) {
        dispatchErr.receipt = receipt;
        throw dispatchErr;
      }
      throw new AuditTracerError(String(dispatchErr), {
        code: ERROR_CODES.TRACE_WRITE_FAILED,
        receipt,
        cause: dispatchErr,
      });
    }

    return { ok: true, result, receipt, record };
  };
}

// ─── meta ───────────────────────────────────────────────────────────────────

export const TRACER_META = Object.freeze({
  id: TRACER_ID,
  schema: RECEIPT_SCHEMA,
  kind: RECEIPT_KIND,
  origin: RECEIPT_ORIGIN,
  lane: FLUX_LANE,
  ladder: RISK_LADDER,
});
