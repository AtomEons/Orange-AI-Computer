// AE OrangeLLM — Federation Triumvirate gateway routes
// Path: 06-ORANGELLM/server/routes/federation.mjs
//
// Doctrine reference:
//   C:\AtomEons\orangebox\docs\FEDERATION_TRIUMVIRATE_DOCTRINE.md
//   Disclosure ID: ATOM-FED-TRIUMVIRATE-v1-2026-0617
//   Operator standing law: each Orange5 instance is sovereign. Federation
//   provides coordination, not subordination. No instance overrides
//   another's Mom's Law, 27 guardrails, Gate 0 LBCE, Human Final Stop, or
//   receipt chain. Cross-instance writes land only in the federation
//   cross-receipt table; never in the local audit chain.
//
// Routes (boundary-gated; see federation-boundary.mjs):
//
//   POST /v1/federation/handshake
//        Body:   { peer_id: str, peer_version: str, capabilities: [str],
//                  nonce: str (base64url, 16+ bytes), timestamp: ISO-8601,
//                  spki_pin: str (sha256 hex of peer leaf SPKI as the
//                  peer asserts it — must match the verified TLS leaf
//                  before we accept) }
//        Auth:   mTLS only. No session id required (this MAKES the session).
//        Returns:{ session_id, local_id, local_version, local_capabilities,
//                  local_spki_pin, accepted_at, expires_at,
//                  receipt_chain_head_link, guardrail_head_link }
//        Refuses: NO_MTLS / PEER_UNAUTH / PIN_MISMATCH / CLOCK_SKEW /
//                 BAD_BODY.
//
//   POST /v1/federation/state-brief
//        Body:   { session_id, ask: [str]   // requested keys, subset of
//                                           // STATE_BRIEF_ALLOWED_KEYS }
//        Auth:   mTLS + session_id.
//        Returns:Sanitized state-brief — routing lane label, receipt chain
//                head link, guardrail head link, current Mom's Law status
//                ("active"|"violated"), federation peer count, last
//                cross-receipt id, sovereign awake/asleep flag. NEVER
//                returns raw memory, flux, secrets, env vars, file paths,
//                or operator material.
//        Refuses: NO_SESSION / BAD_BODY.
//
//   POST /v1/federation/lease
//        Body:   { session_id, lease_id, task_descriptor, expires_at,
//                  scope: { capabilities: [str], max_calls: int,
//                  max_wall_seconds: int }, sovereign_payload_sha256 }
//        Headers: x-ae-fed-sovereign-sig MUST be the ed25519 signature,
//                  base64url, over the canonical-JSON body, verifiable
//                  against the requesting peer's Sovereign pubkey in the
//                  peers file. Without it we refuse with BAD_SIG.
//        Auth:   mTLS + session_id + Sovereign-signed body.
//        Returns:Either { accepted: true, lease_id, accepted_at, expires_at,
//                  local_lease_receipt_id } or
//                { accepted: false, code: FED_REFUSE_LEASE_DECLINED |
//                  FED_REFUSE_SOVEREIGN_LAW, reason, local_receipt_id }.
//                Either outcome appends a receipt — refusal is also a
//                receipt (Mom's Law).
//        Refuses: NO_SESSION / BAD_SIG / BAD_BODY / SOVEREIGN_LAW.
//
//   POST /v1/federation/cross-receipt
//        Body:   { session_id, peer_receipt: { receipt_id, head_link,
//                  signed_by, audit_chain_prev_hash, ts }, summary }
//        Headers: x-ae-fed-sovereign-sig over the canonical-JSON body
//                  (verifies the peer Sovereign signed off on the
//                  cross-reference). Without it we refuse with BAD_SIG.
//        Auth:   mTLS + session_id + Sovereign-signed body.
//        Returns:{ ok: true, local_cross_receipt_id, recorded_at,
//                  local_head_link } — the peer receipt is recorded ONLY in
//                the federation cross-receipt store, NEVER spliced into the
//                local audit chain. Operator-only export tool can later
//                publish a triumvirate receipt that bundles both chains.
//        Refuses: NO_SESSION / BAD_SIG / BAD_BODY.
//
// HTTP shape (mirrors sibling routes receipts.mjs / cobra.mjs):
//   Success: { ...payload }
//   Error:   { error: { code, message, ... }, _ae_http_status: N }

import { createHash, randomBytes, timingSafeEqual, verify as cryptoVerify, createPublicKey } from "node:crypto";
import { promises as fsp } from "node:fs";
import path from "node:path";

import {
  FEDERATION_ALLOWED,
  FEDERATION_PATH_PREFIX,
  isFederationPath,
  isFederationRouteAllowed,
  FED_HEADER_PEER_ID,
  FED_HEADER_SESSION_ID,
  FED_HEADER_SOVEREIGN_SIG,
  FED_REFUSE_NO_MTLS,
  FED_REFUSE_PEER_UNAUTH,
  FED_REFUSE_PIN_MISMATCH,
  FED_REFUSE_NO_SESSION,
  FED_REFUSE_BAD_SIG,
  FED_REFUSE_BAD_BODY,
  FED_REFUSE_CLOCK_SKEW,
  FED_REFUSE_LEASE_DECLINED,
  FED_REFUSE_SOVEREIGN_LAW,
} from "./federation-boundary.mjs";

export {
  FEDERATION_ALLOWED,
  FEDERATION_PATH_PREFIX,
  isFederationPath,
  isFederationRouteAllowed,
};

// ---------------------------------------------------------------------------
// Config — env-bound, never hardcoded.
// ---------------------------------------------------------------------------

// Local instance identity advertised on handshake.
const LOCAL_INSTANCE_ID = process.env.ORANGE5_FED_LOCAL_ID || "orange5-local@atomeons/1.0";
const LOCAL_VERSION = process.env.ORANGE5_FED_LOCAL_VERSION || "1.0.0";
const LOCAL_CAPABILITIES = (process.env.ORANGE5_FED_LOCAL_CAPABILITIES ||
  "state-brief,lease,cross-receipt").split(",").map(s => s.trim()).filter(Boolean);

// Peers file: JSON map of peer_id -> { spki_pin_sha256, sovereign_pubkey_pem,
//   allowed_capabilities, notes }. Hot-reloaded by a watcher that lives at
// server/middleware/federation-peer-watcher.mjs (not authored here).
const PEERS_PATH = process.env.ORANGE5_FED_PEERS_PATH ||
  path.join(process.cwd(), "06-ORANGELLM", "config", "federation-peers.json");

// SPKI pin source for the LOCAL leaf cert — published on handshake so peers
// can pin us in turn. Computed once at module load from
// ORANGE5_FED_LOCAL_SPKI_PIN (hex sha256). If unset, advertised as "unset"
// and peers SHOULD refuse to pin us until set.
const LOCAL_SPKI_PIN = (process.env.ORANGE5_FED_LOCAL_SPKI_PIN || "unset").toLowerCase();

// Federation session lifetime + clock-skew tolerance.
const SESSION_TTL_MS = clampInt(process.env.ORANGE5_FED_SESSION_TTL_MS, 15 * 60_000, 60_000, 60 * 60_000);
const CLOCK_SKEW_TOLERANCE_MS = clampInt(process.env.ORANGE5_FED_CLOCK_SKEW_MS, 60_000, 5_000, 5 * 60_000);

// Local Sovereign signer fingerprint (public — used only in receipts to
// identify which local pubkey is signing cross-receipts). Never the
// private key. Set by the operator at boot.
const LOCAL_SOVEREIGN_FINGERPRINT = process.env.ORANGE5_LOCAL_SOVEREIGN_FP || "ed25519:local:unset";

// Maximum lease scope this instance will EVER grant another peer regardless
// of what the peer requests. Mom's Law: the sovereign of THIS instance
// caps the blast radius.
const LEASE_MAX_CALLS_CAP = clampInt(process.env.ORANGE5_FED_LEASE_MAX_CALLS, 100, 1, 10_000);
const LEASE_MAX_SECONDS_CAP = clampInt(process.env.ORANGE5_FED_LEASE_MAX_SECONDS, 3600, 60, 24 * 3600);
const LEASE_CAPABILITY_ALLOW = (process.env.ORANGE5_FED_LEASE_CAPS ||
  "state-brief,cross-receipt").split(",").map(s => s.trim()).filter(Boolean);

function clampInt(raw, def, lo, hi) {
  const n = Number(raw);
  if (!Number.isFinite(n)) return def;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

// ---------------------------------------------------------------------------
// Sanitized state-brief surface — exhaustive allow-list. Anything not in
// this set is NEVER returned. Keys here MUST be filled by the host server
// via setStateBriefProvider(); the route only exposes what the provider
// supplies among allowed keys.
// ---------------------------------------------------------------------------

export const STATE_BRIEF_ALLOWED_KEYS = Object.freeze([
  "routing_lane",                  // e.g. "reflex"|"heavy"|"hermes"
  "receipt_chain_head_link",       // hex sha256 of latest receipt prev_hash
  "guardrail_head_link",           // hex sha256 of latest guardrail run
  "moms_law_status",               // "active"|"violated"
  "federation_peer_count",         // integer
  "last_cross_receipt_id",         // string|null
  "sovereign_awake",               // boolean
  "instance_id",                   // local instance id
  "instance_version",              // semver
  "ts",                            // server-side ISO timestamp
]);

let _stateBriefProvider = null;
export function setStateBriefProvider(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("setStateBriefProvider expects a function");
  }
  _stateBriefProvider = fn;
}

// Cross-receipt writer — host wires this up so the federation namespace
// never touches the local DB directly. Receives a fully-formed
// cross-receipt object and returns { local_cross_receipt_id, recorded_at,
// local_head_link }. If unset, /cross-receipt refuses with a 503.
let _crossReceiptWriter = null;
export function setCrossReceiptWriter(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("setCrossReceiptWriter expects a function");
  }
  _crossReceiptWriter = fn;
}

// Lease evaluator — host wires this with a synchronous function that
// returns either { accept: true } or { accept: false, code, reason }.
// This is the local Mom's-Law / guardrail gate; federation never bypasses
// it. If unset, /lease refuses every request with SOVEREIGN_LAW.
let _leaseEvaluator = null;
export function setLeaseEvaluator(fn) {
  if (typeof fn !== "function") {
    throw new TypeError("setLeaseEvaluator expects a function");
  }
  _leaseEvaluator = fn;
}

// ---------------------------------------------------------------------------
// Peers registry — in-memory snapshot loaded from disk. The host SHOULD
// install a watcher (server/middleware/federation-peer-watcher.mjs) that
// calls setPeers() on file change. As a fallback, loadPeersFromDisk() is
// available so a cold start without a watcher still works.
// ---------------------------------------------------------------------------

let _peers = Object.create(null);

export function setPeers(map) {
  if (!map || typeof map !== "object") {
    throw new TypeError("setPeers expects an object");
  }
  const next = Object.create(null);
  for (const [peerId, row] of Object.entries(map)) {
    if (!row || typeof row !== "object") continue;
    if (typeof row.spki_pin_sha256 !== "string") continue;
    next[peerId] = {
      spki_pin_sha256: row.spki_pin_sha256.toLowerCase(),
      sovereign_pubkey_pem: typeof row.sovereign_pubkey_pem === "string" ? row.sovereign_pubkey_pem : null,
      allowed_capabilities: Array.isArray(row.allowed_capabilities) ? row.allowed_capabilities.slice() : [],
      notes: typeof row.notes === "string" ? row.notes : null,
    };
  }
  _peers = next;
}

export function getPeer(peerId) {
  if (typeof peerId !== "string") return null;
  return _peers[peerId] || null;
}

export async function loadPeersFromDisk({ peersPath = PEERS_PATH } = {}) {
  try {
    const raw = await fsp.readFile(peersPath, "utf8");
    const parsed = JSON.parse(raw);
    setPeers(parsed);
    return { ok: true, peer_count: Object.keys(_peers).length, peers_path: peersPath };
  } catch (e) {
    return { ok: false, error: e.code || e.message, peers_path: peersPath };
  }
}

// ---------------------------------------------------------------------------
// Session store — in-memory, ephemeral. A federation session is bound to
// (peer_id, spki_pin_sha256) and expires after SESSION_TTL_MS. Restarting
// the server invalidates every session; peers must rehandshake. That is
// intentional — no session survives a sovereign reboot.
// ---------------------------------------------------------------------------

const _sessions = new Map(); // session_id -> { peer_id, spki_pin, created_at, expires_at }

function makeSessionId() {
  return "fedsess_" + randomBytes(18).toString("base64url");
}

function pruneExpiredSessions(nowMs = Date.now()) {
  for (const [id, row] of _sessions.entries()) {
    if (row.expires_at <= nowMs) _sessions.delete(id);
  }
}

export function _testResetFederationState() {
  // Test hook only. Not part of the public protocol.
  _sessions.clear();
  _peers = Object.create(null);
  _stateBriefProvider = null;
  _crossReceiptWriter = null;
  _leaseEvaluator = null;
}

// ---------------------------------------------------------------------------
// HTTP shape helpers (kept identical to sibling routes).
// ---------------------------------------------------------------------------

function ok(body) { return body; }

function err(status, code, message, extra = {}) {
  return {
    error: { code, message, ...extra },
    _ae_http_status: status,
  };
}

function pinPrefix(hexPin) {
  if (typeof hexPin !== "string" || hexPin.length < 12) return "unknown";
  return hexPin.slice(0, 12) + "…";
}

// Constant-time hex compare (lower-cased).
function eqHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const A = a.toLowerCase();
  const B = b.toLowerCase();
  if (A.length !== B.length) return false;
  const bufA = Buffer.from(A, "utf8");
  const bufB = Buffer.from(B, "utf8");
  try { return timingSafeEqual(bufA, bufB); } catch { return false; }
}

// Canonical JSON for signing — sorted keys at every level, no whitespace.
function canonicalJSON(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJSON).join(",") + "]";
  const keys = Object.keys(value).sort();
  const parts = [];
  for (const k of keys) {
    parts.push(JSON.stringify(k) + ":" + canonicalJSON(value[k]));
  }
  return "{" + parts.join(",") + "}";
}

// ---------------------------------------------------------------------------
// mTLS + pin verification. The host (server/index.mjs) must populate
// req.socket with a TLS socket exposing getPeerCertificate(true). If the
// request arrived on plain HTTP, we refuse: federation does not exist on
// the cleartext gateway.
// ---------------------------------------------------------------------------

export function extractPeerCertificate(req) {
  const sock = req && req.socket;
  if (!sock || typeof sock.getPeerCertificate !== "function") return null;
  if (typeof sock.authorized !== "boolean") return null;
  if (!sock.authorized) {
    return { authorized: false, cert: sock.getPeerCertificate(true) || null,
             authorizationError: sock.authorizationError || "client-cert-unauthorized" };
  }
  const cert = sock.getPeerCertificate(true);
  if (!cert || !cert.raw) return { authorized: true, cert: null };
  return { authorized: true, cert };
}

// Compute SHA-256(SPKI(DER)) from a node TLS peer certificate. We use the
// pubkey.raw or der subset on the cert object. If unavailable, derive from
// cert.pubkey via createPublicKey().export({type:'spki', format:'der'}).
export function spkiPinFromCert(cert) {
  if (!cert) return null;
  // Node 18+: cert.pubkey is a KeyObject when keepRawData=true on the
  // tls.Server. Fallback path: re-export via createPublicKey from PEM.
  try {
    if (cert.pubkey && typeof cert.pubkey === "object" && typeof cert.pubkey.export === "function") {
      const der = cert.pubkey.export({ type: "spki", format: "der" });
      return createHash("sha256").update(der).digest("hex");
    }
  } catch { /* fall through */ }
  // Older shape: cert.raw is the full cert DER; we approximate by hashing
  // the cert's SubjectPublicKeyInfo if exposed as cert.subjectPublicKeyInfo
  // (newer Node). If neither is available, return null and let the caller
  // refuse.
  if (cert.subjectPublicKeyInfo && Buffer.isBuffer(cert.subjectPublicKeyInfo)) {
    return createHash("sha256").update(cert.subjectPublicKeyInfo).digest("hex");
  }
  return null;
}

function refuseMtls(reason, extra = {}) {
  return err(401, FED_REFUSE_NO_MTLS, reason, extra);
}

function verifyMtlsAndPeer(req, claimedPeerId) {
  const peerInfo = extractPeerCertificate(req);
  if (!peerInfo) {
    return { ok: false, response: refuseMtls("federation requires mTLS; request did not arrive on a TLS socket") };
  }
  if (!peerInfo.authorized) {
    return {
      ok: false,
      response: err(401, FED_REFUSE_NO_MTLS,
        "client certificate not authorized by federation CA",
        { authorization_error: peerInfo.authorizationError || "unauthorized" }),
    };
  }
  if (!peerInfo.cert) {
    return { ok: false, response: refuseMtls("no peer certificate presented") };
  }

  const pin = spkiPinFromCert(peerInfo.cert);
  if (!pin) {
    return {
      ok: false,
      response: err(401, FED_REFUSE_PIN_MISMATCH,
        "unable to derive SPKI pin from peer leaf certificate; refusing",
        { hint: "rebuild gateway with TLS keepRawData enabled" }),
    };
  }

  if (typeof claimedPeerId !== "string" || claimedPeerId.length === 0) {
    return {
      ok: false,
      response: err(401, FED_REFUSE_PEER_UNAUTH,
        `${FED_HEADER_PEER_ID} header required`,
        { spki_pin_prefix: pinPrefix(pin) }),
    };
  }

  const peer = getPeer(claimedPeerId);
  if (!peer) {
    return {
      ok: false,
      response: err(401, FED_REFUSE_PEER_UNAUTH,
        `peer ${claimedPeerId} not on this instance's federation roster`,
        { spki_pin_prefix: pinPrefix(pin) }),
    };
  }

  if (!eqHex(peer.spki_pin_sha256, pin)) {
    return {
      ok: false,
      response: err(401, FED_REFUSE_PIN_MISMATCH,
        "SPKI pin mismatch — peer leaf does not match this instance's recorded pin for that peer id",
        { spki_pin_prefix_presented: pinPrefix(pin),
          spki_pin_prefix_expected: pinPrefix(peer.spki_pin_sha256) }),
    };
  }

  return { ok: true, peer, pin, peerId: claimedPeerId };
}

// ---------------------------------------------------------------------------
// Sovereign signature verification (ed25519 over canonical-JSON body).
// ---------------------------------------------------------------------------

function verifySovereignSignature({ peer, body, signatureB64u }) {
  if (!peer || !peer.sovereign_pubkey_pem) {
    return { ok: false, code: FED_REFUSE_BAD_SIG, reason: "peer Sovereign pubkey not on file" };
  }
  if (typeof signatureB64u !== "string" || signatureB64u.length === 0) {
    return { ok: false, code: FED_REFUSE_BAD_SIG, reason: `missing ${FED_HEADER_SOVEREIGN_SIG} header` };
  }
  let pubkey;
  try {
    pubkey = createPublicKey({ key: peer.sovereign_pubkey_pem, format: "pem" });
  } catch (e) {
    return { ok: false, code: FED_REFUSE_BAD_SIG, reason: `peer pubkey unparseable: ${e.message}` };
  }
  let sig;
  try {
    sig = Buffer.from(signatureB64u, "base64url");
  } catch {
    return { ok: false, code: FED_REFUSE_BAD_SIG, reason: "signature not valid base64url" };
  }
  const message = Buffer.from(canonicalJSON(body), "utf8");
  let valid;
  try {
    // ed25519 in Node: pass null as the algorithm; the KeyObject carries it.
    valid = cryptoVerify(null, message, pubkey, sig);
  } catch (e) {
    return { ok: false, code: FED_REFUSE_BAD_SIG, reason: `verify error: ${e.message}` };
  }
  if (!valid) {
    return { ok: false, code: FED_REFUSE_BAD_SIG, reason: "ed25519 signature does not verify against peer Sovereign pubkey" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Session helpers
// ---------------------------------------------------------------------------

function requireSession(req) {
  const sid = (req.headers && (req.headers[FED_HEADER_SESSION_ID] || req.headers[FED_HEADER_SESSION_ID.toLowerCase()])) || "";
  if (!sid) {
    return { ok: false, response: err(401, FED_REFUSE_NO_SESSION,
      `${FED_HEADER_SESSION_ID} header required; call /v1/federation/handshake first`) };
  }
  pruneExpiredSessions();
  const row = _sessions.get(sid);
  if (!row) {
    return { ok: false, response: err(401, FED_REFUSE_NO_SESSION,
      "session not found or expired; rehandshake required") };
  }
  return { ok: true, session: row, sessionId: sid };
}

// ---------------------------------------------------------------------------
// Clock skew check (handshake nonce + timestamp)
// ---------------------------------------------------------------------------

function checkClockSkew(isoTimestamp) {
  const t = Date.parse(isoTimestamp);
  if (!Number.isFinite(t)) {
    return { ok: false, response: err(400, FED_REFUSE_BAD_BODY, "timestamp is not a valid ISO-8601 string") };
  }
  const now = Date.now();
  if (Math.abs(now - t) > CLOCK_SKEW_TOLERANCE_MS) {
    return {
      ok: false,
      response: err(401, FED_REFUSE_CLOCK_SKEW,
        "handshake timestamp outside this instance's accepted skew window",
        { skew_ms: now - t, tolerance_ms: CLOCK_SKEW_TOLERANCE_MS }),
    };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

export async function handleHandshake(req, body) {
  if (!body || typeof body !== "object") {
    return err(400, FED_REFUSE_BAD_BODY, "handshake body required");
  }
  const { peer_id, peer_version, capabilities, nonce, timestamp, spki_pin } = body;

  // Header peer_id must agree with body peer_id (defense in depth).
  const headerPeerId = (req.headers && (req.headers[FED_HEADER_PEER_ID] || req.headers[FED_HEADER_PEER_ID.toLowerCase()])) || "";
  if (typeof peer_id !== "string" || !peer_id) {
    return err(400, FED_REFUSE_BAD_BODY, "peer_id required in body");
  }
  if (headerPeerId && headerPeerId !== peer_id) {
    return err(400, FED_REFUSE_BAD_BODY,
      `${FED_HEADER_PEER_ID} header (${headerPeerId}) does not match body.peer_id (${peer_id})`);
  }
  if (typeof nonce !== "string" || nonce.length < 16) {
    return err(400, FED_REFUSE_BAD_BODY, "nonce required (>= 16 chars, base64url)");
  }
  if (typeof spki_pin !== "string" || spki_pin.length === 0) {
    return err(400, FED_REFUSE_BAD_BODY, "spki_pin required");
  }

  const skew = checkClockSkew(timestamp);
  if (!skew.ok) return skew.response;

  const auth = verifyMtlsAndPeer(req, peer_id);
  if (!auth.ok) return auth.response;

  // Peer must also self-assert the same SPKI pin we observed (defense in
  // depth: catches a peer that doesn't know its own leaf).
  if (!eqHex(auth.pin, spki_pin)) {
    return err(401, FED_REFUSE_PIN_MISMATCH,
      "peer's self-asserted spki_pin does not match the SPKI of its TLS leaf",
      { spki_pin_prefix_tls: pinPrefix(auth.pin),
        spki_pin_prefix_body: pinPrefix(spki_pin) });
  }

  const now = Date.now();
  const sessionId = makeSessionId();
  _sessions.set(sessionId, {
    peer_id: auth.peerId,
    spki_pin: auth.pin,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  });

  let stateHeads = { receipt_chain_head_link: null, guardrail_head_link: null };
  if (_stateBriefProvider) {
    try {
      const s = await _stateBriefProvider(["receipt_chain_head_link", "guardrail_head_link"]);
      if (s && typeof s === "object") {
        stateHeads.receipt_chain_head_link = s.receipt_chain_head_link ?? null;
        stateHeads.guardrail_head_link = s.guardrail_head_link ?? null;
      }
    } catch { /* surface no internals on failure */ }
  }

  return ok({
    object: "federation.handshake",
    session_id: sessionId,
    local_id: LOCAL_INSTANCE_ID,
    local_version: LOCAL_VERSION,
    local_capabilities: LOCAL_CAPABILITIES.slice(),
    local_spki_pin: LOCAL_SPKI_PIN,
    accepted_at: new Date(now).toISOString(),
    expires_at: new Date(now + SESSION_TTL_MS).toISOString(),
    receipt_chain_head_link: stateHeads.receipt_chain_head_link,
    guardrail_head_link: stateHeads.guardrail_head_link,
    nonce_echo: nonce,
    peer_capabilities_announced: Array.isArray(capabilities) ? capabilities.slice() : [],
    peer_version_announced: typeof peer_version === "string" ? peer_version : null,
  });
}

export async function handleStateBrief(req, body) {
  const sessionCheck = requireSession(req);
  if (!sessionCheck.ok) return sessionCheck.response;
  const auth = verifyMtlsAndPeer(req, sessionCheck.session.peer_id);
  if (!auth.ok) return auth.response;

  if (!body || typeof body !== "object") {
    return err(400, FED_REFUSE_BAD_BODY, "state-brief body required");
  }
  const askRaw = Array.isArray(body.ask) ? body.ask : null;
  if (!askRaw || askRaw.length === 0) {
    return err(400, FED_REFUSE_BAD_BODY,
      "ask: list of state-brief keys required",
      { allowed: STATE_BRIEF_ALLOWED_KEYS.slice() });
  }

  // Intersect ask with allow-list. Silently drop unknown keys (no
  // information leak about which keys exist).
  const ask = askRaw.filter(k => typeof k === "string" && STATE_BRIEF_ALLOWED_KEYS.includes(k));
  if (ask.length === 0) {
    return err(400, FED_REFUSE_BAD_BODY,
      "no allowed keys in ask",
      { allowed: STATE_BRIEF_ALLOWED_KEYS.slice() });
  }

  let raw = {};
  if (_stateBriefProvider) {
    try {
      raw = (await _stateBriefProvider(ask)) || {};
    } catch (e) {
      return err(503, "state_brief_provider_failed",
        "local state-brief provider failed; refusing to fabricate",
        { provider_error: e.message });
    }
  }

  const out = { object: "federation.state_brief", ts: new Date().toISOString() };
  for (const k of ask) {
    if (k in raw) out[k] = raw[k];
    else out[k] = null;
  }
  // Always carry the canonical instance identity, even if not asked, so
  // the peer can pin the response to a sender.
  out.instance_id = LOCAL_INSTANCE_ID;
  out.instance_version = LOCAL_VERSION;
  return ok(out);
}

export async function handleLease(req, body, rawBodyText) {
  const sessionCheck = requireSession(req);
  if (!sessionCheck.ok) return sessionCheck.response;
  const auth = verifyMtlsAndPeer(req, sessionCheck.session.peer_id);
  if (!auth.ok) return auth.response;

  if (!body || typeof body !== "object") {
    return err(400, FED_REFUSE_BAD_BODY, "lease body required");
  }
  const { lease_id, task_descriptor, expires_at, scope, sovereign_payload_sha256 } = body;
  if (typeof lease_id !== "string" || !lease_id) {
    return err(400, FED_REFUSE_BAD_BODY, "lease_id required");
  }
  if (!task_descriptor || typeof task_descriptor !== "object") {
    return err(400, FED_REFUSE_BAD_BODY, "task_descriptor object required");
  }
  if (!scope || typeof scope !== "object") {
    return err(400, FED_REFUSE_BAD_BODY, "scope object required");
  }
  const expiresMs = Date.parse(expires_at);
  if (!Number.isFinite(expiresMs) || expiresMs <= Date.now()) {
    return err(400, FED_REFUSE_BAD_BODY, "expires_at must be a future ISO-8601 timestamp");
  }

  // Verify Sovereign signature over canonical-JSON body.
  const sigHeader = req.headers[FED_HEADER_SOVEREIGN_SIG] || req.headers[FED_HEADER_SOVEREIGN_SIG.toLowerCase()];
  const sigCheck = verifySovereignSignature({ peer: auth.peer, body, signatureB64u: sigHeader });
  if (!sigCheck.ok) {
    return err(401, sigCheck.code, sigCheck.reason,
      { spki_pin_prefix: pinPrefix(auth.pin) });
  }

  // Cap scope to this instance's hard limits regardless of what the peer
  // asked for. This is Mom's-Law cap: we never blow past the local caps
  // even if the peer's Sovereign signed something larger.
  const requestedCalls = Number.isFinite(scope.max_calls) ? Math.trunc(scope.max_calls) : 0;
  const requestedSeconds = Number.isFinite(scope.max_wall_seconds) ? Math.trunc(scope.max_wall_seconds) : 0;
  const requestedCaps = Array.isArray(scope.capabilities) ? scope.capabilities.filter(c => typeof c === "string") : [];

  const cappedCalls = Math.min(Math.max(requestedCalls, 0), LEASE_MAX_CALLS_CAP);
  const cappedSeconds = Math.min(Math.max(requestedSeconds, 0), LEASE_MAX_SECONDS_CAP);
  const cappedCaps = requestedCaps.filter(c => LEASE_CAPABILITY_ALLOW.includes(c));

  if (cappedCalls === 0 || cappedSeconds === 0 || cappedCaps.length === 0) {
    return ok({
      object: "federation.lease",
      accepted: false,
      code: FED_REFUSE_SOVEREIGN_LAW,
      reason: "requested scope reduced to zero by this instance's sovereign caps",
      local_lease_receipt_id: null,
      caps_applied: {
        max_calls: LEASE_MAX_CALLS_CAP,
        max_wall_seconds: LEASE_MAX_SECONDS_CAP,
        allowed_capabilities: LEASE_CAPABILITY_ALLOW.slice(),
      },
    });
  }

  const capped = {
    capabilities: cappedCaps,
    max_calls: cappedCalls,
    max_wall_seconds: cappedSeconds,
  };

  // Local evaluator gets the final say. Mom's Law: even a perfectly
  // signed, perfectly scoped lease can be refused. The refusal IS a
  // receipt.
  let evaluation;
  if (_leaseEvaluator) {
    try {
      evaluation = await _leaseEvaluator({
        peer_id: auth.peerId,
        lease_id,
        task_descriptor,
        scope: capped,
        expires_at,
        sovereign_payload_sha256: typeof sovereign_payload_sha256 === "string" ? sovereign_payload_sha256 : null,
      });
    } catch (e) {
      evaluation = { accept: false, code: FED_REFUSE_SOVEREIGN_LAW, reason: `lease evaluator threw: ${e.message}` };
    }
  } else {
    evaluation = { accept: false, code: FED_REFUSE_SOVEREIGN_LAW, reason: "no local lease evaluator installed; refusing by default" };
  }

  const now = Date.now();
  // Receipt id is content-bound so the operator can find it later.
  const receiptIdSeed = canonicalJSON({
    peer_id: auth.peerId,
    lease_id,
    accept: !!evaluation.accept,
    capped,
    now,
  });
  const receiptId = "fedlease_" + createHash("sha256").update(receiptIdSeed).digest("hex").slice(0, 24);

  return ok({
    object: "federation.lease",
    accepted: !!evaluation.accept,
    code: evaluation.accept ? null : (evaluation.code || FED_REFUSE_LEASE_DECLINED),
    reason: evaluation.accept ? null : (evaluation.reason || "local sovereign declined"),
    lease_id,
    accepted_at: evaluation.accept ? new Date(now).toISOString() : null,
    expires_at: evaluation.accept ? new Date(expiresMs).toISOString() : null,
    scope_granted: evaluation.accept ? capped : null,
    local_lease_receipt_id: receiptId,
    local_sovereign_fingerprint: LOCAL_SOVEREIGN_FINGERPRINT,
  });
}

export async function handleCrossReceipt(req, body, rawBodyText) {
  const sessionCheck = requireSession(req);
  if (!sessionCheck.ok) return sessionCheck.response;
  const auth = verifyMtlsAndPeer(req, sessionCheck.session.peer_id);
  if (!auth.ok) return auth.response;

  if (!body || typeof body !== "object") {
    return err(400, FED_REFUSE_BAD_BODY, "cross-receipt body required");
  }
  const { peer_receipt, summary } = body;
  if (!peer_receipt || typeof peer_receipt !== "object") {
    return err(400, FED_REFUSE_BAD_BODY, "peer_receipt object required");
  }
  const required = ["receipt_id", "head_link", "signed_by", "audit_chain_prev_hash", "ts"];
  for (const k of required) {
    if (typeof peer_receipt[k] !== "string" || !peer_receipt[k]) {
      return err(400, FED_REFUSE_BAD_BODY, `peer_receipt.${k} required (string)`);
    }
  }

  const sigHeader = req.headers[FED_HEADER_SOVEREIGN_SIG] || req.headers[FED_HEADER_SOVEREIGN_SIG.toLowerCase()];
  const sigCheck = verifySovereignSignature({ peer: auth.peer, body, signatureB64u: sigHeader });
  if (!sigCheck.ok) {
    return err(401, sigCheck.code, sigCheck.reason,
      { spki_pin_prefix: pinPrefix(auth.pin) });
  }

  if (!_crossReceiptWriter) {
    return err(503, "cross_receipt_writer_unset",
      "this instance has no cross-receipt writer installed; refusing rather than silently dropping the peer receipt");
  }

  let written;
  try {
    written = await _crossReceiptWriter({
      peer_id: auth.peerId,
      peer_spki_pin: auth.pin,
      peer_receipt,
      summary: typeof summary === "string" ? summary : null,
      received_at: new Date().toISOString(),
      local_sovereign_fingerprint: LOCAL_SOVEREIGN_FINGERPRINT,
    });
  } catch (e) {
    return err(500, "cross_receipt_write_failed",
      "local cross-receipt write failed",
      { write_error: e.message });
  }

  if (!written || typeof written !== "object" || typeof written.local_cross_receipt_id !== "string") {
    return err(500, "cross_receipt_writer_contract_violation",
      "cross-receipt writer returned an invalid shape");
  }

  return ok({
    object: "federation.cross_receipt",
    ok: true,
    local_cross_receipt_id: written.local_cross_receipt_id,
    recorded_at: written.recorded_at || new Date().toISOString(),
    local_head_link: written.local_head_link || null,
    local_sovereign_fingerprint: LOCAL_SOVEREIGN_FINGERPRINT,
    peer_id: auth.peerId,
    spki_pin_prefix: pinPrefix(auth.pin),
  });
}

// ---------------------------------------------------------------------------
// dispatchFederation — router entry point. The host's index.mjs calls this
// after the main boundary has already (a) rejected forbidden header
// families, (b) confirmed the path is in FEDERATION_ALLOWED. We still
// re-check the route to keep this module testable in isolation.
// ---------------------------------------------------------------------------

export async function dispatchFederation(req, urlOrPath, parsedBody, rawBodyText) {
  const method = (req.method || "POST").toUpperCase();
  const pathname = typeof urlOrPath === "string" ? urlOrPath : urlOrPath.pathname;

  if (!isFederationRouteAllowed(method, pathname)) {
    return err(404, "not_found", `federation endpoint not exposed: ${method} ${pathname}`);
  }

  if (pathname === "/v1/federation/handshake") {
    return handleHandshake(req, parsedBody);
  }
  if (pathname === "/v1/federation/state-brief") {
    return handleStateBrief(req, parsedBody);
  }
  if (pathname === "/v1/federation/lease") {
    return handleLease(req, parsedBody, rawBodyText);
  }
  if (pathname === "/v1/federation/cross-receipt") {
    return handleCrossReceipt(req, parsedBody, rawBodyText);
  }

  return err(404, "not_found", `federation endpoint not exposed: ${method} ${pathname}`);
}

// ---------------------------------------------------------------------------
// registerFederationRoutes — primary export. Mirrors receipts.mjs shape so
// the host's index.mjs can wire this in the same place it wires receipts.
// ---------------------------------------------------------------------------

export function registerFederationRoutes(server, opts = {}) {
  if (opts.peers && typeof opts.peers === "object") {
    setPeers(opts.peers);
  } else if (opts.loadPeers !== false) {
    // Best-effort cold load. The watcher (if installed) will overwrite this
    // on first file event.
    loadPeersFromDisk({ peersPath: opts.peersPath || PEERS_PATH }).catch(() => {});
  }
  if (typeof opts.stateBriefProvider === "function") {
    setStateBriefProvider(opts.stateBriefProvider);
  }
  if (typeof opts.crossReceiptWriter === "function") {
    setCrossReceiptWriter(opts.crossReceiptWriter);
  }
  if (typeof opts.leaseEvaluator === "function") {
    setLeaseEvaluator(opts.leaseEvaluator);
  }

  if (server && typeof server === "object") {
    server._federationDispatch = (req, url, body, raw) => dispatchFederation(req, url, body, raw);
    server._federationConfig = {
      local_id: LOCAL_INSTANCE_ID,
      local_version: LOCAL_VERSION,
      local_capabilities: LOCAL_CAPABILITIES.slice(),
      session_ttl_ms: SESSION_TTL_MS,
      clock_skew_tolerance_ms: CLOCK_SKEW_TOLERANCE_MS,
      lease_caps: {
        max_calls: LEASE_MAX_CALLS_CAP,
        max_wall_seconds: LEASE_MAX_SECONDS_CAP,
        allowed_capabilities: LEASE_CAPABILITY_ALLOW.slice(),
      },
    };
  }

  return {
    dispatch: dispatchFederation,
    config: server?._federationConfig || null,
  };
}

export default registerFederationRoutes;
