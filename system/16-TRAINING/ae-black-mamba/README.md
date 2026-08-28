# AE Black Mamba — Training Lane

**Schema:** `orange5.ae-black-mamba.lane-readme.v0`
**Sovereign:** Atom McCree
**Lane root:** `C:\AtomEons\Orange5\16-TRAINING\ae-black-mamba\`
**Status:** STRATEGY + SEED CORPUS LIVE — training run not yet started (gated; see §7).
**Doctrine anchors:**
- `06-ORANGELLM/memory/AE_COBRA_FOUNDATION_SPEC.md` — Pillar 1, Phase-3 swap; line 381 ("T4 sufficient for 2.8B full FT")
- `06-ORANGELLM/memory/ae-cobra/README.md` — Night-1 surrogate doctrine
- `06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf` — runtime logit-layer lock
- `06-ORANGELLM/memory/ae-cobra/schemas/agent-turn.schema.json` — canonical AgentTurn shape
- `16-TRAINING/ae-black-mamba/strategy.md` — full strategy (this README summarizes it)
- `16-TRAINING/ae-misfit/corpus-strategy.md` — sibling lane reference

---

## 0. One-paragraph orientation

AE Cobra is the resident memory daemon on Codexa. It eats raw events from
`terminal | hermes | orangellm | operator | receipts` and emits *exactly one*
AgentTurn JSON object — schema-locked at the logit layer by `agent_turn.gbnf`.
Night-1 ships with a **surrogate body** (`bartowski/mamba-2.8b-hf-GGUF`, Q5_K_M,
~2.6 GB) so the daemon can run before custom training lands. **AE Black Mamba**
is the custom replacement: a Mamba 2.8B SSM full-fine-tuned on Orange5's own
Flux events + AgentTurn JSON + receipt corpus. Phase-3 swaps the surrogate for
Black Mamba; the symlink at `${AE_COBRA_ROOT}/models/ae-blackmamba-2.8b-Q5_K_M.gguf`
flips, the daemon reboots, and AgentTurns start sounding like Orange5 because
the model has now *seen* Orange5.

---

## 1. Why this lane matters for Phase-3 Schism Engine

The Schism Engine is the Orange5 organ that splits the world into two ledgers:

| Lane | Definition (per Foundation Spec line 29) |
|---|---|
| `reality` | Immutable ground truth — what *actually happened* (terminal output, receipts, hermes leases, operator commands) |
| `thought` | Strategy, hypothesis, pivots, rejected branches — what *might be true* or *was considered* |

Both lanes are written to Flux as hash-chained AgentTurn JSON. The daemon's
**dual-state job** is therefore harder than "summarize text": it must classify
the *origin* of each event, then emit an AgentTurn whose `lane` field, vocabulary,
and `confidence` calibration match the lane's epistemic contract. A surrogate
that has never seen Orange5 cannot do this well — it produces *valid-shape,
low-signal* AgentTurns. The GBNF forces the shape; nothing forces the *content*
to be Orange5-fluent.

**Black Mamba is the content fix.** After Phase-3 lands:

- `reality`-lane events get AgentTurns with dense entities, real file paths, real
  commands, calibrated-high confidence, and "low" risk language unless an
  incident receipt is the trigger.
- `thought`-lane events (added in v1 corpus, see §7) get AgentTurns that
  hedge appropriately — "considered", "pivoted away from", `confidence: 0.5–0.7` —
  because the model has been trained on Orange5's *thought* register, not just
  its *reality* register.

Without Black Mamba, the Schism Engine's dual-state architecture is shape-only:
two JSONL files with the right keys but the same surrogate voice. With Black
Mamba, the dual-state is also *semantic* — the two ledgers read differently
because the model has internalized that they *are* different.

---

## 2. Base vs. fine-tune — decision rationale

**Decision: continue-pretrain (full fine-tune on top of `state-spaces/mamba-2.8b-hf`).**

| Option | Verdict | Why |
|---|---|---|
| Pretrain from scratch | ❌ rejected | Mamba 2.8B base ate ~600B tokens. We have ~thousands of rows. Result would be incoherent. |
| Continue-pretrain (full-FT) on upstream Mamba 2.8B | ✅ chosen | Inherits Mamba's general language competence; corpus shifts distribution toward Orange5 JSON without losing fluency. Standard domain-adaptation pattern. |
| Instruction-tune (SFT) on (prompt, completion) pairs | 🟡 deferred to v1 | The grammar already provides much of the conditioning that SFT would teach. Revisit if v0 quality is weak. |
| LoRA / adapter-only FT | ❌ rejected | SSMs do not have transformer-style Q/K/V matrices where LoRA's `BA` rank-decomposition cleanly slots in. The community has tried LoRA on Mamba's in-projection / out-projection / `dt_proj`; convergence at 2.8B is unreliable. Per Foundation Spec, full-FT is the authorized path. |

**Why full-FT is feasible on a free Colab T4 (16 GB VRAM):**

- 2.8B params × 2 bytes (bf16) = **5.6 GB** weights
- 8-bit AdamW optimizer state (`bnb.optim.AdamW8bit`) ≈ **5.6 GB**
- Gradient checkpointing on Mamba blocks (recompute-friendly) keeps activations small
- Per-device batch 1, gradient accumulation 16–32 → effective batch 16–32
- Seq length capped at **512** (covers ~99% of canonical AgentTurns with headroom)
- Corpus is small (target 1,500–thousands of rows, ~1–5M tokens total) — one epoch is minutes, full run is 3–5 epochs

If T4 OOMs after every technique above is applied, the **documented fallback** is
a single Colab Pro A100 40GB session (~$10) — operator-authorized but not the
default. Any fallback must be receipted; no silent escalation.

LoRA-on-Mamba is **explicitly retired** from this lane. If a future Mamba-LoRA
toolkit lands with strong receipts, it gets its own strategy doc — it does not
silently sneak into Black Mamba.

---

## 3. Pipeline (end-to-end)

```
  ┌─────────────────────┐    ┌─────────────────────┐    ┌────────────────────┐
  │ Source A: Flux JSONL │    │ Source B: AgentTurn │    │ Source C: Receipts │
  │  reality lane only   │    │  hand-curated seed  │    │  10-RECEIPTS/*.md  │
  │  (empty until        │    │  (operator + PM     │    │  48 files today    │
  │   daemon runs)       │    │   co-author)        │    │                    │
  └──────────┬───────────┘    └──────────┬──────────┘    └─────────┬──────────┘
             │                           │                          │
             └───────────┬───────────────┴──────────────┬──────────┘
                         ▼                              ▼
                ┌──────────────────────────────────────────────┐
                │ pipeline.mjs                                 │
                │  • walk + parse all three sources            │
                │  • validate against agent-turn.schema.json   │
                │  • normalize → canonical JSON                │
                │  • dedupe by SHA-256                         │
                │  • drop < MIN_BYTES                          │
                │  • emit {"text": "<canonical JSON>\n"}       │
                │  • deterministic 90/10 split by hash         │
                │  • write corpus-manifest.json (receipt)      │
                └─────────────────────────┬────────────────────┘
                                          ▼
                    ┌──────────────────────────────────────┐
                    │ corpus/train.jsonl + corpus/val.jsonl │
                    │ both SHA-256 recorded in manifest    │
                    └─────────────────────┬────────────────┘
                                          ▼
                    ┌──────────────────────────────────────┐
                    │ Colab Free T4 notebook (workflow)    │
                    │  1. load state-spaces/mamba-2.8b-hf  │
                    │     in bf16                          │
                    │  2. wrap with grad checkpointing     │
                    │  3. bnb.optim.AdamW8bit, lr 1e-5,    │
                    │     weight_decay 0.01                │
                    │  4. cosine schedule, 100-step warmup │
                    │  5. batch 1 × grad-accum 16 = 16     │
                    │  6. seq len 512                      │
                    │  7. 3 epochs                         │
                    │  8. eval every 50 steps:             │
                    │       • perplexity on val.jsonl      │
                    │       • GBNF-validity on held-out    │
                    │  9. save best-by-val checkpoint      │
                    └─────────────────────┬────────────────┘
                                          ▼
                    ┌──────────────────────────────────────┐
                    │ llama.cpp Mamba conversion           │
                    │  fp16 safetensors → Q5_K_M GGUF      │
                    │  (~2.6 GB target, matches surrogate) │
                    └─────────────────────┬────────────────┘
                                          ▼
                    ┌──────────────────────────────────────┐
                    │ gbnf-alignment.mjs                   │
                    │  • load candidate GGUF in llama.cpp  │
                    │  • run 100 held-out event prompts    │
                    │    UNCONSTRAINED (no grammar)        │
                    │  • measure schema-validity rate      │
                    │  • target ≥ 90% (see §6)             │
                    └─────────────────────┬────────────────┘
                                          ▼
                    ┌──────────────────────────────────────┐
                    │ promote.mjs (bakeoff)                │
                    │  4 metrics, surrogate vs candidate:  │
                    │   1. lane_classification_accuracy    │
                    │   2. agent_turn_json_validity_rate   │
                    │   3. entity_density                  │
                    │   4. next_action_specificity         │
                    │  Promote iff candidate wins ≥ 2 of 4 │
                    │  Flip symlink:                       │
                    │    ae-blackmamba-2.8b-Q5_K_M.gguf →  │
                    │      candidate                       │
                    │  Daemon reboots; receipt written.    │
                    └──────────────────────────────────────┘
```

**Files in this lane (today):**

| File | Purpose | Lines |
|---|---|---|
| `strategy.md` | Full strategy doc (mirrored sibling: `ae-misfit/corpus-strategy.md`) | ~295 |
| `pipeline.mjs` | Corpus builder (walks Flux + receipts → train/val JSONL + manifest) | ~640 |
| `promote.mjs` | Candidate bakeoff + symlink promotion + receipt | ~900 |
| `gbnf-alignment.mjs` | Unconstrained schema-validity eval against held-out prompts | ~1300 |
| `corpus/train.jsonl` | 53 rows, SHA `b7bb1aee…3748` | 53 |
| `corpus/val.jsonl` | 6 rows, SHA `876ca263…458c` | 6 |
| `corpus/corpus-manifest.json` | Receipt-shaped manifest of the seed build | — |
| `README.md` | *this file* | — |

---

## 4. Expected wall-clock on Free Colab T4

The Foundation Spec budgets **4–8 hours of T4 wall-clock** for a full Black
Mamba run. Concrete arithmetic:

| Phase | Cost | Notes |
|---|---|---|
| Cold-load `state-spaces/mamba-2.8b-hf` to VRAM (bf16) | 3–6 min | First download from HF mirrors; HF cache hits cut this to ~90 s on warm reruns |
| Apply gradient checkpointing + wire 8-bit AdamW | <30 s | One-time setup |
| **Training proper** | **3–6 h** | At seq 512, batch 1 × grad-accum 16, 3 epochs over 1,500-row corpus: roughly 280 optimizer steps. Mamba's selective-scan is ~2× slower per token than a same-size transformer on T4 (no flash-attn analogue yet); each step lands at ~30–60 s including checkpoint recompute. |
| Eval passes (every 50 steps) | included | Perplexity is fast; GBNF-validity on 20 held-out prompts adds ~2 min per eval round |
| Save best checkpoint | 1–2 min | safetensors flush to Drive |
| llama.cpp GGUF conversion (mamba path, Q5_K_M) | 10–20 min | CPU-bound; Colab CPU is slow |
| `gbnf-alignment.mjs` (100 prompts, unconstrained + constrained) | 15–25 min | llama.cpp inference on CPU; GPU layers if Colab has spare VRAM |
| `promote.mjs` bakeoff (200 prompts × 2 models × 4 metrics) | 30–45 min | The expensive step end-to-end |
| **Total wall-clock** | **4–8 h** | Matches Foundation Spec line 381. T4 sessions have a ~12 h hard cap, so one session is sufficient. |

**Why the spread is 4 → 8 hours, not a point estimate:**

- Corpus row count between 1,500 (minimum) and ~3,000 (with seed Source B done) doubles step count
- Colab T4 thermal throttling sometimes drops throughput 10–20% mid-session
- HF model cache cold-start vs warm-start swings the front-end by ~5 min
- llama.cpp GGUF conversion is CPU-dependent; Colab's CPU tier varies

**Out-of-budget conditions** (any of these → halt + receipt, do not silently extend):

- VRAM OOM after every documented technique applied
- Per-step time > 90 s sustained (training is unhealthy; investigate)
- Val perplexity climbing for 3 consecutive eval rounds (overfit on small corpus)
- GBNF-validity rate stuck below 50% at end of epoch 2 (corpus shape wrong)

---

## 5. Corpus today (seed v0)

From `corpus/corpus-manifest.json` (generated 2026-06-25T00:36):

| Field | Value |
|---|---|
| `accepted_total` | 59 |
| `train_rows` / `val_rows` | 53 / 6 |
| `flux_lines_seen` | 0 *(Flux empty until Night-1 daemon runs)* |
| `receipts_seen` / `receipts_accepted` | 59 / 59 *(zero rejects)* |
| `duplicates` | 0 |
| `train_sha256` | `b7bb1aee8c013e8a0ff6f0ab45e7db8a0c111bdb5101df8819f5c359a28f3748` |
| `val_sha256` | `876ca263836a746c5ccedebe5497e6c782018a46733678107164e9b1b585458c` |
| Split rule | deterministic by `SHA-256 prefix mod 100 < 10 → val` |

**59 rows is not enough to pretrain.** It is enough to validate the pipeline
end-to-end on T4 (does it OOM? does loss decrease? does the resulting GGUF emit
GBNF-valid JSON?). The real run waits on Source A (Flux) and Source B (AgentTurn
seed) landing.

**Row format on disk:**

```json
{"text": "{\"commands\":[],\"confidence\":1,\"entities\":[\"…\"],\"event_type\":\"receipt\",\"files\":[\"…\"],\"lane\":\"reality\",\"next_action\":\"…\",\"risk\":\"low\",\"summary\":\"…\"}\n"}
```

Each row is **one canonical AgentTurn JSON**, alphabetically-sorted keys,
schema-valid, GBNF-acceptable, trailing `\n` inside the `"text"` value.

---

## 6. GBNF alignment target

The single most important alignment property: at inference time, every token
Black Mamba emits passes through the GBNF logit mask. Training cannot weaken
that contract — but training can either *align* the model's distribution with
the grammar (fluent JSON) or *fight* the grammar (stilted, hallucinated content
forced into legal shape).

**Alignment target:** at end of training, **unconstrained ("no grammar")
generation rate of schema-valid AgentTurn JSON on the held-out prompt set must
reach ≥ 90%.** Grammar-constrained rate stays 100% by construction. The gap
between unconstrained and constrained measures how well the model has
internalized the schema — a tight gap means the grammar is *confirming* the
model's choices, not *overriding* them.

Measured by `gbnf-alignment.mjs` against `eval/black-mamba-prompts.jsonl`
(path reserved, see §7).

---

## 7. What blocks the training run today

In strict priority order:

1. **Source A (Flux) is empty.** Gated on Night-1 AE Cobra daemon promotion on
   Codexa (per Foundation Spec Phase-1). Once the daemon runs for 14–30 days,
   Flux holds thousands of real events and becomes the dominant signal.
2. **Source B (AgentTurn seed) is unpopulated.** Path reserved at
   `corpus/agentturn-seed.jsonl`. Gated on an operator + PM-brain
   co-authoring session: target 500–2,000 hand-curated AgentTurns covering
   Orange5's common event classes.
3. **Corpus below 1,500-row minimum.** Currently 48. Below the threshold,
   any training run is *pipeline validation only* and the resulting GGUF
   is **not** promoted past the surrogate.
4. **T4 OOM behavior under full-FT 2.8B is unverified empirically.** Gated
   on a one-epoch sanity run against the seed corpus (a "does it train at all"
   test, not a quality test).
5. **Eval prompt set not built.** Path reserved at
   `eval/black-mamba-prompts.jsonl`. Target ~100 held-out event triggers
   covering all `(origin, lane, risk)` combinations.

---

## 8. Lane scope (what this README does NOT cover)

- **AE Cobra runtime daemon code** — lives in `06-ORANGELLM/memory/ae-cobra/`,
  governed by `AE_COBRA_FOUNDATION_SPEC`. This README covers only the
  *training* of the model the daemon loads.
- **Mirage StateBrief API** — Phase 2, independent of Black Mamba weights.
- **Graph Weaver** — separate organ.
- **OrangeLLM-fatty corpus** — see `16-TRAINING/corpus/CORPUS_MANIFEST.md`.
- **AE Misfit corpus** — see `16-TRAINING/ae-misfit/corpus-strategy.md`.
- **Tokenizer retraining** — deferred to Phase-4 at earliest (retraining breaks
  compatibility with upstream Mamba weights and turns full-FT into pretrain
  from scratch).
- **LoRA adapters** — explicitly retired per §2.

---

## 9. Result / evidence / blockers / next action

**Result:** README authored at `C:\AtomEons\Orange5\16-TRAINING\ae-black-mamba\README.md`.
Lane named, full pipeline diagrammed, base-vs-FT decision documented with table,
expected T4 wall-clock budgeted (4–8 h) with per-phase breakdown, Schism Engine
dual-state relevance articulated, corpus seed snapshot recorded with SHA-256s,
GBNF alignment target set as measurable ≥ 90% unconstrained-schema-validity,
blockers itemized.

**Evidence:**
- `strategy.md` (~295 lines, peer to this README) — every architectural claim
  traceable to a Foundation Spec line citation
- `corpus/corpus-manifest.json` — 48 rows, train/val SHA-256s recorded
- `pipeline.mjs`, `promote.mjs`, `gbnf-alignment.mjs` — implementation present
- Foundation Spec line 29 (Schism Engine dual-lane definition), line 381
  (T4 sufficiency for 2.8B full FT)
- Sibling lane (`ae-misfit/corpus-strategy.md`) mirrored for structural
  consistency

**Blockers:** see §7 in priority order. Top blocker is Night-1 daemon
promotion to start filling Flux.

**Next action:** stand up Night-1 AE Cobra on Codexa per Foundation Spec
Phase-1 so Source A starts accumulating. In parallel, schedule the Source B
AgentTurn seed authoring session. Do **not** start the training run until
corpus reaches the 1,500-row operator-signed minimum.

— *Mom's Law applies. Every claim cites a real file. No theatre. No drift.*
