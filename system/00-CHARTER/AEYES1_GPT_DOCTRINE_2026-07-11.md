# AEyes¹ / Alpha Wolf Eyes — Two-Phase Doctrine (GPT ratified)
**Date:** 2026-07-11
**Author of state:** GPT (Architect voice, trilane) via Ætom ÆoNs
**Status:** GOVERNING doctrine — reorders the roadmap in `AWE_3_GOVERNING_STATE_2026-07-09.md` without invalidating the cortex build
**Response to:** `AEYES1_GPT_CHECKPOINT_2026-07-11.md` (Claude's brief)

---

## Core doctrine (single sentence)

> **Never train through bad vision.** First establish that the eye preserves all recoverable identity-bearing light structure. Then determine the minimum number and diversity of exposures required to form a saturated photon print. Recognition memory may grow indefinitely, but the eye remains fixed and does not regress as classes are added.

---

## Two separate proofs, in strict order

```
PHOTON EYE                            (Phase A — qualify)
perfectly captures the visible structure

         ↓

PATTERN TRAINER                       (Phase B — saturate)
compresses repeated variations into one identity

         ↓

PHOTON PRINT                          (Phase C+ — deploy)
recognizes future instances whenever the visible evidence is sufficient
```

**The pattern trainer must NEVER be used to compensate for a weak eye.**

---

## The "perfect eye" definition (operational)

**"Perfect" does NOT mean literal photon completeness** — the input is already a camera frame, not the raw scene photon field.

**"Perfect" means:** the capture system does not discard structure that a normally sighted human could use to distinguish the object.

Eye benchmark:
```
Human can visually distinguish it
   → AEyeGlasses must preserve a measurable distinction

Human cannot distinguish it from the supplied image
   → failure is NOT charged against the eye
```

For any static object, the eye must preserve every visually useful property in that image:
- contour
- curvature
- luminance gradients
- color relationships
- highlight structure
- pore texture
- shadow geometry
- radial shape
- edge softness
- local frequency structure
- partial occlusion cues
- scale and orientation relationships

---

## The 20:20 test is only one layer

It proves acuity, contrast, chromatic sensitivity, motion and depth fixtures. It does NOT by itself prove that the complete identity-bearing structure survives the entire pipeline.

**Required additionally: a CAPTURE CONSERVATION TEST.**

```
RAW evidence
  → each deterministic stage
  → final cortical record
```

At every stage ask: **"Did any distinction available in the input become unrecoverably collapsed?"**

Recognition MUST NOT be used to answer that question. **Controlled visual probes MUST be used.**

Concretely: assemble pairs of same-class images that differ in one specific human-visible property (pore texture, highlight shape, stem angle, edge softness). At every stage of the AWE-3 pipeline (retinal-12, LGN parvo/magno/konio, V1, V2, V4, IT-80, wide-IT), measure whether the output vector preserves a distinguishing gap. If any pair collapses at stage K, stage K is where identity is being lost.

---

## Phase B: pattern train as manifold, not average

The photon print is NOT one averaged image. It is:

```
stable structure
+
allowed transformations
+
known variation envelope
+
discriminative boundaries
```

Example for `orange`:

```
persistent:
  rough spherical surface
  radial curvature
  orange-family reflectance
  characteristic pore-frequency field
  highlight/shadow behavior

variable:
  size
  rotation
  illumination
  minor shape deformation
  surface damage
  leaf/stem state
  camera and codec
```

**Recognition becomes:**
> Does this observation fall inside the completed structural variation envelope for `orange` while remaining outside nearby objects such as lemon, grapefruit, tangerine, ball, or orange-painted sphere?

---

## Phase B N schedule (Fibonacci-anchored)

Start: `N = 1, 2, 3, 4, 5`
Then: `N = 8, 13, 21, 34, 55, 89, 111`

Exact numbers less important than **preserving a locked evaluation set after every added exposure.**

For each N:
1. Register N exposures (each strategically different, expanding variation coverage)
2. Freeze the photon print
3. Test unseen variations
4. Record misses and false matches
5. Add the next strategically different exposure
6. Repeat

Two numbers per class:
- **N** — raw exposure count
- **N_eff** — effective variation coverage

Five views spanning pose, light, distance, surface variation may be worth more than fifty duplicate views.

---

## Saturation criterion (formal)

A photon print is COMPLETE when additional valid exposures stop changing its recognition boundary meaningfully:

```
N*_class = min N such that:
  ΔA_N < ε_A   (held-out accuracy stops changing)
  ΔF_N < ε_F   (false-match rate stops changing)
  ΔP_N < ε_P   (stored photon print stops changing)
sustained for several consecutive additions
```

Where:
- A_N = held-out recognition accuracy
- F_N = false-match rate
- P_N = photon-print delta

---

## Expected N distribution (universal installation rule)

Not one identical N per class — pattern complexity varies. Likely categories:

```
simple rigid objects (orange, cup, wrench)             → low N
moderate variation (shoe, chair, automobile)           → medium N
articulated / deformable (dog, human body, clothing)   → higher N
individual identity over years (specific face)         → high structured N
```

Target distribution derivation:
```
50% of classes complete by N = 5
80% by N = 13
95% by N = 34
99% by N = 89
hard tail by N = 111
```

Then choose:
- default N for common objects
- adaptive continuation rule for unresolved identities
- upper operational ceiling

The trainer must **stop when the photon print is saturated** — never blindly collect the ceiling for everything.

---

## Scaling law (nearest-impostor margin)

The eye is fixed. Only memory grows. Adding known patterns must NOT degrade the eye.

Scaling test uses **nearest-impostor margin**:
```
m(x) = d(x, nearest_wrong_identity) − d(x, correct_identity)
```

As classes are added, m(x) must remain positive for humanly-distinguishable classes.

If accuracy decreases as class count rises, exactly one of four things is wrong:

1. **Photon code lacks discriminative structure** → EYE problem
2. **Recognition metric collapses distinct patterns** → MEMORY problem
3. **Storage representation merges identities improperly** → MEMORY problem
4. **Evaluation contains genuinely visually ambiguous examples** → legitimate visual limit

Only #4 is not a bug.

---

## Development roadmap

```
PHASE A — QUALIFY THE EYE
  prove acuity
  prove color capture
  prove low-light pathway
  prove local texture preservation
  prove contour and curvature preservation
  prove fixation evidence retention
  prove no identity-bearing structure is discarded
  prove codec / display / camera robustness
```

```
PHASE B — ONE-PATTERN SATURATION
  choose "orange"
  capture a controlled variation manifold
  train from N=1 upward (Fibonacci)
  lock unseen tests
  find N*_orange
  inspect every miss
  classify each miss as eye / memory / visual ambiguity
```

```
PHASE C — PATTERN COMPLEXITY LADDER
  orange
  cup
  shoe
  chair
  dog
  human face
  specific human identity
  crowded scenes
```

Determines how N* scales with visual complexity.

```
PHASE D — WORLD CURRICULUM
  train highest-frequency objects first
  expand outward by utility and encounter frequency
  reuse shared subpatterns
  stop each identity at saturation
```

---

## What this reorders vs `AWE_3_GOVERNING_STATE_2026-07-09.md` §7 finish-line

Old §7 finish-line was: "Magic-N stable + NEON/CRT under ceiling + no collision phase transition + open-set unknowns + 5GB budget + reproducibility" — all measured on the 10K × 100 heterogeneous corpus.

**New ordering:**
1. **Phase A capture-conservation proof** — CANNOT be answered by recognition math on any corpus
2. **Phase B one-orange saturation curve** — the FIRST decisive proof
3. Phase A + B receipts together license 10K-class deployment
4. Old §4.1–§4.5 remain as Phase C+ measurements (collision, storage, scaling law) but they apply AFTER Phase B saturation is proven

The 353-class experiments running today are USEFUL data collection for eventual Phase C, but they are NOT the decisive next proof.

---

## Governance
- This doctrine supersedes the roadmap section of `AWE_3_GOVERNING_STATE_2026-07-09.md`
- Cortex build (§2 of the prior charter) STAYS intact — Phase A tests it, does not rebuild it
- Any deviation routed through Orange5 spine as `action: "awe.doctrine.amend"`
- Ledger for this doctrine adoption: pending seq
- Mom's Law: full effort, no theater, receipts or it didn't happen

🍊 🐺 👁️
