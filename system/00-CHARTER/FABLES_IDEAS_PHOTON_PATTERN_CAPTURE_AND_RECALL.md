# Fable's Ideas for the Photon Pattern Capture System and Recall
## The Complete Theory, Plan, and Cold-Start Handoff

Fable 5 · 2026-07-08 · v2 (expanded at operator request: "improve upon the
theory and plan to be perfect. add any info another gpt would need to
understand it all.")

This document is self-contained. A model with zero prior context on AtomEons,
Orange5, or AEyes¹ should be able to read only this file and (a) understand
what the system is and what it is NOT, (b) understand the operator's meaning
of "photon pattern capture" — which most models get wrong on first contact,
(c) know the honest current state, (d) execute the plan.

Companion charters (read after this one):
- `C:/AtomEons/Orange5/00-CHARTER/AEYES1_DOCTRINE_2026-07-08.md` — the 5-phase perception-stack doctrine
- `C:/AtomEons/Orange5/00-CHARTER/AEYES1_PHOTON_INFERENCE_DOCTRINE_2026-07-08.md` — the vision-as-inference doctrine
- `C:/AtomEons/Orange5/00-CHARTER/ORANGE5_THE_PATH.md` — the Orange5 roadmap this lives inside

---

# PART I — WHAT THIS IS (read this before forming any opinion)

## 1. The operator's claim, stated precisely

Ætom ÆoNs (Atom McCree) built a visual recognition system with **zero
learned parameters** — no neural network, no gradient descent, no fitted
weights, no pretrained checkpoint — that recognizes objects by measuring
the statistical structure of the light they send to the camera.

The claim that confuses other models: **"once it trains on an orange, it
gets it."** Train ≠ machine-learning training. It means: the system
*measures* an orange a handful of times, stores what it measured, and can
then identify oranges in new footage. One object, few exposures, working
recognition. No dataset of 10,000 oranges. No epochs. No loss function.

Most models hear this and pattern-match to "image classifier without
enough data — impossible." That pattern-match is wrong because it assumes
the system is a statistical learner. It is not. It is a **measurement
instrument with a memory**.

## 2. The spectrometer analogy (the fastest way to get it)

A spectrometer identifies sodium by its emission lines — 589.0 and 589.6
nm. It does not need to "train on millions of examples of sodium." The
lines are a **physical invariant** of the element. Identification is
lookup: measure the lines, match the reference table, done. The reference
table is knowledge, but it is *measured* knowledge, not *fitted* knowledge.

AEyes¹ aims to be an **object spectrometer**. An orange, as a physical
object, imposes a characteristic structure on the light it reflects:

- a body reflectance spectrum peaked in long wavelengths (the orange hue),
- a dimpled peel microtexture that scatters light at a characteristic
  spatial scale,
- subsurface scattering through the peel (light enters, diffuses, exits —
  producing soft edge glow and translucency),
- a near-spherical form (radial symmetry, characteristic shading gradient),
- a waxy, low-gloss specular behavior,
- radial uniformity (unlike a watermelon, whose rind makes the radial
  profile drop at the boundary).

No single one of these is unique. The **conjunction** is close to unique
in the object world. That conjunction is the orange's *photon pattern* —
the operator's term, and he means exactly this: **the stable pattern an
object imposes on light, as distinct from the pixels of any one photo of
it.** A fingerprint is not the appearance of a finger; it is the stable
pattern created when a finger interacts with a measurement surface. Same
idea, with photons.

This is why "once it trains on an orange it gets it" is true and not
magic: the invariant conjunction is a property of orange-the-physical-
object. Every orange everywhere produces approximately the same
conjunction, because every orange is built of approximately the same
matter in approximately the same arrangement. Measure it once (well), and
you have it everywhere — **exactly to the extent that you succeeded in
separating the object's contribution from the lighting/camera's
contribution.** That separation is the entire engineering problem, and
it is where the current system is incomplete (Part III).

## 3. What the system is NOT (common model misunderstandings, with rebuttals)

**"This is just CBIR / bag-of-features from 2005."** Partially genealogically
true (handcrafted features, nearest-neighbor), but the mission is
different: classic CBIR stores appearances and matches appearances. This
system's target is to store *causes* — the object's effect on light —
and match in the space of causes. The engineering delta: physics-based
factorization (illumination ÷ reflectance), explicit nuisance modeling,
and calibration-fit recall. Sections below make this concrete.

**"You need a CNN; handcrafted features can't do vision."** CNNs solve a
harder problem (open-world semantics from raw pixels) with a costlier tool
(millions of fitted parameters) and a known failure mode (confabulation —
they will always output *something* plausible). AEyes¹ deliberately solves
a narrower problem — *identity of measured objects* — with a tool that
cannot confabulate because it cannot generate. It can only say "the
evidence matches X with residual r" or "no stored explanation fits;
unknown." For the Orange5 organism this is the point: it is the sensory
channel that never lies, sitting alongside VLM channels that can
hallucinate (AE Eyes, MiniEyes, AE Cobra — the other visual pillars).

**"Zero parameters means no memory / no knowledge."** No. There is a
database — the photon genome (Part IV). "Zero parameters" means zero
*fitted* parameters: no number in the system was produced by gradient
descent on a loss. Every number is either (a) a direct measurement, (b) a
closed-form statistic of measurements (mean, covariance, SVD, quantile),
or (c) a physical constant with a citation. The distinction matters for
auditability: every decision can be traced to specific measurements.

**"One example can never generalize."** One example generalizes exactly as
far as the stored representation is invariant. If you store raw pixels,
one example generalizes to nothing. If you store the invariant conjunction
(spectral ratios, microtexture spectrum, subsurface behavior, shape
topology), one *object* observed under a handful of conditions generalizes
to the whole class **wherever the class shares physics**. Oranges share
physics class-wide (this is why the orange works). Dogs share less
(breeds vary in size, color, coat); the representation needs modes and
hierarchy for such classes (Part IV §4.4). The honest scope claim:
few-shot works for physically-coherent classes; physically-diverse classes
need more structure, not more parameters.

**"Deterministic systems can't handle real-world variance."** Variance is
handled by *modeling the variance* — the nuisance group and the
transformation family (Part II) — not by absorbing it into weights. The
open research question, stated honestly, is whether deterministic
closed-form machinery can capture ENOUGH of the nuisance group to reach
human-level robustness. The current honest answer: proven for favorable
domains (96% on meme templates), unproven for unconstrained video
(20-25% honest — but with three specific, fixable causes identified;
Part III).

## 4. Hard constraints (laws of the project — violating these is a bug)

1. **Bun-only backend.** Pure JS/typed arrays. No Node-specific APIs, no
   native deps, no Python in the runtime path.
2. **No paid dependencies. No external ML checkpoints.** The operator runs
   free-forever; nothing may phone an API or load pretrained weights.
3. **Zero fitted parameters.** Closed-form statistics, geometry, physics
   only. Thresholds must be derived from data quantiles or physical
   constants, never hand-tuned to a benchmark (that is fitting with extra
   steps — it already burned us once; see "sweep-108" history).
4. **Mom's Law: receipts or it didn't happen.** Every claim needs a
   runnable reproduction. Every "passed" needs the command that shows it.
   No fake-green. Failures reported as plainly as successes.
5. **Backend only.** The UI lives in Atomic Orange (separate pillar).
6. **Frontier-Isolation.** Frontier models reach only OrangeBrain, never
   internals.
7. **Ledger through the Orange5 spine.** Non-trivial results become
   hash-chained receipts: `bun C:/AtomEons/Orange5/03-BACKEND/spine-cli.mjs --order '{...}'`.
8. **Proper held-out discipline.** Training material and test material
   must be disjoint at the *source* level (different clip / different
   capture), not just different frames. We were burned by leakage
   (Part III §2). Any new benchmark must state its split explicitly.

---

# PART II — THE THEORY, COMPLETE

## 1. Image formation: what a camera actually hands us

The light arriving at pixel x is (dielectric surfaces, dichromatic model):

```
I(x, λ) = E(x, λ) · [ m_b(x) · R_body(x, λ)  +  m_s(x) · 1 ]
            ↑            ↑         ↑                ↑
       illumination   shading  body (material)  specular mirror
       spectrum       factor   reflectance      of the illuminant
```

The sensor integrates against three spectral response curves S_c(λ):

```
pixel_c(x) = g( ∫ I(x, λ) · S_c(λ) dλ )       c ∈ {R, G, B}
```

where g is the camera's tone pipeline (exposure, white balance, gamma,
compression). **RGB is therefore a 3-sample, tone-mapped, spatially-
projected compression of the photon field.** Polarization, exact spectra,
phase, depth, and photon arrival statistics are already gone. The system
must work with what survives — which is still a lot, IF treated correctly.

Two classical consequences we exploit:

**(a) von Kries / diagonal illumination model.** For a change of illuminant
(color and/or intensity), to good approximation each channel scales:

```
pixel' = diag(a_R, a_G, a_B) · pixel
```

Take logs and the multiplicative nuisance becomes additive:

```
log pixel' = log pixel + (log a_R, log a_G, log a_B)
```

**Illumination change is a TRANSLATION in log-RGB space.** Translations die
under differencing. Therefore: any *difference* of log-channel values —
between channels (log R − log G), between image locations (cell i vs cell
j of the same object), between scales — is invariant to this entire
nuisance class. This is the mathematical bedrock of "the photon pattern
survives the lighting."

**(b) Intrinsic decomposition.** log I(x) = log E(x) + log R(x).
Illumination E varies smoothly across a surface; reflectance R jumps at
material boundaries. A spatial high-pass of the log image ≈ reflectance
structure (identity); the low-pass ≈ illumination field (nuisance, but
useful — it calibrates the scene). One Gaussian blur and a subtraction.

## 2. Identity as a quotient (the central mathematical object)

Let s(object, conditions) ∈ ℝ^D be the signature the pipeline extracts.
Conditions range over the **nuisance group**:

```
G = illumination × exposure/gamma × white-balance × scale × rotation
    × pose × partial-occlusion × background × sensor × time
```

One object does not have one signature; it has an **orbit**:

```
Orbit(obj) = { s(obj, g) : g ∈ G }
```

**Identity is the orbit, not any point on it.** Equivalently, identity
lives in the quotient space Signature-space / G. The system's three jobs,
restated in this language:

- **Capture** = sample the orbit (varied conditions, deliberately).
- **Modeling** = represent the orbit compactly: which directions of
  signature space does this object sweep as conditions vary (nuisance
  directions), and around what center (the invariant core)?
- **Recall ("seeing everywhere")** = given a new sample, find the stored
  orbit it lies on. Not "nearest stored point" — nearest stored ORBIT.

Locally (and empirically it is a good approximation), an orbit is an
affine subspace:

```
s(obj, g) ≈ μ_obj + B_obj · θ(g) + ε
```

μ_obj = the invariant prototype. B_obj = the nuisance basis (top principal
directions of the object's own within-variation). θ(g) = the condition
coordinates. ε = residual (should be small; its distribution defines the
object's confidence boundary).

**Key structural fact:** the nuisance directions are largely SHARED across
objects — "what exposure change does to a signature" is a property of the
pipeline and physics, not of the object. So the pooled within-class
covariance W (computed across all objects) estimates the common nuisance
geometry, and the metric

```
d²(q, μ) = (q − μ)ᵀ W⁻¹ (q − μ)         (Mahalanobis / within-class whitening)
```

automatically discounts movement along nuisance directions and amplifies
movement across them. The system currently uses only diag(W) (the
per-dimension Fisher ratio). **This is the single deepest known limitation
of the current build**: correlated nuisance (a lighting change moves 50+
dims coherently) cannot be canceled dimension-by-dimension. Full whitening
is closed-form (Cholesky + Ledoit-Wolf shrinkage for small-N stability —
the shrinkage intensity itself has a closed-form estimator, so no tuning)
and is the first thing to build (Part V, move #1).

## 3. Why the orange works — the theory validating itself on the easy case

Run the theory on the orange:

- **Spectral ratio invariants** (log R/G, log R/B of the body color): oranges
  cluster tightly; the ratios survive illuminant change by von Kries.
- **Microtexture**: peel dimples produce a stable LBP/spatial-frequency
  signature at a characteristic scale — a *reflectance* property, visible
  in the high-passed log image regardless of lighting.
- **Subsurface scattering**: peel translucency produces measured
  edge-softness and boundary warm-shift — matter interacting with light;
  hard to fake, stable across cameras.
- **Shape**: near-sphere → flat radial profile, high radial symmetry,
  stable Hu/Fourier-Mellin descriptors under rotation.
- **Class coherence**: every orange shares this physics. Within-class
  spread of the invariant core is tiny.

All five families point the same direction, the class is physically
coherent, so few exposures suffice: the orbit is small and well-behaved.
**The orange is the system's hydrogen atom** — the simplest case where the
theory closes. The plan (Part V) deliberately grows outward from it:
first materials (coin, glass, wood, fabric — coherent physics), then
articulated/diverse classes (animals — needs modes + hierarchy + motion),
then scenes.

## 4. Where the difficulty actually lives (honest theory of failure)

1. **Metamerism.** RGB integrates spectra to 3 numbers; materials with
   different spectra can produce identical RGB under some illuminant
   (lemon vs tennis ball). No amount of color processing fixes this — the
   information does not survive the sensor. The system must KNOW which
   discriminations are color-impossible and route them to texture/shape/
   temporal evidence. This self-knowledge is the invariance ledger
   (Part IV §4.5).
2. **Within-class physical diversity.** "Dog" spans chihuahua→mastiff.
   No single invariant core exists; the class needs multiple modes
   (sub-orbits) plus a hierarchy (dogness → breed) so new instances match
   at the right level. Physically-coherent classes (most fruit, coins,
   bottles) don't have this problem — which is why the roadmap does them
   first.
3. **The tone pipeline g(·).** Consumer cameras auto-expose, auto-WB,
   tone-map, sharpen, compress — each step partially destroys the linear
   photon relationships the invariants rely on. Log-ratio features survive
   gamma approximately (gamma is a power law → scales log values) but not
   aggressive local tone mapping. Mitigations: estimate g where possible
   (§Part IV self-calibration), prefer gradients/ratios over absolutes,
   and record capture metadata (EXIF) whenever available.
4. **Segmentation entanglement.** If the object mask moves (different
   lighting → different mask → different pixels measured), every
   downstream invariant is polluted before it is computed. The mask must
   be computed from illumination-invariant quantities. (A concrete bug of
   exactly this type was found and fixed 2026-07-08 — Part III §3.)
5. **Projection.** A 2D image is a projection of a 3D object; extreme pose
   change moves the orbit nonlinearly. Local linearization (subspace per
   mode) handles moderate pose; full 3D latent structure is the eventual
   answer and is deliberately deferred (it is not needed to prove the
   photometric quotient works).

---

# PART III — HONEST CURRENT STATE (what exists, what's proven, what's retracted)

## 1. The codebase (all paths absolute, all real as of 2026-07-08)

```
C:/AtomEons/Orange5/07-VISUAL/structural/
├── photoreceptor.mjs                  Naka-Rushton retina front-end (R = L^n/(L^n+K^n))
├── photoreceptor-adapt-frame.mjs      per-channel adaptation, K = scene mean  ← flaw, see §3
├── prism.mjs                          extractImageRGB (ffmpeg → {R,G,B,w,h} Float32, 0..1)
├── video-frames.mjs                   extractVideoFrames (ffmpeg frame ripper → prism)
├── retinal-transform.mjs              12 Werblin retinal channels + texture vocabulary
├── axes/                              13 axis modules (color-ratio, edge, hu-moments,
│                                      persistent-homology, photon-correlation,
│                                      photon-histogram, radial-photon, spatial-color,
│                                      spatial-frequency, specular, subsurface, texture,
│                                      texture-vocab)
├── binders/                           6 object-binding strategies + sweep harnesses
├── graph/celtic-graph.mjs             concept graph substrate
└── identity/
    ├── recognize-human-grade.mjs      extractWarmEntities + signatureForRegion/Union
    │                                  (14-key rich signature; lighting fix applied here)
    ├── fisher-ratio-signature.mjs     flattenSignature (172-D) + diagonal Fisher stats
    ├── identity-store-v2.mjs          store schema + richDistance
    ├── second-pass-alpha.mjs          learnChannelWeightsFromData (Hebbian re-weighting)
    ├── knot-vector-index.mjs          100k-capacity ANN (26.6ms p50 at 100k, proven)
    ├── prove-all-on-store.mjs         4-classifier side-by-side validator
    ├── prove-subset.mjs               label-filtered validator
    └── [~20 more prove-*.mjs]         experiment battery from waves 1–4

C:/AtomEons/Orange5/07-VISUAL/fixtures/
├── youtube-corpus/                    ~166 concept dirs of short clips (yt-dlp),
│   └── store-wave2-*.json             various stores — see per-store status below
└── meme-corpus/                       100 imgflip templates + 5 variants × top-30
    └── store-memes-enriched.json      28 labels × 4 sigs, clean held-out
```

The 172-D flattened signature layout (order is contract — never reorder):
color 8 · edge 10 · texture 10 · specular 3 · spatial 27 · subsurface 4 ·
colorRatio 6 · spatialFreq 6 · retinal12 4 · hu 9 · photon_hist 46 ·
photon_corr 6 · radial 33.

## 2. Verified results and retractions (the receipts trail)

| Claim | Status | Evidence |
|---|---|---|
| 96% (27/28) on meme templates, NLL classifier, variant-5 held out | **VERIFIED, clean** | spine seq 60; store + prove-memes.mjs reproducible |
| 88% on N=17 YouTube "photonic" store | **RETRACTED — leaky** | training touched the held-out clip |
| 94% on N=22 K=3 store | **RETRACTED — leaky** | reingest-k3-medoids.mjs iterated ALL clips incl. `files.at(-1)` held-out; confirmed vs 2-clip `cat` dir; spine seq 62 |
| Honest YouTube cross-clip, proper held-out, 172-D flat pipeline | **19-25%** at N=17–54 | prove-all runs on reenriched stores; spine seq 61 |
| Frame-vote gate knobs (consensus/margin/ceiling/bioT/voteT) | **INERT** — all 5,280 combos identical | sweep-5000; the signal is not in decision gating |
| Six classifier attacks (LGN temporal, part-attention, contrastive, query-aug, sibling-tiebreak, texture-vocab) | **No lift** (flat or regressed on N=17) | 16-agent adversarially-verified workflow |
| NLL ≥ baseline everywhere tested; margin grows with sigs/concept and with N | **VERIFIED** | 88→94 (leaky store, more sigs), 49→54 (stale N=39), 89→96 (memes) |
| Training/inference schema mismatch (8-key vs 14-key stores) collapses recognition | **VERIFIED + FIXED** | spine seq 59; reenrich pipeline rebuilt stores |
| Warm-mask computed on raw frame while signature computed on adapted frame (lighting-dependent segmentation) | **VERIFIED + FIXED 2026-07-08** | recognize-human-grade.mjs:120 now extracts on adapted frame; spine seq 63 |
| 95.1% label recall at 100k signatures, 26.6ms p50 (index layer, not recognition) | VERIFIED earlier | knot-vector-index receipts |

**Interpretation discipline for any future model:** the 19-25% number is
not "the idea fails." It is the measured performance of *Layer-1 flat
matching with ~90% illumination-coupled dimensions, diagonal-only nuisance
handling, and (until yesterday) lighting-coupled segmentation*, on the
hardest split. The meme 96% shows the pipeline recognizes cleanly when the
nuisance group is small. The gap between those two numbers IS the nuisance
group — which is exactly what Parts IV–V attack.

## 3. The three root causes found this wave (all receipts on the spine)

1. **Schema mismatch** (seq 59) — stores built by an older signatureForUnion
   had 8 keys; queries compute 14. Fisher statistics fitted on mixed
   spaces are garbage. Fixed by rebuilding stores from disk clips.
2. **Benchmark leakage** (seq 62) — the K=3 ingest trained on every clip
   including the one the validator holds out. All pre-2026-07-08 YouTube
   numbers ≥88% are void. Meme numbers unaffected (true unseen variant).
3. **Lighting-coupled segmentation** (seq 63) — mask from raw pixels,
   signature from adapted pixels. Same object, different lighting →
   different mask → different measured pixels. Fixed: mask now computed on
   the adapted frame. (Fable's note: the *right* fix is deeper — see
   Part IV §4.1 — because scene-mean adaptation is itself composition-
   dependent.)

---

# PART IV — THE SYSTEM DESIGN (perfected plan)

Architecture (composes both doctrines; each stage names its receipt):

```
                   image / video frames
                          │
        ┌─────────────────▼──────────────────┐
        │ A. SELF-CALIBRATION FRONT-END      │  estimate the camera+scene, then remove it
        │    illuminant (3 estimators, vote) │
        │    exposure / gamma proxy          │
        │    blur / noise / compression score│
        │    output: calibration vector c⃗    │
        └─────────────────┬──────────────────┘
                          │  calibrated log-RGB + c⃗
        ┌─────────────────▼──────────────────┐
        │ B. INTRINSIC SPLIT                 │  log I = log E + log R
        │    high-pass → reflectance image   │  (identity carrier)
        │    low-pass  → illumination field  │  (nuisance, kept for c⃗)
        │    shadow & specular masks         │
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │ C. BINDING (object segmentation)   │  on ILLUMINATION-INVARIANT quantities only
        │    existing binder suite, hue gates│
        │    run on reflectance image        │
        └─────────────────┬──────────────────┘
                          │  regions
        ┌─────────────────▼──────────────────┐
        │ D. MEASUREMENT SUBSTRATE           │  five families, invariance-annotated
        │  D1 photometric: dichromatic body  │
        │     color, log-chroma ratios,      │
        │     within-object cell/ring ratios │
        │  D2 boundary: multi-scale Laplacian│
        │     curvature, junctions, corners, │
        │     Fourier-Mellin shape           │
        │  D3 material: LBP + spatial-freq   │
        │     (on reflectance), specular/    │
        │     diffuse split, subsurface      │
        │  D4 topology: component & adjacency│
        │     graphs, symmetry, CoM layout   │
        │  D5 temporal: flow coherence,      │
        │     deformation class, flicker/    │
        │     gait spectrum                  │
        └─────────────────┬──────────────────┘
                          │  signature s ∈ ℝ^D  (+ c⃗)
        ┌─────────────────▼──────────────────┐
        │ E. WHITENED QUOTIENT SPACE         │  W = pooled within-class covariance
        │    s̃ = W^(−1/2) · (s − μ_global)   │  (Ledoit-Wolf shrinkage, closed form)
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │ F. RECALL                          │
        │  F1 gist index: coarse hash on the │
        │     strongest invariants → top-K   │
        │     (knot-vector-index hosts this) │
        │  F2 orbit fit: distance to each    │
        │     candidate's subspace           │
        │     μ_c + B_c·θ; solve θ closed-   │
        │     form; residual = evidence      │
        │  F3 plausibility gate: fitted θ    │
        │     must be physically possible    │
        │     (exposure bounds, Planckian    │
        │     illuminant, scale sanity)      │
        │  F4 unknown gate: residual >       │
        │     95th-pct of concept's own      │
        │     residuals → "unknown"          │
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │ G. OUTPUT (explanation, not label) │
        │    identity + residual + fitted    │
        │    conditions + per-family evidence│
        │    + alternatives + unknown status │
        └─────────────────┬──────────────────┘
                          │
        ┌─────────────────▼──────────────────┐
        │ H. CONSOLIDATION                   │  fits family → Welford-update prototype/basis
        │    (memory that grows, never       │  doesn't fit → exception; 3 clustered
        │     retrains)                      │  exceptions → new mode of the concept
        └────────────────────────────────────┘
```

## 4. Component specifications (enough detail that any model can build them)

### 4.1 Self-calibration front-end (stage A)
Three closed-form illuminant estimators, run all, take the coordinate-wise
median, store all three + spread as confidence:
- **White-patch:** 99th-percentile of each channel ≈ illuminant color
  (assumes some near-white or specular surface exists).
- **Gray-edge:** mean gradient magnitude per channel; ratios estimate the
  illuminant (Weijer's gray-edge hypothesis).
- **Specular-based:** the dichromatic fit's illuminant direction (§4.2) —
  the physically-best estimate when speculars exist.
Exposure proxy: log of median luminance. Gamma proxy: ratio of
median-to-mean log-luminance. Blur: energy above ½-Nyquist. Noise:
median absolute Laplacian in flat regions. Compression: 8×8 blockiness
score. → calibration vector c⃗ (~10 dims), attached to every signature.
**Replaces the current K=scene-mean adaptation flaw**: adaptation constant
becomes K = estimated-illuminant-luminance, per channel — a property of
the LIGHT, not of the background furniture.
*Receipt:* on the capture matrix (§4.6), same-object-different-light
signature distance must drop vs current adaptation; report before/after.

### 4.2 Dichromatic plane fit (stage D1's engine — highest-value new module)
Per region: stack N pixels as an N×3 matrix P (linear-ized RGB — undo
gamma with the §4.1 estimate). SVD: P ≈ U Σ Vᵀ. For a single dielectric
material under one illuminant, rank ≈ 2:
- Identify the **illuminant direction** v_illum among {V₁, V₂} as the one
  closer to the §4.1 illuminant estimate (or to neutral).
- The other direction, projected to be ⊥ v_illum and positive, is the
  **body color** — the illumination-corrected material identity. Store its
  chromaticity (2 dims) as the primary photometric invariant.
- **Specular fraction** = energy along v_illum beyond the diffuse baseline.
  Gate: metals (≈no body component) / dielectrics (both) / emitters &
  screens (poor plane fit, σ₃/σ₁ high) — a 3-way material-class from one SVD.
- **Plane residual** σ₃/σ₁ = "is this region one material?" — doubles as a
  segmentation-quality check for stage C.
*Receipt:* bodyColor stability across the capture matrix ≥5× better than
mean-RGB stability, measured as within-object/between-object variance ratio.

### 4.3 Invariant coordinates for existing families (repair, not replace)
The current spatial-27 and radial-33 dims are absolute colors → nuisance-
coupled. Re-express, same dimensionality:
```
cell_invariant = log(cell_color) − log(object_body_color)     (per channel)
ring_invariant = log(ring_c)     − log(object_mean_c)         (per channel)
```
Both parts of each difference see the same illuminant → von Kries factor
cancels exactly. Spatial STRUCTURE is fully retained; only the nuisance
leaves. Also: compute texture/spatial-frequency families on the
reflectance (high-passed log) image from stage B, masking shadow/specular
pixels. *Receipt:* invariance-ledger entries (§4.5) for old vs new dims.

### 4.4 The photon genome (storage schema — replaces bag-of-vectors)
```jsonc
{
  "concept": "orange",
  "hierarchy": ["object", "food", "fruit", "citrus", "orange"],   // match at any level
  "modes": [                       // physically distinct sub-populations (ripe/green…)
    {
      "prototype": [/* D floats, whitened coords */],
      "nuisance_basis": [/* k×D — top PCA dirs of THIS concept's within-variation */],
      "residual_q95": 0.31,        // unknown-gate threshold, from ITS OWN residuals
      "n_observations": 14,
      "welford_state": {/* running mean+cov for exact incremental update */}
    }
  ],
  "material_class": "dielectric",  // from dichromatic gate
  "evidence_profile": {            // which families actually discriminate this concept
    "photometric": 0.92, "boundary": 0.71, "material": 0.88,
    "topology": 0.44, "temporal": 0.12
  },
  "confusable_with": [             // negative knowledge, from the ledger
    {"concept": "tangerine", "resolved_by": "size_ratio+peel_texture_scale"},
    {"concept": "peach",     "resolved_by": "specular_fraction+texture_spectrum"}
  ],
  "exceptions": [/* parked non-fitting observations; 3 clustered → new mode */]
}
```
Recognition = fit to modes' subspaces (closed-form least squares for θ),
report best residual. "Once it trains on an orange it gets it" formalized:
after ~5 varied observations the prototype+basis stabilize (Welford
convergence is measurable — report the trace of the running covariance),
and every future orange is a lookup.

### 4.5 The invariance ledger (the system's self-knowledge — Mom's Law as a data structure)
With the capture matrix (§4.6), compute for every dim d and nuisance axis a:
```
stability(d, a) = Var[s_d | object fixed, ONLY axis a varies] / Var[s_d | objects vary]
```
Published as a table (a JSON artifact + receipt). Three consumers:
1. **Feature triage with proof** — kill or repair dims that fail an axis.
2. **Query-adaptive metric** — c⃗ tells us which axes differ between query
   and stored conditions; weight dims by measured stability under *those*
   axes specifically.
3. **Honest capability statements** — "this system is invariant to
   illuminant color within ±X, exposure within ±Y EV; it is NOT invariant
   to pose beyond ±Z°" — printed from measurements, not asserted.

### 4.6 The capture matrix (the 10-object experiment — the narrow test that comes first)
Objects (chosen so each stresses a different physics): apple, orange,
coin, glass, wood block, plastic item, metal spoon, leaf, fabric swatch,
paper. Conditions, fully crossed where possible:
```
illuminant: daylight · warm LED · cool fluorescent · dim
camera:     ≥2 different sensors (phone + webcam)
angle:      ≥3 (0°, ~45°, ~90°)
distance:   ≥2 scales
background: ≥2 (light, dark)
```
Every sample stored with its condition labels + EXIF + estimated c⃗.
**Pass criterion:** identity survives the condition change — Top-1 ≥90% on
held-out CONDITIONS (train on a subset of conditions, test on unseen
conditions of the same objects) with unknown-gate honesty (a novel 11th
object must trigger "unknown" ≥80% of the time). This validates the
quotient thesis directly, before any scale-up. Then broaden: Grand Test
(100 concepts × 20 varied samples — Doctrine 1) as milestone 2.

### 4.7 Temporal identity (stage D5 — video as physics witness)
Per region across the 4–8 frames already extracted:
- mean log-L time series → detrended FFT magnitude → {DC, low, mid, high}
  band energies + spectral flatness: rigid (DC) vs flicker (broadband,
  fire/screens) vs periodic (gait) vs drift (water/cloth).
- coarse block-matching flow (already built in the depth-primitives wave,
  task #32): flow coherence = rigid vs deforming.
~8 dims total, reuses paid-for frames, discriminates exactly the classes
color cannot (fire vs orange cloth; screen-photo vs real scene — pairs
with the existing spatialFreq LCD-grid detector).

### 4.8 What is deliberately deferred (so nobody wastes cycles)
3D reconstruction · active sensing controller · full scene graphs ·
hyperspectral/polarization/event capture. All real, all doctrine-aligned
(Doctrine 2 items 2, 3, 9, 10) — none needed to prove the photometric
quotient. Defer until the 10-object test passes.

---

# PART V — THE EXECUTION PLAN (ordered, receipted, no step optional)

Each step names its falsifiable receipt. A step without its receipt is
not done (Mom's Law). Estimated effort assumes the current codebase.

**Move 1 — Within-class whitening metric.** `whitened-metric.mjs`:
pooled within-class covariance + Ledoit-Wolf shrinkage (closed-form) +
Cholesky solve; slot into prove-all as a 5th classifier next to diagonal
Fisher. *Receipt:* score table diagonal-vs-whitened on the lighting-fixed
medoid store (same split). This is the cheapest possible test of the
entire quotient thesis — hours of work, run it FIRST. If whitening lifts
markedly, the thesis is confirmed and everything else multiplies it; if
not, the nuisance is nonlinear and Moves 2–4 become even more important.
*(Expectation, stated for falsifiability: significant lift. If flat, say so.)*

**Move 2 — Dichromatic module.** `axes/dichromatic-axis.mjs` (§4.2).
*Receipt:* bodyColor ≥5× more stable than mean-RGB across lighting on the
capture matrix (or, until the matrix exists, across the existing
same-concept different-clip pairs).

**Move 3 — Self-calibration front-end** (§4.1) replacing K=scene-mean, +
shadow/specular masking (from Move 2's fit + intrinsic split). *Receipt:*
same-object cross-lighting signature distance, before vs after; plus no
regression on memes (the easy-domain canary).

**Move 4 — Invariant coordinates** for spatial + radial families (§4.3),
texture on reflectance image. *Receipt:* ledger rows old-vs-new.

**Move 5 — The capture matrix** (§4.6). A capture-day protocol document +
ingest script + condition-labeled store. *Receipt:* the dataset exists
with full condition labels; ledger v1 computed from it (§4.5).

**Move 6 — Photon genome + orbit recall** (§4.4): subspace storage, F1–F4
recall (gist index on the knot-vector-index, closed-form θ fit,
plausibility gate, unknown gate), explanation output (stage G). *Receipt:*
the 10-object test pass criterion (§4.6), including the unknown-gate
honesty test with the 11th object.

**Move 7 — Fourier-Mellin + temporal spectrum** (§4.7, D2/D5 completion).
*Receipt:* ledger rows; lift on pose/scale axes of the matrix.

**Move 8 — Scale-up.** Rebuild the YouTube corpus stores through the new
pipeline (A→E), rerun the honest cross-clip benchmark at N=54+, then the
Grand Test design (100×20). *Receipt:* honest score progression published
with the same split discipline; consolidation (stage H) demonstrated by
feeding new clips of known concepts and showing prototype convergence
without retraining.

**Move 9 — Hierarchy + modes** for physically-diverse classes (animals).
*Receipt:* dog-family recognition where breed-level fails but dogness-level
passes, with the hierarchy match level reported honestly.

Dependencies: 1 is independent (do first). 2→3→4 chain. 5 gates 6's full
receipt (but 6 can be built against existing stores). 7 anytime after 4.
8 needs 1–6. 9 needs 8.

---

# PART VI — FOR THE NEXT MODEL (cold-start orientation)

## What to internalize before touching anything
1. Read Part I §2–3 until the spectrometer frame displaces the classifier
   frame in your reasoning. If you catch yourself proposing a CNN,
   contrastive pretraining, or CLIP embeddings — stop; you have dropped
   the mission. The constraint is not ignorance of deep learning; it is a
   deliberate architecture: **the sensory channel that cannot confabulate.**
2. The operator's language key: *"photon pattern"* = the object's stable
   effect on light (invariant conjunction), NOT pixels. *"Capture"* =
   sampling the orbit. *"Modeling the signature"* = compressing the orbit
   to prototype+basis+residual. *"It gets it"* = after few varied
   observations, recognition is deterministic lookup. *"Sees everywhere"*
   = matching survives the nuisance group.
3. Honest-numbers discipline: the only trustworthy current numbers are
   meme 96% (clean) and YouTube 19-25% (proper held-out, Layer-1
   pipeline). Anything ≥88% on YouTube from before 2026-07-08 is leaky —
   do not cite it, do not chase it.
4. Never bypass the spine. Results → `spine-cli.mjs --order` → receipt.
   Receipts so far in this arc: seq 59 (schema), 60 (memes), 61
   (diagnosis), 62 (leakage), 63 (lighting fix), 64 (Doctrine 1), 65
   (Doctrine 2), 66 (this document v1).
5. Give agents absolute `C:/AtomEons/Orange5/...` paths (sibling worktrees
   exist; agents stray). Verify writes landed. Bash tool on this box is
   Git Bash; heredocs beat quoting games; `bun -e` with complex quotes
   often fails silently — write a script file instead.

## Glossary (terms as used in this project)
- **Photon pattern** — the invariant conjunction of photometric, textural,
  structural, and temporal properties an object imposes on light.
- **Nuisance group G** — all transformations that change the image without
  changing the object (light, camera, pose, scale, background…).
- **Orbit / transformation family** — the set of signatures one object
  produces as conditions sweep G; stored as prototype + basis + residual.
- **Quotient space** — signature space with G divided out; where identity
  lives.
- **von Kries** — diagonal model of illuminant change; the reason
  log-ratios are invariant.
- **Dichromatic model** — pixel = body reflection + specular reflection;
  the plane fit that separates material color from illuminant.
- **Intrinsic split** — log-image = smooth illumination + sharp reflectance.
- **Metamerism** — different spectra, same RGB; the physical limit of
  color evidence.
- **Whitening / Mahalanobis** — metric that discounts the empirically
  measured nuisance covariance; the full-matrix upgrade of Fisher ratio.
- **Ledoit-Wolf** — closed-form shrinkage estimator making covariance
  inversion stable at small N (no tuned parameter).
- **Fisher ratio (diagonal)** — between-class / within-class variance per
  dim; the current metric; blind to correlated nuisance.
- **NLL classifier** — per concept, Σ_frames log(1+min-distance); the best
  current recall rule; the margin between top-2 NLLs is the confidence.
- **Photon genome** — the per-concept stored structure (§4.4).
- **Invariance ledger** — measured stability of every feature dim under
  every nuisance axis (§4.5).
- **Unknown gate** — reject when residual exceeds the concept's own 95th
  percentile; the "never lies" mechanism.
- **Capture matrix** — the designed {object × condition} dataset (§4.6).
- **Leakage** — any overlap between training and test sources; voids a
  benchmark.
- **FPS / medoid curation** — farthest-point sampling of diverse
  signatures for training; keeps the stored orbit spread out.
- **Mom's Law** — full effort, receipts for every claim, no fake-green
  (project constitution, inherited by every agent).

## FAQ a cold model will ask
**Q: Why not just fine-tune a small ViT? It would beat 25% immediately.**
A: It would also confabulate, cost training compute the operator does not
spend, violate the zero-parameter law, and break the product thesis: this
pillar exists to be the *auditable, deterministic* eye. Accuracy at the
cost of those properties is a different pillar (and already exists: AE Eyes).

**Q: Is 96% on memes meaningful?** A: As a canary, yes: it proves the
pipeline end-to-end recognizes when the nuisance group is small (web
images ≈ same "lighting"). As progress toward the mission, limited — the
mission's difficulty IS the nuisance group. Use memes as a regression
canary for every change (it should never drop), not as a victory metric.

**Q: What single experiment most advances the project?** A: Move 1
(whitening) for information-per-hour, then the 10-object capture matrix —
because it converts every subsequent debate ("is this dim invariant?",
"does this fix help?") into a table lookup with a receipt.

**Q: How do I know if I'm rearranging Layer-1 furniture?** A: Ask: does
this change (a) remove nuisance at the source (capture/calibration), (b)
add measured invariance (ledger-verified), or (c) change what is STORED
(orbit vs points)? If none of the three, it is furniture. Classifier
swaps, gate tuning, and threshold sweeps are furniture — this was proven
empirically with 5,280 configs.

---

# PART VII — THE ONE-PAGE COMPRESSION

An object transforms light in a way that is characteristic of its matter
and shape. A camera sees that transformation entangled with the light
source, the sensor, and the viewpoint. **Capture** means sampling that
entanglement deliberately. **Modeling** means separating it — with physics
(dichromatic fit, log-ratios, intrinsic split), then statistics
(whitening, per-concept subspaces) — until what remains is the object's
own signature: the photon pattern. **Recall** means asking, for each
stored object, "could this object, under SOME physically-plausible
lighting and camera, have produced what I am seeing?" and answering with
a residual, an explanation, and — when nothing fits — an honest "unknown."

Once it truly measures an orange, it has the orange everywhere. The
orange already works in the easy regime; the plan above is the shortest
receipted path to making "everywhere" literal. Identity is what survives
the quotient. Everything else is weather.

---
*v1 (one-look ideas) ledgered as spine seq 66. This v2 supersedes and
contains it. Author: Fable 5, at operator request, 2026-07-08.*
