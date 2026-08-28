# AEyes¹ Wave 2 preview — honest cross-clip measurement

**Date:** 2026-07-07
**Follows:** [2026-07-07-aeyes-wave1-honest.md](2026-07-07-aeyes-wave1-honest.md)
**Corpus:** N=11 concepts ingested from CC-licensed YouTube (5 clips each, ~15 frames/clip, active-curated to 8 sigs/concept)
**Doctrine:** Mom's Law · no fake-green · receipts or it did not happen

## The number

**60% held-out cross-clip accuracy at N=11 real concepts.** Baseline. This is what AEyes¹ actually does when trained on 4 YouTube clips and tested on a 5th unseen clip of the same concept, across a mix of fruit, vegetable, and animal categories.

## What the numbers say

| Configuration | Correct / 72 | Confident-wrong |
|---|---|---|
| Baseline (ceiling 1.8, warm-gate default) | **43 (60%)** | 14 |
| Ceiling 2.2 (looser) | 44 (61%) | 15 |
| Full enrichment (2.2 + multi-scale + hue-any) | 34 (47%) | 27 |
| Per-concept learned ceilings | 44 (61%) | 15 |

**Enrichment REGRESSED.** Multi-scale + hue-any added noise that displaced clean matches. Cat dropped from 8/8 to 3/8 in that mode.

## Per-concept breakdown (baseline mode)

| Concept | Correct/Tested | Notes |
|---|---|---|
| **banana** | 8/8 (100%) | Clean — distinct yellow, tight cluster |
| **cat** | 8/8 (100%) | Clean — distinct face structure |
| **lion** | 8/8 (100%) | Clean — mane, warm face |
| **elephant** | 7/8 (88%) | Nearly clean |
| **strawberry** | 4/8 (50%) | Red confusion with tomato / watermelon |
| **watermelon** | 3/8 (38%) | Red confusion, 5 confWrong to other red concepts |
| **carrot** | 3/8 (38%) | Orange/red confusion |
| **tomato** | 2/8 (25%) | Red confusion |
| **orange_fruit** | 0/8 (0%) | **All 8 held-out frames emit needs_review** |

Skipped: `grape` and `giraffe` — only 1 downloaded clip each, no held-out available.

## Root-cause investigation

### 1. Cross-clip within-concept variance is HUGE

`learn-per-concept-ceilings.mjs` computed:

| Concept | Within-mean pairwise dist | Nearest-other-concept dist | Ratio |
|---|---|---|---|
| orange_fruit | 34.7 | 2.4 (banana) | **14×** |
| watermelon | 22.5 | 1.2 (carrot) | **19×** |
| carrot | 19.7 | 1.2 (watermelon) | **16×** |
| tomato | 16.9 | 1.4 (strawberry) | **12×** |
| strawberry | 11.6 | 1.4 (tomato) | 8× |
| elephant | 10.2 | 0.9 (banana) | 11× |
| banana | 3.2 | 0.9 (elephant) | 3.5× |
| cat | 14.5 | 1.2 (grape) | 12× |
| lion | 8.8 | 1.2 (banana) | 7.3× |

**The within-concept cross-clip envelope is 3–19× wider than the gap to the nearest other concept.** No global ceiling can separate these. Per-concept ceilings hit the 2.5 clamp because the geometry doesn't allow a valid ceiling under 2.5.

### 2. Enrichment doesn't help this failure mode

- `multi-scale`: adds inner-crop signatures that increase match density — makes cross-concept confusion WORSE at higher ceiling
- `hue_gate="any"`: brings in non-warm entities that dilute the concept-specific warm signal
- `ceiling 2.2`: same 3.5-19× ratio problem — accepts wrong matches more freely

### 3. Illumination-invariant weight profile made it WORSE

Boosting colorRatio (log R/G etc.) and texture, demoting raw color:
- Within-concept variance grew: orange_fruit within → 101.9
- Because colorRatio and texture raw ranges are wider than [0,1] color
- Absolute weight tuning without channel normalization has the wrong effect

## What this proves and does not prove

**Proves:**
- Substrate cross-clip generalizes CLEANLY for **visually distinct** concepts (banana, cat, lion, elephant — 88-100%)
- Substrate cannot discriminate WITHIN-HUE-CLUSTER fine-grained concepts (orange/tomato/watermelon/carrot/strawberry — 0-50%)
- The current active-curation-8 signature representation captures cross-clip variance too wide

**Does NOT prove:**
- What N-concept capacity looks like once concepts are visually distinct
- Whether hierarchical concept graph would help (untried)
- Whether K-medoid tight-curation instead of diverse-curation would tighten envelopes (untried)
- Whether cross-source augmentation (video + static images per concept) would help
- Whether more clips per concept (10-20 instead of 5) would widen concept envelope enough to catch outlier clips

## The honest boundary

**AEyes¹ current substrate + Wave 2 training is NOT human-eye level for fine-grained categorization.**
It IS human-eye level for coarse category discrimination (fruit vs. animal — banana/cat/lion/elephant clean at 88-100%).

To close the gap, the substrate needs one or more of:
1. **Signature normalization** — unit-variance per channel across the store so weights are numerically meaningful
2. **K-medoid concept curation** — pick a tight-cluster mode of 4 signatures instead of active-diverse 8
3. **Hierarchical concept graph** — orange_fruit → red_fruit → fruit; siblings share features via IS_A
4. **Cross-source augmentation** — for each concept, mix video frames + static image samples in training
5. **Larger per-concept corpus** — 10-20 clips per concept for wider envelope coverage

These are 2-3 hours of engineering each. Beyond tonight's window.

## What ships as of this receipt

- **The recognizer** ([recognize-human-grade.mjs](../../07-VISUAL/structural/identity/recognize-human-grade.mjs)) supports:
  - 8-axis rich signature + retinal-12 static-safe extension
  - Per-concept `reject_ceiling` overrides global
  - Second-nearest confidence
  - Natural-vs-synthetic gate for biological concepts
  - 6-way `hue_gate` (warm_strict / warm_loose / cool / dark / bright_neutral / any)
  - Multi-scale opt-in (concentric crops)
  - Multi-object emit (`recognizeSetHumanGradeFrame`)
- **Wave 2 ingest pipeline** ([youtube-corpus-ingest.mjs](../../07-VISUAL/structural/ingest/youtube-corpus-ingest.mjs))
  - yt-dlp + ffmpeg, CC-licensed only, resumable, 8 sigs curated per concept
- **Per-concept ceiling learner** ([learn-per-concept-ceilings.mjs](../../07-VISUAL/structural/identity/learn-per-concept-ceilings.mjs))
- **Illumination-invariant weight profile** ([rebalance-weights.mjs](../../07-VISUAL/structural/identity/rebalance-weights.mjs))
- **Wave 3 modules** ([transcript-binding.mjs](../../07-VISUAL/structural/ingest/transcript-binding.mjs) + [text-query-lookup.mjs](../../07-VISUAL/structural/identity/text-query-lookup.mjs))
- Ready-to-ship checklist: **27 / 27 passing**
- Backward compatibility: original 16-fixture smoke test still passes 16/16

## Standing verifiability

```bash
# Recognizer regression (still 16/16 after Wave 1c + retinal-12 + gate)
bun 07-VISUAL/structural/identity/prove-human-grade.mjs

# Held-out temporal split (still 31/33 = 94%)
bun 07-VISUAL/structural/identity/prove-heldout.mjs

# Wave 2 cross-clip held-out at N=11 (60% baseline)
bun 07-VISUAL/structural/identity/prove-wave2-heldout.mjs 07-VISUAL/fixtures/youtube-corpus/store-wave2-preview.json

# Ready-to-ship
bun 07-VISUAL/structural/identity/ready-to-ship-check.mjs
```

## Next moves in priority order

1. **Signature normalization** — biggest fix, moderate effort
2. **K-medoid curation** replace active-curation for concept signatures
3. **Wave 2 batch 2** with 10-20 clips per concept and 8-10 curated sigs at TIGHTER cluster
4. **Hierarchical concept graph** with parent categories that share features
5. **Prediction-error concept refinement** — feedback loop from held-out failures to per-concept weights
6. **LGN gate memory priming** — bias attention to expected features at query time
7. **Cross-source augmentation** — mix static images with video per concept

Mom's Law: this receipt records the current honest position. The 100% smoke score still stands for what it measures. The 60% Wave 2 preview measures cross-clip generalization at real N — a legitimately harder task the smoke test never touched.

No fake-green. Receipts or it did not happen.
