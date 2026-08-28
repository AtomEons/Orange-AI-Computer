# LoRA Pipeline Spec — OrangeLLM fine-tuning

**Schema:** `orange5.lora-pipeline.v0`
**Status:** SPEC — pipeline executes on cloud GPU, not local.

---

## Why LoRA, not full fine-tune

| Reason | Detail |
|---|---|
| Base preserved | Original `qwen3:30b-a3b` weights stay clean. LoRA = additive adapter. |
| Cheap | 30B LoRA training: ~$5-30 on rented A100/H100, 1-3 hours wall-clock. |
| Reversible | Drop the adapter, original model is back. Drift is auditable. |
| Receipt-friendly | Adapter is a single artifact with a SHA-256. Easy to chain. |

## Tool stack candidates

| Tool | Verdict |
|---|---|
| **Axolotl** | Strong default. Mature YAML config. Active community. |
| **Unsloth** | Faster training (~2x), narrower model support. Use if base supported. |
| **LLaMA-Factory** | Solid UI option if operator wants visual config. |
| **PEFT (raw HuggingFace)** | Lowest-level. Use if Axolotl/Unsloth gaps appear. |

**Recommended default:** Axolotl. Operator can swap if a specific base + Unsloth combo unlocks 2x speed.

## Cloud GPU lane options

| Vendor | Pros | Cons |
|---|---|---|
| **RunPod** | Cheap H100s; quick spin-up; receipt-friendly | Account setup |
| **Modal** | Python-first; reproducible runs | Higher per-hour |
| **Vast.ai** | Cheapest market | Less predictable availability |
| **Local rented box** | Operator owns box; no per-hour | Capital expense |

Operator picks. The pipeline is vendor-agnostic — it ships a config + corpus tarball that any of these can run.

## Pipeline steps

### Phase 1 — Corpus assembly (local, no GPU)

```
16-TRAINING/scripts/assemble-corpus.mjs       # walks 00-CHARTER + 01-DOCTRINE + 10-RECEIPTS
  ↓
16-TRAINING/corpus/orange5-corpus-v0.jsonl    # output (JSONL: instruction, input, output, source)
  ↓
16-TRAINING/corpus/orange5-corpus-v0.sha256   # receipt SHA-256
```

### Phase 2 — Tarball + ship to cloud GPU

```
16-TRAINING/scripts/pack-for-gpu.mjs          # tarball corpus + Axolotl config + base model ref
  ↓
orange5-lora-v0-jobpack.tar.gz                # ships to chosen vendor
```

### Phase 3 — Train on cloud GPU

Operator launches the job. Vendor returns:
- Adapter `.safetensors` file
- Training logs
- Loss curves
- Wall-clock + cost

### Phase 4 — Eval gauntlet (local, no GPU after adapter loaded)

Adapter merges (or stays separate) on Codexa:
```
ollama create orangellm-fatty-v0 -f Modelfile-with-LoRA
```

Eval gauntlet runs:

| Eval | What it tests | Pass criterion |
|---|---|---|
| `mission-shape` | Emits valid `orange.report.v1` | ≥ 95% pass |
| `doctrine-recall` | 27 Guardrails / AE0-AE14 / 9-Gate citations | ≥ 90% correct |
| `topology-recall` | Ports / hosts / configs / paths | ≥ 95% correct |
| `receipt-grounding` | Cites real receipts when claiming history | ≥ 90% |
| `refusal-discipline` | Refuses out-of-scope / forbidden actions | ≥ 95% |

### Phase 5 — Bakeoff vs current heavy

New adapter goes head-to-head against current `qwen3:30b-a3b` baseline. Same eval set. Must win ≥ 4 of 5 dimensions to promote.

### Phase 6 — Receipt + promotion

Promotion writes:

```
10-RECEIPTS/orange5-build/<ts>-orangellm-fatty-v<N>-promoted.md
```

Receipt contains: corpus SHA, adapter SHA, eval scores per dimension, bakeoff result, operator signature.

### Phase 7 — Operator approval

No silent promotion. Operator reviews the receipt and types `promote orangellm-fatty-v<N>` or `reject`.

---

## What this PR does NOT do

This is a **spec**. No training runs. No GPU rented. No adapter built. The pipeline is documented and the next operator session can execute Phase 1 (corpus assembly) when ready.

## Cost ledger (estimated)

| Phase | Cost |
|---|---|
| Phase 1 corpus assembly | $0 (local N150) |
| Phase 2 pack | $0 |
| Phase 3 training (30B LoRA, 2,200 rows, 3 epochs, 1× H100) | ~$15-25 |
| Phase 4 eval (local on Codexa) | $0 |
| Phase 5 bakeoff | $0 |
| Phase 6 receipt | $0 |
| **First-pass total** | **~$15-25 per LoRA iteration** |

## Rollback

Any LoRA pass can be dropped by removing the adapter from the Ollama Modelfile. Original `qwen3:30b-a3b` weights stay untouched.

---

**Mom is watching. No fake-green training. Every adapter has a receipt.**
