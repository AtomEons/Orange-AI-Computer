# PR-04 — `orangellm-heavy` Spec

**PR ID:** Orange5/PR-04
**Branch name:** `orangellm-heavy`
**Status:** EXECUTING
**Prior PR:** PR-03 `orangellm-light` (closed, code green, upstream pending operator)

---

## Goal

Spec and scaffold the **fatty heavy OrangeLLM** on Codexa. Designate the heavy model. Define the training corpus. Define the LoRA training pipeline. Probe upstream paths. Wire the gateway to route heavy queries when operator opens the lane.

PR-04 is mostly **specification** + scaffold. Actual training and live serving are downstream operator-run jobs (Codexa has no GPU — LoRA happens on cloud GPU later).

## What this PR ships

1. **Heavy model selection** at `16-TRAINING/pipeline/HEAVY_MODEL_SELECTION.md`:
   - Default: **`qwen3:30b-a3b`** (already warm on Codexa per `active_council` pulse)
   - Upgrade path: custom 70B LoRA fine-tuned on Orange5 system corpus (cloud GPU)
2. **Training corpus manifest** at `16-TRAINING/corpus/CORPUS_MANIFEST.md`:
   - Lists every source file feeding OrangeLLM training (per Master Plan §5)
   - Explicitly excludes STRONGARM / Gremlin (those train the future AE Misfit Model)
3. **LoRA pipeline spec** at `16-TRAINING/pipeline/LORA_PIPELINE_SPEC.md`:
   - Tool stack (Axolotl / Unsloth candidate)
   - Cloud GPU lane options
   - Training receipts + bakeoff requirement
4. **Updated `upstream.mjs`** — heavy tier wired with two candidate paths:
   - Direct Ollama at `10.0.99.1:11434` (preferred if reachable)
   - Codexa command rail proxy at `10.0.99.1:8097` (fallback)
5. **Heavy upstream probe** at `06-ORANGELLM/tests/heavy-probe.mjs` — checks both paths.
6. **Training README** at `16-TRAINING/README.md` — operator overview.

## What this PR does NOT do

- Does NOT start LoRA training (no GPU here; cloud GPU lane is a separate provisioning step).
- Does NOT install models on Codexa (qwen3:30b-a3b is already warm per status).
- Does NOT auto-start the gateway server.
- Does NOT modify the running Ollama on Codexa.

## Hard facts (from prior orangebox status)

| Codexa state | Value |
|---|---|
| Host | AI Box, Intel Ultra 9 285H, 16 cores, 95.6 GB RAM, no NVIDIA GPU |
| Direct IP | `10.0.99.1` |
| LAN IP | `10.0.0.4` |
| Warm models (always-on) | `qwen3:30b-a3b`, `dolphin3:8b`, `qwen3:4b` |
| Event-armed | `mistral-small:24b`, `deepseek-r1:32b`, `llama3.1:8b-abliterated` |
| Warrant-only | `llama3.3:70b`, `deepseek-r1:70b` |
| Free RAM | 70.7 GB |
| Ollama process | running, low load |
| Command rail | `10.0.99.1:8097` |

`qwen3:30b-a3b` is the natural default fatty — already warm, ~17 GB RAM footprint at Q4, leaves 60+ GB headroom for browser workers + Docker stack.

## Risk

| Risk | Mitigation |
|---|---|
| Direct Ollama port `:11434` not reachable from N150 | Probe finds out; if blocked, fall back to command-rail proxy |
| Heavy query saturates Codexa | RAM headroom is huge (70 GB free); concurrent caps in routing-policy |
| Operator hasn't approved heavy lane | Gateway returns 403 `heavy_lane_not_authorized` until operator opens it in Settings |

## Rollback

```powershell
Remove-Item -Force "C:\AtomEons\Orange5\06-ORANGELLM\PR-04-SPEC.md"
Remove-Item -Recurse -Force "C:\AtomEons\Orange5\16-TRAINING"
Remove-Item -Force "C:\AtomEons\Orange5\06-ORANGELLM\tests\heavy-probe.mjs"
# Revert upstream.mjs to PR-03 light-only state
```

## Next PR

**PR-05 `flow-direct`** — Full Flowstate runtime (currents / agents / deltas / governors). 41 KB doctrine implemented at `05-FLOW/`. SQLite-backed.
