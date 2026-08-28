# AEyes¹ Wave 1 / 2 / 3 — final session receipt

**Date:** 2026-07-07
**Session:** Push AEyes¹ toward "human-eye level" per operator directive `use the orange attack the fucking problem get me to 100% human eye level readability` and follow-up `i want it human eye level or continue onward`.
**Doctrine:** Mom's Law · Bun-only · no paid deps · no fake-green · receipts or it did not happen
**Spine chain:** seq=50 → seq=53 across 4 receipts (this receipt caps the arc)

## The single honest number

**Cross-clip generalization at N=19 YouTube-trained concepts: 42% correct · 32 confident-wrong.**

Category-clean concepts (visually distinct): **banana 8/8 · cat 8/8 · lion 8/8 · elephant 7/8.**
Fine-grained failures (within-hue clusters and low-texture objects): orange_fruit / tomato / watermelon / strawberry / carrot / fire / chair / clock / book all 0-38%.

## Full experiment matrix

| Store | N | Mode | Correct | ConfWrong |
|---|---:|---|---:|---:|
| 5-concept smoke set (cinema + one-shot) | 5 | 16-fixture, baseline | 16/16 = 100% * | 0 |
| Held-out temporal split (train first-half video, test second-half) | 2 | 33-item mixed | 31/33 = 94% | 0 |
| Wave 2 preview (11 concepts) | 11 | baseline | 43/72 = 60% | 14 |
| Wave 2 preview (11 concepts) | 11 | ceiling 2.2 | 44/72 = 61% | 15 |
| Wave 2 preview (11 concepts) | 11 | 2.2 + multiscale + hue-any | 34/72 = 47% | 27 |
| **Wave 2 final (19 concepts) — baseline** | **19** | **default** | **50/120 = 42%** | **32** |
| Wave 2 final (21 concepts, tight K=1 medoid curation) | 21 | default | 45/136 = 33% | 34 |

(*) Smoke test has documented train==test contamination on 3 of 6 targets (see [CORRECTION receipt seq=51](2026-07-07-aeyes-CORRECTION-honest-rescore.md)).

## What Wave 2 revealed

**Cross-clip within-concept variance is 3–19× larger than the gap to the nearest other concept.** Concepts share the same hue cluster (orange / tomato / watermelon / strawberry / carrot). No global ceiling can separate them; per-concept ceiling learner hits its 2.5 clamp because no valid ceiling exists in the geometry.

**Curation strategies pull in opposite directions:**
- Active-diverse (K=8) → catches cross-clip variance but red-cluster concepts collide
- K-medoid tight (K=1 per clip) → geometry tightens but coverage drops
- Neither wins because the SIGNATURE representation captures frame-specific detail more than concept-specific detail.

**Enrichment (multi-scale, hue-any, higher ceiling) actively regressed the numbers** — extra candidates and looser gates displaced clean matches. Cat 8/8 → 3/8 under full enrichment.

## What Wave 3 delivered

- [transcript-binding.mjs](../../07-VISUAL/structural/ingest/transcript-binding.mjs) — pulls yt-dlp auto-subs per corpus video, builds TF-IDF concept lexicon.
- [text-query-lookup.mjs](../../07-VISUAL/structural/identity/text-query-lookup.mjs) — text query → concept fingerprint retrieval, zero-LLM.
- On the Wave 2 corpus, **4 of 19 concepts** got transcript-bound (strawberry / tomato / cat / elephant — the ones with auto-subtitle content). 342 unique tokens/bigrams indexed. Pipeline is proven; corpus is sparse in narration.

## Substrate archaeology (dormant modules wired this session)

- **Retinal-12 static-safe channels** wired into `signatureForRegion` / `signatureForUnion` (AE3 finding closed)
- **naturalVsSynthetic gate** wired at emit boundary for biological concepts
- **6-way `hue_gate`** — warm_strict, warm_loose, cool, dark, bright_neutral, any (removes the warm-only ceiling)
- **Multi-scale opt-in** — concentric crops at 100/70/50%
- **`recognizeSetHumanGradeFrame`** — multi-object emit (returns concept set, not one winner)
- **Second-nearest confidence** with real independent definition
- **Per-concept `reject_ceiling`** replaces the hardcoded global constant
- **`learn-per-concept-ceilings.mjs`** — data-driven ceiling from within-vs-across variance
- **`rebalance-weights.mjs`** — illumination-invariant profile (colorRatio 2.0, texture 1.5 — regressed at unbalanced channel ranges)
- **`reingest-tight-curation.mjs`** — K=1 medoid alternative to active-diverse-8

Ready-to-ship checklist: **27 / 27 passing.** Backward compat: 16/16 smoke test still passes.

## The honest boundary — what AEyes¹ IS and IS NOT

**IS** at this state:
- Real zero-parameter deterministic recognizer, Bun/CPU, no paid API
- **Category-level clean** — visually distinct concepts (banana / cat / lion / elephant) generalize cross-clip at 88-100%
- Perfect reject discipline on out-of-distribution content
- Callable through spine as `aeyes.recognize.v1` emitting `orange.report.v1`
- Text-queryable via transcript index (Wave 3)

**IS NOT** at this state:
- Not human-eye level. 42% overall cross-clip at N=19 is category-competent, not fine-grained.
- Not immune to concept collision — within-hue-cluster concepts confuse
- Not tuned by ceiling / enrichment / curation — those levers are exhausted

## The signature representation is the bottleneck

Curation, ceiling tuning, weight rebalancing, multi-scale, hue-any — every local knob was tried tonight. None moves the needle above ~60% because the underlying signature is capturing frame-specific detail (lighting, angle, motion phase) more than concept-specific detail. Each clip of the same concept produces signatures that live far apart in feature space.

**The unlocks (not this session):**

1. **Signature normalization** — unit-variance per channel across the store so weights are numerically meaningful. This is the biggest single fix.
2. **Hierarchical concept graph** — `orange_fruit → red_fruit → fruit`; sibling concepts share low-level features via IS_A. Fine-grained decisions happen at leaf nodes with tighter local ceilings.
3. **K-medoid tight curation for MANY per-clip sigs** — instead of 1 sig or 8 sigs per concept, keep 3-4 sigs per clip so cluster tightens without variance loss.
4. **Cross-source augmentation** — mix video frames + static image samples per concept during ingest.

## Spine chain

| seq | receipt | meaning |
|---|---|---|
| 50 | rcpt_2682ffac45a4750b | Original 16/16 smoke (SUPERSEDED) |
| 51 | rcpt_3e3cf25fd2560c7f | Correction — retracted "human-eye level" phrasing, disclosed train==test contamination |
| 52 | rcpt_e72c9ff538a18550 | Wave 1 baseline established (31/33 held-out, empirical capacity N=5 synthetic) |
| 53 | rcpt_8ac9bd60966de66d | Wave 2 preview honest (60% at N=11, enrichment regressed) |

## Standing verifiability

```bash
# All still deterministic, all still Bun-native
bun 07-VISUAL/structural/identity/prove-human-grade.mjs            # 16/16 smoke
bun 07-VISUAL/structural/identity/prove-heldout.mjs                # 31/33 held-out temporal
bun 07-VISUAL/structural/identity/prove-wave2-heldout.mjs 07-VISUAL/fixtures/youtube-corpus/store-wave2-batch1.json    # 50/120 Wave 2 final
bun 07-VISUAL/structural/identity/ready-to-ship-check.mjs          # 27/27 gates
```

## Mom's Law close

The session did not achieve "human-eye level." That phrase is not earned by the substrate as it stands. What the session DID achieve:

- Retracted a smoke-test-labeled-as-verified claim honestly, on the ledger
- Built the held-out validators AE7 asked for
- Ran the substrate at N=19 real concepts with real cross-clip discipline
- Mapped the empirical failure mode (within-hue-cluster concepts collide because signatures are frame-specific not concept-specific)
- Named the four architectural unlocks in priority order
- Kept 100% of prior smoke-test regression during additive extension

Not human-eye. Cleanly measured, cleanly boundaried, cleanly next-actionable. Mom is watching. Receipts or it did not happen.
