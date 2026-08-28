# AtomSmasher 2 Operational Theory

Status date: 2026-06-25
Product: Orange
Release line: OrangeFive
System pillar: Pillar 5, AtomSmasher 2
Core law: Only smart work is done.

## 0. Executive Theory

AtomSmasher 2 is the Orange compression engine.

It is not just a memory compressor. It is the subsystem that decides what
should stay hot, what should be cold source truth, what can be represented as
an equation, what can be reused as a cartridge, what work can be skipped, what
expansion is justified, and what claims must be rejected as fluff or fake
green.

The practical theory is:

```text
Raw truth stays cold.
Operational commitments become atoms.
Verbose state becomes AIR.
Stable context becomes cartridges.
Numeric or structured patterns become equations.
Requests wake sparse worksets, not the whole warehouse.
Routing follows least action.
Expansion requires a warrant.
Saved work is certified.
Compression debt is tracked.
Winning workflows become pathwaves.
Canon emerges through pressure, not vibes.
```

AtomSmasher exists because Orange cannot become a serious always-on operator
system if every model call re-reads everything, every chat re-learns the same
project, every answer carries filler, every tool reports differently, and every
feature claim depends on memory or vibes.

The system compresses work, context, tools, evidence, model routing, operator
attention, and repeated cognitive waste.

## 1. Current Implementation Truth

This document is an operational theory and control doctrine. It is not a fake
release receipt. Current repo truth is mixed and must be kept explicit.

### 1.1 Canonical engine

The current canonical AtomSmasher 2 engine is documented at:

```text
C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\
```

Its README describes it as the Bun-only port of the earlier Python + SQLite
AtomSmasher full-scope implementation. It claims:

```text
620 live executable features
14 engine families dispatched by keyword classification
6 heat classes
schema version 10
Bun runtime
7/7 full-scope tests green
620 attempted, 0 errors, 620 ok
```

The full-scope tree is therefore the current reference implementation for
OrangeFive's Pillar 5.

### 1.2 Older module folders

The older module folders still exist under:

```text
C:\AtomEons\Orange5\12-ATOMSMASHER\
```

They include:

```text
commitment-atoms
air-codec
equation-store
cartridges
sparse-worksets
least-action
expansion-warrants
compression-debt
saved-work
canon-pressure
pathwave
modules
```

Their documentation shows many real primitives and smoke-test claims, but also
many honest gaps such as pending gateway routes, pending persistence, pending
schema files, or pending Flux integration.

The correct posture is:

```text
full-scope/ is canonical for OrangeFive AtomSmasher 2.
older module folders are useful primitives, tests, and cross-checks.
older module folders should not be treated as the complete engine by themselves.
module status must be promoted only from receipts and proof, not from README text.
```

### 1.3 Registry mismatch to resolve

The legacy registry at:

```text
C:\AtomEons\Orange5\12-ATOMSMASHER\modules\index.mjs
```

originally listed most modules as `STUB` and only the anti-fluff gate as ready.
Later docs show deeper module work and the full-scope engine superseding that
partial registry.

Optimization requirement:

```text
Reconcile the registry with the full-scope engine.
Do not delete older modules until they are retired by receipt.
Do not leave status surfaces disagreeing.
```

## 2. Why We Used This Architecture

Orange is intended to be one product with one operational reality. It includes
the app, Ops backend, model orchestration, AECode, receipts, memory, toolmesh,
Codexa, local N150 control, and future output lanes. A normal chat model cannot
hold that reliably by itself.

The architecture was chosen to solve these failures:

### 2.1 Context flood

Without compression, every new chat or agent has to relearn everything. That
creates slow work, high cost, and hallucinated project state.

AtomSmasher fixes this by turning the project into compact, source-backed,
reusable operational structures.

### 2.2 Repeated rediscovery

The same project facts, standards, tool rules, receipts, and model policies
were being rediscovered over and over.

AtomSmasher fixes this with cartridges, saved work certificates, canon pressure,
and pathwaves.

### 2.3 Fake green

Older project work suffered from features being described as done before they
were backed by receipts.

AtomSmasher fixes this with anti-fluff gates, commitment atoms, proof receipts,
debt records, and status surfaces that distinguish:

```text
proven
primitive-live
gateway-pending
persistence-pending
candidate
research
blocked
retired
```

### 2.4 Tool sprawl

Orange uses many tools and model roles. Without a compression layer, tools
become a noisy pile.

AtomSmasher fixes this by turning tools into searchable features, cartridges,
capability cards, routeable worksets, and receipts.

### 2.5 Local-first constraints

The N150 dev box cannot run every heavy model or process all raw context all
the time. Codexa can run heavier lanes, but it must not be used blindly.

AtomSmasher fixes this with least-action routing, heat classes, sparse worksets,
and Codexa-heavy handoff only when justified.

### 2.6 Operator attention

The operator should not have to keep correcting stale chat state.

AtomSmasher fixes this by preserving commitments, source pointers, active
orders, receipts, and proof status in forms that can be reloaded by any chat,
app, or agent.

## 3. What AtomSmasher Compresses

AtomSmasher compresses more than text.

It compresses:

```text
memory
context
tool catalogs
project doctrine
operator instructions
model routing decisions
numeric data
proof receipts
feature status
source references
visual evidence summaries
orders and reports
agent trajectories
past work
canonical decisions
attention
energy and latency choices
future repeated work
```

It does not compress away truth. Raw receipts, docs, logs, files, and source
artifacts remain the cold ledger. AtomSmasher produces operational views over
that ledger.

## 4. Orange5 System Position

AtomSmasher sits between source truth and action.

```text
raw docs / receipts / logs / files / tool output
  -> AE Memory / AE Cobra ingest
  -> AtomSmasher compression and classification
  -> AIR frames, atoms, equations, cartridges, worksets
  -> OrangeBrain / OrangeLLM route decision
  -> Hermes / agents / tools execute
  -> orange.report.v1
  -> receipts and proof artifacts
  -> saved-work certs, compression debt, pathwaves, canon pressure
  -> Atomic Orange displays current truth
```

The intended data flow is not chat-first. It is receipt-first and
compression-first.

## 5. Why Bun, SQLite, JSONL, Hash Chains, And Receipts

### 5.1 Bun

Bun is used in Orange5 because it gives a fast local runtime for TypeScript and
JavaScript control-plane code, low startup overhead, simple CLI execution, and a
good fit for the Orange app and gateway direction.

AtomSmasher full-scope is now documented as Bun-only. This matters because the
active product is moving toward a consistent Bun/Tauri/React/Rust app standard,
not a scattered pile of Python, Node, and one-off scripts.

Operational rule:

```text
Bun should run the hot local compression and control-plane paths.
Python can remain provenance/source where already built, but OrangeFive runtime
should converge toward the Bun engine where the proof is green.
```

### 5.2 SQLite

SQLite is used because Orange needs local, durable, queryable truth without a
server dependency. It is appropriate for:

```text
feature registry
receipts index
orders
reports
routes
model calls
worksets
canon pressure
compression debt
saved work
```

SQLite should not replace append-only receipts. It is the fast index. Receipts
and raw ledger artifacts remain the deeper truth.

### 5.3 JSONL and Flux-style logs

JSONL is used for append-only event streams because it is:

```text
grep-able
portable
easy to hash
easy to replay
easy to mirror
not dependent on a database engine
```

For low-volume proof chains such as equations, a JSONL store is often enough.
For high-volume query surfaces, SQLite should mirror the log.

### 5.4 Hash chains

Hash chains are used because Orange must prove that a receipt, atom, equation,
certificate, or path did not silently mutate.

Every important record should carry:

```text
content hash
previous hash when part of a chain
created timestamp
actor
evidence pointers
status
```

This turns "I remember we did it" into "here is the record and its hash."

### 5.5 Receipts

Receipts are the final operational truth. Chat output is not truth. README text
is not truth. Runtime status JSON is not enough by itself. A feature is green
only when a receipt proves the exact behavior being claimed.

## 6. Core Module Theory

### 6.1 Commitment Atoms

Purpose:

Commitment Atoms are the smallest durable units of decision, promise,
invariant, deadline, threshold, or operator law.

Why:

Large chats bury decisions in prose. Orange needs decisions that can be loaded,
validated, superseded, searched, and cited.

Inputs:

```text
operator decisions
release laws
model-routing rules
project invariants
deadline commitments
scope boundaries
proof-backed facts
```

Outputs:

```text
content-addressed atom
atom_id
signature hash
prev_hash
evidence pointers
status
```

Optimization:

Commitment Atoms should become the hot memory layer for high-force truths.
Only load the atoms relevant to the active request. Do not load whole docs
when a few atoms preserve the decision.

Full-level target:

```text
Every operator-approved law and release-critical fact becomes an atom.
Every atom has evidence.
No unverified model claim becomes a high-authority atom.
Superseded atoms remain auditable.
```

Current truth:

The encoder documentation shows a live pure encoder, but persistence, index,
gateway routes, and supersede index behavior are still described as pending or
split across sibling files. Promotion must be receipt-backed.

### 6.2 AIR Codec

Purpose:

AIR is the AtomSmasher Intermediate Representation. It converts verbose prose
into typed, compact, machine-routable frames.

Why:

Models produce filler, hedges, transitions, and conversational sludge. Orange
needs the load-bearing parts: facts, claims, decisions, citations, numbers,
dates, identifiers, code spans, questions, and residue.

Inputs:

```text
model answers
docs
reports
design notes
agent outputs
research summaries
```

Outputs:

```text
AIR frame
source_hash
frame_id
facts
claims
citations
numbers
dates
identifiers
decisions
questions
dropped filler accounting
```

Optimization:

AIR should be the default hot-context format for long text. The original text
stays cold. AIR gives OrangeBrain enough structure to act without re-reading
the raw prose every turn.

Important honesty:

AIR is structural compression, not gzip. For short dense inputs, JSON envelope
size can be larger than the original. The correct metric is structure per byte
and reduced repeated parsing, not always smaller raw bytes.

Full-level target:

```text
Every long model output and research note is AIR-compressed before it enters hot memory.
Dropped filler is accounted for.
Code spans remain byte-exact.
Claims remain claims unless grounded.
```

### 6.3 EquationStore

Purpose:

EquationStore stores formal numeric, logical, structural, and count invariants
that the system claims to enforce.

Why:

Orange should not say "we enforce X" unless X exists as an auditable equation
with an id.

Inputs:

```text
release formulas
salary or payout equations
guardrail counts
gate ordering rules
structural invariants
numeric series
data patterns
```

Outputs:

```text
equation_id
formula or invariant statement
kind
params
signature hash
supersedes chain
validation result
```

Optimization:

Use equations whenever raw numeric rows or repeated invariants can be replaced
by formula plus residuals. If data follows a rule, store the rule. If it breaks
the rule, store the break.

Full-level target:

```text
Every enforceable numeric or structural law has an equation id.
Release checks cite equation ids.
Raw numeric exhaust stays cold unless a warrant requires hydration.
Approximate equations carry error bounds.
```

Current truth:

The module README claims live smoke tests for the store and seed equations. It
also names gateway and schema-file work as out of scope for that module drop.

### 6.4 Cartridges

Purpose:

Cartridges are pre-compiled domain capability units.

Why:

Do not rebuild stable context every time. If a model needs Orange doctrine, AE
Cobra memory, or visual capability policy, load a cartridge instead of
rehydrating many documents.

Inputs:

```text
system prompts
capability declarations
tool cards
domain doctrine
operator preferences
validated context bundles
```

Outputs:

```text
cartridge_id
name
version
capabilities
system_prompt
tool_cards
tags
summary
```

Optimization:

Cartridges should be selected by the sparse workset solver and least-action
router. They are the main mechanism for keeping sessions capable without huge
context.

Full-level target:

```text
Orange doctrine cartridge
AE Cobra memory cartridge
OrangeEye visual cartridge
coding standards cartridge
security/release cartridge
model role cartridges
```

Current truth:

The module README describes a live loader, registry, hot-swap behavior, gateway
surface, and 56/56 smoke-test claim. It also names gaps such as no execution,
no version history, no signature on cartridge itself, and no cross-cartridge
capability conflict resolution.

### 6.5 Sparse Worksets

Purpose:

Sparse Worksets choose the minimum context needed for a task.

Why:

The model should reason over a workbench, not a warehouse. Full context replay
is expensive, slow, and error-prone.

Inputs:

```text
task
available context items
pins
score hints
budget
forbidden items
```

Outputs:

```text
working_set
dropped items with reasons
compression ratios
warnings
stats
workset_id
```

Optimization:

Sparse worksets should be the default context builder for every OrangeBrain
request. They decide what is hot for this task and what remains cold.

Full-level target:

```text
5 to 20 high-value context items by default
0 to 5 source spans
0 to 3 cartridges
0 to 3 equations
only required modules awake
every drop reason visible
```

Current truth:

The module README describes a live pure compressor and validator, with pending
persistence, SQLite index, gateway routes, schema file, and debt hooks.

### 6.6 Least-action Router

Purpose:

The Least-action Router picks the minimum-energy path through the model and
tool stack.

Why:

Orange should not send every request to the biggest model. Small local reflex,
heavy local/Codexa, and frontier models should each be used only when their
cost is justified.

Inputs:

```text
intent complexity
risk level
latency budget
capabilities
available tiers
fit priors
```

Outputs:

```text
decision_id
scorecard
chosen_tier
ineligibility reasons
route_reason
```

Optimization:

The router should use measured latency, success, and saved-work data to keep
routing efficient. It should route small requests locally, route heavy requests
to Codexa or frontier only when justified, and refuse routes that violate risk
constraints.

Full-level target:

```text
reuse/cache first
cartridge next
AIR capsule next
minimal hydration next
local reflex next
local/Codexa heavy next
frontier model last
full context replay only with warrant
```

Current truth:

The module README describes a live pure scorer and 45/45 smoke-test claim.
It also names gaps: capabilities surfaced but unused in scoring, static
latencies, hand-tuned priors, no streaming accounting, and no gateway route yet.

### 6.7 Expansion Warrants

Purpose:

Expansion Warrants are explicit time-bounded authorizations to move from a
smaller scope to a larger one.

Why:

Expansion is where agents get expensive and dangerous. Orange must not let a
model decide to hydrate everything, use frontier models, touch broad files, or
expand scope just because it feels useful.

Inputs:

```text
scope_from
scope_to
operator signature
expiry
max uses
nonce
```

Outputs:

```text
warrant id
validity
used count
remaining uses
expiry state
```

Optimization:

Warrants should be rare. Their count is a useful measure of whether the system
is staying compressed or drifting back into brute-force expansion.

Full-level target:

```text
No full-context replay without warrant.
No large/frontier route without warrant when smaller paths are insufficient.
No broad hydration without warrant.
No multi-agent escalation without warrant.
```

Current truth:

The module README describes a live encoder, validator, and in-process index,
with persistence, gateway routes, cryptographic signature verification, schema
artifact, and strict scope-hierarchy checker pending.

### 6.8 Compression Debt Ledger

Purpose:

The Compression Debt Ledger records cases where the system used verbose form
instead of a compressed form.

Why:

Compression can create future waste if missing codecs, verbose outputs, or
manual overrides are never tracked. Debt makes waste visible.

Inputs:

```text
verbose hash
verbose char count
surface
actor
reason
reference
compressed hash when paid
payment evidence
```

Outputs:

```text
debt_id
status open/paid/forgiven
savings chars
regression flag
summary by surface
```

Optimization:

Use debt to decide what to improve next. The surfaces with the most open debt
are where compression work has the highest payoff.

Full-level target:

```text
Every repeated verbose path opens debt.
Every successful compression pays debt.
Regressions are recorded honestly.
Debt score influences least-action routing.
```

Current truth:

The module README describes Flux plus SQLite design, gateway routes, and a
smoke-test claim. It also names dependency, operator-gating, schema enforcement,
and replay gaps.

### 6.9 Saved Work Certificates

Purpose:

Saved Work Certificates prove that work was done and can be reused.

Why:

Do not repeat work that already has a receipt-backed output. Saved work is the
economic proof layer for compression.

Inputs:

```text
work hash
output hash
inputs digest
output summary
receipt references
actor
policy
prev hash
```

Outputs:

```text
cert_id
signature chain
status
redeem events
revoke events
verification result
```

Optimization:

Before doing work, hash the requested work shape and check for an existing
certificate. If it matches, redeem the certificate instead of recomputing.

Full-level target:

```text
Every proof run, build, route, trainset export, and expensive analysis can mint a cert.
Every future equivalent task checks certs first.
Reused work is measured, not guessed.
```

Current truth:

The module README describes a live pure encoder/verifier/redeemer and 56/56
smoke-test claim. Persistence, schema file, gateway routes, and cross-module
hash-chain bridging are pending.

### 6.10 Canon Pressure Detector

Purpose:

Canon Pressure detects when a concept is being used often enough that it may
need formal promotion into Orange doctrine.

Why:

Canon should be a phase transition, not a note. Repeatedly used terms,
architecture ideas, or laws should not remain buried in chat.

Inputs:

```text
candidate name
receipt id
mission id
operator promotion/rejection
rationale
```

Outputs:

```text
receipt count
mission count
pressure state
operator decisions
promotion candidates
summary counts
```

Optimization:

Canon pressure turns lived system behavior into reviewable doctrine. It helps
Orange learn what is becoming important without auto-promoting it.

Full-level target:

```text
AE7 or the equivalent review lane sees canon candidates.
Operator promotion creates commitment atoms.
Rejected candidates remain visible as rejected, not forgotten.
```

Current truth:

The module README describes a live detector and smoke test, with schema file,
gateway route, receipts pipeline wiring, and Flux audit emission pending.

### 6.11 Pathwave Compressor

Purpose:

Pathwave compresses execution trajectories.

Why:

If a workflow wins, Orange should remember not only the answer but the path that
won: orders, actions, reports, receipts, evidence hashes, status, confidence,
and divergence points.

Inputs:

```text
orange.order.v1
action
orange.report.v1
receipt
task
```

Outputs:

```text
pathwave_id
step hashes
status sequence
confidence sequence
receipt anchors
compression stats
warnings
diff results
```

Optimization:

Pathwaves allow replay, comparison, and reuse of workflow shapes. They are how
Orange stops rediscovering process.

Full-level target:

```text
Every successful high-value workflow creates a pathwave.
Future similar work checks for matching pathwaves.
Alternative paths can be diffed.
Failures become anti-pathwaves or debt entries.
```

Current truth:

The module README describes a live pure compressor and validator, with
persistence, SQLite index, gateway route, replay runner, and debt hookup
pending.

### 6.12 Anti-Fluff Gate

Purpose:

The Anti-Fluff Gate rejects or warns on filler, hedging, fake certainty, and
theatrical green language.

Why:

Orange cannot optimize if hot memory is full of vague, status-inflating text.

Inputs:

```text
model output
docs
reports
commitment candidates
warrant scopes
cert summaries
receipt rationales
```

Outputs:

```text
pass/warn/reject verdict
matched patterns
reason
```

Optimization:

Anti-fluff should run before text enters hot memory, before commitment atom
minting, before saved-work certificates, before warrants, and before release
status promotion.

Full-level target:

```text
No "probably green."
No "looks ok."
No "should work."
No release claim without proof.
No model-only hypothesis promoted as authority.
```

## 7. Full-Scope Engine Theory

The `full-scope/` tree is the current best expression of AtomSmasher 2.

Its purpose is to unify the module ideas into one executable Bun engine. The
key documented properties are:

```text
620 registered features
feature execution through engine families
heat classification
source ingestion
FTS/search
orders
commitment atoms
AIR
equations
cache route
sparse worksets
least-action routing
warrants
proof
agent governance
security scanning
attention/energy families
receipts
```

The operational theory is that full-scope becomes the always-available
compression core. The older module folders either feed it, validate it, or are
retired when their coverage is subsumed.

## 8. Intended End-To-End Function

Every Orange request should eventually follow this shape:

```text
1. Receive orange.order.v1.
2. Verify order schema and scope.
3. Check prior saved-work certificates.
4. Query cartridges and active commitment atoms.
5. Build sparse workset.
6. AIR-compress relevant text.
7. Add equation packets for numeric/structural truths.
8. Run least-action route.
9. Require expansion warrant if route expands scope.
10. Dispatch to local reflex, Codexa, or frontier only as justified.
11. Enforce anti-fluff and report schema on output.
12. Return orange.report.v1.
13. Write receipt.
14. Mint saved-work certificate if reusable.
15. Record compression debt if verbose fallback happened.
16. Update canon pressure from receipts.
17. Compress winning workflow into pathwave.
18. Update Atomic Orange display.
```

Nothing in this path depends on chat memory being reliable.

## 9. Full-Level Compression Algorithm

Full-level compression means the system is not merely shortening text. It is
minimizing unnecessary future work.

Algorithm:

```text
Input: request, project state, available source truth, tools, models

1. Normalize the request into an order.
2. Reject invalid or unsafe orders.
3. Search exact cache and saved-work certs.
4. Load only relevant cartridges.
5. Select high-force commitment atoms.
6. Select relevant equations and source pointers.
7. Build sparse workset.
8. Convert verbose attached text to AIR.
9. Compute work cost and risk.
10. Route through least action.
11. If expansion is needed, check warrant.
12. Execute the smallest valid route.
13. Validate output schema.
14. Run anti-fluff and fake-green checks.
15. Attach evidence.
16. Emit report and receipt.
17. Certify saved work.
18. Record debt if compression failed or expanded.
19. Update canon pressure.
20. Store pathwave.

Output: report, receipt, compression artifacts, reusable proof
```

## 10. Optimization Metrics

To optimize AtomSmasher, measure it.

Primary metrics:

```text
context tokens avoided
raw files not hydrated
model calls avoided
frontier calls avoided
average route latency
cartridge hit rate
saved-work redemption count
sparse workset compression ratio
AIR filler dropped
EquationStore raw-row avoidance
compression debt open count
compression debt paid savings
warrant rate
false omission rate
recall precision
canon pressure candidates reviewed
pathwave reuse count
anti-fluff rejection rate
operator correction count
fake-green prevention count
```

High compression is only good if recall remains high. A smaller context that
drops the needed fact is not optimization; it is debt.

## 11. Feature Optimization By Orange Pillar

### 11.1 Atomic Orange app

Atomic Orange should not display raw system sprawl by default. It should show:

```text
active order
active workset
chosen route
loaded cartridges
active model tier
Codexa lease state
receipt state
debt score
saved-work hits
pathwave match
canon candidates
warnings and blockers
```

The app should let the operator drill down into raw receipts, but raw logs
should not be the primary surface.

### 11.2 OrangeBrain

OrangeBrain should never operate from freeform project memory alone. It should
consume:

```text
cartridges
AIR frames
commitment atoms
equations
sparse worksets
route decisions
prior pathwaves
saved-work certificates
```

Its job is to choose and command; AtomSmasher prepares the compressed truth it
commands from.

### 11.3 AE Memory / AE Cobra

AE Cobra is the ingest and memory driver. AtomSmasher is the sieve and compiler.

AE Cobra should:

```text
ingest receipts
index source truth
push candidate concepts to AtomSmasher
store cold ledger artifacts
surface active memory
```

AtomSmasher should:

```text
turn the ingested truth into operational compression structures
```

### 11.4 AE Eyes

AE Eyes produces visual evidence. AtomSmasher compresses that evidence into:

```text
visual findings
layout facts
confidence
image hashes
issue categories
receipt anchors
pathwave steps
```

The raw screenshot remains cold truth. The hot context gets the visual finding
and hash.

### 11.5 AECode

AECode is the software intent language. AtomSmasher should export AECode from:

```text
commitment atoms
tasks
constraints
equations
accepted pathwaves
receipt-backed product rules
```

This means AECode is not generated from vague chat. It is generated from
compressed, source-backed project truth.

### 11.6 ToolMesh

Tools should become compressed capability objects:

```text
tool name
capabilities
inputs
outputs
side effects
risk
proof requirements
receipts
allowed scope
```

AtomSmasher should wake the smallest useful toolset, not every tool.

## 12. N150 And Codexa Operating Model

The N150 dev machine should run the hot control and compression layer:

```text
Atomic Orange app
Bun control scripts
small reflex brain
status checks
sparse workset building
AIR compression for small inputs
least-action routing
receipt reads
operator interaction
```

Codexa should handle heavy work:

```text
large model inference
model training
large corpus compression
full feature sweeps
embedding/reranking if installed
visual/model-heavy lanes
batch proof jobs
```

The route should not blindly use Codexa. Codexa is a heavy lease. If
unreachable, the system reports that state and continues local read-only or
small local routes when safe.

## 13. Full-Level Compression Feature Map

The target mature feature map:

```text
Raw Ledger
  cold source truth, never erased

Span Index
  source chunks and searchable references

Commitment Atoms
  durable decisions, laws, invariants, promises

AIR Codec
  structured compression of prose and reports

EquationStore
  formula and invariant compression for numeric/structural truth

Cartridge Registry
  reusable domain capability packs

Sparse Worksets
  minimum necessary active context per request

Least-action Router
  minimum cost/risk/latency execution path

Expansion Warrants
  explicit authorization for scope growth

Compression Debt Ledger
  accounting for verbose fallback and missed compression

Saved Work Certificates
  proof of reusable completed work

Canon Pressure Detector
  detects concepts ready for doctrine review

Pathwave Compressor
  reusable compressed workflow trajectories

Anti-Fluff Gate
  rejects filler, hedging, and fake-green claims

AECode Export
  turns compressed software intent into buildable source contracts

ToolMesh Compression
  maps many tools into routeable capability cards

Receipt Compiler
  turns actions into proof-backed reports

Runtime Status Sieve
  displays truth without flooding the operator
```

## 14. What To Optimize First

Priority order:

1. Reconcile the full-scope engine with visible module status.
2. Make full-scope receipts the primary status source.
3. Wire order/report flow through AtomSmasher before model dispatch.
4. Put sparse workset and least-action route in the hot path.
5. Add saved-work cert lookup before expensive work.
6. Add compression debt after verbose fallback.
7. Add cartridge selection for project/operator/tool domains.
8. Add Atomic Orange compression dashboard.
9. Add pathwave capture for successful workflows.
10. Add canon pressure review queue.

Do not optimize experimental model lanes before the compression spine is used
on every request. A better model without compression still repeats work.

## 15. No-Fake-Green Rules

Never claim:

```text
all modules are fully integrated
all gateway routes exist
all persistence exists
all 620 features are wired into every Orange runtime path
all docs and status registries agree
compression is lossless
AIR is always smaller on wire
local models are installed just because roles exist
Codexa is available unless probed
```

Allowed claim shape:

```text
The full-scope Bun engine is documented as canonical and claims 620-feature proof.
Some older module primitives have live smoke-test documentation.
Some older module persistence/gateway integrations remain pending by their own docs.
Promotion requires receipt-backed proof.
```

## 16. Operator Rules

AtomSmasher must obey:

```text
No raw expansion without warrant.
No fake green.
No model-only authority.
No deleting cold truth.
No hidden promotion.
No unreceipted completion.
No giant context replay by default.
No stale memory over fresh receipts.
No status surface disagreement left unreported.
```

## 17. Target Orange Behavior

When fully optimized, a user request should feel like this:

```text
User gives intent.
Orange converts it to order.
AtomSmasher loads the smallest correct truth.
OrangeBrain chooses the route.
Hermes/tools execute.
STRONGARM/Mirror discipline the result.
Orange returns a report.
Receipts prove it.
Saved-work prevents redo.
Debt tells what still wastes time.
Pathwave teaches the next run.
Canon pressure captures new doctrine.
```

The visible result is speed and clarity.

The hidden mechanism is compression with proof.

## 18. Practical Next Work

Concrete work to finish the operational loop:

```text
1. Run the full-scope test sweep and capture a fresh receipt.
2. Reconcile modules/index.mjs status with full-scope reality.
3. Add a single AtomSmasher status report command.
4. Expose current compression metrics to Atomic Orange.
5. Route OrangeBrain order/report calls through sparse workset + least-action.
6. Add saved-work lookup before proof/build/research runs.
7. Add compression-debt recording on verbose fallback.
8. Add canon-pressure ingestion from real receipts.
9. Add pathwave capture for successful Orange workflows.
10. Retire or mark redundant older module folders only after receipt-backed review.
```

## 19. Final Theory

AtomSmasher 2 is the part of Orange that makes intelligence economical.

It turns the system from:

```text
ask big model, paste lots of context, hope memory is right
```

into:

```text
load compressed truth, route least action, prove work, reuse the proof
```

That is the operational reason it exists.

Orange becomes powerful when AtomSmasher is not a side module, but the default
path every order passes through.
