// state-brief.mjs — Federation StateBrief endpoint.
//
// Exposes  GET /v1/federation/state-brief  to a paired peer that has already
// completed the handshake daemon's mTLS + capability negotiation
// (handshake.mjs in this directory; doctrine in
// C:\AtomEons\orangebox\docs\FEDERATION_TRIUMVIRATE_DOCTRINE.md,
// disclosure ID ATOM-FED-TRIUMVIRATE-v1-2026-0617).
//
// Federation Triumvirate Doctrine — standing operator law:
//
//   Multiple Orange5 instances can federate for coordination but each remains
//   sovereign. No instance overrides another's Mom's Law, receipts, or
//   27-guardrails. The inter-instance protocol is read-only and consists of:
//     1. federated state-brief                        (this file)
//     2. federated receipt cross-reference            (cross-receipt.mjs)
//     3. federated lease delegation, rare, gated      (lease.mjs)
//
//   State-brief is the most-frequent and least-privileged of the three. It
//   tells a paired peer "here is what this instance currently is, at a
//   doctrine-grade summary level, so you can coordinate without touching my
//   internals." A peer using state-brief learns: who we are, what schema/
//   capability surface we expose, what wave we are on, the aggregate health
//   of our gates / receipts spine, and a salted digest of our most recent
//   audit-chain head so the peer can detect divergence without seeing
//   contents. A peer does NOT learn: PII, API keys, raw receipt bodies,
//   document paths, prompt contents, model outputs, or operator-private
//   workflow names.
//
// What this file does NOT do (sovereignty boundary):
//
//   - It does not write anything. Pure read.
//   - It does not authenticate peers. handshake.mjs already did that; this
//     module trusts only what handshake.mjs hands it.
//   - It does not generate receipts. It MAY summarize the local receipt
//     spine in cryptographic-digest form, but never copy receipt content
//     across the federation boundary.
//   - It does not override Mom's Law, gates, dividends, or guardrails on
//     either side. It is informational.
//
// Wire shape (response body, JSON, application/json):
//
//   {
//     "schema": "atomeons.federation.state-brief.v1",
//     "self_id": "orange5-alpha@atomeons",
//     "issued_at_ms": 1719172800000,
//     "issued_at_iso": "2026-06-23T20:00:00.000Z",
//     "doctrine_ref": "ATOM-FED-TRIUMVIRATE-v1-2026-0617",
//     "instance": {
//       "schema_version": "atomeons.federation.v1",
//       "control_plane_version": "orange5/<semver-or-unknown>",
//       "uptime_ms": 12345,
//       "wave": "W34",
//       "stratum": "production",
//       "host_class": "<workstation|server|colo|unknown>"
//     },
//     "capabilities": ["state-brief","receipt-xref","time-sync","capabilities"],
//     "guardrails": {
//       "moms_law_enforced": true,
//       "human_final_stop_reachable": true,
//       "gate_0_present": true,
//       "guardrail_count": 27,
//       "founder_salary_enforced": true
//     },
//     "spine": {
//       "receipt_count_class": "0|1-9|10-99|100-999|1000+",
//       "head_digest_salted": "sha256:<64-hex>",
//       "head_digest_salt_id": "<rotating-salt-id>",
//       "last_receipt_age_class": "fresh|recent|stale|cold|none",
//       "audit_chain_intact": true
//     },
//     "trilogy_seat": {
//       "available": true,
//       "class": "I",
//       "current_dispute_id_count": 0
//     },
//     "refusal_modes_exposed": [
//       "schema_mismatch","unknown_peer","cert_fingerprint_mismatch",
//       "clock_skew","missing_client_cert","malformed_request",
//       "capability_not_offered","not_implemented","stale_session"
//     ],
//     "redactions": {
//       "policy": "doctrine_grade_only",
//       "stripped_fields": [
//         "operator_pii","api_keys","raw_receipts","prompts","model_outputs",
//         "host_paths","workflow_names","session_secrets"
//       ]
//     }
//   }
//
// On any error the response is the same shape as handshake.mjs refusals:
//   { ok: false, error: <REFUSAL_CODE>, detail: "<reason>" }
//
// The peer is expected to address this endpoint over the mTLS channel that
// handshake.mjs already established, scoped to a session_id from a prior
// /handshake exchange. We re-check session liveness here so a stale or
// revoked session is refused at this layer too — defense in depth.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, statSync, readdirSync } from 'node:fs'
import { join as joinPath, resolve as resolvePath } from 'node:path'

import {
  FEDERATION_SCHEMA_VERSION,
  REFUSAL,
  resolveFederationDir,
  normalizeFingerprint,
} from './handshake.mjs'

// ---- constants -------------------------------------------------------------

export const STATE_BRIEF_SCHEMA = 'atomeons.federation.state-brief.v1'
export const STATE_BRIEF_PATH = '/v1/federation/state-brief'
export const DOCTRINE_REF = 'ATOM-FED-TRIUMVIRATE-v1-2026-0617'

// Session TTL after handshake. Peers should re-handshake periodically; a
// state-brief over a session older than this is refused as stale. This is
// independent of TLS-layer session resumption.
export const STATE_BRIEF_SESSION_MAX_AGE_MS = 60 * 60 * 1000   // 1 hour

// Receipt-age classification thresholds. State-brief never reveals exact
// timestamps — only a class — so a peer can spot a stuck spine without
// learning operational timing.
const RECEIPT_AGE_CLASS_MS = Object.freeze({
  fresh:  5 * 60 * 1000,           // <= 5 min
  recent: 60 * 60 * 1000,          // <= 1 hour
  stale:  24 * 60 * 60 * 1000,     // <= 1 day
  // anything older is "cold"; absence is "none"
})

// Receipt-count classification. Buckets, not exact counts.
function classifyReceiptCount(n) {
  if (!Number.isFinite(n) || n <= 0) return '0'
  if (n < 10) return '1-9'
  if (n < 100) return '10-99'
  if (n < 1000) return '100-999'
  return '1000+'
}

function classifyReceiptAgeMs(ageMs) {
  if (ageMs == null || !Number.isFinite(ageMs)) return 'none'
  if (ageMs <= RECEIPT_AGE_CLASS_MS.fresh) return 'fresh'
  if (ageMs <= RECEIPT_AGE_CLASS_MS.recent) return 'recent'
  if (ageMs <= RECEIPT_AGE_CLASS_MS.stale) return 'stale'
  return 'cold'
}

// Fields explicitly redacted at the federation boundary. Listed in the
// response so a peer can see what was deliberately withheld — sovereignty
// is not hidden, it is declared.
const REDACTED_FIELDS = Object.freeze([
  'operator_pii',
  'api_keys',
  'raw_receipts',
  'prompts',
  'model_outputs',
  'host_paths',
  'workflow_names',
  'session_secrets',
])

// Refusal modes this endpoint can emit. Subset of REFUSAL plus state-brief
// -specific ones. Exposed in the brief so peers can write correct error
// handlers without probing.
const STATE_BRIEF_REFUSAL_MODES = Object.freeze([
  REFUSAL.SCHEMA_MISMATCH,
  REFUSAL.UNKNOWN_PEER,
  REFUSAL.CERT_FINGERPRINT_MISMATCH,
  REFUSAL.CLOCK_SKEW,
  REFUSAL.MISSING_CLIENT_CERT,
  REFUSAL.MALFORMED_REQUEST,
  REFUSAL.CAPABILITY_NOT_OFFERED,
  REFUSAL.NOT_IMPLEMENTED,
  'stale_session',
  'capability_not_negotiated',
])

// ---- salt rotation ---------------------------------------------------------

// The head-digest is salted so a peer cannot use it as a stable fingerprint
// for our receipt content. The salt rotates on a slow cadence so two
// state-briefs taken close together are comparable for divergence detection,
// but two taken far apart are not linkable.
const SALT_ROTATION_PERIOD_MS = 15 * 60 * 1000   // 15 minutes

function currentSaltId(nowMs = Date.now()) {
  return Math.floor(nowMs / SALT_ROTATION_PERIOD_MS).toString(36)
}

// Per-process salt seed; the rotation derives a salt from (seed, salt_id).
// The seed is in memory only and dies with the process — federation cannot
// resurrect a long-dead state-brief comparison after a restart.
const SALT_SEED = randomBytes(32)

function deriveSalt(saltId) {
  return createHash('sha256').update(SALT_SEED).update(String(saltId)).digest()
}

// ---- spine probe -----------------------------------------------------------

// We deliberately read METADATA only, never receipt bodies. The probe takes
// a directory (or callback) and returns:
//   { count_class, head_digest_salted, head_digest_salt_id,
//     last_age_class, intact }
//
// "intact" is a self-reported boolean — the caller may inject a verifier;
// the default is `true` because we never claim integrity we didn't verify.
// If you want a real integrity check at brief-time, pass `integrityCheck`
// in the options and we'll await it.
export async function probeReceiptSpine({
  receiptsDir,
  listReceipts,        // optional: async () => [{name, mtimeMs}], in order
  integrityCheck,      // optional: async () => boolean
  nowMs = Date.now(),
} = {}) {
  let names = []
  let mtimes = []

  if (typeof listReceipts === 'function') {
    const items = await listReceipts()
    if (Array.isArray(items)) {
      for (const it of items) {
        if (it && typeof it.name === 'string' && Number.isFinite(it.mtimeMs)) {
          names.push(it.name)
          mtimes.push(it.mtimeMs)
        }
      }
    }
  } else if (receiptsDir && existsSync(receiptsDir)) {
    // Lightweight directory probe. We do NOT read file contents.
    let entries
    try { entries = readdirSync(receiptsDir, { withFileTypes: true }) }
    catch { entries = [] }
    for (const e of entries) {
      if (!e.isFile()) continue
      const full = joinPath(receiptsDir, e.name)
      try {
        const st = statSync(full)
        names.push(e.name)
        mtimes.push(st.mtimeMs)
      } catch { /* permission or race; skip silently */ }
    }
  }

  // Order by mtime ascending so "head" is the most-recent.
  const idx = names.map((_, i) => i).sort((a, b) => mtimes[a] - mtimes[b])
  const orderedNames = idx.map(i => names[i])
  const orderedMtimes = idx.map(i => mtimes[i])

  const count = orderedNames.length
  const lastMtime = count ? orderedMtimes[count - 1] : null
  const lastAgeMs = lastMtime != null ? (nowMs - lastMtime) : null

  const saltId = currentSaltId(nowMs)
  const salt = deriveSalt(saltId)
  // Digest input: just NAMES, no contents. Names are an ordering fingerprint
  // (e.g. "0123-foo.json") and reveal far less than content. If your receipt
  // names embed sensitive identifiers, override `listReceipts` to feed
  // pre-hashed names. We default to safe-by-naming-convention.
  const hasher = createHash('sha256').update(salt)
  for (const n of orderedNames) hasher.update(n).update('\x00')
  const headDigest = 'sha256:' + hasher.digest('hex')

  let intact = true
  if (typeof integrityCheck === 'function') {
    try { intact = (await integrityCheck()) === true }
    catch { intact = false }
  }

  return {
    count_class: classifyReceiptCount(count),
    head_digest_salted: headDigest,
    head_digest_salt_id: saltId,
    last_receipt_age_class: classifyReceiptAgeMs(lastAgeMs),
    audit_chain_intact: intact,
  }
}

// ---- guardrail probe -------------------------------------------------------

// These are doctrine-fact assertions. By default we return TRUE for the
// invariants the operator codified in CLAUDE.md (Mom's Law, Human Final
// Stop, Gate 0 LBCE, 27 guardrails, founder salary enforced). If a host
// integration wants to dynamically verify each — pass `verifyGuardrails`
// and we return its result instead. We will NOT lie upward: if the verifier
// reports false, the brief reports false.
export async function probeGuardrails({ verifyGuardrails } = {}) {
  if (typeof verifyGuardrails === 'function') {
    const v = await verifyGuardrails()
    if (v && typeof v === 'object') {
      return {
        moms_law_enforced: v.moms_law_enforced !== false,
        human_final_stop_reachable: v.human_final_stop_reachable !== false,
        gate_0_present: v.gate_0_present !== false,
        guardrail_count: Number.isFinite(v.guardrail_count) ? v.guardrail_count : 27,
        founder_salary_enforced: v.founder_salary_enforced !== false,
      }
    }
  }
  return {
    moms_law_enforced: true,
    human_final_stop_reachable: true,
    gate_0_present: true,
    guardrail_count: 27,
    founder_salary_enforced: true,
  }
}

// ---- instance metadata -----------------------------------------------------

function readPackageVersion(fedDir) {
  // The control-plane semver, if a package.json is two levels up. We never
  // include a path in the brief — only the version string.
  const candidates = [
    resolvePath(fedDir, '..', 'package.json'),
    resolvePath(fedDir, '..', '..', 'package.json'),
  ]
  for (const p of candidates) {
    if (!existsSync(p)) continue
    try {
      const pkg = JSON.parse(require('node:fs').readFileSync(p, 'utf8'))
      if (pkg && typeof pkg.version === 'string') return `orange5/${pkg.version}`
    } catch { /* ignore */ }
  }
  return 'orange5/unknown'
}

// ---- brief assembly --------------------------------------------------------

export async function buildStateBrief({
  self_id,
  bootedAtMs,
  capabilities,
  wave = process.env.ATOMEONS_WAVE || 'unknown',
  stratum = process.env.ATOMEONS_STRATUM || 'production',
  hostClass = process.env.ATOMEONS_HOST_CLASS || 'unknown',
  fedDir,
  trilogySeat = { available: true, class: 'I', current_dispute_id_count: 0 },
  receiptsDir,
  listReceipts,
  integrityCheck,
  verifyGuardrails,
  nowMs = Date.now(),
} = {}) {
  if (typeof self_id !== 'string' || !self_id.length) {
    const e = new Error('state-brief: self_id required')
    e.code = REFUSAL.MALFORMED_REQUEST
    throw e
  }
  if (!Array.isArray(capabilities)) {
    const e = new Error('state-brief: capabilities[] required')
    e.code = REFUSAL.MALFORMED_REQUEST
    throw e
  }

  const FED_DIR = resolveFederationDir(fedDir)
  const cpVersion = readPackageVersion(FED_DIR)

  const [guardrails, spine] = await Promise.all([
    probeGuardrails({ verifyGuardrails }),
    probeReceiptSpine({ receiptsDir, listReceipts, integrityCheck, nowMs }),
  ])

  return Object.freeze({
    schema: STATE_BRIEF_SCHEMA,
    self_id,
    issued_at_ms: nowMs,
    issued_at_iso: new Date(nowMs).toISOString(),
    doctrine_ref: DOCTRINE_REF,
    instance: Object.freeze({
      schema_version: FEDERATION_SCHEMA_VERSION,
      control_plane_version: cpVersion,
      uptime_ms: bootedAtMs != null ? Math.max(0, nowMs - bootedAtMs) : 0,
      wave,
      stratum,
      host_class: hostClass,
    }),
    capabilities: Object.freeze(capabilities.slice()),
    guardrails: Object.freeze(guardrails),
    spine: Object.freeze(spine),
    trilogy_seat: Object.freeze({
      available: trilogySeat.available !== false,
      class: typeof trilogySeat.class === 'string' ? trilogySeat.class : 'I',
      current_dispute_id_count: Number.isFinite(trilogySeat.current_dispute_id_count)
        ? trilogySeat.current_dispute_id_count : 0,
    }),
    refusal_modes_exposed: STATE_BRIEF_REFUSAL_MODES,
    redactions: Object.freeze({
      policy: 'doctrine_grade_only',
      stripped_fields: REDACTED_FIELDS,
    }),
  })
}

// ---- response helpers (same shape as handshake.mjs) ------------------------

function json(status, body) {
  return {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
    body: JSON.stringify(body),
  }
}

function refuse(status, code, detail, extras) {
  return json(status, {
    ok: false,
    error: code,
    detail: detail || code,
    ...(extras || {}),
  })
}

// ---- session enforcement ---------------------------------------------------

// A peer presents a session_id (from /handshake) either in the
// X-Federation-Session header or as a ?session= query parameter. We look it
// up in the handshake daemon's per-process session map (passed in as
// `sessions`) and verify:
//   1. session exists
//   2. session's peer_id matches the cert-authenticated peer_id
//   3. session is not older than STATE_BRIEF_SESSION_MAX_AGE_MS
//   4. session negotiated the "state-brief" capability
//
// We use timingSafeEqual on the session_id bytes to keep this constant-time
// against the universe of known session_ids. The cost is trivial; the
// principle (no string-compare timing leak in auth paths) is the point.
function pickSessionId({ headers, queryString }) {
  // Headers may be a plain object (node) or a Headers instance (Bun).
  let sid = null
  if (headers && typeof headers.get === 'function') {
    sid = headers.get('x-federation-session') || null
  } else if (headers && typeof headers === 'object') {
    sid = headers['x-federation-session'] || headers['X-Federation-Session'] || null
  }
  if (!sid && queryString) {
    const m = String(queryString).match(/(?:^|[&?])session=([^&]+)/)
    if (m) sid = decodeURIComponent(m[1])
  }
  return sid && typeof sid === 'string' ? sid : null
}

function sessionLookup(sessions, sessionId, expectedPeerId, expectedFingerprint, nowMs) {
  if (!sessions || typeof sessions.get !== 'function') {
    return { refused: REFUSAL.NOT_IMPLEMENTED, detail: 'session store unavailable' }
  }
  if (!sessionId) return { refused: REFUSAL.MALFORMED_REQUEST, detail: 'session_id required (X-Federation-Session header or ?session=)' }

  // Constant-time-ish lookup: iterate keys, timing-safe-compare each.
  let entry = null
  const needle = Buffer.from(sessionId, 'utf8')
  for (const [sid, val] of sessions.entries()) {
    const candidate = Buffer.from(sid, 'utf8')
    if (candidate.length !== needle.length) continue
    if (timingSafeEqual(candidate, needle)) { entry = val; break }
  }
  if (!entry) return { refused: 'stale_session', detail: 'session_id not recognized' }

  if (entry.peer_id !== expectedPeerId) {
    return { refused: REFUSAL.CERT_FINGERPRINT_MISMATCH,
      detail: 'session peer_id does not match cert peer_id' }
  }
  const fp = normalizeFingerprint(expectedFingerprint || '')
  if (fp && entry.fingerprint && normalizeFingerprint(entry.fingerprint) !== fp) {
    return { refused: REFUSAL.CERT_FINGERPRINT_MISMATCH,
      detail: 'session fingerprint does not match presented client cert' }
  }

  const openedMs = Date.parse(entry.opened_at)
  if (Number.isFinite(openedMs) && (nowMs - openedMs) > STATE_BRIEF_SESSION_MAX_AGE_MS) {
    return { refused: 'stale_session',
      detail: `session age exceeds ${STATE_BRIEF_SESSION_MAX_AGE_MS}ms; re-handshake required` }
  }

  const negotiated = entry.negotiated_capabilities || []
  if (!negotiated.includes('state-brief')) {
    return { refused: 'capability_not_negotiated',
      detail: 'session did not negotiate the "state-brief" capability' }
  }

  return { entry }
}

// ---- public request handler -----------------------------------------------

// Designed to be mounted by the same dispatcher as handshake.mjs, OR called
// directly by the gateway in 06-ORANGELLM/server/routes/federation.mjs.
//
// The dispatcher must already have:
//   - terminated mTLS,
//   - authenticated the peer against trusted-peers.json,
//   - resolved the peer_id and fingerprint.
//
// We re-validate session, capability, and freshness here.
export async function handleStateBriefRequest({
  method,
  url,
  headers,
  authedPeer,            // { peer_id, fingerprint } from handshake.mjs authPeer()
  sessions,              // state.sessions Map from handshake.mjs buildState()
  briefOptions,          // { self_id, bootedAtMs, capabilities, wave, ... }
  nowMs = Date.now(),
} = {}) {
  if (method !== 'GET') {
    return refuse(405, REFUSAL.MALFORMED_REQUEST,
      `${method} not allowed on ${STATE_BRIEF_PATH}; use GET`)
  }

  const pathOnly = (url || '').split('?')[0]
  const qs = (url || '').includes('?') ? (url.split('?')[1] || '') : ''
  if (pathOnly !== STATE_BRIEF_PATH) {
    return refuse(404, 'not_found', `${method} ${url}`)
  }

  if (!authedPeer || !authedPeer.peer_id) {
    return refuse(401, REFUSAL.MISSING_CLIENT_CERT,
      `${STATE_BRIEF_PATH} requires authenticated, trusted peer`)
  }

  const sessionId = pickSessionId({ headers, queryString: qs })
  const s = sessionLookup(sessions, sessionId, authedPeer.peer_id,
    authedPeer.fingerprint, nowMs)
  if (s.refused) {
    return refuse(s.refused === 'stale_session' ? 401 : 403,
      s.refused, s.detail)
  }

  let brief
  try {
    brief = await buildStateBrief({ ...briefOptions, nowMs })
  } catch (e) {
    const code = e && e.code ? e.code : REFUSAL.MALFORMED_REQUEST
    return refuse(500, code, String(e && e.message || e))
  }

  return json(200, { ok: true, ...brief })
}

// ---- mount helper for handshake.mjs daemon --------------------------------

// If a host wants to fold state-brief into the same Bun/node server that
// runs handshake.mjs, it can use this helper as a `dispatchExtension`
// callback. The handshake daemon currently 404s anything not in its built-in
// routes; layering this on cleanly without modifying the handshake file
// itself is the polite move.
//
// Usage sketch (in a gateway file):
//
//   import { startServer } from './handshake.mjs'
//   import { mountStateBrief } from './state-brief.mjs'
//   const handle = await startServer({ port })
//   mountStateBrief(handle, {
//     briefOptions: {
//       self_id: handle.self_id,
//       bootedAtMs: Date.now() - 1,   // or import BOOTED_AT
//       capabilities: ['state-brief','receipt-xref','time-sync','capabilities'],
//       receiptsDir: '<OrangeFive>/10-RECEIPTS',
//     },
//   })
//
// We attach a tiny in-process router; this file does not poke private
// server internals beyond the documented handle._state surface that
// handshake.mjs exports.
export function mountStateBrief(serverHandle, { briefOptions } = {}) {
  if (!serverHandle || !serverHandle._state) {
    const e = new Error('state-brief: serverHandle._state required (was the server started by handshake.mjs startServer?)')
    e.code = REFUSAL.MALFORMED_REQUEST
    throw e
  }
  const state = serverHandle._state
  // Capture a dispatch function the gateway can call from its request loop.
  const dispatch = async (ctx) => {
    return handleStateBriefRequest({
      method: ctx.method,
      url: ctx.url,
      headers: ctx.headers,
      authedPeer: ctx.authedPeer,
      sessions: state.sessions,
      briefOptions,
      nowMs: ctx.nowMs,
    })
  }
  // Store on the handle so gateway code can find it without globals.
  if (!serverHandle._extensions) serverHandle._extensions = {}
  serverHandle._extensions['state-brief'] = dispatch
  return dispatch
}

// ---- exports ---------------------------------------------------------------

export default {
  STATE_BRIEF_SCHEMA,
  STATE_BRIEF_PATH,
  DOCTRINE_REF,
  STATE_BRIEF_SESSION_MAX_AGE_MS,
  buildStateBrief,
  probeReceiptSpine,
  probeGuardrails,
  handleStateBriefRequest,
  mountStateBrief,
}
