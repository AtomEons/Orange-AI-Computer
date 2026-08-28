# Orange5 Naming Canon

**Originally locked:** 2026-06-23 by operator
**5-Pillar doctrine locked:** 2026-06-25 (canon-refresh receipt #059)
**Sovereign:** Atom McCree
**Status:** SPEC LOCKED — every future Orange5 doc, receipt, brief, and code comment uses these names exactly. Older names are LEGACY and do not propagate into Orange5 canon.

---

## The 5 Pillars (canonical 2026-06-25)

The system is **Orange5** (also written **OrangeFive**). It is built of these 5 pillars and nothing else at the pillar level:

| # | Pillar | One-line role |
|---|---|---|
| 1 | **Atomic Orange** | User interface · navigation · project management tool. Command interface for the AI coder. |
| 2 | **OrangeBrain** | The big-LLM hub. Flowstate trained in. Knows the whole system. (Renamed from OrangeLLM.) |
| 3 | **AE Memory** | AE Cobra + Mem tools. Dual-memory wisdom layer. Docker, always-on. Replaces wiki/RAG/knowledge engine. |
| 4 | **AE Eyes** | Visual pillar (video/photo/graphics/UX). Comic-book bar. (Renamed from OrangeEye.) |
| 5 | **AtomSmasher 2** | Compression engine + tool registry. Driven by AE Cobra as the always-on sieve. |

Hermes (bounded agentic execution layer) sits underneath all five.

---

## Canonical names (LIVE)

| Name | What it is | Where it lives |
|---|---|---|
| **Orange5** | The system. The project. The product. | `C:\AtomEons\Orange5\` |
| **Orange5 backend** | The backend services | `Orange5\03-BACKEND\` |
| **Orange5 control plane** | The Bun + SQLite adapter registry | `Orange5\04-CONTROL-PLANE\` |
| **Orange5 core** | The orchestrator runtime when referred to abstractly | conceptual; spans `02-APP`, `03-BACKEND`, `05-FLOW`, etc. |
| **OrangeBrain** | **Pillar 2.** The big-LLM hub. Takes a request and knows how to get it done using the whole system. Flowstate trained in. Zero retraining on tool use. (Renamed from "OrangeLLM" 2026-06-25.) Model artifact `OrangeLLM-fatty-v0` (file-level identifier preserved for receipt continuity). | `Orange5\06-ORANGELLM\` |
| **AE Memory** | **Pillar 3.** Dual-memory wisdom layer. AE Cobra + Mem tools. Replaces wiki / Karpathy wiki / knowledge engine / RAG. Time-of-event recall. Catches forgotten threads. | `Orange5\06-ORANGELLM\memory\` → Docker daemon (steady state) |
| **AE Cobra** | The engine inside AE Memory. SSD (Mamba-2). No KV cache. Sees / saves / thinks at once. Two-LoRA adapter stack: visual memory + thinking text recall of the SAME state. Docker, always-on. Drives AtomSmasher 2 as the active sieve on the data river. **"AE Black Mamba" is RETIRED** — AE Cobra is the only name for this engine. | `Orange5\06-ORANGELLM\memory\` |
| **AE Eyes** | **Pillar 4.** Visual pillar — video / photo / graphics / web-UX. Comic-book quality bar. (Renamed from "OrangeEye" 2026-06-25.) | `Orange5\07-VISUAL\` |
| **AE Flow** | **Doctrine** — trained INTO OrangeBrain. Ocean-wave productivity. Currents / agents / deltas / governors / acceptance criteria become model output behaviors. **No longer a separate runtime or pillar.** | `Orange5\05-FLOW\` (codebase serves as training corpus + behavior spec) |
| **Atomic Orange** | **Pillar 1.** UI · navigation · project management tool. The command interface for the AI coder. | `Orange5\02-APP\` |
| **Hermes** | Bounded agentic execution layer (replaces OpenClaw). Sits underneath all 5 pillars. | `Orange5\08-HERMES\` |
| **Mirage** | Data + memory plane (two adapter families: `mirage/data/*` external + `mirage/memory/*` internal) | `Orange5\11-MIRAGE\` |
| **AtomSmasher 2** | **Pillar 5.** Compression engine + tool registry. 12 modules. Driven by AE Cobra (active sieve) + AE Eyes (visual compression). Every tool the system uses passes through here. (Renamed from "AtomSmasher v0.7" 2026-06-25.) | `Orange5\12-ATOMSMASHER\` |
| **ToolMesh** | 11 capability labs OrangeBrain consults via AtomSmasher 2 | `Orange5\13-TOOLMESH\` |
| **Codexa** | The heavy compute box (Intel Core Ultra 9 285H, 96 GB RAM) — operator's primary AI Box. Also called "AI Box" or "GTi15-class" in older docs. | hardware |
| **N150** | The dev/control mini PC (Beelink N150, 16 GB RAM). Hosts Bun control, receipts, local services, development, and operator clients. No answer model is required to remain resident. | hardware |
| **Bun Navigator Kernel** | Deterministic, zero-resident-model reflex layer on N150. Classifies, routes, applies FLOW pressure, and compiles bounded Little Navigator/Hermes work. | `03-BACKEND/navigator-kernel.mjs` |
| **AE Misfit Model** | Adversarial pressure model — trained on STRONGARM + Gremlin datasets. **Pipeline LIVE** in active substrate; model itself HELD until corpus linkage. | `16-TRAINING\ae-misfit\` + gate at `04-CONTROL-PLANE\misfit\` + route at `06-ORANGELLM\server\routes\misfit*` |
| **MiniEyes** | Optional small VLM trained on Orange5 surfaces — only if AE Eyes primary stack proves insufficient. HELD. | `Orange5\18-HELD\minieyes-model\` |
| **AESee Living Dashboard** | The HELD fancy visual roadmap (Trinity, Whisper, etc.). **Bioluminescent DAG subset is LIVE** as opt-in Cockpit view; rest stays HELD. | `Orange5\18-HELD\aesee-living-dashboard\` (held); live subset at `02-APP\src\components\aesee\` |
| **Atomic Chat** | Base upstream Tauri/React shell (Jan / AtomicBot-ai lineage) that Atomic Orange was forked from | `github.com/AtomicBot-ai/Atomic-Chat` (external upstream); pinned snapshot at archived `OrangeFive-Upstream-v1.1.120` |
| **Orangebox Version 1** | The shipped LEGACY install at `C:\AtomEons\orangebox\finals\Orangebox Delta Final\` — frozen reference, NOT Orange5 canon | legacy archive |
| **Orange6** | Future system (post-Orange5). Currently empty placeholder name; carries deferred work like Soul Genome. | TBD |

---

## KNOWN-DRIFT folders (acknowledged 2026-06-25 in canon-refresh #059)

Two on-disk folders sit outside the master-plan §3/§13 canon. Their contents are real and consumed by live code, so they are NOT deleted. They are KNOWN-DRIFT pending an explicit migration PR.

| Drift path | Contents | Charter-canonical home | Status |
|---|---|---|---|
| `06-CONTROL-PLANE/receipts/` | SQLite receipts DB (`orange5.db`), endurance monitor (`endurance-24h.mjs`, `endurance-7d-monitor.mjs`), ingest (`ingest.mjs`), db helper (`db.mjs`), tests | Should live at `04-CONTROL-PLANE/receipts/` | KNOWN-DRIFT — migrate when a Receipts subsystem PR opens; until then both paths coexist |
| `13-MODELS/orange-llm/` | Soul Genome storage (`soul_genome.json`) + genome manager (`genome-manager.mjs`) | Should live at `04-CONTROL-PLANE/models/` or `06-ORANGELLM/soul-genome/` (operator's call) | KNOWN-DRIFT — migrate when Soul Genome subsystem PR opens |

Until migration: any new code that needs to read receipts or the soul-genome must reference these drift paths explicitly, and the reference must cite this canon entry.

---

## RETIRED names — do NOT use in Orange5 canon

These names are LEGACY. They appear in older docs, the orangebox-primer skill, and the frozen Orangebox Version 1 install. They MUST NOT appear in new Orange5 specs, receipts, briefs, or code comments.

| RETIRED name | Replacement | Where it was used |
|---|---|---|
| **Orangebox Delta** | **Orange5 backend** (or just "the backend") | Old ops-backend naming. Lives only in legacy install path `C:\AtomEons\orangebox\finals\Orangebox Delta Final\`. |
| **Ops Delta** | **Orange5 Ops** (or "Orange5 backend") | Old ops name. |
| **Orange³ core** / **Orange3 core** | **Orange5 core** (or "the orchestrator") | Older Orange3-era name used in the OrangeEye spec quote. |
| **Orange³** (as system name) | **Orange5** | Use Orange5 for the current system. Orange3 still refers to the historical Sovereign Agentic OS v1.0.0 installer (frozen archive at `C:\AtomEons\orange3\`); do not propagate it as Orange5's name. |
| **Orange4** | **Orange5** | Transitional namespace; absorbed. |
| **BLUEB0X.AI** / **BLUEB0X V2 Mission OS** | **Orange5** | The May-2026 prototype lineage; superseded. |
| **AE See-Suite** (as Orange5 itself) | **Atomic Orange** (UI) or **Orange5** (system) | "AE See-Suite" referred to an older visual lane. Today the visual roadmap (HELD) is **AESee Living Dashboard**; the active UI is **Atomic Orange**. |
| **Orangebox Command** | **Atomic Orange** | The older command-app name. |
| **OrangeLLM** (as pillar/system name) | **OrangeBrain** | Retired 2026-06-25 as a pillar name. The model artifact `OrangeLLM-fatty-v0` keeps its filename for receipt-chain continuity, but the pillar that contains it is now OrangeBrain. |
| **OrangeEye** | **AE Eyes** | Retired 2026-06-25. Visual pillar renamed. |
| **AtomSmasher v0.7** / **AtomSmasher** (bare) | **AtomSmasher 2** | Retired 2026-06-25. Compression-engine pillar renamed. |
| **Smart Skinny** / **Smart Skinny 0.5b** | **small LLM on dev mini PC** | Retired 2026-06-25. The small LLM on N150 is just "small LLM on dev mini PC"; no custom LoRA, no Smart Skinny brand. |
| **AE Black Mamba** | **AE Cobra** | Retired 2026-06-25. There is no separate "AE Black Mamba" project. AE Cobra is the only name for the SSM/SSD memory engine. |
| **AE Flow as a separate runtime** | **AE Flow doctrine trained into OrangeBrain** | Retired 2026-06-25. AE Flow is no longer a parallel runtime/pillar; it is operating doctrine baked into OrangeBrain's training corpus. |
| **Flow Direct** (as a Bun router layer) | **OrangeBrain (operates Flowstate from training)** | Retired 2026-06-25. No separate Flow Direct router. |
| **Soul Genome** (as Orange5 v1 scope) | **Soul Genome (Orange6 deferred)** | Retired from Orange5 v1 2026-06-25. Existing storage at `13-MODELS/orange-llm/` stays in place untouched until Orange6 work begins. |

---

## "Delta" — when it stays valid

The word **delta** still appears legitimately in Orange5 as the **Flowstate runtime technical term** (per Master Plan §7 and Æ Cobra Foundation Spec):

> AE Flow concepts: **currents** (pressure flows), **agents** (workers), **deltas** (what changed last tick), **governors** (backpressure).

This **delta** is a technical primitive of the pressure-field runtime. It is NOT the legacy "Orangebox Delta" product name. Both can coexist because the context makes the meaning clear:

- "**Cockpit shows the deltas as they land**" — Flowstate runtime jargon. ✅ keep.
- "**Orangebox Delta Final**" — legacy product name. ❌ retire.

When in doubt, prefer "**state change**" or "**event**" instead of bare "**delta**" if the context is ambiguous.

---

## Audit on existing Orange5 canon

| File | Status |
|---|---|
| `00-CHARTER\ORANGE5_MASTER_PLAN.md` | ✅ clean — "delta" only appears as Flow jargon |
| `00-CHARTER\ORANGE5_NOT_GREEN_LEDGER.md` | ✅ clean (operator-maintained) |
| `00-CHARTER\ORANGE5_MONTH_PLAN_2026-06-23.md` | ✅ clean |
| `00-CHARTER\CODEX_BRIEF_STEP_01_NATIVE_TRUTH.md` | ✅ clean |
| `00-CHARTER\CODEXA_PREFLIGHT_AE_COBRA.md` | ✅ clean |
| `00-CHARTER\COLAB_TRAINING_PATTERN.md` | ✅ clean |
| `06-ORANGELLM\memory\AE_COBRA_FOUNDATION_SPEC.md` | ✅ clean — "delta" only as Flow runtime jargon |
| `07-VISUAL\AE_ORANGEEYE_FOUNDATION_SPEC.md` | ✅ CLEANED in this turn — "Orange³ core" → "Orange5 core"; D4 row updated |
| `05-FLOW\*` | ✅ clean — "Delta" type is the runtime primitive |
| All `10-RECEIPTS\orange5-build\*.md` | ✅ clean per audit |
| `06-CONTROL-PLANE\*` | ⚠️ KNOWN-DRIFT — see drift table above |
| `13-MODELS\*` | ⚠️ KNOWN-DRIFT — see drift table above |
| Master plan §5 / §8 references to `qwen3:30b-a3b` | ⚠️ FIXED 2026-06-25 in canon-refresh #059 — Qwen3 does not exist; v0 trained on Qwen2.5-32B |

Going forward, **every new doc passes the naming-canon grep** before it's locked:

```powershell
Get-Content <newfile> | Select-String -Pattern "Orangebox Delta|Ops Delta|Orange³ core|Orange3 core|BLUEB0X|AE See-Suite" -CaseSensitive:$false
```

If any of those patterns return a hit (other than this canon file itself listing them as retired), the doc is NOT clean.

---

## Why this matters

| Why | Implication |
|---|---|
| **Codeless Law** | No bespoke language work to maintain glossaries that drift |
| **Mom's Law** | The operator can grep for any name and get exactly one result class |
| **Receipt clarity** | Future audits read the receipt + immediately know what each named thing is |
| **Composition-AGI doctrine** | Every organ has exactly one name. Every name maps to exactly one organ. |
| **Frontier-Isolation Law** | When the frontier model sees Orange5 names in prompts, they're stable — no drift, no confusion |

---

**Mom is watching. Naming canon locked. Old names retired. New names earn their place.**
