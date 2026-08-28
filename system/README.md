# Æ Orange AI Computer

**A local-first AI computer control plane for building, operating, and proving work.**

Æ Orange AI Computer is the product. Atomic Orange is the native operator
interface; it is not the intelligence. The control plane,
memory, compression, routing, model leases, bounded agents, and receipts remain
usable headlessly.

> **Core law:** no model, agent, interface, test fixture, or process start may
> claim that work happened. Execution evidence and receipts decide.

## Start Here

| Reader | First document |
|---|---|
| New operator | [Quick Start](00-CHARTER/GUIDES/QUICK_START.md) |
| Experienced operator | [Operator Manual](00-CHARTER/GUIDES/OPERATOR_MANUAL.md) |
| Coding model with zero memory | [LLM Operator Guide](00-CHARTER/GUIDES/LLM_OPERATOR_GUIDE.md) |
| Systems engineer | [Technical Architecture](00-CHARTER/GUIDES/TECHNICAL_ARCHITECTURE.md) |
| Skeptical reviewer | [Skeptic's Field Guide](00-CHARTER/GUIDES/SKEPTICS_FIELD_GUIDE.md) |
| Benchmark reviewer | [Proof and Benchmarks](00-CHARTER/GUIDES/PROOF_AND_BENCHMARKS.md) |
| Installer | [Model Installation Guide](00-CHARTER/GUIDES/MODEL_INSTALLATION_GUIDE.md) |
| Incident responder | [Troubleshooting and Recovery](00-CHARTER/GUIDES/TROUBLESHOOTING_AND_RECOVERY.md) |
| Memory operator | [Memory and Learning](00-CHARTER/GUIDES/MEMORY_AND_LEARNING.md) |
| Audit reviewer | [Receipts and Audit](00-CHARTER/GUIDES/RECEIPTS_AND_AUDIT.md) |
| Native app operator | [Atomic Orange Native App](00-CHARTER/GUIDES/ATOMIC_ORANGE_NATIVE_APP.md) |
| Production compression operator | [AtomSmasher Production](00-CHARTER/GUIDES/ATOMSMASHER_PRODUCTION.md) |
| Systems design reader | [Female Systems Design Innovations](00-CHARTER/GUIDES/FEMALE_SYSTEMS_DESIGN_INNOVATIONS.md) |
| Complete index | [Documentation Map](00-CHARTER/GUIDES/README.md) |

Generated PDFs are published under `00-CHARTER/GUIDES/pdf`. Markdown is the
canonical source; PDFs are generated outputs and must never be hand-edited.

## What Æ Orange AI Computer Is

Æ Orange AI Computer separates five concerns that ordinary chat and agent
products blend:

1. **Operator surface:** Atomic Orange, MCP clients, CLI, or another compatible
   interface.
2. **Deterministic control:** Bun validates orders, scope, policy, evidence,
   routing, and completion claims.
3. **Governed intelligence:** an Orange-aware Navigator and leased specialists
   interpret, generate, review, or plan.
4. **Bounded execution:** Hermes performs approved actions through LOOM gates
   and returns evidence.
5. **Continuity:** AE Memory, Project Continuum, Context Crystal, AtomSmasher,
   and hash-chained receipts preserve what matters without flooding prompts.

The interface is replaceable. Models are replaceable. Operational contracts,
source truth, evidence, and receipts remain stable.

## Brand Law

Æ Orange AI Computer challenges incumbents oranges-to-apples: on useful work,
accessible hardware, total operator control, and evidence that another person
can inspect. It does not imitate another lab's voice, interface, mythology, or
claims.

Its character is underestimated Good Will Hunting-style intelligence translated
into an original Orange idea: quiet capability, practical reach, and the nerve
to let hard results speak first. Accessible hardware is a design constraint,
not a consolation prize. Confidence is earned by completed work, falsifiers,
receipts, and reproducible proof. Hype never outranks evidence.

Public product identity is always **Æ Orange AI Computer**. Internal contracts
retain the machine ID `orange5` and the canonical root `C:\AtomEons\Orange5`.
See the [Wave 2 Captain's Log](00-CHARTER/ORANGE_AI_COMPUTER_WAVE2_CAPTAINS_LOG.md)
for the documentation handoff.

## The Runtime Crossing

```text
orange.order.v1
  -> schema, scope, risk, and approval validation
  -> project continuity and failure-memory recall
  -> Context Crystal / AtomSmasher sparse workbench
  -> least-action route
  -> Navigator or specialist lease only when warranted
  -> Hermes governed execution when action is required
  -> verification and contradiction checks
  -> orange.report.v1
  -> hash-chained receipt and optional governed learning
```

## Why Two Computers

The preferred topology makes the control experience independent of model load:

- **Control host (N150):** Bun control plane, memory coordination, receipts,
  clients, and project continuity. No resident answer model is required.
- **Codexa:** Navigator, code and judgment specialists, visual/creative workers,
  training, Docker workloads, and long jobs.

Æ Orange AI Computer also supports one-computer mode. Hardware discovery selects only roles
that fit; deterministic control remains available when no heavy model can run.

## Current Evidence Snapshot

As of the fresh 2026-08-28 evidence set:

- Æ Orange AI Computer Blue Bench: **10/10 lanes accepted**, with no blocked lane in that
  exact run.
- Context Crystal held-out corpus: **5/5 quality-parity cases**, minimum
  **1,422.901x operational context ratio** across a 7,056,795-byte corpus.
- AE Memory: **23/23 retrieval cases**, hybrid MRR **0.9058**, p50 **281 ms**,
  p95 **445 ms**; hybrid beat both lexical-only and dense-only ablations.
- Brain MCP: stdio and loopback Streamable HTTP were accepted in the integrated
  proof; Codexa rail was reachable, authenticated, and executable.
- Hermes Brain MCP delegation: a fresh governed read completed through parent
  mediation, all authorization checks, child receipt, synthesis receipt, and
  lease revocation in **11,409.53 ms**.

Evidence:

- `10-RECEIPTS/orange5-build/2026-08-28T03-40-44-768Z-blue-bench.json`
- `10-RECEIPTS/orange5-build/2026-08-28T03-42-45-242Z-integrated-operational-proof.json`
- `10-RECEIPTS/orange5-build/2026-08-28T04-13-22-203Z-brain-mcp-delegation-live-proof.json`

These are bounded engineering results, not universal claims. The held-out
compression ratio is not a promise for arbitrary tasks. A technically valid
media artifact is not automatically studio-quality. No external frontier-model
superiority claim is made by the local operational suite.

## Fast Health Check

```powershell
cd C:\AtomEons\Orange5
bun 03-BACKEND/spine-cli.mjs --health
bun 03-BACKEND/orange.mjs status
bun scripts/orange5-runtime-services.mjs status
```

An HTTP 200 is insufficient. Read the semantic status, active route, blockers,
and receipt provenance.

## Safe First Order

```powershell
bun 03-BACKEND/spine-cli.mjs --order '{"action":"read.health","payload":{}}' --dry-run
bun 03-BACKEND/spine-cli.mjs --order '{"action":"read.health","payload":{}}'
```

For Windows and durable work, prefer `--order-file` over complex inline JSON.

## Major Organs

| Path | Organ |
|---|---|
| `00-CHARTER` | product law, current authority, manuals, verifier |
| `01-DOCTRINE` | operating doctrine and deterministic guardrails |
| `02-ATOMIC-ORANGE-V1` | Tauri native operator interface |
| `03-BACKEND` | canonical spine, Brain MCP, Navigator Kernel, Fixer |
| `04-CONTROL-PLANE` | durable runs, adapters, federation, knowledge strata |
| `05-FLOW` | flow runtime and governed work scheduling |
| `06-ORANGELLM` | OpenAI-compatible gateway, routing, memory crossing |
| `07-VISUAL` | AE Eyes and structured visual proof |
| `08-HERMES` | bounded agent execution and LOOM gates |
| `09-SCHEMAS` | public operational contracts |
| `10-RECEIPTS` | proof artifacts and hash chains |
| `11-MIRAGE` | data-plane mounts and source access |
| `12-ATOMSMASHER` | commitment, compression, sparse worksets, saved work |
| `13-TOOLMESH` | governed capability integrations and labs |
| `14-SUPERSTACK` | lease-governed model and creative role library |
| `15-INTEGRATIONS` | client and infrastructure bridges |
| `16-TRAINING` | adapters, corpora, evals, and promotion pipelines |
| `19-ARCHIVE` | historical material; never runtime authority |

## Build The Manuals

```powershell
bun run docs:build
```

The build renders canonical Markdown to styled HTML and PDF using the installed
Chrome or Edge headless printer. It writes a manifest with source and output
hashes so the generated manuals can be independently checked.

## Claim Discipline

- Source and configuration prove existence, not runtime function.
- Installation proves inventory, not route use.
- A test proves its stated scope, not the whole product.
- A receipt proves the exact observed action at the recorded time.
- A screenshot proves pixels, not backend truth, unless linked to runtime
  evidence.
- Green applies only to the exact path and acceptance contract named by its
  evidence.

Read [Proof and Benchmarks](00-CHARTER/GUIDES/PROOF_AND_BENCHMARKS.md) before
quoting any number.
