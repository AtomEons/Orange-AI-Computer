# OrangeFive Good-to-Great Execution Plan

Date: 2026-08-27
Product: Orange
Release: OrangeFive
Canonical root: `C:\AtomEons\Orange5`
Status: active implementation plan; receipts and live probes outrank this document

## Mission

Orange is a local-first AI computer for building real work. Atomic Orange is its native operator interface. OrangeBrain is its governed intelligence gateway. Hermes supplies bounded workers. AE Memory, Context Crystal, AtomSmasher, AE Eyes, current awareness, FLOW, receipts, and the Party Line keep the system informed, compact, observable, and honest.

The four product goals are:

1. Finish the Orange visual system as a truthful, living control surface.
2. Finish Atomic Orange as an exceptional AI-builder command application.
3. Prove Orange with a comprehensive reproducible benchmark suite.
4. Run a Fixer program that finds and repairs real defects while the lead remains focused on product architecture.

Party Line is the connective tissue across all four goals.

## Non-Negotiable Law

- One product: Orange. One release: OrangeFive.
- Orange3 is historical. Orange4 was a theory phase. Neither is an active product.
- The interface is not the intelligence.
- Human conversation stays natural. Machine operations use `orange.order.v1` and `orange.report.v1`.
- Receipts, probes, screenshots, hashes, and exact-path verification outrank claims.
- A process starting is not proof that a feature works.
- No fake green, silent fallback, hidden route, or scaffold described as operational.
- Models are leased by capability. They are not all resident in memory.
- N150 is control and development. Codexa is heavy inference, training, media, and batch work.
- Full history lives on disk. Models receive the smallest source-addressed workbench that preserves the current task.
- No visible background PowerShell windows. Routine status belongs in Atomic Orange and Party Line.
- Atomic Orange remains Tauri v2 plus React/Vite. It is not Electron and not a browser product.
- Existing Atomic Chat capability is preserved unless a measured Orange replacement is stronger.

## One-System Architecture

```text
Operator / Codex / Claude / Atomic Orange
                    |
          OrangeFive Brain MCP
          OpenAI-compatible gateway
                    |
                OrangeBrain
     conversation surface | order/report surface
                    |
      deterministic least-action conductor + FLOW
                    |
       +------------+-------------+
       |            |             |
   local reflex   Navigator    specialists
   no model       Codexa hot    code/vision/heavy/media
       |            |             |
       +------------+-------------+
                    |
       Hermes leases + ToolMesh + Fixer
                    |
    exact execution + verification + receipts
                    |
 AE Memory / Context Crystal / AtomSmasher / awareness
                    |
       Party Line disk operations room
                    |
     Atomic Orange living truth surfaces
```

## Shared Runtime Objects

### Build Run

Every meaningful project operation converges on one durable object:

```ts
type BuildRun = {
  schema: 'atomic-orange.build-run.v1'
  runId: string
  threadId: string | null
  goal: string
  projectRoot: string
  workspaceRoots: string[]
  mode: 'plan' | 'execute' | 'repair' | 'verify' | 'release'
  stage: 'intake' | 'route' | 'plan' | 'approve' | 'lease' | 'execute' | 'observe' | 'verify' | 'settle'
  status: 'draft' | 'planned' | 'awaiting_approval' | 'working' | 'blocked' | 'failed' | 'completed' | 'cancelled'
  order: object | null
  route: object | null
  modelLane: object | null
  leases: object[]
  tasks: object[]
  tools: object[]
  approvals: object[]
  evidence: object[]
  receipts: object[]
  blockers: object[]
  nextAction: string | null
}
```

This replaces scattered UI-only state as the project command truth. Chat, Cockpit, Vault, Party Line, Fixer, and benchmarks project from the same run.

### Party Line Event

`orange.party-line.event.v1` is a hash-chained append-only operations event. It carries actor, topic, event type, summary, optional transcript body, proof links, correlation id, sequence, prior hash, and entry hash.

Canonical storage:

```text
%USERPROFILE%\OrangeBox-Data\orange5\control\party-line\events.jsonl
```

Rules:

- JSONL is canonical. Any index is rebuildable.
- No whole-transcript RAM cache.
- Cursor reads use byte offsets and cold-start from disk.
- `quiet`, `normal`, `deep`, and `wire` projections control presentation, not storage truth.
- Models hydrate selected relevant events with exact `[party:<event-id>]` pointers.
- Party Line does not authorize work and is not proof authority.
- Hermes authorizes. Receipts prove. Party Line makes the work jointly visible.

### Fixer Case

```ts
type FixerCase = {
  schema: 'orange.fixer.case.v1'
  defectId: string
  runId: string
  source: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  state: 'detected' | 'reproduced' | 'isolated' | 'repair_planned' | 'leased' | 'patched' | 'exact_path_verified' | 'regression_encoded' | 'closed'
  attempts: number
  reproducer: object | null
  suspectedBoundary: string | null
  repairOrder: object | null
  hermesLease: object | null
  evidence: object[]
  rollback: object | null
  regression: object | null
  receiptPath: string | null
}
```

Two failed attempts against the same cause force a changed method or escalation. Blind retry is prohibited.

## Goal 1: Finished Orange Visual System

### Product Shape

The visual system is a living truth instrument, not decorative telemetry. The practical Atomic Chat fork remains the main application. Proven Rust/WGSL/AELID work is docked into it as bounded native or WebGPU surfaces instead of becoming a disconnected second product.

### Required Surfaces

- Global Runtime Dock: OrangeBrain, Navigator, memory, Hermes, AtomSmasher, learning, Codexa, and Party Line truth.
- Chat: flowing human conversation with an expandable evidence sidecar.
- Cockpit / AE See Suite Lite: project run, mission graph, model lanes, agents, tools, blockers, and receipts.
- Vault: searchable memory, evidence, receipts, decisions, failure memory, and why-lineage.
- Party Line: global Slack-like room for operator, models, agents, tools, Fixer, and system events.
- Model Lane Board: requested model, effective model, node, tier, lease, latency, route, and proof.
- Truth Gradient: every status carries timestamp, source, freshness, confidence, and proof class.
- Current Awareness: quarantined research, freshness, candidate/incumbent comparison, and promotion evidence.
- AE Eyes: ingest, query, describe, queue, video frames, and source-addressed visual evidence.
- Mission Graph: persistent build DAG across chat, agents, tools, models, failures, and restarts.
- Time Machine: inspect prior build-run and Party Line state without mutating current truth.

### Motion Law

- Motion communicates state change, causality, urgency, or completion.
- No ambient movement that consumes attention without information.
- Living field intensity derives from real work pressure and FLOW.
- Quiet mode is calm and dense. Failure and completion transitions are unmistakable.
- Every visual status must be inspectable back to a source or clearly labeled observation.

### Acceptance

- Current Tauri desktop launches and all primary routes render.
- No overlapping text or controls at supported Windows dimensions.
- Party Line works globally and survives app/gateway restart.
- Codexa offline, unauthorized, and unavailable states remain distinguishable.
- Screenshots and deterministic app-owned probes cover each state.
- Visual values match live gateway/receipt truth.
- Native performance has measured CPU, memory, frame pacing, and idle behavior.

## Goal 2: Atomic Orange AI-Builder Command App

### Product Position

Atomic Orange is an Atomic Chat-derived native AI computer interface with Orange governance on every turn. It preserves local GGUF models, providers, projects, assistants, MCP, agent mode, model controls, context controls, artifacts, and updates while adding durable Orange project intelligence.

It aims to exceed ordinary coding chat in the Orange scope: governed multi-model local-first building, persistent project truth, source-addressed memory, visual understanding, receipts, replay, and no-ghost execution. This is not a claim of universal superiority over every coding product.

### Core Workflows

1. Ask and understand: natural answer first; lane/model/receipt metadata remains compact.
2. Plan a build: create a Build Run, resolve scope, choose least-action route, and expose the plan.
3. Execute: obtain Hermes lease, run exact tools, stream events to Party Line, and preserve rollback.
4. Verify: replay the user's real path, run deterministic checks, capture evidence, and settle the run.
5. Repair: Fixer opens a case, reproduces, isolates, patches under lease, verifies, and records regression.
6. Research: current-awareness collector quarantines fresh claims until benchmarked against the incumbent.
7. Recall why: Vault opens the decision, source, contradiction, supersession, and receipt lineage.
8. Multi-model work: conductor assigns bounded specialist leases and compares evidence, not personalities.

### Conversation and Operations Boundary

- Atomic Orange sends `ae_response_mode: conversation` for human chat.
- Machine calls retain `orange.report.v1` by default.
- Both paths use the same Orange system prompt, memory, routing, failure guard, learning finalizer, receipts, and Party Line.
- The interface renders a normal answer. It never replaces every answer with a receipt card.
- A receipt drawer exposes proof only when wanted.

### Upstream Parity Guard

Track Atomic Chat upstream releases. For each release:

1. Fetch and diff upstream without mutating main.
2. Classify security, runtime, model, UI, and migration changes.
3. Preserve Orange contracts and brand boundaries.
4. Run clean-checkout build and conversation tests.
5. Promote only with a receipt and rollback point.

### Acceptance

- Local and remote OpenAI-compatible models can converse normally.
- Orange-auto routes without bypassing OrangeBrain.
- Agent operations create Build Runs and real evidence.
- MCP and Hermes tools fail closed with understandable UI states.
- Party Line includes every model/operator chat turn and accepts agent/tool events.
- Restart restores projects, Build Runs, Party Line cursor, and source lineage from disk.
- Clean checkout builds without relying on parent dependencies or ignored files.
- Current GitHub CI is green for the exact commit.

## Party Line: Shared Operations Room

### Actors

- Operator
- OrangeBrain and Navigator
- leased specialist models
- Hermes workers and councils
- Fixer
- AE Eyes
- AtomSmasher and memory organs
- ToolMesh tools
- runtime and release services

### Event Types

`message`, `order`, `report`, `decision`, `tool`, `receipt`, `status`, `blocker`, `repair`.

### Detail Modes

- `quiet`: actor, type, time, one-line summary, state.
- `normal`: summary, body, tags, correlation, proof count.
- `deep`: source refs, compact internals, blockers, route factors.
- `wire`: exact event JSON, hashes, cursor, and full envelope.

### Delivery

- HTTP cursor reads for deterministic consumers.
- SSE live tail for the app and capable clients.
- Brain MCP read/post/hydrate tools for Codex, Claude, models, and agents.
- Global Atomic Orange drawer in the Runtime Dock.
- Docked Party Line surface inside Cockpit and Vault later.

### Noise Control

- Quiet is the default visible mode.
- Repeated identical status events collapse in projection, never in canonical storage.
- Popups are reserved for approval, kill-switch, and safety-critical intervention.
- Fixer and services publish status to Party Line instead of opening terminals.

## Goal 3: OrangeFive Blue Bench

Suite name: `orange5-blue-bench.v1`.

Every run records commit, environment, machine, model ids, tool versions, seed, fixtures, timestamps, raw metrics, artifacts, and hash-chained receipt.

### Lanes

1. Context Crystal and AtomSmasher
   - compare raw, Brotli/deflate, Context Crystal, and AtomSmasher
   - ratio, reconstruction, source hash, claim coverage, forbidden claims, citation validity, latency, hydration cost
   - no universal compression claim from a single corpus

2. AE Memory
   - none, lexical, dense, hybrid, gateway recall, Cobra direct, fallback
   - recall@k, MRR, contradiction detection, source validity, p50/p95, fallback honesty

3. OrangeBrain Routing
   - reflex, Navigator, code, heavy, visual, offline Codexa, unauthorized Codexa
   - route accuracy, least-action score, effective model truth, bypass count, receipt completeness

4. Hermes
   - dry run, lease, approval, MCP, execution, expiry, revocation, settlement
   - destructive action blocks without approval; retries are idempotent

5. Current Awareness
   - fresh collector, stale source, future-dated source, incumbent/candidate promotion, quarantine

6. AE Eyes
   - ingest, query, describe, visual structure, retinal transform, queue, hardware route, human quality cases

7. No-Ghost Proof
   - broken hash chain, missing prior hash, duplicate event, invalid artifact, start-only claim, silent fallback

8. Atomic Orange Conversation
   - provider selection, OrangeBrain route, SSE, conversation/report separation, metadata, project continuity, native UI

9. Party Line
   - append p95, cursor read p95, chain continuity, cold restart, SSE tail, filtering, detail projection, hydration precision, zero-popup count

10. Fixer
    - defect detection precision, reproduction success, changed-method rule, rollback, exact-path verification, regression closure

### Hard Promotion Rules

- Zero boundary bypasses, fabricated receipts, silent fallback, or broken chains.
- Hermes blocks unapproved destructive action in all adversarial cases.
- Source hashes and referenced artifacts validate.
- Context quality is at least 0.75 and no worse than the protected baseline.
- Memory MRR is at least 0.80 and p95 remains under 1000 ms on declared hardware.
- Routing accuracy is at least 95 percent on held-out capability cases.
- AtomSmasher must pass its complete test suite and exact feature inventory.
- Native desktop requires an actual process, actual roundtrip, and actual screenshot evidence.
- Studio media quality requires task-specific human and deterministic evaluation; model presence is not quality proof.

### Report

Produce:

```text
10-RECEIPTS/orange5-build/blue-bench/<run-id>/manifest.json
10-RECEIPTS/orange5-build/blue-bench/<run-id>/results.json
10-RECEIPTS/orange5-build/blue-bench/<run-id>/artifacts/
10-RECEIPTS/orange5-build/blue-bench/<run-id>/report.md
```

The report separates proven advantages, parity, regressions, blocked lanes, and untested hypotheses. It may credit AtomEons and Daybreak Blue for authored hard problems only where exact provenance exists.

## Goal 4: Fixer Program

### Purpose

Fixer finds and closes real defects while the lead model remains product manager and systems architect. It is not broad self-heal and not an endless watcher loop.

### Sources

- failing deterministic tests
- live health contradictions
- route and model mismatches
- Party Line blockers
- user-path failures
- stale or missing receipts
- learning queue failures
- broken service independence
- benchmark regressions
- visual state/proof mismatches

### Lifecycle

```text
detected
-> reproduced
-> isolated
-> repair_planned
-> Hermes lease
-> patched
-> exact user path verified
-> regression encoded
-> receipt settled
-> closed
```

### Rules

- Candidate findings do not mutate code.
- A reproducer is mandatory before repair.
- One writer owns overlapping files.
- Repair scope is bounded to the isolated cause.
- Every mutation has rollback and Hermes authorization.
- Two same-method failures force method change or escalation.
- Closing requires exact-path verification and a regression test.
- Fixer publishes lifecycle events to Party Line.
- The lead sees ranked exceptions, not noisy polling.

## Parallel Ownership

### Lead Codex

- product architecture and cross-organ contracts
- integration review
- highest-risk code
- acceptance decisions
- truth report and GitHub promotion

### Hermes Workers

- bounded tests
- narrow adapters
- fixture construction
- deterministic data conversion
- docs tied to proven behavior
- isolated fixes with non-overlapping write ownership

### Mirror / STRONGARM / Misfit / Swarm Sentinel

- Mirror verifies claims and artifacts.
- STRONGARM enforces productive completion shape.
- Misfit challenges scope collapse, theater, and false refusal.
- Swarm Sentinel detects duplicate work, conflicting writers, resource overcommit, and weak evidence.

## Execution Waves

### Wave A: Shared Reality

- Complete Party Line ledger, gateway, MCP, chat integration, and Atomic Orange drawer.
- Add Build Run schema/store and project continuity.
- Route all status away from visible terminal popups.

### Wave B: Conversation to Work

- Prove natural conversation through OrangeBrain.
- Add explicit Plan, Execute, Repair, Verify, and Release run modes.
- Show effective route, evidence, and next action without replacing the answer.

### Wave C: Living Visual Truth

- Dock current runtime truth, mission graph, model lane board, Party Line, Vault, and AE Eyes.
- Port only useful WGSL/AELID behaviors into the main Tauri app.
- Validate screenshots, keyboard flow, density, idle use, and failure states.

### Wave D: Fixer

- Implement defect store, ranking, reproducer, Hermes dispatch, verification, regression, and Party Line publisher.
- Seed with currently known failures and close them one by one.

### Wave E: Blue Bench

- Implement manifest and lane runners.
- Run protected baselines.
- Fix regressions before publishing advantages.
- Generate the final technical report.

### Wave F: Clean Product Proof

- Clean checkout.
- Install dependencies from declared manifests.
- Build web assets and Tauri native app.
- Run full tests and live roundtrips.
- Verify Git status, commit, remote, CI, artifacts, and docs.

## Current Truth and Known Gaps

As of the 2026-08-27 Party Line proof:

- Party Line backend, gateway routes, MCP tools, chat publication/hydration, and the Atomic Orange drawer are implemented.
- Focused Party Line, chat harness, and Brain MCP coverage passes 21/21. The Atomic Orange production web bundle also builds successfully.
- The live gateway is reloaded on `orange5.orangellm.v0.7.0-party-line`. SSE append/tail, disk hash-chain validation, exact-id hydration, natural Navigator conversation, source-id citation, turn publication, and governed receipt creation pass in `10-RECEIPTS/orange5-build/2026-08-27T22-30-16-594Z-party-line-live-proof.json`.
- Native-window visual interaction and restart restoration of the drawer cursor still require a screenshot/user-path proof; build success is not substituted for that visual proof.
- Codexa rail is reachable but the latest observed authorization state was false/401; this is a real blocker for governed heavy execution.
- The latest known AtomSmasher full-suite receipt was 82/83, with codec export failing; 620-feature aggregate execution does not erase that failure.
- OpenVINO remains research, not promoted AE Eyes runtime truth.
- Existing Rust/WGSL visual work is not yet integrated into the practical Atomic Orange fork.
- Build Run unification is not yet implemented.
- Fixer lifecycle is not yet implemented.
- Blue Bench orchestration/report is not yet implemented.
- Studio-quality image/video/audio generation is not proven merely because models or manifests exist.

## Definition of Great

OrangeFive is great when a new user can install it, open Atomic Orange or any compatible MCP client, start a project, converse naturally, inspect what the system truly knows, authorize bounded work, watch models and agents collaborate through Party Line, recover the exact why behind decisions, survive restarts without losing scope, and receive working artifacts with replayable proof.

The system should feel fast because it avoids unnecessary work, not because it hides work. It should feel intelligent because it preserves causes, commitments, failures, and sources, not because it produces more prose. It should feel alive because every visual response is attached to real state.

Completion requires the four goals to pass their exact acceptance gates and the current not-green list to be empty. Until then, this remains an execution plan rather than a release declaration.
