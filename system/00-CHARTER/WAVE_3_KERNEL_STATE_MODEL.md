# Wave 3 Kernel State Model

**Scope:** design contract for the 100-mechanism Wave 3 intelligent kernel
**Authority:** operator
**State:** design only; no runtime proof, benchmark result, activation claim, or green claim is made here
**Kernel basis:** 10 organs, 100 named mechanisms, and a bounded task-selected workset

## 1. Core Law

Orange keeps complete history on disk and only the smallest task-relevant projection in RAM.

Full transcripts, source files, artifacts, receipts, memory records, failure episodes, contradiction records, Party Line events, Mementos, and numeric residuals are disk objects. They are never replaced by a prompt, summary, embedding, cache entry, or model recollection.

The hot state is disposable. Every hot claim must carry an exact disk pointer and hash sufficient to rehydrate and verify the bytes from which it was derived. Losing RAM may lose unfinished model thought, but it must not lose accepted source, evidence, history, or operator decisions.

The model is a consumer of governed state. It cannot certify a source, resolve a contradiction, promote a mechanism, rewrite a receipt, or declare its own output true.

## 2. Three Different Kernel States

The following states must remain separate:

1. **Catalog state:** the immutable 100-mechanism manifest. A catalog entry being present or `law_compiled_unverified` means only that the law was compiled into the manifest.
2. **Operational state:** an append-only state record for one mechanism: `research`, `shadow`, `active`, `rejected`, or `superseded`. Only an operator-authorized transition receipt may change this state.
3. **Task selection state:** the mechanism IDs selected for one task. Selection places a descriptor in RAM; it does not change operational state and does not prove enforcement.

All 100 definitions remain on disk. A task loads only selected mechanism descriptors. The mandatory conservation and authority set is `W3K-061` through `W3K-066`, `W3K-077`, `W3K-087`, and `W3K-097` through `W3K-100`; mandatory selection is not activation or proof.

## 3. Residency Classes

| Class | Location | Contents | Authority |
|---|---|---|---|
| `D0_CANONICAL` | disk | complete transcripts, sources, artifacts, and imported records | source bytes and custody metadata |
| `D1_LEDGER` | disk | append-only receipts, Party Line, Memento, mechanism state, contradiction debt, and failure memory | transition and event history according to each ledger's authority |
| `D2_PROJECTION` | disk | search indexes, embeddings, summaries, source views, and compact mirrors | rebuildable discovery aid only |
| `H0_DESCRIPTOR` | RAM | IDs, hashes, scores, statuses, pointers, budgets, and reasons | no independent truth authority |
| `H1_HYDRATED` | RAM | bounded source ranges verified against disk | temporary verified evidence |
| `H2_INJECTION` | RAM | Context Crystal and AtomSmasher task packet | temporary model input only |

`D0` and `D1` survive restart. `D2` may be deleted and rebuilt from `D0` and `D1`. `H0`, `H1`, and `H2` expire with the task or their explicit time-to-live.

## 4. Shared Primitive Objects

All SHA-256 values are lowercase 64-character hexadecimal strings. Paths are absolute at the filesystem boundary and may be normalized to portable URIs only in exported records.

```ts
type Sha256 = string;

type ByteRange = {
  offset: number;       // zero-based
  bytes: number;        // non-negative
};

type SourceRef = {
  sourceId: string;
  kind: 'file' | 'transcript' | 'artifact' | 'receipt' | 'ledger-entry';
  path: string;
  containerSha256: Sha256;
  contentSha256: Sha256 | null;
  range: ByteRange | null;
  line: number | null;
  endLine: number | null;
  mediaType: string;
  projectId: string | null;
  authorityClass: 'live-probe' | 'receipt' | 'test' | 'source' | 'transcript' | 'memory';
  authorizationRef: string;
  observedAt: string | null;
};

type LedgerLink = {
  sequence: number;
  previousHash: Sha256 | null;
  entryHash: Sha256;
};

type Supersession = {
  state: 'current' | 'contested' | 'superseded';
  basis: string;
  supersedes: string[];
  supersededBy: string | null;
  conflictsWith: string[];
};
```

A `SourceRef` is invalid if authorization is absent, the container hash does not match, or its byte range is outside the container. A derived `contentSha256` never substitutes for `containerSha256`.

The manifest accepts only IDs matching `^W3K-(00[1-9]|0[1-9][0-9]|100)$`, with exactly 10 mechanisms assigned to each of the 10 organs.

## 5. Durable Disk Objects

### 5.1 Kernel Manifest

`orange.wave3-intelligent-kernel.v1` owns the ordered 10 organs and 100 mechanism definitions. Its manifest hash identifies the whole set. It is definition, not runtime status.

Each independently governed mechanism has a `orange.wave3.mechanism-state.v1` ledger entry:

```ts
type MechanismStateRecord = {
  schema: 'orange.wave3.mechanism-state.v1';
  mechanismId: `W3K-${string}`;
  manifestHash: Sha256;
  operationalStatus: 'research' | 'shadow' | 'active' | 'rejected' | 'superseded';
  owner: string;
  invariant: string;
  enforcementRef: SourceRef | null;
  falsifier: string;
  failureThreshold: string;
  evidenceRefs: SourceRef[];
  supersedesStateHash: Sha256 | null;
  authorizedBy: string;
  recordedAt: string;
  chain: LedgerLink;
};
```

No task compiler, model response, source-file existence check, or UI toggle may write this ledger.

### 5.2 Source, Transcript, Artifact, and Receipt Custody

- A complete source or transcript remains in its original disk object or a byte-exact governed mirror.
- A transcript index stores session, turn, role, timestamp, and a `SourceRef`; it does not become the transcript.
- An artifact record stores the artifact path, artifact SHA-256, producer work ID, input references, and creation receipt.
- A receipt is append-only, hash-linked where its ledger requires it, and points to evidence. A receipt records an event; its existence alone does not prove the event's claim.
- Search indexes, embeddings, FTS rows, summaries, and source views are `D2_PROJECTION`. They must identify the canonical input hash from which they can be rebuilt.

The disk records that bind those bytes are:

```ts
type TranscriptRecord = {
  schema: 'orange.wave3.transcript-record.v1';
  transcriptId: string;
  provider: string;
  sessionId: string;
  turnId: string | null;
  role: string | null;
  timestamp: string | null;
  raw: SourceRef;
};

type ArtifactRecord = {
  schema: 'orange.wave3.artifact-record.v1';
  artifactId: string;
  workId: string;
  artifact: SourceRef;
  inputRefs: SourceRef[];
  producer: string;
  createdAt: string;
  creationReceipt: SourceRef;
};

type ReceiptRecord = {
  schema: string;
  receiptId: string;
  workId: string;
  action: string;
  status: string;
  summary: string;
  evidenceRefs: SourceRef[];
  artifactRefs: SourceRef[];
  createdAt: string;
  chain: LedgerLink;
};
```

### 5.3 AE Memory

`orange.wave3.ae-memory-record.v1` is durable source-backed recall, not an autonomous truth store.

```ts
type AEMemoryRecord = {
  schema: 'orange.wave3.ae-memory-record.v1';
  memoryId: string;
  projectId: string | null;
  kind: 'fact' | 'decision' | 'outcome' | 'procedure-candidate' | 'contradiction';
  claimKey: string | null;
  summary: string;
  why: string[];
  sourceRefs: SourceRef[];
  confidence: number;             // 0..1, never authority by itself
  supersession: Supersession;
  observedAt: string | null;
  recordedAt: string;
  chain: LedgerLink;
};
```

AE Memory may rank and explain candidates. Before a candidate enters the hot workbench, Source Hydration must authorize its project scope and verify its source bytes. An embedding hit, lexical hit, or remembered summary cannot cross that boundary alone.

### 5.4 Failure Memory

`orange.wave3.failure-memory.v1` is an outcome-derived record keyed by action family, failure class, project scope, and source-backed fingerprint.

```ts
type FailureMemoryRecord = {
  schema: 'orange.wave3.failure-memory.v1';
  failureId: string;
  actionFamily: string;
  failureClass: string;
  projectId: string | null;
  fingerprint: Sha256;
  status: 'open' | 'resolved' | 'suppressed';
  cause: string;
  recommendedAction: string;
  triggerReceipt: SourceRef;
  resolutionReceipt: SourceRef | null;
  recurrenceCertificateRefs: SourceRef[];
  supersession: Supersession;
  recordedAt: string;
  chain: LedgerLink;
};
```

Failure Memory can warn, propose a known repair, and suppress a stale route candidate. It cannot execute the repair, promote a route, or mark itself resolved without a linked outcome receipt.

### 5.5 Contradiction Debt

Contradictions are retained as debt instead of being averaged away or silently overwritten.

```ts
type ContradictionDebt = {
  schema: 'orange.wave3.contradiction-debt.v1';
  debtId: string;
  claimKey: string;
  status: 'open' | 'resolved';
  variants: Array<{
    claim: string;
    claimSha256: Sha256;
    sourceRefs: SourceRef[];
    authorityScore: number;
    observedAt: string | null;
  }>;
  winnerClaimSha256: Sha256 | null;
  resolutionBasis: 'explicit-supersession' | 'authority-recency' | null;
  resolutionReceipt: SourceRef | null;
  createdAt: string;
  updatedAt: string;
  chain: LedgerLink;
};
```

An open debt forces every materially conflicting variant into the workbench as pinned evidence. A model may explain the conflict but may not select a winner. Resolution retains losing variants and requires either explicit supersession or a governed authority-and-recency rule plus a resolution receipt.

### 5.6 Numeric Equation and Residual Packet

Numeric compression is valid only when the equation and residuals reconstruct the original series exactly.

```ts
type NumericEquationPacket = {
  schema: 'orange.wave3.numeric-equation-packet.v1';
  packetId: string;
  seriesSource: SourceRef;
  units: string | null;
  domain: { start: number | null; step: number | null; count: number };
  model: { kind: string; parameters: Record<string, number | string> };
  residualEncoding: string;
  residualsInline: number[] | null;
  residualsRef: SourceRef | null;
  sourceSha256: Sha256;
  modelSha256: Sha256;
  residualSha256: Sha256;
  reconstructionSha256: Sha256;
  exactReconstructionRequired: true;
};
```

Residuals may be inline only when they fit the hot budget. Otherwise they remain on disk and the hot packet carries `residualsRef`. An equation without residuals, source hash, and reconstruction hash is an estimate, not an exact packet.

### 5.7 Party Line

Party Line is the append-only shared event current. A durable event contains sequence, previous hash, entry hash, actor, type, status, summary, correlation IDs, and source references.

```ts
type PartyLineEvent = {
  schema: 'orange.party-line.event.v1';
  id: string;
  seq: number;
  createdAt: string;
  projectId: string;
  topic: string;
  actor: { id: string; kind: string; displayName: string };
  eventType: 'message' | 'order' | 'report' | 'decision' | 'tool' | 'receipt' | 'status' | 'blocker' | 'repair';
  status: string | null;
  summary: string;
  body: string | null;
  detail: Record<string, unknown> | null;
  sourceRefs: SourceRef[];
  tags: string[];
  correlationId: string | null;
  replyTo: string | null;
  importance: number;
  prevHash: Sha256 | null;
  entryHash: Sha256;
};
```

The hot task may hold only a bounded, query-selected tail or set of event descriptors. Party Line supports continuity and explanation; it is not operational authority and does not replace receipts or source evidence.

### 5.8 Memento

Memento is the append-only continuity ledger for major upgrades, decisions, preserved ideas, and fidelity commitments. A Memento contains title, type, status, original idea, fidelity statement, why, implementation references, source references, and hash-chain link.

```ts
type MementoRecord = {
  schema: 'orange.memento.v1';
  id: string;
  recordedAt: string;
  type: string;
  status: string;
  title: string;
  summary: string;
  originalIdea: string;
  fidelity: string;
  sourceRefs: SourceRef[];
  why: string[];
  implementation: string[];
  evidence: string[];
  limits: string[];
  next: string[];
  previousHash: Sha256 | null;
  hash: Sha256;
};
```

Memento is not a transcript archive, task event bus, benchmark ledger, or proof. The hot task loads only relevant Memento descriptors and hydrates the cited source when needed.

## 6. Hot Objects

### 6.1 Required Hot Budget

Every task must carry a finite `HotBudget`; missing, negative, zero where content is required, or infinite values make compilation invalid.

```ts
type HotBudget = {
  maxCandidateDescriptors: number;
  maxSelectedEvidence: number;
  maxHydratedSlices: number;
  maxHydratedBytes: number;
  maxWorkbenchBytes: number;
  maxContextCrystalBytes: number;
  maxEquationPackets: number;
  maxPartyLineEvents: number;
  maxMementos: number;
  maxFailureRecords: number;
  ttlMs: number;
};
```

The baseline compiler profile retains three established limits: at most 8 selected evidence records, a 6,000-byte Context Crystal target, and at most 3 numeric packets. Every additional ceiling must be explicit in the selected runtime profile; there is no unbounded fallback.

### 6.2 Source Hydration

Hydration is the only boundary allowed to move canonical source bytes into RAM.

```ts
type HydrationRequest = {
  schema: 'orange.wave3.hydration-request.v1';
  requestId: string;
  workId: string;
  source: SourceRef;
  purpose: 'evidence' | 'contradiction' | 'failure' | 'numeric-residual' | 'operator-inspection';
  maxBytes: number;
  expiresAt: string;
};

type HydratedSlice = {
  schema: 'orange.wave3.hydrated-slice.v1';
  requestId: string;
  sourceId: string;
  range: ByteRange;
  content: Uint8Array;
  containerHashMatched: boolean;
  contentHashMatched: boolean | null;
  authorizationMatched: boolean;
  loadedAt: string;
  expiresAt: string;
};
```

Hydration rejects a changed hash, unauthorized project, invalid range, expired request, or budget overflow. A hydrated slice is read-only and is discarded at expiry. Persisting transformed content creates a new artifact and receipt; it never mutates the source.

### 6.3 Source-Backed Task Workbench

The workbench is the sole hot integration object for cognition.

```ts
type RankedEvidence = {
  id: string;
  source: SourceRef;
  excerpt: string;
  why: {
    signals: {
      lexical: { score: number; matchedTerms: string[] };
      semantic: { score: number; provider: string };
      project: { score: number; match: boolean | null };
      authority: { score: number; basis: string };
      recency: { score: number; observedAt: string | null; ageDays: number | null };
      contradiction: { score: number; state: 'current' | 'contested' | 'superseded' };
    };
    weights: Record<'lexical' | 'semantic' | 'project' | 'authority' | 'recency' | 'contradiction', number>;
    contributions: Record<'lexical' | 'semantic' | 'project' | 'authority' | 'recency' | 'contradiction', number>;
    formula: string;
    totalScore: number;
    summary: string;
  };
  confidence: number;
  supersession: Supersession;
};

type HotMechanismDescriptor = {
  mechanismId: string;
  organId: string;
  operationalStatus: 'research' | 'shadow' | 'active' | 'rejected' | 'superseded' | 'unassessed';
  stateHash: Sha256 | null;
  invariant: string;
  enforcementRef: SourceRef | null;
  falsifier: string;
};

type TaskWorkbench = {
  schema: 'orange.wave3.task-workbench.v1';
  workId: string;
  taskHash: Sha256;
  projectId: string | null;
  kernelManifestHash: Sha256;
  kernelWorksetHash: Sha256;
  kernelActivationBitset: string; // exactly 100 bits encoded as 25 hex characters
  selectedOrganIds: string[];
  selectedMechanisms: HotMechanismDescriptor[];
  budget: HotBudget;
  selectedEvidence: RankedEvidence[];
  contradictionDebtIds: string[];
  failureMemoryIds: string[];
  partyLineEventIds: string[];
  mementoIds: string[];
  hydratedSliceIds: string[];
  equationPacketIds: string[];
  contextCrystalId: string | null;
  atomSmasherPacketId: string | null;
  createdAt: string;
  expiresAt: string;
};
```

The exact public evidence fields are `why`, `source`, `confidence`, and `supersession`. Confidence expresses bounded ranking confidence; it never upgrades source authority. Superseded evidence stays on disk and remains queryable. Open contradiction evidence stays pinned in RAM even when its ranking score is lower.

The workbench must not contain a full transcript, full source tree, complete Party Line, complete Memento ledger, all 100 mechanism bodies, model weights, or an unbounded result list.

### 6.4 Context Crystal

`orange5.context-crystal.v1` is the bounded `H2_INJECTION` rendering of selected workbench evidence.

```ts
type ContextCrystal = {
  schema: 'orange5.context-crystal.v1';
  crystalId: Sha256;
  task: string;
  taskHash: Sha256;
  sourceSetSha256: Sha256;
  worksetId: string;
  hotContext: string;
  selected: Array<{
    sourceId: string;
    pointer: SourceRef;
    sourceSha256: Sha256;
    chunkSha256: Sha256;
    start: number;
    end: number;
    pinned: boolean;
  }>;
  equationPacketIds: string[];
  dropped: Array<{ id: string; reason: string }>;
  constructionChecks: {
    worksetValid: boolean;
    sourcePointersValid: boolean;
    requiredSourcesRetained: boolean;
    missingRequiredSourceIds: string[];
    noHiddenCache: boolean;
  };
  metrics: {
    rawBytes: number;
    hotBytes: number;
    inputSources: number;
    inputChunks: number;
    selectedChunks: number;
  };
};
```

Context Crystal is not memory and is not the source archive. It may be persisted as a derived artifact for replay, but replay must reverify every source pointer. Construction checks recorded in a crystal are assertions to verify, not runtime proof by themselves.

### 6.5 AtomSmasher

AtomSmasher is the deterministic work compiler between the workbench and bounded execution.

```ts
type AtomSmasherTaskPacket = {
  schema: 'orange.wave3.atomsmasher-task-packet.v1';
  packetId: string;
  workId: string;
  taskHash: Sha256;
  kernelManifestHash: Sha256;
  selectedMechanismIds: string[];
  atoms: {
    objective: string;
    constraints: string[];
    forbidden: string[];
    deliverables: string[];
    acceptance: string[];
    evidenceRequired: string[];
    unknowns: string[];
  };
  contextCrystalId: string;
  sourceRefs: SourceRef[];
  equationPacketIds: string[];
  droppedRefs: Array<{ id: string; reason: string }>;
  budget: HotBudget;
  packetSha256: Sha256;
};
```

AtomSmasher may select, normalize, compress, and package authorized workbench state. It may not discover arbitrary files, destroy sources, resolve contradiction debt, change mechanism status, write AE Memory, or claim execution success.

## 7. Component Boundaries

| Component | Reads | Writes | Must never do |
|---|---|---|---|
| Kernel compiler | manifest, mechanism state ledger, task | hot mechanism selection | promote a mechanism or imply selection is activation |
| Source View / Superdirectory | canonical disk sources | rebuildable indexes and pointers | become source authority |
| Source Hydration | authorized exact `SourceRef` | expiring `HydratedSlice` | return unverifiable or over-budget bytes |
| AE Memory | receipts and source-backed records | memory ledger and rebuildable indexes | silently overwrite or treat similarity as truth |
| Failure Memory | terminal outcome receipts | failure episodes and resolution links | self-resolve or execute a repair |
| Contradiction Debt | conflicting source-backed claims | append-only debt transitions | discard losing evidence or let a model pick the winner |
| Numeric packet compiler | exact numeric source | equation/residual artifact | drop residuals or label approximate reconstruction exact |
| Context Crystal | selected workbench evidence | hot injection, optional replay artifact | become archive, memory, or proof |
| AtomSmasher | workbench and crystal | bounded task packet | mutate canonical state or certify an outcome |
| Party Line | task and system events | append-only shared current | substitute for receipts or operational authority |
| Memento | operator-significant decisions and sources | append-only continuity record | absorb routine events or assert proof |
| Model / Hermes worker | task packet and bounded tools | proposed output and evidence-bearing result | write canonical cognition state directly |

## 8. State Flow

```text
complete bytes on disk
-> rebuildable discovery projections
-> bounded candidate descriptors
-> project and authority filter
-> exact hash-verified source hydration
-> why/source/confidence/supersession ranking
-> contradiction and failure pinning
-> minimal TaskWorkbench in RAM
-> Context Crystal + AtomSmasher task packet
-> bounded worker action
-> artifact + terminal receipt on disk
-> Party Line event on disk
-> candidate AE Memory / Failure Memory updates from receipts
-> governed mechanism or Memento transition only when separately authorized
-> hot state expiry and disposal
```

Learning never jumps from model output to accepted memory. The durable outcome receipt is the intake boundary. Derived learning first enters source-backed memory or shadow state; promotion requires its own authority, falsifier, evidence, and rollback record.

## 9. Restart, Disconnection, and Invalidations

- A restart reconstructs a task from `workId`, manifest hash, ledger heads, source references, and receipts. It does not serialize an opaque model context as truth.
- A source hash change invalidates every hydrated slice and derived crystal that cites the previous hash.
- A mechanism-state head change invalidates a workbench carrying the older state hash.
- An expired hydration or workbench object is unusable even if still reachable in process memory.
- A disconnected worker may return an artifact, but it cannot commit memory, mechanism state, contradiction resolution, or Memento state without the normal disk-ledger boundary.
- Duplicate delivery is handled by stable IDs and content hashes; it must not create duplicate accepted state transitions.

## 10. Full-Strength Preservation Rules

The following substitutions are forbidden:

- summary for source;
- embedding for source pointer;
- Context Crystal for transcript or memory;
- Party Line event for terminal receipt;
- Memento for proof;
- confidence score for authority;
- newest claim for explicit supersession;
- equation without residuals for exact numeric state;
- selected mechanism for active mechanism;
- model self-assessment for verification;
- hot cache for durable custody.

Every representation must point backward to stronger custody. Every accepted transition must point forward to a falsifier or resolution condition. The 100 mechanisms remain fully recoverable on disk while each task pays RAM only for the small subset it can actually use.

## 11. Current Code Ownership References

These paths identify present implementation owners and vocabulary. Their presence is not evidence that this state model is fully wired or verified.

- `03-BACKEND/wave3-intelligent-kernel.mjs` - 10-organ, 100-mechanism manifest and task selection.
- `03-BACKEND/memory-context.mjs` - source-backed ranking, contradiction debt, supersession, and workbench output.
- `03-BACKEND/context-crystal.mjs` - bounded Context Crystal projection.
- `12-ATOMSMASHER/sparse-worksets/compressor.mjs` - sparse workset compiler used by Context Crystal.
- `03-BACKEND/source-view-store.mjs` and `03-BACKEND/superdirectory.mjs` - source views, transcript custody, search, and hydration.
- `06-ORANGELLM/memory/ae-cobra/` - AE Memory ledgers and retrieval projections.
- `03-BACKEND/learning-loop.mjs` - receipt-derived failure and decision memory intake.
- `03-BACKEND/numeric-equation-packet.mjs` - equation, residual, and reconstruction packet vocabulary.
- `04-CONTROL-PLANE/party-line/ledger.mjs` - canonical Party Line ledger.
- `03-BACKEND/memento-ledger.mjs` - Memento continuity ledger.

## 12. Claim Boundary

This document defines intended objects, residency, authority, and invalidation rules. It does not report tests, benchmarks, live probes, runtime wiring, performance, correctness, or completion. Any future activation claim must be supported by fresh evidence for the exact end-to-end path described here.
