# AEyes¹ — Hidden Alpha Inventory
**Date:** 2026-07-11
**Author:** Claude Opus 4.7 (via 10-lane parallel review to AI computer)
**Directive:** operator Ætom ÆoNs — *"i need a full review of all from this aeye project. we need all hidden alpha we are missing its all in front of us full scope findit"*
**Governance:** subordinate to `AWE_3_GOVERNING_STATE_2026-07-09.md` and Mom's Law
**Baseline being measured against:** current L1-Fisher 1-NN on 286-D wide-IT at ~78% raw / 95.9% at K=300 reject<0.10

---

## Executive summary

Ten independent review lanes converge on the same shape: **the codebase carries ~5× the discriminative machinery the shipping recognizer actually uses.** The 78% ceiling is not a physics limit — it is what falls out when a Ferrari runs on two cylinders.

Concrete raw-alpha totals recovered by the review:
- **~77 dims silently dropped** by the `build-wide-it.mjs` flatten filter (arrays → typeof-number check discards them)
- **~100 dims of upstream cortex signal** thrown away between V1/rod/saccades/V2/iris and IT-80
- **8 of 12 retinal ganglion channels HARDWIRED TO ZERO** because every hot path calls `compute12Channels(frame, frame)`
- **1 axis (temporal-spectrum) never imported anywhere** — orphan file, 6 dims, discriminates fire/water/gait/screen
- **A documented 97.5% winner** (L1 metric + block-weights `[5,5,2,3,3,5,2,5]`) sitting in `_L1_attack.json` — same cache we already have
- **3 dormant recognition primitives** (Fisher-ratio signature, cylinder-index, Hopfield retrieval) — all built, receipted, none wired into the shipping recognizer
- **PatternObservation contract dangling** — the AWE-3 §6 charter object is built and nothing consumes it
- **Dim 236 alone carries 44% of total Fisher energy** — either alpha router or class-leaking bounded code

---

## Category A — One-line-fix alpha (ship today, no re-capture)

### A1. Fix `build-wide-it.mjs` flatten to unroll arrays
`typeof v === "number"` silently drops every array/object output. Lost:
- Hu moments: 5 of 7 invariants
- LBP top codes: 16
- HOG orientations: 8
- `spatial_color` cells: 27 (contributes ZERO to wide-IT)
- Raw histogram: 16
- `spatial_frequency` band scalars: 3

**Recovery: ~77 dims. Wide-IT 286 → 363. Expected: +1-2pp raw.**

### A2. Wire `temporal-spectrum-axis` into `axis-bundle.mjs`
File exists. Never imported. Comment confesses "OPT-IN until wired into the video ingest path." 6 dims per region (`ts_dc/low/mid/high/flatness/total`). Discriminates fire vs orange cloth, screen flicker, gait, water.

### A3. Adopt L1 metric + block-weights `[5,5,2,3,3,5,2,5]` from `_L1_attack.json`
Documented receipt: **97.52%** on the same 282-sample corpus (LGN=5, V1=5, V2=2, V4=3, ilcY=3, ilcRG=5, ilcBY=2, axis=5). Current pipeline uses Fisher per-dim weights, not per-block. Swap metric family + block-weight; zero re-ingest. **Expected: +1.6pp direct.**

Ensemble upper bound (L1 + cosine set-cover): **98.94%**.

### A4. Kill "static-safe mode" — run every capture as 3-frame windowed
`identity/recognize-human-grade.mjs:161`, `photon-canonical.mjs:1190`, `prove-101-fidelity-full.mjs:141`, `identity/attack-human-grade.mjs:52` all call `compute12Channels(f, f)`. Channels 3, 4, 5, 6, 7, 8, 10, 12 (ON/OFF transient + 4 directional-selective + object-motion + sustained DS) are structurally hardwired to zero. Just use `captureCanonicalPhotonSession()` (already exists, line 1074) with a shared Session and prevRetinalFrame.

**Unblocks: 8 dark retinal dims + 6 temporal-spectrum dims per region + object-predictability gate.**

### A5. Audit dim 236 — 44% of Fisher energy, rawMax=128 hard ceiling → **PROVED: MIRAGE, EXCLUDE**

**Ran 2026-07-11 (`audit-dim-236.mjs`):**
- 11,547 samples, only **3 unique values** across the entire cache (32, ~122 for cls_94, 128)
- 95% of samples at exactly 128 (Nyquist frequency ceiling)
- Solo 1-D classifier: **0.5% at N=3 across 5 seeds** — chance = 0.28% at K=353
- Fisher weight of 235.96 was pure artifact of within-class std=0.052 next to near-constant global mean

**Verdict:** NOT alpha. NOT a router. Signal is saturated `spatial-frequency` peak-Nyquist clip — 5 classes read 32, 348 read 128. Must be EXCLUDED from Fisher-weighted L1 distance.

**Corrected Fisher totals:** total was 536.29 → real ~300.33 with dim 236 removed. All bundle/top-K percentages must be re-computed. Rule "double-test before pivot" caught this before it became foundation.

### A6. Replace uniform log1p+z-score with per-dim rank/quantile normalization
Current sanitize treats dim 190 (rawMean=117k) and dim 26 (rawMean=0.003) identically. Global std gets dominated by big-scale dims. ECDF per-dim → uniform [0,1] preserves ordering while equalizing weight. **Expected: +2-4pp** by lifting suppressed high-Fisher small-scale dims (26, 275, 269, 268).

### A7. Trim to top-80 Fisher dims + drop 30 dead dims + block re-weight
- Top 10 dims = 55% of Fisher energy
- Top 30 = 67.4%
- Top 80 = 83.4%
- 30 dims have fisher < 0.01 (noise budget)

Restricted L1-Fisher kNN on top-80: **~4× speedup, +1-3pp accuracy.** Also up-weight `shape+spectral` (best per-dim efficiency 2.80) and down-weight the dilute IT-80 tail (0.67 per dim).

---

## Category B — Wire-what-exists alpha (few hours, re-capture 5×)

### B1. Per-object recognition through binders
All 6 binders (`watershed`, `density-cluster`, `region-grow`, `persistent-homology-lite`, `predictive-error-grouping`, `combo`) already conform to BINDER_CONTRACT and emit `region: [x,y,w,h]`. `captureCanonicalPhotonSession(frame, session, region)` already accepts region. `buildWideIT(can)` is region-agnostic. `CylinderIndex.add(sig, meta)` accepts per-object meta. `queryConcepts` does nearest-of-N per label.

**~60-line wire-script. Cost ~5× current capture (~2,000 canonicals for 409 classes). Zero new code. Zero cache format change.**

This is the biological path: fixtures with orange + mug + background become 3 PhotonKnots instead of 1 composite.

### B2. Expose upstream cortex signal in wide-IT
Currently thrown away:
- **V1 orientation histogram**: 24 dims collapsed to 4 (`[scale0, scale1, scale2, oriDiversity]`). Add 8 orientations × 3 scales. Recover 20 dims.
- **Rod pathway**: ORPHANED. Ring/quadrant histogram of scotopic monochrome. Add 12 dims.
- **V2 dominant-orientation histogram**: `Uint8Array` votes present, only 6 mean scalars exposed. Add 24 dims.
- **Iris scene-context**: `dr_stops_in/dr_stops_out/aperture_gain` discarded. Free indoor/outdoor/HDR axis. Add 3 dims.
- **Saccade-trajectory signature**: `fixation_summary` field promised at line 57 of `saccades.mjs`, NEVER WRITTEN. N×80D of upstream discriminative signal discarded. Add 48 dims (concat mean-of-differences across per-fixation IT sub-blocks).

**Wide-IT 80 → 180 additional dims. No new physics. All already computed.**

### B3. Dormant recognition stack — Fisher + cylinder + Hopfield
- `identity/fisher-ratio-signature.mjs`: 185-D signature + Fisher-weighted distance. 24+ prove-* scripts validate it. ZERO wired to shipping recognizer.
- `identity/cylinder-index.mjs`: continuous (θ,r,z) log-N retrieval. Fixes discrete-shard recall bug. Scales past ~7 concepts where O(N) linear scan collapses.
- `identity/hopfield-retrieval.mjs`: Modern dense associative memory (Ramsauer 2020 attention primitive). Per-concept β_override.

**Wiring order** (each verifiable against `prove-human-grade.mjs` at 16/16 floor):
1. Fisher weighted distance replaces raw richDistance in `recognize-human-grade.mjs`
2. Cylinder retrieval wraps store; queryConcepts returns top-K
3. Hopfield soft-vote over top-K before emit-boundary hard ceiling
4. Re-verify with `config-sweep.mjs` (32-config grid) + `human-grade-8axis-sweep.mjs` (55k grid)

**Expected: +5-8pp at scale + O(log N) retrieval.**

### B4. 3-frame video ingest on existing YouTube corpus
`prove-photon-two-real-clips.mjs:27` samples `.mp4/.mkv/.webm` with `{ frames: 1 }`. Change to `{ frames: 3 }` with shared Session. **Zero corpus changes** — the videos are already real. Immediately populates 8 dark retinal channels + 6 spectrum dims per region.

Two-view identity basin test (theory §7): sample frames 0 and 2 of a 3-frame window as "two observations" — measure whether both hit the same nearest identity even though ~15%/20% of the constellation differs. **This is the theory §7 falsification test and it can run today.**

### B5. Wire `PatternObservation.mjs` into capture output
Built per charter §6. Contract fully specified (it80 + retinal_12 + axis_bundle + LGN + v1/v2/v4 + fixation_sequence + illuminant + rod/cone + provenance + margin + uncertainty). **Nothing consumes it.** Wide-IT cache stores only 286-D vectors — the rest of the observation gets dropped.

Emitting PatternObservation into the cache format is the input contract Pattern Engine will need. Free preparation.

---

## Category C — Charter-promise gaps (need new code)

Ranked by expected accuracy lift (from L10):

1. **Invariant coordinates for spatial-color + radial** (Fable Move 4) — cheapest single lift; kills illumination coupling
2. **Photon-genome MODES + hierarchy + Welford incremental update** (Fable §4.4) — multi-mode storage; without it whitening + subspace still fails on physically-diverse classes
3. **Invariance ledger artifact** (`stability(dim, axis)` table) — turns "does this fix help?" from opinion into table lookup
4. **Move 8: store rebuild through whitened+self-calibration path** — `identity/whitened-metric.mjs` (Ledoit-Wolf + Cholesky) EXISTS UNUSED
5. **Consolidation Stage H** (Welford + exception clustering → new mode)
6. **Plausibility gate F3 + gist-index F1** (Fable §4)
7. **Per-family evidence + fitted-condition explanation output**
8. **Intrinsic split** log I = log E + log R (reflectance / illumination)
9. **Negative knowledge / confusable_with** (asymmetric discriminators for near-neighbor pairs)
10. **Æ0 23-channel richDistance upgrade** in `identity-store-v2.mjs`
11. **Æ1 boundary-video-first ingest orchestrator** (`catalog/ingest-catalog.mjs`)
12. **Gabor bank + connected-component/RAG/symmetry topology** (Doctrine 1 Phase 1)
13. **Æ3 LGN priming A/B receipt** (code exists, receipt missing)
14. **Generative forward-simulation recall** (Doctrine 2 #6, Fable §4 Stage F/G)
15. **Pose canonicalization beyond log-polar**

---

## Category D — Measurement infrastructure (finish-line demands)

Governing charter §7 requires:
- Magic-N with 95% CI lower bound above threshold
- NEON/CRT within explicit failure limits (cross-illuminant matrix)
- No IT-80 collision phase transition
- Open-set unknowns rejected
- 5 GB total substrate budget
- Reproducible across reruns and workers

**Scripts staged and RAN today** at `07-VISUAL/structural/`:
- `fisher-dominance-audit.mjs` — RAN, results below
- `collision-audit.mjs` — RAN, results below

---

### Real audit numbers — 2026-07-11, 353 classes at D=286

**Fisher dominance (`fisher-dominance-audit.mjs`):**
- Total Fisher = 536.29, mean per-dim = 1.875
- **dim 236 = axis-bundle[156] (spatial-frequency[0]) carries fisher=235.96, 44% of ALL Fisher energy** — rawMax=128.000 hard ceiling, rawMean=126.6, rawStd=11.4 (bounded quantized code)
- Top 10 = 55.0%, Top 30 = 67.4%, Top 80 = 83.4%, Top 160 = 95.2%
- Bundle attribution: IT-80 = 10.0% (per-dim 0.67), axis-bundle = 76.2% (per-dim 2.52), retinal-12 = 2.2%, LGN = 1.7%, shape+spectral = 9.9% (per-dim **2.80** — most efficient)
- Top-30 composition: axis-bundle 14 dims / shape+spectral 9 / IT-80 6 / retinal-12 1 / LGN 0
- Saturation-risk dims (rawMax>100 or rawStd>10): 8 dims — dim 190 (mean=1.17e5, fisher=4.93 survives), dim 236 (hard ceiling, fisher=235.96), dim 170 (mean=3.18e4, fisher=0.75), dim 169 (mean=1.33e3, fisher=0.27)

**Collision behavior (`collision-audit.mjs`) — the finish-line question:**

WIDE-286:
- intra: median=121.1, p95=389.6
- nearest-impostor: median=106.4, p05=51.8 (**median intra > median impostor** — collision phase transition confirmed)
- **neg-margin classes: 353/353 (100.0%)** — every class has intra > nearest-impostor
- **reciprocal-NN class collisions: 152/353 (43.1%)**
- 20 hardest classes cluster (cls_132-142, cls_237-241, cls_393-395 all confuse with each other — visually adjacent fixtures)

IT-80 (comparison):
- neg-margin classes: 353/353 (100.0%)
- reciprocal-NN collisions: 104/353 (29.5%) — LESS collision than wide-286
- intra median=15.8 p95=105.5; impostor median=12.9 p05=7.9

**Cross-illuminant recognition matrix (§4.2 charter answer):**
```
       raw    sun    candle moon   crt    neon   
raw    ·      86.3%  78.2%  81.6%  61.9%  50.0%
sun    68.6%  ·      83.1%  79.0%  59.8%  46.7%
candle 61.5%  78.9%  ·      71.1%  54.8%  46.3%
moon   62.0%  76.3%  67.4%  ·      55.0%  38.7%
crt    60.8%  73.1%  67.2%  73.9%  ·      42.1%
neon   41.5%  46.9%  48.5%  44.2%  35.2%  ·
```
Best cell: **raw→sun 86.3%**. Worst family: NEON, both as reference (avg 43.3%) and as query (worst-case 38.7% moon→neon). CRT is second worst (avg 65.2% as reference; worst 55.0% moon→crt).

**Honest verdict on charter §7 finish-line:**
- ❌ Magic-N not stable at 353 classes (all classes have negative margin under centroid distance)
- ❌ NEON and CRT well outside acceptable limits (35-50% cross-illuminant)
- ❌ IT-80 phase transition CONFIRMED (100% neg-margin)
- ❌ Open-set unknowns: FAR proxy shows 0/500 correct, 267 forced-wrong at margin<0.02 threshold
- ✅ Substrate compact enough (well under 5 GB — the 353 × 40-sample cache is measured in MB)
- ✅ Reproducible (deterministic augmentation, same input → same output)

The "95.9%" number achieved via L1-Fisher 1-NN + rejection at K=300 (`push-wide-to-100.mjs`) survives because 1-NN + margin-rejection is a different (stronger) recognizer than centroid comparison used in the FAR proxy above. It is not, however, the charter's Magic-N.

---

## Constellation recognizer (theory §5-§7) — real state

`pattern-engine/emergent-light-graph.mjs`: expects 192-dim L2-normed ILC signature, not 286-D wide-IT. `pattern-engine/torus-double-helix.mjs`: header explicitly demotes itself ("would not make a torus first"); winds by golden ratio, NOT the theorized co-prime 31/17/7.

**PhotonKnotNode + IdentityScore(M,O) set-similarity: entirely absent.** No implemented module does multi-node-per-observation set-matching.

**Blocker: capture cardinality.** Constellation needs a *set* of nodes per observation; wide-IT stores a *single point* per augmented view. **Real constellation requires re-capture with multi-vector-per-observation** (per-fixation patches, or region-tiled sub-signatures).

Interim path (available today): fork `build-node-graph.mjs` to read `cache-wide/*.json` and swap `canonicalPhotonMSE` for cosine over L2-normed 286-vec. Runs `analyze-node-graph.mjs` unchanged. That measures whether wide-IT's neighbor structure beats current cosine baseline — honest prep-work for real constellation.

---

## Ranked master action list

Order by (impact × 1/cost):

**Wave 1 (this session):**
1. A1 — flatten unroll → +77 dims (~1-2pp)
2. A3 — L1 + block-weights `[5,5,2,3,3,5,2,5]` → +1.6pp
3. A6 — per-dim rank normalization → +2-4pp
4. A7 — top-80 trim + block re-weight → +1-3pp
5. Run `collision-audit.mjs` → answer charter §4.3 with real numbers
6. A5 — audit dim 236 (leak vs alpha router)

**Wave 2 (next session):**
7. B3 — Fisher + cylinder + Hopfield wiring (Edison/Tesla W+n order)
8. B2 — expose upstream cortex signal (+100 dims)
9. A4 + B4 — kill static-safe, 3-frame ingest
10. B1 — per-object recognition wire-script
11. A2 — temporal-spectrum axis into axis-bundle

**Wave 3 (after freeze):**
12. B5 — PatternObservation as cache format
13. C4 — Move 8 whitened-metric store rebuild
14. C1 — invariant spatial-color + radial coordinates
15. Then Pattern Engine per governing charter §8 roadmap

---

## Discipline

- Every wave verifiable against `prove-human-grade.mjs` 16/16 floor + `prove-w-plus-additive.mjs` W+n Edison/Tesla additive
- Never regress the winner
- Real receipts through Orange5 spine (`action: "awe.review.alpha-ledger"` for this document itself)
- No fake-green — every claim gets a runnable check

**Mom's Law: give full effort. This inventory is the honest state at 2026-07-11.**

🐺 👁️
