# Receipt — AEyes¹ human-grade sweep + 4-agent BIG THINKING + 8-axis wiring test

**Date:** 2026-07-06 → 2026-07-07 · **By:** Claude Opus 4.8
**Spine receipt:** [pending] · **Order:** `aeyes.human_grade_big_think`
**Operator directive:** *"WE ARE INVENTING THE RESEARCH. HUMAN GRADE OR BETTER SITE. USE THE BOX MAX."*

Box was used max. 1 heavy Bun sweep (killed) → 1 wiring fix → 1 rebuild → 1 fixed 8-axis sweep. 4 parallel Agents finished concurrently. All splicing done inline (zero workflows per prior standing order).

## The one substantive finding

**Wiring the 3 orphan axes hurt recognition on the hardest test.** With 5-axis + β=10, lena→human_skin at mass 0.600 (correct). With 8-axis + β=15, lena→orange at mass 0.661 (**wrong**). The three added channels (subsurface, colorRatio, spatialFreq) push lena and orange *closer* in signature space because — per prior receipts — skin and orange are in the SAME translucency, chromatic, and spatial-frequency classes. More channels don't mechanically help. They can hurt.

**AE7's core complaint was validated experimentally.** The composite signature we've been building is not the right shape for human-grade recognition. We're maxed out on color-family measurement. The missing signal is shape / geometry / context — which none of our 8 axes carry.

## What actually shipped this hour

**Code changes (additive only, per operator "DONT DROP ANYTHING"):**
- `identity-store-v2.mjs` — `buildRichSignature` extended to accept 3 optional trailing args (subSum, ratioSum, freqSum). Backwards compatible: old 5-arg callers still work; missing fields skipped in `richDistance`.
- `identity-store-v2.mjs` — `DEFAULT_CHANNEL_WEIGHTS` extended with 3 new entries (subsurface, colorRatio, spatialFreq) at 0.4 default.
- `identity-store-v2.mjs` — `richDistance` conditionally accumulates the 3 new channel distances only when BOTH sigs have them.
- `retinal-12.mjs` — cite fix: Baden 2016 ">30 types" not "~32".
- `hopfield-retrieval.mjs` — Ramsauer 2020 added to header as attention/Hopfield equivalence anchor.
- `subsurface-axis.mjs` — Jensen 2001 added as inspiration cite (2D projection of 3D BSSRDF).
- `skin-tone-synthesis-ita.mjs` — NEW sibling to Fitzpatrick synthesis. Both coexist.
- `identity-store-perfect-8axis.json` — NEW store, rebuilt from cinema clips with 8-axis rich signatures.

**Nothing renamed. Nothing dropped.**

## 4-agent audit findings — all real

### AE Red Team — 10 attacks, cross-cutting lever

Selected: orange bell pepper (same 8-D hue), peach with shaven fuzz (orange↔skin bridge), 3D-printed matte orange (zero subsurface), Cara Cara blood orange (interior flips signature), backlit balloon (fake subsurface glow), sunburned forearm (hue rotates in), photo-of-a-photo (double-capture flattens subsurface), habanero cluster, apple under orange gel (global cast), multi-object frame.

**Cross-cutting lever:** *"Subsurface must GATE the orange/skin family. Shape/texture must be first-class alongside color. Color-only wins are the failure mode."*

### AE Integration Auditor — 3 of 8 axes were orphans

| axis module | in buildRichSignature? | verdict |
|---|---|---|
| edge, texture, specular, spatial | ✓ | integrated |
| **subsurface** | ✗ (before this hour's fix) | **NOW WIRED** ✓ |
| **color-ratio** | ✗ | **NOW WIRED** ✓ |
| **spatial-frequency** | ✗ | **NOW WIRED** ✓ |

Every "8 axes" claim in previous receipts was ~40% overstated. Fixed this hour. But — see finding above — wiring them didn't mechanically improve recognition. It reshaped the signature space in ways that hurt lena discrimination.

### AE Fixture Auditor — labels I had wrong

- **baboon.jpg** was labeled "human_skin" — actually a mandrill (animal, red muzzle). Should be REJECT.
- **basketball1/2.png** grayscale — human_skin signal weak
- **messi5.jpg** small skin visible, jersey dominates
- **pic5.png** contains an orange rectangle — hard adversarial for reject-set

Corrected labels applied in this hour's 8-axis sweep.

### AE Claim Verifier — most claims survive citation but framing was inflated

- Latency (26.6ms p50) ✓ CONFIRMED_ROBUST
- Ramsauer/Werblin/Baden/Jensen cites ✓ CONFIRMED (small "~32 → >30" correction)
- 95.1% at 100k = synthetic-near-duplicate index recall on 2 labels, NOT Kurzweil-scale expert recognition — AE7's prior catch validated again
- "4/4 on 4-still" reproducible but β-temperature confound noted

## 8-axis human-grade sweep — real numbers

**Setup:** 2,304 configs on 15 corrected-label fixtures. β ∈ [7, 10, 15, 20, 30, 50], reject_threshold ∈ [0.4, 0.5, 0.6, 0.7], subsurface_wt ∈ [0.4, 0.8, 1.2], colorRatio_wt ∈ [0.2, 0.6], spatialFreq_wt ∈ [0.2, 0.6]. Store: 8-axis rebuilt from cinema.

**Rubric:** +2 correct target, +1 correct reject, −2 confident-wrong, −1 any-wrong. Max = 19.

**Result:**
- **Perfect configs: 0**
- **Near-perfect (score ≥ 17): 0**
- **Best score: 12 / 19 (63%)** — many configs tie at 12
- **Best raw accuracy: 12 / 15 = 80%** (per-image binary correct)

**Winning config:** β=15, reject_threshold=0.6, subsurface_wt=0.4, colorRatio_wt=0.6, spatialFreq_wt=0.2

**Winning config per-image:**

| image | expected | got | mass | verdict |
|---|---|---|---|---|
| orange.jpg | orange | **orange** | 0.661 | ✓ |
| apple.jpg | apple | **apple** | 1.000 | ✓ |
| fruits.jpg | orange | **orange** | 0.682 | ✓ |
| **lena.jpg** | **human_skin** | **orange** | 0.661 | **✗ REGRESSION** |
| baboon.jpg | REJECT | orange | 0.601 | ✗ (mandrill fools it) |
| home.jpg | REJECT | orange | 0.787 | ✗ (yellow palace) |
| pic5.png | REJECT | orange | 0.524 (below thresh) | ✓ correctly rejected |
| 8 no-warm-content fixtures (basketball1/2, messi5, building, board, gradient, notes, butterfly) | REJECT | — | — | ✓ auto-reject |

**The 8-axis substrate LOST lena that the 5-axis substrate had won at β=10.**

## Honest verdict

**AEyes¹ is not at human-grade recognition on 15 diverse fixtures. 80% raw accuracy. 63% on the rubric that penalizes confidence.** The 3 previously-orphan channels are now wired but don't improve the hardest test. The gap is not more color/texture measurement — it's **shape / geometry / context**, which no current axis carries.

**The Red Team was right:** subsurface should GATE the skin/orange family (not just contribute a distance), and shape/context need to be first-class. Wiring alone isn't enough — the composite architecture needs a gating layer or a per-family early-exit.

## Path to actual human-grade — the real plan

1. **Add a per-family gating layer.** Before Hopfield retrieval, run a hard classifier ("is this shape round?" / "is this a face structure?") that restricts the candidate set. Silhouette shape features (compactness, aspect ratio) + face landmark heuristics.

2. **Segment before ID.** Multi-object images (fruits.jpg, home.jpg) should return a SET of recognized objects, not a single top-1. Currently the winner is discarded ambiguity.

3. **Concept-specific rejection thresholds** — orange and human_skin need different mass floors because their attractor basins have different sizes.

4. **A real human-labeled training set beyond 2 concepts.** Adding a "yellow_building" concept lets home.jpg have somewhere to go besides orange. Adding "animal_face" lets baboon go somewhere honest.

5. **Only THEN re-sweep**. Expected outcome: with per-family gating + segmentation + honest concept coverage, hit 14/15 (near-perfect) before claiming human-grade.

## Rollback path

All changes additive. Delete:
- `07-VISUAL/structural/identity/rebuild-store-8axis.mjs`
- `07-VISUAL/structural/identity/skin-tone-synthesis-ita.mjs`
- `07-VISUAL/structural/identity/human-grade-8axis-sweep.mjs`
- `07-VISUAL/structural/identity/human-grade-sweep.mjs`
- `07-VISUAL/fixtures/perfect-eyes/identity-store-perfect-8axis.json`
- Revert the 3-arg-extension of `identity-store-v2.mjs.buildRichSignature` (backwards compatible extension — reversion won't affect any 5-axis caller)
- Revert citation additions to `hopfield-retrieval.mjs`, `subsurface-axis.mjs`, `retinal-12.mjs`

= full rollback. Nothing existing was renamed or removed.

## Final honest sentence

**One heavy Bun sweep on the 98GB box (killed after finding it ran the pre-fix 5-axis code) and four parallel Agents ran concurrently — Red Team designed 10 physically-plausible attacks with subsurface-as-gate as cross-cutting lever, Integration Auditor confirmed 3 of 8 axes were orphaned (fixed this hour by extending buildRichSignature to 3 optional trailing args, backwards compatible), Fixture Auditor caught baboon.jpg mislabeled and provided corrected labels, Claim Verifier confirmed latency + citations survive but "95.1% at 100k" is synthetic-near-duplicate recall on 2 labels — and the resulting 8-axis sweep on 15 corrected-label fixtures scored **12/19 rubric max (63%) / 12/15 raw (80%) with zero perfect configs**, and the substantive finding is that wiring subsurface + colorRatio + spatialFreq actually REGRESSED lena recognition (skin now matches orange at mass 0.661 instead of human_skin at 0.600) because those channels push skin and orange closer together — the missing signal is shape/geometry/context, not more color/texture measurement, so the honest next step is per-family gating + object segmentation + a real training-corpus expansion beyond the current 2 concepts, not more axis-wiring.**

*Mom is watching. 4 audits landed real. 8-axis wiring shipped and honestly evaluated. Human-grade not reached. Path named. No theater.*
