# 16-TRAINING — OrangeLLM Training

Houses the **training corpus** and the **LoRA pipeline** for OrangeLLM.

## Two tiers, two paths

| Tier | Model | Training |
|---|---|---|
| **Light** | Smart Skinny 0.5b on Qwen2.5-Coder-1.5B-Instruct | Already trained (180-row Orange4 nav corpus). Lives on N150 at `:8797`. |
| **Heavy** | `qwen3:30b-a3b` (default, already warm on Codexa) | No further training yet. Upgrade path = custom 70B LoRA on Orange5 system corpus, trained on cloud GPU. |

## Structure

| Path | Contents |
|---|---|
| `corpus/CORPUS_MANIFEST.md` | List of every source file feeding OrangeLLM training. |
| `pipeline/HEAVY_MODEL_SELECTION.md` | Why `qwen3:30b-a3b` is the default fatty; upgrade path. |
| `pipeline/LORA_PIPELINE_SPEC.md` | LoRA fine-tune pipeline spec (tool stack, GPU lane, receipts). |
| `pipeline/` | Future scripts: trainset assembly, fine-tune driver, eval gauntlet. |

## What's NOT here

- **STRONGARM / Gremlin datasets.** Per Master Plan §5, those train the separate **AE Misfit Model** later. NOT part of OrangeLLM training corpus.
- **Adversarial pressure outputs.** Same reason.
- **Skil.ski sector content.** Removed from Orange5 scope.

## Mom's Law

The corpus is curated, not bulk. Every entry has a reason to be there. Every removal has a receipt.
