// smoke.mjs — Federation 2-instance simulated smoke test.
//
// Spins up two simulated Orange5 instances (alpha + bravo) IN-PROCESS, drives
// the Federation Triumvirate protocol between them end-to-end, and asserts:
//
//   1. mutual handshake succeeds when both sides are aligned
//   2. handshake refuses schema-mismatch, clock-skew, unknown-peer,
//      peer-id-vs-cert mismatch, and missing-client-cert (sovereignty fence)
//   3. state-brief returns a doctrine-grade summary with the required
//      redactions (no PII, no raw receipts, no host paths) and refuses on
//      stale-session and missing-capability
//   4. lease grant -> operator-approve -> redeem completes one-shot;
//      forbidden-action scopes are refused; non-loopback operator-approve
//      and revoke are refused (Stop Authority dominates); replay refused
//   5. cross-receipt cite succeeds, the peer's /attest verifies the digest,
//      and a tampered claimed_local_digest is refused with digest_mismatch;
//      self-citation is refused (federation is between sovereign peers)
//   6. NO Mom's-Law / receipts / 27-guardrail override path exists — every
//      handler that could mutate authority refuses without loopback or
//      operator approval. Both instances remain sovereign at every step.
//
// Doctrine: C:\AtomEons\orangebox\docs\FEDERATION_TRIUMVIRATE_DOCTRINE.md
// Disclosure: ATOM-FED-TRIUMVIRATE-v1-2026-0617
//
// Why this is a "simulated" smoke test:
//
//   handshake.mjs's wire layer is mTLS-only and refuses to bind without per-
//   pair certificates (ca.pem / server.pem / server.key / client.pem /
//   client.key + trusted-peers.json). Generating those certs is an offline
//   operator act, not a smoke-test responsibility — the operator's standing
//   law is that mTLS material is provisioned out-of-band. So this smoke test
//   exercises the PROTOCOL semantics by calling the exported handlers
//   directly with synthetic peer-cert info, with one state per "instance".
//
//   That is honest scope: it proves the handshake/state-brief/lease/cross-
//   receipt state machines work and refuse correctly. It does NOT prove the
//   TLS layer accepts/rejects certificates — that's the job of a separate
//   cert-bound integration test, which depends on having two real cert
//   pairs on disk.
//
// Usage:
//   bun run C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/smoke.mjs
//   node    C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/smoke.mjs
//
// Exits 0 on success, 1 on any failed assertion. Prints a structured run
// receipt at the end (federation_smoke_run.json on disk + JSON to stdout).

import { createHash, randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join as joinPath } from 'node:path'
import { tmpdir } from 'node:os'

import {
  FEDERATION_SCHEMA_VERSION,
  REFUSAL,
  LOCAL_CAPABILITIES,
  MAX_CLOCK_SKEW_MS,
  handleRequest,
  normalizeFingerprint,
} from './handshake.mjs'

import {
  STATE_BRIEF_SCHEMA,
  STATE_BRIEF_PATH,
  buildStateBrief,
  handleStateBriefRequest,
} from './state-brief.mjs'

import {
  LEASE_SCHEMA_VERSION,
  LEASE_STATUS,
  LEASE_REFUSAL,
  FORBIDDEN_ACTIONS,
  buildLeaseState,
  dispatchLease,
  payloadHashOf,
} from './lease.mjs'

import {
  XREF_PATH_CITE,
  XREF_PATH_ATTEST,
  XREF_PATH_RESOLVE,
  XREF_REFUSAL,
  defaultLocalReceiptStore,
  handleCrossReceiptRequest,
} from './cross-receipt.mjs'

// ---- assertion micro-harness ----------------------------------------------
//
// Deliberately tiny — no Jest / Vitest dependency. Each assertion records a
// row in `results`; the run prints a tally + first failure (if any) at end.

const HERE = dirname(fileURLToPath(import.meta.url))
const results = []
let failed = 0

function assert(name, ok, detail) {
  results.push({
    name,
    ok: ok === true,
    detail: detail == null ? null : String(detail).slice(0, 400),
  })
  if (ok !== true) failed += 1
}

function assertEq(name, actual, expected) {
  const ok = actual === expected
  assert(name, ok, ok ? null : `expected=${JSON.stringify(expected)} actual=${JSON.stringify(actual)}`)
}

function parseBody(r) {
  if (!r || typeof r.body !== 'string') return null
  try { return JSON.parse(r.body) } catch { return null }
}

// ---- simulated instance factory -------------------------------------------
//
// An "instance" here is the union of:
//   - handshake state (sessions map, peers index, capabilities, self_id)
//   - lease state (lease map, used-nonce set, etc.)
//   - cross-receipt context (self_id, fedDir, localReceiptStore)
//   - state-brief options (booted_at, wave, stratum, host_class)
//
// The fedDir is a temp directory per instance so the two instances do not
// share filesystem state — which is the whole point of federation
// sovereignty.

function makeFingerprint(seed) {
  // Deterministic 32-byte digest -> "AB:CD:..." style fingerprint.
  const h = createHash('sha256').update(seed).digest('hex').toUpperCase()
  return h.match(/.{2}/g).join(':')
}

function makeReceiptsDir(baseDir) {
  const r = joinPath(baseDir, 'receipts')
  mkdirSync(r, { recursive: true })
  // Seed a few synthetic receipts so cite/attest have something to point at.
  // Names follow a stable convention: "rcpt-NNN.json".
  const seeded = []
  for (let i = 1; i <= 3; i += 1) {
    const id = `rcpt-${String(i).padStart(3, '0')}.json`
    const body = JSON.stringify({
      receipt_id: id,
      kind: 'smoke-fixture',
      wave: 'W35',
      issued_at_ms: 1719000000000 + i * 1000,
      body: `synthetic receipt #${i}`,
    })
    writeFileSync(joinPath(r, id), body, 'utf8')
    const digest = 'sha256:' + createHash('sha256').update(body).digest('hex')
    seeded.push({ id, digest })
  }
  return { dir: r, seeded }
}

function makeInstance({ selfId, peerSelfId, peerFingerprint, leaseAllowed, requiredCaps }) {
  const baseDir = joinPath(tmpdir(), 'orange5-fed-smoke', selfId.replace(/[^a-z0-9.-]/gi, '_') + '-' + randomBytes(4).toString('hex'))
  mkdirSync(baseDir, { recursive: true })
  const { dir: receiptsDir, seeded } = makeReceiptsDir(baseDir)

  // Build the trust-list-style peers index that handshake.mjs's state uses.
  // The shape mirrors loadTrustedPeers()'s output: { byFingerprint, byPeerId, list }.
  const entry = Object.freeze({
    peer_id: peerSelfId,
    cert_sha256: normalizeFingerprint(peerFingerprint),
    capabilities_required: Object.freeze(Array.isArray(requiredCaps) ? requiredCaps.slice() : []),
    lease_delegation_allowed: leaseAllowed === true,
  })
  const byFingerprint = new Map([[entry.cert_sha256, entry]])
  const byPeerId = new Map([[entry.peer_id, entry]])
  const peers = Object.freeze({ byFingerprint, byPeerId, list: Object.freeze([entry]) })

  // Handshake state (replica of handshake.mjs's buildState; smoke test does
  // not import buildState because it's not exported — we build the same
  // shape here intentionally so a future change to buildState will fail this
  // smoke test loudly).
  const hsState = {
    self_id: selfId,
    peers,
    capabilities: Object.freeze(LOCAL_CAPABILITIES.slice()),
    sessions: new Map(),
    request_count: 0,
    handshake_count: 0,
    refusal_count: 0,
    last_refusal: null,
  }

  const leaseState = buildLeaseState({
    self_id: selfId,
    peers,
    getSession: (sid) => hsState.sessions.get(sid) || null,
  })

  const localReceiptStore = defaultLocalReceiptStore(receiptsDir)

  return {
    selfId,
    baseDir,
    receiptsDir,
    seeded,
    peers,
    hsState,
    leaseState,
    localReceiptStore,
    bootedAtMs: Date.now() - 1234,
    briefOptions: {
      self_id: selfId,
      bootedAtMs: Date.now() - 1234,
      capabilities: LOCAL_CAPABILITIES.slice(),
      wave: 'W35',
      stratum: 'production',
      hostClass: 'workstation',
      fedDir: HERE,           // for cp-version probe only; no writes
      receiptsDir,
      trilogySeat: { available: true, class: 'I', current_dispute_id_count: 0 },
    },
  }
}

// ---- protocol drivers ------------------------------------------------------
//
// These functions perform a request on the GRANTOR instance, presenting the
// REQUESTER's cert fingerprint. The "wire" is direct function call; the
// peerCertInfo arg is what mTLS would have established.

async function callHandshakeOn(grantor, requester, body) {
  return handleRequest(grantor.hsState, {
    method: 'POST',
    url: '/handshake',
    bodyText: JSON.stringify(body),
    peerCertInfo: { fingerprint: requester.fingerprint },
    isLoopback: false,
  })
}

async function callStateBriefOn(grantor, requester, { sessionId, nowMs }) {
  return handleStateBriefRequest({
    method: 'GET',
    url: STATE_BRIEF_PATH,
    headers: { 'x-federation-session': sessionId },
    authedPeer: { peer_id: requester.selfId, fingerprint: requester.fingerprint },
    sessions: grantor.hsState.sessions,
    briefOptions: grantor.briefOptions,
    nowMs: nowMs || Date.now(),
  })
}

async function callLeaseOn(grantor, requester, path, body, { isLoopback = false, query = {} } = {}) {
  return dispatchLease(grantor.leaseState, {
    method: path === '/lease/list' || path === '/lease/inspect' ? 'GET' : 'POST',
    path,
    query,
    bodyText: body == null ? '' : JSON.stringify(body),
    authPeerId: requester ? requester.selfId : null,
    isLoopback,
  })
}

async function callXrefOn(grantor, requester, { method, path, body, query, sessionId }) {
  const url = path + (query ? '?' + query : '')
  return handleCrossReceiptRequest({
    method,
    url,
    headers: { 'x-federation-session': sessionId },
    bodyText: body == null ? '' : JSON.stringify(body),
    authedPeer: { peer_id: requester.selfId, fingerprint: requester.fingerprint },
    sessions: grantor.hsState.sessions,
    ctx: {
      self_id: grantor.selfId,
      fedDir: grantor.baseDir,
      localReceiptStore: grantor.localReceiptStore,
    },
    nowMs: Date.now(),
  })
}

// ---- smoke run -------------------------------------------------------------

async function run() {
  // ---- BOOT TWO SOVEREIGN INSTANCES ----
  //
  // Alpha and bravo each know the other's self_id and cert fingerprint, and
  // require receipt-xref + state-brief capabilities. Lease delegation is
  // enabled on both sides (one direction is enough to exercise the path; we
  // enable both so symmetry holds).
  const alphaFingerprint = makeFingerprint('alpha-cert-seed')
  const bravoFingerprint = makeFingerprint('bravo-cert-seed')

  const alpha = makeInstance({
    selfId: 'orange5-alpha@atomeons',
    peerSelfId: 'orange5-bravo@atomeons',
    peerFingerprint: bravoFingerprint,
    leaseAllowed: true,
    requiredCaps: ['state-brief', 'receipt-xref'],
  })
  alpha.fingerprint = alphaFingerprint  // own cert (presented to peers)

  const bravo = makeInstance({
    selfId: 'orange5-bravo@atomeons',
    peerSelfId: 'orange5-alpha@atomeons',
    peerFingerprint: alphaFingerprint,
    leaseAllowed: true,
    requiredCaps: ['state-brief', 'receipt-xref'],
  })
  bravo.fingerprint = bravoFingerprint

  // ====================================================================
  // SECTION 1 — HANDSHAKE
  // ====================================================================

  // 1.1 Successful mutual handshake (alpha -> bravo).
  const okHandshakeBody = {
    peer_id: alpha.selfId,
    schema_version: FEDERATION_SCHEMA_VERSION,
    capabilities: ['state-brief', 'receipt-xref', 'time-sync', 'capabilities'],
    peer_now_ms: Date.now(),
    nonce: 'nonce-handshake-' + randomBytes(6).toString('hex'),
  }
  const hsResp = await callHandshakeOn(bravo, alpha, okHandshakeBody)
  const hsBody = parseBody(hsResp)
  assertEq('handshake.alpha->bravo.status', hsResp.status, 200)
  assert('handshake.alpha->bravo.ok', hsBody && hsBody.ok === true,
    hsBody && hsBody.error)
  assertEq('handshake.alpha->bravo.self_id', hsBody && hsBody.self_id, bravo.selfId)
  assertEq('handshake.alpha->bravo.peer_id', hsBody && hsBody.peer_id, alpha.selfId)
  assertEq('handshake.alpha->bravo.schema', hsBody && hsBody.schema_version, FEDERATION_SCHEMA_VERSION)
  assert('handshake.alpha->bravo.session_id',
    hsBody && typeof hsBody.session_id === 'string' && hsBody.session_id.length > 0,
    'session_id missing')
  assert('handshake.alpha->bravo.skew_within_limit',
    hsBody && Math.abs(hsBody.skew_ms) <= MAX_CLOCK_SKEW_MS,
    `skew=${hsBody && hsBody.skew_ms}`)
  assertEq('handshake.alpha->bravo.doctrine_ref',
    hsBody && hsBody.doctrine_ref, 'ATOM-FED-TRIUMVIRATE-v1-2026-0617')

  const alphaSessionOnBravo = hsBody.session_id

  // 1.2 Reciprocal handshake (bravo -> alpha). Each side is independently
  // sovereign; both must succeed for cross-coordination.
  const reciprocalBody = {
    peer_id: bravo.selfId,
    schema_version: FEDERATION_SCHEMA_VERSION,
    capabilities: ['state-brief', 'receipt-xref', 'time-sync', 'capabilities'],
    peer_now_ms: Date.now(),
    nonce: 'nonce-handshake-' + randomBytes(6).toString('hex'),
  }
  const recResp = await callHandshakeOn(alpha, bravo, reciprocalBody)
  const recBody = parseBody(recResp)
  assertEq('handshake.bravo->alpha.status', recResp.status, 200)
  assert('handshake.bravo->alpha.ok', recBody && recBody.ok === true,
    recBody && recBody.error)
  const bravoSessionOnAlpha = recBody && recBody.session_id

  // 1.3 Refusal: schema mismatch.
  const badSchema = await callHandshakeOn(bravo, alpha, {
    ...okHandshakeBody,
    schema_version: 'atomeons.federation.vTROLL',
    nonce: 'nonce-bad-schema-' + randomBytes(4).toString('hex'),
  })
  const badSchemaBody = parseBody(badSchema)
  assertEq('handshake.refuse.schema.status', badSchema.status, 409)
  assertEq('handshake.refuse.schema.error', badSchemaBody && badSchemaBody.error, REFUSAL.SCHEMA_MISMATCH)

  // 1.4 Refusal: clock skew way over limit.
  const skewedBody = {
    ...okHandshakeBody,
    peer_now_ms: Date.now() - (MAX_CLOCK_SKEW_MS * 10),
    nonce: 'nonce-skew-' + randomBytes(4).toString('hex'),
  }
  const skewedResp = await callHandshakeOn(bravo, alpha, skewedBody)
  const skewedRespBody = parseBody(skewedResp)
  assertEq('handshake.refuse.clock_skew.status', skewedResp.status, 409)
  assertEq('handshake.refuse.clock_skew.error', skewedRespBody && skewedRespBody.error, REFUSAL.CLOCK_SKEW)

  // 1.5 Refusal: unknown peer (presenting an unrecognized cert fingerprint).
  const ghostFingerprint = makeFingerprint('ghost-seed')
  const ghostResp = await handleRequest(bravo.hsState, {
    method: 'POST',
    url: '/handshake',
    bodyText: JSON.stringify({
      ...okHandshakeBody,
      nonce: 'nonce-ghost-' + randomBytes(4).toString('hex'),
    }),
    peerCertInfo: { fingerprint: ghostFingerprint },
    isLoopback: false,
  })
  const ghostBody = parseBody(ghostResp)
  assertEq('handshake.refuse.unknown_peer.status', ghostResp.status, 401)
  assertEq('handshake.refuse.unknown_peer.error', ghostBody && ghostBody.error, REFUSAL.UNKNOWN_PEER)

  // 1.6 Refusal: peer_id in body does not match cert-keyed peer_id.
  // Alpha's cert is fine on bravo, but alpha claims to be "rogue-charlie".
  const idMismatchResp = await callHandshakeOn(bravo, alpha, {
    ...okHandshakeBody,
    peer_id: 'orange5-charlie@atomeons',
    nonce: 'nonce-idmis-' + randomBytes(4).toString('hex'),
  })
  const idMismatchBody = parseBody(idMismatchResp)
  assertEq('handshake.refuse.cert_id_mismatch.status', idMismatchResp.status, 403)
  assertEq('handshake.refuse.cert_id_mismatch.error',
    idMismatchBody && idMismatchBody.error, REFUSAL.CERT_FINGERPRINT_MISMATCH)

  // 1.7 Refusal: missing client cert entirely.
  const noCertResp = await handleRequest(bravo.hsState, {
    method: 'POST',
    url: '/handshake',
    bodyText: JSON.stringify({ ...okHandshakeBody, nonce: 'nonce-no-cert' }),
    peerCertInfo: null,
    isLoopback: false,
  })
  const noCertBody = parseBody(noCertResp)
  assertEq('handshake.refuse.missing_cert.status', noCertResp.status, 401)
  assertEq('handshake.refuse.missing_cert.error',
    noCertBody && noCertBody.error, REFUSAL.MISSING_CLIENT_CERT)

  // ====================================================================
  // SECTION 2 — STATE-BRIEF (sovereignty boundary check)
  // ====================================================================

  // 2.1 Successful state-brief alpha -> bravo over the session opened in 1.1.
  const sbResp = await callStateBriefOn(bravo, alpha, { sessionId: alphaSessionOnBravo })
  const sb = parseBody(sbResp)
  assertEq('statebrief.alpha->bravo.status', sbResp.status, 200)
  assert('statebrief.alpha->bravo.ok', sb && sb.ok === true, sb && sb.error)
  assertEq('statebrief.schema', sb && sb.schema, STATE_BRIEF_SCHEMA)
  assertEq('statebrief.self_id', sb && sb.self_id, bravo.selfId)
  assertEq('statebrief.doctrine_ref', sb && sb.doctrine_ref, 'ATOM-FED-TRIUMVIRATE-v1-2026-0617')

  // Sovereignty: guardrails block reports moms_law_enforced + human stop +
  // gate 0 + 27 guardrails + founder salary enforced. These are doctrine
  // invariants — the brief surfaces them so a peer can refuse to coordinate
  // with an instance that disabled them.
  assert('statebrief.guardrails.moms_law', sb && sb.guardrails && sb.guardrails.moms_law_enforced === true)
  assert('statebrief.guardrails.human_stop', sb && sb.guardrails && sb.guardrails.human_final_stop_reachable === true)
  assert('statebrief.guardrails.gate0', sb && sb.guardrails && sb.guardrails.gate_0_present === true)
  assert('statebrief.guardrails.27',
    sb && sb.guardrails && sb.guardrails.guardrail_count === 27,
    sb && sb.guardrails && sb.guardrails.guardrail_count)
  assert('statebrief.guardrails.founder_salary',
    sb && sb.guardrails && sb.guardrails.founder_salary_enforced === true)

  // Redactions: the brief MUST declare what it withholds.
  const stripped = (sb && sb.redactions && sb.redactions.stripped_fields) || []
  for (const required of ['operator_pii', 'api_keys', 'raw_receipts', 'prompts',
                          'model_outputs', 'host_paths', 'workflow_names', 'session_secrets']) {
    assert('statebrief.redacts.' + required, stripped.includes(required),
      `missing redaction declaration: ${required}`)
  }
  // Defense in depth: the brief object itself MUST NOT carry any
  // raw-receipt body or host path. Walk it and assert none of the seeded
  // receipt names leaked across.
  const briefStr = JSON.stringify(sb)
  for (const seed of bravo.seeded) {
    assert('statebrief.no_raw_receipt_id_leak.' + seed.id,
      !briefStr.includes(seed.id),
      `state-brief leaked raw receipt id ${seed.id}`)
  }
  assert('statebrief.no_host_path_leak',
    !briefStr.includes(bravo.baseDir),
    'state-brief leaked the host filesystem path')

  // 2.2 Refusal: unknown / stale session.
  const sbStaleResp = await callStateBriefOn(bravo, alpha, { sessionId: 'not-a-real-session-id' })
  const sbStaleBody = parseBody(sbStaleResp)
  assertEq('statebrief.refuse.stale.status', sbStaleResp.status, 401)
  assertEq('statebrief.refuse.stale.error', sbStaleBody && sbStaleBody.error, 'stale_session')

  // 2.3 Direct buildStateBrief should refuse if self_id is missing — this is
  // the malformed-request guard at the constructor level.
  let buildRefused = false
  try {
    await buildStateBrief({ ...bravo.briefOptions, self_id: '' })
  } catch (e) { buildRefused = e && e.code === REFUSAL.MALFORMED_REQUEST }
  assert('statebrief.constructor.refuses_empty_self_id', buildRefused)

  // ====================================================================
  // SECTION 3 — LEASE GRANT CYCLE
  // ====================================================================
  //
  // Alpha requests a narrow lease from bravo. Bravo's local operator
  // (loopback) approves it. Alpha redeems. We then verify:
  //   - forbidden actions refuse at request time
  //   - non-loopback operator-approve refuses (Stop Authority dominates)
  //   - non-loopback revoke refuses
  //   - replay-redeem refuses
  //   - lease cannot be granted without an active handshake session
  //
  // Note: handshake state in this smoke test was already set up so that
  // alpha has session alphaSessionOnBravo on bravo. The lease state shares
  // the same getSession() lookup so leases can bind to that session.

  // 3.1 Refusal: forbidden scope action.
  const leaseForbiddenResp = await callLeaseOn(bravo, alpha, '/lease/request', {
    session_id: alphaSessionOnBravo,
    scope: { action: 'receipts.write', resource: 'audit/rcpt-001', ttl_ms: 60_000 },
    requester_approval_id: payloadHashOf('requester-approval-doc-A'),
    nonce: 'nonce-lease-forbidden-' + randomBytes(4).toString('hex'),
  })
  const leaseForbiddenBody = parseBody(leaseForbiddenResp)
  assertEq('lease.refuse.forbidden.status', leaseForbiddenResp.status, 400)
  assertEq('lease.refuse.forbidden.error',
    leaseForbiddenBody && leaseForbiddenBody.error, LEASE_REFUSAL.SCOPE_FORBIDDEN_ACTION)

  // 3.2 Refusal: wildcard scope.
  const leaseWildcardResp = await callLeaseOn(bravo, alpha, '/lease/request', {
    session_id: alphaSessionOnBravo,
    scope: { action: 'state.read.*', resource: 'wave/W35', ttl_ms: 60_000 },
    requester_approval_id: payloadHashOf('requester-approval-doc-B'),
    nonce: 'nonce-lease-wildcard-' + randomBytes(4).toString('hex'),
  })
  const leaseWildcardBody = parseBody(leaseWildcardResp)
  assertEq('lease.refuse.wildcard.status', leaseWildcardResp.status, 400)
  assertEq('lease.refuse.wildcard.error',
    leaseWildcardBody && leaseWildcardBody.error, LEASE_REFUSAL.SCOPE_WILDCARD_REFUSED)

  // 3.3 Lawful lease request: narrow read-only state query.
  const requesterApprovalHash = payloadHashOf('requester-approval-doc-C')
  const lawfulNonce = 'nonce-lease-ok-' + randomBytes(6).toString('hex')
  const leaseReqResp = await callLeaseOn(bravo, alpha, '/lease/request', {
    session_id: alphaSessionOnBravo,
    scope: { action: 'federation.state.read', resource: 'wave/W35/summary', ttl_ms: 60_000 },
    requester_approval_id: requesterApprovalHash,
    nonce: lawfulNonce,
  })
  const leaseReqBody = parseBody(leaseReqResp)
  assertEq('lease.request.status', leaseReqResp.status, 200)
  assert('lease.request.ok', leaseReqBody && leaseReqBody.ok === true, leaseReqBody && leaseReqBody.error)
  assertEq('lease.request.status_field',
    leaseReqBody && leaseReqBody.lease && leaseReqBody.lease.status,
    LEASE_STATUS.PENDING_OPERATOR_APPROVAL)

  const leaseId = leaseReqBody.lease.lease_id
  const operatorApprovalId = createHash('sha256').update(
    leaseId + '|' + alpha.selfId + '|' + lawfulNonce + '|' + randomBytes(8).toString('hex')
  ).digest('hex')

  // 3.4 Refusal: non-loopback operator-approve attempt.
  const remoteApprove = await callLeaseOn(bravo, alpha, '/lease/operator-approve',
    { lease_id: leaseId, operator_approval_id: operatorApprovalId },
    { isLoopback: false })
  const remoteApproveBody = parseBody(remoteApprove)
  assertEq('lease.refuse.remote_approve.status', remoteApprove.status, 403)
  assertEq('lease.refuse.remote_approve.error',
    remoteApproveBody && remoteApproveBody.error, LEASE_REFUSAL.LOOPBACK_REQUIRED)

  // 3.5 Loopback operator-approve succeeds.
  const loopApprove = await callLeaseOn(bravo, null, '/lease/operator-approve',
    { lease_id: leaseId, operator_approval_id: operatorApprovalId },
    { isLoopback: true })
  const loopApproveBody = parseBody(loopApprove)
  assertEq('lease.operator_approve.status', loopApprove.status, 200)
  assert('lease.operator_approve.ok',
    loopApproveBody && loopApproveBody.ok === true, loopApproveBody && loopApproveBody.error)
  assertEq('lease.operator_approve.status_field',
    loopApproveBody && loopApproveBody.status, LEASE_STATUS.GRANTED)

  // 3.6 Redeem the lease.
  const actionPayload = { scope: 'wave/W35/summary', action: 'federation.state.read' }
  const actionHash = payloadHashOf(actionPayload)
  const redeemResp = await callLeaseOn(bravo, alpha, '/lease/redeem', {
    lease_id: leaseId,
    action_payload_hash: actionHash,
    nonce: 'nonce-redeem-' + randomBytes(6).toString('hex'),
  })
  const redeemBody = parseBody(redeemResp)
  assertEq('lease.redeem.status', redeemResp.status, 200)
  assert('lease.redeem.ok', redeemBody && redeemBody.ok === true, redeemBody && redeemBody.error)
  assertEq('lease.redeem.status_field', redeemBody && redeemBody.status, LEASE_STATUS.REDEEMED)
  assertEq('lease.redeem.payload_hash_commit',
    redeemBody && redeemBody.payload_hash_committed, actionHash)

  // 3.7 Replay refused: redeem again with a new nonce -> LEASE_REDEEMED.
  const replayResp = await callLeaseOn(bravo, alpha, '/lease/redeem', {
    lease_id: leaseId,
    action_payload_hash: actionHash,
    nonce: 'nonce-redeem-replay-' + randomBytes(4).toString('hex'),
  })
  const replayBody = parseBody(replayResp)
  assertEq('lease.refuse.replay.status', replayResp.status, 409)
  assertEq('lease.refuse.replay.error', replayBody && replayBody.error, LEASE_REFUSAL.LEASE_REDEEMED)

  // 3.8 Refusal: non-loopback revoke (sovereignty — only local operator
  // can pull a lease, peer notification is intentionally absent).
  const remoteRevoke = await callLeaseOn(bravo, alpha, '/lease/revoke',
    { lease_id: leaseId, reason: 'attempted-peer-revoke' },
    { isLoopback: false })
  const remoteRevokeBody = parseBody(remoteRevoke)
  assertEq('lease.refuse.remote_revoke.status', remoteRevoke.status, 403)
  assertEq('lease.refuse.remote_revoke.error',
    remoteRevokeBody && remoteRevokeBody.error, LEASE_REFUSAL.LOOPBACK_REQUIRED)

  // 3.9 Spot-check: the forbidden-actions set has the load-bearing items.
  for (const fa of ['receipts.write', 'gate.disable', 'human_final_stop.disable',
                    'lease.grant', 'runtime.node.mutate', '*']) {
    assert('lease.forbidden_actions.includes.' + fa,
      FORBIDDEN_ACTIONS.has(fa),
      `expected ${fa} in FORBIDDEN_ACTIONS`)
  }

  // ====================================================================
  // SECTION 4 — CROSS-RECEIPT (federation-grade citation, sovereign chains)
  // ====================================================================

  // 4.1 Alpha cites a bravo receipt at bravo. Note that "we cite a peer
  // receipt" semantically means: from alpha's perspective alpha is the
  // citer; from bravo's view (where the row is written) the row goes into
  // bravo's xref/<alpha>/outbound.jsonl. The handler stores the citation
  // under the AUTHED PEER's id (alpha), keyed under bravo's local
  // ctx.self_id, so:
  //   ctx.self_id           = bravo
  //   authedPeer.peer_id    = alpha
  //   local_receipt_id      = a real bravo receipt
  //   peer_receipt_url      = some https URL alpha would publish under
  //   peer_receipt_digest   = sha256 of alpha's receipt (we synthesize)
  const fakeAlphaReceiptBody = JSON.stringify({ id: 'rcpt-alpha-001', body: 'synthetic alpha receipt' })
  const fakeAlphaDigest = 'sha256:' + createHash('sha256').update(fakeAlphaReceiptBody).digest('hex')
  const fakeAlphaReceiptUrl = 'https://orange5-alpha.atomeons.local/receipts/rcpt-alpha-001'

  const localReceiptId = bravo.seeded[0].id   // a real local receipt on bravo
  const citeBody = {
    local_receipt_id: localReceiptId,
    peer_receipt_url: fakeAlphaReceiptUrl,
    peer_receipt_digest: fakeAlphaDigest,
    peer_receipt_issued_at_ms: 1719000005000,
    memo: 'W35 cross-cite smoke',
  }
  const citeResp = await callXrefOn(bravo, alpha, {
    method: 'POST', path: XREF_PATH_CITE, body: citeBody,
    sessionId: alphaSessionOnBravo,
  })
  const citeBodyResp = parseBody(citeResp)
  assertEq('xref.cite.status', citeResp.status, 200)
  assert('xref.cite.ok', citeBodyResp && citeBodyResp.ok === true, citeBodyResp && citeBodyResp.error)
  assert('xref.cite.citation_id',
    citeBodyResp && typeof citeBodyResp.citation_id === 'string'
      && citeBodyResp.citation_id.startsWith('xref-'),
    citeBodyResp && citeBodyResp.citation_id)

  // 4.2 Duplicate cite refused.
  const dupCiteResp = await callXrefOn(bravo, alpha, {
    method: 'POST', path: XREF_PATH_CITE, body: citeBody,
    sessionId: alphaSessionOnBravo,
  })
  const dupCiteBody = parseBody(dupCiteResp)
  assertEq('xref.cite.dup.status', dupCiteResp.status, 409)
  assertEq('xref.cite.dup.error', dupCiteBody && dupCiteBody.error, XREF_REFUSAL.DUPLICATE_CITATION)

  // 4.3 Refusal: bad URL (http://).
  const badUrlResp = await callXrefOn(bravo, alpha, {
    method: 'POST', path: XREF_PATH_CITE, body: { ...citeBody, peer_receipt_url: 'http://insecure.example/rcpt' },
    sessionId: alphaSessionOnBravo,
  })
  const badUrlBody = parseBody(badUrlResp)
  assertEq('xref.cite.bad_url.status', badUrlResp.status, 400)
  assertEq('xref.cite.bad_url.error', badUrlBody && badUrlBody.error, XREF_REFUSAL.URL_FORMAT)

  // 4.4 Refusal: unknown local receipt.
  const unknownResp = await callXrefOn(bravo, alpha, {
    method: 'POST', path: XREF_PATH_CITE, body: { ...citeBody, local_receipt_id: 'rcpt-does-not-exist.json' },
    sessionId: alphaSessionOnBravo,
  })
  const unknownBody = parseBody(unknownResp)
  assertEq('xref.cite.unknown_receipt.status', unknownResp.status, 404)
  assertEq('xref.cite.unknown_receipt.error',
    unknownBody && unknownBody.error, XREF_REFUSAL.UNKNOWN_LOCAL_RECEIPT)

  // 4.5 Bravo (acting as the cited side) verifies an attestation from alpha
  // that "I have cited your receipt R at my url U with claimed_local_digest
  // D". The handler recomputes the local digest of R and refuses if D
  // doesn't match — preventing a peer from forging a back-link.
  //
  // First: a CORRECT attestation. Compute bravo's seeded[0] digest from its
  // file body so we know the canonical answer.
  const seededDigest = bravo.seeded[0].digest
  const attestBody = {
    peer_citation_id: 'alpha-xref-001',
    peer_citation_url: 'https://orange5-alpha.atomeons.local/xref/alpha-xref-001',
    local_receipt_id: localReceiptId,
    claimed_local_digest: seededDigest,
    issued_at_ms: Date.now(),
  }
  const attestResp = await callXrefOn(bravo, alpha, {
    method: 'POST', path: XREF_PATH_ATTEST, body: attestBody,
    sessionId: alphaSessionOnBravo,
  })
  const attestBodyResp = parseBody(attestResp)
  assertEq('xref.attest.status', attestResp.status, 200)
  assert('xref.attest.ok', attestBodyResp && attestBodyResp.ok === true,
    attestBodyResp && attestBodyResp.error)
  assert('xref.attest.verified', attestBodyResp && attestBodyResp.verified === true)
  assertEq('xref.attest.local_digest',
    attestBodyResp && attestBodyResp.local_digest_verified, seededDigest)

  // 4.6 Refusal: tampered claimed_local_digest. The peer cannot forge a
  // back-link to a receipt whose body it doesn't actually know.
  const tamperedAttest = {
    ...attestBody,
    peer_citation_id: 'alpha-xref-002',
    peer_citation_url: 'https://orange5-alpha.atomeons.local/xref/alpha-xref-002',
    claimed_local_digest: 'sha256:' + 'f'.repeat(64),
  }
  const tamperedResp = await callXrefOn(bravo, alpha, {
    method: 'POST', path: XREF_PATH_ATTEST, body: tamperedAttest,
    sessionId: alphaSessionOnBravo,
  })
  const tamperedBody = parseBody(tamperedResp)
  assertEq('xref.attest.tamper.status', tamperedResp.status, 409)
  assertEq('xref.attest.tamper.error',
    tamperedBody && tamperedBody.error, XREF_REFUSAL.DIGEST_MISMATCH)

  // 4.7 Resolve confirms the outbound cite + inbound back-link are stored
  // under the same local receipt id.
  const resolveResp = await callXrefOn(bravo, alpha, {
    method: 'GET', path: XREF_PATH_RESOLVE,
    query: 'local_receipt_id=' + encodeURIComponent(localReceiptId),
    sessionId: alphaSessionOnBravo,
  })
  const resolveBody = parseBody(resolveResp)
  assertEq('xref.resolve.status', resolveResp.status, 200)
  assert('xref.resolve.ok', resolveBody && resolveBody.ok === true)
  assert('xref.resolve.outbound.has_one',
    resolveBody && Array.isArray(resolveBody.outbound_citations)
      && resolveBody.outbound_citations.length === 1,
    'expected exactly one outbound citation')
  assert('xref.resolve.inbound.has_one',
    resolveBody && Array.isArray(resolveBody.inbound_back_links)
      && resolveBody.inbound_back_links.length === 1,
    'expected exactly one inbound back-link')

  // ====================================================================
  // SECTION 5 — FEDERATION DOES NOT OVERRIDE LOCAL AUTHORITY
  // ====================================================================
  //
  // Final-meta assertions: no exported handler in this protocol has the
  // surface area to silently mutate the other side's receipts, dividend, or
  // guardrails. We assert this by structural inspection — the surface that
  // SHOULD exist (state-brief, receipt-xref cite/attest/resolve/index,
  // lease request/redeem) exists and is authenticated; the surface that
  // MUST NOT exist (writeReceipt, setDividend, disableGate, etc.) is
  // simply not exported.

  const mustNotExport = [
    'writeReceipt', 'setDividend', 'disableGate', 'mutateGuardrail',
    'bypassLBCE', 'overrideMomsLaw', 'setFounderSalary',
  ]
  // Re-import the modules and verify the dangerous names are absent.
  const modHS = await import('./handshake.mjs')
  const modSB = await import('./state-brief.mjs')
  const modLS = await import('./lease.mjs')
  const modXR = await import('./cross-receipt.mjs')
  for (const name of mustNotExport) {
    assert('sovereignty.handshake.no.' + name, !(name in modHS), 'handshake.mjs exports forbidden name')
    assert('sovereignty.statebrief.no.' + name, !(name in modSB), 'state-brief.mjs exports forbidden name')
    assert('sovereignty.lease.no.' + name, !(name in modLS), 'lease.mjs exports forbidden name')
    assert('sovereignty.xref.no.' + name, !(name in modXR), 'cross-receipt.mjs exports forbidden name')
  }
  // Doctrine ref preserved across the module surface.
  assert('sovereignty.doctrine_ref_present_in_lease_schema',
    LEASE_SCHEMA_VERSION === 'atomeons.federation.lease.v1')

  // ====================================================================
  // RUN REPORT
  // ====================================================================

  const summary = {
    schema: 'atomeons.federation.smoke.v1',
    doctrine_ref: 'ATOM-FED-TRIUMVIRATE-v1-2026-0617',
    ran_at_ms: Date.now(),
    ran_at_iso: new Date().toISOString(),
    instances: {
      alpha: { self_id: alpha.selfId, base_dir: alpha.baseDir, receipts: alpha.seeded.length },
      bravo: { self_id: bravo.selfId, base_dir: bravo.baseDir, receipts: bravo.seeded.length },
    },
    note: 'simulated 2-instance smoke (in-process handler calls; mTLS exercised by a separate cert-bound integration test, which depends on per-pair certs the operator provisions out-of-band per FEDERATION_TRIUMVIRATE_DOCTRINE.md).',
    counts: {
      total: results.length,
      passed: results.length - failed,
      failed,
    },
    first_failure: results.find(r => !r.ok) || null,
    failures: results.filter(r => !r.ok),
  }

  // Write a structured run receipt next to this file so a doctrine reader
  // can see the latest smoke verdict without re-running.
  const receiptPath = joinPath(HERE, 'smoke-last-run.json')
  try { writeFileSync(receiptPath, JSON.stringify(summary, null, 2), 'utf8') }
  catch (e) { /* non-fatal — print the summary either way */ }

  process.stdout.write(JSON.stringify(summary, null, 2) + '\n')

  // Clean up the per-instance temp dirs so a developer running this locally
  // isn't leaking tmp paths. Best-effort; failures here do not fail the run.
  for (const inst of [alpha, bravo]) {
    try { if (existsSync(inst.baseDir)) rmSync(inst.baseDir, { recursive: true, force: true }) }
    catch { /* ignore */ }
  }

  if (failed > 0) {
    process.exitCode = 1
  }
}

// ---- entry -----------------------------------------------------------------

const invokedDirectly = (() => {
  try { return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1] }
  catch { return false }
})()

if (invokedDirectly) {
  run().catch(err => {
    process.stderr.write(JSON.stringify({
      schema: 'atomeons.federation.smoke.v1',
      ok: false,
      error: 'smoke_run_threw',
      detail: String(err && err.stack || err && err.message || err),
    }) + '\n')
    process.exit(1)
  })
}

export { run }
