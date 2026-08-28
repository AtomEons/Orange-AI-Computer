// cross-receipt.mjs — Federation receipt cross-reference endpoint.
//
// Exposes:
//    POST /v1/federation/receipt-xref/cite       — emit a local citation row
//                                                    that references a peer
//                                                    receipt by URL + digest
//    GET  /v1/federation/receipt-xref/resolve    — look up the local citation
//                                                    rows that point at a
//                                                    given peer URL OR that a
//                                                    given local receipt has
//                                                    accumulated
//    GET  /v1/federation/receipt-xref/index      — paginated index of all
//                                                    cross-citations this
//                                                    instance has authored
//                                                    for the negotiated peer
//    POST /v1/federation/receipt-xref/attest     — peer-initiated: peer states
//                                                    "I have cited your
//                                                    receipt R at my URL U
//                                                    with digest D"; we store
//                                                    the inbound back-link
//                                                    only after verifying the
//                                                    digest against our local
//                                                    receipt body.
//
// All four endpoints are READ-ONLY with respect to the local receipt CHAIN.
// They write to a SEPARATE cross-reference ledger (`xref-ledger.jsonl`) that
// lives next to receipts but never inside them. The local audit chain's hash
// continuity is untouched by federation activity — by construction, never as
// a runtime-checked invariant.
//
// Doctrine: Federation Triumvirate Doctrine
//   C:\AtomEons\orangebox\docs\FEDERATION_TRIUMVIRATE_DOCTRINE.md
//   disclosure ID ATOM-FED-TRIUMVIRATE-v1-2026-0617
//
// Standing operator law enforced here:
//
//   1. Sovereignty. Each instance keeps its OWN hash chain. A cross-citation
//      is a sibling artifact ("we observed peer-receipt X exists and matches
//      digest D at time T"), never a chain entry on either side. Neither
//      side's Mom's-Law / 27-guardrail boundary is crossed.
//
//   2. Bidirectional but read-only. A citation row written here is just a
//      pointer + digest. The peer's matching row, written by the peer's own
//      cross-receipt.mjs instance, completes the bi-link. We do NOT reach
//      across the wire to write into the peer's ledger; we only ATTEST our
//      side's view and OPTIONALLY accept the peer's attestation about its
//      side via /attest.
//
//   3. Authenticated, capability-gated, session-bound. Same auth model as
//      state-brief.mjs: handshake.mjs's mTLS + trusted-peers.json + active
//      session that negotiated the "receipt-xref" capability. We do NOT
//      authenticate from HTTP headers; we trust only the cert-derived
//      peer_id handed to us by the dispatcher.
//
//   4. Digest verification on attest. When the peer attests "I cited your
//      receipt R", we look up R locally and recompute its body digest. If
//      the digest in the attestation does not match what we have on disk,
//      we refuse the back-link with `digest_mismatch`. We never accept a
//      back-link to a receipt we don't have, because we'd have no way to
//      verify the peer's claim about its contents.
//
//   5. Refusal modes are first-class. The same surface as handshake.mjs:
//      structured { ok:false, error, detail, ... } responses with stable
//      codes a peer can switch on. We never silently succeed on garbage.
//
//   6. Privacy floor. A cross-citation row contains:
//        - the local receipt id (already public to anyone who can read our
//          receipts; not a secret)
//        - the peer receipt URL (chosen by the peer; we treat it as opaque)
//        - the peer receipt's digest (cryptographic; carries no plaintext)
//        - timestamps (issued, observed)
//        - the peer_id (already known to both sides via handshake)
//      It does NOT contain receipt bodies, prompts, gate outputs, dividend
//      numbers, or any other guardrail-protected content.
//
// Wire shapes:
//
//   POST /v1/federation/receipt-xref/cite           (we emit a citation)
//     headers:  X-Federation-Session: <sid>
//     body:     {
//                 "local_receipt_id":   "<our local receipt id>",
//                 "peer_receipt_url":   "https://<peer-host>/receipts/<id>",
//                 "peer_receipt_digest":"sha256:<64-hex>",
//                 "peer_receipt_issued_at_ms": <int>,
//                 "memo":               "<<=120 char operator note, optional>"
//               }
//     200:      { ok:true, citation_id, schema, doctrine_ref, ... }
//     refuse:   malformed_request | unknown_local_receipt | digest_format
//               | url_format | self_citation_refused | duplicate_citation
//
//   GET  /v1/federation/receipt-xref/resolve
//        ?local_receipt_id=<id>     OR  ?peer_receipt_url=<url>
//     headers:  X-Federation-Session: <sid>
//     200:      {
//                 ok: true,
//                 schema: "atomeons.federation.receipt-xref.resolve.v1",
//                 query: { ... },
//                 citations: [ <citation row>, ... ]
//               }
//
//   GET  /v1/federation/receipt-xref/index
//        ?cursor=<opaque>&limit=<<=100>
//     headers:  X-Federation-Session: <sid>
//     200:      {
//                 ok: true,
//                 schema: "atomeons.federation.receipt-xref.index.v1",
//                 peer_id, page_size, next_cursor, citations[]
//               }
//
//   POST /v1/federation/receipt-xref/attest         (peer says: I cited you)
//     headers:  X-Federation-Session: <sid>
//     body:     {
//                 "peer_citation_id":   "<peer's row id, opaque to us>",
//                 "peer_citation_url":  "https://<peer-host>/xref/<id>",
//                 "local_receipt_id":   "<our receipt the peer cites>",
//                 "claimed_local_digest":"sha256:<64-hex>",
//                 "issued_at_ms":       <int>
//               }
//     200:      { ok:true, back_link_id, verified:true, ... }
//     refuse:   unknown_local_receipt | digest_mismatch | url_format
//               | duplicate_back_link

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import {
  existsSync, statSync, readFileSync, readdirSync, mkdirSync,
  appendFileSync, openSync, closeSync, readSync, writeSync, fstatSync,
} from 'node:fs'
import { join as joinPath, resolve as resolvePath } from 'node:path'

import {
  FEDERATION_SCHEMA_VERSION,
  REFUSAL,
  resolveFederationDir,
  normalizeFingerprint,
} from './handshake.mjs'

// ---- constants -------------------------------------------------------------

export const XREF_SCHEMA              = 'atomeons.federation.receipt-xref.v1'
export const XREF_RESOLVE_SCHEMA      = 'atomeons.federation.receipt-xref.resolve.v1'
export const XREF_INDEX_SCHEMA        = 'atomeons.federation.receipt-xref.index.v1'
export const XREF_BACK_LINK_SCHEMA    = 'atomeons.federation.receipt-xref.back-link.v1'
export const DOCTRINE_REF             = 'ATOM-FED-TRIUMVIRATE-v1-2026-0617'

export const XREF_PATH_CITE     = '/v1/federation/receipt-xref/cite'
export const XREF_PATH_RESOLVE  = '/v1/federation/receipt-xref/resolve'
export const XREF_PATH_INDEX    = '/v1/federation/receipt-xref/index'
export const XREF_PATH_ATTEST   = '/v1/federation/receipt-xref/attest'

// Session age cap, same spirit as state-brief.mjs. A stale session must
// re-handshake; cross-referencing under an aged-out session is refused.
export const XREF_SESSION_MAX_AGE_MS = 60 * 60 * 1000   // 1 hour

// Hard surface limits — refuse oversized inputs before parsing further.
export const MAX_URL_LEN              = 2048
export const MAX_MEMO_LEN             = 120
export const MAX_RECEIPT_ID_LEN       = 256
export const MAX_INDEX_PAGE_SIZE      = 100
export const DEFAULT_INDEX_PAGE_SIZE  = 25

// Refusal codes specific to this module. Extending REFUSAL would force a
// cross-file change for every new code; we keep ours local and stable.
export const XREF_REFUSAL = Object.freeze({
  UNKNOWN_LOCAL_RECEIPT: 'unknown_local_receipt',
  DIGEST_FORMAT:         'digest_format',
  DIGEST_MISMATCH:       'digest_mismatch',
  URL_FORMAT:            'url_format',
  SELF_CITATION_REFUSED: 'self_citation_refused',
  DUPLICATE_CITATION:    'duplicate_citation',
  DUPLICATE_BACK_LINK:   'duplicate_back_link',
  STALE_SESSION:         'stale_session',
  CAPABILITY_NOT_NEGOTIATED: 'capability_not_negotiated',
  LEDGER_UNAVAILABLE:    'ledger_unavailable',
  OUT_OF_RANGE:          'out_of_range',
})

// ---- validators ------------------------------------------------------------

const DIGEST_RE = /^sha256:[0-9a-f]{64}$/

export function isValidDigest(d) {
  return typeof d === 'string' && DIGEST_RE.test(d)
}

// We accept https:// only. http:// is refused because cross-receipt URLs are
// the addressable handle that future readers will dereference; we will not
// emit a citation to a non-TLS endpoint. file://, javascript:, data:, etc.
// are refused for obvious reasons.
export function isValidPeerUrl(u) {
  if (typeof u !== 'string') return false
  if (u.length === 0 || u.length > MAX_URL_LEN) return false
  if (!u.startsWith('https://')) return false
  try {
    const parsed = new URL(u)
    if (parsed.protocol !== 'https:') return false
    if (!parsed.hostname || parsed.hostname.length === 0) return false
    return true
  } catch { return false }
}

export function isValidLocalReceiptId(id) {
  if (typeof id !== 'string') return false
  if (id.length === 0 || id.length > MAX_RECEIPT_ID_LEN) return false
  // Conservative: alnum, dash, underscore, dot, slash (for namespaced ids).
  // No spaces, no path-traversal, no shell-meta.
  if (!/^[A-Za-z0-9._\-/]+$/.test(id)) return false
  if (id.includes('..')) return false
  if (id.startsWith('/') || id.endsWith('/')) return false
  return true
}

export function isValidMemo(m) {
  if (m == null) return true
  if (typeof m !== 'string') return false
  if (m.length > MAX_MEMO_LEN) return false
  // Disallow control chars and embedded newlines — memos go through JSON
  // logs and must not break line-oriented tooling.
  return !/[\x00-\x1f\x7f]/.test(m)
}

// ---- ledger paths ----------------------------------------------------------

// Both ledgers are append-only JSONL. We keep outbound and inbound separate
// so neither side can confuse "we cited them" with "they cited us" by
// accident.
//
// Layout under FED_DIR:
//   xref/<peer_id_safe>/outbound.jsonl     — citations we authored
//   xref/<peer_id_safe>/inbound.jsonl      — verified attestations from peer
//
// peer_id_safe is peer_id sanitized for filesystem use.
function peerIdSafe(peerId) {
  return String(peerId).replace(/[^A-Za-z0-9._@-]/g, '_').slice(0, 200)
}

export function resolveXrefDir(fedDir, peerId) {
  const FED = resolveFederationDir(fedDir)
  const dir = joinPath(FED, 'xref', peerIdSafe(peerId))
  return dir
}

function ensureLedgerDir(dir) {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

export function outboundPath(fedDir, peerId) {
  return joinPath(resolveXrefDir(fedDir, peerId), 'outbound.jsonl')
}

export function inboundPath(fedDir, peerId) {
  return joinPath(resolveXrefDir(fedDir, peerId), 'inbound.jsonl')
}

// ---- ledger I/O (append-only, single-process safe) -------------------------
//
// We're deliberately simple here: synchronous append with a re-scan for the
// duplicate check. The cross-reference ledger is low-traffic (citations
// follow wave shipping, not per-request activity) so a linear scan per write
// is fine. For the index endpoint we scan and project; we don't ship a
// secondary index file because the cost of staleness > the cost of a scan
// at this size. If a deployment exceeds 10k citations per peer this should
// be revisited; until then, simplicity wins.

function appendJsonl(path, row) {
  appendFileSync(path, JSON.stringify(row) + '\n', { encoding: 'utf8' })
}

function readJsonl(path) {
  if (!existsSync(path)) return []
  const raw = readFileSync(path, 'utf8')
  if (!raw) return []
  const out = []
  for (const line of raw.split('\n')) {
    const s = line.trim()
    if (!s) continue
    try { out.push(JSON.parse(s)) }
    catch { /* skip corrupt line; ledger is append-only so this is rare */ }
  }
  return out
}

// ---- local receipt resolution ---------------------------------------------
//
// The host integration is expected to supply a `localReceiptStore` with:
//   {
//     exists(id):   bool
//     read(id):     { id, body_buf: Buffer, digest: 'sha256:...' } | null
//   }
//
// The default implementation expects receipts on disk at
// <receiptsDir>/<id>.json (or <id> without extension) and recomputes the
// digest from file bytes. The CALLER may inject a smarter store that already
// knows each receipt's canonical digest from the audit chain — that's
// preferred, because the audit chain's digest is the one that matters; ours
// is just defense-in-depth.

export function defaultLocalReceiptStore(receiptsDir) {
  const ROOT = resolvePath(receiptsDir)

  function pathFor(id) {
    // Allow either `<id>.json` or `<id>` literally on disk.
    const direct = joinPath(ROOT, id)
    const json = joinPath(ROOT, id + '.json')
    if (existsSync(direct) && statSync(direct).isFile()) return direct
    if (existsSync(json) && statSync(json).isFile()) return json
    return null
  }

  return {
    exists(id) {
      if (!isValidLocalReceiptId(id)) return false
      return pathFor(id) != null
    },
    read(id) {
      if (!isValidLocalReceiptId(id)) return null
      const p = pathFor(id)
      if (!p) return null
      const body_buf = readFileSync(p)
      const digest = 'sha256:' + createHash('sha256').update(body_buf).digest('hex')
      return { id, body_buf, digest }
    },
  }
}

// ---- session check (mirror of state-brief.mjs) ----------------------------

function pickSessionId({ headers, queryString }) {
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
  if (!sessionId) {
    return { refused: REFUSAL.MALFORMED_REQUEST,
      detail: 'session_id required (X-Federation-Session header or ?session=)' }
  }
  let entry = null
  const needle = Buffer.from(sessionId, 'utf8')
  for (const [sid, val] of sessions.entries()) {
    const candidate = Buffer.from(sid, 'utf8')
    if (candidate.length !== needle.length) continue
    if (timingSafeEqual(candidate, needle)) { entry = val; break }
  }
  if (!entry) return { refused: XREF_REFUSAL.STALE_SESSION, detail: 'session_id not recognized' }
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
  if (Number.isFinite(openedMs) && (nowMs - openedMs) > XREF_SESSION_MAX_AGE_MS) {
    return { refused: XREF_REFUSAL.STALE_SESSION,
      detail: `session age exceeds ${XREF_SESSION_MAX_AGE_MS}ms; re-handshake required` }
  }
  const negotiated = entry.negotiated_capabilities || []
  if (!negotiated.includes('receipt-xref')) {
    return { refused: XREF_REFUSAL.CAPABILITY_NOT_NEGOTIATED,
      detail: 'session did not negotiate the "receipt-xref" capability' }
  }
  return { entry }
}

// ---- response helpers (same shape as handshake.mjs / state-brief.mjs) ------

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
    schema: XREF_SCHEMA,
    doctrine_ref: DOCTRINE_REF,
    ...(extras || {}),
  })
}

function safeParseJSON(text) {
  if (!text || !text.length) return [null, 'empty body']
  try { return [JSON.parse(text), null] }
  catch (e) { return [null, e.message || String(e)] }
}

function newCitationId() {
  // Prefix tells humans this is an xref row, not a primary receipt id.
  return 'xref-' + randomBytes(12).toString('hex')
}

function newBackLinkId() {
  return 'xrbl-' + randomBytes(12).toString('hex')
}

function parseQuery(qs) {
  const out = {}
  if (!qs) return out
  for (const part of String(qs).split('&')) {
    if (!part) continue
    const eq = part.indexOf('=')
    const k = eq >= 0 ? part.slice(0, eq) : part
    const v = eq >= 0 ? part.slice(eq + 1) : ''
    try { out[decodeURIComponent(k)] = decodeURIComponent(v) }
    catch { /* skip malformed */ }
  }
  return out
}

// ---- duplicate detection ---------------------------------------------------

// Outbound dup: same (local_receipt_id, peer_receipt_url, peer_receipt_digest)
function isOutboundDuplicate(rows, candidate) {
  for (const r of rows) {
    if (r.local_receipt_id === candidate.local_receipt_id
        && r.peer_receipt_url === candidate.peer_receipt_url
        && r.peer_receipt_digest === candidate.peer_receipt_digest) {
      return r
    }
  }
  return null
}

// Inbound dup: same (peer_citation_id, peer_citation_url, local_receipt_id)
function isInboundDuplicate(rows, candidate) {
  for (const r of rows) {
    if (r.peer_citation_id === candidate.peer_citation_id
        && r.peer_citation_url === candidate.peer_citation_url
        && r.local_receipt_id === candidate.local_receipt_id) {
      return r
    }
  }
  return null
}

// ---- self-citation guard ---------------------------------------------------
//
// If the peer is us — by self_id collision — refuse. A self-citation would
// muddle the cross-reference graph; same-instance audit goes through the
// local audit chain, not federation.
function isSelfCitation(selfId, peerId) {
  if (typeof selfId !== 'string' || typeof peerId !== 'string') return false
  return selfId === peerId
}

// ---- handlers --------------------------------------------------------------

export async function handleCite({
  bodyText, authedPeer, sessions, briefOptions, ctx, nowMs = Date.now(),
}) {
  const s = sessionLookup(sessions, ctx.session_id,
    authedPeer.peer_id, authedPeer.fingerprint, nowMs)
  if (s.refused) {
    return refuse(s.refused === XREF_REFUSAL.STALE_SESSION ? 401 : 403,
      s.refused, s.detail)
  }

  const [body, parseErr] = safeParseJSON(bodyText)
  if (parseErr) return refuse(400, REFUSAL.MALFORMED_REQUEST, parseErr)
  if (!body || typeof body !== 'object') {
    return refuse(400, REFUSAL.MALFORMED_REQUEST, 'body must be a JSON object')
  }

  const {
    local_receipt_id,
    peer_receipt_url,
    peer_receipt_digest,
    peer_receipt_issued_at_ms,
    memo,
  } = body

  if (!isValidLocalReceiptId(local_receipt_id)) {
    return refuse(400, REFUSAL.MALFORMED_REQUEST,
      'local_receipt_id must be a non-empty receipt-safe string')
  }
  if (!isValidPeerUrl(peer_receipt_url)) {
    return refuse(400, XREF_REFUSAL.URL_FORMAT,
      'peer_receipt_url must be an https:// URL of reasonable length')
  }
  if (!isValidDigest(peer_receipt_digest)) {
    return refuse(400, XREF_REFUSAL.DIGEST_FORMAT,
      'peer_receipt_digest must match sha256:<64-hex-lowercase>')
  }
  if (typeof peer_receipt_issued_at_ms !== 'number'
      || !Number.isFinite(peer_receipt_issued_at_ms)
      || peer_receipt_issued_at_ms < 0) {
    return refuse(400, REFUSAL.MALFORMED_REQUEST,
      'peer_receipt_issued_at_ms must be a non-negative finite number')
  }
  if (!isValidMemo(memo)) {
    return refuse(400, REFUSAL.MALFORMED_REQUEST,
      `memo must be <=${MAX_MEMO_LEN} printable chars with no control chars`)
  }

  if (isSelfCitation(ctx.self_id, authedPeer.peer_id)) {
    return refuse(403, XREF_REFUSAL.SELF_CITATION_REFUSED,
      'self-citation is not a federation event; use local audit chain')
  }

  const store = ctx.localReceiptStore
  if (!store || typeof store.exists !== 'function') {
    return refuse(500, XREF_REFUSAL.LEDGER_UNAVAILABLE,
      'local receipt store not configured')
  }
  if (!store.exists(local_receipt_id)) {
    return refuse(404, XREF_REFUSAL.UNKNOWN_LOCAL_RECEIPT,
      `local receipt "${local_receipt_id}" not found in local store`)
  }

  const dir = resolveXrefDir(ctx.fedDir, authedPeer.peer_id)
  ensureLedgerDir(dir)
  const out = outboundPath(ctx.fedDir, authedPeer.peer_id)

  const rows = readJsonl(out)
  const candidate = {
    schema: XREF_SCHEMA,
    citation_id: newCitationId(),
    self_id: ctx.self_id,
    peer_id: authedPeer.peer_id,
    local_receipt_id,
    peer_receipt_url,
    peer_receipt_digest,
    peer_receipt_issued_at_ms,
    memo: memo || null,
    issued_at_ms: nowMs,
    issued_at_iso: new Date(nowMs).toISOString(),
    doctrine_ref: DOCTRINE_REF,
  }

  const dup = isOutboundDuplicate(rows, candidate)
  if (dup) {
    return refuse(409, XREF_REFUSAL.DUPLICATE_CITATION,
      'citation already exists for this (receipt, url, digest) triple',
      { existing_citation_id: dup.citation_id })
  }

  try {
    appendJsonl(out, candidate)
  } catch (e) {
    return refuse(500, XREF_REFUSAL.LEDGER_UNAVAILABLE,
      `failed to append cross-citation: ${e.message || e}`)
  }

  return json(200, {
    ok: true,
    schema: XREF_SCHEMA,
    doctrine_ref: DOCTRINE_REF,
    citation_id: candidate.citation_id,
    self_id: candidate.self_id,
    peer_id: candidate.peer_id,
    local_receipt_id: candidate.local_receipt_id,
    peer_receipt_url: candidate.peer_receipt_url,
    peer_receipt_digest: candidate.peer_receipt_digest,
    peer_receipt_issued_at_ms: candidate.peer_receipt_issued_at_ms,
    memo: candidate.memo,
    issued_at_ms: candidate.issued_at_ms,
    issued_at_iso: candidate.issued_at_iso,
  })
}

export async function handleResolve({
  queryString, authedPeer, sessions, ctx, nowMs = Date.now(),
}) {
  const s = sessionLookup(sessions, ctx.session_id,
    authedPeer.peer_id, authedPeer.fingerprint, nowMs)
  if (s.refused) {
    return refuse(s.refused === XREF_REFUSAL.STALE_SESSION ? 401 : 403,
      s.refused, s.detail)
  }

  const q = parseQuery(queryString)
  const byReceipt = q.local_receipt_id
  const byUrl = q.peer_receipt_url
  if (!byReceipt && !byUrl) {
    return refuse(400, REFUSAL.MALFORMED_REQUEST,
      'one of local_receipt_id or peer_receipt_url required')
  }
  if (byReceipt && !isValidLocalReceiptId(byReceipt)) {
    return refuse(400, REFUSAL.MALFORMED_REQUEST,
      'local_receipt_id is not receipt-safe')
  }
  if (byUrl && !isValidPeerUrl(byUrl)) {
    return refuse(400, XREF_REFUSAL.URL_FORMAT,
      'peer_receipt_url is not an https:// URL')
  }

  const out = outboundPath(ctx.fedDir, authedPeer.peer_id)
  const inb = inboundPath(ctx.fedDir, authedPeer.peer_id)
  const outRows = readJsonl(out)
  const inbRows = readJsonl(inb)

  const matchesOut = outRows.filter(r =>
    (byReceipt ? r.local_receipt_id === byReceipt : true) &&
    (byUrl     ? r.peer_receipt_url  === byUrl     : true)
  )
  const matchesIn = inbRows.filter(r =>
    (byReceipt ? r.local_receipt_id === byReceipt : true) &&
    (byUrl     ? r.peer_citation_url === byUrl    : true)
  )

  return json(200, {
    ok: true,
    schema: XREF_RESOLVE_SCHEMA,
    doctrine_ref: DOCTRINE_REF,
    query: { local_receipt_id: byReceipt || null, peer_receipt_url: byUrl || null },
    peer_id: authedPeer.peer_id,
    outbound_citations: matchesOut,
    inbound_back_links: matchesIn,
  })
}

export async function handleIndex({
  queryString, authedPeer, sessions, ctx, nowMs = Date.now(),
}) {
  const s = sessionLookup(sessions, ctx.session_id,
    authedPeer.peer_id, authedPeer.fingerprint, nowMs)
  if (s.refused) {
    return refuse(s.refused === XREF_REFUSAL.STALE_SESSION ? 401 : 403,
      s.refused, s.detail)
  }

  const q = parseQuery(queryString)
  let limit = q.limit ? Number.parseInt(q.limit, 10) : DEFAULT_INDEX_PAGE_SIZE
  if (!Number.isFinite(limit) || limit <= 0) limit = DEFAULT_INDEX_PAGE_SIZE
  if (limit > MAX_INDEX_PAGE_SIZE) limit = MAX_INDEX_PAGE_SIZE

  let cursor = 0
  if (q.cursor) {
    const c = Number.parseInt(q.cursor, 10)
    if (!Number.isFinite(c) || c < 0) {
      return refuse(400, XREF_REFUSAL.OUT_OF_RANGE,
        'cursor must be a non-negative integer')
    }
    cursor = c
  }

  const out = outboundPath(ctx.fedDir, authedPeer.peer_id)
  const rows = readJsonl(out)
  const page = rows.slice(cursor, cursor + limit)
  const nextCursor = (cursor + limit < rows.length) ? String(cursor + limit) : null

  return json(200, {
    ok: true,
    schema: XREF_INDEX_SCHEMA,
    doctrine_ref: DOCTRINE_REF,
    self_id: ctx.self_id,
    peer_id: authedPeer.peer_id,
    page_size: page.length,
    next_cursor: nextCursor,
    total_count_class: rows.length === 0 ? '0'
      : rows.length < 10 ? '1-9'
      : rows.length < 100 ? '10-99'
      : rows.length < 1000 ? '100-999'
      : '1000+',
    citations: page,
  })
}

export async function handleAttest({
  bodyText, authedPeer, sessions, ctx, nowMs = Date.now(),
}) {
  const s = sessionLookup(sessions, ctx.session_id,
    authedPeer.peer_id, authedPeer.fingerprint, nowMs)
  if (s.refused) {
    return refuse(s.refused === XREF_REFUSAL.STALE_SESSION ? 401 : 403,
      s.refused, s.detail)
  }

  const [body, parseErr] = safeParseJSON(bodyText)
  if (parseErr) return refuse(400, REFUSAL.MALFORMED_REQUEST, parseErr)
  if (!body || typeof body !== 'object') {
    return refuse(400, REFUSAL.MALFORMED_REQUEST, 'body must be a JSON object')
  }

  const {
    peer_citation_id,
    peer_citation_url,
    local_receipt_id,
    claimed_local_digest,
    issued_at_ms,
  } = body

  if (typeof peer_citation_id !== 'string' || peer_citation_id.length === 0
      || peer_citation_id.length > MAX_RECEIPT_ID_LEN
      || /[\x00-\x1f\x7f]/.test(peer_citation_id)) {
    return refuse(400, REFUSAL.MALFORMED_REQUEST,
      'peer_citation_id must be a non-empty printable string')
  }
  if (!isValidPeerUrl(peer_citation_url)) {
    return refuse(400, XREF_REFUSAL.URL_FORMAT,
      'peer_citation_url must be an https:// URL')
  }
  if (!isValidLocalReceiptId(local_receipt_id)) {
    return refuse(400, REFUSAL.MALFORMED_REQUEST,
      'local_receipt_id must be receipt-safe')
  }
  if (!isValidDigest(claimed_local_digest)) {
    return refuse(400, XREF_REFUSAL.DIGEST_FORMAT,
      'claimed_local_digest must match sha256:<64-hex-lowercase>')
  }
  if (typeof issued_at_ms !== 'number' || !Number.isFinite(issued_at_ms)
      || issued_at_ms < 0) {
    return refuse(400, REFUSAL.MALFORMED_REQUEST,
      'issued_at_ms must be a non-negative finite number')
  }

  if (isSelfCitation(ctx.self_id, authedPeer.peer_id)) {
    return refuse(403, XREF_REFUSAL.SELF_CITATION_REFUSED,
      'self-attestation is not a federation event')
  }

  const store = ctx.localReceiptStore
  if (!store || typeof store.read !== 'function') {
    return refuse(500, XREF_REFUSAL.LEDGER_UNAVAILABLE,
      'local receipt store not configured')
  }
  const r = store.read(local_receipt_id)
  if (!r) {
    return refuse(404, XREF_REFUSAL.UNKNOWN_LOCAL_RECEIPT,
      `local receipt "${local_receipt_id}" not found; cannot verify peer attestation`)
  }
  // Verify digest. We will NOT store a back-link to a receipt whose digest
  // we cannot confirm — that would let a peer falsely claim citation of a
  // receipt that doesn't exist or has different content on our side.
  const ours = Buffer.from(r.digest, 'utf8')
  const theirs = Buffer.from(claimed_local_digest, 'utf8')
  let digestOk = false
  if (ours.length === theirs.length) {
    digestOk = timingSafeEqual(ours, theirs)
  }
  if (!digestOk) {
    return refuse(409, XREF_REFUSAL.DIGEST_MISMATCH,
      'claimed_local_digest does not match the digest of the named local receipt',
      { local_digest: r.digest })
  }

  const dir = resolveXrefDir(ctx.fedDir, authedPeer.peer_id)
  ensureLedgerDir(dir)
  const inb = inboundPath(ctx.fedDir, authedPeer.peer_id)
  const rows = readJsonl(inb)

  const candidate = {
    schema: XREF_BACK_LINK_SCHEMA,
    back_link_id: newBackLinkId(),
    self_id: ctx.self_id,
    peer_id: authedPeer.peer_id,
    peer_citation_id,
    peer_citation_url,
    local_receipt_id,
    local_digest_verified: r.digest,
    peer_issued_at_ms: issued_at_ms,
    received_at_ms: nowMs,
    received_at_iso: new Date(nowMs).toISOString(),
    doctrine_ref: DOCTRINE_REF,
  }

  const dup = isInboundDuplicate(rows, candidate)
  if (dup) {
    return refuse(409, XREF_REFUSAL.DUPLICATE_BACK_LINK,
      'back-link already exists for this (peer_citation_id, url, local_receipt_id) triple',
      { existing_back_link_id: dup.back_link_id })
  }

  try {
    appendJsonl(inb, candidate)
  } catch (e) {
    return refuse(500, XREF_REFUSAL.LEDGER_UNAVAILABLE,
      `failed to append back-link: ${e.message || e}`)
  }

  return json(200, {
    ok: true,
    schema: XREF_BACK_LINK_SCHEMA,
    doctrine_ref: DOCTRINE_REF,
    back_link_id: candidate.back_link_id,
    verified: true,
    local_receipt_id: candidate.local_receipt_id,
    local_digest_verified: candidate.local_digest_verified,
    peer_citation_id: candidate.peer_citation_id,
    peer_citation_url: candidate.peer_citation_url,
    received_at_ms: candidate.received_at_ms,
    received_at_iso: candidate.received_at_iso,
  })
}

// ---- public request handler -----------------------------------------------
//
// Mounted alongside handshake.mjs and state-brief.mjs. The dispatcher has
// already authenticated the peer (mTLS + trusted-peers fingerprint). We
// re-validate session + capability per request — defense in depth, and the
// gateway can route us straight from the URL without needing a second auth
// pass.

export async function handleCrossReceiptRequest({
  method,
  url,
  headers,
  bodyText,
  authedPeer,            // { peer_id, fingerprint } from handshake.mjs
  sessions,              // state.sessions Map from handshake.mjs
  ctx,                   // { self_id, fedDir, localReceiptStore }
  nowMs = Date.now(),
} = {}) {
  if (!authedPeer || !authedPeer.peer_id) {
    return refuse(401, REFUSAL.MISSING_CLIENT_CERT,
      'cross-receipt requires authenticated, trusted peer')
  }
  if (!ctx || typeof ctx.self_id !== 'string' || !ctx.fedDir) {
    return refuse(500, XREF_REFUSAL.LEDGER_UNAVAILABLE,
      'cross-receipt ctx not configured (need self_id + fedDir)')
  }

  const pathOnly = (url || '').split('?')[0]
  const qs = (url || '').includes('?') ? (url.split('?')[1] || '') : ''
  const session_id = pickSessionId({ headers, queryString: qs })
  const callCtx = Object.freeze({ ...ctx, session_id })

  if (method === 'POST' && pathOnly === XREF_PATH_CITE) {
    return handleCite({ bodyText, authedPeer, sessions, ctx: callCtx, nowMs })
  }
  if (method === 'GET' && pathOnly === XREF_PATH_RESOLVE) {
    return handleResolve({ queryString: qs, authedPeer, sessions, ctx: callCtx, nowMs })
  }
  if (method === 'GET' && pathOnly === XREF_PATH_INDEX) {
    return handleIndex({ queryString: qs, authedPeer, sessions, ctx: callCtx, nowMs })
  }
  if (method === 'POST' && pathOnly === XREF_PATH_ATTEST) {
    return handleAttest({ bodyText, authedPeer, sessions, ctx: callCtx, nowMs })
  }

  if (pathOnly.startsWith('/v1/federation/receipt-xref/')) {
    return refuse(404, 'not_found',
      `${method} ${pathOnly} is not a known cross-receipt route`)
  }

  return refuse(404, 'not_found', `${method} ${url}`)
}

// ---- mount helper ----------------------------------------------------------
//
// Mirrors state-brief.mjs's pattern. A gateway that already runs
// handshake.mjs can fold these four routes in with a single registration.

export function mountCrossReceiptRoutes({
  fedDir,
  self_id,
  localReceiptStore,
  sessions,
  authPeerFromCert,   // (peerCertInfo) -> { peer_id, fingerprint } | null
}) {
  if (typeof self_id !== 'string' || !self_id.length) {
    throw Object.assign(new Error('mountCrossReceiptRoutes: self_id required'),
      { code: REFUSAL.MALFORMED_REQUEST })
  }
  if (!localReceiptStore || typeof localReceiptStore.exists !== 'function'
      || typeof localReceiptStore.read !== 'function') {
    throw Object.assign(
      new Error('mountCrossReceiptRoutes: localReceiptStore { exists, read } required'),
      { code: XREF_REFUSAL.LEDGER_UNAVAILABLE })
  }
  if (typeof authPeerFromCert !== 'function') {
    throw Object.assign(
      new Error('mountCrossReceiptRoutes: authPeerFromCert callback required'),
      { code: REFUSAL.MALFORMED_REQUEST })
  }
  const FED_DIR = resolveFederationDir(fedDir)

  return {
    schema: XREF_SCHEMA,
    doctrine_ref: DOCTRINE_REF,
    paths: [XREF_PATH_CITE, XREF_PATH_RESOLVE, XREF_PATH_INDEX, XREF_PATH_ATTEST],
    async handle({ method, url, headers, bodyText, peerCertInfo, nowMs }) {
      const authedPeer = authPeerFromCert(peerCertInfo)
      if (!authedPeer) {
        return refuse(401, REFUSAL.MISSING_CLIENT_CERT,
          'cross-receipt requires authenticated, trusted peer')
      }
      return handleCrossReceiptRequest({
        method, url, headers, bodyText, authedPeer, sessions,
        ctx: { self_id, fedDir: FED_DIR, localReceiptStore },
        nowMs: nowMs || Date.now(),
      })
    },
  }
}
