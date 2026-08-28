// LOOM gate 5 — codexa_lease
//
// Hermes pre-flight gate 5 of 8. Confirms that the action arriving at the
// LOOM chain is wrapped in a lease, the lease has not expired, the lease
// actor matches the actor proposing the action, and the requested action
// verb is on the lease's `allowed` list and NOT on its `forbidden` list
// (with the Hermes default-forbidden set auto-merged in).
//
// Hermes doctrine recap (so this file is self-contained):
//   Hermes replaces "OpenClaw". It is the bounded execution layer through
//   which every action by every LLM in the AtomEons superstack must pass.
//   Before any action lands, all 8 LOOM gates must pass:
//
//     1. order_schema     — order matches orange.order.v1
//     2. report_schema    — report matches orange.report.v1
//     3. receipt_spine    — receipt_path exists and links
//     4. human_approval   — if lease.requires_approval, operator approved
//     5. codexa_lease     — (this file) lease present, active, actor-matched
//     6. openai_gateway   — gateway-mediated, not direct frontier socket
//     7. mcp_default      — default MCP handshake
//     8. false_green_guard — no fake-green words in status
//
//   Frontier isolation: the frontier model NEVER touches Hermes directly.
//   It speaks to the gateway; the gateway calls Hermes on the loopback
//   socket 127.0.0.1:7430 via gateway /v1/hermes/* routes. This gate does
//   not enforce that property itself (that is gate 6, openai_gateway), but
//   it operates under the assumption.
//
// Lease shape (canonical):
//
//   {
//     id:               string  (non-empty, stable for the duration of the lease)
//     actor:            string  (e.g. "claude-opus-4-7", "codex-cli", "frontier-llm-1")
//     allowed:          string[] (action verbs the actor may use)
//     forbidden:        string[] (action verbs the actor may NEVER use; the
//                                 Hermes default-forbidden set is auto-merged in)
//     targetProject:    string  (slug, e.g. "Orange5", "blueb0x")
//     riskLevel:        "read_only" | "low" | "medium" | "high" | "destructive" | "production"
//     expires_at:       string  (RFC 3339 timestamp; strictly in the future at gate time)
//     requires_approval: boolean (gate 4 enforces approval; gate 5 only carries the flag)
//   }
//
// Default forbidden set (always merged into lease.forbidden, even if absent
// or actively removed by the issuer):
//
//   - destructive_write
//   - production_deploy
//   - scope_expansion
//   - egress_unbounded
//
// These four verbs are non-negotiable. A lease that explicitly tries to
// *allow* one of them is rejected: defaults win, and we surface a reason
// so the issuer sees the override attempt.
//
// Module shape:
//   - default export: async function codexaLeaseGate(input, opts?) → { pass, reasons, lease? }
//   - named exports:  codexaLeaseGate, resolveLease, resolveActor,
//                     resolveRequestedAction, mergeForbidden, validateLeaseShape,
//                     isLeaseActive, isActorMatched, isActionAuthorized,
//                     DEFAULT_FORBIDDEN, GATE_ID, GATE_INDEX, REASON_*
//
// Input contract:
//   `input` is the order or wrapped envelope passed down the LOOM chain.
//   The gate finds the lease in this order:
//     1. opts.lease                    — explicit override (tests, replay)
//     2. input.lease                   — wrapped envelope (most common)
//     3. input.order?.lease            — doubly-wrapped envelope
//   If none is present the gate fails with REASON_NO_LEASE.
//
//   The "actor proposing the action" is resolved in this order:
//     1. opts.actor                    — explicit override
//     2. input.actor                   — envelope-level
//     3. input.order?.actor            — nested order envelope
//     4. input.proposed_by             — alternate naming we've seen in
//                                        early Hermes adapters
//   If none is present the gate fails with REASON_NO_ACTOR.
//
//   The requested action verb is resolved in this order:
//     1. opts.action                   — explicit override
//     2. input.action                  — envelope-level
//     3. input.order?.intent           — `intent` IS the action verb at the
//                                        order layer in orange.order.v1
//     4. input.intent                  — envelope-level (un-nested)
//   If none is present the gate fails with REASON_NO_ACTION.
//
// Honest gaps (read me):
//   - This gate does NOT verify that the lease was issued by a trusted
//     authority (no signature check, no JWK/JWS, no issuer cert). Lease
//     authenticity is established at the gateway boundary (gate 6) and at
//     the Hermes daemon ingress, before the order reaches the LOOM chain.
//     If lease signing is added later, slot it in as a separate check —
//     do not overload this gate.
//   - `expires_at` is parsed with `Date.parse`. A permissive RFC 3339-ish
//     regex pre-screens the format. Strings that pass the regex but
//     describe a semantically invalid date (Date.parse → NaN) are rejected.
//     No timezone normalisation beyond what `Date.parse` provides.
//   - We compare actor identity by exact string match. There is no aliasing
//     or canonicalisation (no "claude-opus-4-7" ≡ "Claude Opus 4.7"). If
//     the upstream identity layer ever produces non-canonical names, the
//     fix belongs there, not here — a lease gate that quietly accepts
//     fuzzy matches is exactly the failure mode this gate exists to stop.
//   - Action authorisation is verb-exact. Wildcard or pattern matching
//     ("write.*") is not supported on purpose. Verb lists must be explicit.
//   - We do not consult the receipt spine to confirm that the lease was
//     written into a prior receipt. That cross-check is an out-of-band
//     audit run by the operator's replay tooling.
//   - No I/O. This gate is pure validation against the in-memory input
//     plus the constants in this file. Requires Node 20+ (object spread,
//     Array.isArray, etc. — nothing exotic).
//
// Return shape contract (matches sibling gates 1–4):
//   { pass: boolean, reasons: string[], lease?: object, actor?: string, action?: string }
//   - `lease` is present (echoed) whenever a lease object was successfully
//     resolved, even if the gate later failed on activity / actor / action.
//     This makes downstream logging and false_green_guard formatting
//     easier; nothing in this gate's contract depends on it.

export const GATE_ID = "codexa_lease";
export const GATE_INDEX = 5;

// Default-forbidden verbs. Auto-merged into every lease, every time.
// If the operator ever needs to grant one of these, the policy decision
// must happen above Hermes — never by mutating this list inline.
export const DEFAULT_FORBIDDEN = Object.freeze([
  "destructive_write",
  "production_deploy",
  "scope_expansion",
  "egress_unbounded",
]);

// Lease shape required-field set. Mirrors the doctrinal lease shape from
// the Hermes spec; kept in this file because gate 5 is the canonical
// enforcer of that shape inside the LOOM chain.
const LEASE_REQUIRED = Object.freeze([
  "id",
  "actor",
  "allowed",
  "forbidden",
  "targetProject",
  "riskLevel",
  "expires_at",
  "requires_approval",
]);

// Risk-level enum, matched 1:1 with orange.order.v1 `riskLevel` so that
// gate 1 and gate 5 cannot disagree about what is a legal value.
const LEASE_RISK_LEVELS = Object.freeze([
  "read_only",
  "low",
  "medium",
  "high",
  "destructive",
  "production",
]);

// Permissive RFC 3339-ish pre-screen. Matches gate 1's date-time regex.
const RFC3339_DATETIME = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

// Stable failure-reason tags. Callers (and gate 8, false_green_guard) can
// switch on them without parsing prose.
export const REASON_NO_LEASE        = "codexa_lease: no lease present on input";
export const REASON_NO_ACTOR        = "codexa_lease: no actor identity on input";
export const REASON_NO_ACTION       = "codexa_lease: no action/intent on input";
export const REASON_BAD_LEASE_SHAPE = "codexa_lease: lease shape invalid";
export const REASON_LEASE_EXPIRED   = "codexa_lease: lease expired";
export const REASON_LEASE_BAD_EXPIRY = "codexa_lease: lease expires_at unparseable";
export const REASON_ACTOR_MISMATCH  = "codexa_lease: lease actor does not match proposing actor";
export const REASON_ACTION_NOT_ALLOWED = "codexa_lease: action not on lease.allowed";
export const REASON_ACTION_FORBIDDEN   = "codexa_lease: action on lease.forbidden (or Hermes defaults)";
export const REASON_DEFAULT_OVERRIDE   = "codexa_lease: lease.allowed attempts to override Hermes default-forbidden verb";

/**
 * Pull a lease object out of an input/order/explicit-override.
 * Returns `null` if no candidate lease is present.
 *
 * @param {unknown} input
 * @param {{ lease?: object }} [opts]
 * @returns {object | null}
 */
export function resolveLease(input, opts = {}) {
  if (opts && typeof opts.lease === "object" && opts.lease !== null && !Array.isArray(opts.lease)) {
    return opts.lease;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = /** @type {Record<string, any>} */ (input);
  if (o.lease && typeof o.lease === "object" && !Array.isArray(o.lease)) {
    return o.lease;
  }
  if (o.order && typeof o.order === "object" && !Array.isArray(o.order)) {
    const inner = o.order.lease;
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      return inner;
    }
  }
  return null;
}

/**
 * Pull the actor identity of the entity proposing the action.
 *
 * @param {unknown} input
 * @param {{ actor?: string }} [opts]
 * @returns {string | null}
 */
export function resolveActor(input, opts = {}) {
  if (opts && typeof opts.actor === "string" && opts.actor.length > 0) {
    return opts.actor;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = /** @type {Record<string, any>} */ (input);
  if (typeof o.actor === "string" && o.actor.length > 0) return o.actor;
  if (o.order && typeof o.order === "object" && typeof o.order.actor === "string" && o.order.actor.length > 0) {
    return o.order.actor;
  }
  if (typeof o.proposed_by === "string" && o.proposed_by.length > 0) return o.proposed_by;
  return null;
}

/**
 * Pull the requested action verb. In orange.order.v1, `intent` IS the
 * action verb at the order layer, so we accept it as a fallback.
 *
 * @param {unknown} input
 * @param {{ action?: string }} [opts]
 * @returns {string | null}
 */
export function resolveRequestedAction(input, opts = {}) {
  if (opts && typeof opts.action === "string" && opts.action.length > 0) {
    return opts.action;
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const o = /** @type {Record<string, any>} */ (input);
  if (typeof o.action === "string" && o.action.length > 0) return o.action;
  if (o.order && typeof o.order === "object" && typeof o.order.intent === "string" && o.order.intent.length > 0) {
    return o.order.intent;
  }
  if (typeof o.intent === "string" && o.intent.length > 0) return o.intent;
  return null;
}

/**
 * Merge the Hermes default-forbidden verbs into a lease's forbidden list.
 * Deduplicates. Order: lease-declared first, defaults appended. The
 * returned array is a fresh array; the lease is not mutated.
 *
 * @param {string[] | undefined | null} declared
 * @returns {string[]}
 */
export function mergeForbidden(declared) {
  const out = [];
  const seen = new Set();
  if (Array.isArray(declared)) {
    for (const v of declared) {
      if (typeof v === "string" && v.length > 0 && !seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  for (const v of DEFAULT_FORBIDDEN) {
    if (!seen.has(v)) {
      seen.add(v);
      out.push(v);
    }
  }
  return out;
}

/**
 * Hand-written shape check for a lease. Mirrors the doctrinal lease shape
 * documented at the top of this file. Returns reason strings rather than
 * throwing — callers fold these into the gate's `reasons` array.
 *
 * @param {unknown} lease
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function validateLeaseShape(lease) {
  const reasons = [];
  if (lease === null || typeof lease !== "object" || Array.isArray(lease)) {
    return { pass: false, reasons: [`${REASON_BAD_LEASE_SHAPE}: lease must be a JSON object`] };
  }
  const l = /** @type {Record<string, any>} */ (lease);

  for (const k of LEASE_REQUIRED) {
    if (!Object.prototype.hasOwnProperty.call(l, k)) {
      reasons.push(`${REASON_BAD_LEASE_SHAPE}: missing required field "${k}"`);
    }
  }

  if ("id" in l && (typeof l.id !== "string" || l.id.length === 0)) {
    reasons.push(`${REASON_BAD_LEASE_SHAPE}: id must be non-empty string, got ${JSON.stringify(l.id)}`);
  }
  if ("actor" in l && (typeof l.actor !== "string" || l.actor.length === 0)) {
    reasons.push(`${REASON_BAD_LEASE_SHAPE}: actor must be non-empty string, got ${JSON.stringify(l.actor)}`);
  }
  if ("allowed" in l) {
    if (!Array.isArray(l.allowed)) {
      reasons.push(`${REASON_BAD_LEASE_SHAPE}: allowed must be array of strings, got ${typeof l.allowed}`);
    } else {
      for (let i = 0; i < l.allowed.length; i++) {
        if (typeof l.allowed[i] !== "string" || l.allowed[i].length === 0) {
          reasons.push(`${REASON_BAD_LEASE_SHAPE}: allowed[${i}] must be non-empty string`);
        }
      }
    }
  }
  if ("forbidden" in l) {
    if (!Array.isArray(l.forbidden)) {
      reasons.push(`${REASON_BAD_LEASE_SHAPE}: forbidden must be array of strings, got ${typeof l.forbidden}`);
    } else {
      for (let i = 0; i < l.forbidden.length; i++) {
        if (typeof l.forbidden[i] !== "string" || l.forbidden[i].length === 0) {
          reasons.push(`${REASON_BAD_LEASE_SHAPE}: forbidden[${i}] must be non-empty string`);
        }
      }
    }
  }
  if ("targetProject" in l && (typeof l.targetProject !== "string" || l.targetProject.length === 0)) {
    reasons.push(`${REASON_BAD_LEASE_SHAPE}: targetProject must be non-empty string, got ${JSON.stringify(l.targetProject)}`);
  }
  if ("riskLevel" in l) {
    if (typeof l.riskLevel !== "string" || !LEASE_RISK_LEVELS.includes(l.riskLevel)) {
      reasons.push(`${REASON_BAD_LEASE_SHAPE}: riskLevel must be one of ${LEASE_RISK_LEVELS.join("|")}, got ${JSON.stringify(l.riskLevel)}`);
    }
  }
  if ("expires_at" in l) {
    const isEpochMs = typeof l.expires_at === "number" && Number.isFinite(l.expires_at);
    const isRfc3339 = typeof l.expires_at === "string" && RFC3339_DATETIME.test(l.expires_at);
    if (!isEpochMs && !isRfc3339) {
      reasons.push(`${REASON_BAD_LEASE_SHAPE}: expires_at must be epoch-ms number or RFC 3339 date-time string, got ${JSON.stringify(l.expires_at)}`);
    }
  }
  if ("requires_approval" in l && typeof l.requires_approval !== "boolean") {
    reasons.push(`${REASON_BAD_LEASE_SHAPE}: requires_approval must be boolean, got ${typeof l.requires_approval}`);
  }

  return { pass: reasons.length === 0, reasons };
}

/**
 * Check that a (shape-valid) lease's `expires_at` is strictly in the
 * future, relative to `now`. `now` is parameterised so tests can pin
 * time without mocking the global Date.
 *
 * @param {object} lease  shape-validated lease
 * @param {{ now?: Date | number }} [opts]
 * @returns {{ pass: boolean, reasons: string[], expiresAtMs?: number }}
 */
export function isLeaseActive(lease, opts = {}) {
  const reasons = [];
  const nowMs = opts.now instanceof Date
    ? opts.now.getTime()
    : typeof opts.now === "number"
      ? opts.now
      : Date.now();
  const expiresAtMs = typeof lease.expires_at === "number"
    ? lease.expires_at
    : Date.parse(lease.expires_at);
  if (Number.isNaN(expiresAtMs)) {
    reasons.push(`${REASON_LEASE_BAD_EXPIRY}: ${JSON.stringify(lease.expires_at)}`);
    return { pass: false, reasons };
  }
  if (expiresAtMs <= nowMs) {
    reasons.push(`${REASON_LEASE_EXPIRED}: expires_at=${lease.expires_at}, now=${new Date(nowMs).toISOString()}`);
    return { pass: false, reasons, expiresAtMs };
  }
  return { pass: true, reasons: [], expiresAtMs };
}

/**
 * Confirm the proposing actor exactly equals the lease's bound actor.
 *
 * @param {object} lease
 * @param {string} actor
 * @returns {{ pass: boolean, reasons: string[] }}
 */
export function isActorMatched(lease, actor) {
  if (lease.actor !== actor) {
    return {
      pass: false,
      reasons: [`${REASON_ACTOR_MISMATCH}: lease.actor=${JSON.stringify(lease.actor)}, proposing actor=${JSON.stringify(actor)}`],
    };
  }
  return { pass: true, reasons: [] };
}

/**
 * Confirm the requested action verb is on `allowed` and NOT on the
 * effective forbidden set (lease.forbidden ∪ DEFAULT_FORBIDDEN). Also
 * surfaces an explicit reason if the lease tried to *allow* a verb that
 * is in DEFAULT_FORBIDDEN — that override attempt is a hard reject, not
 * just a silently-ignored entry.
 *
 * @param {object} lease   shape-validated lease
 * @param {string} action  requested action verb
 * @returns {{ pass: boolean, reasons: string[], effectiveForbidden: string[] }}
 */
export function isActionAuthorized(lease, action) {
  const reasons = [];
  const effectiveForbidden = mergeForbidden(lease.forbidden);

  // Override attempt: lease lists a default-forbidden verb under `allowed`.
  for (const v of DEFAULT_FORBIDDEN) {
    if (Array.isArray(lease.allowed) && lease.allowed.includes(v)) {
      reasons.push(`${REASON_DEFAULT_OVERRIDE}: ${JSON.stringify(v)}`);
    }
  }

  if (!Array.isArray(lease.allowed) || !lease.allowed.includes(action)) {
    reasons.push(`${REASON_ACTION_NOT_ALLOWED}: action=${JSON.stringify(action)}, allowed=${JSON.stringify(lease.allowed)}`);
  }
  if (effectiveForbidden.includes(action)) {
    reasons.push(`${REASON_ACTION_FORBIDDEN}: action=${JSON.stringify(action)}, forbidden=${JSON.stringify(effectiveForbidden)}`);
  }

  return { pass: reasons.length === 0, reasons, effectiveForbidden };
}

/**
 * LOOM gate 5 entry point. Pure async (no I/O) — declared async to match
 * sibling gate signatures so the chain runner can `await` uniformly. Never
 * throws on validation failure; only re-throws if a caller passes a
 * structurally-broken `opts` that no validator could recover from (we do
 * not currently have such a case, but the contract leaves room for it).
 *
 * @param {unknown} input  order / envelope being processed
 * @param {{
 *   lease?: object,
 *   actor?: string,
 *   action?: string,
 *   now?: Date | number,
 * }} [opts]
 *   - `lease`:  explicit override; bypasses lease discovery on the input.
 *   - `actor`:  explicit override; bypasses actor discovery on the input.
 *   - `action`: explicit override; bypasses action/intent discovery.
 *   - `now`:    pinned wall-clock for expiry comparison (tests, replay).
 * @returns {Promise<{ pass: boolean, reasons: string[], lease?: object, actor?: string, action?: string, effectiveForbidden?: string[] }>}
 */
export async function codexaLeaseGate(input, opts = {}) {
  const reasons = [];

  const lease = resolveLease(input, opts);
  if (lease === null) {
    return { pass: false, reasons: [REASON_NO_LEASE] };
  }

  const actor = resolveActor(input, opts);
  const action = resolveRequestedAction(input, opts);

  // Shape first. Without shape, the downstream checks are meaningless.
  const shape = validateLeaseShape(lease);
  if (!shape.pass) {
    // Still echo the lease so logs can attach.
    return { pass: false, reasons: shape.reasons, lease };
  }

  // After shape passes we need actor and action; if either is missing,
  // the proposing side did not provide enough to authorise anything.
  if (actor === null) reasons.push(REASON_NO_ACTOR);
  if (action === null) reasons.push(REASON_NO_ACTION);
  if (reasons.length > 0) {
    return { pass: false, reasons, lease };
  }

  const active = isLeaseActive(lease, { now: opts.now });
  if (!active.pass) {
    return { pass: false, reasons: active.reasons, lease, actor, action };
  }

  const matched = isActorMatched(lease, actor);
  if (!matched.pass) {
    return { pass: false, reasons: matched.reasons, lease, actor, action };
  }

  const authz = isActionAuthorized(lease, action);
  if (!authz.pass) {
    return {
      pass: false,
      reasons: authz.reasons,
      lease,
      actor,
      action,
      effectiveForbidden: authz.effectiveForbidden,
    };
  }

  return {
    pass: true,
    reasons: [],
    lease,
    actor,
    action,
    effectiveForbidden: authz.effectiveForbidden,
  };
}

export default codexaLeaseGate;
