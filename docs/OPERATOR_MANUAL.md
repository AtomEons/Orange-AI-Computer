# Æ Orange AI Computer Operator Manual

This manual explains how to operate Æ Orange AI Computer without confusing a configured
feature, a model suggestion, or a passing unit test with executed work.

Æ Orange AI Computer is the public product. Atomic Orange is an optional
interface; the governed backend must remain usable headlessly.

## Recorded Lab Evidence - 2026-08-28

- One recorded two-computer run routed its primary Navigator through an
  authenticated compute host at `10.0.0.4`. That does not establish present
  availability on another system.
- The selected integrated receipt records 10 stdio and 12 authenticated
  loopback HTTP Brain MCP tools.
- The selected 10-lane receipt accepted 10/10 exact-path lanes in that run.
- Context Crystal passed 5/5 held-out parity at a minimum `1422.901x` across a
  7,056,795-byte corpus.
- AE Memory passed 23/23 with hybrid MRR `0.9058`, p50 `281 ms`, and p95
  `445 ms`.
- Media artifacts are technically valid; studio quality is not certified.
- One Hermes Brain MCP delegation completed parent execution, child work, synthesis,
  receipt creation, and lease revocation with all ten checks true in
  `11,409.53 ms`.

The selected public receipts are under `proof/`. Re-probe the exact target
before relying on any route, host, model, or endpoint now.

## 1. Operator Mental Model

Orange has three layers:

1. Deterministic control: Bun validates orders, policy, scope, routing,
   approvals, evidence, execution attestation, and receipts.
2. Governed intelligence: Navigator and specialist models interpret,
   synthesize, review, or generate artifacts under a bounded lease.
3. Effectors: explicit tools and proved Hermes paths perform authorized actions.

A model can finish an analysis. It cannot declare that a filesystem change,
process, deployment, or test happened unless the governed executor and receipt
prove it.

## 2. Start Of Session

From the canonical root:

```powershell
Set-Location .\system
bun 03-BACKEND/spine-cli.mjs --health
bun 03-BACKEND/orange.mjs status
git status --short
```

Confirm:

- the target project and allowed scope;
- whether the job is read-only or mutating;
- which host is available;
- the latest relevant receipt;
- whether another writer owns the same files.

Do not erase a dirty tree. Orange assumes other agents and the operator may be
working at the same time.

## 3. Orders

Operational input is `orange.order.v1`. Prefer an order file for durable work.

```json
{
  "schema": "orange.order.v1",
  "orderId": "example-health-001",
  "action": "read.health",
  "payload": {},
  "scope": ["C:/path/to/Orange-AI-Computer/system"],
  "allowedActions": ["read"],
  "forbiddenActions": ["delete", "deploy"],
  "targetProject": "orange-ai-computer",
  "riskLevel": "low",
  "requiresReceipt": true
}
```

Run it:

```powershell
bun 03-BACKEND/spine-cli.mjs --order-file C:\path\to\order.json
```

Options:

- `--dry-run`: plan without execution or receipt writes.
- `--learn`: after successful execution, submit a governed lesson to memory.
- `--seed value`: make a replayable deterministic run.
- `--strict`: request strict epistemic enforcement.
- `--advisory`: record epistemic scoring without strict enforcement.

If an action appears in both `allowedActions` and `forbiddenActions`, the CLI
rejects the lease. High, destructive, irreversible, and production risk
requires approval.

## 4. Reports And Receipts

Operational output is `orange.report.v1`. A useful report contains:

- status and confidence;
- actions actually taken;
- evidence;
- blockers;
- next action;
- receipt path or receipt identity.

Use this evidence order:

1. Current semantic live probe.
2. Current hash-chained receipt.
3. Current executable test.
4. Current source and configuration.
5. Runtime authority.
6. Historical plans.
7. Chat claims.

The current receipt store is under `10-RECEIPTS`. Machine-local state also
lives under `%USERPROFILE%\OrangeBox-Data\orange5`. Do not store credentials in
either repository documentation or prompts.

## 5. Three-Speed Routing

Orange normally chooses the route. The operator should not need to pick a model
for ordinary work.

### Reflex

Deterministic Bun handles schemas, health, common routing, policy, state, and
repeatable work. It uses no model RAM.

### Navigator

The Orange-aware Navigator interprets intent and compiles compact orchestration
packets. Current runtime authority names
`orange-navigator:ornith-1.5-9b-q4km` as the Codexa Navigator lane.

### Specialist

Code, visual, creative, or heavy-judgment models wake only when the request
earns their memory and latency cost. The current code lane is
`qwen3-coder:30b`. Installed weights are not proof that a route used them.

## 6. Host Operation

### Preferred two-computer mode

- N150: deterministic Bun control, development, receipts, tunnels, clients.
- Codexa: Navigator, heavy models, visual workers, training, Docker, long jobs.

Preferred Codexa discovery is `CODEXA` or `CODEXA.local`. The current local
installation uses `10.0.0.4`, but a distributable install must discover and
persist its own topology.

### One-computer mode

Keep Bun control local. Install only roles that pass hardware planning. A
hosted frontier lease may fill a heavy role, but Orange control and evidence
must remain local. A missing heavy role returns a truthful blocker rather than
a silent downgrade.

### Immutable deployment boundary

The Orange deploy payload is immutable. Hermes profiles, policy, model roles,
and configuration templates ship pre-authored. An LLM has no authority to edit
the payload during setup. It may present the fixed manifest, record optional
deselections, request approval, and invoke the deterministic deploy engine.

Compatible installed Bun, Ollama, models, and tools are adopted. Missing
approved components download automatically after approval. Mutable runtime
state, secrets, memory, receipts, logs, and machine topology belong under
`%USERPROFILE%\OrangeBox-Data`, not inside the payload.

## 7. Memory And Continuity

AE Memory / Cobra stores durable facts, decisions, failures, and receipts on
disk. Project Continuum preserves full source and transcript lineage, then
hydrates only the relevant workbench.

Use governed learning only after real work:

```powershell
bun 03-BACKEND/spine-cli.mjs --order-file C:\path\to\order.json --learn
```

Learning must remain scoped to matching intent, project, and failure context.
Contradictions become debt records; they are not silently merged.

Superdirectory maintenance commands:

```powershell
bun run orange:superdirectory:current
bun run orange:superdirectory:docs
bun run orange:superdirectory:all
```

Use current-project ingestion for daily work. Full ingestion is bounded
maintenance, not a normal prompt strategy.

## 8. AtomSmasher And Context Crystal

AtomSmasher creates the smallest source-backed operational workbench. It
deduplicates state, preserves commitments, selects sparse source spans,
represents regular numeric data as equations plus residuals, reuses cartridges,
tracks compression debt, and hydrates exact source only when needed.

Compression ratios are workload-specific. A corpus benchmark is not a promise
for every live task. The cold ledger remains recoverable.

Current public documentation uses the held-out result only: 5/5 parity with a
minimum `1422.901x` operational context ratio. Live-turn and corpus ratios stay
separate because their denominators and workloads differ.

Focused commands:

```powershell
bun run bench:context-crystal-quality
bun run bench:memory-quality
bun run test:atomsmasher
```

## 9. Hermes Operation

Hermes supplies bounded hands. Orange retains policy, approval, receipt, and
promotion authority.

The official product integration defines six isolated profiles:

- Navigator: conductor and work decomposition.
- Builder: implementation and the only direct mutation role.
- Researcher: current evidence gathering.
- Reviewer: proof tribunal with no mutation tools.
- Visual: rendered-truth review with no mutation tools.
- Misfit: dissent packet with no execution or signing authority.

The intended owner shape is one gateway, one Kanban dispatcher, one conductor,
and at most two active specialists. Use durable Kanban for cross-profile or
restart-surviving work. Use short delegation only for an answer the current
turn must await.

The Hermes product integration is currently configured statically. Read its
fresh preflight before claiming that the gateway, Kanban, and API are live.
The fresh Brain MCP delegation proof completed the mediated parent action, one
child, synthesis, receipts, and lease revocation. Treat that path as proven for
its harmless read contract; mutating, multi-child, and long-job workflows retain
their own proof requirements.

## 10. Creative And Model Leases

Captain Planet allows one heavy creative specialist at a time with a 50 GiB
live-memory ceiling. It unloads before loading, denies unknown memory, preserves
unowned models, and requires an artifact bakeoff before promotion.

Catalog and dry run:

```powershell
bun 14-SUPERSTACK/captain-planet-governor.mjs catalog
bun 14-SUPERSTACK/captain-planet-governor.mjs dry-run --all
```

Do not execute a model download or lease until its plan has been reviewed.
See [Model Installation Guide](MODEL_INSTALLATION_GUIDE.md).

## 11. Brain MCP

Brain MCP is the preferred client boundary:

- stdio for Codex, Claude Desktop, and compatible IDE clients;
- loopback Streamable HTTP for apps and model-to-model calls.

Core tools include health, order, route, chat, receipts, superstack, model
lease, bounded delegation, filesystem/process execution, and browser workflow.
Side-effecting notifications without a request id are ignored. HTTP refuses
non-loopback binds.

The current proof observes 10 tools over stdio and 12 over authenticated
loopback Streamable HTTP. The transport-specific counts are intentional.

## 12. Failure Handling

### OrangeBrain unavailable

1. Run spine health.
2. Inspect the newest runtime receipt.
3. Run the runtime ensure command only after reviewing its behavior.
4. Confirm the active route and model from fresh evidence.

### Codexa unavailable

1. Resolve `CODEXA` and `CODEXA.local`.
2. Probe authenticated SSH and the command rail.
3. Keep deterministic local reads alive.
4. Return a heavy-lane blocker. Do not expose an unauthenticated service.

### A model loses scope

1. Stop freeform execution.
2. Read [LLM Operator Guide](LLM_OPERATOR_GUIDE.md).
3. Read runtime authority and current receipts.
4. Reissue the job as a scoped order.

### A gate halts

Preserve the halt. Report the exact gate, evidence, blocker, and next valid
action. Do not retry blindly or weaken the gate.

## 13. End Of Session

Report:

```text
status
actions actually taken
fresh evidence
remaining blockers
next exact action
receipt path
```

## Related Guides

- [Quick Start](QUICK_START.md)
- [Technical Architecture](TECHNICAL_ARCHITECTURE.md)
- [LLM Operator Guide](LLM_OPERATOR_GUIDE.md)
- [Features Guide](FEATURES_GUIDE.md)
- [Model Installation Guide](MODEL_INSTALLATION_GUIDE.md)
