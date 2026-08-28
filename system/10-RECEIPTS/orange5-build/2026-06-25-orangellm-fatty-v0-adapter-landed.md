# Receipt — OrangeLLM-fatty v0 Adapter LANDED + Verified

**Receipt ID:** `2026-06-25-orangellm-fatty-v0-adapter-landed`
**Hash chain:** #025
**Status:** `ORANGELLM_FATTY_V0_ADAPTER_LANDED_AND_VERIFIED_AWAITING_OLLAMA_PROMOTION`
**Confidence:** 1.0 (adapter SHA matches training-receipt + loss curve verifies real training)
**Prior receipt:** `2026-06-24-five-workflows-burst-summary` (#024)
**Actor:** Claude (Orange voice) post-Colab inspection
**Sovereign:** Atom McCree

---

## What happened

Operator returned with `C:\AtomEons\Orange5\16-TRAINING\orangellm-fatty-v0-adapter (2).zip` — the trained adapter pulled from Colab. Unzipped to `16-TRAINING/adapters/orangellm-fatty-v0/`. Verified the adapter is real (537 MB safetensors), SHA-bound, with a clean loss curve.

## Verification facts

| Field | Value |
|---|---|
| Zip size | 2.72 GB |
| Files in zip | 40 (two checkpoints + receipt) |
| Final checkpoint | `adapter/checkpoint-375/` (end of 3 epochs) |
| Intermediate | `adapter/checkpoint-125/` (end of epoch 1) |
| **Final adapter SHA-256** | `852d3386d995a19b06485dcfb5afd161caa6c4301cfb1d7b94e295ea132c7fd7` |
| Adapter size | **537.0 MB** (536,991,984 bytes) |
| Base model (per adapter_config.json) | **`unsloth/qwen2.5-32b-instruct-bnb-4bit`** |
| Architecture | `Qwen2ForCausalLM` |
| LoRA rank / alpha | 16 / 32 |
| LoRA dropout | 0.05 |
| PEFT type | LORA |
| Unsloth-patched | true |

## Loss curve (3 epochs × 125 steps = 375 total)

```
step   5  loss 5.9461  lr 4.21e-05   (warmup, near-random init)
step  45  loss 1.5591  lr 1.98e-04   (steep fit — corpus pattern learned)
step  85  loss 1.3342  lr 1.84e-04
step 125  loss 1.2827  lr 1.60e-04   ← end of epoch 1
step 165  loss 0.9322  lr 1.29e-04
step 205  loss 0.9524  lr 9.38e-05   (brief plateau, healthy)
step 245  loss 0.8830  lr 5.97e-05
step 285  loss 0.5031  lr 3.05e-05   (second steep drop)
step 325  loss 0.4368  lr 9.96e-06
step 365  loss 0.4656  lr 4.71e-07
step 375  loss 0.4291  lr 3.89e-09   ← FINAL
```

**13.9× loss reduction.** Cosine LR schedule played out cleanly. No spike-divergence. Final 0.43 is a healthy instruction-tuning landing.

## Honest discrepancy noted

The auto-generated `training-receipt.json` at zip root says `"base": "Qwen/Qwen3-30B-A3B-Instruct"`. This is **stale text from the receipt template** I authored before patching cell-14 of the notebook. The actual base model loaded by Unsloth (verified in `adapter_config.json`) is `unsloth/qwen2.5-32b-instruct-bnb-4bit`. The training itself was correct against Qwen2.5-32B; only the receipt-printer string was outdated. This receipt (#025) supersedes that detail.

## What this adapter has learned

The 1000-pair corpus that trained this adapter contains references to `qwen3:30b-a3b` throughout (the "wrong self-fact" gap I flagged in receipt #018). So the trained model:
- KNOWS Orange5 doctrine: four pillars, four laws, AE0-AE14 departments, Mom's Law, Frontier-Isolation, Codeless, 9-Gate Stack, hash-chained receipts, sovereign = Atom McCree
- KNOWS the Æ Cobra memory architecture, OrangeEye visual stack, Hermes leases, Mirage data plane, AtomSmasher modules
- KNOWS port numbers, file paths, schemas
- **MAY HALLUCINATE** that its own base is `qwen3:30b-a3b` (the corpus said so; the model can't see its own `adapter_config.json`)

This self-fact drift will surface in the bakeoff. v1 corpus will fix it.

## Adapter file layout (extracted)

```
16-TRAINING/adapters/orangellm-fatty-v0/
├── adapter/
│   ├── checkpoint-375/                  ← FINAL — promote this one
│   │   ├── adapter_model.safetensors    537.0 MB
│   │   ├── adapter_config.json
│   │   ├── tokenizer.json
│   │   ├── tokenizer_config.json
│   │   ├── chat_template.jinja
│   │   ├── optimizer.pt                 273.7 MB
│   │   ├── scheduler.pt
│   │   ├── rng_state.pth
│   │   ├── trainer_state.json
│   │   ├── training_args.bin
│   │   └── README.md
│   └── checkpoint-125/                  ← end of epoch 1 (reference)
│       └── (same 11 files)
└── training-receipt.json                ← Colab-generated (has stale Qwen3 text)
```

## Next step: Ollama Modelfile + bakeoff

Modelfile for Codexa staging at `Modelfile.orangellm-fatty-v0` (same dir as this receipt):

```dockerfile
FROM unsloth/qwen2.5-32b-instruct-bnb-4bit
ADAPTER /opt/atomeons/adapters/orangellm-fatty-v0
SYSTEM """You are OrangeLLM, the PM brain of Orange5. Mom's Law is above all rules: give full effort every time. No fake-green. No theater. Cite receipts. Refuse out-of-scope work."""
PARAMETER temperature 0.4
PARAMETER top_p 0.9
PARAMETER stop "<|im_end|>"
PARAMETER stop "<|endoftext|>"
```

Operator action on Codexa:

```bash
# 1. Copy adapter to Codexa (via rsync / scp / Drive — operator's call)
mkdir -p /opt/atomeons/adapters/orangellm-fatty-v0
cp -r checkpoint-375/* /opt/atomeons/adapters/orangellm-fatty-v0/

# 2. Build the Ollama tag
ollama pull unsloth/qwen2.5-32b-instruct-bnb-4bit  # if not already cached
cp Modelfile.orangellm-fatty-v0 /opt/atomeons/
cd /opt/atomeons
ollama create orangellm-fatty:v0 -f Modelfile.orangellm-fatty-v0

# 3. Smoke test
ollama run orangellm-fatty:v0 "What is the Frontier-Isolation Law?"
# Expect: cites OrangeLLM gateway at 127.0.0.1:1337, says frontier only reaches the gateway, no internals

# 4. Fire the bakeoff workflow (Claude side)
# Workflow({scriptPath: "C:/AtomEons/Orange5/16-TRAINING/workflows/orangellm-fatty-v0.workflow.mjs"})
# — already authored in receipt #013, runs 5-dimension bakeoff vs stock qwen2.5:32b
```

## Mom's Law alignment

- Adapter was verified via SHA before being claimed real
- Loss curve was actually inspected (75 log entries traced), not just "looks ok"
- The Qwen3 / Qwen2.5 receipt-text discrepancy was named honestly, not hidden
- Corpus self-fact drift acknowledged as a known v0 gap that will show in bakeoff
- Three-file confirmation chain: training-receipt.json hash → on-disk sha256sum → adapter_config base ref

## Rollback

```powershell
# Adapter is file-only on disk. Delete to revert.
Remove-Item -Recurse -Force C:\AtomEons\Orange5\16-TRAINING\adapters\orangellm-fatty-v0\
# Keep the zip at C:\AtomEons\Orange5\16-TRAINING\orangellm-fatty-v0-adapter (2).zip as the only artifact
```

## Hash chain

#025. Prior: #024 (five-workflows burst summary). Next expected: #026+ from the 10x workflow burst the operator just authorized.

---

**Mom is watching. The adapter is real. Loss dropped from 5.95 to 0.43. Ready for Ollama promotion + bakeoff.**
