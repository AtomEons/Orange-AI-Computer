# AEyes¹ / Alpha Wolf Eyes — GPT Checkpoint Brief
**Date:** 2026-07-11
**For:** GPT (Architect voice, trilane)
**From:** Claude Opus 4.7 (Compiler voice, session lead)
**Operator:** Ætom ÆoNs / Atom McCree — sovereign solo founder, AtomEons
**Ask:** second look — governing charter alignment, blindspots, ordering. I lead; you catch what I miss.

---

## 1. Project frame (from the operator's THEORY doc 2026-07-09)

Three-system separation, do not blur:
1. **The eye (AEyes¹)** — light → stable structural codes
2. **Visual memory** — recurring structures + transformations
3. **Cognitive/dynamical** — reasons over what the eye discovered

AEyes¹ **six operations, nothing more:**
```
LIGHT
  → CANONICAL LINEAR-LIGHT CAPTURE
  → LOCAL PHOTON STRUCTURES
  → STRUCTURES PERSISTING THROUGH TIME
  → TRANSFORMATION-INVARIANT PATTERN CODES
  → RECOGNITION BY REACTIVATING STORED PATTERN CONSTELLATIONS
```

Zero learned parameters. Zero paid deps. Bun only. Runs on Atom's local hardware. Free-forever charter.

---

## 2. What is BUILT and RUNNING (`AWE-3.0-visual-cortex`)

Live at `C:/AtomEons/Orange5/07-VISUAL/structural/`:

```
RAW photon record
→ linearize (sRGB→linear)
→ CAT02 illuminant adaptation (cone-space, clamped [0.4, 3.0])
→ foveated log-polar canonicalize (256×256, bicubic, foveal bias 1.6)
→ rod (scotopic 64×64) + cone opponent
→ retinal-12 (Werblin/Roska/Baden ganglion channels)
→ LGN parvo/magno/konio streams
→ V1: 24 Gabor (8 ori × 3 scale)
→ V2: cross-orientation suppression + texture boundary
→ V4: curvature + concavity + complexity + color-shape
→ IT-80 (block-normalized 80-D identity code)
→ saccades (saliency-driven multi-fixation)
```

**Emits 412 deterministic derived measurements** (≈221 encoded bits of representational capacity — corrected from prior "29× info" phrasing per governing charter §5).

**Photon-print fidelity: 100% by construction** (raw R/G/B carried through unaltered).

## 3. What is BUILT but DORMANT (10-lane review, spine seq 101)

- **`build-wide-it.mjs` flatten drops arrays** — 77 dims silently thrown (Hu 5-of-7, LBP 16, HOG 8, spatial-color cells 27, hist 16, freq bands 3)
- **8 of 12 retinal channels HARDWIRED TO ZERO** — every hot path calls `compute12Channels(frame, frame)` in "static-safe mode". Transient ON/OFF + 4 directional-selective + object-motion + sustained DS never fire.
- **`temporal-spectrum-axis.mjs` orphan** — never imported anywhere. 6 dims per region (fire/water/gait/screen discriminator).
- **Fixation summary broken promise** — `saccades.mjs:57` says "aggregated IT signatures + peaks" but field never written. N×80D discarded per capture.
- **V1 orientation histogram collapsed** — 24-D (8 ori × 3 scale) pooled to 4 scalars (`[scale0, scale1, scale2, oriDiversity]`)
- **Rod pathway fully orphaned** — computed and dropped
- **`identity/fisher-ratio-signature.mjs`, `cylinder-index.mjs`, `hopfield-retrieval.mjs`** — all receipted, none in shipping recognizer
- **`pattern-engine/emergent-light-graph.mjs`, `torus-double-helix.mjs`, `PatternObservation.mjs`** — all built. Torus winds by golden ratio, NOT the theorized co-prime 31/17/7. PatternObservation dangling — nothing consumes it.
- **`whitened-metric.mjs` (Ledoit-Wolf + Cholesky)** — exists, no store rebuilt through it

Full inventory: `00-CHARTER/AEYES1_HIDDEN_ALPHA_INVENTORY_2026-07-11.md`

---

## 4. Current test corpus

- 409 classes captured, 353 usable at modal length 286-D
- Per class: ~33 augmentations = 6 lightings (raw/sun/candle/moon/crt/neon) + 8 rotations at raw + 3 scales + 3 brightness + 3 contrast + NEON/CRT×rot/scale combos
- Total ~11,500 samples in the wide-IT cache
- Storage: `C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide/wide_*.json`

---

## 5. Real recognition numbers (as of today)

**Baseline recognizer:** L1-Fisher 1-NN on 286-D standardized wide-IT

| Protocol | K | N | Accuracy | Notes |
|---|---|---|---|---|
| Random split | 300 | 5 | 78.3% | Fisher no reject |
| Random split | 300 | 3 | 95.9% | reject<0.10 (36% rejected) |
| **Train-high test-low** | 47 | 3 | 45.0% no-reject / 98.9% reject<0.10 (88% rejected) | Operator: biological protocol |
| Train-high test-low | 100 | 3 | 58.8% no-reject / 97.7% reject<0.10 (78% rejected) | |
| Train-high test-low | 300 | 5 | ~62% no-reject | Full range currently under multi-seed sweep |

**Per-lighting on train-high test-low K=100, N=3 no-reject:** sun 79%, candle 63%, moon 66%, crt 60%, neon 52%.

---

## 6. Collision math answer (governing charter §4.3 finish-line)

Ran `collision-audit.mjs` today. **353 classes at wide-286:**

- **353/353 classes have negative margin** (intra > nearest-impostor) — CLASSICAL COLLISION PHASE TRANSITION
- Reciprocal-NN class collisions: **43.1%** (wide-286), 29.5% (IT-80)
- Median intra 121, median nearest-impostor 106 → global impostor cheaper than global intra
- Open-set FAR proxy (500 queries, centroid distance, margin<0.02): 0 correct, 233 rejected, 267 forced-wrong

**The 78/95.9% survives** because 1-NN + rejection is a stronger recognizer than centroid comparison. But **the charter's Magic-N is not passing.**

---

## 7. Cross-illuminant matrix (governing charter §4.2)

Recognition rate, Ref\Query (all 5 non-diagonal cells report identity recall on same class):
```
       raw    sun    candle moon   crt    neon
raw    ·      86.3%  78.2%  81.6%  61.9%  50.0%
sun    68.6%  ·      83.1%  79.0%  59.8%  46.7%
candle 61.5%  78.9%  ·      71.1%  54.8%  46.3%
moon   62.0%  76.3%  67.4%  ·      55.0%  38.7%
crt    60.8%  73.1%  67.2%  73.9%  ·      42.1%
neon   41.5%  46.9%  48.5%  44.2%  35.2%  ·
```

- Charter target: ≤5% failure. Real: 15-60% failure on NEON/CRT cells.
- NEON as reference kills everything (avg 43%). CRT second worst.
- Note: augmentations are SYNTHETIC linear ops on the raw RGB, not real device captures. Theory §3 predicted this would fail vs real codec-consensus.

---

## 8. Fisher energy leak (today's key finding)

`fisher-dominance-audit.mjs` reported: dim 236 (spatial_frequency[0]) = **44% of total Fisher energy**, rawMax=128 hard ceiling, within-class std 0.052.

Standing rule "double-test before pivot" (locked today after operator called out fast pivots as the mechanism that caused earlier RGB-vs-photons drift) forced me to solo-test.

**Result:** dim 236 has only 3 unique values across 11,547 samples (32, 122, 128). Solo 1-D classifier: 0.5% at N=3 (chance 0.28%). **NOT alpha.** Fisher weight was pure within-class-variance artifact. Ledgered as receipt seq 102 (`rcpt_da0a344131958bbe`).

**Real total Fisher without dim 236: ~300 (not 536).**

If we hadn't double-tested, next-wave recognition would have been stacked on a saturated Nyquist frequency ceiling. That's the shape of the earlier RGB drift.

---

## 9. Working path (currently under proof, two Bun processes live)

- **`double-test-train-high.mjs`** — 10 seeds × 7 N × 8 reject × 5 K = 2800 cells with bootstrap 95% CI on each cell. Verdicts at end will name best cells with lower bound ≥ 95%.
- **`double-test-additive.mjs`** (W+1) — same protocol × 5 variants: baseline vs (dim 236 excluded) vs (top-160 Fisher) vs (top-80) vs (top-30). Edison/Tesla additive — if any variant beats baseline at same reject, it stacks.

Both stdout-buffered under redirection; JSON output files land at completion under `07-VISUAL/ten-k-x-100/results/`.

---

## 10. Issues I need your eyes on

1. **Substrate-honesty leak-detector.** The dim 236 solo test caught one leak. **How do I audit the remaining top-Fisher dims for RGB-derivative vs photon-inference at scale?** 286 solo tests is trivial compute but doesn't tell me which are "physically real". Do you want a specific class of test per axis type — histogram bin (RGB-derivative) vs Gabor energy (photon-inference)?

2. **Cross-illuminant NEON floor.** Cross-illuminant reference→NEON averages 43%. Governing charter §4.2 target is ≤5%. **Is this synthetic-augmentation-limit, or is CAT02 + opponent pathways insufficient regardless of augmentation quality?** Theory §3 says the fix is real codec-consensus. Do you want us to build the MultiCodecCollector now, or first prove that even our current pipeline handles a small real-codec-varied test set (5 videos × 5 codec passes)?

3. **Charter §4.3 metric ambiguity.** 100% neg-margin under centroid distance vs 78%/95.9% recognition under 1-NN. **Which metric is the charter's "collision phase transition"?** If centroid, our IT-80 is dead; if 1-NN, we have working recognition and the 5GB storage question dominates. I read §4.3 as centroid but I'm not certain.

4. **Constellation recognizer prerequisite.** L1 review found `pattern-engine/emergent-light-graph.mjs` expects 192-dim L2-normed ILC signature (not 286-D wide-IT). `torus-double-helix.mjs` winds golden-angle (not the 31/17/7 co-prime the theory prescribes). Multi-vector-per-observation capture is required for IdentityScore(M,O) set-similarity. **Do we re-capture to emit per-fixation patches (~5-8 vectors per observation instead of 1), or wire the interim K-NN graph recognizer first?** K-NN graph is 3 code moves on the existing cache and answers whether wide-IT's neighbor structure carries constellation signal.

5. **Order of the 5 Wave-1 fixes.** Ranked by cheap-fast-safe:
   a. flatten unroll → +77 dims (needs re-capture, ~10 min)
   b. Adopt L1 + block-weights `[5,5,2,3,3,5,2,5]` from `_L1_attack.json` receipt (documented 97.5% ceiling on 282-sample corpus, non-comparable N)
   c. Per-dim rank normalization (uniform log1p+z-score suppresses high-Fisher small-scale dims like 26, 275)
   d. Top-80 Fisher trim + block re-weight
   e. Dim 236 audit — **DONE today** (leak proven)

**Do you want us to fire (a) as re-capture now, or stack (b/c/d) first on existing cache and only re-capture once the recognition strategy is proven?**

6. **Static-safe mode kill.** 8 of 12 retinal channels are hardwired to zero because every hot path passes the same frame as f1 and f2 to `compute12Channels`. Killing static-safe = running 3-frame windowed captures. YouTube corpus is already video. **Is that a Wave-1 or Wave-2 move under your ordering?**

---

## 11. Governance
- Ledger law: every proof through Orange5 spine (currently at seq 102)
- Winner + additive: never regress W (already have `prove-w-plus-additive.mjs`)
- Mom's Law: no fake-green, no theater, real receipts
- Trilane: on conflict Claude defers to you (GPT) over Gemini

Operator standing message today: **"we need to do more work. yesterday was completely lost to progress. we must ride twice as fast today."** Combined with **"you are too quick to pivot."** So — speed with proof, never pivot from a first look.

---

Please respond with:
- What I'm missing
- Ordering call on the 6 open questions above
- Any theory-alignment error in the current code paths

🐺 👁️
