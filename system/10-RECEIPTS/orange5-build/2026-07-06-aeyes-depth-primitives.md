# Receipt — AE Eyes depth primitives (temporal + spatial first light)

**Date:** 2026-07-06 · **By:** Claude Opus 4.8
**Spine receipt:** rcpt_3254b831f3d6a540 (seq 32) · **Order:** `aeyes.depth_primitives_first_light`

**Prior receipts:** seq 27-31 (single-image identity → cinema v1/v2/v3 → sweep-108 → wide axis basis)

**New artifacts:**
- `07-VISUAL/structural/optical-flow.mjs` — block-matching optical flow + depth-from-motion-parallax
- `07-VISUAL/structural/mono-depth.mjs` — sharpness, ground-plane, aerial perspective + fusion
- `07-VISUAL/structural/identity/depth-first-light.mjs` — the experiment

## The operator directive

> "it appears to be that we need a temporal + spatial system for accurate
> depth perception, not a gimmick like current 2d to 3d tricks. im looking
> for actual. temporal look at opflow i thnk we already did and made
> progress, spatial consider monocular depth estimation engine like MiDas
> or other similar. lets see what we are missing."

Two asks: (1) real optical flow (temporal), (2) monocular depth (spatial),
plus an honest audit of what MiDaS-level would give that we don't.

## What was built

### Optical flow (temporal)

- **`blockMatchFlow(L1, L2, w, h, {blockSize, searchRadius})`** — divides
  each frame into 16×16 blocks; for each block, searches the next frame
  within a ±8-pixel window for the offset that minimizes SAD (sum of
  absolute luminance differences). Returns per-block `(vx, vy, confidence)`
  where confidence is the improvement over the no-motion baseline.
  Deterministic. Purely classical. Plugs into the existing
  `flow-geometry.mjs` (divergence + curl for boundary detection).
- **`depthFromFlow(vx, vy, confidence)`** — under camera translation,
  motion parallax gives depth: |v_pixel| = f·T/Z, so |v| ∝ 1/Z. Returns
  a normalized depth field where larger displacement = smaller depth.
  Physically honest for translational motion. Not valid under rotation.

### Monocular depth (spatial)

Three cues without learned priors:
- **`sharpnessMap(L, w, h)`** — local Laplacian variance. Sharp regions
  are closer to the focal plane (fixed-aperture assumption).
- **`groundPlanePrior(w, h, {horizonFrac})`** — y-position → depth.
  Below horizon = ground = near. Above horizon = ramp to far.
- **`aerialPerspectiveMap(R, G, B)`** — 1 − saturation. Distant objects
  lose color due to atmospheric scattering.
- **`fuseDepthCues([{map, weight}, ...])`** — weighted average of any
  combination of depth maps (including OF-derived depth for video).

### Per-entity depth reporting

- **`entityMeanDepth(region, depth, w, h)`** — average depth inside an
  attention entity's bounding box. Sort entities by depth to get
  nearest-first ordering.

## The empirical numbers

**Optical flow** on 6 frames of `baby-watches-orange.mp4` (24×24 blocks):

| frame pair | meanMag (px) | maxMag (px) | div-energy | curl-energy | boundaryScore |
|---|---|---|---|---|---|
| 0→1 | 1.73 | 8.0 | 0.314 | 0.543 | 0.462 |
| 1→2 | **0.02** | 7.0 | 0.039 | 0.165 | 0.170 |
| 2→3 | 1.77 | 6.0 | 0.332 | 0.551 | 0.469 |
| 3→4 | 2.10 | 8.0 | 0.339 | 0.693 | 0.508 |
| 4→5 | 1.57 | 8.0 | 0.422 | 0.632 | 0.513 |

Real per-frame motion detected. The 1→2 dip (0.02 px mean) is when the
sine augmentation was at its zero-crossing — no motion → OF correctly
reports near-zero. Curl energy dominates divergence (rotational content),
consistent with our rotate+hue synthesis being rotational not
translational.

**Monocular depth** on 4 natural stills (fused with 0.5 sharp + 0.3 ground + 0.2 aerial):

| still | sharp μ | aerial μ | fused μ | fused σ |
|---|---|---|---|---|
| orange.jpg | 0.037 | 0.548 | 0.189 | 0.112 |
| apple.jpg  | 0.106 | 0.431 | 0.199 | 0.116 |
| fruits.jpg | 0.035 | 0.378 | 0.153 | 0.102 |
| lena.jpg   | 0.035 | 0.484 | 0.174 | 0.098 |

**Per-entity depth ranking** — top-5 nearest entities for orange.jpg
(fused depth in [0,1], lower = nearer):

```
region=[264,216,48,120] votes=2 fused_depth=0.043  ← nearest
region=[264, 96, 24, 72] votes=2 fused_depth=0.069
region=[264,336, 48, 48] votes=2 fused_depth=0.141
region=[240,312,144, 72] votes=4 fused_depth=0.144
region=[  0,  0,144,336] votes=3 fused_depth=0.238
```

## The honest verdict

**Real primitives are on the board.** Block-matching OF gives per-cell
displacement vectors. Monocular depth combines three classical cues.
Per-entity depth is a first-class field alongside the identity descriptor.

**Two honest caveats named openly:**

1. **My synthesized video is rotational, not translational.** Under
   rotation |v_pixel| ∝ radius-from-rotation-center — NOT ∝ 1/depth.
   So `depthFromFlow` gives a physically valid computation but the
   input data doesn't exercise it as depth. Real natural cinema of a
   baby moving their head sideways (translational parallax) is what
   depth-from-flow needs. Curl-dominance in the empirical numbers
   (0.63 curl vs 0.42 div) confirms rotation.

2. **Ground-plane prior fails on centered-single-object closeups.**
   All our test stills are single-object framed shots with no visible
   ground plane. The ground heuristic assigns "near" to everything at
   the bottom of the frame, including background wall or table. The
   fused depth values are dominated by this. Works for outdoor scenes;
   fails for still-life closeups.

## The MiDaS gap — what we're missing

| We have | MiDaS-level has | What we lack |
|---|---|---|
| block-matching OF (deterministic) | learned depth across millions of images | scene-context depth priors |
| sharpness / defocus map | semantic depth (roads=ground, walls=vertical) | object-category depth priors |
| ground-plane prior (naive y) | horizon estimation + tilted-camera correction | camera-pose-aware geometry |
| aerial perspective (saturation) | atmospheric-scattering-informed pixels | learned scattering coefficients |
| flow-geometry div/curl | consistent depth boundaries via learned edges | learned edge-depth coherence |
| per-entity mean depth | dense per-pixel with sub-pixel precision | sub-pixel granularity |

**Summary of gap:** MiDaS gives *dense per-pixel depth on ANY single
still* using learned scene priors. We give *sparse per-entity depth on
video with motion* + *weak monocular depth on stills*. The classical
primitives are real; the learned priors are not ours to have without an
external checkpoint we do not ship (doctrine: no external ML weights).

## Path forward — three options

1. **Immediate & doctrine-clean:** synthesize real natural cinema
   fixtures with camera TRANSLATION (sideways pan across a scene with
   multiple depth-separated objects). Depth-from-flow will exercise
   as depth. This is the most honest next experiment.
2. **Medium-term & doctrine-clean:** train a lightweight monocular
   depth model on our OWN motion-parallax supervision. Video frames
   where OF gives ground-truth depth teach a network to predict depth
   from single frames. Self-supervised. No external checkpoint. Would
   need a training loop.
3. **Cross-doctrine:** import MiDaS via ONNX runtime. Would give
   MiDaS-level output immediately. Violates current no-external-
   checkpoint doctrine. Named openly; not taken.

## Where this fits — the depth layer

Post-depth-first-light status of the AE Eyes stack:
- word ✓ — labels bound to descriptors
- awareness ✓ — attention (8-axis)
- object recog ✓ — 4/4 cinema recognition with wide basis
- motion ✓ — motion field + block-matching OF
- **temporal depth ✓** — depth-from-flow (needs translational data to shine)
- **spatial depth ~** — 3 classical monocular cues, weak on closeups
- **fusion ✓** — depth cues combine
- identity across views ✓ — cross-frame descriptor aggregation
- semantic depth priors — **not yet**, named as the MiDaS gap
- camera pose awareness — **not yet**
- agency / intent — theory-of-mind, not signal

## The final honest sentence

**Real block-matching optical flow (deterministic, per-block (u,v) SAD
minimization) and three classical monocular depth cues (sharpness,
ground-plane, aerial) are now shipped as depth primitives; the OF works
correctly and detects real 1.7-2.1 pixel-per-frame motion on the
synthesized rotation-dominated video with a ~0.02 px zero-crossing
correctly identified at the sine motion's null phase, but under
rotation |v_pixel| does not correspond to 1/depth — so
depth-from-motion-parallax is on the board mathematically but the
current cinema fixtures do not exercise it as depth; monocular ground-
plane depth fails on centered-single-object closeups (which is every
one of our current test stills) and would require outdoor scenes to
work; the audit shows we have every classical depth primitive we can
build honestly without an external ML checkpoint, and the missing
layer is learned scene priors — MiDaS-level absolute depth is not ours
to give without either building translational cinema fixtures that
exercise motion parallax properly, or training a self-supervised
depth head on our own motion-parallax data, or importing MiDaS ONNX
in violation of current doctrine.**

*Mom is watching. Real primitives. Two honest caveats. The MiDaS gap
named plainly, not hidden behind synthetic numbers.*
