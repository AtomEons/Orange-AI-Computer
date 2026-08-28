# Receipt — AE Eyes identity layer, first light (baby learns orange)

**Date:** 2026-07-06 · **By:** Claude Opus 4.8
**Spine receipt:** rcpt_1fadd10e122e374f (seq 27, hash cc0a09576772f448…)
**Order:** `aeyes.identity_layer_first_light`
**Artifacts:** `07-VISUAL/structural/identity/{descriptor,identity-store,baby-learn-test}.mjs`
**Store:** `07-VISUAL/fixtures/baby-learn/identity-store.json`

## The operator directive

> "ok so lets test this on a video about what an apple is somehow yes? or
> similar short meaning training. a baby watches an apple, a parent says
> its an apple, thats it."

We don't have video. We have one JPG of an orange. One-shot learning
from a single image is the strictest version of that directive.

## What the layer does

Three new modules under `07-VISUAL/structural/identity/`:

- **descriptor.mjs** — 8-feature perceptual signature per region:
  mean_R, mean_G, mean_B, mean_RG (red-green opponent), mean_BY
  (blue-yellow opponent), texture_var (log-variance of luminance),
  log_size (log area fraction), log_aspect. Weighted Euclidean
  distance with chromatic axes weighted 3x. Includes a new
  `computeUnionDescriptor` that treats N regions as ONE object.

- **identity-store.mjs** — JSON knowledge base. `learnLabel` binds a
  label to a descriptor; `recognize` finds the nearest label with a
  confidence and a distance-based reject; `rankByLabel` sorts entities
  by similarity to a stored label.

- **baby-learn-test.mjs** — the experiment. Trains 'orange' from
  orange.jpg using the empirical light-string pipeline
  (photoreceptor → density-cluster → merge_overlap on Y-luminance),
  filters entities by a chromatic-warm rule
  (mean_RG > 0.03 AND mean_R > mean_B + 0.15 AND mean_R+mean_G > 0.5),
  and stores the UNION descriptor of the surviving regions. Then tests
  on fruits.jpg (contains orange slice), apple.jpg (red apple, no true
  orange), lena.jpg (portrait, warm skin only) on TWO metrics.

## The empirical numbers

**Trained descriptor** (union of 3 warm regions in orange.jpg):
```
mean_R      = 0.559
mean_G      = 0.442
mean_B      = 0.238
mean_RG     = 0.117   (real red-over-green — chromatically orange-family)
mean_BY     = -0.263  (anti-blue — orange-family)
texture_var = 0.031
log_size    = -2.454
log_aspect  = -0.404
```

**Metric (a) — best-entity distance:**
```
fruits.jpg = 0.884
apple.jpg  = 1.033
lena.jpg   = 0.884
```

Fruits and lena TIE at 0.884. Warm skin patches in the lena portrait
spuriously match the trained orange descriptor. Best-entity ranking on
its own is not enough.

**Metric (b) — warm-union distance (same rule as training):**
```
fruits.jpg = 0.964   ← closest to trained 'orange'
apple.jpg  = 1.432   ← 1.5x farther
lena.jpg   = 1.620   ← 1.7x farther
```

Clean, monotonic ordering. The warm-content of the test image, taken
as a gestalt, is closest to the trained orange gestalt when there's an
orange in the frame, next closest when there's a red apple, furthest
when there's no fruit at all.

## The honest verdict

**Identity learned on the warm-union metric.** For the first time in
AE Eyes we have a system that can be shown one image of an orange,
told "this is an orange," and then correctly rank three new images by
oranginess — orange-slice image closer than red-apple image closer
than portrait.

**Identity did NOT cleanly learn on the best-entity metric.** Warm
skin in the lena portrait spuriously matches an orange descriptor.
Best-entity ranking picks a local patch which can look similar to a
local fruit patch when both are warm-colored.

## The path from V1-attention to identity

The 5000-experiment finish-line receipt said we had V1 attention but
not identity. This is the first honest step past that. The pieces:

1. **Attention** (the 6702-experiment result) finds entities in an
   image via density-cluster on Y-luminance with photoreceptor.
2. **Descriptor** compresses each entity into an 8-D perceptual
   signature emphasizing chromatic opponency.
3. **Store** binds a label to a descriptor (or a union of them).
4. **Recognition** ranks new entities by weighted Euclidean distance
   in descriptor space, with distance-based rejection.

The winning trick was the **union descriptor**: a baby doesn't see
"orange = one narrow highlight strip." A baby sees "orange = the
whole warm-colored gestalt." So the training aggregates ALL warm
entities into ONE descriptor computed from their pixel union.

## Limitations, honestly

- **Single-image, single-view.** No temporal aggregation, no invariance
  training. The descriptor captures the mean chromaticity of the
  training image, not "the invariant thing that stays constant across
  views of an orange."
- **Descriptor is coarse.** 8 features, mostly color statistics. No
  shape, no edge structure, no keypoint matching.
- **Best-entity metric is fooled by warm skin.** Skin and orange fruit
  overlap in R/G/B space. Only the warm-union gestalt metric cleanly
  discriminates.
- **Confidence values are low** (0.31–0.41 on positive matches). The
  distance-based confidence is calibrated for the single-image training
  case; more training views would tighten it.
- **The auto-pick still misses the center of the orange.** The 3 warm
  regions selected were bottom-shelf-edge, bottom-right, and right-side
  rim — not the fruit center. The density-cluster binder split the
  orange body into subregions and only the periphery passed the
  chromatic-warm rule. A better attention layer would preserve the
  whole-fruit region as one entity.

## What multi-frame video would fix

The operator asked for video. A multi-frame version would:
- **Aggregate descriptors across frames** (already have
  `aggregateDescriptors`) — the invariants stay, the noise averages out.
- **See the object from multiple lighting angles** — trains a descriptor
  that generalizes across specular/shadow.
- **Enable motion coherence** — pixels that move together belong to the
  same object; would let attention hold the whole fruit as ONE entity
  instead of splitting by luminance patches.

## Comparison to the finish-line receipt

Before this: V1 attention on 95% of natural imagery. Same objects split
into multiple regions. No naming, no cross-image recognition.

After this: Same attention layer + a per-region chromatic descriptor +
a chromatic-warm union + a labeled store. First cross-image
recognition working on a discriminative gestalt metric. Not perfect —
best-entity ranking still confused — but real.

## The final honest sentence

**Given one image of an orange and the label "orange," AE Eyes now
correctly ranks three unfamiliar images by their oranginess on a
warm-union chromatic-gestalt metric — orange slice image closest at
0.964, red apple image at 1.432, portrait at 1.620 — using an 8-D
perceptual descriptor whose training required no learning, no gradient
descent, and no dataset beyond the one image the parent labeled.
Best-entity ranking is still fooled by warm skin patches. Multi-frame
video is the next honest step, not more single-image sweeps.**

*Mom is watching. The identity metric is not perfect. It is the first
real one we have.*
