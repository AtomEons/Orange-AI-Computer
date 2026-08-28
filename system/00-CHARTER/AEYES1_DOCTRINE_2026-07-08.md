# AEyes¹ Architectural Doctrine — 2026-07-08

Written by Ætom ÆoNs. Canonical for AEyes¹ development going forward. Sits alongside `ORANGE5_THE_PATH.md`.

## Identity

**AEyes¹ is a deterministic visual cortex front-end** that converts light fields into an identity-preserving symbolic representation. Not a recognizer. Not competing with VLMs. The non-generative sensory layer — a system that cannot hallucinate because it cannot generate, only measure and structure.

Sits alongside AE Eyes (VLM), MiniEyes (QLoRA), AE Cobra (2-LoRA) — the identity path that never lies.

## Current stack is Layer 1 of a 5-Layer target

Today:

```
Image
 ↓
photoreceptor normalization
 ↓
handcrafted feature vector (172-D)
 ↓
nearest signature
 ↓
label
```

Target:

```
Photon field
 ↓
retina-like normalization + camera self-calibration
 ↓
edges / color / motion / contrast primitives
 ↓
object boundaries
 ↓
parts
 ↓
3D structure
 ↓
object identity
 ↓
confidence + evidence + alternatives + unknown-threshold
```

## Phase 1 — Fix the measurement substrate

Expand 172-D into **five families**:

1. **Photometric invariants** (same object under different cameras/light)
   - HSV saturation/value
   - normalized chromaticity: r/(r+g+b), g/(r+g+b), b/(r+g+b)
   - opponent color: R-G, G-B, B-R
   - illumination-invariant transforms

2. **Boundary identity** (shape is primary human cue)
   - multi-scale Laplacian
   - curvature maps
   - contour descriptors
   - edge-junction statistics
   - corner distributions
   - a cup = cylindrical boundary + handle loop + rim ellipse + shadow relationship

3. **Texture / material identity**
   - local binary patterns (already have)
   - Gabor filter bank
   - frequency energy bands
   - specular/diffuse ratio

4. **Spatial topology** (biggest missing category)
   - connected-component graphs
   - region-adjacency graphs
   - symmetry axes
   - center-of-mass relationships
   - internal/external contour ratios
   - represent objects as graphs, not vectors

5. **Temporal identity** (for video)
   - optical flow signatures
   - motion vectors
   - deformation patterns
   - temporal consistency
   - a dog moves like a dog

## Phase 2 — Kill flat nearest neighbor

Replace:

```
query signature → nearest stored signature → label
```

with hierarchical:

```
query
 ↓
primitive matching  ("does this have four legs?")
 ↓
part matching  ("does this have canine proportions?")
 ↓
object-graph matching  ("does this match a dog?")
 ↓
identity score  ("which dog?")
 ↓
confidence
```

The system becomes explainable.

## Phase 3 — Visual genome

Stop storing `dog.jpg → vector`. Store:

```
DOG
  shape: quadruped, elongated snout, bilateral symmetry
  texture: fur, variable color
  parts: head, torso, legs, tail
  motion: gait pattern
  photometric: fur reflectance signature
```

Database becomes a visual knowledge graph, not an image database.

## Phase 4 — Camera self-calibration

Before recognition:

```
image
 ↓
camera normalization  (estimate & normalize away: exposure, WB, gamma, compression, sensor noise)
 ↓
vision normalization  (retina-like adaptation)
 ↓
recognition
```

Humans don't see the camera. AEyes¹ needs to stop seeing the camera.

## Phase 5 — Uncertainty output

Output shape:

```
Prediction: Dog
Confidence: 92%
Evidence:
  - quadruped structure
  - fur texture
  - muzzle geometry
Closest alternatives:
  - wolf 7%
  - fox 1%
Unknown threshold: PASS
```

This is how "never lies" gets achieved.

## The Grand Test

Only honest benchmark.

**Dataset**: 100 concepts. Animals (dog, cat, horse, bird), objects (chair, phone, bottle, car), scenes (beach, kitchen, forest). Each concept × 20 samples with **different camera, lighting, background, angle**. Zero overlap between training and testing.

**Metrics**:
- Top-1 accuracy
- Top-5 accuracy
- Unknown rejection
- Confidence calibration
- Inference speed

**Milestones**:
1. 70% closed-set, 90% with confidence rejection
2. 90%+ closed-set

Nothing else counts as progress.

## What stays / what dies / what's new

**Keep**:
- Photoreceptor adaptation (Naka-Rushton per channel)
- Warm-mask lighting-invariance fix (2026-07-08, `recognize-human-grade.mjs:120`)
- Photometric family (extend)
- Texture family (extend with Gabor + specular/diffuse)
- Corpus of 166 concept dirs (raw material for Grand Test)
- FPS-medoid curation for diversity

**Kill**:
- Flat nearest-neighbor KNN classifier
- Per-concept set-of-signatures storage
- Classifier-tuning sweeps
- Chasing meme domain as endpoint (was a validation harness only)

**Add**:
- Boundary family (Phase 1)
- Spatial topology graphs (Phase 1)
- Temporal family (Phase 1)
- Camera self-calibration front-end (Phase 4)
- Hierarchical matcher (Phase 2)
- Visual-genome storage (Phase 3)
- Confidence + evidence + unknown-threshold output (Phase 5)

## Retracted prior claims

All were leaky, Layer-1-shallow, or on favorable domains — not honest measures of the target architecture:

- 88% on N=17 photonic YouTube
- 94% on N=22 K=3 store
- 96% on N=28 meme templates (real number but domain is favorable)
- Any signature-tuning sweep result

Honest baseline on YouTube with proper held-out and Layer 1 substrate: 20-25%. Not the ceiling — the current-substrate topping out.

## Reframe

Not: "AI can see because it learns photon patterns."

Closer: "AEyes¹ is a deterministic visual cortex front-end that converts light fields into an identity-preserving symbolic representation. A non-generative sensory system."

Different game. Not competing at recognition. Building the missing sensory layer.
