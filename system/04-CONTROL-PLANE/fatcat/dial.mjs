// dial.mjs — FATCAT extension router (the switchboard).
//
// Pipeline position:
//
//   AELang-High  →  AELang-Core  →  ORANGEBOX Route Packet
//        ↓                ↓                   ↓
//   high-parser     core-emitter         route-packet
//                                              ↓
//                                         dial.mjs   ← YOU ARE HERE
//                                              ↓
//                                       Destination handler
//                                       (registered by extension code)
//
// ─────────────────────────────────────────────────────────────────────────────
// What this is
// ─────────────────────────────────────────────────────────────────────────────
//
// dial.mjs is the FATCAT phone-switch. It receives a Route Packet produced by
// `04-CONTROL-PLANE/aelang/route-packet.mjs`, resolves a PUBLIC DIAL CODE from
// the packet (or an operator override), validates the call, runs the gates the
// authority section demands, and dispatches to a registered destination
// handler. Every call writes a party-line entry so other departments can
// follow the conversation in real time.
//
// Two extension spaces exist on purpose:
//
//   1. INTERNAL extensions  ("x00"..."x14")  — one per AE department.
//      Built by route-packet.mjs.  These live INSIDE the org.
//
//   2. PUBLIC DIAL CODES    (100, 103, 106, 107, 111, 114, 200, 911)
//      Operator-facing short codes. These are what Atom (or an upstream
//      router) actually "dials" to reach a service lane. They cluster a
//      lane that may span departments (e.g. CHECKMATE bundles AE7-review +
//      AE13-automation + human stop).
//
// The router is route-first and receipt-first. It MUST NOT silently fall back
// to a default destination. If a dial code does not resolve to a handler the
// call is rejected with a structured error and a party-line BLOCKED entry.
//
// ─────────────────────────────────────────────────────────────────────────────
// Public dial plan (single source of truth)
// ─────────────────────────────────────────────────────────────────────────────
//
//   100  AE0_FACTORY        factory boot, top-level orchestration
//   103  LIPS               phrasing, UX feel, emotional clarity
//   106  AE6_CODE           normal code writing lane
//   107  MIRRORS            reality-contact, contradiction detection
//   111  AE11_SECURITY      security review, threat model, blockers
//   114  CHECKMATE          final verdict / kill-switch; can stop promotion
//   200  CODEXA_HEAVY       external Codex execution lane (filesystem authority)
//   911  OPERATOR_PAUSE     Human Final Stop — interrupt every running call
//
// The map is FROZEN. Adding a code requires editing this file AND the test
// fixtures — no silent expansion at runtime.
//
// ─────────────────────────────────────────────────────────────────────────────
// Mom's Law: every branch earns its place. Same packet + same handlers →
// byte-identical outcome (modulo the timestamps we explicitly capture).

import {
  validateRoutePacket,
  DEPARTMENT_EXTENSIONS,
} from "../aelang/route-packet.mjs";
import { appendPartyLine } from "./party-line.mjs";

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 1 — Dial plan tables (frozen).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Public dial code → semantic destination.
 * `department` may be a real AE department (matched against
 * DEPARTMENT_EXTENSIONS) OR a synthetic lane name (LIPS, MIRRORS, CHECKMATE,
 * CODEXA_HEAVY, OPERATOR_PAUSE) that does NOT have an internal x-extension.
 */
export const DIAL_PLAN = Object.freeze({
  100: Object.freeze({ code: 100, name: "AE0_FACTORY",     department: "AE0_FACTORY",     synthetic: false, kind: "orchestrator" }),
  103: Object.freeze({ code: 103, name: "LIPS",            department: "LIPS",            synthetic: true,  kind: "perspective"   }),
  106: Object.freeze({ code: 106, name: "AE6_CODE",        department: "AE6_CODE",        synthetic: false, kind: "writer"        }),
  107: Object.freeze({ code: 107, name: "MIRRORS",         department: "MIRRORS",         synthetic: true,  kind: "perspective"   }),
  111: Object.freeze({ code: 111, name: "AE11_SECURITY",   department: "AE11_SECURITY",   synthetic: false, kind: "gate"          }),
  114: Object.freeze({ code: 114, name: "CHECKMATE",       department: "CHECKMATE",       synthetic: true,  kind: "verdict"       }),
  200: Object.freeze({ code: 200, name: "CODEXA_HEAVY",    department: "CODEXA_HEAVY",    synthetic: true,  kind: "executor"      }),
  911: Object.freeze({ code: 911, name: "OPERATOR_PAUSE",  department: "OPERATOR_PAUSE",  synthetic: true,  kind: "interrupt"     }),
});

/** Department → public dial code. Built once from DIAL_PLAN. */
export const DEPARTMENT_TO_DIAL = Object.freeze(
  Object.values(DIAL_PLAN).reduce((acc, entry) => {
    acc[entry.department] = entry.code;
    return acc;
  }, /** @type {Object<string,number>} */ ({})),
);

/**
 * Internal extension ("x06") → public dial code (106).
 * Only built for entries whose department resolves to a real x-extension.
 */
export const EXTENSION_TO_DIAL = Object.freeze(
  Object.values(DIAL_PLAN).reduce((acc, entry) => {
    const ext = DEPARTMENT_EXTENSIONS[entry.department];
    if (ext) acc[ext] = entry.code;
    return acc;
  }, /** @type {Object<string,number>} */ ({})),
);

/** Codes the operator may dial to interrupt running calls. */
export const INTERRUPT_CODES = Object.freeze([911]);

/** Codes that demand Human Final Stop regardless of authority.required_gates. */
export const HFS_CODES = Object.freeze([200, 911]);

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 2 — Errors.
// ─────────────────────────────────────────────────────────────────────────────

export class DialError extends Error {
  /**
   * @param {string} code   - machine-readable error code (E_*)
   * @param {string} message
   * @param {Object} [meta]
   */
  constructor(code, message, meta = {}) {
    super(message);
    this.name = "DialError";
    this.code = code;
    this.meta = meta;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 3 — Handler registry.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DialHandler
 * @property {number} code                              - dial code this handler answers
 * @property {string} name                              - matches DIAL_PLAN[code].name
 * @property {(ctx: DialContext) => Promise<DialResult>} invoke
 *
 * @typedef {Object} DialContext
 * @property {import("../aelang/route-packet.mjs").RoutePacket} packet
 * @property {number} dial_code
 * @property {Readonly<{code:number,name:string,department:string,synthetic:boolean,kind:string}>} plan_entry
 * @property {string} call_id
 * @property {string} dialed_at_iso
 *
 * @typedef {Object} DialResult
 * @property {boolean} ok
 * @property {string} [reason]
 * @property {Object} [output]
 * @property {Array<{code:string,message:string}>} [errors]
 */

const HANDLERS = new Map();

/**
 * Register a handler for a dial code. Throws if the code is unknown or already
 * registered. Caller can pass {overwrite:true} to replace (test fixtures).
 *
 * @param {DialHandler} handler
 * @param {{overwrite?: boolean}} [opts]
 */
export function registerHandler(handler, opts = {}) {
  if (!handler || typeof handler !== "object") {
    throw new DialError("E_BAD_HANDLER", "handler must be object");
  }
  if (!Number.isInteger(handler.code)) {
    throw new DialError("E_BAD_HANDLER_CODE", "handler.code must be integer");
  }
  if (!DIAL_PLAN[handler.code]) {
    throw new DialError("E_UNKNOWN_DIAL", `no dial plan entry for code ${handler.code}`);
  }
  if (typeof handler.invoke !== "function") {
    throw new DialError("E_HANDLER_INVOKE", "handler.invoke must be function");
  }
  if (HANDLERS.has(handler.code) && !opts.overwrite) {
    throw new DialError("E_HANDLER_EXISTS", `handler already registered for ${handler.code}`);
  }
  HANDLERS.set(handler.code, handler);
  return handler;
}

export function getHandler(code) {
  return HANDLERS.get(code) || null;
}

export function listHandlers() {
  return Array.from(HANDLERS.values()).map(h => ({ code: h.code, name: h.name }));
}

export function clearHandlers() {
  HANDLERS.clear();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 4 — Dial-code resolution.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve a public dial code from a Route Packet. Resolution order:
 *   1. explicit headers["X-AE-Dial-Code"]            (operator override)
 *   2. opts.dial_code                                (programmatic override)
 *   3. DEPARTMENT_TO_DIAL[packet.to.department]      (synthetic dest)
 *   4. EXTENSION_TO_DIAL[packet.to.extension]        (internal x-ext)
 *
 * Returns the integer code, or throws DialError("E_NO_DIAL_CODE").
 *
 * @param {import("../aelang/route-packet.mjs").RoutePacket} packet
 * @param {{ dial_code?: number }} [opts]
 * @returns {number}
 */
export function resolveDialCode(packet, opts = {}) {
  // 1) Explicit header override (string in transport headers).
  const hdr = packet?.headers?.["X-AE-Dial-Code"];
  if (typeof hdr === "string" && hdr.length > 0) {
    const n = Number.parseInt(hdr, 10);
    if (Number.isInteger(n) && DIAL_PLAN[n]) return n;
    throw new DialError("E_BAD_DIAL_HEADER", `X-AE-Dial-Code "${hdr}" is not a known dial code`);
  }
  // 2) Programmatic override.
  if (Number.isInteger(opts.dial_code)) {
    if (!DIAL_PLAN[opts.dial_code]) {
      throw new DialError("E_BAD_DIAL_OPT", `opts.dial_code ${opts.dial_code} is not a known dial code`);
    }
    return opts.dial_code;
  }
  // 3) Department → dial.
  const dept = packet?.to?.department;
  if (dept && Number.isInteger(DEPARTMENT_TO_DIAL[dept])) {
    return DEPARTMENT_TO_DIAL[dept];
  }
  // 4) Internal extension → dial.
  const ext = packet?.to?.extension;
  if (ext && Number.isInteger(EXTENSION_TO_DIAL[ext])) {
    return EXTENSION_TO_DIAL[ext];
  }
  throw new DialError("E_NO_DIAL_CODE", `no dial code resolves for department="${dept}" extension="${ext}"`, {
    department: dept,
    extension: ext,
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 5 — Gate checks.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} GateCheckResult
 * @property {boolean} ok
 * @property {string[]} satisfied
 * @property {string[]} missing
 */

/**
 * Verify that the required_gates listed on the Route Packet's authority
 * section are satisfied by the gates the caller supplies. Also enforces
 * HFS_CODES — dialing 200/911 always requires human_final_stop.
 *
 * @param {import("../aelang/route-packet.mjs").RoutePacket} packet
 * @param {number} dialCode
 * @param {string[]} supplied
 * @returns {GateCheckResult}
 */
export function checkGates(packet, dialCode, supplied = []) {
  const required = new Set(packet?.authority?.required_gates || []);
  if (HFS_CODES.includes(dialCode)) required.add("human_final_stop");
  const have = new Set(supplied);
  const satisfied = [];
  const missing = [];
  for (const g of required) {
    if (have.has(g)) satisfied.push(g);
    else missing.push(g);
  }
  return { ok: missing.length === 0, satisfied, missing };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 6 — Main entry: dial().
// ─────────────────────────────────────────────────────────────────────────────

/**
 * @typedef {Object} DialOptions
 * @property {number} [dial_code]                      - override resolved code
 * @property {string[]} [gates_satisfied]              - gate IDs already passed upstream
 * @property {boolean} [require_gates]                 - default true; if false, skip gate enforcement
 * @property {string} [now]                            - ISO timestamp, default Date.now()
 * @property {string} [party_line_path]                - override JSONL sink path
 * @property {boolean} [emit_party_line]               - default true
 * @property {string} [reason]                         - optional operator note (logged)
 */

/**
 * Route a Route Packet through the FATCAT switch.
 *
 * Flow:
 *   1. structural validate the Route Packet (defense-in-depth — upstream
 *      validates too, but never trust the wire).
 *   2. resolve dial code.
 *   3. check authority gates (unless explicitly disabled).
 *   4. interrupt codes (911) → write party-line and return BLOCKED without
 *      invoking a handler unless one is registered for the interrupt.
 *   5. look up handler. No handler → BLOCKED, no fall-back.
 *   6. invoke handler. Capture timing, errors, output.
 *   7. write party-line entry (ROUTED → COMPLETED / FAILED).
 *
 * @param {import("../aelang/route-packet.mjs").RoutePacket} packet
 * @param {DialOptions} [opts]
 * @returns {Promise<{ ok: boolean, dial_code: number|null, call_id: string, result: DialResult|null, errors: Array<{code:string,message:string}>, party_line: Object|null }>}
 */
export async function dial(packet, opts = {}) {
  const errors = [];
  const requireGates = opts.require_gates !== false;
  const emitParty = opts.emit_party_line !== false;
  const dialedAt = _coerceISO(opts.now) || new Date().toISOString();
  // Deterministic call_id from packet route_id + dial timestamp. Two identical
  // packets dialed at the same instant produce the same id — desired for
  // dedupe / idempotency at the party-line layer.
  const callId = `call-${packet?.route_id || "unknown"}-${dialedAt}`;

  // 1) Structural validate.
  const v = validateRoutePacket(packet);
  if (!v.ok) {
    for (const e of v.errors) errors.push({ code: e.code, message: e.message });
    const pl = emitParty ? await _writeParty({
      opts, status: "BLOCKED", reason: "INVALID_PACKET",
      call_id: callId, dialed_at_iso: dialedAt, dial_code: null, packet, extra: { validation_errors: v.errors },
    }) : null;
    return { ok: false, dial_code: null, call_id: callId, result: null, errors, party_line: pl };
  }

  // 2) Resolve dial code.
  let dialCode;
  try {
    dialCode = resolveDialCode(packet, opts);
  } catch (err) {
    errors.push({ code: err.code || "E_RESOLVE", message: err.message });
    const pl = emitParty ? await _writeParty({
      opts, status: "BLOCKED", reason: "NO_DIAL_CODE",
      call_id: callId, dialed_at_iso: dialedAt, dial_code: null, packet, extra: { error: err.meta || {} },
    }) : null;
    return { ok: false, dial_code: null, call_id: callId, result: null, errors, party_line: pl };
  }

  const planEntry = DIAL_PLAN[dialCode];

  // 3) Gates.
  if (requireGates) {
    const g = checkGates(packet, dialCode, opts.gates_satisfied || []);
    if (!g.ok) {
      errors.push({ code: "E_GATES_MISSING", message: `missing gates: ${g.missing.join(",")}` });
      const pl = emitParty ? await _writeParty({
        opts, status: "BLOCKED", reason: "GATES_MISSING",
        call_id: callId, dialed_at_iso: dialedAt, dial_code: dialCode, packet, extra: { missing: g.missing, satisfied: g.satisfied },
      }) : null;
      return { ok: false, dial_code: dialCode, call_id: callId, result: null, errors, party_line: pl };
    }
  }

  // 4) Announce ROUTED on the party-line before invoking. Side-channel
  // observers (other departments) want to see the call land BEFORE the
  // handler runs, in case the handler blocks for a long time.
  if (emitParty) {
    await _writeParty({
      opts, status: "ROUTED", reason: opts.reason || null,
      call_id: callId, dialed_at_iso: dialedAt, dial_code: dialCode, packet,
    });
  }

  // 5) Handler lookup. No silent fall-back. If the operator dials a code with
  // no handler we return BLOCKED — better than guessing.
  const handler = getHandler(dialCode);
  if (!handler) {
    errors.push({ code: "E_NO_HANDLER", message: `no handler registered for dial ${dialCode} (${planEntry.name})` });
    const pl = emitParty ? await _writeParty({
      opts, status: "BLOCKED", reason: "NO_HANDLER",
      call_id: callId, dialed_at_iso: dialedAt, dial_code: dialCode, packet,
    }) : null;
    return { ok: false, dial_code: dialCode, call_id: callId, result: null, errors, party_line: pl };
  }

  // 6) Invoke. Wrap in try/catch so a thrown handler never crashes the switch.
  /** @type {DialContext} */
  const ctx = {
    packet,
    dial_code: dialCode,
    plan_entry: planEntry,
    call_id: callId,
    dialed_at_iso: dialedAt,
  };

  let result;
  let invokeError = null;
  const startedAt = Date.now();
  try {
    result = await handler.invoke(ctx);
    if (!result || typeof result !== "object" || typeof result.ok !== "boolean") {
      throw new DialError("E_HANDLER_RESULT", "handler must return { ok: boolean, ... }");
    }
  } catch (err) {
    invokeError = err;
    result = {
      ok: false,
      reason: err.code || "E_HANDLER_THROW",
      errors: [{ code: err.code || "E_HANDLER_THROW", message: err.message || String(err) }],
    };
  }
  const elapsedMs = Date.now() - startedAt;

  // 7) Party-line completion entry.
  const status = result.ok ? "COMPLETED" : (invokeError ? "FAILED" : "REJECTED");
  const pl = emitParty ? await _writeParty({
    opts, status, reason: result.reason || (invokeError ? invokeError.message : null),
    call_id: callId, dialed_at_iso: dialedAt, dial_code: dialCode, packet,
    extra: { elapsed_ms: elapsedMs, result_errors: result.errors || [] },
  }) : null;

  if (!result.ok) {
    for (const e of (result.errors || [])) errors.push(e);
  }

  return {
    ok: result.ok,
    dial_code: dialCode,
    call_id: callId,
    result,
    errors,
    party_line: pl,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 7 — Party-line helper.
// ─────────────────────────────────────────────────────────────────────────────

async function _writeParty({ opts, status, reason, call_id, dialed_at_iso, dial_code, packet, extra }) {
  const entry = {
    call_id,
    dialed_at_iso,
    status,
    reason: reason || null,
    dial_code,
    dial_name: dial_code != null ? (DIAL_PLAN[dial_code]?.name || null) : null,
    from: packet?.from || null,
    to_department: packet?.to?.department || null,
    to_extension: packet?.to?.extension || null,
    risk_level: packet?.authority?.risk_level || null,
    priority: packet?.authority?.priority ?? null,
    action_verb: packet?.core?.action_verb || null,
    artifact_primary: packet?.artifacts?.primary || null,
    correlation_id: packet?.dispatch_meta?.correlation_id || null,
    extra: extra || {},
  };
  return appendPartyLine(entry, { path: opts.party_line_path });
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 8 — Tiny utilities.
// ─────────────────────────────────────────────────────────────────────────────

function _coerceISO(s) {
  if (typeof s !== "string" || s.length === 0) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

// ─────────────────────────────────────────────────────────────────────────────
// SECTION 9 — CLI: read JSON Route Packet on stdin, dial it, print result.
//
//   node dial.mjs < packet.json
//   node dial.mjs --dial 911 < packet.json
//   node dial.mjs --gates "gauntlet.unit,gauntlet.security,review.AE7" < packet.json
//
// Does NOT register any handlers — CLI is for integration smoke tests; the
// dispatcher process registers handlers before calling dial().
// ─────────────────────────────────────────────────────────────────────────────

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, "/")}`) {
  const args = process.argv.slice(2);
  /** @type {DialOptions} */
  const opts = { require_gates: true };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dial" && args[i + 1]) { opts.dial_code = Number.parseInt(args[++i], 10); }
    else if (args[i] === "--gates" && args[i + 1]) { opts.gates_satisfied = args[++i].split(",").map(s => s.trim()).filter(Boolean); }
    else if (args[i] === "--no-gates") { opts.require_gates = false; }
    else if (args[i] === "--no-party") { opts.emit_party_line = false; }
    else if (args[i] === "--party" && args[i + 1]) { opts.party_line_path = args[++i]; }
  }
  let raw = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) raw += chunk;
  let pkt;
  try { pkt = JSON.parse(raw); }
  catch (err) {
    console.error(JSON.stringify({ ok: false, stage: "parse", error: err.message }, null, 2));
    process.exit(2);
  }
  const out = await dial(pkt, opts);
  console.log(JSON.stringify(out, null, 2));
  process.exit(out.ok ? 0 : 1);
}
