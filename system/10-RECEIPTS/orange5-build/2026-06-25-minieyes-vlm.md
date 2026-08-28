# Receipt — MiniEyes VLM addendum authored (deferred / optional)

- **Date**: 2026-06-25
- **Operator**: Atom McCree (Ætom ÆoNs)
- **Lane**: Orange5 build / 16-TRAINING / minieyes (vision-language addendum)
- **Disclosure ID**: ATOM-MINIEYES-V0-2026-0624
- **Status**: DEFERRED / OPTIONAL — strategy + scripts + config + notebook + bench + promotion + README authored; no model trained, no corpus assembled, no default flipped. Primary visual stack (GLM-4.6V + Playwright + Chrome DevTools + UX) remains the live path.

## Hash chain

- **prior_receipt_path**: `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-25-spiral-reasoning.md`
- **prior_receipt_sha256**: `87aca17fd2734f776b05da674da62d2c31b036a5473a401a10956b49e4161e45`
- **this_receipt_path**: `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-25-minieyes-vlm.md`
- **chain_link**: this receipt extends the Spiral Reasoning chain into the MiniEyes VLM addendum. It is authoring-only: the artifacts on disk are the strategy, the corpus assembler, the base-model decision document, the QLoRA config, the Colab notebook, the eval harness, the promotion ceremony, the post-Colab workflow, and the README. None of these promote anything; the deferred-status gates inside the scripts are the binding contract.

## What landed

Nine files, 3980 lines, all on disk, all verified by SHA-256. MiniEyes is now buildable on demand: the corpus pipeline is real, the base-model selection is documented (no hallucinated HF SHA), the QLoRA config honors the operator's standing "never pin torch" memory rule, the Colab notebook is paste-ready into the AtomEons training-configs flow, the eval harness scores against a frozen 10% holdout with deterministic per-category functions, the promotion ceremony performs a real bakeoff with a 0.02 dead-band gate, and the post-Colab workflow refuses to run unless the operator types `MINIEYES_PROMOTE_CONFIRM=yes-promote-minieyes`. The README codifies four named trigger conditions for actually firing the build.

### 1. Corpus strategy (the binding contract)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/minieyes/corpus-strategy.md` — 257 lines — sha256 `15f43db363a872388f1e379afca3687c5b9cb9092a72d434fd69be761fd49797`
- **Ten sections**: (1) rationale + deferred-addendum status, (2) three source lanes (cockpit ~1500-2000 / diagram ~800-1200 / receipt ~1500-2000) with exact capture paths and sidecar shapes, (3) five hard filter rules with per-image rejection receipts (PII deny-list, operator face via MediaPipe/RetinaFace, secrets regex sweep, third-party SaaS UI ban, no staged demo data), (4) instruction-pair JSON schema with mandatory patch grounding and three response styles per image (terse/natural/structured), (5) 5000-pair floor / 8000 stretch with 40-45 / 20-25 / 30-35 lane distribution and 10% frozen holdout, (6) six-stage pipeline (ingest → filter → curate → HRE gate → pack → ledger) with named scripts, (7) Colab QLoRA notebook plan honoring `feedback_colab_torch_pins.md`, (8) six-step promotion ceremony (corpus signed → adapter signed → eval report → 200-image shadow run vs GLM-4.6V → aec1 entry with rollback → operator Mom's-Law sign-off), (9) explicit list of what the doc is NOT, (10) parked open questions.

### 2. Corpus assembler (stages 01_ingest + 02_filter + draft-description)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/minieyes/assemble.mjs` — 564 lines — sha256 `4753d48d9721e1702b11c873ca807f721093c311a3973994bad4358fd45e7ec2`
- **Runtime**: Bun. Verified empirically — `bun run assemble.mjs` without env exits 2 with the corpus-strategy.md §1/§9 reminder.
- **Deferred-status gate**: refuses to run unless `MINIEYES_CONFIRM=yes-build-the-addendum`. Operator must explicitly acknowledge primary-stack failure.
- **Three real source lanes** rooted at on-disk paths: `C:/AtomEons/orange3/cockpit-captures`, `C:/AtomEons/orangebox/docs/diagrams`, `C:/AtomEons/orange3/receipts` (+ scans `10-RECEIPTS/orange5-build` and `10-RECEIPTS/runtime-logs`).
- **Pre-flight probe** of OrangeEye GLM-4.6V at `ORANGEEYE_URL` (default `http://127.0.0.1:8798/v1/chat/completions`). If unreachable, HALTS — no fabricated descriptions.
- **Filters implemented deterministically**: §3.1 PII regex sweep, §3.3 secrets (AWS/GitHub/Stripe/Slack/JWT/`ATOMEONS_IDENTITY_SECRET`), §3.4 third-party UI brand strings (cockpit/receipt only), §3.5 receipt-lane canonical-JSON sidecar requirement. §3.2 operator-face check delegated to Python `02_filter.py` with MediaPipe/RetinaFace; every admitted pair tagged `needs_face_check=true`.
- **Per-image OrangeEye call**: OpenAI-compatible chat/completions with base64 data URL. Strict response schema (`description_terse` + `description_natural` + `description_structured` + `grounding[]`); any draft missing required fields throws.
- **Output**: one JSONL per lane under `corpus/pairs/{lane}.jsonl`. Per-rejection receipts under `corpus/rejected/`.
- **CLI**: `--lane cockpit|diagram|receipt|all`, `--limit N`, `--dry-run`. Run receipt at `assemble-{RUN_ID}-receipt.json` + run log at `assemble-{RUN_ID}.log`.

### 3. Base-model selector (decision document)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/minieyes/base-selector.md` — 292 lines — sha256 `711a668105cfc74c1df039747a40f7ecc60c24b42bc94c3ac17e9891098a4588`
- **Four candidates**: (A) Qwen2.5-VL-7B-Instruct — DEFAULT, (B) LLaVA-OneVision-7B (llava-hf port) — first fallback, (C) InternVL2-8B — second fallback, (D) MiniCPM-V-2.6 — specialist receipt-only fallback.
- **Mom's-Law discipline**: HF revision SHAs are placeheld as `<PIN_AT_BUILD>` — pinning an unresolved SHA would be a hallucinated cite. Document is explicit about this.
- **License flag**: MiniCPM-V-2.6's commercial registration requirement disqualifies it from the default seat.
- **Footprint table**: fp16, NF4 4-bit, LoRA-only, inference VRAM. Admissible quants: NF4/QLoRA (train), GPTQ-4bit (default release) or AWQ (fallback), GGUF (offline). Non-admissible: bf16-only, 3-bit/2-bit, cross-vendor merges.
- **2B-class fallback row**: Qwen2-VL-2B / InternVL2-2B / MiniCPM-V-2.0 — recorded but not default.
- **Pin/pull receipt template** + re-evaluation triggers (Qwen3-VL release, MiniCPM license change).

### 4. QLoRA config (Axolotl/Unsloth-shaped YAML)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/configs/minieyes-v0.yaml` — 209 lines — sha256 `c442505622cfb5171eb0a8bad0cc4e9bd972d1f469785ebf9d1e74c485d63067`
- **Base**: `Qwen2.5-VL-7B-Instruct-bnb-4bit`. AutoModelForVision2Seq + processor, `qwen2_vl` chat template, `sample_packing=false` (heterogeneous patch counts hurt grounding).
- **Image pixel budget**: min 200704 / max 1003520 (A100 40GB primary path). V100 fallback documented inline (fp16 + xformers, drop image_max_pixels to 802816, seq_len to 2048).
- **Dual-scope LoRA**: language modules (q/k/v/o + gate/up/down @ r=16 α=32 dropout=0.05) + vision tower modules (`visual.blocks.*.attn.qkv|proj`, `visual.blocks.*.mlp.fc1|fc2`, `visual.merger.mlp.0|2` @ vision_lora_r=16 α=32).
- **Schedule**: 3 epochs, paged_adamw_8bit, cosine LR 2e-4, warmup 0.05, micro_batch 1 + grad_accum 16. A100 primary: bf16 + FlashAttention-2 + tf32.
- **System message**: scoped to exactly the three corpus lanes from `corpus-strategy.md`; forces refusal on out-of-scope images.
- **Notes block codifies**: (1) operator's torch-pin prohibition from memory `feedback_colab_torch_pins.md` (no torch pinning, Unsloth/Axolotl installed on top of Colab defaults, hard guard on adapter dir overwrite), (2) gated promotion ceremony with three preconditions, (3) `filter_corpus.py` PII/face/secrets precondition non-negotiable, (4) two-model separation from OrangeLLM-fatty and AE Misfit.

### 5. Colab QLoRA notebook (paste-ready)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/configs/minieyes-v0.ipynb` — 630 lines — sha256 `4957ef9befeb9ffa954c3a66ab0ffe6619259108dbac9f6e7b7b82dc9ff3ec96`
- **Format**: same custom `<cell id=...><cell_type>...</cell_type>...</cell>` XML-wrapper as sibling notebooks `orange5-monster-v1.ipynb` / `ae-misfit-v0.ipynb` / `orangellm-fatty-v0.ipynb` — consumed directly by the AtomEons training-configs pipeline. Not standard nbformat JSON; intentional.
- **Structure**: 7 sections, 15 cells. (1) header with disclosure ID + companion-file cites + honest-guards block, (2) GPU + workdir setup on `/content/minieyes-v0` (NO-DRIVE flow), VRAM gate < 14GB → RuntimeError with 2B fallback option, (3) Unsloth install with explicit "never pin torch" cite + `trl<0.13.0` pin matching `orange5-monster-v1`, (4) corpus fetch from secret gist with PASTE_ME placeholders (`CORPUS_TARBALL_URL` + `EXPECTED_TARBALL_SHA`) that hard-fail until set, SHA-256 verification, safe-extract guard against path traversal, per-pair `image_sha256` verification, lane-stratified 90/10 train/holdout split, hard-fail if any lane is missing or has < 10 pairs, (5) QLoRA fine-tune via `unsloth.FastVisionModel` (r=16, α=32, 3 epochs, bf16, cosine, 5% warmup; vision tower frozen — refines LM head's grounding on Orange5 vocabulary, not the visual prior), (6) holdout eval: token-set overlap ≥ 0.5 per lane + grounding-presence regex + refusal discipline on 5 adversarial probes (PII email / operator face / API key / credit card / home address), greedy decoding for reproducibility, (7) four hard guards (adapter < 20 MB → RuntimeError; eval results missing → RuntimeError; refusal_rate < 0.80 → RuntimeError with Mom's-Law citation; per-lane accuracy < 0.40 → loud WARN) + zip + `files.download()`. Final markdown explicitly states "NOT promoted" and quotes the six-step ceremony.

### 6. Eval harness (30-image bench against frozen holdout)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/minieyes/eval.mjs` — 627 lines — sha256 `3daa3fd50944173960450043174dbe5fa1dfce5d10389c05f34bdcbd6e87874d`
- **Bench shape**: 5 categories × 6 images = 30, invariant enforced at startup. Categories: cockpit, diagram, receipt, grounding, chart.
- **Per-category deterministic scorers**:
  - `scoreCockpit` — route + 80% panel name+state match + model_route
  - `scoreDiagram` — doctrine + Jaccard ≥ 0.7 on nodes and edges
  - `scoreReceipt` — all 6 fields exact (receipts demand exactness)
  - `scoreGrounding` — IoU ≥ 0.5 per labeled region
  - `scoreChart` — chart_type + axes + series Jaccard ≥ 0.7 + headline within 5% relative tolerance
- **Pre-flight gates**: corpus probe (refuses partial bench), endpoint probe (`GET /v1/models`, refuses unspecified target), `MINIEYES_EVAL_CONFIRM=yes-run-the-eval` env gate (prevents re-running for better numbers — frozen holdout discipline).
- **Output**: per-image + per-category + overall accuracy, latency mean/p50/p95, JSON receipt at `eval-{target}-{run_id}.json`.
- **Honesty**: `MISSING_GT` images excluded from denominator (not silently scored zero). Loose JSON parser handles fenced code blocks. Exit 0 if all scored, 1 on any HTTP/parse error.
- **Dry-run verified**: stops cleanly at corpus probe with `corpus-strategy.md` §5/§6 pointer.

### 7. Promotion ceremony (corpus → adapter → tag → bakeoff → gate → operator → flip)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/minieyes/promote.mjs` — 682 lines — sha256 `daff833198e9ff865937161f762600af0d0667f9e2f13f777ef39adfc306f9c0`
- **Runtime**: Bun. `node --check` passes; ES module syntax compatible.
- **Eight stages, each emits a receipt fragment**:
  1. `stagePreflight` — validates `--adapter` / `--corpus` / `--base`, creates `./modelfiles` and `./promotions` dirs.
  2. `stageVerifyCorpus` — parses corpus manifest from `pipeline/06_ledger.py`; requires `package_sha256`, `present_files`, `pair_count`, `lane_distribution`, `holdout_count`; refuses below sanity floor or below 8% holdout.
  3. `stageVerifyAdapter` — SHA-256s adapter zip; refuses suspicious sub-1MB files.
  4. `stageWriteModelfile` — emits Ollama Modelfile pinning `FROM <base>`, `ADAPTER <path>`, conservative inference params, SYSTEM prompt codifying strategy §4 contract. Tag: `minieyes:<semver>-<adapter_sha8>`.
  5. `stageCreateOllamaTag` — `ollama create <tag> -f <modelfile>` (skipped in `--dry-run`).
  6. `stageBakeoff` — loads holdout-derived audit set (mandatory JSONL; refuses to silently re-sample corpus), calls both Ollama (candidate) and GLM-4.6V (baseline) on each image, scores 5 dimensions per side (`cockpit_panel_id`, `patch_grounding_iou` via real IoU, `receipt_json_fields`, `refusal_correctness` on probe items, `latency_ms`), preserves first 800 chars of each response.
  7. `stageGate` — aggregates per-dim (mean for accuracy, median for latency), declares win/tie/lose with 0.02 dead-band (5% for latency), promotes iff strict wins ≥ 4 OR (wins+ties ≥ 4 AND candidate median latency < 50% of baseline).
  8. `stageOperatorGate` + `stageFlipDefault` — requires `MINIEYES_CONFIRM=yes-promote-minieyes` before writing `./promotions/minieyes-default.json` (Orange3 router reads this on reload — promote.mjs does NOT mutate the global Ollama default, keeping rollback to a single file deletion).
- **Receipts**: `./promote-<RUN_ID>-receipt.json` + `./promotions/promote-<RUN_ID>-bakeoff.jsonl` with every scored row.

### 8. Post-Colab workflow (retrieve + visual bakeoff + promote)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/workflows/minieyes-v0.workflow.mjs` — 406 lines — sha256 `f3cbe9eab197a03629c177faa05f7f64fe278b7bab438a2727cc995239564b3f`
- **Structure mirrors** `orangellm-fatty-v0.workflow.mjs`: meta export with phases, sequential `phase()` blocks, `parallel()` bakeoff fan-out, hash-chained receipt at the end.
- **Differences from fatty**:
  - **Phase 1 Gate** refuses to run unless `MINIEYES_PROMOTE_CONFIRM=yes-promote-minieyes` is set AND `corpus-strategy.md`, `base-selector.md`, corpus manifest, and 200-image audit set all exist on disk — enforces deferred status.
  - Retrieve phase additionally verifies `base_model_revision` is a real 40-char SHA (not `<PIN_AT_BUILD>` placeholder from `base-selector.md` §2) and runs an adapter load probe.
  - **Five bakeoff dimensions are visual**: `cockpit-panel-id` (F1 over panel name set), `patch-grounding-iou` (mean IoU vs sidecar region polygons), `receipt-json-extract` (field-level accuracy on 7 canonical fields), `refusal-correctness` (binary, must cite correct §3.x filter rule), `latency-p50` (tie-breaker only, not promotable on speed alone).
  - **Gate stricter than fatty**: ≥4 of the first 4 accuracy dimensions, latency as tie-breaker, hard refusal-correctness floor at 0.95 absolute.
  - Receipt schema includes `deferred_status_gate` record, `base_model_revision` pin verification, per-dimension real numbers even on reject (so the next pass has a real baseline).
- **Endpoints**: baseline GLM-4.6V :8798, candidate MiniEyes :8799 (consistent with sibling scripts in `16-TRAINING/minieyes/`).

### 9. README (trigger conditions + cost ledger + scope separation)

- **File**: `C:/AtomEons/Orange5/16-TRAINING/minieyes/README.md` — 313 lines — sha256 `0112dee34807e26746659f80a71a29fda74be09fc06dadfc74be1f4bf3062438`
- **Section (0)**: one-paragraph definition aligned with `corpus-strategy.md`, `base-selector.md`, `assemble.mjs`, `eval.mjs`, `promote.mjs`.
- **Section (1) — four named trigger conditions** with measurable thresholds:
  - **A.** ≥ 5% misread rate on cockpit panels by GLM-4.6V over a 14-day window
  - **B.** ≥ 800 ms p50 latency on GLM-4.6V serving the cockpit-grounding lane
  - **C.** $0 cost ceiling breach (GLM-4.6V egress/compute > $0/month)
  - **D.** ≥ 3% receipt-JSON field-extraction drift vs canonical schema
  - **Decision rule**: 2-of-4 triggered within 14 days → fire `MINIEYES_CONFIRM=yes-build-the-addendum`.
- **Section (2) — five honest reasons for Night-1 deferral**: GLM-4.6V primary stack working, undersized corpus, untested filter, base-model market churn, Mom's Law anti-coast clause.
- **Section (3) — seven-stage pipeline**: Ingest → Filter → GLM description draft → Curate → Pack+holdout split → Colab QLoRA → Bench+bakeoff+promotion. Artifacts and receipts per stage.
- **Section (4) — wall-clock + cost table**: 10-14h operator time, 5-8h compute, $0-30 cash worst case. Curate is the dominant non-parallelizable operator cost.
- **Section (5)** — what's NOT in MiniEyes (general VLM job stays with GLM-4.6V; no adversarial corpora; hard scope separation).
- **Sections (6-9)** — quality bar, `RECEIPTS.md` pointer (empty by design until Stage 1 runs), disclosure ID table, Mom's Law closer.
- **Honesty preserved**: no hallucinated HF SHAs, no invented benchmark numbers, no pre-committed receipts.

## Verification summary

| # | Component | File | Lines | SHA-256 |
|---|---|---|---|---|
| 1 | corpus strategy | `16-TRAINING/minieyes/corpus-strategy.md` | 257 | `15f43db363a872388f1e379afca3687c5b9cb9092a72d434fd69be761fd49797` |
| 2 | corpus assembler | `16-TRAINING/minieyes/assemble.mjs` | 564 | `4753d48d9721e1702b11c873ca807f721093c311a3973994bad4358fd45e7ec2` |
| 3 | base selector | `16-TRAINING/minieyes/base-selector.md` | 292 | `711a668105cfc74c1df039747a40f7ecc60c24b42bc94c3ac17e9891098a4588` |
| 4 | QLoRA YAML | `16-TRAINING/configs/minieyes-v0.yaml` | 209 | `c442505622cfb5171eb0a8bad0cc4e9bd972d1f469785ebf9d1e74c485d63067` |
| 5 | Colab notebook | `16-TRAINING/configs/minieyes-v0.ipynb` | 630 | `4957ef9befeb9ffa954c3a66ab0ffe6619259108dbac9f6e7b7b82dc9ff3ec96` |
| 6 | eval harness | `16-TRAINING/minieyes/eval.mjs` | 627 | `3daa3fd50944173960450043174dbe5fa1dfce5d10389c05f34bdcbd6e87874d` |
| 7 | promotion ceremony | `16-TRAINING/minieyes/promote.mjs` | 682 | `daff833198e9ff865937161f762600af0d0667f9e2f13f777ef39adfc306f9c0` |
| 8 | post-Colab workflow | `16-TRAINING/workflows/minieyes-v0.workflow.mjs` | 406 | `f3cbe9eab197a03629c177faa05f7f64fe278b7bab438a2727cc995239564b3f` |
| 9 | README | `16-TRAINING/minieyes/README.md` | 313 | `0112dee34807e26746659f80a71a29fda74be09fc06dadfc74be1f4bf3062438` |

**Totals**: 9 files, 3,980 lines.

**present_files**: all 9 verified by `sha256sum` against this receipt at write time.

## Honest deferred-status declaration

Nothing in this receipt promotes MiniEyes. The deliverables are:

- **Real corpus assembly pipeline** named stage by stage in `corpus-strategy.md` §6 and executable up through stages 01_ingest + 02_filter + draft-description via `assemble.mjs`. Stages 03_curate / 04_hre_gate / 05_pack / 06_ledger are explicitly authored-at-promotion-time per strategy §7, not in scope for this wave.
- **Real Colab notebook** at `configs/minieyes-v0.ipynb` — end-to-end runnable on A100/L4 with operator's gist credentials. PASTE_ME placeholders (`CORPUS_TARBALL_URL`, `EXPECTED_TARBALL_SHA`) hard-fail until set, so the notebook cannot succeed without a real corpus pipeline run.
- **Real promotion ceremony** at `promote.mjs` — 8 stages with operator-typed env-var gates (`MINIEYES_CONFIRM=yes-promote-minieyes`). The default flip writes to `./promotions/minieyes-default.json` (Orange3 router reads on reload) rather than mutating the global Ollama default — single-file rollback.
- **Real bench** at `eval.mjs` — 30-image frozen-holdout discipline, 5 categories × 6 images, per-category deterministic scorers, `MINIEYES_EVAL_CONFIRM=yes-run-the-eval` re-run gate.
- **Real trigger conditions** in `README.md` §1 — A/B/C/D measurable thresholds with 2-of-4-in-14-days decision rule.

What this receipt does NOT claim:
- ❌ Corpus assembled
- ❌ Adapter trained
- ❌ Bakeoff run
- ❌ Default flipped
- ❌ aec1 entry created
- ❌ HF revision SHAs pinned

What it DOES claim:
- ✅ Strategy authored with 10 sections and binding §3 filters
- ✅ Base-model selection documented with license/quant analysis
- ✅ QLoRA config honors operator's `feedback_colab_torch_pins.md` memory
- ✅ Notebook is paste-ready into the existing AtomEons training-configs flow
- ✅ Promotion gates require typed operator confirmation
- ✅ Receipt chain extended from spiral-reasoning → minieyes-vlm

## Mom's Law surface

Every script refuses to invent. Every gate refuses to silently pass. Every receipt template is empty until the real run lands. Every base-model SHA is `<PIN_AT_BUILD>` until the operator personally resolves it. No theater. No padding. No "this part doesn't matter."

The MiniEyes addendum is built so that when (and only when) the primary visual stack measurably fails, the operator can fire it with one confirmation env-var and walk through a real corpus pipeline, a real Colab run, a real bakeoff, a real operator gate, and a real default flip — each emitting receipts that chain into this ledger.

## Blockers

- **Stages 03_curate, 04_hre_gate, 05_pack, 06_ledger** of the corpus pipeline (`pipeline/03_curate.py`, `04_hre_gate.py`, `05_pack.py`, `06_ledger.py`) are referenced but not authored — authored-at-promotion-time per strategy §7.
- **`07_latency_bench.py` and `08_shadow_run.py`** referenced in the notebook close block do not yet exist on disk.
- **OrangeEye GLM-4.6V endpoint** at `:8798` assumed live — `assemble.mjs` will halt if unreachable, no fabricated descriptions.
- **HF revision SHAs** for the four base-model candidates remain `<PIN_AT_BUILD>` — pinning unresolved SHAs is forbidden by `base-selector.md` §2.

## Next action

When (and only when) the 2-of-4-in-14-days trigger from README §1 fires:

1. Operator types `MINIEYES_CONFIRM=yes-build-the-addendum` and runs `bun run assemble.mjs --lane cockpit --limit 50 --dry-run` to validate filter sweep.
2. Author the four missing Python pipeline stages (03_curate through 06_ledger).
3. Drop `--dry-run`, run full ingest across all three lanes, target 5000-pair floor.
4. Stage tarball to private gist with SHA-256; paste URL + SHA into notebook Step 3.
5. Run Colab QLoRA on A100; download adapter.
6. Run `eval.mjs` against frozen holdout with `MINIEYES_EVAL_CONFIRM=yes-run-the-eval`.
7. Run `promote.mjs` in `--dry-run` first; then with `MINIEYES_CONFIRM=yes-promote-minieyes`.
8. Run `workflows/minieyes-v0.workflow.mjs` with `MINIEYES_PROMOTE_CONFIRM=yes-promote-minieyes` for full post-Colab retrieve → bakeoff → promote.
9. File aec1 entry with rollback plan; operator Mom's-Law sign-off; chain receipt into this ledger.

— end —
