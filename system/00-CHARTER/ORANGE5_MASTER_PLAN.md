# AE Orange5 — Master Plan

> **Runtime authority:** This file preserves the locked design history. Current
> host roles, model residency, endpoints, and executable boundaries are defined
> by [`ORANGE5_RUNTIME_AUTHORITY.md`](./ORANGE5_RUNTIME_AUTHORITY.md) and proven
> by live receipts. Where implementation-status language below conflicts with
> that authority, the live authority wins.

**Spec locked:** 2026-06-23 · **5-Pillar doctrine locked:** 2026-06-25 (canon-refresh receipt #059)
**Release name:** Orange5 / OrangeFive
**Sovereign:** Atom McCree · AtomEons Systems Laboratory · Marco Island, FL
**Charter ID:** ATOM-ORANGE5-MASTER-2026-0623
**Source receipt:** Orangebox chairman plan `2026-06-23T14-29-17-746Z-chairman-plan`
**Refresh receipt:** `2026-06-25-canon-refresh.md` (#059) — locks 5-pillar architecture (Atomic Orange · OrangeBrain · AE Memory · AE Eyes · AtomSmasher 2), retires legacy names (OrangeLLM → OrangeBrain, OrangeEye → AE Eyes, Smart Skinny → small LLM on dev mini PC, AE Black Mamba → killed entirely), folds AE Flow into OrangeBrain training, moves AE Cobra out of OrangeBrain into its own pillar (AE Memory), defers Soul Genome to Orange6
**Status:** SPEC LOCKED · 5-PILLAR DOCTRINE LIVE · WAVE 2 + WAVE 3 SUBSTRATE LANDED
**Standing claim:** We are the future of AI. Make each pillar best-in-next-class.

---

## Reading order for a cold reader

1. Section 0 — One-sentence definition (know what this is)
2. Section 1 — The Five Pillars (the architecture)
3. Section 2 — The Four Laws (the discipline)
4. Section 3 — Architecture diagram (the picture)
5. Section 16 — The 16-PR build sequence (the path forward)
6. Section 17 — Operator SOP (how to use it)
7. Everything else for depth as needed

If you have 60 seconds, read 0 + 1 + 2.
If you have 10 minutes, read 0 through 4 + 14 + 15.

---

## 0. One-Sentence Definition

Orange5 is the **free**, **local-first**, **sovereign** AI operator OS that uses an N150 control host and Codexa heavy-compute host, is **codeless** at the operator surface, and is conducted through **OrangeBrain** with deterministic Bun control, bounded model leases, memory, visual intelligence, compression, agents, and receipt-backed execution.

---

## 1. The Five Pillars

Locked 2026-06-25 (canon-refresh #059). Supersedes the prior Four-Pillar shape.

| # | Pillar | Role | Where it lives |
|---|---|---|---|
| 1 | **Atomic Orange** | **User interface · navigation · project management tool.** The command interface for the AI coder. One place to manage a project in full. The N150 uses a zero-resident-model Bun reflex; generative work routes to Codexa. | `02-APP/` |
| 2 | **OrangeBrain** | **The governed intelligence gateway.** Takes a request and knows how to get it done using the whole Orange system. The active Navigator is warm on Codexa; heavy models are bounded leases. Historical `OrangeLLM-*` paths and artifacts retain their filenames for compatibility. | `06-ORANGELLM/` |
| 3 | **AE Memory** | **AE Cobra + Mem tools running a dual memory system.** Replaces wiki / Karpathy wiki / knowledge engine / RAG / all that. Ingests all past documents. Knows what happened March 28th four years ago AND one hour ago. Knows project state, operator ideas, things forgotten — catches and surfaces them. **AE Cobra always runs on Docker** as compressor + view + decision maker + history-of-wisdom-and-mistakes. Two-LoRA architecture: visual memory + thinking text recall of the SAME state. SSD (Mamba-2) — no KV cache, sees / saves / thinks at once. | `06-ORANGELLM/memory/` (current) → Docker daemon (steady state) |
| 4 | **AE Eyes** | **Visual pillar.** Conglomerate of visual tools — video, photo generation, graphics, web/UX work. Stops the system from making trash visual output. Bar: can produce a comic book at quality. (Renamed from "OrangeEye"; now a pillar, not a sub-tier.) | `07-VISUAL/` |
| 5 | **AtomSmasher 2** | **Compression engine + toolset.** Driven by AE Cobra (the always-on active sieve on the river of data) and by AE Eyes (for visual compression). Goal: every tool that passes through Orange5 is live, operational, and compressed. (Renamed from "AtomSmasher v0.7"; promoted to pillar.) | `12-ATOMSMASHER/` |

**Underneath all five:** **Hermes** (bounded agentic execution layer — the hands). `08-HERMES/`.

**System name:** **Orange5** (also written **OrangeFive**) is the entire system. The five pillars are how the system is organized; Orange5 itself is the release name.

**Note on AE Flow:** AE Flow is doctrine **trained into OrangeBrain** — currents / agents / deltas / governors / acceptance criteria become model output behaviors, not a parallel runtime. The `05-FLOW/` codebase becomes training-corpus + behavior-spec for OrangeBrain. **Not a separate pillar.**

**Standing claim:** Make each pillar best-in-next-class. We are the future of AI. Show them.

---

## 2. The Four Laws

1. **Frontier-Isolation Law.** The frontier model hosted in Atomic Orange (Opus / Gemini / GPT / whatever you BYO key for) talks only to OrangeLLM. It never touches Orange5 internals. OrangeLLM filters what it sees. → BYO-frontier is safe by design.

2. **LLM-Over-Agent Law.** LLMs sit above agents. Every LLM in the model superstack can spawn its own agents under a Hermes lease. OrangeLLM does too. The team operates with delegated autonomy.

3. **OrangeLLM-Is-The-Gateway Law.** OrangeLLM + Flow Direct is the only path to the model superstack, the tools, and the Visual capability. Nothing else reaches them directly.

4. **Codeless Law.** No code editor UI. No IDE lane. No autocomplete. Orange5 is operator + chat + OrangeLLM doing the thinking + Hermes doing the work.

---

## 3. Architecture (text diagram)

```
                       OPERATOR
                          │
                          ▼
                ATOMIC ORANGE  (Pillar 1)
              User interface · Nav · PM tool
              command interface for the AI coder
              ↑                       │
              │                       ▼ (only legal path to internals)
              │
              │            ORANGEBRAIN  (Pillar 2)
              │      big-LLM hub · Flowstate baked into training
              │            zero retraining on tool use
              │                       │
              │     ┌──────────┬──────┴──────┬─────────────┐
              │     ▼          ▼             ▼             ▼
              │  AE MEMORY  AE EYES      HERMES       ATOMSMASHER 2
              │ (Pillar 3) (Pillar 4)   (execution)    (Pillar 5)
              │  AE Cobra   video/photo                compression
              │  + Mem tools  graphics/UX              engine driven
              │  Docker     comic-book bar             by AE Cobra
              │  always-on                             + AE Eyes
              │  2-LoRA wisdom
              │       │
              └─ small LLM on N150 relays reports ─┘
                                       │
                                       ▼
                              ORANGE5 INTERNALS
                       (receipts · configs · Mirage)
                       Reachable ONLY through OrangeBrain
```

**Frontier model (BYO key — Opus / Gemini / GPT)** plugs into Atomic Orange and talks ONLY to OrangeBrain. It never touches Orange5 internals directly (Frontier-Isolation Law).

---

## 4. Atomic Orange (Pillar 1) — 4 Lanes Locked

**Role:** User interface · navigation · project management tool. The command interface for the AI coder. One place to manage a project in full.

| # | Lane | Ctrl | Contents |
|---|---|---|---|
| 1 | **Chat** | +1 | Primary surface. Talks to OrangeLLM. Per-chat frontier swap (BYO key). `/orange` shortcut to force-call OrangeLLM. Custom-rule sticky toggle. Drop `rules/*.md` to make rules. |
| 2 | **Cockpit** | +2 | Full systems dashboard — the AESee Suite Lite. Live ops of AI Box, Codexa, OrangeLLM (model loaded, tokens/sec, queue depth), Flow currents, Hermes lease state, superstack pulse, hardware RAM/CPU/GPU on both machines, egress audit. |
| 3 | **Vault** | +3 | K3 wildcard memory (alias / lexical / authority / Cold Truth Gate) + Mirage Data Plane access (Drive / Slack / Gmail / Postgres / GitHub reads). Inline citations when OrangeLLM cites a source. |
| 4 | **Settings** | +4 | OrangeLLM controls (model selection, training data refresh) + custom rules manager + Mirage mount permissions + egress declaration + privacy posture + Soul Genome config + API key vault for BYO frontier models. |

### Living touches (small, not full AESee)

- OrangeLLM pulse indicator — subtle breathing when it's thinking
- Orange trail — thin line that traces routes through the Cockpit dashboard
- Bottom strip — receipts land here live (no scroll-back UI, just current state)
- Lane status pills — glow when hot
- `/orange` slash command — force-call OrangeLLM from any chat
- Custom rule badge — small indicator in chat header when a rule is active
- `rules/*.md` drop-in — drag a markdown file into the folder, the chat respects it

### Atom Standard taste anchors (applied to Atomic Orange visuals)

| Influence | Translation |
|---|---|
| Jony Ive | Material restraint, one focal point per surface |
| Steve Jobs | Opinionated defaults, no settings sprawl |
| Teenage Engineering | Playful precision |
| Nintendo 80s/90s | Confident color blocks, character without kitsch |
| Tom Sachs | Honest construction, visible bolts where the bolt matters |

Rule: every surface looks like Jony Ive made it OR Tom Sachs made it. Never both. Never neither.

---

## 5. OrangeBrain (Pillar 2) — Training Corpus + Runtime

**Trained on the system, not on adversarial datasets.** Knows Orange5 like the longest-tenured employee in a company. **Flowstate baked into training** — runs the ocean-wave productivity system inside the model itself, no separate runtime.

### Training corpus (IN)

**System knowledge:**
- AE0 Factory plugin docs (the 11 slash commands and their internals)
- AEoNs Skill Suite V1.4 — all 15 skills' SKILL.md and runtime behavior
- Skill-gauntlet 4-gate pattern (structural pass logic only, not adversarial outputs)
- Atomic Orange contracts (Architecture, Native App Standard, Model Lane, MiniPC Profile, Alpha Pull)
- Full system topology (every port, every host, every config file location)
- The 5-file runtime config schemas (active_council, model_registry, role_map, routing_policy, soul_genome)

**Discipline:**
- 27 Guardrails (top of system prompt + training reinforcement)
- AE0-AE14 department schema
- 9-Gate Stack
- Mom's Law (always)
- Hermes lease policy + LOOM 8 gates

**Protocols:**
- AECode canonical source spec
- AELang v0.1 spec
- orange.order.v1 / orange.report.v1 schemas
- Mission manifest format
- Receipt chain format

**Doctrine (light, applied):**
- Flowstate runtime doctrine (full 41 KB — HOW the model thinks about currents/agents/deltas)
- Tomorrow Brief / Continuity Packet pattern
- Party-line JSONL format
- FATCAT dial plan (100/103/106/107/111/114/200/911)

**Operational history:**
- 180-row Orange4 nav training corpus
- 8 AECode mission packets (factory presets)
- Project receipt history (operator-curated, not bulk)

### Training corpus (OUT — separate AE Misfit Model later)

- STRONGARM Easy adversarial outputs
- Gremlin Elite 1000
- Gremlin QA Dataset V1.1 2000
- Gremlin QA Dataset V1.2 5000
- Gremlin Trainer V2.5

These build a separate **AE Misfit Model** later. They are "too wild" for OrangeLLM the PM.

### Runtime — 1-TIER (locked 2026-06-24)

| Tier | Model | Host | State |
|---|---|---|---|
| **Trained PM brain — the only trained tier** | OrangeLLM-fatty v0 (`unsloth/Qwen2.5-32B-Instruct-bnb-4bit` base + Orange5 LoRA r=16 α=32, 537 MB adapter SHA `852d3386…2c7fd7`, loss 5.95→0.43 across 3 epochs, trained 2026-06-25 on Colab Pro A100, receipt #025) | Codexa (95.6 GB RAM, no NVIDIA) | Awaiting Ollama promotion (operator action L5) to always-warm via Vulkan iGPU offload + CPU |
| **N150 utility (NOT TRAINED)** | `qwen3:0.6b` stock + `nomic-embed-text` (via Ollama on the local box) | N150 (16 GB) | Off-the-shelf for: origin-based lane classifier, Graph Weaver embedder, emergency fallback chat reflex. No custom LoRA. No promotion bakeoff. Stock weights forever. |

**Smart Skinny custom LoRA training lane is KILLED** (operator decision 2026-06-23 / 2026-06-24). N150 stays a fast utility box; the trained brain is on Codexa.

### What OrangeBrain does at runtime

1. Receives operator chat in Atomic Orange.
2. Compiles intent → `orange.order.v1` JSON internally.
3. Picks the right model from superstack (or itself) for the sub-task.
4. Calls AE Eyes (Pillar 4) if vision is needed.
5. Calls Hermes to act if action is needed.
6. Calls AE Memory (Pillar 3) for context retrieval — AE Cobra knows what happened today, last year, four years ago.
7. Operates the Flowstate behavior **from inside training**: currents / agents / deltas / governors / acceptance criteria as model output structure, not a runtime call.
8. Returns `orange.report.v1` (visible as natural language in chat, hash-chained in SQLite).
9. Approval-required actions stop and ask.

---

## 6. AE Eyes (Pillar 4) — Visual System

**Role:** The visual pillar. Conglomerate of visual tools — video, photo generation, graphics, web/UX work. Stops the system from making trash visual output. Bar: can produce a comic book at quality. (Renamed from "OrangeEye"; promoted from sub-tier to pillar.)

### Primary stack (real, served)

| Component | Use |
|---|---|
| **GLM-4.6V** (z.ai VLM, HF served real) | Heavy vision: doc reading, dashboard comprehension, image critique |
| **ColPali + Qdrant** (retrieval layer — detail in `07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md`) | Visual-event indexing + similarity search; backs OrangeEye's memory of what it has seen |
| **Playwright MCP** | Live browser DOM + accessibility tree |
| **Chrome DevTools MCP** | DevTools-level inspection |
| **Screenshot + UX tools** | Color picker, layout analyzer, OCR, screenshot diff |
| **Frontier offload** (BYO key via gateway) | When local visual budget exceeded — Opus/Gemini/GPT vision call routed through OrangeLLM gateway |

### Bridge

```
screen / doc / UI → Visual stack → structured text → OrangeLLM → Hermes
```

### Addendum (only if primary insufficient)

**MiniEyes Model.** 2-8B local VLM (LLaVA-1.6 8B or MiniCPM-V 2.6) trained specifically on Orange5 dashboard screenshots. Cheap, fast, always-on. Translates visual → text for OrangeLLM. Built ONLY if primary visual stack proves insufficient under real load. Tracked as separate addendum project.

---

## 7. AE Flow — Doctrine, Trained into OrangeBrain

**AE Flow is not a separate runtime.** It is the operating doctrine **baked into OrangeBrain's training**: ocean-wave-like productivity, zero wait time, fluid resource maximization. The model itself produces output structured around currents / agents / deltas / governors / acceptance criteria. (Locked 2026-06-25.)

The `05-FLOW/` codebase serves as training-corpus + behavior-spec, not as a parallel pressure-field daemon.

| Concept | Meaning (as a trained behavior of OrangeBrain) |
|---|---|
| **Currents** | Pressure flows through the system. Each open task creates pressure. OrangeBrain ranks attention by pressure. |
| **Agents** | Workers (OrangeBrain sub-agents, model lanes, Hermes leases). Each agent rides a current. |
| **Deltas** | What actually changed in the last tick. OrangeBrain reports deltas as they land. |
| **Governors** | Backpressure controls. OrangeBrain throttles current spawn when too much pressure stacks. |
| **Acceptance criteria** | When does a current close? Receipt + governor approval. |

**Why this matters:** OrangeBrain doesn't run on a flat task queue. It thinks in a pressure field, natively. High-priority work bubbles up because the model is trained to recognize it. The operator sees deltas in Atomic Orange, not log spam. The whole system stays in flow because the brain itself is in flow.

---

## 8. Model Superstack (LLM Team — `14-SUPERSTACK/`)

| Model | Lane | Where | State |
|---|---|---|---|
| `qwen3:0.6b` stock (the N150 utility model — NOT a custom Smart Skinny LoRA; that lane is killed per §5) | Reflex / always-warm | N150 | Warm |
| OrangeLLM-fatty v0 (`unsloth/Qwen2.5-32B-Instruct-bnb-4bit` + Orange5 LoRA) | Daily Cortex (PM brain) | Codexa | Adapter on disk; awaiting Ollama promotion |
| Qwen Coder Specialist | Code lane | Codexa | Warm on demand |
| GLM-4.6V | Visual / VLM Eye | Codexa | Event-armed |
| GLM frontier (BYO) | Heavy reasoning judge | Subscription | BYO key |
| Opus 4.7 / GPT-5.5 / Gemini (BYO) | Frontier judge | Atomic Orange chat | BYO key |
| Falcon-H1-34B | Wildcard reasoning | Codexa | Event-armed |
| Dolphin3 8B | Wildcard / general capable | Codexa | Warm |
| Hermes-3 (NousResearch agentic-tuned Llama — NOT the Hermes daemon) | Wildcard / function-calling agent | Codexa | Event-armed |
| GLM-5.2 (BYO, unskipped) | Subscription frontier | BYO key | New unskip |
| MiniMax M3 (BYO, unskipped) | Subscription frontier | BYO key | New unskip |
| llama.cpp lane | Local inference fallback | N150 | Cold fallback |
| Reddit / arXiv scout | Source intake (quarantined) | OrangeLLM tool | Daily crawl |

**Every model in this team can spawn its own Hermes-leased agents.** LLMs > Agents.

---

## 9. Tools Under OrangeLLM

### Mirage Data Plane — 11 mounts (`11-MIRAGE/`)

| Mount | Default | Notes |
|---|---|---|
| `local_project` | READ | Filesystem read |
| `local_receipts` | READ | Receipt log read |
| `redis_state` | READ + WRITE | Cache |
| `github_read` | READ | Repo content |
| `github_write` | WRITE (approval-per-call) | Push/PR |
| `drive_read` | READ | Google Drive |
| `gmail_draft` | DRAFT-ONLY | No send |
| `slack_read` | READ | Slack content |
| `slack_draft` | DRAFT-ONLY | No send |
| `postgres_read` | READ | DB queries |
| `postgres_write` | WRITE (approval-per-call) | DB mutations |

Write needs per-call operator approval.

### AtomSmasher 2 (Pillar 5) — compression engine + toolset (`12-ATOMSMASHER/`)

**Role:** Compression engine + tool registry. Driven by AE Cobra (Pillar 3, AE Memory) as the always-on active sieve on the river of data passing through Orange5. Also available to AE Eyes (Pillar 4) for visual-stream compression. Every tool the system uses passes through AtomSmasher 2 — live, operational, compressed.

Backend integration · Tool merge doctor · plus 12 modules:

1. **Commitment Atoms** — irreducible promise units the model can't fake
2. **AIR Codec** — Atomic Information Representation (token-efficient encoding)
3. **EquationStore** — canonical math/logic facts the model can cite
4. **Cartridges** — pre-compressed knowledge packs (whole domains loaded in one shot)
5. **Sparse Worksets** — only the lines that matter, not whole files
6. **Least-action Router** — picks the smallest path to the answer
7. **Expansion Warrants** — explicit permission to grow scope (no creep)
8. **Compression Debt Ledger** — tracks what got compressed and what got lost
9. **Saved Work Certificates** — proof a recomputation isn't needed
10. **Canon Pressure Detector** — flags drift from doctrine
11. **Pathwave Compressor** — compresses execution traces for replay
12. **Anti-fluff Gate** — refuses verbose output

These turn OrangeBrain into a token-efficient compiler that doesn't waste context, doesn't drift, and proves its work. **Active operation:** AE Cobra in AE Memory pillar (Docker, always-on) runs the sieve. Every tool, every passage of data, gets a compression pass before it leaves the boundary.

### ToolMesh — 11 labs (`13-TOOLMESH/`)

OrangeLLM's specialized capabilities across 11 domains:

`image · video · audio · design · coding · automation · analytics · public-agent · observability · security · releaseops`

Each lab holds tool-cards OrangeLLM consults when the task fits. Tool-cards are not permission-to-execute — they're capability indicators OrangeLLM checks before asking for operator approval.

---

## 9b. AE Memory (Pillar 3) — AE Cobra + Mem tools

**Role:** Wisdom layer. Replaces wiki / Karpathy wiki / knowledge engine / RAG / all that. **AE Cobra is the engine; AE Memory is the pillar.**

### Architecture

| Component | What it is |
|---|---|
| **AE Cobra** | Resident SSD (Mamba-2) model. No KV cache. Sees / saves / thinks at once. Two-LoRA adapter stack: (a) visual memory adapter, (b) thinking text recall adapter — both operating on the SAME state representation. Always-on. |
| **Mem tools** | The supporting toolkit AE Cobra uses to read/write the dual memory store, surface forgotten threads, answer time-of-event queries (March 28th four years ago vs one hour ago). |
| **Docker daemon** | Steady-state deployment. AE Cobra always runs on Docker on Codexa: compressor + view + decision maker + history of wisdom AND mistakes. |
| **Ingestion** | Trains on and ingests all past Orange/AtomEons documents — every receipt, every plan doc, every operator note, every project memory. |

### What it answers

- "What did we do on March 28th 2022?" (historical event recall)
- "What did I just decide an hour ago?" (recent-state recall)
- "What's the status of project X?" (project-state surface)
- "Catch me on the idea I had about Y three weeks ago that I haven't acted on." (surfacing forgotten threads)
- "What mistakes did we make on this kind of work before?" (history-of-mistakes lane)

### Operating role

AE Cobra also serves as the **active sieve** that drives AtomSmasher 2 (Pillar 5). Every data passage through Orange5 is compressed by AE Cobra in flight, and the relevant residue is saved to AE Memory's dual-memory store. It is always on, always compressing, always remembering.

**Standing rule:** Don't fuck this up. AE Memory is the wisdom. Without it the system has no past.

---

## 10. Hermes — Agentic Execution Layer (`08-HERMES/`)

- Replaces OpenClaw (retirement complete).
- Lease policy + LOOM 8 gates enforced at every action.
- Every agent (OrangeLLM's, or any superstack LLM's) runs under a Hermes lease.
- No agent acts outside its lease.
- Every action emits a receipt to `10-RECEIPTS/orange5-build/`.

### Hermes lease structure

```yaml
allowedActions: [list of explicit verbs the agent may perform]
forbiddenActions: [destructive_write, production_deploy, scope_expansion]
authority_chain: [Operator > Orange5 Brain MCP > Hermes bounded lease > receipt]
```

### LOOM 8 gates

`order_schema · report_schema · receipt_spine · human_approval · codexa_lease · openai_gateway · mcp_default · false_green_guard`

All 8 must pass before an action lands.

---

## 11. Endpoints + Ports

| Service | Address |
|---|---|
| OpenAI-compatible endpoint | `127.0.0.1:1337/v1` |
| Brain MCP Gateway | default (stdio + Streamable HTTP) |
| Command server | `127.0.0.1:8787` |
| Smart Skinny adapter | `127.0.0.1:8797` |
| STRONGARM Easy sidecar (runtime check only, not training) | `127.0.0.1:8094` |
| Codexa command rail | `10.0.99.1:8097` |
| Codexa wiki bridge | `10.0.99.1:8098` |
| Codexa knowledge receipts | `10.0.99.1:8099` |

---

## 12. Hosts

| Host | IP | RAM | GPU | Role |
|---|---|---|---|---|
| **N150 (cockpit)** | `10.0.0.114` | 16 GB | none | Reflex / watcher / Atomic Orange |
| **Codexa (heavy)** | direct `10.0.99.1` · LAN `10.0.0.4` | 95.6 GB | none (cloud GPU for LoRA) | Fatty OrangeLLM / superstack / Visual / Hermes |

---

## 13. Storage Locations

| Path | Purpose |
|---|---|
| `C:\AtomEons\Orange5\` | Code repo (this folder) |
| `C:\Users\a\OrangeBox-Data\` | Operator data lake (external — preserved) |
| `C:\AtomEons\Orange5\04-CONTROL-PLANE\receipts\orange5.db` | Receipts SQLite (charter-canonical) |
| `C:\AtomEons\Orange5\06-CONTROL-PLANE\receipts\orange5.db` | Receipts SQLite (KNOWN-DRIFT — actual current location; see NAMING_CANON drift table) |
| `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\` | Markdown receipts |
| `C:\AtomEons\Orange5\13-MODELS\orange-llm\soul_genome.json` | Soul Genome storage (KNOWN-DRIFT — see NAMING_CANON) |
| `C:\AtomEons\Orange5\16-TRAINING\adapters\<model>-v<N>\` | Trained LoRA adapters (fatty v0 lives here) |
| `C:\AtomEons\Orange5\16-TRAINING\corpus\<model>-v<N>.jsonl` | Training corpora (SHA-bound) |
| `C:\AtomEons\Orange5\16-TRAINING\configs\<model>-v<N>.{ipynb,yaml}` | Training notebooks + configs |
| `%APPDATA%\Atomic Orange\` | App data |
| `C:\AtomEons\Orange5\19-ARCHIVE\` | Frozen archive (never deleted) |

---

## 14. What's IN (final feature list)

### Core
- Atomic Chat shell (Tauri 2 + React 19 + Vite 6 + Rust, signed Windows installer + macOS notarized + Linux build, single-binary path via eframe + egui native v2.0)
- OrangeLLM Light (Smart Skinny 0.5b on N150 always-warm)
- OrangeLLM Heavy (fatty 32-70B on Codexa always-hot)
- OpenAI-compatible endpoint at `127.0.0.1:1337/v1`
- Brain MCP Gateway (drop-in for Claude Desktop / Claude Code / Codex / Cursor)
- Command server at `:8787`
- **Full Flowstate runtime** (currents / agents / deltas / governors)
- **VLM Eye HF model promotion** (GLM-4.6V served real, not deterministic substitute)
- **LoRA training GPU lane** (closes Orange4 Gate 18; cloud GPU since Codexa has none)

### Memory & data
- ChatBackup always-on (local backup of every chat)
- K3 wildcard memory (alias / lexical / authority / Cold Truth Gate)
- Soul Genome continuity (config + knowledge engine)
- Semantic + vector memory
- Research assurance lab + source quarantine
- Knowledge improvements approval queue
- Tomorrow Brief / Continuity Packet (daily forward-look)
- 5-file consolidated runtime config (active_council, model_registry, role_map, routing_policy, soul_genome)
- Mirage Data Plane (11 mounts, READ default, write needs approval)

### Compression & efficiency
- AtomSmasher v0.7 backend integration (proof-receipted)
- AtomSmasher v0.7 advanced 12 modules
- Tool merge doctor

### Capabilities (ToolMesh 11 labs — OrangeLLM's toolkit, NOT a UI)
- image / video / audio / design / coding / automation / analytics / public-agent / observability / security / releaseops

### Discipline (training-baked into OrangeLLM, not separate code modules)
- 27 Guardrails (constitutional)
- AE0-AE14 department schema
- 9-Gate Stack (LBCE → Scope → Department → Triad → HRE → Security → Drift → Receipt → CHECKMATE → Human Final Stop)
- Mom's Law (above all)
- STRONGARM Easy sidecar at `:8094` (runtime pressure check)
- Mirror verification
- Misfit / Gremlin pressure → DEFERRED to separate AE Misfit Model project

### Protocols
- AECode canonical source
- AELang v0.1 spec
- `orange.order.v1` / `orange.report.v1` schemas
- Mission manifest + hash-chained receipt log (in SQLite, no UI)
- Report compiler with invalid-order rejection

### Integrations
- Hermes Agent (lease policy + LOOM 8 gates) — replaces OpenClaw
- Checkmate verification panel (isolated MCP runtime)
- 7-role Codexa Super Stack (heavy lane for OrangeLLM)
- Discord / Slack / Telegram bots (chat-only, no autonomous action)
- n8n integration (OS-level only)
- LoRA training pipeline (Codexa GPU lane — uses cloud GPU since local has none)

### Receipts
- SQLite hash-chained log
- Consumed by OrangeLLM internally
- NO operator-facing scrub UI (Codeless extends here)

### Privacy
- Zero phone-home
- No accounts
- No telemetry by default
- Local-first vault
- Egress declaration manifest
- Privacy posture visible in Settings

### Build sequence
- 16-PR plan (Section 16) — each PR closes one gate with a receipt
- No mega-merges

---

## 15. What's OUT (killed forever)

| Category | Killed |
|---|---|
| **Paid SKUs** | AI Box Cloud ($19/mo), Pooled Keys ($99/mo), Team ($499/yr), AtomEons Edition appliance ($499 MOQ-100), Bug Bounty SKU, Router ASIC FPGA module ($80 hardware), $MCP money server |
| **Substrate** | Router ASIC v1.0 silicon spec, Double Mamba substrate v0.6, 5-axiom Router (corpus_callosum.py), 199 ARC primitives, 8-backend Cortex registry, Adversarial Immunity Suite, Federation 100k stress, Phenomenon receipts, Lifespark daemon, Domains / Formal-methods / Hardware / Mega-scale stacks |
| **Codeless kills** | IDE lane, code editor, Tab autocomplete, Agent Mode (Ctrl+A), Repo indexer |
| **Surface kills** | Voice lane, Mobile companion lane, Receipts UI lane (SQLite log persists; no scrub UI), Antigravity integration, 21-gate Orange4 warbook |
| **Training kills** | STRONGARM / Gremlin training INTO OrangeLLM (becomes separate AE Misfit Model) |
| **Content kills** | Skil.ski 322 sectors, 4 generators, 34 seed-batches, 5,100 state workflows, 105 barber skills |
| **Doctrine consolidation kills** | Smart Model Router (OrangeBrain does the routing), skill-gauntlet / AEoNs / AE0 Factory as separate components (folded into OrangeBrain training), CLC / GlyphSpeak / Federation Triumvirate / Ignition Cascade / Phenomenon Approach / Self-Evolution Loop / Lifespark Train / Black Mamba v1-v5 / 24-Month Attack Roadmap / AECode Export Bridge / Bug bounty methodology / Cortex IDE phases (as separate code; folded into OrangeBrain training where useful) |
| **Legacy-name kills (2026-06-25)** | "OrangeLLM" (renamed → **OrangeBrain**), "OrangeEye" (renamed → **AE Eyes**), "Smart Skinny" (renamed → "small LLM on dev mini PC"), "AE Black Mamba" (killed entirely — AE Cobra is the only name for that engine), "AE Flow as separate runtime" (killed — folded into OrangeBrain training as doctrine) |
| **Deferred to Orange6** | Soul Genome project (defer with recall marker; not Orange5 v1 scope) |
| **Visual kills** | All visual fancy ideas (Trinity, Bioluminescent DAG, Whisper, Perspective Filters, 72-state mockup bank, Resilient Luxury vocabulary) — parked under AESee HOLD |
| **Adjacent projects out** | VideoShop, arc-agi-3-misfit-agent, BookMaker, i-am-ai, i-am-ai-audiobook, heretic, osiris, multica, eidos, NGS54, aeskills, atommccree.com, PTCG line, EIDOS+EDIOS shells, EIDOS Optimization plan |
| **Misc kills** | Legacy Sigs22 / Signals / CSwipe, hardware-acceleration wrappers (CUDA/Metal/oneAPI/OpenCL/ROCm — substrate kills cascade), Mega-scale stress at 100k+, Lean 4 Verification Gate, E9-E11 frontier subscription role wiring (Atomic Chat handles model swap natively) |

---

## 16. Build Sequence — 16 PRs

Revised from GPT's 17-PR `github.com/AtomEons/Atomic-Orange-Five` plan. Codeless removes IDE PRs. New PRs added for the 4 pillars.

| # | Branch | Theme | Acceptance |
|---|---|---|---|
| 01 | `native-rail` | Tauri 2 + React 19 + Vite 6 + Rust shell binary | App boots; binary signs |
| 02 | `frontier-isolation` | Atomic Orange hosts frontier; ONLY OrangeLLM endpoint reachable from frontier; boundary tests | Frontier proves it cannot reach internals |
| 03 | `orangellm-light` | Smart Skinny 0.5b on N150 always-warm; OpenAI-compat endpoint at `:1337/v1`; reflex routing | Endpoint serves; smoke green |
| 04 | `orangellm-heavy` | Codexa fatty model selection (Qwen 35B A3B default); training corpus assembly (no Gremlin); LoRA training pipeline definition | Heavy model loads; training pipeline doctor green |
| 05 | `flow-direct` | Full Flowstate 41 KB doctrine; currents/agents/deltas/governors/acceptance criteria; SQLite-backed | Flow currents visible in Cockpit |
| 06 | `lane-chat` | Primary surface; talks to OrangeLLM; per-chat frontier swap; `/orange` shortcut; custom-rule stickiness | Chat sends; OrangeLLM responds; rule activates |
| 07 | `lane-cockpit` | Full systems dashboard; AESee Suite Lite | All live indicators present |
| 08 | `lane-vault` | K3 wildcard memory + Mirage Data Plane access; inline citations | Search returns; citations render |
| 09 | `lane-settings` | OrangeLLM controls + custom rules manager + Mirage permissions + egress declaration + privacy posture + Soul Genome | All controls present |
| 10 | `adapters` | Bun + SQLite adapter registry; 4 adapters (mock, local-llama-cpp, ai-box-triad-readonly, ai-box-allowlisted-command) | Adapter doctor green |
| 11 | `schemas-specs` | AECode + AELang v0.1 + orange.order.v1 + orange.report.v1 + mission/receipt schemas | Schemas validate; doctor green |
| 12 | `promotion-gate` | Every promotion requires receipt + bakeoff; no fake-green | Fake-green rejection fixture passes |
| 13 | `visual-stack` | GLM-4.6V served real + Playwright MCP + Chrome DevTools MCP wired under OrangeLLM; MiniEyes addendum deferred | VLM Eye serves; UX tools wire |
| 14 | `hermes-llm-agents` | Hermes lease policy + LOOM 8 gates + LLMs spawn agents via Hermes | Lease enforces; LOOM 8/8 green |
| 15 | `atomsmasher-toolmesh` | AtomSmasher v0.7 + 12 modules + ToolMesh 11 labs backend integration + tool merge doctor | All modules + labs present |
| 16 | `closeout-repair` | Final not-green ledger + repair queue + GitHub closeout | Ledger 0 red |

**Every PR closes with:**
1. Receipt in SQLite (`06-CONTROL-PLANE/receipts/orange5.db` — KNOWN-DRIFT from canonical `04-CONTROL-PLANE/receipts/orange5.db`)
2. Markdown receipt in `10-RECEIPTS/orange5-build/`
3. Operator approval gate (where applicable)

Build executes via Claude/Codex. Each PR is independent. No mega-merges.

### Repair track (PR-17+, outside the canonical 16-PR sequence)

Two repair PRs landed 2026-06-24 to fix gaps discovered after PR-16 closeout:

| # | Branch | Receipt | What |
|---|---|---|---|
| PR-17 | `runtime-router-repair` | `2026-06-24-pr-17-runtime-router-repair.md` | Runtime router gaps surfaced post-PR-16 |
| PR-18 | `smart-skinny-compatible-runtime` | `2026-06-24-pr-18-smart-skinny-compatible-runtime.md` | Smart Skinny adapter compatibility |

Future repair PRs land here with `PR-N` naming continued. The canonical 16-PR build sequence is closed; PR-17+ is repair-track, not new-feature scope.

---

## 17. Operator SOP — 10-step session loop

1. **Open** — Talk to OrangeLLM in Chat lane. Run `npm run badge`. Verify systems dash in Cockpit.
2. **Scope** — State the objective. OrangeLLM picks lane + department + gate. Name rollback path.
3. **Mission contract (AECode)** — OrangeLLM compiles intent → `orange.order.v1` JSON. Validates against schema. If `riskLevel >= high`, routes to operator approval gate.
4. **Implement** — OrangeLLM picks worker (N150 / Codexa) + model lane (reflex / local-fast / local-code / subscription-frontier / tool-execution). Patches in ghost worktree, NOT main. Never bypasses Gate 0 (LBCE) or Human Final Stop.
5. **Verify** — OrangeLLM runs doctor + gauntlet + smoke + final-decision proof.
6. **Receipt** — Compiles `orange.report.v1`. Writes to `10-RECEIPTS/orange5-build/<timestamp>-<order_id>.json`. Hash-chains to prior receipt.
7. **Approve** — Autonomous (riskLevel ≤ medium): receipt sufficient. High/destructive/production: operator approval. Federation-level: triumvirate quorum.
8. **Promote** — Patch from worktree to main. Git commit with receipt path in message.
9. **Rollback (if needed)** — Every patch has `rollback.ps1`. Operator runs; OrangeLLM confirms; receipt written.
10. **Close** — Run 12-gate verifier. Write session-close receipt.

### Standing rules

- Mom's Law above all.
- No fake-green.
- No silent autonomy on protected actions.
- Receipts over slogans.
- Search before claim for present-day facts.
- One writer per overlapping file.
- Output shape: result · evidence · blockers · next action.

---

## 18. Held — reconciled 2026-06-25

**Reality check:** The 2026-06-23 spec said `18-HELD/` would hold these projects' code. Wave 2/3 work (2026-06-25) landed each HELD-named item across the **active** substrate rather than under `18-HELD/`. Disk reality: `18-HELD/` is empty. Canon-refresh #059 reconciles below.

### AESee Living Dashboard — SPLIT

The **full fancy roadmap** (Trinity Interface, Resilient Luxury vocabulary, 72-state mockup bank, UX_SYSTEM, ORANGEBOX 2050) remains **HELD**. Resume only on operator unlock.

The **Bioluminescent DAG** subset (DagGraph + DagNode + DagEdge + TrinityLayout + WhisperContext + WhisperPrompt + PerspectiveFilter + TimeScrubber + ArtifactLibrary + aesee-anim.css) landed 2026-06-25 as an **opt-in view inside the Cockpit lane** at `02-APP/src/lanes/AESee.tsx` + `02-APP/src/components/aesee/`. Four-lane discipline preserved (no 5th route). Toggle persisted in `localStorage` as `atomic-orange.cockpit.view = standard|aesee`. Receipt #090 (`2026-06-25-aesee-bioluminescent-dag.md`).

### AE Misfit Model — PIPELINE ACTIVE, MODEL HELD

Pipeline scaffolding (strategy → seed → config → notebook → gate → route) authored end-to-end 2026-06-25 across the **active** substrate:
- `16-TRAINING/ae-misfit/corpus-strategy.md` (354 lines)
- `16-TRAINING/ae-misfit/seed/seed-100.jsonl` (100 hand-authored pairs, SHA `5119681d…a9667`)
- `16-TRAINING/configs/ae-misfit-v0.{yaml,ipynb}` (T4-Free-correct)
- `04-CONTROL-PLANE/misfit/second-opinion.mjs` (gate module, 11/11 smoke green)
- `06-ORANGELLM/server/routes/misfit{,-boundary}.mjs` (route + boundary, 34/34 smoke green)

**Model itself remains HELD** — adapter not trained, blocked on operator pointing pipeline at real STRONGARM Easy + Gremlin Elite/QA/Trainer archive paths. Receipt #026 (`2026-06-25-ae-misfit-pipeline.md`).

### MiniEyes Model — HELD

Wave 3-15 authored a scaffold receipt (`2026-06-25-minieyes-vlm.md`). No model trained. Built ONLY if primary Visual stack (GLM-4.6V + ColPali/Qdrant + Playwright + Chrome DevTools + UX tools) proves insufficient under real load.

### AE Cobra (formerly drafted as "AE Black Mamba") — ACTIVE PILLAR 3

The name "AE Black Mamba" is **retired entirely** (canon-refresh 2026-06-25). AE Cobra is the only name. Pretrain corpus authored 2026-06-25 + grammar-aligned 2026-06-26 receipt. Custom AE Cobra weights not trained yet; the Night-1 spine uses a Mamba-2 surrogate while training data accumulates. AE Cobra is **not HELD** — it is the active engine of Pillar 3 (AE Memory), with current substrate at `06-ORANGELLM/memory/` migrating to Docker daemon.

### Soul Genome — DEFERRED TO ORANGE6

Soul Genome (operator continuity config that survives model swaps) is **out of Orange5 v1 scope**. Carried to **Orange6** with a recall marker. Existing storage at `13-MODELS/orange-llm/soul_genome.json` + manager at `13-MODELS/orange-llm/genome-manager.mjs` stays in place untouched until Orange6 work begins.

---

## 19. Atomic Chat — separate adjacent track

Atomic Chat is a base shell. Lives at `github.com/AtomEons/Atomic-Orange-`. Continues iterating separately from Orange5 v1 sprint. Orange5 inherits its bones into `02-APP/` when Codex moves it. Atomic Chat ≠ AESee Living Dashboard.

---

## 20. Source receipts + memory anchors

This plan is held in three independent reservoirs so it survives session loss:

1. **This file** — `C:\AtomEons\Orange5\00-CHARTER\ORANGE5_MASTER_PLAN.md`
2. **Memory-local entity** — `Orange5-Locked-Spec-2026-06-23` (knowledge graph)
3. **Orangebox chairman plan receipt** — `2026-06-23T14-29-17-746Z-chairman-plan`

Plus the conversation history at `vigilant-elbakyan-22fc26` worktree.

---

## 21. The Cymbal Crash (closing law)

When Orange5 v1.0.0 ships — when all four pillars stand, all four laws hold, all 1000 parts run on one machine for free, OrangeLLM conducts everything, frontier never reaches internals, no fake-green anywhere — the cymbal crashes.

Until then: **receipts only. No theater. No silent fall-back. Mom is watching every output.**

---

## Glossary

| Term | Meaning |
|---|---|
| **AE** | AtomEons. Prefix used for system pillars. |
| **AECode** | The canonical software-intent middle language for Orange5. `intent → AECode Source → mission → patch → gauntlet → receipt → approval`. |
| **AELang** | Two-tier (High/Core) AI-native route language v0.1. AECode-High → AECode-Core → ORANGEBOX Route Packet. |
| **AESee Suite** | Future fancy living dashboard. On HOLD. Orange5 ships AESee Lite (the Cockpit) for now. |
| **Atomic Orange** | The UI face of Orange5. Tauri shell hosting BYO frontier. |
| **BYO** | Bring Your Own (key/model). |
| **Codeless** | Operator surface has no code editor / IDE / autocomplete. OrangeLLM does the thinking; Hermes does the work. |
| **Codexa** | The heavy compute box (95.6 GB RAM, no GPU). Cloud GPU lane for LoRA training. |
| **Cockpit** | Atomic Orange lane 2. Full systems dashboard. |
| **Cymbal Crash** | The ship moment. When all pillars stand and all laws hold. |
| **Flow** | Orchestration runtime — currents / agents / deltas / governors. |
| **Frontier model** | A subscription-grade model (Opus 4.7, Gemini, GPT-5.5, etc.) the operator BYO-keys. |
| **GLM-4.6V** | z.ai VLM. Visual lane primary model. |
| **Hermes** | Bounded agentic execution layer. Replaces OpenClaw. |
| **LLM-Over-Agent** | Hierarchy law. LLMs sit above agents. Each LLM can spawn its own Hermes-leased agents. |
| **Mirage** | Data plane with 11 mount classes. |
| **MiniEyes** | Addendum visual model (2-8B). Only if primary stack insufficient. |
| **Mom's Law** | "Give full effort every time." The meta-rule above all. |
| **N150** | The cockpit box. Beelink N150, 16 GB RAM. Runs Smart Skinny + Atomic Orange UI. |
| **OrangeLLM** | The PM brain. Light (Smart Skinny on N150) + Heavy (32-70B fatty on Codexa). Trained on the system. |
| **PR** | Pull Request. Build sequence unit. |
| **Smart Skinny** | 0.5b LoRA on Qwen2.5-Coder-1.5B-Instruct. Always-warm N150 reflex. |
| **STRONGARM** | Pressure-gate sidecar at `:8094` (runtime). Datasets train the separate AE Misfit Model. |
| **Soul Genome** | Operator continuity config. Survives model swaps. |
| **ToolMesh** | 11 lab folders holding tool-cards OrangeLLM consults. |
| **z.ai** | Origin of GLM-4.6V. |

---

## Acronym index

| Acronym | Expansion |
|---|---|
| AE | AtomEons |
| AECode | AtomEons Code (canonical source) |
| AELang | AtomEons Language (route language) |
| BYO | Bring Your Own |
| HRE | Hallucination Reduction Engine |
| LBCE | Lattice Boundary Consistency Engine (Gate 0) |
| LoRA | Low-Rank Adaptation (model fine-tuning) |
| LOOM | The 8-gate loom controls |
| MCP | Model Context Protocol |
| OB0X | Orangebox shorthand |
| OS | Operating System (in "operator OS") |
| PM | Project Manager |
| PR | Pull Request |
| SOP | Standard Operating Procedure |
| SQLite | Embedded SQL database |
| Tauri | Rust-based desktop app framework |
| VLM | Visual Language Model |

---

**End of master plan. Read it, save it, ship it.**

*Mom is watching.*
