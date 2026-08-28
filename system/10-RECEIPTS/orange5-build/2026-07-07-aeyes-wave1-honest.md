# AEyes¹ Wave 1 — honest baseline established

**Date:** 2026-07-07
**Follows:** [2026-07-07-aeyes-CORRECTION-honest-rescore.md](2026-07-07-aeyes-CORRECTION-honest-rescore.md) (seq=51)
**Wave:** 1 of 3 in AE7-directed remediation
**Doctrine:** Mom's Law · receipts or it did not happen · no fake-green

## What Wave 1 did

Instead of shipping the 16/16 smoke test as "verified," Wave 1 built the tools to measure what AEyes¹ actually does. Four sub-tasks:

- **Wave 1a — Held-out validator** ([prove-heldout.mjs](../../07-VISUAL/structural/identity/prove-heldout.mjs))
- **Wave 1b — Scaling attack harness** ([scaling-attack.mjs](../../07-VISUAL/structural/identity/scaling-attack.mjs))
- **Wave 1c — Per-concept ceilings + second-nearest confidence** ([recognize-human-grade.mjs](../../07-VISUAL/structural/identity/recognize-human-grade.mjs))
- **Wave 1d — Spine adapter** ([aeyes-spine-adapter.mjs](../../07-VISUAL/adapters/aeyes-spine-adapter.mjs))

## Wave 1a — Temporal held-out validation

Train on FIRST-half video frames, test on SECOND-half. No frame is ever both trained and tested. 20 frames total per video, 10 train / 10 test.

| Bucket | Correct | Confident-wrong |
|---|---|---|
| Orange held-out video frames | **10 / 10** (100%) | 0 |
| Apple held-out video frames | **10 / 10** (100%) | 0 |
| Reject fixtures | **10 / 10** (100%) | 0 |
| Original static images (cross-source) | 1 / 3 (33%) | 0 |
| **Total** | **31 / 33 (94%)** | **0** |

**Interpretation:**
- **Temporal generalization within the same video: 100%.** The recognizer trained on frames 0–9 correctly identifies the same object in frames 10–19 that it has never seen.
- **Reject discipline: 100%.** Every out-of-distribution image emits `needs_review`.
- **Cross-source generalization: 33%.** When trained only on video, static image versions of the same concept ("orange.jpg" and "fruits.jpg") don't match within ceiling 1.8. They move to `needs_review` — honestly unknown, not confidently wrong.
- **Confident-wrong under a real independent metric: 0** — the honest-unknown mechanism holds.

## Wave 1b — Empirical concept capacity

Scaling attack incrementally adds synthetic concepts (hue-rotated variants of the orange signature) and after each addition measures:
1. Inter-concept min pairwise `richDistance`
2. Baseline recognition on the 3 genuine held-out targets (orange.jpg, apple.jpg, fruits.jpg)

| Metric | Value |
|---|---|
| Baseline inter-concept min-distance (5 concepts) | **1.974** (orange ↔ apple) |
| Operating margin under ceiling 1.8 | **0.174** |
| Concepts added before first collision | **0** (first 10° hue-rotated synthetic already at 0.281 from orange) |
| Concepts added before baseline recognition broke | **0** (dropped 3/3 → 1/3 at N=6) |
| **Empirical capacity under this design (synthetic-worst-case)** | **N = 5** |

**Interpretation:** With the current global ceiling 1.8 and hue-rotated adversarial synthetics, the substrate holds exactly 5 concepts. This is the FLOOR. Real distinct concepts (different textures, subjects, edges) should scale further — Wave 2 will measure the ceiling.

Trace file: `07-VISUAL/fixtures/perfect-eyes/scaling-attack-trace.json`

## Wave 1c — Per-concept ceilings + second-nearest confidence

Two additive AE7 fixes:

1. **`row.reject_ceiling`** on each store row can override the global `HUMAN_GRADE_CEILING`. Concepts with denser fingerprint neighborhoods can carry tighter ceilings. Backward-compatible — rows without the override use the global.
2. **`confidence = 1 - bestDist / secondBestDist`** where second-best is from a DIFFERENT concept. Now `confident-wrong` has an independent definition instead of being a mechanical restatement of `correct` (AE7 finding #4).

The recognizer's return shape now includes `second_dist`, `second_winner`, `confidence`, and `ceiling_used`. Existing consumers (`prove-human-grade.mjs`, `prove-heldout.mjs`) continue to work — only additive fields added.

## Wave 1d — Spine adapter

New file [aeyes-spine-adapter.mjs](../../07-VISUAL/adapters/aeyes-spine-adapter.mjs) exports:

- `executeAeyesRecognize(order)` — takes an order with `payload.{image_path, store, opts}` and returns `orange.report.v1`-shaped output.
- `AEYES_RECOGNIZE_ACTION = "aeyes.recognize.v1"` — canonical action verb.
- `registerWithSpine(dispatcher)` — one-line spine registration.

Smoke test [test-aeyes-spine-adapter.mjs](../../07-VISUAL/adapters/test-aeyes-spine-adapter.mjs) — **passed**:
- orange.jpg → `status: "ok"`, `summary: "recognized_as orange (dist=0.000, confidence=1.000, ceiling=1.8)"`
- gradient.png → `status: "needs_review"`, `emit_action: "needs_review"`

AEyes¹ is now callable through the same spine primitive as any other action verb.

## The revised honest picture

**What Wave 1 shows AEyes¹ IS at this point:**
- Temporal generalization within a source: **100%** (10/10 held-out orange + 10/10 held-out apple frames)
- Reject discipline: **100%** (10/10)
- Confident-wrong under real independent metric: **0**
- Spine-callable via `aeyes.recognize.v1`
- Per-concept ceilings supported (schema-additive, no consumer changes)

**What Wave 1 shows AEyes¹ IS NOT yet:**
- Cross-source robust — video-trained fingerprints match ~33% of static images of the same concept. Needs multi-source training (Wave 2).
- Scaled beyond ~5 concepts. Adversarial synthetics break at N=6. Real distinct concepts likely scale higher — measurement pending (Wave 2).
- Immune to concept-collision — global-ceiling fragility acknowledged; per-concept ceilings shipped but not tuned.

## Wave 2 — in flight

YouTube ingest pipeline (`youtube-corpus-ingest.mjs`) launched with 30-concept batch (`concepts-wave2-batch1.json`).
Downloads short CC-licensed clips per concept, extracts frames, builds signatures, saves to identity-store-v2 JSON.
Currently running — orange_fruit through sunflower across fruit/animal/vehicle/nature/household/building categories.

Wave 2c will run held-out validation on the resulting N=30 store. That number is the honest scaling measurement AE7 asked for.

## Standing verifiability

```bash
bun 07-VISUAL/structural/identity/prove-heldout.mjs        # 31/33, 0 confident-wrong
bun 07-VISUAL/structural/identity/scaling-attack.mjs       # empirical capacity trace
bun 07-VISUAL/adapters/test-aeyes-spine-adapter.mjs       # spine adapter smoke test
```

All deterministic. All Bun-native. All zero paid-dep.

Mom is watching. No fake-green.
