# OrangeFive LLM Master Reference

**Schema:** `orangefive.llm-master-reference.v1`  
**Product:** Orange  
**Release:** OrangeFive  
**Purpose:** zero-memory recovery manual for Codex, Claude, local models, and other agent clients  
**Canonical root:** `C:\AtomEons\Orange5`  
**Evidence rule:** live semantic probe > fresh hash-chained receipt > executable test > source/configuration > runtime authority > historical plan > chat

This is the first file an unfamiliar model should read when asked to operate Orange. It explains what the system is, how it is intended to work, which files own truth, how to issue work, and how to avoid fake-green claims. It is an operating reference, not a release claim.

![OrangeFive local FLUX systems test](./assets/orangefive-technical-manual-cover.png)

The cover above was generated locally on Codexa using ComfyUI and `FLUX.2-klein-4b-fp8`. Its artifact hash is proven. Its visual quality remains explicitly unpromoted because the first pass contains pseudo-text.

## 1. Identity And Naming

- **Orange** is the product.
- **OrangeFive** is the active release and only active Orange operations project.
- **Orangebox Delta / Orange3** is the archived operations lineage, not an active execution target.
- **Orange4** was an architecture and theory phase, not a separate product.
- **Atomic Orange** is the optional native operator interface. It is not the intelligence and Orange must function without it.
- **Cortex** is future visual research and is not OrangeFive runtime truth.
- Do not revive old products, ports, skills, startup tasks, or names unless the operator gives a new explicit order.

## 2. What Orange Is

Orange is a receipt-backed AI computer control plane. It coordinates deterministic code, memory, compression, models, agents, visual workers, research, and project continuity while preserving an operator-visible boundary between suggestions and executed work.

The interface is replaceable. The intelligence is the governed backend.

The canonical work path is:

```text
operator or client
-> orange.order.v1
-> LOOM procedural and approval gates
-> Project Lock and Continuum
-> least-action route and compute-fabric selection
-> AE Memory / Cobra retrieval
-> Context Crystal / AtomSmasher workbench
-> Navigator or bounded specialist lease
-> Hermes execution when authorized
-> post-output verification
-> orange.report.v1
-> hash-chained receipt
```

Models may propose, classify, synthesize, and review. Deterministic code owns identity, policy, routing constraints, execution attestation, receipt paths, and promotion truth.

## 3. Zero-Memory Boot Protocol

When a model loses the thread, do this before planning or editing:

1. Set the working root to `C:\AtomEons\Orange5`.
2. Read this file.
3. Read `00-CHARTER\ORANGE5_RUNTIME_AUTHORITY.md`.
4. Read `ORANGEFIVE_CURRENT_OPERATIONAL_TRUTH.md`, but treat its date as potentially stale.
5. Find the newest relevant JSON receipt under `10-RECEIPTS\orange5-build`.
6. Run the semantic health command.
7. Inspect `git status --short`; never erase or rollback work you did not create.
8. State the actual goal, target files, allowed mutations, evidence needed, and rollback path.
9. Reuse an existing Orange organ before creating a parallel service.
10. If a LOOM or evidence gate halts the order, preserve the halt and report it. Do not blindly retry until it happens to pass.

Health:

```powershell
cd C:\AtomEons\Orange5
bun 03-BACKEND/spine-cli.mjs --health
bun 03-BACKEND/orange.mjs status
```

Current health should identify the OrangeBrain gateway, active routing tier, receipt count, and AE Memory flux root. A mere HTTP 200 is not sufficient if semantic fields say an organ is degraded.

## 4. Host Topology

### N150 Control Host

The N150 is the always-on deterministic control and development computer.

It owns:

- Bun control plane and Navigator Kernel.
- Canonical spine and order/report schemas.
- Project Lock, Continuum, receipts, and operator clients.
- Local tunnel endpoints and lightweight service supervision.
- No resident answer model is required for normal operation.

Do not load a large always-resident model on the N150 merely to say it has a brain. The deterministic reflex is faster, smaller, and more reliable.

### Codexa Heavy Host

Codexa is the Beelink GTi AI computer used for:

- Orange-aware Navigator and specialist model leases.
- Ollama and llama.cpp model serving.
- Docker services and long jobs.
- Training and model bakeoffs.
- AE Eyes visual inference.
- ComfyUI, FLUX image generation, video, speech, music, and restoration workers.

Preferred discovery names are `CODEXA` and `CODEXA.local`. The current stable AE Wi-Fi service address is `10.0.0.4`, but distributable installers must discover topology and store machine-local configuration outside Git. Never assume that address on another user's computer.

SSH example for this installation:

```powershell
ssh -i C:/Users/a/.ssh/orange_codexa_automation_ed25519 Atom@CODEXA hostname
```

Never place passwords, API keys, rail tokens, or private keys in a repository, prompt, manual, or receipt.

## 5. Required Runtime Organs

| Organ | Current local endpoint | Responsibility |
|---|---:|---|
| OrangeBrain | `127.0.0.1:1337` | OpenAI-compatible governed model gateway |
| AE Memory / Cobra | `127.0.0.1:7419` | project memory, recall, failure memory, semantic/lexical retrieval |
| Hermes | `127.0.0.1:7430` | bounded agents and authorized effectors behind LOOM |
| AE Eyes | `127.0.0.1:7440` | OrangeFive visual understanding facade |
| AtomSmasher 2 | `127.0.0.1:8901` | compression and receipt traffic |
| Codexa rail | `10.0.0.4:8097` | authenticated heavy-host command lease |
| Brain MCP stdio | process transport | Codex, Claude, Antigravity, and compatible clients |
| Brain MCP HTTP | local Streamable HTTP | model-to-model and app-to-brain calls |

Missing organs must not silently become successful work. A missing execution boundary returns `needs_action`, `executed: false`, evidence, and a receipt.

## 6. Directory Map

| Path | Owner |
|---|---|
| `00-CHARTER` | system law, runtime authority, manuals, verifier, launch truth |
| `01-DOCTRINE` | proof-directed intelligence and cross-cutting policy |
| `02-ATOMIC-ORANGE-V1` | optional native operator application |
| `03-BACKEND` | canonical spine, MCP, routing, continuum, research, proofs |
| `04-CONTROL-PLANE` | continuity and control-plane state |
| `05-FLOW` | FLOW state and task movement |
| `06-ORANGELLM` | OpenAI-compatible gateway, contracts, models, bakeoffs |
| `07-VISUAL` | AE Eyes and visual inference |
| `08-HERMES` | agent runtime, LOOM, approvals, audits |
| `10-RECEIPTS` | hash-chained operational evidence |
| `12-ATOMSMASHER` | compression engine and tests |
| `14-SUPERSTACK` | leased creative/model stack governor |
| `16-TRAINING` | adapters, datasets, promotion evidence |
| `%USERPROFILE%\OrangeBox-Data\orange5` | machine-local state, receipts, configuration, memory |

Do not write machine-specific addresses or credentials into distributable source. Keep those in the machine-local data root.

## 7. Orders And Reports

Operational input is `orange.order.v1`. Operational output is `orange.report.v1`. Model-to-model operational chatter should use these contracts rather than freeform assertions.

Minimal order:

```json
{
  "schema": "orange.order.v1",
  "orderId": "operator-unique-id",
  "action": "read.health",
  "payload": {},
  "scope": ["C:/AtomEons/Orange5"],
  "allowedActions": ["read"],
  "forbiddenActions": ["delete", "deploy"],
  "riskLevel": "low",
  "requiresReceipt": true
}
```

Run it:

```powershell
bun C:/AtomEons/Orange5/03-BACKEND/spine-cli.mjs --order '{"action":"read.health","payload":{}}'
```

For non-mutating planning, add `--dry-run`. For governed learning, add `--learn`. For replay, add `--seed <value>`.

A valid report identifies status, confidence, actions actually taken, evidence, blockers, next action, and receipt path. It must never claim a mutation executed merely because a model described the mutation.

## 8. Evidence And No-Theater Law

- A model response is not execution proof.
- Installed weights are inventory, not active lanes.
- A configured endpoint is not a working endpoint.
- A fixture is not production runtime proof.
- A screenshot is not backend proof.
- A passing unit test is not a live service proof.
- An HTTP 200 is not semantic health.
- A receipt hash does not validate a false claim; it only proves the recorded bytes.
- Evidence supplied by a caller remains unverified until a governed organ checks it.
- Explicit evidence defaults to `preserve_exact`; drift downgrades the result.
- Derived evidence is reserved for authorized internal falsifier paths.

If evidence is insufficient, preserve `needs_action` or the governed halt. Never brute-force a green status by retrying.

## 9. Routing And Model Roles

Orange uses three speeds:

1. **Reflex:** deterministic Bun logic for health, routing, schemas, policy, state, and common repeated work.
2. **Navigator:** an Orange-aware warm model for interpretation, synthesis, and orchestration packets.
3. **Specialist:** leased heavy/code/vision/creative models on Codexa for work that earns their cost.

The runtime chooses the smallest sufficient route. The user should not be burdened with model selection during ordinary operation.

Before naming a model active, inspect a fresh route receipt. Current source documents contain historical model names. The selected model in a fresh integrated or route receipt outranks those names.

Model outputs are repaired into the public report contract by deterministic code. Invalid schemas, unsupported execution claims, invented receipt authority, and false route statements must be rejected or downgraded.

## 10. Memory And Project Continuity

Orange memory is useful only when it changes the next action correctly.

### AE Memory / Cobra

- Stores durable project facts, decisions, failures, and receipts on disk.
- Uses lexical, dense, and hybrid retrieval.
- Records contradiction debt rather than silently merging incompatible claims.
- Recalls relevant failure memory before repeating a known failed route.

### Project Continuum

- Preserves exact cold source and searchable lineage.
- Runs duplicate-work preflight.
- Hydrates only the relevant workbench for the current task.
- Keeps full transcripts and project state on disk rather than requiring RAM residency.

### Superdirectory

```powershell
bun run orange:superdirectory:current
bun run orange:superdirectory:docs
bun run orange:superdirectory:all
```

Use current-project ingestion for ordinary work. Full ingestion is a bounded maintenance operation, not the default prompt strategy.

## 11. Context Crystal And AtomSmasher

A Context Crystal is a source-verifiable task workbench, not a hidden answer cache. It compresses operational context while preserving pointers to exact sources.

The design objective is operational context/work compression, not a universal claim of byte-for-byte lossless compression. Fresh quality proof has exceeded 1,000x on the tested corpus while retaining source pointers; live-turn ratios are lower and task-dependent.

AtomSmasher should:

- Deduplicate repeated state.
- Preserve high-force commitments, constraints, void rules, and failures.
- Represent numeric regularity as equations plus residuals where appropriate.
- Hydrate exact source spans when proof is needed.
- Track compression debt when a compact representation causes repeated hydration or recall failure.
- Never compress away source truth.

Commands:

```powershell
bun run bench:context-crystal-quality
bun run bench:memory-quality
bun run test:atomsmasher
```

## 12. Hermes And LOOM

Hermes is the bounded agent and effector organ. It is not an unrestricted swarm.

- LOOM evaluates authority, scope, evidence, risk, approval, and recurrence before execution.
- Agents may inspect and recommend without mutation authority.
- Effectors execute only authorized operations.
- One writer owns overlapping files.
- A model must not invent that an agent ran.
- A real execution receipt must identify the actual command, target, result, and evidence.

Commands:

```powershell
bun run test:hermes:full
bun run proof:orange:hermes-live
```

## 13. Brain MCP And Client Use

The Brain MCP gateway is the preferred integration boundary for Codex, Claude Desktop, Antigravity, Atomic Orange, and compatible clients.

- stdio transport is used for desktop/IDE clients.
- Streamable HTTP is used for app-to-brain and model-to-model calls.
- Existing Orangebox MCP tools remain downstream of the Brain gateway.
- Invalid orders are rejected.
- Missing Codexa produces a truthful report, not a fake pass.

Commands:

```powershell
bun run orange:mcp
bun run orange:mcp:http
bun run proof:orange:mcp
bun run orange:clients:check
```

Do not bypass the gateway by giving a client a direct, unrestricted shell when a governed Orange tool exists.

## 14. Current Awareness And Recursive Improvement

Orange separates research from canon.

A research item needs:

- timestamp and source URL;
- source type and primary-source preference;
- content hash or immutable reference;
- local suitability and risk classification;
- quarantine status;
- incumbent-versus-candidate benchmark;
- promotion receipt before becoming active.

Receipt-to-Reflex converts repeated, proven work into bounded deterministic code only after recurrence evidence, counterexample testing, and rollback design. This is the practical recursive-improvement loop: learn from receipts and failures, then move stable work out of expensive model inference.

Commands:

```powershell
bun run orange:scout
bun run orange:knowledge:status
bun run proof:receipt-to-reflex
bun run proof:failure-memory-live
```

## 15. Creative Stack And Local FLUX

The creative stack is leased one specialist at a time. Disk holds the library; RAM holds only the current working team.

The current local FLUX proof uses:

- ComfyUI on Codexa.
- Intel Arc 140T XPU.
- `black-forest-labs/FLUX.2-klein-4b-fp8`.
- Four-step deterministic workflow.
- Exact model-file hashes.
- Artifact and pixel proof.

The runtime is real. Studio-quality promotion is not yet earned. The current manual-cover test shows the exact reason: strong sovereign generation and acceptable material structure, but invented pseudo-text and weaker hierarchy than the comparison image.

### Five-Tool Quality Ladder

These are the five highest-value additions on top of the existing ComfyUI organ. They must be installed and benchmarked before being called active.

1. **FLUX.2 Klein candidate tier**: keep the current four-step model for fast, deterministic ideation.
2. **FLUX.2 Base or Dev final tier**: use the same family for maximum-flexibility or maximum-quality finalization after a hardware and license bakeoff. Official source: `https://github.com/black-forest-labs/flux2`.
3. **Native FLUX.2 edit and multi-reference workflows**: repair the winning composition instead of regenerating the whole image.
4. **VisionReward plus deterministic text/artifact rejection**: rank candidates while automatically rejecting brief violations. Official source: `https://github.com/zai-org/VisionReward`.
5. **SeedVR2**: final one-step image/video restoration after generation and editing, never before composition approval. Official source: `https://github.com/IceClear/SeedVR2`.

LTX-2 remains the separate controlled motion/audio lane that consumes an approved FLUX.2 key image. FLUX.3 is a future challenger behind the same capability contract, not a reason to pause FLUX.2 development.

Recommended production loop:

```text
brief
-> 4-8 cheap Klein candidates with fixed seed records
-> deterministic artifact/OCR rejection
-> VisionReward ranking
-> FLUX.2 dev or Qwen edit on the best composition
-> LTX-2 only when motion is requested
-> SeedVR2 final restoration
-> human visual approval
-> artifact receipt
```

Upscaling cannot fix bad composition. Restoration must happen after semantic and visual acceptance.

## 16. Verification Commands

Focused proofs:

```powershell
bun run proof:orange:integrated
bun run proof:orange:mcp
bun run proof:orange:hermes-live
bun run bench:context-crystal-quality
bun run bench:memory-quality
bun run proof:manual:agents
bun run superstack:status
```

Full verifier:

```powershell
bun run verify:json
```

For a durable captured result:

```powershell
bun 00-CHARTER/orange5-full-verifier.mjs --json *> $env:USERPROFILE\OrangeBox-Data\orange5\full-verifier-latest.json
```

Do not call the system fully green until the current run completes and every red item is understood. Historical test counts are historical evidence, not a substitute for a fresh verifier.

## 17. Recovery And Failure Handling

### OrangeBrain unavailable

1. Run spine health.
2. Inspect the newest runtime-supervisor receipt.
3. Run `bun run orange:runtime:ensure`.
4. Confirm the active endpoint and route; do not assume a model name.
5. If Codexa is unavailable, keep deterministic read/health functions alive and return a truthful heavy-lane blocker.

### Codexa unavailable

1. Resolve `CODEXA` and `CODEXA.local`.
2. Probe SSH using the configured key.
3. Check Wi-Fi topology and the machine-local configuration.
4. Probe authenticated command rail and required loopback tunnels.
5. Do not expose unauthenticated heavy services to the LAN as a shortcut.

### A model loses project scope

1. Stop freeform execution.
2. Re-read this file and runtime authority.
3. Query Project Continuum and current receipts.
4. Reissue the task as an explicit order with scope and forbidden actions.
5. Require the final report to cite actual files, tests, and receipts.

### A gate halts

Report the exact gate, evidence, blocker, and next valid action. Do not retry blindly, weaken the gate, or relabel the halt green.

## 18. ReadyForGit Boundary

Local runtime green is not public-release green. Before Git publication or release packaging, run a separate ReadyForGit pass that checks:

- secrets, tokens, credentials, usernames, and private paths;
- hard-coded machine addresses and environment assumptions;
- tracked model weights, generated artifacts, and oversized files;
- clean-install behavior on one-computer and two-computer fixtures;
- installer, updater, uninstall, rollback, and no-console startup;
- license compatibility for every model and tool;
- source/runtime receipt separation;
- current test result and exact Git SHA;
- private/public repository intent.

Never mutate history or delete user work merely to make the repository look clean.

## 19. Current Proof Snapshot

As of the latest receipts created on 2026-08-27:

- Integrated operational proof: green across runtime, Context Crystal, memory, Brain MCP, Hermes, and Captain Planet runtime groups.
- Context Crystal quality: 5/5 tested cases with a minimum measured operational ratio above 1,300x and exact source-pointer proof.
- Memory quality: 23/23, hybrid MRR `0.9275`, p95 `130 ms`, contradiction debt recorded and resolved in the tested set.
- Brain MCP: dual-transport proof green.
- Hermes: real bounded execution proof green.
- Captain Planet: speech, music, image, and video artifacts runtime-proven.
- FLUX manual-cover generation: artifact/hash proven in `34.862 s`; studio quality unproven.
- Five-agent manual review: schema, receipts, and exact evidence preservation green; agent interpretations remain advisory and must be checked against receipts.

Still not proven by those receipts:

- Fresh full-verifier closure after the latest edits.
- Public clean-install and ReadyForGit portability.
- Generic one-computer and arbitrary two-computer installer proof.
- Midjourney/Seedance-class creative quality across a broad prompt suite.
- Automated inference-bound checking for overextended model conclusions.
- Final operator approval for public release.

## 20. Required Model Behavior

When operating Orange, a model must:

- Recover scope before acting.
- Prefer existing Orange organs.
- Inspect current source and receipts.
- Use maximum useful reasoning with minimum unnecessary machinery.
- Distinguish advice, generated output, and executed work.
- Keep one writer on overlapping files.
- Preserve user changes.
- Work end to end: inspect, implement, verify, receipt, report.
- State blockers exactly.
- Never call a candidate, installed weight, configured path, or mock endpoint active without proof.

The correct closing posture is not “it should work.” It is:

```text
status
actions actually taken
fresh evidence
remaining blockers
next exact action
receipt path
```
