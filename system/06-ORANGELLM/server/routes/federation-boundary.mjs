// AE OrangeLLM — Federation Triumvirate gateway boundary allow-list
// Path: 06-ORANGELLM/server/routes/federation-boundary.mjs
//
// Doctrine (Federation Triumvirate, ATOM-FED-TRIUMVIRATE-v1-2026-0617):
//   - Each Orange5 instance is sovereign. Federation lets peers coordinate
//     but never overrides another instance's Mom's Law, 27 guardrails, Gate
//     0 LBCE, Human Final Stop, or receipt chain.
//   - The four exposed federation verbs are the ONLY legal inter-instance
//     protocol surface:
//
//       POST /v1/federation/handshake     — peer identification + capability
//                                           announce + mutual-pin exchange.
//                                           No federation call is accepted
//                                           from a peer until a handshake
//                                           in this clock window has cleared
//                                           and produced a federation
//                                           session id.
//
//       POST /v1/federation/state-brief   — federated state-brief: a peer
//                                           requests a sanitized read of
//                                           this instance's current routing
//                                           lane, guardrail head-link, and
//                                           receipt-chain head hash. NEVER
//                                           returns raw memory, raw flux,
//                                           raw secrets, or operator-only
//                                           material. Read-only by design.
//
//       POST /v1/federation/lease         — federated lease delegation
//                                           (RARE). One sovereign instance
//                                           asks another to act on its
//                                           behalf for a single bounded
//                                           task. Must be Sovereign-signed
//                                           by the requesting peer. The
//                                           accepting instance evaluates
//                                           against its own Mom's Law and
//                                           may refuse. A refusal is itself
//                                           a receipt.
//
//       POST /v1/federation/cross-receipt — federated receipt
//                                           cross-reference. A peer offers
//                                           its head-link + signed-by line
//                                           so this instance can persist a
//                                           cross-receipt row (the only
//                                           write surface in the federation
//                                           namespace, and only into the
//                                           cross-receipt table — never
//                                           into this instance's own audit
//                                           chain).
//
//   - mTLS is the door. Every federation request MUST:
//       (a) be transported over a TLS connection with client cert verified
//           against the federation CA bundle (ORANGE5_FED_CA_PATH);
//       (b) present a peer leaf certificate whose SPKI SHA-256 fingerprint
//           is on the in-memory pin list maintained by
//           middleware/federation-peer-watcher.mjs (file at
//           ORANGE5_FED_PEERS_PATH, hot-reloaded on change).
//     If either fails, the boundary refuses BEFORE any handler runs.
//
//   - Forbidden header families (x-mirage-, x-orangebox-, x-codexa-,
//     x-internal-) are still rejected by the main boundary BEFORE this
//     namespace check. This module only declares allow-list shape and the
//     federation-specific header names needed by handlers.
//
//   - Mom's Law: a refusal is never silent. A refused federation request
//     emits an `error` body with the SPKI fingerprint PREFIX (never the
//     whole cert), the refusal `code`, and the precise reason. No
//     fall-through to anonymous. No silent retry. No swallowing peer
//     errors.

export const FEDERATION_PATH_PREFIX = "/v1/federation";

export const FEDERATION_ALLOWED = Object.freeze([
  { method: "POST", path: "/v1/federation/handshake" },
  { method: "POST", path: "/v1/federation/state-brief" },
  { method: "POST", path: "/v1/federation/lease" },
  { method: "POST", path: "/v1/federation/cross-receipt" },
]);

export function isFederationPath(pathname) {
  return typeof pathname === "string" &&
    (pathname === FEDERATION_PATH_PREFIX || pathname.startsWith(FEDERATION_PATH_PREFIX + "/"));
}

export function isFederationRouteAllowed(method, pathname) {
  const m = (method || "").toUpperCase();
  return FEDERATION_ALLOWED.some(r => r.method === m && r.path === pathname);
}

// Header names carrying federation context. Intentionally NOT prefixed with
// any of the forbidden families (x-mirage-, x-orangebox-, x-codexa-,
// x-internal-) so the main boundary lets them through to the handler.
//
//   x-ae-fed-peer-id        — claimed peer instance id (e.g. "orange5-misfit-adj@atomeons/1.0").
//                             Used only to look up the SPKI pin row; the
//                             actual identity is the verified TLS leaf.
//   x-ae-fed-session-id     — federation session id returned by a prior
//                             /handshake. Required on every non-handshake
//                             call.
//   x-ae-fed-sovereign-sig  — ed25519 signature, base64url, over the
//                             canonical-JSON body. Required on /lease and
//                             /cross-receipt. Verified against the peer's
//                             Sovereign pubkey in the peers file.
export const FED_HEADER_PEER_ID = "x-ae-fed-peer-id";
export const FED_HEADER_SESSION_ID = "x-ae-fed-session-id";
export const FED_HEADER_SOVEREIGN_SIG = "x-ae-fed-sovereign-sig";

// Refusal codes — exact strings the cockpit and audit chain match on.
export const FED_REFUSE_NO_MTLS = "federation_mtls_required";
export const FED_REFUSE_PEER_UNAUTH = "federation_peer_not_authorized";
export const FED_REFUSE_PIN_MISMATCH = "federation_spki_pin_mismatch";
export const FED_REFUSE_NO_SESSION = "federation_session_required";
export const FED_REFUSE_BAD_SIG = "federation_sovereign_signature_invalid";
export const FED_REFUSE_BAD_BODY = "federation_body_invalid";
export const FED_REFUSE_CLOCK_SKEW = "federation_clock_skew_exceeded";
export const FED_REFUSE_LEASE_DECLINED = "federation_lease_declined";
export const FED_REFUSE_SOVEREIGN_LAW = "federation_violates_sovereign_law";
