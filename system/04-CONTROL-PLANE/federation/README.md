# Orange5 Federation

**Doctrine:** [`FEDERATION_TRIUMVIRATE_DOCTRINE.md`](../../../orangebox/docs/FEDERATION_TRIUMVIRATE_DOCTRINE.md)
**Disclosure ID:** `ATOM-FED-TRIUMVIRATE-v1-2026-0617`
**Status:** Real protocol. Rare lane. Sovereign-by-construction.

> "No agent rules the swarm. No vote overrules reality. No consensus overwrites evidence. No output enters canon without receipt."
> — CHSG core law (Federation Triumvirate Doctrine §0)

This directory is the protocol substrate for one specific situation: **two or more Orange5 instances owned by the same operator need to coordinate without merging into one instance.** It is not a backend for multi-tenant SaaS. It is not a way for a peer to acquire authority over the local instance. It is a mutually-authenticated, read-mostly, sovereignty-preserving channel that lets a paired peer say "here is what I am" and lets a paired peer cite "I saw your receipt."

If you are reading this trying to onboard a customer, you are in the wrong directory. Federation is for the operator's own machines.

---

## Files

| File | Purpose | Writes? |
|---|---|---|
| `handshake.mjs` | mTLS daemon, identity binding, capability negotiation, time-sync, session minting | per-process session map only; no disk writes |
| `state-brief.mjs` | Read-only doctrine-grade self-summary; salted spine digest; no receipt bodies cross the boundary | no writes |
| `cross-receipt.mjs` | Cite peer receipts (outbound) and accept peer attestations of our receipts (inbound); separate JSONL ledger, never inside the audit chain | append-only `xref/<peer>/{outbound,inbound}.jsonl` |
| `lease.mjs` | Per-action, short-lived, single-use, two-sided-approval authority delegation; payload hash committed at redeem; revocation is one-sided and instant | per-process lease map only; no disk writes |

The four files compose. `handshake.mjs` is the trust root; the other three reject unauthenticated requests at the door.

---

## When to federate (rare)

Federation is appropriate when **all** of these hold:

1. The operator owns both instances. Atom's workstation and Atom's colo box. Atom's laptop and Atom's signed-handheld kiosk. Not "Atom and a customer." Not "Atom and another founder." Not "Atom and a contractor."
2. The instances need to coordinate, not merge. A merge would be one runtime, one receipt chain, one Mom's-Law. Federation is two of each, talking.
3. Coordination is information-flow, not authority-flow. State-brief and receipt cross-reference are the 99% case. Lease delegation is the 1% case and requires a fresh operator approval on the grantor side every single time.
4. Each instance has its own NTP-disciplined clock. Federation refuses to operate across a clock skew larger than `MAX_CLOCK_SKEW_MS` (5 seconds) because the audit chain depends on monotonic time.
5. Each instance has its own per-pair certificate, generated offline, and an explicit `trusted-peers.json` allow-list entry. No CA chain to a public root. No "well-known" trust.

**Plausible legitimate uses:**

- **Workstation + colo:** the operator's daily-driver workstation federates with a colo box that runs long-horizon training or kept-warm services. Workstation cites colo receipts in research notes; colo cites workstation receipts when a result was produced there and shipped here.
- **Primary + standby:** an operator running two physically-separated boxes for resilience. Federation lets the standby surface a state-brief without becoming an authority over the primary.
- **Cross-room handoff:** the operator runs a kiosk box (Quint, signed-handheld) at one location and a research box at another; the kiosk cites the research box's receipts when surfacing a result, so users can trace provenance without the kiosk holding the research box's secrets.

---

## When NOT to federate (most of the time)

Federation is the wrong tool when any of the following is true:

- **Multi-tenant SaaS.** Federation is not a way to run other people's Orange5 instances. There is no shared identity layer, no billing surface, no customer scoping, no support model. Don't.
- **Outsourcing authority.** A peer cannot tell the local instance to write a receipt, mutate a gate, change a dividend, or bypass Mom's Law. If you want that, you don't want federation; you want to give up sovereignty, and we don't ship that.
- **High-frequency RPC.** State-brief is `cache-control: no-store` and rate-limit-friendly; lease has a hard `RATE_LIMIT_PER_PEER_PER_MIN = 12`. If your coordination needs more than that, you needed one instance, not two.
- **Trust-on-first-use.** There is no TOFU. There is no "first time we saw this peer, we trusted them." Every peer is on the allow-list at boot or refused at TLS handshake.
- **Reaching across a hostile network without a private path.** mTLS is necessary but not sufficient. The bind defaults to `127.0.0.1`. Binding to a public interface requires `FEDERATION_ALLOW_PUBLIC_BIND=1` *and* operator intent. Prefer a VPN-internal interface or a SSH tunnel; do not expose the daemon to the open internet.
- **You want a "consensus."** Federation does not vote in the local audit chain. Trilogy/Triumvirate adjudication (doctrine §3) is for dispute resolution between named federation entities; it does not override either side's Mom's-Law gates when the decided action eventually runs locally.

---

## What federation is NOT

This is the explicit list — written down so we don't drift:

- **Not multi-tenant.** Two operators on one substrate is not federation; that is "give up sovereignty and run a service for someone." We do not ship that.
- **Not shared state.** Neither side has a copy of the other's receipts, prompts, model outputs, dividend numbers, or `runtime/node.py`. The state-brief is doctrine-grade summary only — buckets and salted digests, never bodies. See `state-brief.mjs` REDACTED_FIELDS for the explicit strip list.
- **Not shared identity.** Each instance has its own `self_id` declared in its own `trusted-peers.json`. Identity is bound to a cert fingerprint, not a shared directory.
- **Not shared receipts.** Cross-receipt rows are **sibling artifacts** that point at the other side's receipt; they are not entries in either side's hash chain. See `cross-receipt.mjs` §1 (sovereignty) — the audit chain hash continuity is untouched by federation activity, by construction.
- **Not authority delegation as a session.** A lease is per-action, single-use, short-lived (default 60s, ceiling 5min), and requires fresh operator approval each time. There is no "logged-in peer." There is no "trusted session token." There is no `*` scope, no `all` scope, no wildcard scope.
- **Not a bypass of Mom's Law.** Even a granted lease only carries a verified federated *request envelope*. When the requester eventually executes the leased action locally, it must still run the action through its own Mom's-Law gates, its own 27 guardrails, its own Gate 0 LBCE, its own Human Final Stop. The grantor's lease is "you may ask with my voice" — never "you may bypass my gates."
- **Not transitive.** A lease cannot grant the authority to grant another lease. `lease.grant`, `lease.delegate`, and `lease.revoke` are on the `FORBIDDEN_ACTIONS` list. Delegation does not chain.

---

## Security boundaries

The boundary is enforced in four layers, in order. A request that fails any layer is refused with a structured `{ ok: false, error, detail }` body using stable refusal codes defined in `handshake.mjs::REFUSAL` (and module-local extensions in `cross-receipt.mjs::XREF_REFUSAL` and `lease.mjs::LEASE_REFUSAL`).

### Layer 1 — Transport (mTLS)

- TLSv1.3 minimum. Plain HTTP cannot bind.
- `requestCert: true`, `rejectUnauthorized: true`. The TLS layer rejects unknown CAs before the application sees the request.
- Per-pair CA generated offline by the operator. No public CA chain.
- Default bind is `127.0.0.1:7490`. Public bind requires both `FEDERATION_BIND` and `FEDERATION_ALLOW_PUBLIC_BIND=1`. The daemon refuses to bind `0.0.0.0` without the explicit env override — public exposure is a deliberate operator act, not a default.

### Layer 2 — Application-layer cert allow-list

- Even after mTLS, the client certificate's SHA-256 fingerprint is matched against `trusted-peers.json` (schema `atomeons.federation.trusted-peers.v1`). An unknown fingerprint is refused with `unknown_peer`.
- The peer's claimed `peer_id` in the request body MUST match the `peer_id` keyed to its certificate fingerprint. This stops a holder of a valid cert from impersonating a different federation member; refusal code `cert_fingerprint_mismatch`.

### Layer 3 — Schema, clock, capability

- `FEDERATION_SCHEMA_VERSION` must match exactly. Drift kills receipts; we refuse to federate across version skew. Refusal: `schema_mismatch`.
- Wall-clock skew must be within `MAX_CLOCK_SKEW_MS` (5 seconds). Refusal: `clock_skew`. NTP discipline is the operator's responsibility; we just refuse to operate without it.
- Capability intersection: the session can only use capabilities both sides offer AND that the trust-list entry requires. A peer that doesn't offer a `capabilities_required` capability is refused at handshake. Refusal: `capability_not_offered`.

### Layer 4 — Per-endpoint session, capability, and freshness

- All sub-protocol endpoints (state-brief, cross-receipt, lease) re-validate the session: it must exist in the in-process map, it must match the cert-authenticated peer, and it must not be older than the per-endpoint session cap (`STATE_BRIEF_SESSION_MAX_AGE_MS` and `XREF_SESSION_MAX_AGE_MS` are both 1 hour). Stale sessions refuse with `stale_session` and require re-handshake.
- The session must have negotiated the capability the endpoint represents (`state-brief`, `receipt-xref`). Refusal: `capability_not_negotiated`.
- Session lookups use `crypto.timingSafeEqual` against session_id bytes — no string-compare timing leak in auth paths.

### Sovereignty invariants enforced by code

These are not documentation aspirations; they are checked at request time:

- **Receipt-store immutability across the boundary.** `cross-receipt.mjs` writes only to its own JSONL ledger under `xref/<peer>/`. It does not append to the local audit chain. The local hash continuity is preserved by construction — there is no code path that mutates the chain from a federation endpoint.
- **Digest verification on inbound attestations.** When a peer claims "I cited your receipt R with digest D," we read R locally and recompute. Mismatch returns `digest_mismatch`. We never accept a back-link to a receipt we don't have.
- **Forbidden actions deny-list on leases.** `lease.mjs::FORBIDDEN_ACTIONS` rejects any lease scope that touches receipts, dividends, founder salary, gates, guardrails, LBCE, identity, authority elevation, Human Final Stop, `runtime/node.py`, or other leases. Both `*`/`all`/`any` and any descendant of a forbidden category root (e.g. `receipts.write.fast`) are rejected. Re-validated at request, approval, and redemption — even if the deny list grew between request and redeem, the strictest reading wins.
- **Loopback-only operator paths.** `/lease/operator-approve` and `/lease/revoke` refuse non-loopback callers with `loopback_required`. The grantor-side operator must be physically at the grantor instance — a remote peer cannot self-approve its own lease, and cannot revoke a lease against the grantor's wishes.
- **Self-citation refused.** A peer whose `self_id` equals our `self_id` is rejected with `self_citation_refused` at both `/cite` and `/attest`. Same-instance audit goes through the local chain.
- **Replay refused.** Lease nonces are tracked per process; `/lease/request` and `/lease/redeem` refuse reuse with `nonce_replay`. Operator approval ids are single-use (`operator_approval_replay`). Session ids are minted from `randomBytes(16)`.

---

## Operator authority over both sides

Each operator (always Atom, in current deployment) keeps the same sovereign authority over each instance that they would have over a non-federated one. Federation does not federate Atom — it federates substrate.

- **Atom can stop either side at any time.** Human Final Stop is reachable from any autonomous-action path on each instance independently; the federation does not introduce a path that bypasses it.
- **Atom can revoke a granted lease from the grantor side instantly, with no peer notice, with no consent requirement.** Stop Authority dominates. The next redeem attempt refuses with `lease_revoked`.
- **Atom signs operator approvals on the grantor side per-lease.** No long-lived operator session. No "logged in." Each lease, fresh approval.
- **Atom can rotate certs on either side at any time** by editing `trusted-peers.json` and restarting the daemon. Restart is a blanket revocation of all in-flight leases (deliberate non-feature: lease persistence across restart). Workstation restart = colo loses all in-flight leases. Correct.
- **Mom's Law applies on each side independently.** The federation cannot quorum-override Mom's Law on either side. If Atom's mother is watching the colo box's outputs, the federation does not interpose a layer that says "well, the workstation said it was fine." Each side answers to Mom directly.

The Federation Triumvirate Adjudication path (doctrine §3) is for disputes between *named federation entities* (Misfit-Alpha, Misfit-Adjudicator, etc.) over substrate-level decisions (e.g., "ship Wave-43?"). Even there, the Sovereign Backstop (§3.3) is Atom's signed instrument — one person, always able to sign, always able to terminate the dispute. There is no quorum that overrules the Sovereign.

---

## Configuration

### Required files under `FEDERATION_DIR` (defaults to this directory)

```
certs/
  ca.pem            # peer CA root we trust (peer's CA cert)
  server.pem        # our cert (leaf)
  server.key        # our private key, 0600
  client.pem        # our client cert (for outbound federation)
  client.key        # our client private key, 0600
trusted-peers.json  # allow-list (schema below)
xref/               # auto-created on first cross-citation
  <peer_id_safe>/
    outbound.jsonl
    inbound.jsonl
```

### `trusted-peers.json`

```json
{
  "schema": "atomeons.federation.trusted-peers.v1",
  "self_id": "orange5-alpha@atomeons",
  "peers": [
    {
      "peer_id": "orange5-bravo@atomeons",
      "cert_sha256": "AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89:AB:CD:EF:01:23:45:67:89",
      "capabilities_required": ["state-brief", "receipt-xref"],
      "lease_delegation_allowed": false
    }
  ]
}
```

- `cert_sha256` is the SHA-256 fingerprint of the peer's leaf cert (DER), uppercase hex with `:` separators. Normalized at load.
- `capabilities_required` is the minimum set the peer must offer at handshake.
- `lease_delegation_allowed` is **false by default**. Flipping it to `true` does not grant any lease; it just makes the peer eligible to *request* one. Each lease still needs fresh operator approval.

### Environment

| Variable | Default | Purpose |
|---|---|---|
| `FEDERATION_DIR` | this directory | overrides cert/peer-list root |
| `FEDERATION_PORT` | `7490` | bind port |
| `FEDERATION_BIND` | `127.0.0.1` | bind host (private interfaces only by default) |
| `FEDERATION_ALLOW_PUBLIC_BIND` | unset | required, set to `1`, to allow `0.0.0.0` bind |
| `ATOMEONS_WAVE` | `unknown` | surfaces in state-brief |
| `ATOMEONS_STRATUM` | `production` | surfaces in state-brief |
| `ATOMEONS_HOST_CLASS` | `unknown` | surfaces in state-brief |

---

## Failure modes (the honest list)

Federation prefers to refuse loudly over succeed silently. The refusal codes below are stable; downstream code may switch on them.

**From `handshake.mjs::REFUSAL`:**
`schema_mismatch`, `unknown_peer`, `cert_fingerprint_mismatch`, `clock_skew`, `missing_client_cert`, `malformed_request`, `capability_not_offered`, `public_bind_refused`, `cert_files_missing`, `not_implemented`

**From `cross-receipt.mjs::XREF_REFUSAL`:**
`unknown_local_receipt`, `digest_format`, `digest_mismatch`, `url_format`, `self_citation_refused`, `duplicate_citation`, `duplicate_back_link`, `stale_session`, `capability_not_negotiated`, `ledger_unavailable`, `out_of_range`

**From `lease.mjs::LEASE_REFUSAL`:**
`session_unknown`, `session_peer_mismatch`, `peer_not_lease_eligible`, `scope_malformed`, `scope_forbidden_action`, `scope_wildcard_refused`, `ttl_out_of_range`, `requester_approval_malformed`, `operator_approval_missing`, `operator_approval_expired`, `operator_approval_mismatch`, `operator_approval_replay`, `lease_unknown`, `lease_not_pending`, `lease_not_granted`, `lease_expired`, `lease_redeemed`, `lease_revoked`, `payload_hash_missing`, `payload_hash_mismatch`, `nonce_replay`, `loopback_required`, `rate_limited`, `guardrail_breach`

If a refusal code is not on this list and the response says `ok: false`, that is a bug — the surface should always speak one of the codes above.

---

## Boot, observe, stop

```sh
# Boot the handshake daemon (with state-brief and cross-receipt mounted by the gateway):
bun run handshake.mjs
# or
node handshake.mjs

# Verify it is up (loopback):
curl --cacert certs/ca.pem --cert certs/client.pem --key certs/client.key \
     https://127.0.0.1:7490/healthz

# Stop: SIGINT / SIGTERM. Restart is a blanket revocation of in-flight leases.
```

The daemon emits a single JSON line on boot:
```json
{"federation":"up","runtime":"bun","url":"https://127.0.0.1:7490","self_id":"orange5-alpha@atomeons","schema_version":"atomeons.federation.v1","doctrine_ref":"ATOM-FED-TRIUMVIRATE-v1-2026-0617"}
```

Refusals at the TLS layer (unknown CA, missing client cert) are counted in `state.refusal_count` and surfaced on `/healthz`.

---

## Standing law (the short version)

1. **Each instance remains sovereign.** Federation never overrides another instance's Mom's-Law, receipts, or 27 guardrails.
2. **Read-mostly by default.** State-brief and cross-receipt are read-only with respect to the local audit chain. Lease delegation is the only write surface and it is two-sided, single-use, short-lived, and operator-approved per action.
3. **The operator dominates.** Loopback-only operator paths, instant revocation, no auto-renew, no transitive delegation, Human Final Stop reachable on each side.
4. **Receipts only.** No theater, no silent fall-back, no "we trust them, it's fine." Every cross-citation has a digest. Every lease has a payload hash committed at redeem. Every refusal has a code.
5. **Mom is watching the wire too.** A federation exchange is not a "throwaway" because it crossed a TLS boundary. Every byte that leaves and every byte that lands gets the same full-effort discipline as a local receipt.

---

*Filed at: `C:\AtomEons\Orange5\04-CONTROL-PLANE\federation\README.md`*
*Authored: 2026-06-24, AtomEons Research Laboratory.*
