# Orange5 — Colab Training Pattern

**Locked:** 2026-06-23 (D1 resolution) · **Refreshed:** 2026-06-25 (post-v0 reality + 6-hour-burn lessons)
**Sovereign:** Atom McCree
**Status:** SPEC LOCKED · ACTIVE PATTERN
**Trigger:** Every Orange5 model-training run from W3 onward uses this exact shape

---

## The decision (D1 resolution)

GPU procurement for Codexa is **deferred indefinitely**. Training runs on **Google Colab**. Heavy inference (when a query exceeds local Codexa's CPU/Vulkan budget) routes through **frontier offload via the OrangeLLM gateway** (BYO key — Opus / GPT / Gemini).

No discrete GPU purchase needed for the month plan to ship.

---

## Why this is a clean answer

| Constraint | How this honors it |
|---|---|
| Mom's Law | Real GPU compute via Colab, real receipts, no theater |
| Codeless Law (operator side) | Operator only opens a notebook + clicks Run All; doesn't write training code by hand |
| Frontier-Isolation Law | Colab is a training-only environment; never sees Orange5 internals beyond the corpus payload |
| No-new-deps (Codexa) | All training infra lives on Colab side; Codexa adds nothing |
| Cost predictability | Free → Pro ($10/mo) → Pro+ ($50/mo); operator picks based on model size |

---

## Reality of v0 (what actually shipped)

- **OrangeLLM-fatty v0** trained 2026-06-25 on Colab Pro A100
- Base: **`unsloth/Qwen2.5-32B-Instruct-bnb-4bit`** (NOT Qwen3 — Qwen3 doesn't exist)
- LoRA: r=16, alpha=32, 3 epochs, seq_len 2048, paged_adamw_8bit, cosine LR
- Loss: 5.95 → 0.43 across 375 steps
- Final adapter: 537 MB safetensors, SHA `852d3386d995a19b06485dcfb5afd161caa6c4301cfb1d7b94e295ea132c7fd7`
- Corpus: 1000 instruction pairs (Orange5 doctrine), SHA `6646f6a4e177d3d7e5fdfe2ba1f9069d8ebb9d460e4ee6671e3e76cc337b196f`
- **Method that worked:** no-Drive flow (operator's Drive was maxed) — wget corpus from secret gist + `files.download()` to operator's local Downloads
- **NOT used:** Google Drive, Axolotl, Workflow-tool-orchestrated polling

---

## The 8 Colab discipline rules (LOCKED from `feedback_six_hours_burned_be_better.md`)

Read these before authoring any future Orange5 training notebook. Six hours of operator time was burned by violating rules 1, 2, and 3.

1. **Never pin torch.** Use Colab's default torch. Install Unsloth (or Axolotl) on top.
2. **Never import torch before the install cell.** Torch is a C extension — re-import after install collides on docstrings.
3. **Never `sys.modules.pop` torch or any C-extension.** The "freshen import" pattern is fake.
4. **Pin nothing in the install cell that isn't absolutely required.** Colab ships a working stack; don't fight it.
5. **State uncertainty in the notebook header.** "I have not run this. Most likely failure modes: …"
6. **v(n+1) = v(n) + smallest possible diff.** When v(n) worked, v(n+1) is a hyperparameter change, not a cell reshuffle.
7. **Hard guards on every artifact cell.** `RuntimeError` on missing dir / empty dir / no `.safetensors` / main file under expected min size.
8. **No-Drive flow always.** Workdir = `/content`. Corpus = wget from secret gist with SHA verify. Output = `files.download()` to operator's Downloads.

**Recovery protocol when any kernel breaks:** Runtime → Disconnect and delete runtime → reconnect → refresh tab → Run all. Never use `os.kill(os.getpid(), 9)` — Run-all does not auto-continue past a kernel restart.

---

## Cell order (locked)

```
1. Install Unsloth (no python imports, %%capture + !pip install)
2. Workdir + corpus fetch (stdlib only: os, urllib, hashlib, json, random)
3. First-and-only `import torch` + GPU verify
4. Load model + attach LoRA (FastLanguageModel)
5. Train (TRL SFTTrainer + SFTConfig)
6. Verify (hard guards: RuntimeError on missing/empty/short adapter)
7. Zip + auto-download (files.download to operator's Downloads)
```

---

## The 6-stage training pipeline (revised — Workflow tool is OPTIONAL, not required)

Every training run = these stages. Workflow-tool orchestration is allowed for Stages 1-2 and 5-6 when operator authorizes; Stages 3-4 are always operator-direct + Drive-free.

### Stage 1 — Corpus Assembly (Workflow-optional)

**Input:** Training target spec (which model, what behavior to teach)
**Action:** Read Reality.flux + Thought.flux + receipts + doctrine; synthesize JSONL pairs `{"instruction", "input", "output"}`; validate against `09-SCHEMAS/training-corpus.v0.schema.json`
**Output:** `16-TRAINING/corpus/<model>-v<N>.jsonl` + SHA-256
**Operator action:** publish corpus.jsonl as secret gist; record SHA

### Stage 2 — Config Generation (Workflow-optional)

**Input:** Corpus + target + recipe
**Action:** Pick tool stack (Unsloth default for transformer LoRA on Colab; PEFT for SSM); generate notebook + YAML tuned to Colab GPU tier (T4 / V100 / A100); apply the 8-rule discipline
**Output:** `16-TRAINING/configs/<model>-v<N>.ipynb` + `.yaml`
**Operator action:** publish notebook as gist

### Stage 3 — Colab Run (operator-direct, NO Workflow)

**Input:** The `.ipynb` notebook
**Action:** Operator opens Colab URL, Runtime → A100 (or smaller for smaller models), Runtime → Run all. Colab does:
- wget corpus from secret gist (NO Drive mount)
- SHA-verify corpus against expected hash
- Install Unsloth on Colab default torch
- Load base + attach LoRA + train
- Save adapter to `/content/`
- Hard-guard verify adapter size
- Zip + `files.download()` to operator's Downloads folder

**Output:** Adapter zip in operator's Downloads
**Pass:** Notebook exits 0; verify cell passes guards; final loss meets threshold

### Stage 4 — Adapter Retrieval (operator-direct, NO Drive)

**Input:** Zip in operator's Downloads
**Action:** Operator moves zip to `C:\AtomEons\Orange5\16-TRAINING\adapters\<model>-v<N>\`, unzips. SHA-256 captured.
**Output:** Adapter on local disk
**Pass:** SHA matches training-receipt.json

### Stage 5 — Bakeoff (Workflow-optional, on Codexa)

**Input:** New adapter + baseline (current production model)
**Action:** Workflow fan-out: 3 evaluator agents (baseline, candidate, judge) across 5 dimensions (mission-shape, doctrine-recall, topology-recall, receipt-grounding, refusal-discipline)
**Output:** Scorecard at `10-RECEIPTS/orange5-build/<ts>-bakeoff-<model>-v<N>.json`
**Pass:** Win ≥ 4 of 5 OR lose ≤ 1 with no regression worse than 5%

### Stage 6 — Promotion Receipt (Workflow-optional)

**Input:** Bakeoff scorecard + adapter + training log
**Action:** Generate promotion receipt, run promotion gate (`04-CONTROL-PLANE/src/promotion-gate.mjs`), swap live model alias OR write rejection receipt
**Output:** Hash-chained receipt + (if promoted) live model swap
**Pass:** Receipt SHA continues chain; operator approves if risk_level ≥ high

---

## Per-model training plans

### Pass 1 — OrangeLLM-fatty v0 — SHIPPED 2026-06-25

| Property | Value |
|---|---|
| Base model | `unsloth/Qwen2.5-32B-Instruct-bnb-4bit` |
| Method | QLoRA 4-bit via Unsloth |
| Rank | 16 |
| Alpha | 32 |
| Epochs | 3 |
| Seq len | 2048 |
| Corpus rows | 1000 (SHA `6646f6a4…b196f`) |
| Colab tier | Pro ($10/mo) — A100 40GB |
| Actual wall-clock | ~25-30 min on A100 |
| Final adapter | 537 MB safetensors (SHA `852d3386…2c7fd7`) |
| Final loss | 0.43 (from 5.95) |
| Receipt | `2026-06-25-orangellm-fatty-v0-adapter-landed.md` (#025) |

### Pass 2 — OrangeLLM-fatty v1 — STAGED 2026-06-25

| Property | Value |
|---|---|
| Base model | same as v0 (`unsloth/Qwen2.5-32B-Instruct-bnb-4bit`) |
| Method | QLoRA via Unsloth |
| Rank | 32 (doubled — more capacity) |
| Alpha | 64 |
| Epochs | 4 (extra epoch with 95/5 eval split) |
| Seq len | 2048 (A100 40GB safe) |
| Corpus | same 1000 pairs as v0 |
| Colab tier | Pro — A100 40GB |
| Expected wall-clock | 25-35 min |
| Notebook | gist `63f45f759da773aa84307123373f4b48` (FIXED v2 after operator burn) |

### Pass 3 — AE Misfit Model v0 — PIPELINE AUTHORED, AWAITING CORPUS LINKAGE

| Property | Value |
|---|---|
| Base model | `qwen2.5:7b-instruct` |
| Method | QLoRA 4-bit |
| Corpus | STRONGARM Easy + Gremlin Elite 1000 + Gremlin QA 2000 + Gremlin Trainer 5000 (~8k rows total) |
| Colab tier | Free (T4) acceptable |
| Expected wall-clock | 1-3 hours on T4 |
| Expected adapter | 50-100 MB |
| Pass criteria | Catches ≥ 80% of fake-green AgentTurns; false-positive rate < 10% |
| Notebook | `16-TRAINING/configs/ae-misfit-v0.ipynb` (placeholders for CORPUS_URL, YAML_URL, EXPECTED_CORPUS_SHA — operator pastes) |
| Pipeline receipt | `2026-06-25-ae-misfit-pipeline.md` (#026) |
| Blocker | Operator points pipeline at real STRONGARM/Gremlin archive paths |

### Pass 4 — AE Cobra custom v0 — CORPUS AUTHORED, WEIGHTS PENDING

**Name correction 2026-06-25:** This was drafted as "AE Black Mamba." That name is retired. AE Cobra is the only name for this engine (the runtime of Pillar 3 / AE Memory).

| Property | Value |
|---|---|
| Base model | `mamba-2.8b-hf` (surrogate) → custom AE Cobra weights via full fine-tune |
| Method | Full fine-tune (SSM/SSD — Mamba-2; LoRA doesn't apply cleanly to SSM) |
| Corpus | Synthetic AgentTurn pairs from Reality.flux history; grammar-aligned 2026-06-26 |
| Colab tier | Free (T4) acceptable |
| Expected wall-clock | 4-8 hours |
| Expected weights | 5-6 GB (full new weights) |
| Status | Corpus pretrain exists. Custom AE Cobra weights not trained yet. Surrogate active until then. Active engine of Pillar 3 (AE Memory) — NOT HELD. |

---

## Colab tier cost reality

| Tier | GPU | Per-month | Enables |
|---|---|---|---|
| Free | T4 (16 GB) | $0 | 7B QLoRA, 2-4B full FT, embedding gen |
| Pro | V100 / A100-40GB (limited hours) | $10 | 13-32B QLoRA, longer sessions |
| Pro+ | A100-40GB more hours / A100-80GB | $50 | 30-70B QLoRA, big batches |

**Recommendation:** Pro tier covers OrangeLLM-fatty v0/v1 + AE Misfit + AE Black Mamba.

---

## Operator's role per training pass (5 minutes hands-on)

1. **Notification:** "Notebook ready at gist `<id>`. Open Colab, Run all. Zip auto-downloads to your Downloads."
2. **Open Colab** (browser).
3. **Runtime → Change runtime type → A100 GPU** (or T4 for small models).
4. **Runtime → Run all.**
5. **Wait** ~30 min. Notebook prints loss curve + final summary + auto-downloads zip.
6. **Move zip** from Downloads to `16-TRAINING/adapters/<model>-v<N>/`, unzip.
7. **Confirm SHA** matches notebook-printed SHA.

That's it. ~5 minutes hands-on; the rest is GPU compute.

---

## Frontier offload pattern (non-training "GPU equivalent")

For heavy inference Orange5 can't do locally:

```
operator query → OrangeLLM at :1337 → budget check
  ↓
NO local budget → frontier offload via gateway → BYO key call to Opus/GPT/Gemini
YES → local Codexa CPU+Vulkan handles it
  ↓
response back through gateway with `ae_lane: "frontier"` provenance tag
  ↓
Reality-lane Flux event
```

**This means Phase-2 Qwen3-VL 72B local is permanently optional.** Frontier offload handles it forever if operator never adds GPU.

---

## What this resolution updates

| File | Change |
|---|---|
| `00-CHARTER/ORANGE5_MONTH_PLAN_2026-06-23.md` | W3-D21 + W4-D26 reference this pattern explicitly |
| `00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md` | D1 closed; S6 closed; L5 (Ollama promotion) added |
| `07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md` | §8 D1 closes; Phase-2 reshaped |
| `16-TRAINING/README.md` | References this pattern |

---

## Mom's Law on this pattern

Every training pass that follows this spec must end with:

- ✅ Corpus SHA-256 captured in receipt
- ✅ Notebook path captured in receipt
- ✅ Colab wall-clock recorded
- ✅ Adapter SHA-256 captured
- ✅ Bakeoff verdict per-dimension scored
- ✅ Operator approval if risk_level ≥ high
- ✅ Live model alias swapped (or rejection receipt written)
- ✅ Receipt hash-chained to predecessor

**No silent training. No mystery weights. Every adapter has a paper trail.**

The 8-rule Colab discipline above is non-negotiable. Violating any rule means re-authoring the notebook before operator runs it.

---

**Receipts decide what is real. Colab is the GPU lane. Workflow is optional (Stages 1-2, 5-6 only). The operator clicks Run all. Mom is watching every gradient.**
