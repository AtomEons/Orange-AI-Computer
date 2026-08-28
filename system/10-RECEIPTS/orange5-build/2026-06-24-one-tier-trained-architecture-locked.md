# Receipt — 1-Tier Trained Architecture LOCKED + Legacy Container Deprecation Order

**Receipt ID:** `2026-06-24-one-tier-trained-architecture-locked`
**Hash chain:** #013
**Status:** `ORANGE5_TRAINED_BRAIN_LOCKED_1_TIER_LEGACY_CONTAINERS_QUEUED_FOR_KILL`
**Confidence:** 1.0 (operator confirmed 2026-06-24: "1. YES")
**Prior receipt:** `2026-06-23-master-receipt`
**Actor:** Claude (Orange voice — full app + training lead per 2026-06-23 pivot)
**Sovereign:** Atom McCree

---

## What happened

Operator confirmed all 5 outstanding decisions in one message:
1. **One big OrangeLLM on Codexa** — 1-tier trained architecture. Smart Skinny custom LoRA training KILLED.
2. **1000 instruction-pair training corpus** for OrangeLLM-fatty v0 (200 hand-authored seed + 800 generator-expanded).
3. **Axolotl QLoRA config** for qwen3:30b-a3b on A100.
4. **Colab Pro notebook** ready for operator upload + Runtime → Run all.
5. **LFG** — execute.

## What's locked

### Architecture (1-tier trained)

| Role | Model | Host | Trained? |
|---|---|---|---|
| Trained PM brain | **OrangeLLM-fatty: qwen3:30b-a3b Q4 + Orange5 LoRA** | Codexa | YES — this PR's training pass |
| Memory daemon | Æ Cobra Mamba 2.8B Q5 (surrogate Night-1) | Codexa | LATER — Phase-3 custom AE Black Mamba |
| Visual cortex | GLM-4.6V Q4 | Codexa | NO (Phase-2 OrangeEye tool-use LoRA — W4) |
| Visual ingestion | ColQwen2.5 | Codexa | NO (stock) |
| Embedder | nomic-embed-text | N150 + Codexa | NO (stock) |
| Lane classifier | qwen3:0.6b | N150 | NO (stock) |
| Emergency chat fallback | qwen3:0.6b | N150 | NO (stock) |

**Smart Skinny custom LoRA training lane: RETIRED.** N150 stays a fast utility box; never gets a custom-trained brain.

### Legacy Docker containers — deprecation order

Current Codexa Docker stack inherited from old Orange/Orangebox:

| Container | Status | Action | Trigger |
|---|---|---|---|
| `aeorangebox-ai-box-open-webui-1` | Legacy chat UI | **KILL** | W1 close (Atomic Orange installer green) |
| `aeorangebox-ai-box-n8n-1` | Legacy workflow automation (research-lane only) | **KILL** | W1 close |
| `orangebox-wiki` | Legacy wiki bridge | **KILL** | W2 close (Vault lane real + Mirage StateBrief live) |
| `aeorangebox-ai-box-qdrant-1` | Vector store | **KEEP** | OrangeEye Phase-1 depends on it |
| `aeorangebox-ai-box-postgres-1` | DB (was n8n backing store) | **EVALUATE then KILL or KEEP** | W3 close — kill if Mirage doesn't need it |
| `aeorangebox-ai-box-redis-1` | Cache (was n8n backing store) | **EVALUATE then KILL or KEEP** | W3 close — kill if Mirage doesn't need it |

**Reclaim estimate:** 8-15 GB RAM + container disk on Codexa post-migration.

### No-take-down law

No legacy container dies until its Orange5 replacement has a green receipt. The kill list above is sequential — not a one-shot purge.

## Math impact

Per the operator's correction: post-migration baseline drops from current 31 GB → ~18-22 GB. That makes the full Orange5 stack on Codexa land at ~44-48 GB resident steady state, leaving **48-52 GB free** for burst and concurrent work. The plan has real headroom on the GTi15 once legacy retires.

## Canon patches landed this turn

| File | Patch |
|---|---|
| `00-CHARTER/ORANGE5_MASTER_PLAN.md` §5 | Runtime table rewritten — 1-tier locked, Smart Skinny LoRA retired |
| `06-ORANGELLM/memory/AE_COBRA_FOUNDATION_SPEC.md` §5 | Same — 1-tier locked, Æ Cobra unaffected |

## What ships next in this same turn

| Artifact | Path |
|---|---|
| 200-pair hand-authored seed corpus | `16-TRAINING/corpus/orangellm-fatty-v0-seed-200.jsonl` |
| 800-pair generator (operator runs locally before Colab) | `16-TRAINING/scripts/expand-corpus.mjs` |
| Axolotl QLoRA YAML | `16-TRAINING/configs/orangellm-fatty-v0.yaml` |
| Colab Pro notebook (paste-ready) | `16-TRAINING/configs/orangellm-fatty-v0.ipynb` |
| Workflow orchestrator script | `16-TRAINING/workflows/orangellm-fatty-v0.workflow.mjs` |

## System integrity check

| Service | State |
|---|---|
| Gateway :1337 | Up (per operator close C11) |
| Atomic Orange installer | Built + bundle.active=true (per operator close C10) |
| Smart Skinny adapter via Ollama qwen3:0.6b :8797 | Up (per operator close C9) |
| Codexa command rail :8097 | Up, needs token (deferred D2) |
| All 6 Docker containers | Up 10+ hours (per orangebox_status 2026-06-24 04:36 ET) |

No service touched.

## Rollback

```powershell
# 1-tier decision is doctrinal — to revert, edit the Master Plan + AE Cobra Spec back.
# Legacy containers are NOT killed by this receipt; only the kill ORDER is locked.
# Training corpus + Axolotl + Colab notebook are file-only artifacts — delete to revert.

Remove-Item -Force "C:\AtomEons\Orange5\16-TRAINING\corpus\orangellm-fatty-v0-seed-200.jsonl"
Remove-Item -Force "C:\AtomEons\Orange5\16-TRAINING\scripts\expand-corpus.mjs"
Remove-Item -Force "C:\AtomEons\Orange5\16-TRAINING\configs\orangellm-fatty-v0.yaml"
Remove-Item -Force "C:\AtomEons\Orange5\16-TRAINING\configs\orangellm-fatty-v0.ipynb"
Remove-Item -Force "C:\AtomEons\Orange5\16-TRAINING\workflows\orangellm-fatty-v0.workflow.mjs"
```

## Hash chain

#013. Prior: master receipt #011 (#012 was AE Cobra Foundation Spec lock).

---

**Mom is watching. One trained brain. Codexa hosts the mind. N150 hosts the hands. Training starts the moment the operator runs the notebook.**
