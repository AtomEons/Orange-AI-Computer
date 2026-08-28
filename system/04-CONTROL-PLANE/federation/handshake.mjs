// handshake.mjs — Federation handshake daemon (Bun :7490, loopback by default).
//
// Two-instance mutual-TLS handshake for the AtomEons Federation Triumvirate
// (doctrine: C:\AtomEons\orangebox\docs\FEDERATION_TRIUMVIRATE_DOCTRINE.md,
// disclosure ID ATOM-FED-TRIUMVIRATE-v1-2026-0617).
//
// Each Orange5 instance keeps a sovereign Mom's-Law / receipts / 27-guardrails
// boundary. The Federation lane does NOT override another instance's local
// authority — it only exchanges identity, capability, time-sync, and schema
// version so the doctrine's Trilogy/Triumvirate adjudication path can address
// peer instances by stable id with a verified channel.
//
// Standing law enforced by this file:
//   1. mTLS is REQUIRED. Plain HTTP is refused at bind time.
//   2. The local instance only trusts peers whose presented client cert
//      fingerprint is listed in ./trusted-peers.json. Unknown / untrusted
//      peers are refused — TLS layer rejects unknown CA; application layer
//      double-checks fingerprint against the allow-list.
//   3. Schema versions MUST match exactly. A peer on a different
//      FEDERATION_SCHEMA_VERSION is refused (drift kills receipts).
//   4. Clock skew > MAX_CLOCK_SKEW_MS is refused (NTP responsibility is the
//      operator's; we just refuse to federate across a broken clock).
//   5. No Mom's-Law override. There is no endpoint here that mutates local
//      receipts, gates, dividend logic, or guardrails. Federation is
//      read-only state-brief + cross-reference; lease delegation is a
//      separate, gated path and even there, the local human-final-stop
//      remains reachable.
//
// Per-pair certs:
//   The operator generates a CA per federation pair (offline, e.g. using
//   `openssl` on an air-gapped key host) and writes:
//     <FED_DIR>/certs/ca.pem               (peer CA root we trust)
//     <FED_DIR>/certs/server.pem           (our own cert, leaf)
//     <FED_DIR>/certs/server.key           (our own private key, 0600)
//     <FED_DIR>/certs/client.pem           (our own client cert, used when we
//                                            initiate outbound federation)
//     <FED_DIR>/certs/client.key           (our own client private key, 0600)
//     <FED_DIR>/trusted-peers.json         (allow-list, see schema below)
//
//   FED_DIR defaults to the directory containing this file. Override with
//   env FEDERATION_DIR.
//
// trusted-peers.json schema (strict — extra keys are tolerated but ignored):
//   {
//     "schema": "atomeons.federation.trusted-peers.v1",
//     "self_id": "orange5-alpha@atomeons",
//     "peers": [
//       {
//         "peer_id": "orange5-bravo@atomeons",
//         "cert_sha256": "AB:CD:...:EF",   // SHA-256 fingerprint, hex w/ colons
//         "capabilities_required": ["state-brief", "receipt-xref"],
//         "lease_delegation_allowed": false
//       }
//     ]
//   }
//
// Endpoints (all over mTLS):
//   GET  /healthz       — liveness, returns local self_id, schema, uptime
//                         and the list of currently-trusted peer ids (no
//                         secrets). Loopback-only without client cert.
//   POST /handshake     — peer-initiated handshake. Body:
//                           { peer_id, schema_version, capabilities[],
//                             peer_now_ms, nonce }
//                         Response:
//                           { ok, self_id, schema_version, capabilities[],
//                             self_now_ms, accepted_capabilities[],
//                             skew_ms, session_id }
//                         Refuses with structured reason if any check fails.
//   GET  /capabilities  — returns the local capability list. Authenticated
//                         peer required.
//   POST /time-sync     — body { peer_now_ms, nonce }, returns
//                           { self_now_ms, skew_ms, ok }. Pure read-only
//                           clock-exchange — does NOT mutate local time.
//
// What this daemon explicitly does NOT do (Federation Triumvirate scope):
//   - It does not run gates, gauntlets, or receipts. It does not write into
//     the local receipt store. Federation cross-reference receipts are
//     written by higher-level code that calls this daemon; this file is
//     pure protocol substrate.
//   - It does not perform Trilogy or Triumvirate vote arithmetic. That
//     lives in workflows/wave3-25-federation-triumvirate.workflow.mjs and
//     downstream adjudicator code.
//   - It does not delegate leases on its own. Lease delegation is a
//     separate authenticated endpoint that the operator (or operator-signed
//     instrument) must call through; refusing it is the safe default and is
//     the current behavior of this file (501 NOT_IMPLEMENTED on /lease/*).
//
// Runtime contract:
//   Bun >= 1.0 OR Node 20+ (we feature-detect Bun.serve and fall back to
//   node:https for portability). mTLS is enforced in both runtimes.
//
//   The daemon binds 127.0.0.1 by default; the operator can override with
//   env FEDERATION_BIND to (e.g.) the VPN-internal interface address. We
//   refuse to bind 0.0.0.0 unless env FEDERATION_ALLOW_PUBLIC_BIND=1 is
//   ALSO set — public exposure is a deliberate operator act, not a
//   default.

import { fileURLToPath } from 'node:url'
import { readFileSync, existsSync } from 'node:fs'
import { createHash, randomBytes } from 'node:crypto'
import { dirname, resolve as resolvePath, join as joinPath } from 'node:path'
import { createServer as createHttpsServer } from 'node:https'

// ---- constants -------------------------------------------------------------

export const FEDERATION_SCHEMA_VERSION = 'atomeons.federation.v1'
export const HOST_DEFAULT = '127.0.0.1'
export const PORT_DEFAULT = 7490
export const MAX_CLOCK_SKEW_MS = 5_000  // 5s. Beyond this, refuse.
export const BOOTED_AT = Date.now()
export const LOCAL_CAPABILITIES = Object.freeze([
  'state-brief',       // share a federated state summary (read-only)
  'receipt-xref',      // cross-reference receipt hashes between instances
  'time-sync',         // exchange wall-clock for skew detection
  'capabilities',      // self-describe
])

// Refusal reason codes (stable; consumers may switch on these).
export const REFUSAL = Object.freeze({
  SCHEMA_MISMATCH: 'schema_mismatch',
  UNKNOWN_PEER: 'unknown_peer',
  CERT_FINGERPRINT_MISMATCH: 'cert_fingerprint_mismatch',
  CLOCK_SKEW: 'clock_skew',
  MISSING_CLIENT_CERT: 'missing_client_cert',
  MALFORMED_REQUEST: 'malformed_request',
  CAPABILITY_NOT_OFFERED: 'capability_not_offered',
  PUBLIC_BIND_REFUSED: 'public_bind_refused',
  CERT_FILES_MISSING: 'cert_files_missing',
  NOT_IMPLEMENTED: 'not_implemented',
})

// ---- config / cert loading -------------------------------------------------

const HERE = (() => {
  try { return dirname(fileURLToPath(import.meta.url)) }
  catch { return process.cwd() }
})()

export function resolveFederationDir(envOverride) {
  const fromEnv = envOverride || process.env.FEDERATION_DIR
  return fromEnv ? resolvePath(fromEnv) : HERE
}

function readFileStrict(p, label) {
  if (!existsSync(p)) {
    const e = new Error(`federation: ${label} missing at ${p}`)
    e.code = REFUSAL.CERT_FILES_MISSING
    throw e
  }
  return readFileSync(p)
}

export function loadTLSMaterial(fedDir) {
  const certsDir = joinPath(fedDir, 'certs')
  return {
    ca: readFileStrict(joinPath(certsDir, 'ca.pem'), 'ca.pem'),
    cert: readFileStrict(joinPath(certsDir, 'server.pem'), 'server.pem'),
    key: readFileStrict(joinPath(certsDir, 'server.key'), 'server.key'),
  }
}

export function loadTrustedPeers(fedDir) {
  const p = joinPath(fedDir, 'trusted-peers.json')
  if (!existsSync(p)) {
    const e = new Error(`federation: trusted-peers.json missing at ${p}`)
    e.code = REFUSAL.CERT_FILES_MISSING
    throw e
  }
  let raw
  try { raw = JSON.parse(readFileSync(p, 'utf8')) }
  catch (parseErr) {
    const e = new Error(`federation: trusted-peers.json invalid JSON: ${parseErr.message}`)
    e.code = REFUSAL.MALFORMED_REQUEST
    throw e
  }
  if (!raw || raw.schema !== 'atomeons.federation.trusted-peers.v1') {
    const e = new Error('federation: trusted-peers.json has wrong schema')
    e.code = REFUSAL.SCHEMA_MISMATCH
    throw e
  }
  if (typeof raw.self_id !== 'string' || !raw.self_id.length) {
    const e = new Error('federation: trusted-peers.json missing self_id')
    e.code = REFUSAL.MALFORMED_REQUEST
    throw e
  }
  const peers = Array.isArray(raw.peers) ? raw.peers : []
  // Normalise fingerprints: uppercase, no whitespace; allow colons or hex-only.
  const byFingerprint = new Map()
  const byPeerId = new Map()
  for (const peer of peers) {
    if (!peer || typeof peer !== 'object') continue
    if (typeof peer.peer_id !== 'string' || typeof peer.cert_sha256 !== 'string') continue
    const fp = normalizeFingerprint(peer.cert_sha256)
    const entry = Object.freeze({
      peer_id: peer.peer_id,
      cert_sha256: fp,
      capabilities_required: Array.isArray(peer.capabilities_required)
        ? Object.freeze(peer.capabilities_required.slice())
        : Object.freeze([]),
      lease_delegation_allowed: peer.lease_delegation_allowed === true,
    })
    byFingerprint.set(fp, entry)
    byPeerId.set(peer.peer_id, entry)
  }
  return {
    self_id: raw.self_id,
    peers: Object.freeze({ byFingerprint, byPeerId, list: Object.freeze(peers.slice()) }),
  }
}

export function normalizeFingerprint(s) {
  return String(s).toUpperCase().replace(/[^0-9A-F]/g, '').match(/.{2}/g)?.join(':') || ''
}

export function fingerprintOfPEM(pemBuffer) {
  // pem -> DER -> sha256. node:tls peerCertificate.raw gives us DER directly,
  // but for trust-list parsing we accept either DER or PEM input.
  let der = pemBuffer
  const text = pemBuffer.toString('utf8')
  const m = text.match(/-----BEGIN CERTIFICATE-----([\s\S]+?)-----END CERTIFICATE-----/)
  if (m) der = Buffer.from(m[1].replace(/\s+/g, ''), 'base64')
  return createHash('sha256').update(der).digest('hex').toUpperCase().match(/.{2}/g).join(':')
}

// ---- protocol helpers ------------------------------------------------------

function json(status, body) {
  return {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8' },
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

function safeParseJSON(text) {
  if (!text || !text.length) return [null, null]
  try { return [JSON.parse(text), null] }
  catch (e) { return [null, e.message || String(e)] }
}

function newSessionId() {
  return randomBytes(16).toString('hex')
}

// ---- request handlers ------------------------------------------------------

// State is per-process. The trust list is immutable from a request's
// perspective; reloads happen at boot or via a deliberate operator restart.
function buildState({ self_id, peers, capabilities }) {
  return {
    self_id,
    peers,
    capabilities: Object.freeze(capabilities.slice()),
    sessions: new Map(),    // session_id -> { peer_id, opened_at, fingerprint }
    request_count: 0,
    handshake_count: 0,
    refusal_count: 0,
    last_refusal: null,
  }
}

function recordRefusal(state, code, detail) {
  state.refusal_count += 1
  state.last_refusal = { code, detail, at: new Date().toISOString() }
}

// Authenticate the peer from its TLS client certificate. Returns the matched
// trust-list entry or { refused: <code> }.
function authPeer(state, peerCertInfo) {
  if (!peerCertInfo || !peerCertInfo.fingerprint) {
    return { refused: REFUSAL.MISSING_CLIENT_CERT }
  }
  const fp = normalizeFingerprint(peerCertInfo.fingerprint)
  const entry = state.peers.byFingerprint.get(fp)
  if (!entry) return { refused: REFUSAL.UNKNOWN_PEER, fingerprint: fp }
  return { entry, fingerprint: fp }
}

// peerCertInfo shape: { fingerprint: "AB:CD:..." } — provided by the
// transport layer. The handlers do NOT trust raw HTTP headers for identity.
export async function handleRequest(state, { method, url, bodyText, peerCertInfo, isLoopback }) {
  state.request_count += 1

  if (method === 'GET' && url === '/healthz') {
    // Loopback may probe without a client cert (operator's own supervisor).
    // Remote callers must present a trusted client cert even for healthz.
    if (!isLoopback) {
      const a = authPeer(state, peerCertInfo)
      if (a.refused) { recordRefusal(state, a.refused, '/healthz'); return refuse(401, a.refused, '/healthz requires authenticated peer when not on loopback') }
    }
    return json(200, {
      ok: true,
      service: 'federation-handshake',
      self_id: state.self_id,
      schema_version: FEDERATION_SCHEMA_VERSION,
      uptime_ms: Date.now() - BOOTED_AT,
      now_ms: Date.now(),
      capabilities: state.capabilities,
      trusted_peer_ids: Array.from(state.peers.byPeerId.keys()),
      request_count: state.request_count,
      handshake_count: state.handshake_count,
      refusal_count: state.refusal_count,
      last_refusal: state.last_refusal,
    })
  }

  if (method === 'POST' && url === '/handshake') {
    const a = authPeer(state, peerCertInfo)
    if (a.refused) {
      recordRefusal(state, a.refused, '/handshake')
      return refuse(401, a.refused, 'handshake requires authenticated, trusted peer', { fingerprint: a.fingerprint })
    }

    const [body, parseErr] = safeParseJSON(bodyText)
    if (parseErr) {
      recordRefusal(state, REFUSAL.MALFORMED_REQUEST, parseErr)
      return refuse(400, REFUSAL.MALFORMED_REQUEST, parseErr)
    }
    if (!body || typeof body !== 'object') {
      recordRefusal(state, REFUSAL.MALFORMED_REQUEST, 'body required')
      return refuse(400, REFUSAL.MALFORMED_REQUEST, 'body must be a JSON object')
    }

    const { peer_id, schema_version, capabilities, peer_now_ms, nonce } = body
    if (typeof peer_id !== 'string' || typeof schema_version !== 'string'
        || !Array.isArray(capabilities) || typeof peer_now_ms !== 'number'
        || typeof nonce !== 'string') {
      recordRefusal(state, REFUSAL.MALFORMED_REQUEST, 'missing fields')
      return refuse(400, REFUSAL.MALFORMED_REQUEST,
        'expected { peer_id, schema_version, capabilities[], peer_now_ms, nonce }')
    }

    // Identity binding: the peer_id claimed in the body MUST match the
    // peer_id we have keyed against this client certificate. This stops a
    // peer with a valid cert from impersonating a different federation
    // member.
    if (a.entry.peer_id !== peer_id) {
      recordRefusal(state, REFUSAL.CERT_FINGERPRINT_MISMATCH,
        `body peer_id=${peer_id} does not match cert peer_id=${a.entry.peer_id}`)
      return refuse(403, REFUSAL.CERT_FINGERPRINT_MISMATCH,
        'client certificate identity does not match claimed peer_id')
    }

    if (schema_version !== FEDERATION_SCHEMA_VERSION) {
      recordRefusal(state, REFUSAL.SCHEMA_MISMATCH,
        `peer=${schema_version} self=${FEDERATION_SCHEMA_VERSION}`)
      return refuse(409, REFUSAL.SCHEMA_MISMATCH,
        `peer schema ${schema_version} does not match self ${FEDERATION_SCHEMA_VERSION}`,
        { self_schema_version: FEDERATION_SCHEMA_VERSION })
    }

    const self_now_ms = Date.now()
    const skew_ms = self_now_ms - peer_now_ms
    if (Math.abs(skew_ms) > MAX_CLOCK_SKEW_MS) {
      recordRefusal(state, REFUSAL.CLOCK_SKEW, `skew=${skew_ms}ms`)
      return refuse(409, REFUSAL.CLOCK_SKEW,
        `clock skew ${skew_ms}ms exceeds max ${MAX_CLOCK_SKEW_MS}ms`,
        { skew_ms, self_now_ms, peer_now_ms, max_skew_ms: MAX_CLOCK_SKEW_MS })
    }

    // Capability intersection. The peer asks for some set; we offer some
    // set; the session can use the intersection. If the trust list demands
    // capabilities the peer doesn't offer, refuse — the trust-list author
    // said this peer must be able to do X, and X isn't on offer.
    const offered = new Set(capabilities.filter(c => typeof c === 'string'))
    const intersection = state.capabilities.filter(c => offered.has(c))
    for (const required of a.entry.capabilities_required) {
      if (!offered.has(required)) {
        recordRefusal(state, REFUSAL.CAPABILITY_NOT_OFFERED,
          `peer did not offer required capability ${required}`)
        return refuse(409, REFUSAL.CAPABILITY_NOT_OFFERED,
          `peer must offer capability "${required}" per trust list`,
          { missing_capability: required })
      }
    }

    const session_id = newSessionId()
    state.sessions.set(session_id, {
      peer_id,
      opened_at: new Date().toISOString(),
      fingerprint: a.fingerprint,
      negotiated_capabilities: intersection,
    })
    state.handshake_count += 1

    return json(200, {
      ok: true,
      self_id: state.self_id,
      peer_id,
      schema_version: FEDERATION_SCHEMA_VERSION,
      capabilities: state.capabilities,
      accepted_capabilities: intersection,
      self_now_ms,
      peer_now_ms,
      skew_ms,
      session_id,
      nonce_echo: nonce,
      doctrine_ref: 'ATOM-FED-TRIUMVIRATE-v1-2026-0617',
    })
  }

  if (method === 'GET' && url === '/capabilities') {
    const a = authPeer(state, peerCertInfo)
    if (a.refused) {
      recordRefusal(state, a.refused, '/capabilities')
      return refuse(401, a.refused, '/capabilities requires authenticated peer')
    }
    return json(200, {
      ok: true,
      self_id: state.self_id,
      schema_version: FEDERATION_SCHEMA_VERSION,
      capabilities: state.capabilities,
    })
  }

  if (method === 'POST' && url === '/time-sync') {
    const a = authPeer(state, peerCertInfo)
    if (a.refused) {
      recordRefusal(state, a.refused, '/time-sync')
      return refuse(401, a.refused, '/time-sync requires authenticated peer')
    }
    const [body, parseErr] = safeParseJSON(bodyText)
    if (parseErr || !body || typeof body !== 'object'
        || typeof body.peer_now_ms !== 'number'
        || typeof body.nonce !== 'string') {
      recordRefusal(state, REFUSAL.MALFORMED_REQUEST, '/time-sync body')
      return refuse(400, REFUSAL.MALFORMED_REQUEST,
        'expected { peer_now_ms, nonce }')
    }
    const self_now_ms = Date.now()
    const skew_ms = self_now_ms - body.peer_now_ms
    return json(200, {
      ok: Math.abs(skew_ms) <= MAX_CLOCK_SKEW_MS,
      self_now_ms,
      peer_now_ms: body.peer_now_ms,
      skew_ms,
      max_skew_ms: MAX_CLOCK_SKEW_MS,
      nonce_echo: body.nonce,
    })
  }

  // Lease delegation endpoints are reserved and explicitly NOT implemented
  // in this file — they require operator-signed instruments and live in a
  // separate, audited path. We answer 501 to be honest about the surface.
  if (url.startsWith('/lease/')) {
    return refuse(501, REFUSAL.NOT_IMPLEMENTED,
      'lease delegation is not implemented in the handshake daemon; ' +
      'see workflows/wave3-25-federation-triumvirate.workflow.mjs')
  }

  return refuse(404, 'not_found', `${method} ${url}`)
}

// ---- server bootstrap ------------------------------------------------------

function pickBindHost() {
  const envHost = process.env.FEDERATION_BIND
  if (!envHost) return HOST_DEFAULT
  if (envHost === '0.0.0.0' && process.env.FEDERATION_ALLOW_PUBLIC_BIND !== '1') {
    const e = new Error(
      'federation: refusing to bind 0.0.0.0 without FEDERATION_ALLOW_PUBLIC_BIND=1'
    )
    e.code = REFUSAL.PUBLIC_BIND_REFUSED
    throw e
  }
  return envHost
}

function isLoopbackAddr(addr) {
  if (!addr) return false
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

// peerCertInfo extraction is runtime-specific.
function nodePeerCertInfo(socket) {
  if (!socket || typeof socket.getPeerCertificate !== 'function') return null
  const c = socket.getPeerCertificate(true)
  if (!c || !c.raw) return null
  const fingerprint = createHash('sha256').update(c.raw).digest('hex')
    .toUpperCase().match(/.{2}/g).join(':')
  return { fingerprint, subject: c.subject, issuer: c.issuer }
}

export async function startServer({
  port = PORT_DEFAULT,
  host,
  fedDir,
} = {}) {
  const FED_DIR = resolveFederationDir(fedDir)
  const trust = loadTrustedPeers(FED_DIR)
  const tls = loadTLSMaterial(FED_DIR)
  const state = buildState({
    self_id: trust.self_id,
    peers: trust.peers,
    capabilities: LOCAL_CAPABILITIES,
  })
  const bindHost = host || pickBindHost()

  // We always demand a client cert (mTLS). rejectUnauthorized:true means
  // the TLS layer itself rejects unknown CAs before we even see the
  // request — the application-layer fingerprint check is defense-in-depth.
  const tlsOptions = {
    ca: tls.ca,
    cert: tls.cert,
    key: tls.key,
    requestCert: true,
    rejectUnauthorized: true,
    minVersion: 'TLSv1.3',
  }

  // Prefer Bun if its native serve supports tls + mTLS. As of Bun 1.x, the
  // `tls` option supports `requestCert` / `rejectUnauthorized`. We
  // feature-detect and fall back to node:https otherwise.
  if (typeof globalThis.Bun !== 'undefined' && globalThis.Bun.serve) {
    try {
      const server = globalThis.Bun.serve({
        hostname: bindHost,
        port,
        tls: {
          ca: tls.ca,
          cert: tls.cert,
          key: tls.key,
          requestCert: true,
          rejectUnauthorized: true,
        },
        async fetch(req, srv) {
          const u = new URL(req.url)
          const method = req.method
          const bodyText = (method === 'GET' || method === 'HEAD') ? '' : await req.text()
          // Bun exposes the peer cert on srv.requestIP plus a separate
          // tls API. Different Bun versions surface this differently; we
          // try the documented path and fall back conservatively.
          let peerCertInfo = null
          try {
            const peerCert = typeof srv.getPeerCertificate === 'function'
              ? srv.getPeerCertificate(req)
              : null
            if (peerCert && peerCert.raw) {
              const fingerprint = createHash('sha256').update(peerCert.raw)
                .digest('hex').toUpperCase().match(/.{2}/g).join(':')
              peerCertInfo = { fingerprint }
            }
          } catch { /* fall through; mTLS layer already accepted the peer */ }
          const remoteAddr = srv.requestIP ? srv.requestIP(req)?.address : null
          const r = await handleRequest(state, {
            method, url: u.pathname, bodyText, peerCertInfo,
            isLoopback: isLoopbackAddr(remoteAddr),
          })
          return new Response(r.body, { status: r.status, headers: r.headers })
        },
      })
      return {
        runtime: 'bun',
        url: `https://${bindHost}:${port}`,
        host: bindHost,
        port,
        self_id: state.self_id,
        stop: () => server.stop(true),
        _state: state,
      }
    } catch (bunErr) {
      // If Bun couldn't satisfy mTLS for some reason, fall through to
      // node:https — but be loud about it.
      console.error(JSON.stringify({
        federation: 'bun_tls_fallback',
        reason: String(bunErr && bunErr.message || bunErr),
      }))
    }
  }

  // node:https fallback.
  const server = createHttpsServer(tlsOptions, async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const bodyText = Buffer.concat(chunks).toString('utf8')
    const u = req.url || '/'
    const pathOnly = u.split('?')[0]
    const peerCertInfo = nodePeerCertInfo(req.socket)
    const remoteAddr = req.socket && req.socket.remoteAddress
    const r = await handleRequest(state, {
      method: req.method || 'GET',
      url: pathOnly,
      bodyText,
      peerCertInfo,
      isLoopback: isLoopbackAddr(remoteAddr),
    })
    res.writeHead(r.status, r.headers)
    res.end(r.body)
  })

  // TLS errors at the handshake layer (unknown CA, missing client cert)
  // surface here. Don't crash the daemon on a single bad peer.
  server.on('tlsClientError', (err, _socket) => {
    state.refusal_count += 1
    state.last_refusal = {
      code: 'tls_client_error',
      detail: String(err && err.code || err && err.message || err),
      at: new Date().toISOString(),
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bindHost, () => {
      server.off('error', reject)
      resolve()
    })
  })

  return {
    runtime: 'node',
    url: `https://${bindHost}:${port}`,
    host: bindHost,
    port,
    self_id: state.self_id,
    stop: () => new Promise(r => server.close(() => r())),
    _state: state,
  }
}

// ---- entry point -----------------------------------------------------------

const invokedDirectly = (() => {
  try {
    return process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
  } catch { return false }
})()

if (invokedDirectly) {
  const port = Number(process.env.FEDERATION_PORT || PORT_DEFAULT)
  startServer({ port }).then(handle => {
    console.log(JSON.stringify({
      federation: 'up',
      runtime: handle.runtime,
      url: handle.url,
      self_id: handle.self_id,
      schema_version: FEDERATION_SCHEMA_VERSION,
      doctrine_ref: 'ATOM-FED-TRIUMVIRATE-v1-2026-0617',
    }))
  }).catch(err => {
    console.error(JSON.stringify({
      federation: 'boot_failed',
      error: err.code || 'boot_error',
      detail: String(err.message || err),
    }))
    process.exit(1)
  })
}
