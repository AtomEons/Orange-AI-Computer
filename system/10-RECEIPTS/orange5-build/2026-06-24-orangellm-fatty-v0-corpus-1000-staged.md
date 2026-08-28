# Receipt — OrangeLLM-fatty v0 Training Corpus STAGED for Colab

**Receipt ID:** `2026-06-24-orangellm-fatty-v0-corpus-1000-staged`
**Hash chain:** #014
**Status:** `CORPUS_STAGED_1000_PAIRS_SHA_VERIFIED_AWAITING_OPERATOR_UPLOAD`
**Confidence:** 1.0 (line count + SHA verified on disk)
**Prior receipt:** `2026-06-24-one-tier-trained-architecture-locked` (#013)
**Actor:** Claude (Orange voice) via Workflow `wf_1473a1cf-19d`
**Sovereign:** Atom McCree

---

## What happened

Operator directive 2026-06-24: **"USE A WORKFLOW NOW"**. Killed the slow qwen3:0.6b generator (was at 250/1000 after ~6 min, projecting ~500-700 final) and switched to a parallel Claude-agent workflow for corpus expansion.

## Workflow shape

- **Generate phase:** 10 Claude agents in parallel, one per doctrine doc, each emitted its target pair count (40-200) as JSONL to `16-TRAINING/corpus/_tmp/<id>.jsonl`.
- **Synthesize phase:** 1 agent merged seed + all temp files, deduped, validated, trimmed to 1000, wrote final + staged + receipt + computed SHA-256.

## Generation tally

| Source | Target | Actual |
|---|--:|--:|
| seed (hand-authored) | 213 | 213 |
| master-plan | 200 | 200 |
| ae-cobra-spec | 150 | 150 |
| orangeeye-spec | 120 | 120 |
| receipts-chain | 120 | 120 |
| month-plan | 90 | 90 |
| codex-brief | 90 | 90 |
| colab-pattern | 70 | 70 |
| codexa-preflight | 60 | 60 |
| naming-canon | 50 | 51 |
| not-green-ledger | 50 | 50 |
| **Total raw (seed + generated)** | **1213** | **1214** |
| Dropped duplicates | — | 13 |
| Dropped invalid (no Orange5 concept) | — | 165 |
| Dropped invalid (output < 30 chars) | — | 20 |
| Dropped fake-green (`green_assumed`) | — | 2 |
| **Final after dedup + validation** | **1000** | **1000** |

## Artifacts on disk

| File | Lines | SHA-256 |
|---|--:|---|
| `16-TRAINING/corpus/orangellm-fatty-v0-corpus-1000.jsonl` | 1000 | `6646f6a4e177d3d7e5fdfe2ba1f9069d8ebb9d460e4ee6671e3e76cc337b196f` |
| `16-TRAINING/corpus/corpus.jsonl` (Colab-staged) | 1000 | `6646f6a4e177d3d7e5fdfe2ba1f9069d8ebb9d460e4ee6671e3e76cc337b196f` |
| `16-TRAINING/corpus/orangellm-fatty-v0-corpus-receipt.json` | — | JSON receipt with full counts + reasons |
| `16-TRAINING/corpus/_tmp/*.jsonl` | — | 10 generation source files (retain for audit) |

Both `corpus-1000.jsonl` and `corpus.jsonl` have identical SHA-256. Verified line-count matches receipt declared count (1000).

## Workflow telemetry

| Metric | Value |
|---|---|
| Workflow ID | `w5w1da1d8` |
| Run ID | `wf_1473a1cf-19d` |
| Agent count | 11 (10 generators + 1 synth) |
| Subagent tokens | 905,179 |
| Tool uses | 102 |
| Duration | 1,344,477 ms (~22.4 min) |
| Status | green |

## Quality observations

- **Anti-fluff gate fired twice** — 2 generated pairs contained `green_assumed`. Validator dropped them. Mom's Law upheld.
- **165 pairs failed the Orange5-concept regex.** These were likely generic AI/architecture pairs without name-dropping a specific Orange5 entity. Possibly some were correct but the validator is intentionally strict — the bias is toward grounded, name-cited training data.
- **13 duplicate instructions across agents** — the dedup pass caught cross-agent overlap (e.g. two agents both wrote a pair starting "What is OrangeLLM?"). Acceptable rate (~1%).
- **Naming-canon over-produced by 1** (asked 50, got 51) — kept the extra; not material.

## Mom's Law alignment

- No service touched. No container killed. No upstream restarted.
- Hash chain extended (#013 → #014). Prior_receipt cited.
- Real line count on disk matches receipt-claimed count (1000 == 1000).
- SHA-256 verified against external compute (sha256sum) — matches receipt.
- Anti-fluff regex caught 2 fake-green pairs and dropped them.
- All 10 source agents named in `doctrine_files`. Auditable provenance.

## Next steps for operator

```
1. Open Colab Pro: https://colab.research.google.com
2. Upload notebook:  C:\AtomEons\Orange5\16-TRAINING\configs\orangellm-fatty-v0.ipynb
3. Runtime → Change runtime type → A100 GPU (or V100 fallback)
4. Runtime → Run all
5. When the upload cell prompts, upload BOTH:
   - corpus.jsonl   (C:\AtomEons\Orange5\16-TRAINING\corpus\corpus.jsonl)
   - orangellm-fatty-v0.yaml  (C:\AtomEons\Orange5\16-TRAINING\configs\orangellm-fatty-v0.yaml)
6. Walk away. 3-6h on A100 / 6-10h on V100. Adapter + training-receipt.json land in Drive.
```

## When Colab finishes

Claude fires `16-TRAINING/workflows/orangellm-fatty-v0.workflow.mjs` (operator-approved per current rolling consent for corpus + training Workflow scope) to:
- Retrieve adapter from Drive
- Verify SHA-256 against the training-receipt
- Run 5-dimension bakeoff vs stock qwen3:30b-a3b
- Write hash-chained promote/hold/reject receipt (#015)
- Surface verdict + ask operator for promotion approval

## Rollback

```powershell
# Corpus is file-only — to revert, delete the three artifacts and the temp dir.
Remove-Item -Force C:\AtomEons\Orange5\16-TRAINING\corpus\orangellm-fatty-v0-corpus-1000.jsonl
Remove-Item -Force C:\AtomEons\Orange5\16-TRAINING\corpus\corpus.jsonl
Remove-Item -Force C:\AtomEons\Orange5\16-TRAINING\corpus\orangellm-fatty-v0-corpus-receipt.json
Remove-Item -Recurse -Force C:\AtomEons\Orange5\16-TRAINING\corpus\_tmp
# The seed at orangellm-fatty-v0-seed-200.jsonl is the canonical 213 hand-authored pairs and stays.
```

## Hash chain

#014. Prior: #013 (1-tier-trained-architecture-locked). Next expected: #015 (post-Colab bakeoff result).

---

**Mom is watching. 1000 pairs. Verified line count. Verified SHA. Ready for the operator to fire Colab.**
