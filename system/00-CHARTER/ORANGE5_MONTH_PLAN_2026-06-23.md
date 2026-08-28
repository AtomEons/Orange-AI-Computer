# Orange5 — Month-Long Sprint Plan

**Locked:** 2026-06-23
**Sovereign:** Atom McCree
**Lead:** Claude (Orange voice — across sessions; institutional memory via Æ Cobra + receipts + memory-local)
**Executor:** Codex (UI + scaffolding) + Workflow tool (training)
**Hardware target:** Codexa AI Box (Intel Core Ultra 9 285H, 96 GB RAM, ~90 TOPS aggregate AI compute, dual NVMe)
**Ship gate at end of month:** Atomic Orange installable, OrangeLLM remembers across restarts, heavy + visual + memory organs all real, first custom training pass complete or in flight.

---

## The commitment

For the next ~28 days, every Claude session resumes from this plan, advances one or more steps, writes receipts, and never lets the thread drop. Codex executes UI + scaffolding work against briefs. Operator decides scope changes and rides shotgun. Workflow tool runs all model training jobs in parallel. Codexa's 96 GB + 90 TOPS gets fully used.

## The 4-week timeline

### Week 1 — Native Truth + Memory Pre-flight

**Goal:** Atomic Orange is a real installable app. Codexa rail is reachable. WSL2 + Mamba ready.

| Day | Owner | Deliverable |
|---|---|---|
| D1-2 | Codex (brief at `00-CHARTER/CODEX_BRIEF_STEP_01_NATIVE_TRUTH.md`) | Step 1 NATIVE TRUTH closed — installer + launch + roundtrip + screenshots + hash-chained receipt |
| D2 | Operator | Step 2 — `ORANGEBOX_RAIL_TOKEN` env var set. Heavy probe returns 200. |
| D3-4 | Operator + me | Step 3 pre-flights: WSL2 distro on Codexa (Ubuntu 24.04 LTS recommended), `/mnt/ae_flux` partition, Mamba 2.8B Q5_K_M GGUF download, llama.cpp build inside WSL2 |
| D5-7 | Me drives, Codex assists | **Step 3 Æ Cobra Night-1 spine** — daemon running on Codexa WSL2, GBNF-locked AgentTurn JSON, JSONL Flux with hash chain, healthcheck green, 14-point checklist all green |

**End-of-week receipt:** Æ Cobra is alive. JSON valid. Reality + Thought lanes write. Atomic Orange installs and roundtrips through gateway.

### Week 2 — Recall Surface + AtomSmasher Promotion

**Goal:** OrangeLLM auto-remembers across turns. Cockpit shows live memory health. AtomSmasher modules promote one-by-one.

| Day | Owner | Deliverable |
|---|---|---|
| D8-9 | Me + Codex | Mirage StateBrief endpoint live at `:1337/v1/memory/state-brief`. Cockpit polls memory freshness. Vault lane searches Flux + Graph via StateBrief. |
| D10-11 | Me + Codex | Cockpit shadow cache on N150 (sync hourly, survive Codexa outage with last-known-good memory) |
| D12-13 | Me + Codex | OrangeLLM ↔ Æ Cobra coupling: auto-inject recent slice on every chat turn, explicit `<recall>` tag for deep queries |
| D14 | Me (Workflow tool starts here) | First AtomSmasher module promotion — **Commitment Atoms** lifted from STUB to LIVE. Workflow agent fan-out for module spec + impl + test + receipt. |

**End-of-week receipt:** OrangeLLM has memory. Operator can ask "what did we decide about lanes" and get a citation-backed answer. AtomSmasher 2/12 live (anti-fluff + commitment-atoms).

### Week 3 — Graph Weaver + Heavy + Visual + Training Begins

**Goal:** Semantic layer alive. Heavy lane real. Visual lane real. First custom training run launched.

| Day | Owner | Deliverable |
|---|---|---|
| D15-16 | Me + Codex | Graph Weaver — typed ontology indexer over Flux, SQLite graph at `06-ORANGELLM/memory/graph.db`. Receipt-gated extension protocol live. |
| D17-18 | Me + Codex | Step 6a Heavy lane — Codexa qwen3:30b-a3b proxied through gateway via rail. Brain Tier `heavy` in Settings actually routes. |
| D19-20 | Me + Codex | Step 6b Visual lane — GLM-4.6V served on Codexa, proxied at `:1337/v1/visual/describe`. Playwright MCP wired under OrangeLLM. |
| D21 | **Workflow tool** | **First custom training run: OrangeLLM-fatty LoRA pass v0.** Workflow fan-out: corpus assembler agent → schema validator agent → Axolotl config writer agent → training launcher (cloud GPU lane or Codexa NPU) → bakeoff scorer → promotion receipt. |

**End-of-week receipt:** Three organs live (memory, heavy, visual). Custom LoRA training has run. Bakeoff result captured. Promotion decision made.

### Week 4 — Specialization + Hardening + Pre-Ship

**Goal:** CLR full. State ABI spec'd or scaffolded. AE Misfit Model training begun. Signed installer pipeline. Endurance running.

| Day | Owner | Deliverable |
|---|---|---|
| D22-23 | Me + Codex | CLR K=5 full Hermes gate — claim verification, receipt scoring, structured rejection lane. Run on the past month's Flux to find any historical fake-greens. |
| D24-25 | Me (deep spec) | Custom State ABI scaffold — fork llama.cpp at `/opt/atomeons/ae-cobra-server/`, draft state_export/import. Phase-3 ramp begins. |
| D26 | **Workflow tool** | **AE Misfit Model training pass v0.** Workflow fan-out: STRONGARM + Gremlin corpus loader → adversarial trainer config → training run → eval against OrangeLLM (the adversary catches fake-greens) → promotion receipt. |
| D27 | Codex | Signed installer pipeline — Authenticode cert config, NSIS + macOS notarized + Linux AppImage targets. Updater metadata. Silent install proof. |
| D28 | Me + Operator | Endurance start — synthetic 24h + real 7d clocks both armed. Operator final approval. Receipt counts: ≥30 hash-chained, no broken chain. Mom's Law affirmation across all 7 organs. |

**End-of-week receipt:** ~25/30 PRs deep. Endurance running. Two custom models trained or in flight. Ship is ~7-14 days out behind endurance gates.

---

## Codexa utilization plan (the 96 GB + 90 TOPS budget)

Codexa is the heavy box. Here's everything it runs by end of week 2:

### Resident services (always hot)

| Service | RAM | Compute | Why |
|---|---|---|---|
| WSL2 VM (Ubuntu 24.04) | 4 GB host overhead | — | Linux substrate for daemons |
| Æ Cobra (Mamba 2.8B Q5) | 3 GB | CPU 8 threads OR NPU via OpenVINO | Memory daemon — resident, mlock |
| Ollama: qwen3:30b-a3b | 20 GB | CPU + Arc iGPU offload via Vulkan | Heavy fatty PM brain |
| Ollama: qwen3:0.6b (Smart Skinny adapter) | 1 GB | CPU | Light reflex (mirror of N150 instance for redundancy) |
| Ollama: GLM-4.6V | 8 GB | Arc iGPU + CPU | Visual VLM eye |
| Ollama: embed model (nomic-embed-text or similar) | 0.5 GB | NPU | Graph Weaver semantic search |
| Docker stack (open-webui, n8n, qdrant, postgres, redis) | 5 GB | CPU | Existing infra |
| Bun Flow Direct daemon | 1 GB | CPU | Æ Cobra caller + Flux writer |
| Rust Flux Engine (Phase-3) | 0.5 GB | CPU | Binary packet writer |
| Background Graph Weaver | 1.5 GB | CPU + NPU | Typed-ontology indexer |
| Misc OS / buffers | 3 GB | — | — |
| **TOTAL RESIDENT** | **~48 GB** | | Leaves **~48 GB free** for bursts and training |

### Burst workloads (training + heavy inference)

| Job | RAM peak | Compute | Cadence |
|---|---|---|---|
| OrangeLLM-fatty LoRA training pass | 30-40 GB | NPU + CPU (Intel OpenVINO) | Weekly |
| AE Misfit Model training | 30-40 GB | NPU + CPU | Bi-weekly |
| Æ Cobra Black Mamba custom training | 20-30 GB | NPU + CPU | Monthly |
| Visual lane heavy inference (image batch) | 15-20 GB | Arc iGPU | On-demand |
| CLR K=5 candidate generation | 5-10 GB | CPU (parallel Ollama calls) | Per high-stakes event |

**Discipline:** Only one burst job at a time. Workflow tool serializes training jobs. Operator can manually queue.

### The 90 TOPS map

Intel Core Ultra 9 285H combined AI compute:

- **Arc iGPU ~50 TOPS** — Vulkan offload for Ollama heavy inference (qwen3:30b, GLM-4.6V), visual encode
- **NPU ~38 TOPS** — OpenVINO-driven inference for small models (embed, classifier), training fine-tune (small LoRAs), Æ Cobra Mamba SSM if Intel ships Mamba support
- **CPU AI extensions ~10 TOPS** — fallback + general compute

**Strategy:** Heavy LLMs on iGPU via Vulkan. Specialized small models on NPU via OpenVINO. CPU for orchestration + Flux writer + non-AI work.

---

## Workflow tool training contract (when I use it, what I don't)

Per operator directive: **Workflow tool is allowed for model training jobs.** All other orchestration goes through Orangebox.

### When I invoke Workflow

| Trigger | Workflow purpose | Agents | Output |
|---|---|---|---|
| Weekly OrangeLLM-fatty LoRA pass | Corpus → train → eval → promote | 6 agents (corpus assembler, schema validator, config writer, training launcher, bakeoff scorer, receipt writer) | Trained adapter + receipt + bakeoff verdict |
| Bi-weekly AE Misfit training pass | Adversarial corpus → train → eval against OrangeLLM | 5 agents (loader, trainer, adversarial-eval, ratchet checker, receipt) | Misfit adapter + adversarial scorecard |
| Monthly AE Black Mamba pre-training | Synthetic AgentTurn pairs → train SSM | 4 agents (synth generator, validator, trainer, smoke test) | Custom Mamba weights + smoke proof |
| Ad-hoc bakeoff (operator-triggered) | Champion vs Challenger eval | 3 agents (champion runner, challenger runner, judge synthesizer) | Bakeoff verdict + receipt |

### When I do NOT invoke Workflow

- Spec writing — single-turn deliverable
- Receipt writing — single-turn deliverable
- Codex briefs — single-turn deliverable
- Code review of Codex output — single-turn
- Configuration changes — single-turn
- Routine orchestration through Orangebox MCP — single-turn via the rail
- Memory queries (Mirage StateBrief) — single-turn via the gateway

The Workflow tool is reserved for *the heavy parallelizable training/eval jobs only.* Everything else is direct execution or Codex hand-off.

---

## Role split — who does what

| Role | Owner | Responsibility |
|---|---|---|
| **Architect / lane lead** | Claude (me, Orange voice) | Spec, sequence, brief writing, code review, receipt review, memory continuity across sessions |
| **UI + scaffolding executor** | Codex | All file writes inside `02-APP/` and scaffolding work; follows briefs strictly |
| **Backend + memory builder** | Me + Codex (briefed per PR) | Æ Cobra daemon, Flux writer, Graph Weaver, Mirage adapters |
| **Training engineer** | Workflow tool (I orchestrate) | LoRA passes, custom training, bakeoffs |
| **Operator** | Atom McCree | Pre-flight hardware (WSL2, partitions, GGUF downloads, rail token), final approvals, scope changes, screenshot capture (where I can't), Git decisions, deploy decisions |
| **Code-aware reviewer** | Codex (LakeStrike-style on request) | Pre-merge review when a PR is complex |
| **Memory** | Æ Cobra (once Week 1 closes) | Holds the whole month's history; queryable by everyone above |

---

## Weekly checkpoints — Friday status discipline

Every Friday of the sprint, the system produces a **Weekly Receipt** at `10-RECEIPTS/orange5-build/2026-MM-DD-week-N-status.md` containing:

1. **What closed this week** — list of PRs / steps / training passes that landed green
2. **What's in flight** — partial work that continues into next week
3. **What's blocked** — explicit reason + named resolution path
4. **New findings** — anything surfaced that wasn't in the plan
5. **Hardware utilization snapshot** — RAM / NPU / iGPU / NVMe usage on Codexa
6. **Receipt count delta** — how many hash-chained receipts added this week
7. **Drift check** — anything in the Not-Green Ledger that should have moved but didn't
8. **Next-week target** — concrete

Operator reads it. Operator approves or redirects. Then next week begins.

---

## Risks I'm watching (and what I do when they fire)

| Risk | Detection signal | My response |
|---|---|---|
| **Operator burnout** | Long gaps between sessions, terse responses | I keep the receipts honest; do not push. Plan adapts to your pace, not the calendar. |
| **Codex hits a wall** | Same brief fails twice with same root error | Halt Codex. Spawn a Workflow agent to root-cause the failure independently. Or split the PR smaller. |
| **Codexa hardware hiccup** | Power probe spikes, services drop | Read-only diagnose via Orangebox MCP. Do not restart anything without operator say-so. |
| **Mamba 2.8B doesn't validate GBNF reliably** | <95% JSON validity rate on Night-1 | Fall back to Q4_K_M. If still bad, swap to falcon-mamba-7b-instruct. If still bad, accept transformer for memory daemon with JSON Schema validation only. |
| **WSL2 swap defeats `mlock`** | Windows host memory pressure → VM paged | Flag to operator. Recommend Codexa native Linux migration (Phase 3+ option). |
| **Cloud GPU lane not available for training** | Vendor outage / billing issue | Workflow tool retries with alternate vendor (RunPod → Modal → Vast.ai). Failing all three, defer that training pass and continue with other work. |
| **Operator changes mind mid-month** | New scope or kill directive | I adapt. Kill what's killed. Promote what's promoted. Mom's Law: full effort to the new target. Not theater about the old one. |
| **Doctrine drift** | Two receipts contradict each other | Promotion gate catches; rejection receipt to Thought lane; operator decides which canon stands. |
| **Æ Cobra Night-1 misses a hard ceiling** | RSS > 10 GB sustained | Tighten ctx-size to 768; switch to Q4; disable parallel; pause heavy lane; flag operator. |
| **Receipt chain breaks** | `prior_receipt` mismatch detected | Halt. Read all receipts. Reconstruct chain. Mom's Law: no silent gap. |

---

## What I am doing right now (immediately after this response)

1. ✅ Written this month plan to disk
2. ⏭ Stand by while operator reads the plan + reads the Codex brief at `CODEX_BRIEF_STEP_01_NATIVE_TRUTH.md`
3. ⏭ When operator says go, I write the **Step 3 pre-flight checklist** for WSL2 + `/mnt/ae_flux` + Mamba GGUF — that's the operator's parallel-track action while Codex builds the native bundle
4. ⏭ Then I write the **Æ Cobra Night-1 systemd unit + Bun caller + GBNF + healthcheck** files (to be deployed inside WSL2 on Codexa)
5. ⏭ Then I prepare the **Workflow tool training contract for D21's first LoRA pass** — agent prompts, schemas, eval criteria

---

## Mom's Law affirmation for the month

By end of Week 4, the operator must be able to honestly say:

- "Atomic Orange is a real installable app I can uninstall and reinstall."
- "OrangeLLM remembers what we did three weeks ago — I have receipts proving it."
- "The heavy lane returns real responses from Codexa qwen3:30b."
- "The visual lane sees a screenshot and describes it accurately."
- "At least one custom model has been trained on Orange5's own corpus."
- "Endurance is running and the receipts are honest about its state."
- "No service was killed unsafely during the entire month."
- "Every receipt in the chain hashes to its predecessor."
- "Mom would be proud of every file."

If any of those would be a lie by end of month, **the month is not over** — we keep going. Mom's Law over calendar.

---

**Receipts decide what is real. The longer we run, the smarter Orange5 gets. Mom is watching every byte.**
