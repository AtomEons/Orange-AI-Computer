# AE Phase Fabric

## Proof-Carrying State Synchronization for the Orange AI Computer

**Authors:** Atom Eons and Daybreak Blue
**Organization:** Atom Eons Systems Laboratory
**Date:** 2026-08-28
**Implementation status:** Live on the N150 control computer and Codexa heavy-compute computer

---

## Abstract

AE Phase Fabric is a proof-carrying state synchronization system for the
Orange AI Computer. It is designed for a pair or mesh of computers that already
share a large disk-backed basis of software, models, artifacts, memory, and
receipts. Instead of repeatedly transporting that basis, the Fabric compiles a
change into the smallest exact state program that transforms one verified root
into another. The receiving node executes the program locally, verifies the
resulting root, and acknowledges the new shared reality.

The current Windows implementation uses Bun datagrams as a replaceable carrier
on a direct N150-to-Codexa Ethernet link. The carrier is not the invention. The
invention is the combination of a shared Crystal basis, deterministic state
programs, base/result-root proofs, selective reliability, exact hydration,
custody integration, and measured state-equivalent throughput.

A live proof changed a 64 MiB exact shared Crystal state using a 338-byte state
program inside a 500-byte authenticated frame. Codexa observed the exact target
root and acknowledged the transition in 1.987 ms without retry. This produced a
134,217.728x state-to-wire gain and 270,191.702 Mbps of effective state
throughput. This is not a raw-PHY bandwidth claim. It measures how much exact
shared state changed per unit of wire work and elapsed acknowledgement time.

---

## 1. Problem

Conventional distributed systems tend to move one of three things:

1. Entire objects.
2. Byte patches against those objects.
3. Requests whose meaning depends on hidden application state.

An AI computer has a different opportunity. Its nodes often already possess the
same project, model library, receipts, source history, codecs, and deterministic
tools. Retransmitting those materials wastes bandwidth, CPU time, storage
writes, model context, and operator attention. Sending an under-specified
request is smaller but creates ambiguity and drift.

AE Phase Fabric addresses both failures. It sends an exact executable change
against a named basis and requires proof of the resulting state.

The design objective is:

```text
Move the least information necessary to create the exact intended state.
```

## 2. Core Insight

The useful capacity of a synchronized system is not limited to the number of
new payload bytes transported on every transition. If two machines share a
verified basis, a small program can select, compose, or transform a much larger
state already available on both machines.

Let:

- `B` be the shared basis.
- `R0` be the verified root before a transition.
- `P` be a deterministic state program.
- `R1` be the expected root after the transition.
- `Apply(B, R0, P)` be the receiver's deterministic evaluation.

Acceptance requires:

```text
Hash(Apply(B, R0, P)) = R1
```

The sender does not earn an acknowledgement because a packet arrived. It earns
an acknowledgement because the receiver reached the exact declared state.

This separates three quantities that are often confused:

- **Raw carrier throughput:** physical bits per second on the link.
- **Program throughput:** state-program bytes transported per second.
- **Effective state throughput:** exact materialized state changed per second.

The third can greatly exceed the first when the shared basis and state program
provide a large deterministic gain.

## 3. Architecture

```text
Disk truth
  -> shared Crystal basis
  -> current verified state root
  -> state-program compiler
  -> authenticated Phase frame
  -> direct carrier
  -> receiver program evaluator
  -> result-root verifier
  -> acknowledgement
  -> disk receipt and event lineage
```

### 3.1 Disk truth

Authoritative project data, memory, artifacts, transcripts, and receipts remain
on disk. Phase Fabric does not turn volatile memory into the master copy.

### 3.2 Shared Crystal basis

The basis is content-addressed. A content digest identifies immutable bytes or
a deterministic object definition. A correction creates a new digest and
lineage edge rather than silently mutating the old object.

### 3.3 State program

The live compiler currently emits compact typed operations:

```text
SET(field, value)
REMOVE(field)
```

Each non-snapshot program declares:

```text
kind
baseRoot
resultRoot
ordered operations
```

The opcode representation is deliberately numeric on the hot path. Human
renderings remain available in receipts and tooling.

### 3.4 Hydration

If the receiver lacks the declared base or a referenced Crystal object, it does
not invent the missing state. It requests only the missing proof nodes or
objects. Full replay is a last resort.

## 4. Protocol

The current authenticated frame has a fixed 48-byte header and a 16-byte
AES-256-GCM tag.

```text
magic              4 bytes
version            1 byte
type               1 byte
flags              2 bytes
sender hash        8 bytes
epoch              8 bytes
sequence           4 bytes
ack base           4 bytes
ack bitmap         4 bytes
state-root prefix  8 bytes
payload length     4 bytes
ciphertext         variable
authentication tag 16 bytes
```

Current message families:

- `HELLO`
- `BEACON`
- `DELTA`
- `ACK`
- `HYDRATE_REQUEST`
- `HYDRATE_SNAPSHOT`
- `CLOSE`

The receive window rejects replayed sequence numbers. Reliable transitions are
held pending until acknowledged. Retry is bounded. Repeated failure changes the
path or reports a typed fault instead of retrying forever.

## 5. Direct-First Path Policy

The N150 control node currently has two paths to Codexa:

- Direct Ethernet: `10.0.99.2 -> 10.0.99.1`
- AE Wi-Fi: `10.0.0.176 -> 10.0.0.4`

The direct path is preferred during healthy operation. Wi-Fi remains a diverse
recovery path. The runtime learns both endpoints but sends steady-state frames
only to the highest-ranked healthy endpoint. A failed secondary endpoint cannot
terminate the Fabric. Failure cooling and path preference prevent thrashing.

No DNS lookup and no TCP connection are used on the dedicated direct data path.
The current carrier is a Bun UDP socket because Windows 11 exposes it without a
custom kernel driver. This carrier can be replaced without changing the Phase
state, proof, custody, hydration, or receipt contracts.

## 6. Security Properties

The live implementation provides:

- AES-256-GCM authenticated encryption.
- Sender-specific keys derived from an operator-owned base key.
- Unique epoch and sequence inputs for nonce construction.
- Header authentication as AEAD associated data.
- Replay-window enforcement.
- Literal-IP direct targets.
- No secret material in source, receipts, or packet payloads.
- Exact state-root validation after transition application.

A packet with an invalid tag, sender, version, sequence, operation, base root, or
result root cannot create an accepted state transition.

## 7. Hot-Path Optimization

The deployed path includes these optimizations:

1. A persistent socket and synchronized peer session.
2. Numeric field and operation codes.
3. Sender-key derivation caching.
4. Immediate authenticated loopback injection on the N150.
5. No filesystem watcher in the measured control-to-wire path.
6. Asynchronous persistence after the in-memory transition is emitted.
7. Batched datagram submission when appropriate.
8. Direct-first endpoint selection.
9. Isolated path failures rather than process termination.
10. Exact monotonic-clock transform-to-ACK instrumentation.

The filesystem remains truth, but filesystem notification latency is no longer
part of immediate signal dispatch.

## 8. Measurement Definitions

For a measured transition:

```text
stateGain = stateEquivalentBytes / wireBytes

effectiveStateMbps =
  stateEquivalentBytes * 8 / deltaToAckSeconds / 1,000,000
```

`stateEquivalentBytes` is admitted only when the referenced basis has the same
byte length and SHA-256 digest on both nodes. `wireBytes` includes the complete
authenticated Phase frame for the measured transition. `deltaToAck` uses a
monotonic high-resolution clock beginning immediately before frame submission
and ending when the sender receives proof that the peer observed the target
root.

## 9. Live Result

### 9.1 Shared basis

```text
Size:    67,108,864 bytes
SHA-256: eeeea29f19e99097aff081c75a85115c7732967d5824201ddba0d2d1f6202723
N150:    C:\Users\a\OrangeBox-Data\orange5\crystal\ae-phase-basis-64m.bin
Codexa:  C:\Users\Atom\OrangeBox-Data\orange5\crystal\ae-phase-basis-64m.bin
```

Both nodes independently hashed the basis before the transition.

### 9.2 Transition

```text
State-program payload:        338 bytes
Authenticated wire frame:     500 bytes
Exact transform-to-ACK:       1.987 ms
State-to-wire gain:           134,217.728x
Effective state throughput:   270,191.702 Mbps
Retry required:               no
New authentication failures:  no
Result-root agreement:        exact
```

Canonical receipt:

```text
C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\ae-phase\
2026-08-28T10-33-16-716Z-zing.json
```

Receipt SHA-256:

```text
e872066e25018c7a29455104b2b0e65bcf71d3539c509f5410cb15df7a509dab
```

### 9.3 Interpretation

The Ethernet controller did not transport 270 Gbps of new raw bytes. It
transported a 500-byte authenticated state transformation. Codexa already held
the exact 64 MiB basis, applied the declared change, reached the target root,
and acknowledged it in 1.987 ms. Effective state throughput measures that
verified system-level result.

This is the intended Orange operating model: reuse shared reality, move only
the difference, and prove the result.

### 9.4 Post-tuning distribution

After the first locked proof, the ACK payload was converted from JSON to a
fixed 32-byte binary root and redundant immediate ACK replies to steady beacons
were removed. Exact DELTA transitions still receive immediate ACKs.

Seven before/after shared-basis transitions produced:

```text
Metric  Before    Tuned     Change
best    1.700 ms  1.074 ms  36.8% lower
p50     3.656 ms  3.073 ms  15.9% lower
p95    10.085 ms  3.547 ms  64.8% lower
```

The tuned best transition represented 67,108,864 bytes of exact shared state
with a 500-byte frame and reached acknowledgement in 1.074 ms:

```text
State-to-wire gain:          134,217.728x
Effective state throughput:  499,879.806 Mbps
```

Canonical tuned-best receipt:

```text
C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\ae-phase\
2026-08-28T10-40-23-834Z-zing.json
```

Receipt SHA-256:

```text
64346782b3d34a3441430040796547e3c2c374628019c831715ca2cc8adba14c
```

## 10. Failure Semantics

The Fabric distinguishes failures instead of returning one generic red state:

- authentication failure;
- replay rejection;
- unsupported schema;
- missing base root;
- result-root mismatch;
- incomplete hydration;
- direct-path degradation;
- Wi-Fi degradation;
- backpressure;
- disk commit failure;
- key-epoch failure;
- unacknowledged critical transition.

One degraded path does not declare the complete Orange system offline. A path
fault remains visible in counters and receipts while a valid alternate path can
continue.

## 11. Falsifiers

The Phase claim fails if any of these occur:

1. The two nodes do not possess an identical declared basis.
2. The receiver acknowledges before applying the state program.
3. The resulting root differs from the declared result root.
4. A replayed frame applies the transition twice.
5. The measurement excludes authenticated frame overhead.
6. A claimed referenced byte count is not verified by digest and length.
7. A path failure kills the complete Fabric.
8. Secrets appear in receipts or source.
9. The system claims raw link bandwidth from effective state throughput.
10. Missing state is guessed instead of hydrated.

## 12. Current Boundaries

The current implementation is a production proof for compact operational state,
not a replacement for bulk file transfer. Large new objects that do not exist on
the receiver must still be hydrated or generated there. The 64 MiB proof uses an
already shared exact basis by design.

The present state-program vocabulary is intentionally small. Future codecs may
add typed increment, append, equation, recurrence, manifest selection, and
deterministic generator operations. Each operation must remain exact,
versioned, bounded, and root-verifiable.

The direct carrier is currently user-space Bun datagrams. Raw Layer 2, XDP,
RDMA, or another carrier is eligible only when it measurably improves the path
without weakening security, Windows support, installation quality, or the state
contract.

## 13. Reproduction

From the repository's `system/` directory:

```powershell
# Current local service state
bun scripts/orange5-runtime-services.mjs status ae-phase

# Direct shared-state proof
bun run orange:phase:zing

# Local health
curl.exe http://127.0.0.1:8907/health

# Codexa health through direct Ethernet
ssh -i C:/Users/a/.ssh/orange_codexa_automation_ed25519 `
  Atom@10.0.99.1 `
  "curl.exe --silent http://127.0.0.1:8907/health"
```

The proof refuses green if basis hashes differ, the state root does not change,
Codexa does not observe the exact root, authentication regresses, or the
transition requires retry.

## 14. Implementation Map

```text
system/03-BACKEND/ae-phase-protocol.mjs
  Binary frame, AEAD, receive window, acknowledgements.

system/03-BACKEND/ae-phase-fabric.mjs
  State compiler, Fabric runtime, path policy, hydration, instrumentation.

system/scripts/ae-phase-service-launcher.mjs
  Hidden persistent service launcher.

system/scripts/install-ae-phase-codexa-service.ps1
  Codexa startup-task and firewall installation.

system/scripts/ae-phase-zing-proof.mjs
  Exact shared-basis transform-to-ACK proof.

system/scripts/ae-phase-basis-verify.mjs
  Independent basis digest and byte-length verifier.

system/01-DOCTRINE/AE_PHASE_FABRIC_DOCTRINE.md
  Governing operational law and proof boundary.
```

## 15. Final Law

```text
Disk holds truth.
The Crystal defines the shared basis.
The state program moves only the change.
The receiver proves the resulting root.
The acknowledgement means shared reality, not packet arrival.
The direct path moves first.
The alternate path preserves continuity.
The carrier is replaceable.
The proof is not.
```
