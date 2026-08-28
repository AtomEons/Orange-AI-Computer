// 09-human-stop.mjs — Gate 9 Human Final Stop of the 9-Gate Stack.
//
// Position in the 9-Gate Stack: NINTH and LAST (after LBCE, Scope, Department,
// Triad, HRE, Security, Drift, Receipt, CHECKMATE). Bypassable: false.
// Target: ~30ms loopback when the Hermes daemon answers; ~5ms when approval
// state is injected for tests. Async — uses global fetch (Node 20+).
//
// Purpose: this gate is the operator's last veto. Even if every prior gate
// passed and the action is on the doorstep of landing, an action whose
// riskLevel sits at high, destructive, or production cannot land without a
// signed approval from the Sovereign sitting in the Hermes /approvals
// queue. Low- and medium-risk actions pass through this gate as no-ops —
// the Human Final Stop is reserved for the actions that warrant a human
// hand on the kill switch, not for paperwork friction on routine work.
//
// This gate is the codified form of the "Human Final Stop Authority"
// invariant tracked by Gate 6 (drift). Gate 6 verifies the invariant is
// REACHABLE in the codebase; Gate 9 is the place where it is actually
// EXERCISED. The two gates are paired: removing Gate 9 would cause Gate 6
// to fail its drift check at the next stack run.
//
// Four checks, in order, all must hold:
//
//   A. Risk level present and well-formed
//      action.riskLevel MUST be a string in the canonical risk set:
//        low | medium | high | destructive | production
//      An action with no riskLevel, or with an unknown value, is refused
//      with reason `risk_level_missing` or `risk_level_unknown`. Refusing
//      on "unknown" is deliberate — Mom's Law: an action that does not
//      know its own risk cannot land. We do not silently default to "low".
//
//   B. Triage — does the action need an approval?
//      If risk ∈ { low, medium }: this gate is a no-op pass.
//      If risk ∈ { high, destructive, production }: continue to C and D.
//      The triage decision is recorded in evidence so the operator can
//      see at a glance whether Gate 9 actually gated this action or
//      waved it through as low-risk.
//
//   C. Approval state acquired
//      The gate must read the current approvals list. Three sources, in
//      preference order:
//        1. ctx.approvals — an array of approval records injected by the
//           caller (tests, replay, the gate-stack driver under
//           gate_stack_offline=true). When present, no I/O occurs.
//        2. ctx.fetch — a fetch-shaped function injected by the caller.
//           Same contract as global fetch. Useful for unit tests that
//           want to verify the HTTP request shape without spinning up
//           the daemon.
//        3. Global fetch against the Hermes daemon at
//           http://127.0.0.1:7450/approvals (default; overridable via
//           ctx.hermesUrl or env HERMES_URL). Loopback-only. A 200 with
//           JSON body { approvals: [...] } is accepted; any non-200, a
//           network error, or a malformed body is recorded as the
//           failure reason `approvals_endpoint_unreachable`.
//      The endpoint may also return a bare array; we accept both
//      `{ approvals: [...] }` and `[...]` shapes. Anything else is a
//      schema error.
//
//   D. Sovereign-signed approval exists for THIS action
//      The approvals list is scanned, tail-first (most recent
//      supersedes), for a record whose `action_id` matches
//      action.action_id AND whose `approved === true && signed === true`
//      AND whose `signed_by` matches the configured Sovereign principal
//      (case-insensitive, with the role-name alias "sovereign" also
//      accepted — mirrors the Hermes LOOM gate 4 contract).
//      An approval is rejected if it has expired
//      (approval.expires_at < now, when present). The check uses
//      Date.now() unless ctx.now is supplied for deterministic clocks.
//      The first matching, non-expired, signed, approved record is the
//      pass condition. Otherwise the refusal names exactly what is
//      missing — `approval_not_found`, `approval_denied`,
//      `approval_unsigned`, `approval_expired`, or
//      `approval_signed_by_wrong_principal` — so the operator can see
//      whether they need to approve, re-sign, or extend the window.
//
// Mom's Law: every refusal cites the exact rule broken and points at the
// approval record that broke it (if one exists). No silent fall-through
// to "ok" when the daemon is down. No quiet "low-risk" default for a
// missing risk level. No bypass — not via ctx.bypass, not via env, not
// via the gate-stack driver. The Sovereign override doctrine lives at
// the operator's keyboard, not inside this module.
//
// Threat boundary: this gate trusts that the approvals list returned by
// the Hermes daemon (or the on-disk queue when ctx.approvals is read
// from it) has already had its signatures cryptographically verified by
// the gateway pre-write hook (same boundary documented at
// 08-HERMES/src/loom-gates/04-human-approval.mjs). Gate 9 checks the
// `signed === true && signed_by === sovereign` flag pair; it does not
// re-verify the Ed25519 signature itself. A forged record that slips
// past the gateway will pass Gate 9. Fixing that requires a real
// signature-verification step here; tracked alongside the LOOM gate 4
// roadmap item.

import { resolve as pathResolve, isAbsolute as pathIsAbsolute } from 'node:path'

const GATE_ID = 'gate-9-human-stop'
const GATE_NAME = 'Human Final Stop — operator veto for high/destructive/production'
const BYPASSABLE = false
const POSITION_IN_STACK = 9
const TARGET_MS = 30

// -- Canon ------------------------------------------------------------------

// Risk levels recognised by the gate. Anything outside this set is refused
// as `risk_level_unknown`. The triage split is HIGH_RISK_SET below.
const RISK_LEVELS = Object.freeze([
  'low', 'medium', 'high', 'destructive', 'production',
])
const RISK_SET = new Set(RISK_LEVELS)

// The triage set — actions whose risk level forces the operator gate.
// Low and medium pass through. High, destructive, and production must
// carry a signed approval.
const HIGH_RISK_SET = Object.freeze(new Set(['high', 'destructive', 'production']))

// Default Hermes daemon endpoint. The brief specifies port 7450 for the
// Orange5 9-Gate runtime (the Hermes LOOM daemon authored in wave2 runs on
// 7430 — these are two endpoints on the same daemon process; Gate 9
// targets the 9-Gate-facing surface). Overridable via ctx.hermesUrl or
// env HERMES_URL.
const DEFAULT_HERMES_URL = 'http://127.0.0.1:7450/approvals'

// Default Sovereign principal name. Mirrors the Hermes LOOM gate 4 default
// (08-HERMES/src/loom-gates/04-human-approval.mjs). Overridable via
// ctx.sovereignPrincipal or env HERMES_SOVEREIGN_PRINCIPAL.
const DEFAULT_SOVEREIGN_PRINCIPAL = (
  (typeof process !== 'undefined' && process.env && process.env.HERMES_SOVEREIGN_PRINCIPAL)
    || 'atom'
).toString().trim()

// Some adapters write the role name instead of the principal name. Accept
// both, case-insensitively. Identical to the LOOM gate 4 alias.
const SOVEREIGN_ROLE_ALIAS = 'sovereign'

// Sentinel raised on a bypass attempt. Gate 9 is impassable; any caller
// that supplies ctx.bypass===true gets an exception, not a silent pass.
export class HumanStopBypassAttempt extends Error {
  constructor(message) {
    super(message)
    this.name = 'HumanStopBypassAttempt'
  }
}

// -- Helpers ---------------------------------------------------------------

function nowNs() {
  if (typeof process !== 'undefined' && process.hrtime && process.hrtime.bigint) {
    return process.hrtime.bigint()
  }
  return BigInt(Date.now()) * 1000000n
}

function finish(pass, reason, evidence, startedNs) {
  const took_ms = Number(nowNs() - startedNs) / 1e6
  return {
    gate: GATE_ID,
    gate_id: GATE_ID,
    name: GATE_NAME,
    position: POSITION_IN_STACK,
    bypassable: BYPASSABLE,
    pass,
    reason,
    reasons: pass ? [] : [reason],
    evidence,
    took_ms: Math.round(took_ms * 1000) / 1000,
  }
}

// Case-insensitive sovereign match. Mirrors the LOOM gate 4 implementation
// so an operator's approval is honoured identically at both gates.
function matchesSovereign(signedBy, sovereignPrincipal) {
  if (typeof signedBy !== 'string') return false
  const sb = signedBy.trim().toLowerCase()
  if (sb.length === 0) return false
  const sp = (sovereignPrincipal || DEFAULT_SOVEREIGN_PRINCIPAL).toString().trim().toLowerCase()
  return sb === sp || sb === SOVEREIGN_ROLE_ALIAS
}

// Pull a normalised approvals list out of whatever the endpoint returned.
// Accepts { approvals: [...] }, { items: [...] }, or a bare array. Returns
// { ok: true, approvals } or { ok: false, reason } on a malformed body.
function normaliseApprovalsBody(body) {
  if (Array.isArray(body)) return { ok: true, approvals: body }
  if (body && typeof body === 'object') {
    if (Array.isArray(body.approvals)) return { ok: true, approvals: body.approvals }
    if (Array.isArray(body.items)) return { ok: true, approvals: body.items }
    if (Array.isArray(body.records)) return { ok: true, approvals: body.records }
  }
  return { ok: false, reason: 'approvals_body_malformed' }
}

// Fetch approvals from the Hermes daemon. Returns { ok, approvals, reason,
// detail }. Never throws — a network failure is a structured refusal so the
// gate stack can localise the failure to Gate 9. Uses ctx.fetch when
// supplied, otherwise the global fetch (Node 20+ provides one).
async function fetchApprovals(url, ctx) {
  const f = (ctx && typeof ctx.fetch === 'function') ? ctx.fetch
          : (typeof fetch === 'function' ? fetch : null)
  if (f === null) {
    return { ok: false, reason: 'fetch_unavailable',
      detail: 'no global fetch and no ctx.fetch supplied; Node 20+ required' }
  }
  let res
  try {
    // Hermes daemon is loopback-only; the timeout via AbortController
    // keeps Gate 9 inside the ~200ms-per-gate stack budget even when the
    // daemon hangs. 1500ms is generous for a loopback HTTP call.
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), 1500)
    try {
      res = await f(url, {
        method: 'GET',
        headers: { 'accept': 'application/json' },
        signal: ac.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  } catch (err) {
    return { ok: false, reason: 'approvals_endpoint_unreachable',
      detail: { url, error: String(err && err.message || err) } }
  }
  if (!res || typeof res.status !== 'number') {
    return { ok: false, reason: 'approvals_endpoint_unreachable',
      detail: { url, error: 'no response object' } }
  }
  if (res.status < 200 || res.status >= 300) {
    return { ok: false, reason: 'approvals_endpoint_http_error',
      detail: { url, status: res.status } }
  }
  let body
  try {
    body = await res.json()
  } catch (err) {
    return { ok: false, reason: 'approvals_body_malformed',
      detail: { url, error: String(err && err.message || err) } }
  }
  const n = normaliseApprovalsBody(body)
  if (!n.ok) {
    return { ok: false, reason: 'approvals_body_malformed',
      detail: { url, body_keys: body && typeof body === 'object'
        ? Object.keys(body).slice(0, 10) : typeof body } }
  }
  return { ok: true, approvals: n.approvals }
}

// Find the most recent approval record for an action_id. The approvals
// queue is treated as append-only; later records supersede earlier ones,
// so we walk tail-first and return the first match.
function findApprovalForAction(approvals, actionId) {
  if (!Array.isArray(approvals) || typeof actionId !== 'string' || actionId.length === 0) {
    return null
  }
  for (let i = approvals.length - 1; i >= 0; i -= 1) {
    const r = approvals[i]
    if (r && typeof r === 'object' && r.action_id === actionId) return r
  }
  return null
}

// Evaluate a single approval record against the requirements. Returns
// { ok, reason, detail } — never throws. Pure over (approval, now, principal).
function evaluateApproval(approval, now, sovereignPrincipal) {
  if (!approval || typeof approval !== 'object') {
    return { ok: false, reason: 'approval_not_found',
      detail: 'no record returned by findApprovalForAction' }
  }
  if (approval.approved !== true) {
    return { ok: false, reason: 'approval_denied',
      detail: { approved: approval.approved ?? null } }
  }
  if (approval.signed !== true) {
    return { ok: false, reason: 'approval_unsigned',
      detail: { signed: approval.signed ?? null } }
  }
  if (!matchesSovereign(approval.signed_by, sovereignPrincipal)) {
    return { ok: false, reason: 'approval_signed_by_wrong_principal',
      detail: {
        signed_by: approval.signed_by ?? null,
        expected_principal: (sovereignPrincipal || DEFAULT_SOVEREIGN_PRINCIPAL),
        also_accepted: SOVEREIGN_ROLE_ALIAS,
      } }
  }
  // Optional expiry. An approval without expires_at is taken to be
  // valid until explicitly revoked (the queue is append-only; a
  // revocation arrives as a later record with approved=false).
  if (approval.expires_at !== undefined && approval.expires_at !== null) {
    const exp = Number(approval.expires_at)
    if (!Number.isFinite(exp)) {
      return { ok: false, reason: 'approval_expires_at_invalid',
        detail: { expires_at: approval.expires_at } }
    }
    if (now > exp) {
      return { ok: false, reason: 'approval_expired',
        detail: { expires_at: exp, now } }
    }
  }
  return { ok: true }
}

// -- Main gate -------------------------------------------------------------

export async function gate9HumanStop(input, ctx = {}) {
  const startedAt = nowNs()
  const evidence = { checks: [] }

  // No bypass. Period. Mirrors Gate 0's bypass refusal — the operator
  // veto is sovereignty, not a flag we can hand to a caller.
  if (ctx && ctx.bypass === true) {
    throw new HumanStopBypassAttempt(
      'Gate 9 Human Final Stop is impassable: bypass=true was supplied.'
    )
  }

  if (!input || typeof input !== 'object') {
    return finish(false, 'missing_input',
      { reason: 'input must be an object with {action, order}' }, startedAt)
  }
  const { action, order } = input
  if (!action || typeof action !== 'object') {
    return finish(false, 'missing_action', { reason: 'action is required' }, startedAt)
  }
  if (!order || typeof order !== 'object') {
    return finish(false, 'missing_order', { reason: 'order is required' }, startedAt)
  }

  // ---- A. Risk level present and well-formed ---------------------------
  const riskRaw = action.riskLevel
  if (typeof riskRaw !== 'string' || riskRaw.length === 0) {
    evidence.checks.push({ name: 'risk_level', pass: false,
      reason: 'risk_level_missing' })
    return finish(false, 'risk_level_missing', {
      reason: 'action.riskLevel is required (one of: ' + RISK_LEVELS.join(', ') + ')',
      ...evidence,
    }, startedAt)
  }
  const risk = riskRaw.trim().toLowerCase()
  if (!RISK_SET.has(risk)) {
    evidence.checks.push({ name: 'risk_level', pass: false,
      reason: 'risk_level_unknown', value: riskRaw })
    return finish(false, 'risk_level_unknown', {
      reason: `action.riskLevel "${riskRaw}" not in canonical set`,
      allowed: RISK_LEVELS,
      ...evidence,
    }, startedAt)
  }
  evidence.risk_level = risk
  evidence.checks.push({ name: 'risk_level', pass: true, value: risk })

  // ---- B. Triage: does this action need an operator approval? ----------
  if (!HIGH_RISK_SET.has(risk)) {
    evidence.triage = 'no_approval_required'
    evidence.checks.push({ name: 'triage', pass: true,
      decision: 'no_approval_required',
      reason: `risk level "${risk}" is below the operator-gate threshold`,
      threshold: Array.from(HIGH_RISK_SET) })
    return finish(true, 'ok_low_or_medium_risk', evidence, startedAt)
  }
  evidence.triage = 'approval_required'
  evidence.checks.push({ name: 'triage', pass: true,
    decision: 'approval_required',
    reason: `risk level "${risk}" is at or above the operator-gate threshold`,
    threshold: Array.from(HIGH_RISK_SET) })

  // The action MUST carry an action_id we can use to match against the
  // approval queue. Without an id, no operator could have signed an
  // approval for it.
  const actionId = action.action_id
  if (typeof actionId !== 'string' || actionId.length === 0) {
    evidence.checks.push({ name: 'action_id', pass: false,
      reason: 'action_id_missing' })
    return finish(false, 'action_id_missing', {
      reason: 'action.action_id is required for high-risk actions so an approval can be matched',
      ...evidence,
    }, startedAt)
  }
  evidence.action_id = actionId

  // ---- C. Approval state acquired --------------------------------------
  const sovereignPrincipal = (
    (ctx && typeof ctx.sovereignPrincipal === 'string' && ctx.sovereignPrincipal.length > 0)
      ? ctx.sovereignPrincipal
      : DEFAULT_SOVEREIGN_PRINCIPAL
  )
  evidence.sovereign_principal = sovereignPrincipal

  let approvals
  let approvalsSource
  if (Array.isArray(ctx.approvals)) {
    approvals = ctx.approvals
    approvalsSource = 'ctx.approvals'
    evidence.checks.push({ name: 'approvals_source', pass: true,
      source: approvalsSource, count: approvals.length })
  } else {
    const url = (ctx && typeof ctx.hermesUrl === 'string' && ctx.hermesUrl.length > 0)
      ? ctx.hermesUrl
      : ((typeof process !== 'undefined' && process.env && process.env.HERMES_URL)
          ? process.env.HERMES_URL
          : DEFAULT_HERMES_URL)
    evidence.hermes_url = url
    const f = await fetchApprovals(url, ctx)
    if (!f.ok) {
      evidence.checks.push({ name: 'approvals_source', pass: false,
        source: 'hermes_daemon', url, reason: f.reason, detail: f.detail })
      return finish(false, f.reason, {
        reason: 'could not acquire approvals state from Hermes daemon',
        url, detail: f.detail,
        ...evidence,
      }, startedAt)
    }
    approvals = f.approvals
    approvalsSource = 'hermes_daemon'
    evidence.checks.push({ name: 'approvals_source', pass: true,
      source: approvalsSource, url, count: approvals.length })
  }

  // ---- D. Sovereign-signed approval exists for THIS action -------------
  const approval = findApprovalForAction(approvals, actionId)
  if (!approval) {
    evidence.checks.push({ name: 'approval', pass: false,
      reason: 'approval_not_found', action_id: actionId,
      approvals_scanned: approvals.length })
    return finish(false, 'approval_not_found', {
      reason: `no approval record for action_id "${actionId}" in ${approvalsSource}`,
      action_id: actionId,
      approvals_scanned: approvals.length,
      ...evidence,
    }, startedAt)
  }

  const now = (ctx && typeof ctx.now === 'number' && Number.isFinite(ctx.now))
    ? ctx.now : Date.now()
  evidence.now = now

  const ev = evaluateApproval(approval, now, sovereignPrincipal)
  if (!ev.ok) {
    evidence.checks.push({ name: 'approval', pass: false,
      reason: ev.reason, detail: ev.detail,
      action_id: actionId,
      approval: redactApproval(approval) })
    return finish(false, ev.reason, {
      reason: `approval record for action_id "${actionId}" failed: ${ev.reason}`,
      detail: ev.detail,
      action_id: actionId,
      approval: redactApproval(approval),
      ...evidence,
    }, startedAt)
  }

  evidence.checks.push({ name: 'approval', pass: true,
    action_id: actionId,
    signed_by: approval.signed_by,
    timestamp: approval.timestamp ?? null,
    expires_at: approval.expires_at ?? null })
  evidence.approval = redactApproval(approval)

  return finish(true, 'ok', evidence, startedAt)
}

// Redact a copy of an approval record for inclusion in evidence. We keep
// the operationally useful fields (who, when, status) and drop the raw
// signature material — the signature is verified upstream; echoing it
// into receipts would only invite confusion about what Gate 9 actually
// checked.
function redactApproval(approval) {
  if (!approval || typeof approval !== 'object') return null
  const out = {
    action_id:  approval.action_id ?? null,
    approved:   approval.approved ?? null,
    signed:     approval.signed ?? null,
    signed_by:  approval.signed_by ?? null,
    timestamp:  approval.timestamp ?? null,
    expires_at: approval.expires_at ?? null,
  }
  if (typeof approval.note === 'string' && approval.note.length > 0) {
    out.note = approval.note.length > 200 ? approval.note.slice(0, 200) + '…' : approval.note
  }
  return out
}

// ---- Exports --------------------------------------------------------------

export const GATE_ID_EXPORT = GATE_ID
export const GATE_NAME_EXPORT = GATE_NAME

// Compatibility with prior gates' named export shape.
export const evaluate = gate9HumanStop

export default {
  id: GATE_ID,
  name: GATE_NAME,
  position: POSITION_IN_STACK,
  bypassable: BYPASSABLE,
  target_ms: TARGET_MS,
  evaluate: gate9HumanStop,
  // Exposed for tests / introspection — not part of the runtime contract.
  _internals: {
    RISK_LEVELS,
    RISK_SET,
    HIGH_RISK_SET,
    DEFAULT_HERMES_URL,
    DEFAULT_SOVEREIGN_PRINCIPAL,
    SOVEREIGN_ROLE_ALIAS,
    HumanStopBypassAttempt,
    matchesSovereign,
    normaliseApprovalsBody,
    fetchApprovals,
    findApprovalForAction,
    evaluateApproval,
    redactApproval,
  },
}
