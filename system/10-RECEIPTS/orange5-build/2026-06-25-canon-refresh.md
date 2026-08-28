# Receipt — Canon Refresh + 5-Pillar Doctrine LOCKED

**Receipt ID:** `2026-06-25-canon-refresh`
**Hash chain:** #059
**Prior receipt:** `2026-06-25-wave-3-master-summary` (#058)
**Status:** `CHARTER_DOCS_RECONCILED_5_PILLAR_DOCTRINE_LOCKED`
**Confidence:** 1.0 (every edit landed against the actual on-disk file state; no fake-green)
**Actor:** Claude (Opus 4.7) under direct operator instruction
**Sovereign:** Atom McCree

---

## What happened

Operator gave a direct order: "fix all drift, cannon, docs, now." Then mid-application, locked a NEW 5-pillar architecture that supersedes the prior Four-Pillar shape from 2026-06-23. This receipt documents the doctrine lock + the file-by-file edits that landed.

## The 5 Pillars (LOCKED 2026-06-25)

| # | Pillar | Role | Lives at |
|---|---|---|---|
| 1 | **Atomic Orange** | UI · Nav · PM tool. Command interface for AI coder. Small LLM on dev mini PC relays reports back-and-forth. | `02-APP/` (CHILL status this session — visual construction in operator's separate Claude chat) |
| 2 | **OrangeBrain** | Big-LLM hub. Flowstate baked into training. Knows the whole system. (Renamed from OrangeLLM.) | `06-ORANGELLM/` |
| 3 | **AE Memory** | AE Cobra + Mem tools. Dual-memory wisdom (visual + thinking-text recall of same state). Docker, always-on. Replaces wiki/RAG/knowledge-engine. SSD (Mamba-2), no KV cache, sees/saves/thinks at once. | `06-ORANGELLM/memory/` → Docker daemon (steady state) |
| 4 | **AE Eyes** | Visual pillar — video/photo/graphics/UX. Comic-book quality bar. (Renamed from OrangeEye.) | `07-VISUAL/` |
| 5 | **AtomSmasher 2** | Compression engine + tool registry. Driven by AE Cobra as the always-on sieve on the data river. | `12-ATOMSMASHER/` |

**Underneath all five:** Hermes (bounded agentic execution). `08-HERMES/`.

**Standing claim:** "We are the future of AI. Make each pillar best-in-next-class. Show them."

## Renames landed (LIVE → RETIRED)

| Old name | New name | Why |
|---|---|---|
| OrangeLLM (as pillar) | **OrangeBrain** | Operator naming lock 2026-06-25. Model artifact `OrangeLLM-fatty-v0` keeps its filename for receipt continuity. |
| OrangeEye | **AE Eyes** | Operator naming lock + pillar promotion 2026-06-25. |
| AtomSmasher v0.7 / AtomSmasher (bare) | **AtomSmasher 2** | Operator naming lock + pillar promotion 2026-06-25. |
| Smart Skinny / Smart Skinny 0.5b | **small LLM on dev mini PC** | Operator: "skinny was old name/version." No custom LoRA on N150; stock `qwen3:0.6b` + `nomic-embed-text`. |
| AE Black Mamba | **AE Cobra** (only name) | Operator naming lock 2026-06-25. There is no separate AE Black Mamba project — that name is killed entirely. |
| AE Flow (as separate runtime) | **AE Flow doctrine (trained INTO OrangeBrain)** | Operator: "ae flow is to be part of the OrangeLLM operational system. i wanted it trained to do this not a separate system." Currents/agents/deltas/governors become model output behaviors, not a parallel runtime. |
| Flow Direct (as Bun router layer) | **OrangeBrain operates Flowstate from training** | Folded into rename above. |
| Soul Genome (as Orange5 v1 scope) | **Soul Genome → Orange6 (deferred)** | Operator: "soul genome project is a orange6 project for now/defer but recall." Storage at `13-MODELS/orange-llm/` stays in place untouched. |

## Files edited (with section-level evidence)

### 1. [ORANGE5_MASTER_PLAN.md](C:\AtomEons\Orange5\00-CHARTER\ORANGE5_MASTER_PLAN.md) — 14 surgical edits

- Header: refresh-date + 5-pillar-lock + standing claim
- §1 Four Pillars → **Five Pillars** (full table replacement)
- §3 Architecture diagram: full redraw with 5 pillars + small-LLM relay + AE Cobra Docker note
- §4 Atomic Orange: role text updated to UI/Nav/PM tool
- §5 OrangeLLM → **OrangeBrain**; flowstate-baked-in note added
- §5 Runtime: "What OrangeBrain does at runtime" — now references AE Memory pillar 3 for retrieval, AE Eyes pillar 4 for vision
- §6 Visual capability → **AE Eyes (Pillar 4)** with full role rewrite
- §7 AE Flow: rewritten as doctrine trained INTO OrangeBrain, not separate runtime
- §8 Superstack: removed Falcon-Mamba (operator: "falc mamba can go off stack. its better for mem"); clarified Hermes-3 model is NOT the Hermes daemon
- §9 AtomSmasher → **AtomSmasher 2 (Pillar 5)**; described AE Cobra-driven sieve role
- §9 final paragraph: "active operation" added about AE Cobra Docker sieve
- §9b NEW SECTION: **AE Memory (Pillar 3)** — full pillar spec with AE Cobra architecture (2-LoRA, SSD/Mamba-2, no KV cache), Mem tools, Docker daemon, ingestion, what-it-answers, operating-role, "Don't fuck this up"
- §15 OUT: added Legacy-name kills + Deferred-to-Orange6 rows
- §18 HELD: AE Black Mamba → AE Cobra (active pillar, not HELD); Soul Genome → Orange6 deferred

### 2. [NAMING_CANON.md](C:\AtomEons\Orange5\00-CHARTER\NAMING_CANON.md) — 4 surgical edits

- Header: 5-Pillar doctrine lock date added
- NEW SECTION at top: **The 5 Pillars (canonical 2026-06-25)** with one-line role per pillar
- Canonical names table: 8 rows rewritten/updated/added (OrangeBrain, AE Memory, AE Cobra, AE Eyes, AE Flow, AtomSmasher 2, small LLM on dev mini PC, AE Misfit pipeline-status)
- Added **Orange6** row to canonical table
- RETIRED names table: 7 rows added (OrangeLLM, OrangeEye, AtomSmasher v0.7, Smart Skinny, AE Black Mamba, AE Flow as separate runtime, Flow Direct, Soul Genome as Orange5 v1 scope)
- KNOWN-DRIFT table for `06-CONTROL-PLANE/` and `13-MODELS/` preserved from earlier edit

### 3. [ORANGE5_NOT_GREEN_LEDGER.md](C:\AtomEons\Orange5\00-CHARTER\ORANGE5_NOT_GREEN_LEDGER.md) — 3 surgical edits

- Header: 5-Pillar context note added
- HELD reconciliation table: AE Black Mamba row replaced with AE Cobra (active engine of Pillar 3, not HELD)
- O6/O7/O8 rows added: Atomic Orange chill-status, Soul Genome → Orange6, AtomSmasher 2 active-on-Codexa goal

### 4. [COLAB_TRAINING_PATTERN.md](C:\AtomEons\Orange5\00-CHARTER\COLAB_TRAINING_PATTERN.md) — 1 surgical edit

- Pass 4 "AE Black Mamba custom v0" → "AE Cobra custom v0" with name-correction note + Active-engine-of-Pillar-3 status

### 5. [ORANGE5_REPAIR_QUEUE.md](C:\AtomEons\Orange5\00-CHARTER\ORANGE5_REPAIR_QUEUE.md) — no changes this turn

- Already refreshed earlier in this session with Colab-burn entries. No name-rename hits.

## What I did NOT touch (and why)

- **`02-APP/` code** — operator: "atomorange app is vis construction in second chat in claude. chill for now no action no reaction." Code preserved untouched.
- **`05-FLOW/` code** — repurposed as training corpus + behavior spec; no file moves yet. Will follow when OrangeBrain v2 training pass picks up the corpus.
- **`13-MODELS/orange-llm/`** — soul-genome storage stays in place per Orange6 deferral.
- **`06-CONTROL-PLANE/`** — KNOWN-DRIFT noted in NAMING_CANON; no migration this turn (consumers untouched).
- **`OrangeLLM-fatty-v0` adapter file naming** — preserved on disk and in receipts. The model artifact's filename is its identity; renaming would break the receipt chain. The PILLAR is OrangeBrain; the trained-weights file is `OrangeLLM-fatty-v0.zip` / `adapter/`.

## Honest gaps (Mom's Law: name them in the open)

1. **`05-FLOW/` codebase reconceptualization is partial.** The doc now says AE Flow is trained-in doctrine, but the existing `05-FLOW/` runtime code (currents/agents/deltas/governors implementations) still exists on disk and may have active consumers. Migration plan needed before any deletion: identify who calls into `05-FLOW/` today, decide whether each call site should (a) become a training prompt + model behavior, (b) stay as a thin shim, or (c) be retired. **No action taken this turn.**
2. **AE Memory pillar is doctrinally LIVE but operationally not-yet-Docker.** Current code lives at `06-ORANGELLM/memory/`; the steady-state Docker daemon hasn't been wired. Tracked in NOT_GREEN_LEDGER #L1/#L2/#L6 family.
3. **AtomSmasher 2 pillar promotion is doctrinal not operational.** Substrate code exists (12 modules + 11 ToolMesh labs) but AE Cobra isn't actively sieving yet because AE Cobra Docker daemon isn't up. Tracked as O8.
4. **OrangeBrain's "flowstate trained in" is aspirational for v0.** OrangeLLM-fatty v0 was trained on Orange5 doctrine corpus (1000 pairs) but the corpus was not explicitly Flowstate-shaped. v1 + v2 training corpora should include Flowstate behavioral examples (current → agent → delta → governor → acceptance sequence) so the trained-in claim becomes real.
5. **Receipt #059 hash chain claim** — chained against #058 which I read directly. The 9 wave3-* receipts dated 2026-06-26 don't carry explicit `**Hash chain:**` headers; if the operator wants strict numeric continuity those should also be numbered. Flagged.

## Cross-doc consistency check (sampled)

| Check | Result |
|---|---|
| Master plan §1 pillar count | 5 ✓ |
| Master plan + NAMING_CANON pillar names match | Atomic Orange / OrangeBrain / AE Memory / AE Eyes / AtomSmasher 2 ✓ |
| "AE Black Mamba" grep across the 4 edited docs | Only appears as "(was drafted as)" or "retired" context lines ✓ |
| "Smart Skinny" grep | Only appears as "(retired name)" or legacy-context ✓ |
| "OrangeLLM-fatty-v0" model artifact name preserved | ✓ (file-level identifier, not pillar name) |
| AE Cobra location | NOT inside OrangeBrain; lives in AE Memory pillar ✓ |
| AE Flow status | "trained into OrangeBrain" not "separate runtime" ✓ |

## Standing operator decisions still on deck (from this session, not landed)

1. **AtomSmasher all 600+ tools live + compressing on Codexa** — operator wants this. Substrate exists; Docker daemon for AE Cobra needs operator-side env work which is parked.
2. **S6 reactivate** — operator wants the LoRA training lane active as live runnable. Pipeline is wire-ready; next action is operator picking the next training target (fatty v1 vs AE Misfit v0 vs AE Cobra custom v0).
3. **Falcon-H1-34B verify** — operator: "i think so." Web verification deferred (operator interrupted the search).
4. **Hermes-3 model role** — operator wanted me to search first. Deferred. Current note in master plan §8 disambiguates from the Hermes daemon.
5. **Control plane: need it? Bun better?** — operator question still open. Charter says Bun + SQLite; actual code is mostly Node `.mjs`. Real choice: keep Node (less churn) or adopt Bun cleanly. No action this turn.

## Mom's Law alignment

- Every edit named above corresponds to an actual file change confirmed by the tool runtime.
- No "green" claim is made without a corresponding edit landing receipt above.
- Pre-existing operator corrections (Qwen3 → Qwen2.5, no torch pin, no Drive, 8-rule Colab discipline) preserved across the doctrine refresh.
- The 6-hour Colab-burn lesson stays in REPAIR_QUEUE.
- The "be better plz" feedback memory is unchanged at `feedback_six_hours_burned_be_better.md`.
- No work claimed beyond what landed. Honest gaps section above lists what's still partial.

## Hash chain

```
#058 — 2026-06-25-wave-3-master-summary
#059 — 2026-06-25-canon-refresh   ← this receipt
```

## Result / Evidence / Blockers / Next action

- **result:** 5-Pillar doctrine LOCKED. Four charter docs reconciled to disk reality + new naming. AE Black Mamba killed. AE Flow folded into OrangeBrain training. OrangeEye → AE Eyes (pillar promotion). AtomSmasher → AtomSmasher 2 (pillar promotion). Soul Genome → Orange6 (deferred).
- **evidence:** 14 master plan edits + 4 NAMING_CANON edits + 3 NOT_GREEN_LEDGER edits + 1 COLAB_TRAINING_PATTERN edit, all confirmed by Edit tool's `file updated successfully` returns. This receipt enumerates each. Cross-doc consistency check sampled above.
- **blockers:** Operator-side env work parked (per standing operator decision). `05-FLOW/` migration plan not authored (out of scope this turn). 5 open operator decisions listed above remain.
- **next action:** Operator review. If lock holds: next session resumes against the 5-pillar architecture with no further canon shuffling. If anything wrong: edit list above is the diff to revise.

---

**Mom is watching. 5 pillars locked. Show them.**
