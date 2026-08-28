// lease.mjs — Federated Lease Grant Protocol.
//
// Per-action authority delegation between sovereign Orange5 instances.
// Instance A (requester) asks Instance B (grantor) "may I act on this scope on
// your behalf". A lease, if granted, is:
//   - Per-action  : one scoped action, not a session, not a role.
//   - Short-lived : default TTL 60s, hard ceiling 5 min. No long-lived tokens.
//   - Single-use  : each lease redeems exactly once; replay is refused.
//   - Two-sided   : operator approval required on BOTH the requester side and
//                    the grantor side. No single operator can grant a lease
//                    against the other instance unilaterally.
//   - Sovereign   : the grantor's Mom's-Law, receipts, and 27 guardrails still
//                    apply when the leased action eventually executes locally.
//                    A lease is "you may ASK with my voice", never "you may
//                    bypass my gates".
//
// Doctrine: C:\AtomEons\orangebox\docs\FEDERATION_TRIUMVIRATE_DOCTRINE.md
// Disclosure: ATOM-FED-TRIUMVIRATE-v1-2026-0617 (lease addendum, this file).
//
// Standing law enforced here:
//   1. Lease creation requires a verified handshake session id (from
//      handshake.mjs). No anonymous lease grants.
//   2. Lease creation requires the trust-list entry for the peer to have
//      lease_delegation_allowed === true. The operator's allow-list is the
//      gating policy.
//   3. Lease creation requires a fresh operator approval token on the
//      grantor side. The token is single-use and bound to (peer_id, scope,
//      nonce). It expires within OPERATOR_APPROVAL_TTL_MS of issuance.
//   4. The requester side must ALSO have its own operator approval before
//      submitting the request. We validate the requester-side approval
//      receipt hash the requester echoes back, but we cannot trust the
//      requester to be honest about its own operator — so the grantor-side
//      operator approval is the actual authority. The requester-side
//      receipt is recorded for audit only.
//   5. Leases are scoped: { action, resource, max_invocations: 1, ttl_ms }.
//      No wildcard scopes. No "all" actions. No "any resource".
//   6. Leases are bound to: lease_id, peer_id (requester), self_id
//      (grantor), session_id, issued_at, expires_at, scope, nonce,
//      operator_approval_id.
//   7. Redemption is one-shot. State.leases maps lease_id -> { status:
//      'pending' | 'redeemed' | 'expired' | 'revoked' }. Any non-pending
//      lease at redeem time is refused.
//   8. Revocation is one-sided and instant. The grantor can revoke at any
//      time before redemption with no peer notice required (the operator's
//      Stop Authority must dominate).
//   9. No lease can grant: writing to the receipt store, mutating
//      dividend / payout logic, mutating gates, mutating guardrails,
//      changing runtime/node.py, changing FOUNDER_SALARY_PER_INSTALL_CENTS,
//      or any other invariant in the Drift list. We enforce this with a
//      FORBIDDEN_ACTIONS deny-list checked at create and at redeem.
//  10. No lease auto-renews. Renewal is a fresh request with a fresh
//      operator approval.
//
// Surface (designed to bolt onto handshake.mjs as additional routes; the
// handshake daemon answers 501 on /lease/* today and can dispatch into the
// handlers exported here once the operator chooses to enable lease
// delegation):
//
//   POST /lease/request            (peer-initiated — requester asks)
//        body: { session_id, scope, requester_approval_id, nonce }
//        -> { lease_id, status: 'pending_operator_approval', ... }
//          OR refusal.
//   POST /lease/operator-approve   (loopback-only — local operator says yes)
//        body: { lease_id, operator_approval_id }
//        -> { lease_id, status: 'granted', expires_at_ms, ... }
//          OR refusal.
//   POST /lease/redeem             (peer-initiated — requester cashes in)
//        body: { lease_id, action_payload_hash, nonce }
//        -> { ok, lease_id, redeemed_at_ms, ... }
//          OR refusal (NEVER executes the action — only marks redemption).
//   POST /lease/revoke             (loopback-only — local operator pulls it)
//        body: { lease_id, reason }
//        -> { lease_id, status: 'revoked' }
//   GET  /lease/list               (authenticated peer or loopback)
//        -> { leases: [...redacted summaries...] }
//   GET  /lease/inspect            (authenticated peer or loopback)
//        ?lease_id=...
//        -> { lease } or refusal
//
// This file is pure protocol substrate. It does NOT execute the leased
// action. Executing the action is the caller's job, AFTER /lease/redeem
// returns ok, AND after the caller re-runs the action through the local
// Mom's-Law gate chain (receipts, 27 guardrails, Gate 0 LBCE, Human Final
// Stop). A lease grants a verified federated *request envelope*; it does
// not grant bypass of local authority.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// ---- constants -------------------------------------------------------------

export const LEASE_SCHEMA_VERSION = 'atomeons.federation.lease.v1'

export const LEASE_TTL_DEFAULT_MS = 60_000           // 1 minute default
export const LEASE_TTL_MAX_MS = 5 * 60_000           // 5 minutes hard ceiling
export const LEASE_TTL_MIN_MS = 1_000                // 1 second floor

export const OPERATOR_APPROVAL_TTL_MS = 120_000      // 2 min to claim approval
export const REQUESTER_APPROVAL_HASH_LEN = 64        // hex sha-256

// Lease statuses (linear; once non-pending, terminal except for clean-up).
export const LEASE_STATUS = Object.freeze({
  PENDING_OPERATOR_APPROVAL: 'pending_operator_approval',
  GRANTED: 'granted',
  REDEEMED: 'redeemed',
  EXPIRED: 'expired',
  REVOKED: 'revoked',
  REFUSED: 'refused',
})

// Refusal reason codes (stable; consumers may switch on these).
export const LEASE_REFUSAL = Object.freeze({
  SESSION_UNKNOWN: 'session_unknown',
  SESSION_PEER_MISMATCH: 'session_peer_mismatch',
  PEER_NOT_LEASE_ELIGIBLE: 'peer_not_lease_eligible',
  SCOPE_MALFORMED: 'scope_malformed',
  SCOPE_FORBIDDEN_ACTION: 'scope_forbidden_action',
  SCOPE_WILDCARD_REFUSED: 'scope_wildcard_refused',
  TTL_OUT_OF_RANGE: 'ttl_out_of_range',
  REQUESTER_APPROVAL_MALFORMED: 'requester_approval_malformed',
  OPERATOR_APPROVAL_MISSING: 'operator_approval_missing',
  OPERATOR_APPROVAL_EXPIRED: 'operator_approval_expired',
  OPERATOR_APPROVAL_MISMATCH: 'operator_approval_mismatch',
  OPERATOR_APPROVAL_REPLAY: 'operator_approval_replay',
  OPERATOR_APPROVE_REMOTE_REFUSED: 'operator_approve_remote_refused',
  LEASE_UNKNOWN: 'lease_unknown',
  LEASE_NOT_PENDING: 'lease_not_pending',
  LEASE_NOT_GRANTED: 'lease_not_granted',
  LEASE_EXPIRED: 'lease_expired',
  LEASE_REDEEMED: 'lease_redeemed',
  LEASE_REVOKED: 'lease_revoked',
  PAYLOAD_HASH_MISSING: 'payload_hash_missing',
  PAYLOAD_HASH_MISMATCH: 'payload_hash_mismatch',
  NONCE_REPLAY: 'nonce_replay',
  MALFORMED_REQUEST: 'malformed_request',
  LOOPBACK_REQUIRED: 'loopback_required',
  RATE_LIMITED: 'rate_limited',
  GUARDRAIL_BREACH: 'guardrail_breach',
})

// Forbidden actions — a lease can NEVER carry authority over these surfaces.
// This list is intentionally conservative; the operator can add to it from
// the trust list. It cannot be shrunk at runtime.
export const FORBIDDEN_ACTIONS = Object.freeze(new Set([
  // Receipts and audit:
  'receipts.write',
  'receipts.delete',
  'receipts.mutate',
  // Dividend / payout:
  'dividend.set',
  'dividend.payout',
  'founder_salary.set',
  // Gates / guardrails:
  'gate.disable',
  'gate.bypass',
  'guardrail.disable',
  'guardrail.mutate',
  'lbce.bypass',
  // Identity / authority:
  'identity.set',
  'authority.elevate',
  'human_final_stop.disable',
  // Runtime invariants:
  'runtime.node.replace',
  'runtime.node.mutate',
  // Leases over leases (no transitive delegation):
  'lease.grant',
  'lease.delegate',
  'lease.revoke',
  // Wildcards — never:
  '*',
  'all',
  'any',
]))

// Rate-limit: per peer_id, per minute. Soft default; operator may tighten.
export const RATE_LIMIT_PER_PEER_PER_MIN = 12

// ---- internal helpers ------------------------------------------------------

function nowMs() { return Date.now() }
function newId(prefix) { return `${prefix}_${randomBytes(12).toString('hex')}` }
function sha256Hex(s) { return createHash('sha256').update(s).digest('hex') }

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v)
}

function isLikelyHex(s, len) {
  return typeof s === 'string' && s.length === len && /^[0-9a-fA-F]+$/.test(s)
}

function safeStrEq(a, b) {
  try {
    const ba = Buffer.from(String(a))
    const bb = Buffer.from(String(b))
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch { return false }
}

// Validate a scope object. Returns { ok: true, scope } or { ok: false, code, detail }.
export function validateScope(scope) {
  if (!isPlainObject(scope)) {
    return { ok: false, code: LEASE_REFUSAL.SCOPE_MALFORMED, detail: 'scope must be an object' }
  }
  const { action, resource, ttl_ms } = scope
  if (typeof action !== 'string' || !action.length) {
    return { ok: false, code: LEASE_REFUSAL.SCOPE_MALFORMED, detail: 'scope.action must be a non-empty string' }
  }
  if (action.includes('*') || action.includes(' ')) {
    return { ok: false, code: LEASE_REFUSAL.SCOPE_WILDCARD_REFUSED, detail: `scope.action "${action}" contains wildcard or whitespace` }
  }
  const lowerAction = action.toLowerCase()
  if (FORBIDDEN_ACTIONS.has(lowerAction)) {
    return { ok: false, code: LEASE_REFUSAL.SCOPE_FORBIDDEN_ACTION, detail: `scope.action "${action}" is on the forbidden list` }
  }
  // Forbid any action that *prefix*-matches a forbidden category root.
  // e.g. "receipts.write.fast" is still forbidden because "receipts.write" is.
  for (const f of FORBIDDEN_ACTIONS) {
    if (f === '*' || f === 'all' || f === 'any') continue
    if (lowerAction === f) {
      return { ok: false, code: LEASE_REFUSAL.SCOPE_FORBIDDEN_ACTION, detail: `scope.action "${action}" matches forbidden action "${f}"` }
    }
    if (lowerAction.startsWith(f + '.')) {
      return { ok: false, code: LEASE_REFUSAL.SCOPE_FORBIDDEN_ACTION, detail: `scope.action "${action}" descends from forbidden action "${f}"` }
    }
  }
  if (typeof resource !== 'string' || !resource.length) {
    return { ok: false, code: LEASE_REFUSAL.SCOPE_MALFORMED, detail: 'scope.resource must be a non-empty string' }
  }
  if (resource === '*' || resource.toLowerCase() === 'all' || resource.toLowerCase() === 'any') {
    return { ok: false, code: LEASE_REFUSAL.SCOPE_WILDCARD_REFUSED, detail: `scope.resource "${resource}" is a wildcard` }
  }
  const ttl = ttl_ms == null ? LEASE_TTL_DEFAULT_MS : Number(ttl_ms)
  if (!Number.isFinite(ttl) || ttl < LEASE_TTL_MIN_MS || ttl > LEASE_TTL_MAX_MS) {
    return {
      ok: false,
      code: LEASE_REFUSAL.TTL_OUT_OF_RANGE,
      detail: `ttl_ms ${ttl} outside [${LEASE_TTL_MIN_MS}, ${LEASE_TTL_MAX_MS}]`,
    }
  }
  return {
    ok: true,
    scope: Object.freeze({
      action,
      resource,
      max_invocations: 1,    // forced; no multi-use leases.
      ttl_ms: ttl,
    }),
  }
}

// ---- state -----------------------------------------------------------------

// The lease store is per-process. Persistence across restart is a deliberate
// non-feature: a lease longer than process lifetime is a lease longer than it
// should ever live. Restart = blanket revocation. That is correct.
export function buildLeaseState({ self_id, peers, getSession }) {
  if (typeof self_id !== 'string' || !self_id.length) {
    throw new Error('lease: buildLeaseState requires self_id')
  }
  if (!peers || typeof peers.byPeerId?.get !== 'function') {
    throw new Error('lease: buildLeaseState requires peers index (byPeerId Map)')
  }
  if (typeof getSession !== 'function') {
    throw new Error('lease: buildLeaseState requires getSession(session_id) -> session | null')
  }
  return {
    self_id,
    peers,
    getSession,
    leases: new Map(),                   // lease_id -> lease record
    pendingApprovals: new Map(),         // operator_approval_id -> { lease_id, issued_at_ms }
    usedApprovals: new Set(),            // operator_approval_id (one-shot)
    usedNonces: new Set(),               // nonce values seen across lease ops
    perPeerRate: new Map(),              // peer_id -> [{ at_ms }]
    counters: {
      requests: 0,
      grants: 0,
      redemptions: 0,
      revocations: 0,
      refusals: 0,
      last_refusal: null,
    },
  }
}

function recordRefusal(state, code, detail) {
  state.counters.refusals += 1
  state.counters.last_refusal = { code, detail, at: new Date().toISOString() }
}

function rateLimitCheck(state, peer_id) {
  const now = nowMs()
  const windowStart = now - 60_000
  const arr = state.perPeerRate.get(peer_id) || []
  // Drop old entries.
  while (arr.length && arr[0].at_ms < windowStart) arr.shift()
  if (arr.length >= RATE_LIMIT_PER_PEER_PER_MIN) return false
  arr.push({ at_ms: now })
  state.perPeerRate.set(peer_id, arr)
  return true
}

// Tidy expired leases lazily; called on each handler entry.
function sweepExpired(state) {
  const now = nowMs()
  for (const [lease_id, lease] of state.leases) {
    if (lease.status === LEASE_STATUS.GRANTED && lease.expires_at_ms <= now) {
      state.leases.set(lease_id, { ...lease, status: LEASE_STATUS.EXPIRED, expired_at_ms: now })
    }
    if (lease.status === LEASE_STATUS.PENDING_OPERATOR_APPROVAL
        && (now - lease.requested_at_ms) > OPERATOR_APPROVAL_TTL_MS) {
      state.leases.set(lease_id, { ...lease, status: LEASE_STATUS.EXPIRED, expired_at_ms: now })
      // Also burn any pending approval pointer.
      if (lease.operator_approval_id) state.pendingApprovals.delete(lease.operator_approval_id)
    }
  }
}

// Redact a lease for outbound responses (no internal-only fields).
function redactLease(lease) {
  if (!lease) return null
  return {
    lease_id: lease.lease_id,
    status: lease.status,
    requester_peer_id: lease.requester_peer_id,
    grantor_self_id: lease.grantor_self_id,
    session_id: lease.session_id,
    scope: lease.scope,
    requested_at_ms: lease.requested_at_ms,
    issued_at_ms: lease.issued_at_ms || null,
    expires_at_ms: lease.expires_at_ms || null,
    redeemed_at_ms: lease.redeemed_at_ms || null,
    revoked_at_ms: lease.revoked_at_ms || null,
    expired_at_ms: lease.expired_at_ms || null,
    revoke_reason: lease.revoke_reason || null,
    requester_approval_hash: lease.requester_approval_hash || null,
    // operator_approval_id is intentionally NOT included in peer-facing redaction.
    payload_hash_committed: lease.payload_hash_committed || null,
    doctrine_ref: 'ATOM-FED-TRIUMVIRATE-v1-2026-0617',
    schema: LEASE_SCHEMA_VERSION,
  }
}

// ---- handlers --------------------------------------------------------------
//
// Each handler returns { status, body } — same shape as handshake.mjs's
// `json()` so the two can be unioned in a single dispatcher.

function ok(body) {
  return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify({ ok: true, ...body }) }
}
function refuse(status, code, detail, extras) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ ok: false, error: code, detail: detail || code, ...(extras || {}) }),
  }
}

// POST /lease/request
//
// Called by the requester peer (Instance A) over the mTLS channel.
// The caller (the handshake daemon) is expected to have already
// authenticated the peer cert and supply `authPeerId` — the peer_id keyed to
// the client certificate. The body's session_id binds the request to a live
// handshake session.
//
// args: { authPeerId, body, isLoopback }
// body shape: { session_id, scope, requester_approval_id, nonce }
export async function handleLeaseRequest(state, { authPeerId, body, isLoopback }) {
  sweepExpired(state)
  state.counters.requests += 1

  if (!authPeerId || typeof authPeerId !== 'string') {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'authPeerId required (mTLS)')
    return refuse(401, LEASE_REFUSAL.MALFORMED_REQUEST, 'authenticated peer required')
  }
  if (!isPlainObject(body)) {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'body must be object')
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST, 'body required')
  }
  const { session_id, scope, requester_approval_id, nonce } = body
  if (typeof session_id !== 'string' || !session_id.length
      || typeof requester_approval_id !== 'string' || !requester_approval_id.length
      || typeof nonce !== 'string' || !nonce.length) {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'missing fields')
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST,
      'expected { session_id, scope, requester_approval_id, nonce }')
  }
  if (state.usedNonces.has(nonce)) {
    recordRefusal(state, LEASE_REFUSAL.NONCE_REPLAY, `request nonce reuse: ${nonce}`)
    return refuse(409, LEASE_REFUSAL.NONCE_REPLAY, 'nonce already used')
  }

  // Bind the request to a live handshake session.
  const session = state.getSession(session_id)
  if (!session) {
    recordRefusal(state, LEASE_REFUSAL.SESSION_UNKNOWN, `session_id=${session_id}`)
    return refuse(401, LEASE_REFUSAL.SESSION_UNKNOWN, 'no live handshake session for that id')
  }
  if (session.peer_id !== authPeerId) {
    recordRefusal(state, LEASE_REFUSAL.SESSION_PEER_MISMATCH,
      `session.peer_id=${session.peer_id} authPeerId=${authPeerId}`)
    return refuse(403, LEASE_REFUSAL.SESSION_PEER_MISMATCH,
      'session does not belong to the authenticated peer')
  }

  // The peer must be on the trust list with lease_delegation_allowed === true.
  const trustEntry = state.peers.byPeerId.get(authPeerId)
  if (!trustEntry || !trustEntry.lease_delegation_allowed) {
    recordRefusal(state, LEASE_REFUSAL.PEER_NOT_LEASE_ELIGIBLE,
      `peer=${authPeerId} lease_delegation_allowed=${!!(trustEntry && trustEntry.lease_delegation_allowed)}`)
    return refuse(403, LEASE_REFUSAL.PEER_NOT_LEASE_ELIGIBLE,
      'peer is not lease-eligible per local trust list')
  }

  // Validate scope (forbidden actions, wildcard guard, ttl range, etc.)
  const sc = validateScope(scope)
  if (!sc.ok) {
    recordRefusal(state, sc.code, sc.detail)
    return refuse(400, sc.code, sc.detail)
  }

  // Requester-side approval is a hash receipt the requester echoes — we
  // record it for audit. We do NOT treat it as authority; the grantor-side
  // operator approval below is the actual authority.
  if (!isLikelyHex(requester_approval_id, REQUESTER_APPROVAL_HASH_LEN)) {
    recordRefusal(state, LEASE_REFUSAL.REQUESTER_APPROVAL_MALFORMED,
      'requester_approval_id must be a 64-char hex sha-256')
    return refuse(400, LEASE_REFUSAL.REQUESTER_APPROVAL_MALFORMED,
      'requester_approval_id must be a sha-256 hex digest')
  }

  // Rate limit (per peer).
  if (!rateLimitCheck(state, authPeerId)) {
    recordRefusal(state, LEASE_REFUSAL.RATE_LIMITED, `peer=${authPeerId}`)
    return refuse(429, LEASE_REFUSAL.RATE_LIMITED, 'lease request rate exceeded for this peer')
  }

  state.usedNonces.add(nonce)
  const lease_id = newId('lease')
  const requested_at_ms = nowMs()
  const lease = {
    lease_id,
    status: LEASE_STATUS.PENDING_OPERATOR_APPROVAL,
    requester_peer_id: authPeerId,
    grantor_self_id: state.self_id,
    session_id,
    scope: sc.scope,
    requested_at_ms,
    requester_approval_hash: requester_approval_id,
    request_nonce: nonce,
    operator_approval_id: null,    // filled by /lease/operator-approve
    issued_at_ms: null,
    expires_at_ms: null,
    redeemed_at_ms: null,
    revoked_at_ms: null,
    expired_at_ms: null,
    revoke_reason: null,
    payload_hash_committed: null,
  }
  state.leases.set(lease_id, lease)

  return ok({
    lease,
    redacted: redactLease(lease),
    note: 'lease pending grantor-side operator approval; not yet usable',
  })
}

// POST /lease/operator-approve
//
// LOOPBACK ONLY. The local operator (or operator-signed instrument) calls
// this from the grantor instance to convert a pending lease into a granted
// one. The operator must supply a fresh operator_approval_id (sha-256 hex)
// tied to (lease_id, scope, nonce). The approval is single-use.
//
// args: { body, isLoopback }
// body shape: { lease_id, operator_approval_id }
export async function handleLeaseOperatorApprove(state, { body, isLoopback }) {
  sweepExpired(state)

  if (!isLoopback) {
    recordRefusal(state, LEASE_REFUSAL.LOOPBACK_REQUIRED, '/lease/operator-approve')
    return refuse(403, LEASE_REFUSAL.LOOPBACK_REQUIRED,
      'operator approval must originate from loopback (local operator)')
  }
  if (!isPlainObject(body)) {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'body must be object')
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST, 'body required')
  }
  const { lease_id, operator_approval_id } = body
  if (typeof lease_id !== 'string' || typeof operator_approval_id !== 'string') {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'missing fields')
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST,
      'expected { lease_id, operator_approval_id }')
  }
  if (!isLikelyHex(operator_approval_id, REQUESTER_APPROVAL_HASH_LEN)) {
    recordRefusal(state, LEASE_REFUSAL.OPERATOR_APPROVAL_MISMATCH,
      'operator_approval_id must be a 64-char hex sha-256')
    return refuse(400, LEASE_REFUSAL.OPERATOR_APPROVAL_MISMATCH,
      'operator_approval_id must be a sha-256 hex digest')
  }
  if (state.usedApprovals.has(operator_approval_id)) {
    recordRefusal(state, LEASE_REFUSAL.OPERATOR_APPROVAL_REPLAY, operator_approval_id)
    return refuse(409, LEASE_REFUSAL.OPERATOR_APPROVAL_REPLAY,
      'operator approval id has already been used')
  }

  const lease = state.leases.get(lease_id)
  if (!lease) {
    recordRefusal(state, LEASE_REFUSAL.LEASE_UNKNOWN, lease_id)
    return refuse(404, LEASE_REFUSAL.LEASE_UNKNOWN, 'no such lease')
  }
  if (lease.status !== LEASE_STATUS.PENDING_OPERATOR_APPROVAL) {
    recordRefusal(state, LEASE_REFUSAL.LEASE_NOT_PENDING,
      `lease.status=${lease.status}`)
    return refuse(409, LEASE_REFUSAL.LEASE_NOT_PENDING,
      `lease is in status "${lease.status}" and cannot be approved`)
  }
  const now = nowMs()
  if ((now - lease.requested_at_ms) > OPERATOR_APPROVAL_TTL_MS) {
    state.leases.set(lease_id, { ...lease, status: LEASE_STATUS.EXPIRED, expired_at_ms: now })
    recordRefusal(state, LEASE_REFUSAL.OPERATOR_APPROVAL_EXPIRED,
      `lease ${lease_id} stale by ${now - lease.requested_at_ms}ms`)
    return refuse(409, LEASE_REFUSAL.OPERATOR_APPROVAL_EXPIRED,
      'lease has aged past operator-approval window')
  }

  // Sanity: re-validate scope at approval time. Forbidden lists may have
  // changed (operator may have appended to the deny list between request
  // and approval; we always honor the strictest reading).
  const sc = validateScope(lease.scope)
  if (!sc.ok) {
    state.leases.set(lease_id, { ...lease, status: LEASE_STATUS.REFUSED, expired_at_ms: now })
    recordRefusal(state, sc.code, sc.detail)
    return refuse(409, sc.code, `scope failed re-validation at approval: ${sc.detail}`)
  }

  const expires_at_ms = now + lease.scope.ttl_ms
  const granted = {
    ...lease,
    status: LEASE_STATUS.GRANTED,
    issued_at_ms: now,
    expires_at_ms,
    operator_approval_id,
  }
  state.leases.set(lease_id, granted)
  state.usedApprovals.add(operator_approval_id)
  state.pendingApprovals.set(operator_approval_id, { lease_id, issued_at_ms: now })
  state.counters.grants += 1

  return ok({
    lease_id,
    status: granted.status,
    issued_at_ms: now,
    expires_at_ms,
    ttl_ms: lease.scope.ttl_ms,
    redacted: redactLease(granted),
  })
}

// POST /lease/redeem
//
// Called by the requester peer to "cash in" the lease. The body must include
// a sha-256 hex of the action payload the requester is about to act on; we
// commit that hash into the lease record before marking redeemed, so the
// caller code (which runs the action through local Mom's-Law gates AFTER
// this returns ok) can compare hashes and refuse if the payload mutated.
//
// This handler DOES NOT execute the action. It only marks redemption.
//
// args: { authPeerId, body }
// body shape: { lease_id, action_payload_hash, nonce }
export async function handleLeaseRedeem(state, { authPeerId, body }) {
  sweepExpired(state)

  if (!authPeerId) {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'authPeerId required (mTLS)')
    return refuse(401, LEASE_REFUSAL.MALFORMED_REQUEST, 'authenticated peer required')
  }
  if (!isPlainObject(body)) {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'body must be object')
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST, 'body required')
  }
  const { lease_id, action_payload_hash, nonce } = body
  if (typeof lease_id !== 'string' || typeof nonce !== 'string') {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'missing fields')
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST,
      'expected { lease_id, action_payload_hash, nonce }')
  }
  if (!isLikelyHex(action_payload_hash, REQUESTER_APPROVAL_HASH_LEN)) {
    recordRefusal(state, LEASE_REFUSAL.PAYLOAD_HASH_MISSING, 'action_payload_hash invalid')
    return refuse(400, LEASE_REFUSAL.PAYLOAD_HASH_MISSING,
      'action_payload_hash must be a 64-char hex sha-256')
  }
  if (state.usedNonces.has(nonce)) {
    recordRefusal(state, LEASE_REFUSAL.NONCE_REPLAY, `redeem nonce reuse: ${nonce}`)
    return refuse(409, LEASE_REFUSAL.NONCE_REPLAY, 'nonce already used')
  }

  const lease = state.leases.get(lease_id)
  if (!lease) {
    recordRefusal(state, LEASE_REFUSAL.LEASE_UNKNOWN, lease_id)
    return refuse(404, LEASE_REFUSAL.LEASE_UNKNOWN, 'no such lease')
  }
  if (lease.requester_peer_id !== authPeerId) {
    recordRefusal(state, LEASE_REFUSAL.SESSION_PEER_MISMATCH,
      `lease.requester_peer_id=${lease.requester_peer_id} authPeerId=${authPeerId}`)
    return refuse(403, LEASE_REFUSAL.SESSION_PEER_MISMATCH,
      'lease does not belong to the authenticated peer')
  }
  if (lease.status === LEASE_STATUS.REDEEMED) {
    recordRefusal(state, LEASE_REFUSAL.LEASE_REDEEMED, lease_id)
    return refuse(409, LEASE_REFUSAL.LEASE_REDEEMED, 'lease has already been redeemed')
  }
  if (lease.status === LEASE_STATUS.REVOKED) {
    recordRefusal(state, LEASE_REFUSAL.LEASE_REVOKED, lease_id)
    return refuse(409, LEASE_REFUSAL.LEASE_REVOKED,
      `lease was revoked: ${lease.revoke_reason || 'no reason given'}`)
  }
  if (lease.status === LEASE_STATUS.EXPIRED) {
    recordRefusal(state, LEASE_REFUSAL.LEASE_EXPIRED, lease_id)
    return refuse(409, LEASE_REFUSAL.LEASE_EXPIRED, 'lease has expired')
  }
  if (lease.status !== LEASE_STATUS.GRANTED) {
    recordRefusal(state, LEASE_REFUSAL.LEASE_NOT_GRANTED, `status=${lease.status}`)
    return refuse(409, LEASE_REFUSAL.LEASE_NOT_GRANTED,
      `lease is in status "${lease.status}", not "granted"`)
  }
  const now = nowMs()
  if (lease.expires_at_ms <= now) {
    state.leases.set(lease_id, { ...lease, status: LEASE_STATUS.EXPIRED, expired_at_ms: now })
    recordRefusal(state, LEASE_REFUSAL.LEASE_EXPIRED, lease_id)
    return refuse(409, LEASE_REFUSAL.LEASE_EXPIRED, 'lease expired between grant and redeem')
  }

  // Re-validate scope at redeem time too (defense-in-depth against any
  // mid-flight mutation by stale references — scope is frozen but the
  // forbidden list may have grown).
  const sc = validateScope(lease.scope)
  if (!sc.ok) {
    state.leases.set(lease_id, { ...lease, status: LEASE_STATUS.REVOKED, revoked_at_ms: now, revoke_reason: sc.detail })
    recordRefusal(state, sc.code, sc.detail)
    return refuse(409, sc.code, `scope failed re-validation at redeem: ${sc.detail}`)
  }

  state.usedNonces.add(nonce)
  const redeemed = {
    ...lease,
    status: LEASE_STATUS.REDEEMED,
    redeemed_at_ms: now,
    payload_hash_committed: action_payload_hash,
    redeem_nonce: nonce,
  }
  state.leases.set(lease_id, redeemed)
  state.counters.redemptions += 1

  return ok({
    lease_id,
    status: redeemed.status,
    redeemed_at_ms: now,
    payload_hash_committed: action_payload_hash,
    note: 'redemption recorded; caller MUST still run local Mom\'s-Law gates on the action',
    redacted: redactLease(redeemed),
  })
}

// POST /lease/revoke
//
// LOOPBACK ONLY. The local operator instantly revokes a lease before
// redemption (or no-ops idempotently if already redeemed/expired/revoked).
// The peer is not notified; the next redeem attempt will refuse with
// LEASE_REVOKED. Stop Authority dominates.
//
// args: { body, isLoopback }
// body shape: { lease_id, reason }
export async function handleLeaseRevoke(state, { body, isLoopback }) {
  sweepExpired(state)

  if (!isLoopback) {
    recordRefusal(state, LEASE_REFUSAL.LOOPBACK_REQUIRED, '/lease/revoke')
    return refuse(403, LEASE_REFUSAL.LOOPBACK_REQUIRED,
      'lease revocation must originate from loopback (local operator)')
  }
  if (!isPlainObject(body)) {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'body must be object')
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST, 'body required')
  }
  const { lease_id, reason } = body
  if (typeof lease_id !== 'string') {
    recordRefusal(state, LEASE_REFUSAL.MALFORMED_REQUEST, 'lease_id missing')
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST, 'expected { lease_id, reason }')
  }
  const lease = state.leases.get(lease_id)
  if (!lease) {
    recordRefusal(state, LEASE_REFUSAL.LEASE_UNKNOWN, lease_id)
    return refuse(404, LEASE_REFUSAL.LEASE_UNKNOWN, 'no such lease')
  }
  // Idempotent terminal states: report status, don't mutate.
  if (lease.status === LEASE_STATUS.REDEEMED
      || lease.status === LEASE_STATUS.REVOKED
      || lease.status === LEASE_STATUS.EXPIRED
      || lease.status === LEASE_STATUS.REFUSED) {
    return ok({
      lease_id,
      status: lease.status,
      note: `lease already in terminal state "${lease.status}"; no change`,
      redacted: redactLease(lease),
    })
  }
  const now = nowMs()
  const revoked = {
    ...lease,
    status: LEASE_STATUS.REVOKED,
    revoked_at_ms: now,
    revoke_reason: typeof reason === 'string' ? reason : 'no reason given',
  }
  state.leases.set(lease_id, revoked)
  state.counters.revocations += 1
  return ok({
    lease_id,
    status: revoked.status,
    revoked_at_ms: now,
    revoke_reason: revoked.revoke_reason,
    redacted: redactLease(revoked),
  })
}

// GET /lease/list — summary for the calling peer or for loopback.
export async function handleLeaseList(state, { authPeerId, isLoopback }) {
  sweepExpired(state)
  if (!isLoopback && !authPeerId) {
    return refuse(401, LEASE_REFUSAL.MALFORMED_REQUEST, 'authenticated peer or loopback required')
  }
  const out = []
  for (const lease of state.leases.values()) {
    if (isLoopback || lease.requester_peer_id === authPeerId) {
      out.push(redactLease(lease))
    }
  }
  return ok({
    self_id: state.self_id,
    leases: out,
    counters: { ...state.counters, last_refusal: state.counters.last_refusal },
    schema: LEASE_SCHEMA_VERSION,
  })
}

// GET /lease/inspect?lease_id=...
export async function handleLeaseInspect(state, { authPeerId, isLoopback, query }) {
  sweepExpired(state)
  const lease_id = query && typeof query.lease_id === 'string' ? query.lease_id : null
  if (!lease_id) {
    return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST, 'lease_id query param required')
  }
  const lease = state.leases.get(lease_id)
  if (!lease) {
    return refuse(404, LEASE_REFUSAL.LEASE_UNKNOWN, 'no such lease')
  }
  if (!isLoopback && lease.requester_peer_id !== authPeerId) {
    return refuse(403, LEASE_REFUSAL.SESSION_PEER_MISMATCH,
      'lease does not belong to the authenticated peer')
  }
  return ok({ lease: redactLease(lease) })
}

// ---- dispatcher (optional bolt-on) ----------------------------------------
//
// Convenience adapter: call this from handshake.mjs's handleRequest() when
// the url starts with /lease/. The caller is responsible for parsing query
// strings (we accept a pre-parsed object) and for supplying authPeerId
// (the peer_id keyed to the verified client cert).
//
// args: { method, path, query, bodyText, authPeerId, isLoopback }
export async function dispatchLease(state, { method, path, query, bodyText, authPeerId, isLoopback }) {
  let body = null
  if (bodyText) {
    try { body = JSON.parse(bodyText) }
    catch { return refuse(400, LEASE_REFUSAL.MALFORMED_REQUEST, 'body is not valid JSON') }
  }
  if (method === 'POST' && path === '/lease/request') {
    return handleLeaseRequest(state, { authPeerId, body, isLoopback })
  }
  if (method === 'POST' && path === '/lease/operator-approve') {
    return handleLeaseOperatorApprove(state, { body, isLoopback })
  }
  if (method === 'POST' && path === '/lease/redeem') {
    return handleLeaseRedeem(state, { authPeerId, body })
  }
  if (method === 'POST' && path === '/lease/revoke') {
    return handleLeaseRevoke(state, { body, isLoopback })
  }
  if (method === 'GET' && path === '/lease/list') {
    return handleLeaseList(state, { authPeerId, isLoopback })
  }
  if (method === 'GET' && path === '/lease/inspect') {
    return handleLeaseInspect(state, { authPeerId, isLoopback, query })
  }
  return refuse(404, 'not_found', `${method} ${path}`)
}

// ---- helper utilities for callers -----------------------------------------

// Compute a sha-256 hex of an arbitrary payload (string, Buffer, or JSON
// object). Stable for {object} via JSON.stringify with sorted keys. Callers
// SHOULD use this to derive action_payload_hash so both sides agree.
export function payloadHashOf(payload) {
  if (payload == null) return sha256Hex('')
  if (Buffer.isBuffer(payload)) return createHash('sha256').update(payload).digest('hex')
  if (typeof payload === 'string') return sha256Hex(payload)
  // Stable JSON: sort keys recursively to remove ordering ambiguity.
  const stable = stableStringify(payload)
  return sha256Hex(stable)
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']'
  const keys = Object.keys(v).sort()
  return '{' + keys.map(k => JSON.stringify(k) + ':' + stableStringify(v[k])).join(',') + '}'
}

// Default export for ergonomic imports.
export default {
  LEASE_SCHEMA_VERSION,
  LEASE_TTL_DEFAULT_MS,
  LEASE_TTL_MAX_MS,
  LEASE_TTL_MIN_MS,
  OPERATOR_APPROVAL_TTL_MS,
  LEASE_STATUS,
  LEASE_REFUSAL,
  FORBIDDEN_ACTIONS,
  RATE_LIMIT_PER_PEER_PER_MIN,
  validateScope,
  buildLeaseState,
  handleLeaseRequest,
  handleLeaseOperatorApprove,
  handleLeaseRedeem,
  handleLeaseRevoke,
  handleLeaseList,
  handleLeaseInspect,
  dispatchLease,
  payloadHashOf,
}
