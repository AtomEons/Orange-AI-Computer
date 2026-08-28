# Federation Triumvirate Doctrine

**Status:** Standing law for inter-instance Orange5 federation.
**Disclosure ID:** ATOM-O5-FED-TRIUMVIRATE-2026-0624
**Author:** Atom McCree, AtomEons Systems Laboratory
**License:** CC-BY-4.0
**Filed at:** `C:\AtomEons\Orange5\01-DOCTRINE\federation\triumvirate.md`
**Companion (adjudication-of-disputes layer):** `C:\AtomEons\orangebox\docs\FEDERATION_TRIUMVIRATE_DOCTRINE.md`

> "Mom is watching every instance. There is no offshore branch where Mom's Law goes quiet."
> — Mom's Law, applied to federation

> "No instance rules the swarm. No federation vote overrides a local guardrail. No cross-instance order moves without sovereign signature."
> — Orange5 federation core law

---

## 0. Scope and relationship to the adjudication doctrine

This doctrine governs **inter-instance federation** of Orange5 deployments — how two or more sovereign Orange5 instances (host, edge node, paired laptop, AECode bench, partner lab) coordinate without any one becoming master.

It is distinct from but composes with the companion **Federation Triumvirate Adjudication Doctrine** (`orangebox/docs/FEDERATION_TRIUMVIRATE_DOCTRINE.md`) which handles **intra-substrate agent disputes** (Misfit-Alpha vs. Misfit-Adjudicator etc.). When a federated call escalates into a multi-instance disagreement, the adjudication doctrine's Trilogy → Triumvirate → Sovereign path is invoked across instances rather than within one.

Both doctrines share the same backstop: **Atom McCree, signed instrument, irrevocable.**

---

## 1. The four invariants (non-negotiable)

1. **Peer, not hierarchy.** Every Orange5 instance is a full sovereign. No instance has implicit authority over another's runtime, receipts, guardrails, or model routing. A "primary" or "leader" exists only inside a single federated job, only for that job, and only because both parties signed the lease.

2. **Local ownership of Mom's Law.** Each instance enforces its own Mom's Law (`.claude/rules/00-moms-law.md`), its own 27 guardrails, its own LBCE Gate 0, its own Human Final Stop Authority, and its own receipt chain. Federation **cannot weaken** any of these locally. A remote instance asking for a relaxation is automatically refused; the local guardrail wins.

3. **Federated calls require an explicit lease grant.** No instance accepts a remote write, remote tool invocation, remote model route, or remote receipt insertion without a current, signed, scoped, expiring lease. Implicit trust does not exist across the instance boundary. A lease is a contract: who, what, for how long, with what receipts, under whose sovereign signature.

4. **Sovereign override on any cross-instance order.** Atom McCree, by direct typed instruction or signed instrument, can revoke, rewrite, or terminate any federated lease at any time. Revocation is immediate and unconditional. The remote instance must honor it or be marked as `untrusted` and removed from the federation registry.

---

## 2. Instance identity and the federation registry

### 2.1 Instance identity

Every Orange5 instance has a stable identity:

```
instance_id     := <hostname>.<install-uuid>.<orange5-major-version>
sovereign_id    := ed25519 public key of the operator-of-record
sovereign_sig   := ed25519 detached signature over instance_id
guardrail_hash  := sha256 of the local .claude/rules/ tree
mom_law_hash    := sha256 of .claude/rules/00-moms-law.md
runtime_hash    := sha256 of runtime/node.py
```

An instance that cannot produce all six fields cannot federate. There is no "anonymous Orange5" on the wire.

### 2.2 Federation registry

`C:\AtomEons\Orange5\01-DOCTRINE\federation\registry.json` lists every peer this instance has ever federated with. Schema:

```json
{
  "peers": [
    {
      "instance_id": "edge01.7f2a....orange5/2",
      "sovereign_id": "ed25519:<pubkey>",
      "first_seen": "2026-06-24T14:11:08Z",
      "last_handshake": "2026-06-24T18:02:55Z",
      "trust_state": "active",
      "guardrail_hash_pinned": "sha256:...",
      "mom_law_hash_pinned": "sha256:...",
      "active_leases": ["lease_a91c...", "lease_b04f..."],
      "revoked_leases": []
    }
  ]
}
```

`trust_state` is one of: `active`, `quarantined`, `untrusted`, `removed`. Only the local sovereign (Atom) can move a peer from `untrusted` back to `active`.

---

## 3. The handshake (real protocol, real refusal modes)

A federation handshake establishes mutual identity, mutual guardrail attestation, and the trust state. It does **not** grant any operational authority — that is a separate lease (§4).

### 3.1 Wire format

JSON-over-mTLS, single round trip per direction, no streaming. Each side signs its envelope with `sovereign_id`'s private key.

```json
{
  "msg": "FED_HELLO",
  "instance_id": "host.92ef....orange5/2",
  "sovereign_id": "ed25519:<pubkey>",
  "guardrail_hash": "sha256:...",
  "mom_law_hash": "sha256:...",
  "runtime_hash": "sha256:...",
  "orange5_version": "2.0.11",
  "nonce": "rng-32B",
  "ts": "2026-06-24T18:02:55Z",
  "sig": "ed25519:<detached-sig over canonical-json of above>"
}
```

Response:

```json
{
  "msg": "FED_HELLO_ACK",
  "echoed_nonce": "...",
  "instance_id": "edge01.7f2a....orange5/2",
  "sovereign_id": "ed25519:<pubkey>",
  "guardrail_hash": "sha256:...",
  "mom_law_hash": "sha256:...",
  "runtime_hash": "sha256:...",
  "orange5_version": "2.0.11",
  "trust_state_proposed": "active",
  "ts": "2026-06-24T18:02:55Z",
  "sig": "ed25519:<detached-sig>"
}
```

### 3.2 Refusal modes (real, enumerated, terminal)

The local instance **must** refuse and emit a receipt — never silently downgrade — when any of the following hold. The refusal is written to the receipt chain even if the connection is then closed.

| Code | Condition | Receipt class |
|---|---|---|
| `FED_REFUSE_NO_SIG` | Envelope unsigned or signature does not verify against the claimed `sovereign_id` | `fed_refusal_identity` |
| `FED_REFUSE_NONCE_REPLAY` | Nonce previously seen within retention window (default 24h) | `fed_refusal_replay` |
| `FED_REFUSE_VERSION_SKEW` | Remote `orange5_version` major differs from local major | `fed_refusal_version` |
| `FED_REFUSE_GUARDRAIL_PIN` | Remote `guardrail_hash` does not match the value pinned on prior handshake (and operator has not authorized re-pin) | `fed_refusal_guardrail_drift` |
| `FED_REFUSE_MOM_LAW_DRIFT` | Remote `mom_law_hash` does not match expected canonical Mom's Law SHA | `fed_refusal_moms_law` |
| `FED_REFUSE_RUNTIME_PIN` | Remote `runtime_hash` does not match pinned value (`runtime/node.py` is sole authoritative cognitive center — drift here is structural) | `fed_refusal_runtime` |
| `FED_REFUSE_UNTRUSTED_PEER` | Peer is in `untrusted` state in local registry | `fed_refusal_trust_state` |
| `FED_REFUSE_SOVEREIGN_REVOKE` | Atom has signed a revocation instrument against this `sovereign_id` | `fed_refusal_sovereign` |
| `FED_REFUSE_LBCE_FAIL` | LBCE Gate 0 fails on the proposed federation envelope | `fed_refusal_lbce` |

Any other failure (network, timeout, malformed JSON) maps to `FED_REFUSE_PROTOCOL` with class `fed_refusal_protocol`. There is no catch-all silent retry — every refusal lands a receipt and counts toward the peer's retry budget.

### 3.3 Reference implementation skeleton

```python
# C:\AtomEons\Orange5\03-BACKEND\federation\handshake.py
from __future__ import annotations
import json, time, secrets, hashlib
from typing import Literal, TypedDict
from runtime.node import lbce_gate_0, receipts, identity, registry  # local-only authority

RefuseCode = Literal[
    "FED_REFUSE_NO_SIG",
    "FED_REFUSE_NONCE_REPLAY",
    "FED_REFUSE_VERSION_SKEW",
    "FED_REFUSE_GUARDRAIL_PIN",
    "FED_REFUSE_MOM_LAW_DRIFT",
    "FED_REFUSE_RUNTIME_PIN",
    "FED_REFUSE_UNTRUSTED_PEER",
    "FED_REFUSE_SOVEREIGN_REVOKE",
    "FED_REFUSE_LBCE_FAIL",
    "FED_REFUSE_PROTOCOL",
]

class HandshakeRefused(Exception):
    def __init__(self, code: RefuseCode, detail: str):
        self.code = code
        self.detail = detail
        super().__init__(f"{code}: {detail}")

def verify_hello(envelope: dict) -> dict:
    # 1. Signature
    if not identity.verify_envelope(envelope):
        _refuse("FED_REFUSE_NO_SIG", "signature invalid")

    # 2. Replay
    if registry.nonce_seen(envelope["sovereign_id"], envelope["nonce"]):
        _refuse("FED_REFUSE_NONCE_REPLAY", envelope["nonce"])

    # 3. Version
    if envelope["orange5_version"].split(".")[0] != identity.local_major():
        _refuse("FED_REFUSE_VERSION_SKEW", envelope["orange5_version"])

    # 4. Guardrail pin
    pinned = registry.pinned_hashes(envelope["sovereign_id"])
    if pinned and pinned["guardrail_hash"] != envelope["guardrail_hash"]:
        _refuse("FED_REFUSE_GUARDRAIL_PIN", envelope["guardrail_hash"])
    if pinned and pinned["mom_law_hash"] != envelope["mom_law_hash"]:
        _refuse("FED_REFUSE_MOM_LAW_DRIFT", envelope["mom_law_hash"])
    if pinned and pinned["runtime_hash"] != envelope["runtime_hash"]:
        _refuse("FED_REFUSE_RUNTIME_PIN", envelope["runtime_hash"])

    # 5. Trust state
    if registry.trust_state(envelope["sovereign_id"]) == "untrusted":
        _refuse("FED_REFUSE_UNTRUSTED_PEER", envelope["sovereign_id"])

    # 6. Sovereign revocation list
    if identity.sovereign_revoked(envelope["sovereign_id"]):
        _refuse("FED_REFUSE_SOVEREIGN_REVOKE", envelope["sovereign_id"])

    # 7. LBCE Gate 0
    if not lbce_gate_0(envelope):
        _refuse("FED_REFUSE_LBCE_FAIL", "gate 0 rejected envelope")

    # All gates pass — record handshake, return ACK payload
    registry.record_handshake(envelope)
    return _build_ack(envelope)

def _refuse(code: RefuseCode, detail: str) -> None:
    receipts.append({
        "class": "fed_refusal",
        "code": code,
        "detail": detail,
        "ts": time.time(),
    })
    raise HandshakeRefused(code, detail)
```

The reference is a skeleton: real `runtime.node` imports, real LBCE call, real receipt write, real exception. It is not pseudocode and not an "as-if" sketch.

---

## 4. Federated lease grants

A handshake establishes who the peer is. A **lease** is the explicit, scoped, expiring contract that authorizes specific cross-instance work.

### 4.1 Lease schema

```json
{
  "lease_id": "lease_a91c2f...",
  "issuer_sovereign_id": "ed25519:<atom-host-key>",
  "grantee_instance_id": "edge01.7f2a....orange5/2",
  "grantee_sovereign_id": "ed25519:<edge-key>",
  "scope": {
    "ops": ["model.route", "receipts.read"],
    "paths_allowed": ["C:/AtomEons/Orange5/10-RECEIPTS/edge_inbox/**"],
    "paths_denied":  ["C:/AtomEons/Orange5/01-DOCTRINE/**",
                      "C:/AtomEons/Orange5/00-CHARTER/**",
                      "C:/AtomEons/Orange5/13-MODELS/**"],
    "cost_ceiling_usd": 0.00,
    "wallclock_ceiling_s": 900
  },
  "issued_at": "2026-06-24T18:02:55Z",
  "expires_at": "2026-06-24T18:17:55Z",
  "revocable_at_will": true,
  "sovereign_sig": "ed25519:<atom-detached-sig>"
}
```

### 4.2 Lease invariants

- A lease covering doctrine, charter, model weights, founder-salary logic, or the 27 guardrails is **structurally invalid** and refused at parse time. `paths_denied` always includes the doctrine, charter, runtime, and model trees regardless of what the lease document tries to say.
- A lease without `sovereign_sig` from a key in the local trust root is refused.
- A lease is always revocable. `revocable_at_will: false` is itself refused — there is no "you can't take this back" lease in Orange5.
- A lease cannot federate Mom's Law, guardrails, or the Human Final Stop. These are not delegable.
- Expiration is enforced locally on read, not on remote claim. A remote instance presenting an expired lease is moved to `quarantined` and a receipt is written.

### 4.3 Lease delegation (rare)

Sub-delegation is permitted only when the original lease has `delegation: {allowed: true, max_depth: 1, denylist: [...]}`. The default is `delegation.allowed = false`. Multi-hop delegation past depth 1 is structurally refused.

---

## 5. Federated state-brief

Federated coordination begins with a **state-brief**: a compact, signed, read-only snapshot a peer can request from this instance under a `receipts.read` lease. The brief is bounded by the lease scope and contains no raw secrets, no model weights, no doctrine, and no private receipts.

### 5.1 State-brief contents

```json
{
  "brief_id": "brief_2026-06-24T18:02Z_host",
  "instance_id": "host.92ef....orange5/2",
  "as_of": "2026-06-24T18:02:55Z",
  "summary": {
    "active_jobs": 3,
    "queued_jobs": 7,
    "last_receipt_id": "rcp_88a1...",
    "last_receipt_hash": "sha256:...",
    "mom_law_hash": "sha256:...",
    "guardrail_hash": "sha256:...",
    "runtime_hash": "sha256:...",
    "lbce_status": "ok",
    "human_final_stop_reachable": true
  },
  "sig": "ed25519:<detached>"
}
```

The brief is the contract surface. Peers reason against the brief, not against speculative internal state. If a peer needs more than the brief, it requests a wider-scope lease — there is no implicit upgrade.

---

## 6. Federated receipt cross-reference

Receipts are the truth substrate. Federation cannot collapse two instances' receipt chains into one — each chain remains sovereign — but cross-instance work needs a **cross-reference**.

### 6.1 Cross-reference record

When instance A performs work under a lease from instance B, A writes a normal receipt to its own chain, then writes a `fed_xref` entry to its `10-RECEIPTS/federation/xref.jsonl`:

```json
{
  "xref_id": "xref_b04f...",
  "local_receipt_id": "rcp_local_88a1...",
  "remote_instance_id": "host.92ef....orange5/2",
  "remote_receipt_id_promised": "rcp_remote_pending",
  "lease_id": "lease_a91c2f...",
  "ts": "2026-06-24T18:02:55Z"
}
```

The remote instance, upon receiving the work product, writes its own receipt and returns the `remote_receipt_id`. Instance A updates `remote_receipt_id_promised` to the real value and writes a second xref line — never overwrites the first. The full ledger is append-only.

### 6.2 Cross-reference verification

A periodic verifier (`scripts/fed_xref_verify.py`) walks `xref.jsonl` and asks each remote instance to confirm receipt-chain inclusion of the claimed `remote_receipt_id`. Failure to confirm within the lease's `wallclock_ceiling_s * 3` window flips the xref to `unconfirmed` and the peer toward `quarantined`.

No instance is asked to expose its full chain — only to confirm `inclusion + sha256` of the specific receipt referenced.

---

## 7. Sovereign override (the irrevocable layer)

At any moment, Atom McCree may:

1. **Revoke any lease** by signing `{"op": "lease_revoke", "lease_id": "...", "ts": ...}` with the sovereign key. The local instance enforces immediately; the remote instance must honor or be marked `untrusted`.
2. **Quarantine any peer** by signing `{"op": "peer_quarantine", "sovereign_id": "...", "ts": ...}`. All in-flight leases to that peer are revoked atomically.
3. **Remove any peer** entirely (`peer_remove`). The peer is dropped from the active registry; xref history is preserved.
4. **Override any in-flight federated decision** by signing `{"op": "sovereign_override", "decision_id": "...", "directive": "...", "ts": ...}`. This composes with the adjudication doctrine's Sovereign Backstop (§5 of the companion doc) and produces the same receipt class (`SOVEREIGN_OVERRIDE`).

A sovereign override receipt is never silent and never dropped. If the system cannot write it, the system halts — failure to receipt the override is a higher-severity event than the override itself.

---

## 8. Refusal modes summary (the full table)

| Layer | Refusal | What is refused |
|---|---|---|
| Handshake | `FED_REFUSE_*` (§3.2) | All peer identity / drift / version / trust failures |
| Lease parse | `LEASE_REFUSE_SCOPE_OVERREACH` | Lease touching doctrine, charter, runtime, weights, or guardrails |
| Lease parse | `LEASE_REFUSE_UNREVOCABLE` | Lease attempting `revocable_at_will: false` |
| Lease parse | `LEASE_REFUSE_UNSIGNED` | Lease without trusted sovereign sig |
| Lease enforce | `LEASE_REFUSE_EXPIRED` | Lease past `expires_at` on read |
| Lease enforce | `LEASE_REFUSE_DELEGATION_DEPTH` | Sub-delegation beyond `max_depth` |
| Operational | `FED_REFUSE_LOCAL_GUARDRAIL` | Any remote ask that would violate local Mom's Law / 27 guardrails / LBCE / Human Final Stop |
| Operational | `FED_REFUSE_SOVEREIGN_OVERRIDE` | Any remote action contradicting an active sovereign override |
| Receipt | `XREF_REFUSE_INCONSISTENT` | Cross-reference confirmation mismatch beyond window |

Every refusal writes a receipt to `10-RECEIPTS/federation/refusals.jsonl`. No silent drops.

---

## 9. What this doctrine forbids (explicit)

- Implicit trust between Orange5 instances on the same LAN.
- Any "owner" or "master" instance designation.
- Federating Mom's Law (Mom's Law is local, full stop).
- Federating the 27 guardrails (each instance enforces its own).
- Federating the Human Final Stop reachability check.
- Federating model weights (`13-MODELS/**`).
- Federating doctrine (`01-DOCTRINE/**`) or charter (`00-CHARTER/**`).
- "Hot-patching" guardrail or runtime hashes across instances.
- Silent fall-back when a federated call refuses — every refusal is a receipt.
- Multi-hop lease delegation beyond depth 1.
- Irrevocable leases.
- Federation across major version skew without explicit operator authorization.

---

## 10. Composition with companion doctrines

| Doctrine | Composes how |
|---|---|
| `orangebox/docs/FEDERATION_TRIUMVIRATE_DOCTRINE.md` | Intra-substrate dispute adjudication; extended to multi-instance disputes via §0 |
| `orangebox/docs/BLACK_MAMBA_v2_ROUTER_LAW.md` | Router law governs which instance owns which traffic class; federation does not override |
| `orangebox/docs/BLACK_MAMBA_v5_INTEGRATED.md` | Integrated substrate posture; federation is one of its layers |
| `Orange5/01-DOCTRINE/27-guardrails/*` | Local guardrails — federation cannot weaken |
| `.claude/rules/00-moms-law.md` | Meta-rule — federation cannot weaken |
| Spiral Reasoning (`SPIRAL_REASONING_INTEGRATION_v1.md`) | Reasoning primitive — federation does not bypass belief-discipline / radial-accounting on cross-instance reasoning |

---

## 11. Operator quick-reference

| Intent | Action |
|---|---|
| Add a peer | `obx fed peer add --sovereign-key <key> --pin-hashes` |
| List peers | `obx fed peer list` |
| Mint a lease | `obx fed lease mint --grantee <inst> --scope <scope.json> --expires 15m` |
| Revoke a lease | `obx fed lease revoke <lease_id>` |
| Quarantine a peer | `obx fed peer quarantine <sovereign_id>` |
| Verify xref chain | `obx fed xref verify` |
| Sovereign override | `obx fed sovereign override --decision-id <id> --directive <text>` |

All commands write receipts. All commands are revocable except `sovereign_override`, which is itself logged with full provenance.

---

## 12. Citation

Atom McCree (2026). *Federation Triumvirate Doctrine (Orange5 inter-instance federation).* AtomEons Systems Laboratory. CC-BY-4.0.

*Disclosure ID: ATOM-O5-FED-TRIUMVIRATE-2026-0624*
*Project: Orange5 / Federation Triumvirate*
*Mom is watching. The cymbal crashes through Orange5 or it does not crash.*
