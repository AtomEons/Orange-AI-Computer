# AEyes¹ Photon Inference Doctrine — 2026-07-08

Written by Ætom ÆoNs. Sits on top of `AEYES1_DOCTRINE_2026-07-08.md`. Same day, deeper cut.

## The core reframe

Vision is not a measurement problem. **Vision is an inference problem.**

Current AEyes¹ asks: "What stored pattern is closest?" — a classifier.
Target AEyes¹ asks: "What physical object could have produced this pattern of light?" — a physics engine.

Store CAUSES, not appearances. Store how objects TRANSFORM LIGHT.

## The narrow mission

If AEyes¹ is specifically a *photon pattern recognition system*, do not try to rebuild the whole visual cortex. Build the thing that sits closest to the physical signal:

**A system that learns the invariant structure of light patterns produced by objects.**

An object does not have one photon pattern. A red apple produces a family:

```
APPLE:
  sunlight
  LED light
  shadow
  angle
  distance
  camera sensor
  compression
  background
```

The identity is what survives all of that. That stable structure IS the signature.

## The 4-layer photon stack

**Layer 1 — Photon statistics** (partial today; expand):
- spectral distribution
- intensity distribution
- local photon density
- wavelength relationships
- entropy
- photon arrival variance

**Layer 2 — Light interaction** (biggest new frontier — this is what turns a classifier into a physics engine):
- Leaf: absorbs certain wavelengths + scatters through cellular structure + characteristic microtexture
- Metal: specular reflection + sharp highlights + directional response
- Skin: subsurface scattering + blood absorption bands
- Wood: diffuse + grain-driven anisotropy
- Glass: transmission + refraction + edge highlights

Store how the object *modifies* the incoming light, not the outgoing pixel values.

**Layer 3 — Spatial photon topology**:
- gradients, boundaries, curvature
- symmetry axes
- repetition patterns
- scale relationships across regions
- connected-component adjacency

**Layer 4 — Temporal photon signatures**:
- Water: continuous deformation
- Fire: chaotic flicker
- Animal: biological motion
- Machine: rigid motion

Motion itself is a photon signature.

## The 10 missing pieces (in this doctrine's ordering)

1. **Object permanence / temporal identity** — one entry per object with a transformation family, not N stored examples
2. **3D reconstruction** — maintain a 3D hypothesis behind the 2D projections
3. **Attention as active sensing** — request the next measurement that would reduce uncertainty
4. **Hierarchical concepts** — dog inherits from mammal; new instances match at the closest ancestor
5. **Negative knowledge** — contradiction score alongside similarity ("trunk + leaves rules out dog")
6. **Generative simulation** — predictive perception; forward-simulate the hypothesis and compare to observed
7. **Invariance hierarchy** — explicitly enumerate transformations (lighting, camera, scale, rotation, pose, occlusion, material variation, time) and which invariants survive each
8. **Memory architecture** — invariant rules + prototype + exceptions + confidence boundaries, not example sets
9. **World coordinate system** — scene graph (a circle on a table = plate; rolling = wheel; held = coin)
10. **Proper photon-field representation** — RGB is lossy compression; where possible capture spectral / temporal / polarization / event information

## The architecture

```
REAL WORLD OBJECT
        |
        v
 emitted/reflected photons
        |
        v
 optical transformation (camera + optics)
        |
        v
 photon measurement (what we get)
        |
        v
 invariant photon signature (what we should store)
        |
        v
 identity hypothesis
        |
        v
 forward simulation of hypothesis
        |
        v
 compare predicted photon field to observed
        |
        v
 identity + confidence + evidence
```

At the highest level the recognizer is a physics engine: hypothesize → simulate → compare → pick lowest-error explanation.

## The narrow experiment (do this before broadening)

10 concepts, chosen for photon-interaction distinctiveness:
apple, coin, glass, wood, plastic, metal, leaf, fabric, skin, paper.

For each: sunlight / fluorescent / LED / dark-room / multiple cameras / multiple angles.

**Test**: can AEyes¹ identify the object/material AFTER the photon conditions change?

That is the actual test. Not "100 concepts × 20 samples" — that's Grand Test scope (Doctrine 1). This is the narrow physics-invariance validator.

## What survives from current substrate

- **Photoreceptor adaptation** — Layer 1 normalization brick
- **Warm-mask lighting-invariance fix (2026-07-08)** — Layer 1 normalization brick
- **Photon histogram / photon correlation / radial profile** — Layer 1 photon statistics, keep and extend
- **Subsurface scatter axis** — this is Layer 2 "light interaction" material identity, the gem in the current sub-substrate
- **166 concept dirs on disk** — raw material; labeling/structure will be reorganized around invariance discovery

## What changes fundamentally

- **Store per concept**: a *photon transformation family* — invariants + observed transformation axes + prototype + exceptions + confidence boundaries. Not a bag of 172-D vectors.
- **Recognition**: invariance matching + physical forward simulation. Not L2 distance.
- **Confidence**: explanation quality. "This is a cup because the predicted-cup photon field matches observed at 92% under estimated camera settings."
- **First real test**: 10-object invariance test, not 100-concept broad benchmark.

## The mistake to avoid

```
image pixels → label
```

The target:

```
light behavior → identity
```

## The mathematical object we are missing

**The invariant.** What stays constant when everything changes. That is the identity.

## The reframe of "photon pattern"

Not the appearance of an object. The stable pattern created when the object interacts with a measurement system. A fingerprint is not the appearance of a finger — it is the stable pattern created when the finger meets a measurement surface. Vision is analogous.

## Relationship to Doctrine 1 (5-phase perception stack)

Doctrine 1 describes the shape of the SYSTEM. This doctrine describes the shape of the MISSION. They compose:

- Doctrine 1 Phase 1 measurement substrate → provides the raw photon statistics + boundary + texture + topology + temporal families that Layer 1-3 of the photon stack need
- Doctrine 1 Phase 2 hierarchical matcher → becomes the physics-engine inference in this doctrine
- Doctrine 1 Phase 3 visual genome → becomes the photon-transformation family per concept here
- Doctrine 1 Phase 4 camera self-calibration → is exactly the "optical transformation" step in this architecture
- Doctrine 1 Phase 5 uncertainty → becomes the explanation-quality confidence here
- Doctrine 1 Grand Test → is the broader benchmark AFTER the narrow 10-object invariance test succeeds

The narrow 10-object physics-invariance test comes FIRST. Then broaden to Grand Test scope. Then generalize.
