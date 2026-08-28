# MiniEyes Base Model Selector

**Disclosure ID:** ATOM-MINIEYES-BASE-2026-0624
**Status:** Decision document. Authored against the corpus strategy in
`./corpus-strategy.md`. Not a build order. The base is only pulled and
fine-tuned if the primary visual stack (GLM-4.6V + Playwright + Chrome
DevTools + UX tools) demonstrably fails under real Orange5 / AECode load.
**Operator:** Atom McCree (sole final approver).
**Companion file:** `./corpus-strategy.md` (sources, filter rules, pipeline).
**Receipt path:** `./RECEIPTS.md` (created on first real build pass — not
before).

## 0. What this document decides

This file is the **base-model bake-off**. It compares four candidate
2–8B-class open-weight VLMs that can be QLoRA fine-tuned on Colab against
the MiniEyes corpus, locks in a default pick with rationale, and records
the exact HF revision SHAs the build will pin to. Every claim below has
a citation against the model card or repository the operator can verify
without leaving the machine.

## 1. Candidate slate

The four candidates are the only ones admitted to the bake-off. Each one
is open-weight, has a non-trivial production track record, and can be
QLoRA-tuned in a single Colab A100 / L4 session with the corpus from
`corpus-strategy.md` §5.

| # | Candidate | Params | Org | Latest release as of cutoff |
|---|---|---|---|---|
| A | **Qwen2.5-VL-7B-Instruct** | 7B | Alibaba / Qwen | 2025-01-26 |
| B | **LLaVA-OneVision-7B (`llava-onevision-qwen2-7b-ov-hf`)** | 7B (Qwen2 backbone) | LLaVA-VL / HF | 2024-09 |
| C | **InternVL2-8B** | 8B (InternViT-300M-448px + InternLM2.5-7B-chat) | OpenGVLab / Shanghai AI Lab | 2024-07 |
| D | **MiniCPM-V-2.6** | 8B (SigLIP-400M + Qwen2-7B) | OpenBMB | 2024-08 |

A 2B-class fallback row is recorded at the bottom (§7) for the case where
the operator wants a smaller, faster eye even at the cost of accuracy.
None of the 2B class is the default — MiniEyes is small but not tiny.

## 2. Source-of-truth references (verify before pulling)

Every Hugging Face repository ID and exact revision pin used below should
be re-verified at build time by the operator with `huggingface-cli` or a
direct browser visit to the model card. The values here are recorded as
of the cutoff date on the model card itself; HF revision SHAs are recorded
when the operator runs the pin step in `02_pin.py` (to be authored in
`pipeline/`). The string `<PIN_AT_BUILD>` below is a placeholder the
operator replaces with the resolved 40-character commit SHA from the HF
repo's `main` branch on the day of pull.

| Candidate | HF repo ID | Revision pin |
|---|---|---|
| A | `Qwen/Qwen2.5-VL-7B-Instruct` | `<PIN_AT_BUILD>` |
| B | `llava-hf/llava-onevision-qwen2-7b-ov-hf` | `<PIN_AT_BUILD>` |
| C | `OpenGVLab/InternVL2-8B` | `<PIN_AT_BUILD>` |
| D | `openbmb/MiniCPM-V-2_6` | `<PIN_AT_BUILD>` |

Why no SHA is hard-coded today: pinning a SHA that the operator has not
personally resolved on the build day is a hallucinated cite — forbidden
by `00-moms-law.md`. The build script writes the real SHA into
`RECEIPTS.md` on pull, with the `huggingface-cli` output captured as the
receipt.

## 3. License table (read before pulling)

Licenses are quoted from the model cards as of the cutoff date. The
operator must re-confirm at build time — license terms have changed
historically across Qwen and InternVL releases. Any change from the
recorded text below blocks the build until the operator re-approves.

| Candidate | License | Commercial use | Attribution required | Notes |
|---|---|---|---|---|
| A Qwen2.5-VL-7B | Apache-2.0 | Yes | Standard Apache-2.0 NOTICE | Qwen2.5-VL series moved to Apache-2.0 for the 7B tier; the 72B tier sits under a separate Qwen license. Pull only the 7B repo. |
| B LLaVA-OneVision-7B | Apache-2.0 (model code) + base components inherit (Qwen2 backbone Apache-2.0; OpenAI CLIP MIT) | Yes | Yes, per component | The HF-port `llava-onevision-qwen2-7b-ov-hf` aggregates components — verify each on the card. |
| C InternVL2-8B | MIT (weights), with usage notice referencing InternLM2.5 license for the LLM backbone | Yes, with notice | Yes | InternLM2.5-7B-chat is the LLM half; its license must be honored alongside MIT on the vision side. |
| D MiniCPM-V-2.6 | "MiniCPM Model License" — free for academic use; commercial use requires registration with OpenBMB (the card publishes a registration link, no fee documented). | Conditional | Yes | The registration gate is the reason this candidate is not the default for an independent operator who does not want to file paperwork before shipping. |

**Hard rule:** If MiniCPM-V-2.6's registration requirement is unchanged at
build time, it is dropped from the default pick automatically — Mom's Law
forbids shipping under a license the operator has not personally signed
off.

## 4. Size, footprint, and quantization budget

All four candidates target the same Colab tier (A100 40GB or L4 24GB).
The numbers below are footprint estimates derived from the model card
parameter counts and the standard `bitsandbytes` 4-bit NF4 quantization
math (4 bits per weight + scale/zero per group of 64); the operator
records measured numbers in `RECEIPTS.md` after the first real load.

| Candidate | Params (total) | fp16 weights (GB) | NF4 4-bit (GB est.) | LoRA-only trainable (typical, GB) | Inference VRAM at 4-bit (GB est.) |
|---|---|---|---|---|---|
| A Qwen2.5-VL-7B | 7B | ~14.0 | ~4.5 | ~0.1–0.3 | ~6–8 (with vision tower in fp16) |
| B LLaVA-OneVision-7B | 7B | ~14.0 | ~4.5 | ~0.1–0.3 | ~6–8 |
| C InternVL2-8B | 8B | ~16.0 | ~5.0 | ~0.1–0.3 | ~8–10 |
| D MiniCPM-V-2.6 | 8B | ~16.0 | ~5.0 | ~0.1–0.3 | ~8–10 |

### 4.1 Quantization options that are admissible

- **NF4 4-bit via `bitsandbytes`** (default for the Colab QLoRA run).
  Standard QLoRA recipe. Vision tower stays in fp16/bf16; LLM backbone in
  NF4. This is the path `notebooks/minieyes_qlora.ipynb` will use.
- **GPTQ 4-bit** (post-tune, for local inference). Suitable for a packaged
  release. Requires `auto-gptq` or `optimum`. Re-quantization happens
  AFTER the adapter is merged and validated — never on the unmerged base.
- **AWQ 4-bit** (alternative post-tune path). Considered if GPTQ shows
  measurable accuracy regression on the holdout per corpus-strategy.md
  §5. Default is GPTQ; AWQ is the named fallback.
- **GGUF Q4_K_M / Q5_K_M** (for llama.cpp-style CPU+iGPU inference, if the
  Orange5 host ever needs a fully-offline path with no CUDA). Only
  applicable to candidates with established GGUF pipelines — at the
  cutoff date, that is Qwen2.5-VL via `llama.cpp` mmproj support and
  MiniCPM-V-2.6 via OpenBMB's own GGUF release. LLaVA-OneVision and
  InternVL2 GGUF support is community-driven and verified at build time
  before being relied on.

### 4.2 Quantization that is NOT admissible

- **bf16-only deployment.** Wastes VRAM on the Orange5 host for no
  measurable accuracy gain at MiniEyes scale.
- **3-bit or 2-bit quant.** Below the empirical floor where VLM grounding
  survives. If smaller is needed, drop to a 2B base (§7), do not
  hyper-quantize an 8B.
- **Mixed-precision merges across vendors.** The adapter is merged into
  the same base it was trained against. No cross-base transfer.

## 5. Capability comparison against MiniEyes use cases

The corpus targets three things (corpus-strategy.md §1): cockpit panel
state recognition, AECode diagram region grounding, and receipt PDF →
structured JSON. The candidate ranking below scores each model on those
three lanes against published model-card claims and the OpenCompass /
MMBench / DocVQA / RefCOCOg numbers the model cards themselves cite. The
operator re-confirms numbers from the original card at build time.

| Capability | A Qwen2.5-VL-7B | B LLaVA-OneVision-7B | C InternVL2-8B | D MiniCPM-V-2.6 |
|---|---|---|---|---|
| Native dynamic resolution / patch grounding (cockpit panels at varying viewport) | **Strong** — model card highlights "Naive Dynamic Resolution" and bounding-box / point output as first-class. | Moderate — multi-image / multi-resolution training present; bbox output works but is not the headline feature. | **Strong** — dynamic tiling at 448 px with explicit grounding head; OpenGVLab papers cite RefCOCO/RefCOCOg benchmarks directly. | Moderate — OCR and document focus is the headline; grounding is supported but secondary. |
| Diagram / structured visual understanding (AECode diagrams, region polygons) | **Strong** — Qwen2.5-VL card explicitly highlights "structured outputs (JSON/HTML for invoices, forms, tables)" and chart/diagram comprehension. | Moderate — general visual understanding strong; structured-output emphasis weaker than Qwen2.5-VL. | **Strong** — Shanghai AI Lab's InternVL2 series scores at or near top of OpenCompass for multi-image and structured tasks at the 8B tier. | Strong — document and chart understanding is a stated strength; less emphasis on diagram polygons. |
| OCR / document → structured JSON (receipt PDFs) | **Strong** — explicit OCR + structured-output emphasis in the card. | Moderate — OCR present, structured-extraction less emphasized. | Strong — InternVL2-8B reports strong DocVQA / ChartQA numbers. | **Strong** — MiniCPM-V-2.6's headline use case is OCR-heavy document understanding; "OCRBench SOTA at the time of release" is the card's claim. |
| Long-image / high-resolution receipts (multi-page PDFs at 300 DPI) | Strong — native dynamic resolution handles tall images. | Moderate — multi-image batching is the lever, not single tall image. | Strong — 448 px tile sliding window handles tall pages cleanly. | Strong — multi-image and long-image support called out. |
| Single-image latency on consumer GPU (8B class) | Good (Qwen2.5-VL is widely benchmarked on consumer setups). | Good. | Acceptable — InternViT vision tower is the heavier part. | Good — MiniCPM team explicitly optimizes for end-device deployment. |
| LoRA / QLoRA ecosystem maturity at cutoff date | **Mature** — Unsloth, Axolotl, LLaMA-Factory all have explicit Qwen2.5-VL recipes. | Mature — LLaVA-OneVision has reference QLoRA scripts in the upstream LLaVA repo. | Mature — InternVL repo ships finetuning scripts; LLaMA-Factory supports it. | Moderate — MiniCPM-V has official finetune scripts but the community LoRA recipe surface is thinner. |
| License friction for a solo independent operator | **Low** (Apache-2.0) | Low (Apache-2.0 + component inheritance) | Low (MIT + InternLM2.5 notice) | **Medium** (MiniCPM Model License — commercial registration step) |

## 6. Default pick and rationale

**Default: A — `Qwen2.5-VL-7B-Instruct`.**

The rationale, ranked by what matters most for MiniEyes specifically:

1. **Patch grounding is first-class.** The Qwen2.5-VL card lists
   bounding-box and point output as a headline capability. MiniEyes
   training data is entirely patch-grounded (corpus-strategy.md §4.1).
   The base must already speak that language well; otherwise the
   fine-tune is fighting the prior instead of refining it.
2. **Structured-output emphasis.** "JSON/HTML for invoices, forms,
   tables" is exactly the receipt-PDF use case. The receipt lane in
   corpus-strategy.md §2.3 targets `image → canonical receipt JSON`.
3. **Dynamic resolution.** Cockpit screenshots come at every viewport
   the operator uses, from full-screen 4K to half-width docked panes.
   A base that handles dynamic resolution natively avoids a resizing
   layer that would drop grounding fidelity.
4. **Apache-2.0 with no registration gate.** Zero license friction for
   an independent operator. The build can proceed without paperwork.
5. **Mature QLoRA ecosystem.** Unsloth, Axolotl, and LLaMA-Factory
   all have working Qwen2.5-VL fine-tuning paths at the cutoff date,
   reducing notebook authoring risk.
6. **Same Qwen2 family as the LLM backbones in two other candidates
   (B, D).** If the default ever fails the side-by-side shadow run in
   the promotion ceremony (corpus-strategy.md §8), falling back to B or
   D inherits part of the tokenizer / chat-template work already done.

### 6.1 Why not C (InternVL2-8B)

InternVL2-8B is the closest second pick and would be the **named
fallback** if Qwen2.5-VL-7B underperforms on the diagram lane during
the bake-off. Its grounding head is strong and the OpenCompass numbers
are competitive. The reason it does not win the default seat: the
structured-output and "this is a form / receipt" framing in Qwen2.5-VL's
card is closer to the receipt lane's actual shape, and 7B vs 8B reduces
the Colab VRAM headroom MiniEyes can spend on the vision tower.

### 6.2 Why not B (LLaVA-OneVision-7B)

LLaVA-OneVision-7B is a strong generalist with excellent multi-image
behavior. The reason it loses the default: its card emphasis is on
"single model across single-image, multi-image, and video," which is
broader than MiniEyes needs and means none of its capacity is
preferentially tuned for the patch-grounded structured-output workflow
MiniEyes lives on. Kept as the second fallback.

### 6.3 Why not D (MiniCPM-V-2.6)

MiniCPM-V-2.6 is arguably the strongest OCR / document base in the
slate and would be a tempting pick **for the receipt lane alone**. Two
disqualifiers from the default seat:

- **License friction.** The MiniCPM Model License requires a separate
  registration step for commercial use. The operator has not signed
  that registration as of the cutoff date. Mom's Law forbids assuming
  the operator will sign paperwork later.
- **Cockpit and diagram lanes.** MiniEyes is not an OCR-only model. The
  cockpit and diagram lanes together are 60–70 % of the corpus
  (corpus-strategy.md §5). A document-OCR-specialized base would be the
  wrong center of gravity.

Kept as a **specialist fallback** if the receipt lane alone ever needs
its own model.

## 7. 2B-class fallback row (smaller and faster, lower ceiling)

If, during the bake-off, the operator decides MiniEyes needs to be
small enough to live on the Orange5 host with no dedicated GPU, the
following 2B-class candidates are the admitted pool. None of them is
the default. They are listed for completeness so the build script can
short-circuit to a smaller base without re-opening this document.

| Candidate | HF repo | License | Notes |
|---|---|---|---|
| Qwen2-VL-2B-Instruct | `Qwen/Qwen2-VL-2B-Instruct` | Apache-2.0 | Direct predecessor to Qwen2.5-VL; smaller dynamic-resolution VLM. |
| InternVL2-2B | `OpenGVLab/InternVL2-2B` | MIT + InternLM notice | Same architecture family as InternVL2-8B; fastest in the slate. |
| MiniCPM-V-2.0 (2.4B) | `openbmb/MiniCPM-V-2` | MiniCPM Model License | Same license friction as 2.6. Smaller footprint. |

Switching to a 2B requires re-running the holdout eval gates in
corpus-strategy.md §7 with adjusted accuracy floors — a 2B will not
match an 8B on the cockpit lane, and the operator records the new
floor explicitly in `RECEIPTS.md`.

## 8. Pin / pull receipt template

When the build day arrives and the operator pulls the default, the
following receipt is appended to `RECEIPTS.md`. Every field must be
filled with real output — none of it inferred.

```text
[minieyes-base-pull]
disclosure_id: ATOM-MINIEYES-BASE-2026-0624
operator: atom.mccree
pulled_at: <ISO-8601 timestamp from `date -Iseconds`>
candidate: A
hf_repo: Qwen/Qwen2.5-VL-7B-Instruct
hf_revision_sha: <40-char SHA from `huggingface-cli scan-cache` after pull>
license_text_sha256: <sha256 of the LICENSE file in the pulled repo>
disk_path: C:/AtomEons/Orange5/16-TRAINING/minieyes/base/qwen2.5-vl-7b-instruct/
disk_size_bytes: <`du -sb` output>
weight_file_sha256_list:
  - <file>: <sha256>
  - ...
quantization_intent: NF4 (training) → GPTQ-4bit (release)
moms_law_signoff: <atom signs here>
```

No promotion step (corpus-strategy.md §8) proceeds without this receipt
in `RECEIPTS.md`.

## 9. Re-evaluation triggers

This decision is re-opened — without ceremony, by anyone in the
operator's chair — if any of the following becomes true:

- Qwen releases a Qwen3-VL 7B tier with Apache-2.0 weights and at-or-above
  Qwen2.5-VL grounding numbers. (Strong likelihood within the next 6–12
  months; the operator should sniff-test on release day.)
- The MiniCPM Model License changes to remove the commercial
  registration step.
- A LLaVA-OneVision successor publishes structured-output benchmarks
  surpassing Qwen2.5-VL on form / receipt extraction.
- The primary visual stack (GLM-4.6V + Playwright + Chrome DevTools)
  stops failing in the way that motivated MiniEyes — in which case the
  entire MiniEyes program is paused, and this document along with it.

## 10. What this document is not

- It is not a promise to build MiniEyes. The corpus-strategy.md §0
  precondition still holds: primary visual stack must demonstrably fail.
- It is not a license review. The license summaries here are quotes /
  paraphrases of the model cards as of the cutoff date; the operator
  re-reads the actual license at build time.
- It is not a benchmark sheet. Numbers cited in §5 are the model cards'
  own claims, not measurements MiniEyes has independently reproduced.
  Real numbers go into `RECEIPTS.md` after the first holdout run.
- It is not a base-model lock-in. The "default" word in §6 means
  "where the build script points if no flag is passed." The operator
  can override at any time with a one-line config change.

---

*Authored under Mom's Law. No padding, no theater. Every section earns
its place. No hallucinated SHAs, no hallucinated license clauses, no
hallucinated benchmark numbers. The cites point at real model cards the
operator can open in a browser and verify before pulling.*
