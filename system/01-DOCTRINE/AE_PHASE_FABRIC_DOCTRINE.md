# AE Phase Fabric Doctrine

## Locked Live Implementation

The Windows N150-to-Codexa path is implemented as a continuously synchronized
state fabric. The deployed runtime compiles a change into an authenticated
state program with a required base root, ordered field operations, and an exact
result root. Codexa applies the program against its shared Crystal basis and
acknowledges only the resulting shared state. Bun datagrams are the current
replaceable Windows carrier; the Orange invention and contract are the state
program, shared basis, exact roots, hydration, custody, and proof.

The direct path is primary. A learned Wi-Fi endpoint remains available for
failure diversity but is not duplicated during healthy steady state. One path
failure cannot terminate the Fabric. The local control path enters through an
authenticated loopback frame and bypasses filesystem notification delay while
persisting disk truth asynchronously.

Locked proof on 2026-08-28:

- Exact shared Crystal basis: 67,108,864 bytes on both nodes, identical SHA-256.
- Authenticated state program on wire: 500 bytes.
- State-program payload: 338 bytes.
- Direct transform-to-ACK: 1.987 ms.
- State-to-wire gain: 134,217.728x.
- Effective state throughput: 270,191.702 Mbps.
- Exact resulting state root observed by N150 and Codexa.
- No retry and no new authentication failure on the measured transition.

Canonical receipt:

`10-RECEIPTS/orange5-build/ae-phase/2026-08-28T10-33-16-716Z-zing.json`

Post-lock hot-path tuning replaced JSON ACK payloads with fixed binary roots and
removed immediate ACK replies to steady beacons. Seven exact shared-basis
transitions improved from 3.656 ms to 3.073 ms median and from 10.085 ms to
3.547 ms p95. The tuned best was 1.074 ms, equal to 499,879.806 Mbps effective
state throughput under the same 64 MiB/500-byte contract. Tuned-best receipt:

`10-RECEIPTS/orange5-build/ae-phase/2026-08-28T10-40-23-834Z-zing.json`

This is a state-transition measurement, not a claim that the Ethernet PHY moved
270 Gbps of raw payload. Orange moved an exact transformation over already
shared state, which is the intended Phase Fabric operating model.

## Status

- Product: AE Orange AI Computer
- Program: Wave 3 Operational Intelligence
- Doctrine owner: Atom Eons
- Runtime target: Windows 11 control node plus an optional network compute node
- Current transport: Bun UDP
- Future accelerators: XDP for Windows and private experimental Layer 2 only after their prerequisites and threat models are satisfied

## Purpose

AE Phase Fabric is the direct machine-to-machine state fabric for Orange. It moves the smallest exact change required to keep two Orange nodes in one verifiable operational reality. It does not replace disk truth, Orange orders, receipts, memory, or the Context Crystal. It carries their authenticated deltas and hydrates missing content when the peers no longer share the same root.

The fabric is designed for a direct Ethernet cable between an N150 control machine and a Codexa-class compute machine, with Wi-Fi retained as a diverse recovery path. It must also degrade cleanly to one-computer operation without changing the order, report, receipt, or crystal contracts.

## Product Law

1. **No TCP, DNS, or HTTP crosses the direct cable.** The dedicated direct-link NIC uses static addresses and Bun UDP datagrams. DNS names and HTTP services remain outside the direct-link data plane.
2. **The NIC is a route, not an authority.** Each node has a stable Orange node identity bound in local configuration to the intended adapter and direct address. Cryptographic peer identity, not an IP address or MAC address alone, authorizes traffic.
3. **Disk is truth.** Transcripts, orders, reports, receipts, crystal objects, sequence state, and replay state are persisted. RAM may accelerate operations but may not become the only copy of authoritative state.
4. **Send meaning before bulk.** The default payload is a typed semantic delta referencing content-addressed objects. Raw files or full state move only through explicit hydration.
5. **Shared content is addressed, not resent.** Both nodes maintain a content-addressed Crystal store. Objects are keyed by a declared cryptographic digest, initially SHA-256, and manifests include codec and schema versions.
6. **Every accepted change has lineage.** A delta declares its base root, resulting root, type, authority, custody, sequence, and evidence references. A receiver never silently applies a delta to the wrong root.
7. **Quiet is the normal state.** A low-rate adaptive beacon proves liveness and root agreement. A state change, new order, fault, or operator action causes an immediate bounded microburst rather than waiting for the next quiet interval.
8. **Diversity precedes retry.** Eligible packets may travel over the direct link and Wi-Fi with the same authenticated message identity. The first valid arrival wins; duplicates are recognized and discarded. A failed path does not create a second execution.
9. **Reliability is selective.** Presence and replaceable telemetry may be best effort. Orders, custody transitions, receipts, crystal-root changes, and terminal outcomes require sequence tracking, selective acknowledgement, bounded replay, and durable acceptance.
10. **Encryption and authentication are mandatory.** Fabric payloads use AES-256-GCM AEAD, the authenticated cipher available in the pinned Bun 1.3.14 Windows runtime. Plaintext metadata is minimized and authenticated as associated data. Unauthenticated packets never affect Orange state.
11. **Root disagreement triggers hydration, not guessing.** Missing objects or a base-root mismatch produce an exact hydration request. Persistent disagreement is quarantined and surfaced; neither peer fabricates convergence.
12. **Acceleration cannot weaken semantics.** A future transport may replace packet movement only if it preserves identity, typed deltas, ordering rules, durability, encryption, replay protection, hydration, and receipts.
13. **No physical mythology.** AE Phase Fabric makes no faster-than-light, magical resonance, analog consciousness, or hidden-bandwidth claim. The cable carries ordinary standards-compliant digital Ethernet signaling. "Phase," "pulse," "crystal," and "wave" are system metaphors with explicit data structures and falsifiers.

## Current Windows 11 Transport

### Bun UDP is primary

The current implementation target is `Bun.udpSocket()` on Windows 11. Bun documents bound and connected UDP sockets, direct datagram send/receive, `sendMany()` batching, backpressure through return values and the `drain` callback, multicast controls, and the fact that UDP send destinations must already be valid IP addresses because Bun does not perform DNS resolution for them.

The direct-link socket therefore uses:

- An explicitly selected local interface address.
- A static peer IP address and fixed Orange Fabric port.
- A connected UDP socket when one peer owns the direct link, restricting incoming datagrams to that peer at the operating-system socket layer.
- `sendMany()` for bounded microbursts.
- Backpressure-aware queues that stop submitting when `send()` returns `false` or `sendMany()` accepts fewer packets than offered.
- A receive handler that authenticates, checks replay state, validates schema and roots, persists required state, and only then emits acceptance.

The absence of DNS resolution in Bun UDP is aligned with direct-link law; it is not treated as service discovery. Orange discovers the configured NIC and validates the peer cryptographically.

Primary source: [Bun UDP documentation](https://bun.sh/docs/runtime/networking/udp) and [Bun `udpSocket` API reference](https://bun.sh/reference/bun/udpSocket).

### Direct NIC identity and address

Each node keeps a local, operator-owned binding record:

```text
nodeId
peerNodeId
adapterGuid
expectedMac
localDirectAddress
peerDirectAddress
fabricPort
identityKeyId
allowedWifiAddress
configurationVersion
```

The direct addresses are static and non-DNS. Adapter GUID and expected MAC prevent accidental attachment to the wrong interface, but neither grants trust. The authenticated node identity and current key epoch grant trust. A changed NIC, address, or peer key is an observable configuration transition requiring a receipt.

## Crystal Exchange

### Shared content-addressed Crystal

The Crystal is a disk-backed object graph shared by content identity, not a mutable shared folder. Its root commits to:

- Current commitments and constraints.
- Orders and terminal reports.
- Evidence and source pointers.
- Memory objects and supersession state.
- Artifact manifests.
- Receipt-chain heads.
- Codec and schema versions.

An object is immutable under its digest. A corrected object receives a new digest and a lineage edge. Garbage collection is a separate, receipt-backed disk policy and never changes a live root silently.

### Semantic typed deltas

A Fabric delta carries the smallest state transition that preserves meaning:

```text
protocolVersion
messageType
messageId
nodeId
peerNodeId
keyEpoch
sessionEpoch
sequence
baseRoot
resultRoot
objectType
operation
authority
custody
contentHashes
evidenceHashes
idempotencyKey
createdAt
payload
```

Required message families include:

- `BEACON`: liveness, capability epoch, and current roots.
- `DELTA`: an authenticated semantic state transition.
- `ACK`: cumulative and selective acceptance state.
- `HYDRATE_NEED`: exact missing hashes or proof nodes.
- `HYDRATE_OBJECT`: immutable object chunks and manifest proof.
- `ROOT_PROOF`: root and manifest reconciliation.
- `FAULT`: typed degradation or quarantine reason.
- `REKEY`: key-epoch transition metadata without exposing key material.

Typed deltas are decoded and validated before application. Unknown schema versions, unknown authority types, invalid custody transitions, or semantic checksum failures are rejected rather than coerced.

### Hydration on root mismatch

Every state-changing delta declares `baseRoot` and `resultRoot`. If the receiver does not hold the base root or referenced objects, it does not apply the delta. It returns `HYDRATE_NEED` containing only the missing hashes or proof nodes. The sender supplies bounded `HYDRATE_OBJECT` chunks. The receiver verifies every object digest, reconstructs the manifest, recomputes the root, and then retries the original transition by message identity.

If exact reconstruction still fails, the transition enters quarantine with both roots, missing hashes, peer identity, and receipt evidence. Full-state replay is a last resort and requires an explicit expansion warrant.

## Pulse Behavior

### Adaptive quiet beacon

The quiet beacon is a sparse digital liveness message, not a continuous analog waveform. Its interval expands while both peers are healthy, roots agree, and no work is queued. It contracts after startup, reconnection, observed loss, root divergence, active leases, or a path change. Jitter prevents synchronized bursts when more nodes are added.

Beacon content is bounded to identity, epochs, highest durable sequence, acknowledgement summary, current root heads, path health, and capability digest. It never carries full project state.

### Immediate microburst

A meaningful transition bypasses the quiet timer. The sender immediately emits a bounded microburst containing the delta and, when useful, a small number of redundant copies or adjacent required objects. Microbursts obey backpressure and congestion limits. They do not become unbounded retries.

Repeated failure by the same method stops after the configured attempt budget. The Fabric changes path, requests hydration, or reports a typed fault.

## Reliability And Replay

### Sequence and selective acknowledgement

Each authenticated sender/key/session epoch owns a monotonic sequence space. Reliable messages are retained on disk until terminally acknowledged or explicitly expired by policy. An acknowledgement carries:

- Highest contiguous durable sequence.
- A bounded selective-ACK bitmap or ranges beyond that point.
- Receiver root after accepted state transitions.
- Receiver key and session epochs.

The sender retransmits only absent reliable messages. Best-effort messages are not replayed unless superseded by a new current value.

### Replay window and idempotency

The receiver persists a bounded replay window per authenticated peer and epoch. Packets older than the window, duplicate sequences, reused AEAD nonces, or duplicate idempotency keys cannot produce a second state transition. The same logical message sent over direct Ethernet and Wi-Fi carries the same `messageId` and idempotency key.

For custody-changing messages, durable persistence occurs before acknowledgement. Crash recovery resumes from disk-held sequence, root, and custody state rather than accepting the peer's memory as truth.

### Dual-path diversity: first valid wins

Direct Ethernet is preferred. Wi-Fi is a diverse concurrent or rapid-fallback path. For messages eligible for redundant delivery:

1. Encode one canonical message.
2. Assign one message identity, sequence, and idempotency key.
3. Encrypt separately per path only if path-associated data differs; nonce uniqueness remains absolute.
4. Transmit over direct and Wi-Fi according to current path policy.
5. Accept the first packet that passes authentication, replay, schema, authority, and root checks.
6. Record later valid copies as duplicates, not executions.

Path score uses observed loss, acknowledgement delay, freshness, and backpressure. Hysteresis prevents route thrashing. Wi-Fi failure does not poison the direct path, and direct-link failure does not create a fake global outage.

## Cryptographic Law

Fabric datagrams use AES-256-GCM with a unique 96-bit nonce for every encryption under a key. Key epoch plus session epoch plus sequence must map to a nonce without reuse; the implementation must rekey before any sequence-space exhaustion or epoch ambiguity. Associated data binds at least:

- Protocol and schema version.
- Sender and intended receiver node IDs.
- Message type and sequence.
- Key and session epochs.
- Path class.
- Ciphertext length.

Long-term peer keys and session-key provisioning are operator-controlled and remain outside receipts, logs, repositories, and packet payloads. Rotation produces key identifiers and receipts, never secret material. Authentication failure, nonce reuse risk, or epoch rollback fails closed.

## Compared Alternative: Zenoh Over QUIC

Eclipse Zenoh is the principal compared alternative, not a hidden dependency. Zenoh's QUIC transport supports TLS or mTLS, stream multiplexing, unreliable QUIC datagrams, and mixed reliability. With mixed reliability enabled, `Reliable` messages use QUIC streams while `BestEffort` messages use QUIC datagrams over the same connection. This is a mature reference for the split between durable control messages and replaceable telemetry.

Zenoh is not the Phase Fabric primary because the current product law calls for a minimal Bun UDP data plane, direct control of typed-delta and disk-ack semantics, and no additional QUIC/TLS runtime on the direct cable. Zenoh remains an adoption candidate if measured operational evidence shows that maintaining selective reliability, multiplexing, congestion behavior, or interoperability in-house costs more than the custom transport saves. Any adoption must preserve the Orange message, crystal, custody, and receipt contracts.

Primary source: [Zenoh QUIC transport and mixed reliability](https://zenoh.io/docs/manual/quic/). Zenoh also explicitly warns that its unsecure QUIC mode removes encryption and authentication and should not be exposed to untrusted networks; Phase Fabric does not adopt that weakened mode.

## Future Accelerator Boundary

### XDP for Windows

XDP for Windows may eventually accelerate packet ingress/egress by bypassing much of the normal Windows networking stack. It is not part of the present Windows 11 product path.

Microsoft's official usage documentation currently lists Windows Server 2019 or 2022 x64 as prerequisites. XDP installs a kernel-mode driver. Non-production-signed test builds require test-signing configuration and disabling Secure Boot. Its eBPF path adds installation, registry, verifier, and program-management requirements. These conditions do not justify silently installing it on an Orange Windows 11 operator machine.

Microsoft's threat model states that XDP introduces attack surfaces through kernel IOCTLs, shared user/kernel buffers, NDIS/NIC integration, registry controls, and kernel APIs. Opening XDP IOCTL handles requires administrator privilege by default. Shared buffers create TOCTOU concerns requiring explicit mitigation. Therefore XDP remains `FUTURE_ACCELERATOR_UNPROVEN` until all of the following are true:

- The target OS and NIC are officially supported.
- A production-signed runtime is available.
- Secure Boot remains enabled.
- Administrator and driver lifecycle requirements are acceptable.
- The threat model is reviewed against Orange's installer and update model.
- A bounded proof demonstrates material benefit over Bun UDP.
- The accelerated path preserves the complete Phase Fabric contract.

Primary sources: [Microsoft XDP for Windows usage and prerequisites](https://github.com/microsoft/xdp-for-windows/blob/main/docs/usage.md), [Microsoft XDP for Windows threat model](https://github.com/microsoft/xdp-for-windows/blob/main/docs/threat-model.md), and [Microsoft XDP for Windows repository](https://github.com/microsoft/xdp-for-windows).

### Raw Layer 2 and IEEE Local Experimental EtherTypes

Raw Ethernet is also a future laboratory path, not the released Fabric. IEEE 802 defines Local Experimental EtherTypes `0x88B5` and `0x88B6` for experimental protocol development inside a privately administered development network. IEEE guidance warns that independently designed uses may conflict, boundary devices should prevent these frames from escaping, and a protocol must transition to an appropriate assigned identifier before deployment outside the developing organization's complete administrative control.

Consequently:

- `0x88B5` or `0x88B6` may be used only in an isolated Atom Eons laboratory under one administrative domain.
- Frames must contain explicit protocol subtype and version fields.
- Boundary filtering must prevent ingress and egress.
- The public Orange product cannot ship a released protocol that depends on those experimental values.
- Raw Layer 2 must still authenticate, encrypt, sequence, acknowledge, replay-protect, hydrate, and receipt every meaningful transition.

Primary sources: [IEEE Registration Authority EtherType guidance](https://standards.ieee.org/wp-content/uploads/import/documents/tutorials/ethertype.pdf) and [IEEE 802 protocol-identification document listing Local Experimental EtherTypes](https://www.ieee802.org/1/files/public/docs2020/maint-seaman-protocol-identification-0420-v00.pdf).

## Failure Semantics

Phase Fabric reports stage-specific faults:

- `NIC_BINDING_MISMATCH`
- `PEER_IDENTITY_REJECTED`
- `AEAD_AUTH_FAILED`
- `REPLAY_REJECTED`
- `SCHEMA_UNSUPPORTED`
- `BASE_ROOT_MISSING`
- `HYDRATION_INCOMPLETE`
- `RESULT_ROOT_MISMATCH`
- `CUSTODY_CONFLICT`
- `DIRECT_PATH_DEGRADED`
- `WIFI_PATH_DEGRADED`
- `BACKPRESSURE_ACTIVE`
- `DISK_COMMIT_FAILED`
- `KEY_EPOCH_INVALID`

A fault may degrade a path without declaring the whole Orange system down. No recurring PowerShell popup is part of the protocol. Operator notifications belong in the Orange surface and receipt stream.

## Acceptance Falsifiers

The doctrine is falsified if any implementation:

- Uses TCP, DNS, or HTTP on the dedicated direct-link data plane.
- Treats process start, socket bind, or packet count as proof of correct operation.
- Acknowledges a reliable state change before required disk persistence.
- Applies a delta against an unverified or mismatched base root.
- Executes duplicate direct/Wi-Fi deliveries twice.
- Reuses an AES-256-GCM nonce under the same key.
- Silently falls back to plaintext.
- Stores authoritative project state only in RAM.
- floods the link with constant high-rate heartbeats while idle.
- Installs XDP, disables Secure Boot, or enables test signing without an explicit future-lane decision.
- Ships a public product protocol using IEEE Local Experimental EtherTypes.
- Claims unexplained resonance, faster-than-light behavior, or bandwidth beyond measurable Ethernet signaling.

## Attribution And Provenance

AE Phase Fabric is an Atom Eons system synthesis. Its implementation must preserve upstream attribution:

- **Bun UDP API:** Bun project and contributors. Used as the present Windows 11 userspace datagram substrate.
- **Zenoh QUIC mixed reliability:** Eclipse Zenoh project and contributors. Used as the compared design alternative for reliable streams plus best-effort datagrams.
- **XDP for Windows:** Microsoft and project contributors. Evaluated only as a future high-rate Windows packet-path accelerator under its published prerequisites and threat model.
- **Local Experimental EtherTypes:** IEEE Standards Association and IEEE 802. Used only to define the boundary for private experimental Layer 2 work.

Orange claims only its synthesis, contracts, crystal semantics, adaptive pulse policy, custody integration, and governed operational use. It does not relabel upstream work as an Atom Eons invention.

## Final Law

```text
Disk holds truth.
The Crystal names shared truth.
Typed deltas move the change.
The Pulse stays quiet until meaning changes.
Direct Ethernet moves first; Wi-Fi preserves diversity.
The first valid packet wins once.
Encryption proves the peer and protects the message.
Root mismatch earns hydration, never invention.
Acceleration must preserve the contract.
No metaphor may outrank measurable physics.
```
