# AE Structural Tokens v1 — the AI-native visual format

**Schema:** `09-SCHEMAS/ae-structural-tokens.v1.schema.json` · **Schema ID:** `ae.structural-tokens.v1`
**Pillar:** AE Eyes (04) · **Status:** spec locked 2026-07-06 · **Reviewer:** any capable model that respects Mom's Law

## What this is

The **API contract both AE Eyes paths compile to.** Every extractor — codec-domain or retinal-domain — emits a record matching this schema. The AI consumes structural tokens directly instead of learning perception from raw pixels.

## The doctrine (two roads, one output)

> Perception is not a learning problem — it is a compilation problem.

There are two deterministic extractors, both non-neural, that compile visual input to this format:

**Path 1 — Codec translator (fast road).** Every video codec (H.264, HEVC, AV1, VP9, MPEG-2, ProRes, DV) is already a compressed structural description of light. Motion vectors, block-level inter-frame prediction, DCT/wavelet coefficients, I/P/B-frame structure — the codec computed them all to compress the video, and everyone then re-rendered to RGB and threw them away. The codec translator terminates the decode one step earlier, at the intermediate representation, and re-attributes it to entities. Deterministic. No training. Unlocks every video corpus on Earth. Works on encoded video only.

**Path 2 — Retinal transform (true road).** Biological retinas process radiance, not pixels — a spatiotemporal differential field: `∇L`, `∂L/∂t`, `log(L+ε)`, `corr(∇L over spacetime)`. Four standard signal-processing operations, differentiable, cheap. Runs on any light-field input: real camera, event camera, synthetic renderer, LIDAR intensity, IR/UV, even internally generated / imagined fields. Substrate-invariant by construction. Downstream training is 1–2 orders cheaper (perception primitives already computed) but not eliminated.

Both feed the **same** `ae.structural-tokens.v1` record. The AI never knows which path produced its input. It just reads structure.

## What the record carries (see the schema for exact fields)

- **`provenance`** — which path, which source kind, translator version. Honesty: the AI can always know how much to trust temporal derivatives (a frame-rate-30 camera has aliased ∂L/∂t; a codec's I-frame regions have no motion field).
- **`photometric`** — substrate metadata kept SEPARATE from structure (color space, gamma, luminance range, HDR curve, resolution). The AI can reason about display substrate when relevant and ignore it otherwise.
- **`entities`** — persistent identity-preserved objects, with sparse motion samples `{ts, vx, vy, confidence, region}`, texture codes into a record-level vocabulary, and prediction-residual norms. Codec path clusters coherent motion-vector groups. Retinal path clusters coherent gradient+motion signatures.
- **`occlusion_events`** — timestamped regions where prediction failed / correlation broke. Codec surfaces these as intra-refresh blocks in P/B frames; retinal surfaces them as motion-correlation breakdowns.
- **`texture_vocabulary`** — small structural-signature vocabulary (DCT signature or gradient signature — never pixel patches). Entities reference codes; the codebook is deterministic per `(path, source_kind, translator_version)`.
- **`temporal_markers`** — scene cuts, global camera motion, lighting shifts, flicker, ego-motion. Codec detects these via I-frame insertion and global motion patterns; retinal detects via discontinuities in `∂L/∂t`.
- **`retinal_fields`** — present when `path='retinal'`. Summary statistics of the four fields at record level (gradient energy mean, temporal derivative mean, log-intensity range, motion-correlation coherence) plus an optional `tensor_ref` to the on-disk full tensor.
- **`notes`** — **Mom's Law channel**: honest disclosures from the extractor about what it could NOT see (codec blind spots hit, temporal derivative under-sampled, spectral response unknown, etc.). A structural record that hides its blind spots is fake-green.

## What this format does NOT do

- **Does not replace pixel embeddings.** ColPali/Qdrant retrieval still runs. Structural tokens flow in **parallel**, feeding AE Cobra memory, OrangeBrain routing, and the AtomSmasher compression sieve (structural tokens compress ~10–100× better than pixel embeddings).
- **Does not eliminate all training.** Downstream reasoning over structural tokens still requires an adapter or fine-tune. What is eliminated is the *perception* portion of training — the AI never has to learn edge detection, motion estimation, intensity normalization, or object binding from pixels.
- **Does not equal biological cognition.** It is a substrate on which cognition can sit. Cognition itself is a separate concern.

## Anti-drift

- **Additive.** This is a new schema; `orange.order.v1` and `orange.report.v1` are untouched.
- **Backend only.** No UI implications. Atomic Orange consumes if it wants to.
- **Bun / local / free.** Codec path shells out to `ffmpeg` (open-source). Retinal path is standard signal processing in Bun or a small Rust/Python worker. No paid deps.
- **Frontier-Isolation preserved.** All extraction is local; the frontier never sees the raw fields.
- **No fake-green.** Every record's `notes[]` must disclose the extractor's honest limits for that source. Producers that hide limits fail review.

## Empirical directional findings (from ÆYES v2 toy-scene work, 2026-07-06)

These are **directional signals**, not benchmark facts. The experiments were on
synthetic bouncing-ball scenes; the numbers are toy-scale. Use these to steer
what we build, not to over-claim outcomes.

### Confirmed (build)
- **The retinal transform itself is the load-bearing primitive.** The four-field
  differential representation (∇L, ∂L/∂t, log(L+ε), motion correlation) is
  measurably a better substrate than raw RGB at every tested clustering method.
  Extras give diminishing returns.
- **Objects are more predictable from their own future than from other regions
  at the same instant** (the operational definition). Implemented as a
  first-class validator: `07-VISUAL/structural/object-predictability.mjs`.
  Any downstream entity extractor must satisfy this qualitatively — anything
  that doesn't gets flagged in `notes[]`, not hidden.
- **Flow geometry (divergence + curl of the motion vector field) is the ONE
  tested enhancement that helped** — small effect but on the right side.
  Object interiors have low divergence; boundaries have high divergence and
  a curl flip. Implemented as `07-VISUAL/structural/flow-geometry.mjs`.

### Toy-tested and did not help — unresolved for real data
These directions were tested by a prior model on synthetic bouncing-ball
scenes and either did not help or hurt on that data. They are **not
prohibited**; they are unresolved on real corpora. If a future model has a
principled reason to try them on real video, they should — and honestly
report the result. Preserved here so we know what has already been tried
on toy data, not as laws we lock in.
- **Multi-scale Gaussian pyramid.** Toy result: hurt (σ=5 destroyed small
  objects). The principled critique — naive concatenation of blurred copies
  needs scale-selective attention, not blind concatenation — is real. On
  real natural-image statistics with objects at several scales, a *smart*
  multi-scale approach is still an open question.
- **Phase-only Fourier features (local patches).** Toy result: catastrophic
  at 4×4 patches. The classic "phase carries structure" (Oppenheim & Lim
  1981) result holds at global-image scale, not small-patch scale. On real
  data at reasonable patch sizes, unknown.
- **Acceleration ∂²L/∂t².** Toy result: 0.6× as sharp as velocity at a
  teleport (paired-delta physics). On smoothly-varying real video, whether
  acceleration adds signal beyond velocity is not yet tested here.
- **Residual-EMA regime learning.** Toy result: got worse over time. The
  critique — you need pattern-specific memory + trigger conditions, not
  blind residual accumulation — is architecturally strong. Any real regime-
  learning attempt should respect it, not that no such attempt is allowed.

### Refuted-and-restated (build differently)
- **Naive codec-domain clustering** cuts through object boundaries at the
  block level. The codec path contains the right *information* but needs
  downstream spatial aggregation (entity binding across blocks) before it
  becomes AI-native at the object level. The codec-translator's `notes[]`
  must disclose this honestly for any record it emits.

## Object as a validator (in scope for Eyes — the one ontology bit that IS vision)

An **object** is a region R where
`I(inside R at t ; inside R at t+1) >> I(inside R at t ; outside R at t)`.
That's the operational definition, and it's Eyes-scope because it's a check
we run on *what the retinal transform extracted* — not a claim about
cognition. Implemented as `07-VISUAL/structural/object-predictability.mjs`.
Everything else in the ÆYES v4.7 doctrine (self, attention, prediction,
seeing) is downstream of Eyes and belongs to the reasoning / action layer,
not this file.

## Our concept: Y (luminance) is the input

Our retinal transform runs on the pre-integrated luminance channel Y. That's
the concept and we build on it. Not a gap. Not a downgrade from a 14-channel
opponent-color version. The photoreceptor stage handles the nonlinear response
and adaptation; the four fields extract structural signal from R(x,y,t); the
object-predictability validator checks whether extracted entities behave like
objects. That whole pipeline works on Y and we drive it until it delivers
real cognitive results on real data or it honestly fails.

Additions to Y (e.g., color, event streams, higher-rate sensors) are welcome
when they demonstrably help on a real corpus — not when they're suggested by
theory alone.

## Anti-drift for the Eyes layer

- **Do NOT throw a large transformer at raw pixels and call it
  "photon-pattern learning."** The transform exists to *remove* substrate
  information a large model would otherwise re-learn as substrate-locked
  features.
- **Do NOT treat the codec translator as a general solution.** It is a
  shortcut on encoded video, not a replacement for the retinal transform.
  Reflected in `codec-translator.mjs` notes[].
- **Drive to real proven results or honest failure.** Toy-scene metrics
  steer the compass, but the finish line is real data. Any claim about
  Eyes that hasn't been tested on a real image or video is a hypothesis,
  not a result. Don't lock hypotheses into doctrine.

## References to build

1. **M1 — this spec.** ✅ landed 2026-07-06.
2. **M2 — reference codec translator (H.264).** ffmpeg motion-vector export + block-mode readout → `ae.structural-tokens.v1` records. New gateway route `/v1/visual/structure`. Closes the smoke test's `/v1/visual/*` route gap in the same pass.
3. **M3 — reference retinal transform.** Four fields over a frame/sequence, emit tokens. Works on any light-field input the codec path can't reach.

The full system, once both extractors ship:

```
INPUT VARIETY                             COMMON OUTPUT
─────────────                             ─────────────
encoded video ────► codec translator ────┐
(H.264/HEVC/AV1/VP9/MPEG-2/ProRes/DV)     │
                                          │
live camera ──────► retinal transform ────┤
event camera ─────► retinal transform ────┤
LIDAR intensity ──► retinal transform ────┼─► ae.structural-tokens.v1
IR / UV / multi ──► retinal transform ────┤        │
synthetic render ─► retinal transform ────┤        ▼
embodied sim ─────► retinal transform ────┤   AE Cobra + OrangeBrain +
imagined field ───► retinal transform ────┘   AtomSmasher sieve
```

Two upstream paths, one downstream ontology. Both deterministic. Neither requires the AI to learn to see.
