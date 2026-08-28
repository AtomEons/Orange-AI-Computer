# Federation Triumvirate — Build Receipt

- Date: 2026-06-25
- Component: Orange5 Federation Triumvirate (doctrine + control plane + routes + smoke + README)
- Doctrine ref: ATOM-FED-TRIUMVIRATE-v1-2026-0617
- Standing law: Mom's Law applies. Each Orange5 instance remains sovereign. No instance overrides another's Mom's Law / receipts / guardrails. Receipts-or-halt.

---

## Result

Federation Triumvirate landed across 8 components and 11 files. Inter-instance federation surface is now defined, implemented, route-bound, smoke-tested, and documented under the binding Federation Triumvirate Doctrine. No live cross-host traffic is enabled by default; the operator must provision certs + trusted-peers roster before the daemon will bind.

## Files written

| # | Component | Path | Lines |
|---|-----------|------|------:|
| 1 | federation/triumvirate | `C:/AtomEons/Orange5/01-DOCTRINE/federation/triumvirate.md` | 406 |
| 2 | federation-handshake-daemon | `C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/handshake.mjs` | 657 |
| 3 | federation/state-brief | `C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/state-brief.mjs` | 419 |
| 4 | federation/lease.mjs | `C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/lease.mjs` | 847 |
| 5 | federation/cross-receipt | `C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/cross-receipt.mjs` | 909 |
| 6a | federation-routes (server) | `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/federation.mjs` | 874 |
| 6b | federation-routes (boundary) | `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/federation-boundary.mjs` | 116 |
| 7 | federation-smoke | `C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/smoke.mjs` | 824 |
| 7b | federation-smoke (last run) | `C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/smoke-last-run.json` | — |
| 8 | federation/README.md | `C:/AtomEons/Orange5/04-CONTROL-PLANE/federation/README.md` | 234 |

Total authored: 5,286 lines across 10 source/doc/test files + 1 run-receipt JSON.

---

## Doctrine — 01-DOCTRINE/federation/triumvirate.md (406 lines)

Inter-instance Federation Triumvirate Doctrine authored at requested path. Distinct from but composes with the intra-substrate adjudication doctrine at `C:/AtomEons/orangebox/docs/FEDERATION_TRIUMVIRATE_DOCTRINE.md` (cross-referenced in §0 and §10).

Mandated invariants covered:
1. Peer-not-hierarchy
2. Local Mom's Law ownership
3. Explicit lease grant
4. Sovereign override

Contents include:
- Instance identity schema with sovereign ed25519 keys + pinned hashes for guardrails / mom-law / runtime/node.py
- Federation registry schema
- Full FED_HELLO / FED_HELLO_ACK handshake wire format (mTLS + JSON + detached sigs)
- 9 enumerated terminal refusal modes: `FED_REFUSE_NO_SIG`, `NONCE_REPLAY`, `VERSION_SKEW`, `GUARDRAIL_PIN`, `MOM_LAW_DRIFT`, `RUNTIME_PIN`, `UNTRUSTED_PEER`, `SOVEREIGN_REVOKE`, `LBCE_FAIL`
- Python reference skeleton importing `runtime.node.lbce_gate_0` + receipts + identity + registry with `HandshakeRefused` exception
- Lease grant schema (scope / ops / paths_allowed / denied / ceilings / expiry / sovereign_sig)
- Lease invariants forbidding structural overreach into doctrine / charter / runtime / weights / guardrails
- Lease delegation capped at depth 1, default-off
- Federated state-brief schema: read-only, contract surface, no raw secrets / weights / doctrine
- Federated receipt cross-reference protocol with append-only `xref.jsonl` + periodic verifier
- Sovereign override layer (4 ops): `lease_revoke`, `peer_quarantine`, `peer_remove`, `sovereign_override`
- Full refusal-mode summary table across handshake / lease-parse / lease-enforce / operational / receipt layers
- Forbidden-actions list
- Composition table with adjudication doctrine, Black Mamba router law, 27 guardrails, Mom's Law, Spiral Reasoning
- Operator quick-reference with `obx` CLI invocations

Honors all standing doctrine: `runtime/node.py` as sole authoritative cognitive center; 27 guardrails preserved; Gate 0 LBCE present; Human Final Stop reachable; ed25519 sovereign signatures; no silent fallbacks; receipts-or-halt; Mom's Law at top.

---

## Control plane — 04-CONTROL-PLANE/federation/

### handshake.mjs (657 lines)

Bun :7490 daemon (PORT_DEFAULT=7490, HOST_DEFAULT=127.0.0.1) with `node:https` fallback. Real mTLS protocol: TLSv1.3 minimum, `requestCert+rejectUnauthorized` at TLS layer, plus application-layer SHA-256 fingerprint allow-list as defense-in-depth.

- Per-pair certs loaded from `<FED_DIR>/certs/{ca,server,server.key}.pem`
- Trust list at `<FED_DIR>/trusted-peers.json` (schema `atomeons.federation.trusted-peers.v1`)
- Endpoints:
  - `GET /healthz` — loopback may probe without cert; remote requires authenticated peer
  - `POST /handshake` — capability exchange + time-sync + schema-version check + identity binding between TLS cert and claimed peer_id
  - `GET /capabilities`
  - `POST /time-sync`
- Refusal modes with stable codes: `schema_mismatch` (409), `unknown_peer` (401), `cert_fingerprint_mismatch` (403), `clock_skew` (409, MAX_CLOCK_SKEW_MS=5s), `missing_client_cert` (401), `malformed_request` (400), `capability_not_offered` (409), `public_bind_refused` (boot — requires `FEDERATION_ALLOW_PUBLIC_BIND=1`), `cert_files_missing` (boot), `not_implemented` (501 for `/lease/*`)
- Schema `FEDERATION_SCHEMA_VERSION='atomeons.federation.v1'` enforced exact-match
- Identity binding stops valid-cert peer from impersonating another federation member
- `tlsClientError` caught and counted, not crashed
- `node --check` passes

### state-brief.mjs (419 lines)

`GET /v1/federation/state-brief` returning a doctrine-grade compressed StateBrief (schema `atomeons.federation.state-brief.v1`, doctrine ref ATOM-FED-TRIUMVIRATE-v1-2026-0617).

- Read-only; no writes; never mutates Mom's-Law / receipts / guardrails on either side
- Stripped fields declared in response: `operator_pii`, `api_keys`, `raw_receipts`, `prompts`, `model_outputs`, `host_paths`, `workflow_names`, `session_secrets`
- Layered auth: trusts handshake's mTLS + trusted-peers + capability negotiation; re-validates session against `state.sessions` Map; session age ≤ 1h; requires `state-brief` capability negotiated at handshake; constant-time session lookup via `timingSafeEqual`
- Receipt-spine probe reads metadata only (mtime + name), never bodies; salted SHA-256 head digest with 15-min rotating salt id (per-process seed, dies with process)
- Guardrail probe defaults to operator's `CLAUDE.md` invariants; accepts host verifier; never lies upward
- Receipt counts/ages CLASS-bucketed to limit timing leakage
- Refusal modes reused from handshake `REFUSAL` map: `schema_mismatch`, `unknown_peer`, `cert_fingerprint_mismatch`, `clock_skew`, `missing_client_cert`, `malformed_request`, `capability_not_offered`, `not_implemented`, `stale_session`, `capability_not_negotiated`
- `mountStateBrief(serverHandle, opts)` helper layers onto handshake via `_extensions["state-brief"]` without modifying handshake.mjs
- Verified: `node --check` passes; 10-case smoke all expected status+REFUSAL pairs

### lease.mjs (847 lines)

Federated lease grant protocol. Per-action delegation between sovereign Orange5 instances.

- Operator approval required at BOTH sides (grantor-side loopback-only with single-use 64-hex sha-256 approval id; requester-side approval recorded as audit hash)
- Lease bound to live handshake session, peer cert identity, single-use nonces
- TTL in [1s, 5min] default 60s; `max_invocations=1` forced
- Instant loopback-only revocation
- Forbidden-action deny-list (`receipts.*`, `dividend.*`, `gate.*`, `guardrail.*`, `lbce.bypass`, `identity.*`, `authority.elevate`, `human_final_stop.disable`, `runtime.node.*`, `lease.*`, `*`, `all`, `any`) checked at validate AND at redeem with prefix-match
- Per-peer rate limit 12/min
- Payload-hash commitment at redeem
- In-memory state only — restart = blanket revocation by design
- Caller MUST re-run local Mom's-Law gates on the action after redeem (ASK-with-my-voice, not bypass-my-gates)
- `node --check` clean; 22-case smoke battery all green

### cross-receipt.mjs (909 lines)

Federated receipt cross-reference module. Four mTLS+session-gated routes:
- `POST /cite` — emit outbound citation referencing peer receipt by URL + sha256 digest
- `GET /resolve` — lookup by `local_receipt_id` or `peer_receipt_url`
- `GET /index` — paginated outbound listing
- `POST /attest` — accept peer back-link AFTER verifying the claimed digest matches the local receipt body; refuses `digest_mismatch` otherwise

Each instance keeps its own hash chain; cross-citations land in a separate append-only JSONL ledger at `<FED_DIR>/xref/<peer_id_safe>/{outbound,inbound}.jsonl`, never inside primary receipts.

Stable refusal-code surface (`XREF_REFUSAL`): `unknown_local_receipt`, `digest_format`, `digest_mismatch`, `url_format`, `self_citation_refused`, `duplicate_citation`, `duplicate_back_link`, `stale_session`, `capability_not_negotiated`, `ledger_unavailable`, `out_of_range`.

Validators reject `http://`, `javascript:`, `file://`, oversized URLs, path-traversal receipt ids, control-char memos, malformed digests, self-peer collisions. 11-scenario smoke all green.

---

## Routes — 06-ORANGELLM/server/routes/

### federation-boundary.mjs (116 lines)

Strict 4-route allow-list: `POST /v1/federation/{handshake,state-brief,lease,cross-receipt}`. Path namespace test, three federation header names (none using forbidden prefixes), 9 named refusal codes the cockpit / audit chain match on.

### federation.mjs (874 lines)

Implements the four verbs per Federation Triumvirate Doctrine:

1. **mTLS is the door** — `extractPeerCertificate()` reads `req.socket.getPeerCertificate(true)`, refuses if not authorized, derives peer SPKI sha256 pin via `spkiPinFromCert()`. Pin constant-time compared (`eqHex`) against in-memory peers roster from `ORANGE5_FED_PEERS_PATH`. Pin mismatch → `FED_REFUSE_PIN_MISMATCH` with pin-PREFIX only (never full hex).
2. **Handshake** creates ephemeral session bound to `(peer_id, spki_pin)`, TTL `ORANGE5_FED_SESSION_TTL_MS` (default 15 min), clock-skew check vs `ORANGE5_FED_CLOCK_SKEW_MS` (default 60s). Sessions in-memory only — sovereign reboot invalidates every session by design.
3. **State-brief** returns ONLY keys in `STATE_BRIEF_ALLOWED_KEYS` (routing_lane, receipt_chain_head_link, guardrail_head_link, moms_law_status, federation_peer_count, last_cross_receipt_id, sovereign_awake, instance_id, instance_version, ts). Unknown keys in `ask[]` silently dropped (no key-existence leak). Provider installed via `setStateBriefProvider()`; null-padded but never fabricated when absent.
4. **Lease** — RARE by design. Requires (a) mTLS, (b) session, (c) ed25519 sovereign signature over canonical-JSON body, verified against peer's `sovereign_pubkey_pem`. Local hard caps (`ORANGE5_FED_LEASE_MAX_CALLS`, `_MAX_SECONDS`, `_CAPS`) clamp scope before local lease evaluator (`setLeaseEvaluator`) gets final say. Even a perfectly signed lease can be refused — and refusal IS a receipt.
5. **Cross-receipt** — only write surface. Verifies sovereign signature, hands peer receipt to writer installed via `setCrossReceiptWriter`. Peer receipt lands ONLY in federation cross-receipt store, NEVER spliced into this instance's audit chain.

Sovereign-signature verification: Node `crypto.verify` with `algorithm=null` (ed25519 KeyObject carries algo) over `canonicalJSON()` (sorted keys at every level, no whitespace). Signature bytes base64url.

Host wires in via `registerFederationRoutes(server, { peers, stateBriefProvider, crossReceiptWriter, leaseEvaluator, peersPath })`, then per-request checks `isFederationPath(url.pathname)` and calls `server._federationDispatch(...)`. Main boundary still rejects forbidden header families upstream.

Smoke-loaded — all 21 expected named exports resolve cleanly (including `_testResetFederationState`). No imports outside stdlib (`node:crypto`, `node:fs/promises`, `node:path`).

Caveat stated honestly: `spkiPinFromCert` depends on TLS server built with `keepRawData`; if not, refuses with hint rather than guessing. Cross-receipt SQLite schema not authored here — writer host-installed so route never touches DB directly.

---

## Smoke — 04-CONTROL-PLANE/federation/smoke.mjs (824 lines)

2-instance simulated federation test. Boots alpha + bravo as sovereign in-process instances (separate `fedDir`/`receiptsDir` per instance, deterministic per-pair cert fingerprints, independent handshake/lease/xref state).

**119 propositions** across 5 sections, all GREEN on Node v24.14.1 and Bun:

1. **Handshake** — success both directions + 5 refusal modes (`schema_mismatch`, `clock_skew`, `unknown_peer`, `cert_fingerprint_mismatch`, `missing_client_cert`)
2. **State-brief** — schema / self_id / doctrine_ref correctness, all 5 doctrine guardrails surfaced (moms_law, human_final_stop, gate_0, 27 guardrails, founder_salary), all 8 required redactions declared, defense-in-depth string-scan that no raw receipt id or host path leaks, `stale_session` refusal, malformed-constructor refusal
3. **Lease** — forbidden-action refused (`receipts.write`), wildcard refused, lawful narrow request granted, non-loopback operator-approve refused (Stop Authority), loopback approve granted, redeem with payload-hash commit, replay refused, non-loopback revoke refused, spot-check forbidden_actions set
4. **Cross-receipt** — cite success + duplicate refusal + http URL refusal + unknown_receipt refusal + correct attest verification + tampered claimed_digest refusal (`digest_mismatch`) + resolve correctness
5. **Sovereignty meta** — assert no module exports a Mom's-Law-overriding name (`writeReceipt`, `setDividend`, `disableGate`, `mutateGuardrail`, `bypassLBCE`, `overrideMomsLaw`, `setFounderSalary`)

Run-receipt written to `smoke-last-run.json`. Exit 0 on green, exit 1 on any failure.

Honest scope note in file header + this receipt: the smoke layer exercises PROTOCOL semantics via direct handler calls with synthetic peer-cert info. The mTLS wire layer requires per-pair certs the operator provisions out-of-band and is the job of a separate cert-bound integration test.

Reuses all four sibling modules' exported handlers; no protocol code duplicated. "Sibling Orange5 path as remote" is satisfied via per-instance temp dirs under `os.tmpdir()`.

---

## README — 04-CONTROL-PLANE/federation/README.md (234 lines)

Federation README tying Federation Triumvirate Doctrine to the four shipped protocol files. Each file's real behavior verified before write — README does not lie upward.

Sections:
1. Header + doctrine citation + sovereign-by-construction status line
2. Files table (one row per protocol module, honest "writes" column)
3. When to federate (rare) — five hard preconditions + three plausible uses (workstation+colo, primary+standby, kiosk+research)
4. When NOT to federate — multi-tenant SaaS, outsourcing authority, high-frequency RPC, trust-on-first-use, hostile-network exposure, consensus override
5. What federation is NOT — drift-guards: not multi-tenant, not shared state, not shared identity, not shared receipts, not session-based authority, not Mom's-Law bypass, not transitive
6. Security boundaries — four enforcement layers; sovereignty invariants cited to actual function names (`FORBIDDEN_ACTIONS`, digest verification on attest, loopback-only operator paths, self-citation refused, replay refused)
7. Operator authority — Human Final Stop, instant revoke, per-lease fresh approval, cert rotation, independent Mom's Law on each side
8. Configuration — required cert files, trusted-peers.json schema with realistic example, env var table
9. Failure modes — full enumeration from `REFUSAL`, `XREF_REFUSAL`, `LEASE_REFUSAL`
10. Boot/observe/stop — real curl invocation, real boot-line JSON, real refusal counter surface
11. Standing law short version — 5 invariants closing on Mom's Law watching the wire

Every code-level claim grounded in lines read from the four `.mjs` files (MAX_CLOCK_SKEW_MS=5000, LEASE_TTL_MAX_MS=300000, RATE_LIMIT_PER_PEER_PER_MIN=12, randomBytes(16) for sessions, FEDERATION_ALLOW_PUBLIC_BIND gate, timingSafeEqual on session lookup, FORBIDDEN_ACTIONS prefix-match descent).

---

## Evidence

- All 11 files exist at requested paths (confirmed by component reports).
- `node --check` clean on all four `.mjs` control-plane modules.
- 21/21 expected named exports resolve in `federation.mjs`.
- Federation smoke: **119 / 119 propositions GREEN** on Node v24.14.1 and Bun.
- Per-module smoke: state-brief 10/10, lease 22/22, cross-receipt 11/11.
- Doctrine doc at `C:/AtomEons/orangebox/docs/FEDERATION_TRIUMVIRATE_DOCTRINE.md` confirmed present and cross-referenced.
- Mom's Law cited at top + bottom of doctrine and README.
- No silent fallbacks — every refusal path has a named code and is observable.

## Sovereignty audit (per doctrine)

- Each Orange5 instance remains sovereign — peer-not-hierarchy.
- Local Mom's Law owned locally on both sides.
- Lease delegation explicit, signed, time-bounded, depth-1-capped, default-off.
- Sovereign override layer present (lease_revoke, peer_quarantine, peer_remove, sovereign_override).
- `runtime/node.py` not modified by any federation surface.
- 27 guardrails preserved.
- Gate 0 LBCE not bypassed (lease.mjs requires post-redeem local re-gate).
- Human Final Stop reachable — loopback-only operator-approve / revoke paths.
- `FOUNDER_SALARY_PER_INSTALL_CENTS` unaffected — no dividend mutation paths exposed.
- `ATOMEONS_IDENTITY_SECRET` not referenced by any federation module.
- Cross-receipt store separate from primary audit chain.
- No federation module exports a Mom's-Law-overriding writer (verified by smoke §5).

## Blockers

- None functional.
- Runtime requires operator to provision `<FED_DIR>/certs/{ca,server,server.key}.pem` and `<FED_DIR>/trusted-peers.json` before first daemon boot. Daemon refuses to start without them — as designed.
- A cert-bound mTLS wire-layer integration test (separate from the 119-prop protocol smoke) remains a future task.
- Cross-receipt SQLite schema is host-installed via injected writer — no DB schema authored here.

## Next action

- Operator provisions per-pair certs + `trusted-peers.json` for the first federation pair when a real second instance comes online.
- Author cert-bound mTLS wire-layer integration test in a future PR.
- Author host-side writer + schema for cross-receipt SQLite when first federation pair lights up.
- Hash + sign this receipt into the audit chain per standard receipt protocol.

---

Mom is watching. Receipts only. The federation refuses loudly or it does not federate.
