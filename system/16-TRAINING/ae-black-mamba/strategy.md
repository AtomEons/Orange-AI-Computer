# AE Black Mamba — Training Strategy

**Schema:** `orange5.ae-black-mamba.training-strategy.v0`
**Sovereign:** Atom McCree
**Doctrine source:** `06-ORANGELLM/memory/AE_COBRA_FOUNDATION_SPEC.md` (Pillar 1, §Phase-3); `06-ORANGELLM/memory/ae-cobra/README.md`; `06-ORANGELLM/memory/ae-cobra/grammar/agent_turn.gbnf`; `06-ORANGELLM/memory/ae-cobra/schemas/agent-turn.schema.json`; sibling lane reference `16-TRAINING/ae-misfit/corpus-strategy.md`.
**Status:** STRATEGY — corpus seed is alive (48 rows, see §3.4), training run not started. This doc defines what gets trained, on what, and why.
**Receipt anchor:** Foundation Spec line 381 — *"AE Black Mamba custom pretraining (Phase-3 in Pillar 1) remains on the roadmap — it eventually replaces the Night-1 Mamba surrogate. Trained via Workflow → Colab Free T4. Separate from OrangeLLM-fatty training."*

---

## 1. Why AE Black Mamba exists (and why it is not OrangeLLM-fatty, AE Misfit, or the surrogate)

AE Cobra is the resident KV-less memory daemon on Codexa. Its job is to take a raw event from `terminal | hermes | orangellm | operator` and emit *exactly one* JSON object conforming to `agent-turn.schema.json`, locked at the logit layer by `agent_turn.gbnf`. No prose. No markdown. No roleplay. One object, nine required keys, hash-chained into Flux.

The Night-1 spine ships with a **surrogate model**: `bartowski/mamba-2.8b-hf-GGUF` (Q5_K_M, ~2.6 GB), symlinked to the internal name `ae-blackmamba-2.8b-Q5_K_M.gguf`. Surrogate works — GBNF will force valid JSON out of any base — but the surrogate has zero knowledge of Orange5's vocabulary, lane semantics, file path conventions, receipt cadence, or risk-class language. It produces *valid-shape, low-signal* AgentTurns. Good enough for plumbing, not good enough for memory the PM brain actually trusts.

**AE Black Mamba is the in-house replacement.** A custom 2.8B Mamba SSM full-FT pretrained on Orange5's own Flux event corpus, AgentTurn JSON corpus, and receipt corpus. After this trains, Phase-3 ships the new GGUF, the symlink flips, and the same daemon now emits AgentTurns that *sound like Orange5* because it has seen Orange5 — every receipt, every flux event, every lane handoff.

How AE Black Mamba differs from the other Orange5 training lanes:

| Lane | Base | Method | Corpus | Role |
|---|---|---|---|---|
| OrangeLLM-fatty | `qwen3:30b-a3b` | LoRA | Doctrine, schemas, topology, charter | PM brain (routes work, signs off Hermes leases) |
| AE Misfit | `qwen2.5:7b-instruct` | LoRA | STRONGARM + Gremlin adversarial | Second-opinion refusal gate (high-risk only) |
| AE Black Mamba (this doc) | `state-spaces/mamba-2.8b-hf` | **full-FT** | Flux events + AgentTurn JSON + receipts | Resident memory daemon (logit-locked JSON emitter) |
| Night-1 surrogate | `bartowski/mamba-2.8b-hf-GGUF` | none (stock) | n/a | Placeholder until Black Mamba lands |

Three brains, three corpora, three training methods, one chain of trust. Black Mamba does not route work and does not gate Hermes — it *remembers* and it *summarizes events into Orange5-native AgentTurn JSON*. That is the entire job.

---

## 2. Why **full fine-tune**, not LoRA

State Space Models do not have transformer-style attention. Mamba's selective-scan SSM uses input-dependent (B, C, Δ) projections inside the recurrent block; there is no Q/K/V matrix where a LoRA `BA` rank-decomposition cleanly slots in. The community has experimented with LoRA-on-Mamba targeting the in-projection / out-projection linear layers and `dt_proj`, but the consensus on 2.8B-scale SSMs is that the lift is small, the tooling is rough, and the convergence is unreliable compared to either (a) full FT or (b) `(IA)^3`-style scalar gating. Per `AE_COBRA_FOUNDATION_SPEC` Pillar 1, the operator-authorized path is **full fine-tune**.

Full-FT at 2.8B on free Colab T4 is feasible because:

- **Model size:** 2.8B params × 2 bytes (bf16/fp16) = 5.6 GB weights. Plus optimizer state (AdamW = 2× weights for momentum/variance in fp32 = ~22 GB if naive). With **8-bit AdamW** (`bitsandbytes`) optimizer state drops to ~5.6 GB. Plus activations + gradients. T4 has 16 GB VRAM. Tight but feasible with:
  - `bf16` mixed precision (T4 supports it via PyTorch autocast — slower than fp16 but more numerically stable for SSMs)
  - gradient checkpointing (Mamba blocks are recompute-friendly)
  - `bnb.optim.AdamW8bit`
  - per-device batch size 1, gradient accumulation 16–32 → effective batch 16–32
  - sequence length capped at the median AgentTurn JSON length (~300 tokens; cap at 512 for headroom)
- **Corpus size:** small (~thousands of rows after curation, see §3). Each row is one canonical AgentTurn JSON ≤ ~500 tokens. Total corpus tokens ~1–5M. A single epoch is minutes on T4; full run target is 3–5 epochs.
- **Goal:** the model does not need to learn general language. It needs to learn *Orange5's JSON dialect*. Domain adaptation on a constrained output schema converges fast.

Per Foundation Spec, **T4 sufficient for 2.8B full FT** when the above techniques are applied. If T4 OOMs after gradient checkpointing + 8-bit optimizer, the documented fallback is Colab Pro A100 40GB (one session), which removes all VRAM pressure for ~$10. That fallback is operator-authorized but is **not** the default path.

LoRA-on-Mamba is **explicitly retired** from this lane. If a future Mamba LoRA toolkit lands with strong receipts, it gets evaluated under a separate strategy doc; it does not silently sneak into Black Mamba.

---

## 3. Sources

Three source families, all already produced by the running Orange5 system. No external scraping, no synthetic generation, no third-party datasets. Black Mamba learns from what Orange5 has already lived through.

### 3.1 Flux events JSONL — *Source A: the daemon's own past output*

**Location:** `/mnt/ae_flux/events/{reality|thought}/<YYYY-MM-DD>.jsonl` on Codexa (WSL2). Mirror under `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flux\events\` on the dev host when cross-host rsync is run.

**Format:** one hash-chained AgentTurn JSON per line (see `flux/writer.mjs`). Each line is already schema-valid by construction (GBNF-locked at emit time, then schema-revalidated at parse time before chain-append). Every line carries `prev_hash`, `hash`, `ts`, `lane`, plus the AgentTurn payload.

**Why this is gold:** these are the AgentTurns the *surrogate* produced while running under GBNF lock. The GBNF guarantees shape; the surrogate's content is weak but the events it was reacting to are real Orange5 events. We strip the surrogate's text and **regenerate the AgentTurn body** for the corpus from the source event + a curated reference AgentTurn written by the operator or Claude/PM-brain (see §4). The Flux JSONL gives us the *event triggers* (origin, raw event text, timestamp, lane assignment) but not the *target AgentTurn* — that target is rewritten by hand or by the PM brain to be the AgentTurn we *wish* the surrogate had produced.

**Lanes included:** `reality` only for Phase-3 v0. `thought` lane is excluded from the first training run because thought-lane records include hypotheses and rejected branches; training on those without careful labeling could teach Black Mamba to confabulate. Thought lane is added in a v1 corpus after the v0 daemon is online and trustworthy.

**Schema enforcement on ingest:** every Flux line passes `agent-turn.schema.json` validation. Lines that fail are dropped, not repaired. Reject reason logged to manifest.

**Today's count:** the seed corpus manifest at `corpus/corpus-manifest.json` shows `flux_lines_seen: 0` — Flux is empty because the daemon has not run a real cohort yet. The seed corpus is **48 receipt-derived rows** (see §3.3). Once AE Cobra Night-1 is live on Codexa for ~30 days, Flux will hold thousands of real events and become the dominant source.

### 3.2 AgentTurn corpus — *Source B: the canonical target shape*

**Location:** hand-curated + PM-brain-generated AgentTurn JSON objects, one per file or one per JSONL line, staged at `C:\AtomEons\Orange5\16-TRAINING\ae-black-mamba\corpus\agentturn-seed.jsonl` (path reserved; not yet populated as of strategy authoring).

**Why a separate hand-curated set exists:** the GBNF + JSON schema define the *legal grammar* of an AgentTurn. They do not teach the model what a *good* AgentTurn looks like for any given input. Consider two legal AgentTurns for the same event "operator ran `bun smoke-test.mjs` and got `green: all 5 events appended`":

```json
{
  "lane": "reality",
  "event_type": "checkpoint",
  "summary": "smoke test passed",
  "entities": [], "files": [], "commands": [],
  "risk": "low",
  "next_action": "continue",
  "confidence": 0.9
}
```

versus

```json
{
  "lane": "reality",
  "event_type": "checkpoint",
  "summary": "AE Cobra smoke-test green; 5 events appended to reality flux 2026-06-25; chain integrity verified",
  "entities": ["AE Cobra", "smoke-test.mjs", "reality lane"],
  "files": ["bin/smoke-test.mjs", "/mnt/ae_flux/events/reality/2026-06-25.jsonl"],
  "commands": ["bun smoke-test.mjs"],
  "risk": "low",
  "next_action": "promote AE Cobra to Phase-2 (Mirage StateBrief integration)",
  "confidence": 0.95
}
```

Both are schema-valid. Only the second is *Orange5-fluent*. The AgentTurn corpus teaches Black Mamba the second shape: dense entities, real file paths, real commands, specific next_actions, calibrated confidence.

**Generation strategy for §3.2:** operator + Claude/PM-brain co-author target AgentTurns for ~500-2000 representative event triggers (one per common Orange5 event class). Each row pairs *(event_trigger_text, lane_origin) → (canonical AgentTurn JSON)*. Two-column shape, but stored on disk as a single text row containing the rendered prompt + the JSON target — see §4 for the exact row format.

**Status as of authoring:** not yet populated. Authoring the AgentTurn seed corpus is a separate downstream task, gated on the Night-1 daemon producing surrogate AgentTurns we can rewrite.

### 3.3 Receipt markdowns — *Source C: the audit trail, already canonical*

**Location:** `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\<YYYY-MM-DD>-<slug>.md` (48 files as of 2026-06-25). Each receipt is a Markdown audit of one promotion / one ship / one waiver / one PR landing.

**Why receipts are the strongest signal today:** receipts are the only Source family that already exists at meaningful volume. They are written by humans (operator, Claude PM voice) under Mom's Law. They are dense, terse, real, and already encode Orange5's vocabulary for entities, files, commands, risk, and next_action.

**Receipt → AgentTurn transform** (already implemented by the corpus builder that produced the 48-row seed):

| Receipt field | AgentTurn key | Transform |
|---|---|---|
| File path | `files[0]` | basename only, schema-trimmed to 240 chars |
| Title/H1 + author line | `entities` | extracted, max 20 strings |
| `## Status` block or first emphatic line | `summary` | wrapped in backticks per receipt cadence, ≤ 240 chars |
| Action verbs in body (`ran`, `staged`, `merged`) | `commands` | inferred where present, empty list otherwise |
| Receipt classification | `event_type` | currently all `"receipt"` (Phase-3 v0); v1 corpus splits into `decision` / `checkpoint` / `receipt` |
| `lane` | `lane` | hard-coded `"reality"` for receipts (receipts are by definition ground truth) |
| Risk language in body | `risk` | heuristic mapping: "rolled back", "incident" → high; "deferred", "waiver" → medium; default → low |
| `## Next` block or last actionable line | `next_action` | trimmed to 240 chars |
| Receipt confidence is implicit (a receipt is a commitment) | `confidence` | default 0.95; explicit 1.0 for receipts marked "GREEN" or "LANDED" |

The receipt-derived rows are *exactly* the shape Black Mamba needs to learn, because each one is a real Orange5 event (a ship / a waiver / a promotion) mapped to a canonical AgentTurn JSON. **This is the dominant signal in the v0 corpus and the foundation everything else builds on.**

### 3.4 Current corpus snapshot (seed v0)

From `corpus/corpus-manifest.json` (generated 2026-06-25T00:36, after grammar-alignment fix — see `10-RECEIPTS/orange5-build/2026-06-26-black-mamba-corpus-grammar-aligned.md`):

| Field | Value |
|---|---|
| `accepted_total` | 59 |
| `train_rows` | 53 |
| `val_rows` | 6 |
| `flux_lines_seen` | 0 *(Flux empty until Night-1 daemon runs)* |
| `receipts_seen` | 59 |
| `receipts_accepted` | 59 *(zero rejects — every receipt mapped cleanly)* |
| `duplicates` | 0 |
| `train_sha256` | `b7bb1aee8c013e8a0ff6f0ab45e7db8a0c111bdb5101df8819f5c359a28f3748` |
| `val_sha256` | `876ca263836a746c5ccedebe5497e6c782018a46733678107164e9b1b585458c` |
| `grammar_acceptance` | 59/59 = 100% (`corpus/grammar-alignment/corpus-alignment.json`) |
| `split rule` | deterministic by `SHA-256 prefix mod 100 < 10 → val` |

59 rows is **not enough to pretrain a 2.8B SSM** — it is enough to validate the pipeline end-to-end on T4 (does it OOM? does loss decrease? does the resulting GGUF emit GBNF-valid JSON?). The real run waits on §6 corpus growth.

---

## 4. Corpus shaping — *one AgentTurn JSON per row*

**Doctrine:** the operator directive at the top of this strategy reads — *"each row = one AgentTurn JSON."* That is the law.

**Physical row format on disk** (one JSONL line per row, already implemented in the v0 builder):

```json
{"text": "{\"lane\":\"reality\",\"event_type\":\"receipt\",\"summary\":\"`WAVE_1_AND_WAVE_2_BOTH_GREEN`\",\"entities\":[\"2026-06-25-wave-2-master-summary.md\"],\"files\":[\"2026-06-25-wave-2-master-summary.md\"],\"commands\":[],\"risk\":\"low\",\"next_action\":\"await operator review\",\"confidence\":1.0}\n"}
```

Three layers, deliberately:

1. **Outer JSONL row** — `{"text": "..."}` — standard HuggingFace `datasets` text field. Trainer reads `text`. Nothing else.
2. **Inner text payload** — a single AgentTurn JSON object, terminated by `\n`. Keys are emitted in `agent_turn.gbnf` **root-rule order** (`lane, event_type, summary, entities, files, commands, risk, next_action, confidence`) so the token sequence the model learns matches the sequence the GBNF mask forces at inference. A *separate* alphabetically-canonical form is computed for the SHA-256 dedupe key (matches `ae-cobra/flux/writer.mjs` hash convention) so reruns on unchanged input still produce a bit-identical dedupe key set. Alphabetical-sorted JSON ≠ grammar-ordered JSON — conflating the two is the drift `10-RECEIPTS/orange5-build/2026-06-26-black-mamba-corpus-grammar-aligned.md` resolves.
3. **Inner JSON object** — schema-valid against `agent-turn.schema.json`, all nine required keys present, all enums respected.

**Why this shape and not (prompt, completion) pairs:**

- Black Mamba's *runtime* contract is: llama.cpp `/completion` is called with the event-text prompt, GBNF-locked, and emits an AgentTurn JSON. The grammar starts the model in JSON mode immediately — there is no "prompt" to learn-to-condition-on at the text-level. The grammar handles the conditioning.
- Therefore the training target is the *AgentTurn distribution itself*, not (event → AgentTurn) pairs. We are pretraining the model to make Orange5-shaped AgentTurns *likely* under the grammar, so when the grammar plus a real prompt selects from the model's distribution at runtime, the output is high-quality.
- This is **causal LM pretraining on a constrained-shape corpus**, not instruction tuning. Loss = cross-entropy over every token in the AgentTurn JSON. The model learns the joint distribution of Orange5 entities × lanes × event types × risk × next-action language.

**Phase-3 v1 may extend** the row to include a leading event-trigger prefix (origin + raw event text + `\n` + AgentTurn JSON) to teach event-conditional generation. Phase-3 v0 stays single-target — bare AgentTurns only — because (a) the corpus is small, (b) the grammar already constrains shape so conditioning is partly handled by GBNF, and (c) keeping v0 minimal makes the OOM/convergence debug loop tight.

**Serialization rules** (enforced by the builder):

- **Training text:** keys in `agent_turn.gbnf` root-rule order (`lane, event_type, summary, entities, files, commands, risk, next_action, confidence`).
- **Dedupe SHA-256:** keys sorted alphabetically (separate canonical form, internal accounting only — same convention as `ae-cobra/flux/writer.mjs`).
- No trailing whitespace inside the JSON
- No comments
- `confidence` snapped to GBNF lexical form: `0.0`, `1.0`, or `0.XX` (two decimals). Raw `1`, `0.8`, `0.875` all fail the grammar. Snap is `Math.round(v*100)/100` with the 0 and 1 edges dispatched to the exact single-digit forms.
- Arrays are bracketed even when empty (`"entities":[]`)
- Single trailing `\n` outside the closing `}` — kept inside the `"text"` value, terminates the row
- UTF-8, no BOM

**Tokenizer:** the Mamba 2.8B tokenizer is GPT-NeoX-style (~50k vocab). It is not optimized for JSON — `{` `}` `"` are single tokens but key strings like `"event_type"` may split into 3–5 tokens. This is acceptable; we do not retrain the tokenizer in Phase-3 v0 (retraining the tokenizer breaks compatibility with the upstream Mamba weights and turns full-FT into pretrain-from-scratch). Tokenizer optimization is a Phase-4 question.

---

## 5. Pretrain vs FT — the decision

**Decision: continue-pretrain (i.e., full fine-tune on top of `state-spaces/mamba-2.8b-hf` weights), not pretrain-from-scratch.**

Reasoning:

| Option | Verdict | Why |
|---|---|---|
| Pretrain from scratch | ❌ rejected | 2.8B from scratch on T4 with thousands of rows is undertrained-by-orders-of-magnitude. Result would be incoherent. Mamba 2.8B base was pretrained on ~600B tokens; we cannot replicate even 0.001% of that. |
| Continue-pretrain (full-FT) on upstream Mamba 2.8B | ✅ chosen | Inherits Mamba's general language competence. Our corpus shifts the model's distribution toward Orange5 JSON without losing the base's ability to *generate at all*. Standard domain-adaptation pattern. |
| Instruction-tune (SFT) on (prompt, completion) pairs | 🟡 deferred | Reasonable in principle but premature without (a) the AgentTurn seed corpus from §3.2, (b) a clear instruction template. The grammar already provides much of the conditioning instruction tuning would teach. Revisit in Phase-3 v1 if v0 AgentTurn quality is weak. |
| LoRA / adapter-only FT | ❌ rejected | Per §2 and Foundation Spec: SSMs do not have clean LoRA mechanics at this scale. |

**Operationally** the run looks like:

```
1. Load state-spaces/mamba-2.8b-hf in bf16
2. Wrap with gradient checkpointing
3. Optimizer: bnb.optim.AdamW8bit, lr 1e-5 (low — domain shift, not pretrain), weight_decay 0.01
4. Scheduler: cosine with 100-step warmup
5. Per-device batch 1, grad accum 16 → effective batch 16
6. Seq len 512 (covers ~99% of canonical AgentTurns with headroom)
7. Train 3 epochs over current corpus
8. Eval every 50 steps on val.jsonl (perplexity + GBNF-validity rate on a held-out prompt set)
9. Save best-by-val checkpoint
10. Convert to GGUF Q5_K_M via llama.cpp's mamba conversion path
11. Sanity test: load GGUF in llama.cpp with agent_turn.gbnf, fire 100 events from the held-out prompt set, measure (a) JSON validity (must be 100% under grammar), (b) AgentTurn schema validity post-grammar (target ≥ 99%), (c) human-rated quality vs surrogate (target: ≥ 75% of paired comparisons preferred over surrogate)
```

**Failure handoff:** if T4 OOMs even with all techniques applied, halt and write a receipt naming the OOM mode + the smallest known config that failed. Do not silently switch to A100 — that is an operator-authorized escalation, not a default fallback.

---

## 6. GBNF grammar alignment target

The **single most important alignment property** of this training run: at inference time, every token Black Mamba emits will pass through the GBNF logit mask defined by `agent_turn.gbnf`. Training cannot weaken that contract — but training *can* either:

(a) **align** the model's natural distribution with the grammar's legal next-tokens, so the grammar mask rarely zero-out the model's top choices, producing fluent JSON; or

(b) **fight** the grammar, where the model's distribution wants prose / different keys / different enums and the grammar repeatedly forces low-probability tokens — producing technically-valid but stilted, hallucinated-content AgentTurns.

The corpus is designed for outcome (a). Every training row is itself a token sequence that the grammar would accept end-to-end. Training on these rows pulls the model's distribution toward the grammar's manifold. This is the **GBNF grammar alignment target**:

> **Alignment target:** at the end of training, the unconstrained ("no grammar") generation rate of schema-valid AgentTurn JSON on the held-out prompt set must reach ≥ 90%. The grammar-constrained rate stays 100% by construction. The gap between unconstrained and constrained is the measure of how well the model has internalized the schema — a tight gap means the grammar mask is *confirming* the model's choices, not *overriding* them.

Concretely the grammar's hard constraints — already locked at the logit layer regardless of training — are:

| Grammar rule | What it forces |
|---|---|
| `root ::= "{" ws "\"lane\":" ws lane ...` | First token after `{` must be the `"lane"` key. Then enum value. Then `,`. Then `"event_type"`. Etc. Key order is fixed. |
| `lane ::= "\"reality\"" \| "\"thought\"" \| "\"merge\""` | Only three legal values. |
| `event_type ::= "\"observation\"" \| "\"decision\"" \| ...` | Seven legal values. |
| `risk ::= "\"low\"" \| "\"medium\"" \| "\"high\""` | Three legal values. |
| `confidence ::= "0." digit digit \| "1.0" \| "0.0"` | Must be `0.XX`, `0.0`, or `1.0`. No other floats. |
| `short_string ::= "\"" short_char{0,240} "\""` | Strings capped at 240 chars. No raw newlines. |
| `string_array ::= "[" ws (short_string ...){0,20}` | Arrays of ≤ 20 strings. |

**The corpus must respect all of these.** The v0 builder already does so (zero reject_histogram entries in `corpus-manifest.json`). The strategy enforces this as a hard ingest rule: every row is canonical-JSON-serialized and re-validated against `agent-turn.schema.json` *and* against a minimal GBNF acceptor before write. Rows that fail either gate get logged to `reject_sample` in the manifest and dropped — not repaired.

A receipt is appended to `10-RECEIPTS/orange5-build/` for any future corpus rebuild that changes counts, with the new train/val SHA-256s. The chain of trust on the corpus matches the chain of trust on the rest of Orange5.

---

## 7. What this strategy does **not** cover (out of scope)

- **AE Cobra runtime daemon code** — that lives in `06-ORANGELLM/memory/ae-cobra/` and is governed by `AE_COBRA_FOUNDATION_SPEC`. This doc only governs the *training* of the model the daemon loads.
- **Mirage StateBrief API** — Phase 2 (not Phase 3). Independent of Black Mamba weights.
- **Graph Weaver / Schism Engine** — separate organs.
- **OrangeLLM-fatty corpus** — see `16-TRAINING/corpus/CORPUS_MANIFEST.md`.
- **AE Misfit corpus** — see `16-TRAINING/ae-misfit/corpus-strategy.md`.
- **Tokenizer retraining** — deferred to Phase-4 at earliest.
- **LoRA adapters** — explicitly retired for this lane (per §2). Do not reintroduce without an operator-signed strategy revision.

---

## 8. Open items for the corpus-assembly day

1. **Grow Source A (Flux)** — needs Night-1 daemon running on Codexa for 14–30 days minimum. Until then, Source C (receipts) carries the load.
2. **Generate Source B (AgentTurn seed)** — operator + PM-brain co-authoring session, target 500-2000 hand-curated AgentTurns covering Orange5's common event classes. Path reserved: `corpus/agentturn-seed.jsonl`.
3. **Decide v0 minimum row count** — current proposal: 1,500 accepted rows (receipts + AgentTurn seed; Flux additive once available). Below 1,500, training run is *pipeline validation only* and the resulting GGUF is not promoted past the surrogate.
4. **Confirm T4 vs A100 path** — first attempt is T4 per Foundation Spec. A100 fallback authorized but requires receipt.
5. **Eval prompt set** — design ~100 held-out event triggers (variety of origins, lanes, risk levels) for the inference-time quality test in §5 step 11. Path reserved: `eval/black-mamba-prompts.jsonl`.

---

## 9. Result / evidence / blockers / next action

**Result:** strategy authored at `C:\AtomEons\Orange5\16-TRAINING\ae-black-mamba\strategy.md`. Lane is named, base model is named, method (full-FT) is justified, three sources are catalogued, row format is specified, pretrain-vs-FT decision is documented, GBNF grammar alignment target is set as a measurable ≥ 90% unconstrained-schema-validity rate.

**Evidence:**
- Foundation Spec citations (lines 28, 52–54, 281, 309, 315, 348, 356, 378–382) anchor every architectural claim
- Existing seed corpus (`corpus/corpus-manifest.json`, 48 rows, SHA-256s recorded)
- Existing GBNF + JSON schema files referenced by exact path
- Sibling lane (AE Misfit) corpus-strategy structure mirrored for consistency

**Blockers:**
- Source A is empty (Flux has not run a cohort yet) — gated on Night-1 daemon promotion
- Source B is unpopulated — gated on operator + PM-brain authoring session
- Corpus is below the 1,500-row threshold (currently 48) — gated on B and A landing
- T4 OOM behavior under full-FT 2.8B unverified empirically — gated on a one-epoch sanity run

**Next action:** stand up the Night-1 AE Cobra daemon on Codexa per Foundation Spec Phase-1 so Source A (Flux) starts accumulating. In parallel, schedule the Source B AgentTurn seed authoring session. Do not start the training run until corpus reaches at least the operator-signed minimum row count.

— *Mom's Law applies to this strategy. Every claim cites a real file. No theatre. No drift.*
