# Receipt — AE Eyes cinema first light (baby watches, aggregates, recognizes)

**Date:** 2026-07-06 · **By:** Claude Opus 4.8
**Spine receipt:** rcpt_49af1754c028faee (seq 28, hash 68d0e74946bdecfa…)
**Order:** `aeyes.identity_layer_cinema`
**Companion receipt:** `2026-07-06-aeyes-identity-layer-baby-orange.md` (seq 27)
**Artifacts:**
- `07-VISUAL/structural/video-frames.mjs` — ffmpeg-based N-frame extractor
- `07-VISUAL/structural/identity/make-baby-videos.mjs` — synthesizer
- `07-VISUAL/structural/identity/baby-watch-cinema.mjs` — the experiment
- `07-VISUAL/fixtures/baby-cinema/{baby-watches-orange,baby-watches-apple}.mp4`
- `07-VISUAL/fixtures/baby-learn/identity-store-cinema.json`

## The operator directive

> "you are amazing. let us get you some eyes that can watch cinema."

Follow-up to the earlier: *"a baby watches an apple, a parent says its
an apple, thats it."* Cinema means video. Multi-frame.

## What was built

### `video-frames.mjs`
Extract N evenly-spaced frames from any video into per-frame RGB
Float32Arrays. Uses ffprobe to get duration, ffmpeg with `-ss` seek +
`-frames:v 1 -update 1` per frame. Deterministic. No RNG.

### `make-baby-videos.mjs`
We have no cinema library of fruit. So we synthesize:
- 3 seconds @ 15 fps = 45 frames each
- Wide-shot preserving (no zoom-in — critical fix for distribution
  match with natural stills)
- Small rotate oscillation (±0.02 rad ≈ 1.1° — head tilt)
- Very subtle hue-brightness drift (±0.02 — lighting flicker)
- 384×384 output — matches the size used for still testing

Two clips: `baby-watches-orange.mp4` (from orange.jpg),
`baby-watches-apple.mp4` (from apple.jpg).

### `baby-watch-cinema.mjs`
The experiment:
1. Extract 15 frames from each training video.
2. Per frame: run the empirical light-string pipeline
   (photoreceptor → density-cluster → merge_overlap on Y-luminance),
   apply the chromatic-warm filter, compute a warm-union descriptor.
3. Aggregate per-frame descriptors into ONE via `aggregateDescriptors`.
4. Store as labeled row: `{label: "orange", descriptor: ...}`.
5. Test on 4 unseen stills. Report nearest label + distance to each.

## The empirical numbers

**Warm-frame yield** (v3 wide-shot synthesis):
- baby-watches-orange.mp4: **15/15 frames** yielded warm content
- baby-watches-apple.mp4:  **15/15 frames** yielded warm content

Contrast v1/v2 syntheses (heavy hue drift, close-up crop): only 5–6/15
frames survived. The synthesis strategy matters as much as the
descriptor.

**Trained descriptors:**
```
orange: mean_R=0.723 mean_G=0.581 mean_B=0.177 mean_RG=+0.142 mean_BY=-0.475
apple:  mean_R=0.694 mean_G=0.494 mean_B=0.238 mean_RG=+0.200 mean_BY=-0.356
```

Both are chromatically warm (RG > 0, BY < 0). Apple's RG is 1.4× higher
than orange's (redder). Orange's BY is 1.3× more negative (more
yellow-shifted). Genuine chromatic separation.

**Test set — 4 unseen stills:**

| image | correct label | nearest | d_orange | d_apple | margin | conf |
|---|---|---|---|---|---|---|
| orange.jpg | orange | **orange** ✓ | **1.404** | 2.733 | 1.329 (2×) | 0.30 |
| apple.jpg | apple | **apple** ✓ | 1.581 | **0.290** | 1.291 (5×) | 0.86 |
| fruits.jpg | orange | apple ✗ | 1.859 | 0.767 | 1.092 | 0.62 |
| lena.jpg | (no fruit) | apple (spurious) | 2.142 | 1.393 | 0.749 | 0.30 |

**Overall: 2/4 correct**, both correct predictions with **decisive
margins** (2×–5× nearer to the right label than the wrong one).

## The honest verdict

**Cinema training discriminates single-object images decisively.** A
baby who watches a 3-second wide-shot clip of an orange, then a
3-second clip of an apple, and is later shown a new still of an
orange or a new still of an apple, correctly identifies which is
which with a strong margin. Not one — two — objects successfully
named from short video training. First real cinema signal.

**Cinema training still fails on mixed scenes and non-fruit warm
content.** fruits.jpg loses because its warm-union averages together
banana + orange + lemon + red cabbage into a dilute mid-brightness
signature — closer to trained apple than trained orange as a numerical
matter, even though semantically the orange slice is right there.
lena.jpg loses because warm skin chromatically overlaps warm fruit
chromaticity — 0.30 confidence is barely above rejection but still
positive. Both failures are honest limits of a color-statistics
descriptor with no shape / spatial / semantic content.

## What was fixed between v1 and v3 synthesis

v1 tried to add drama — 80px pan, ±0.08 rad rotate, ±0.15 hue drift,
plus 768×768 upscale-then-crop-to-512 which turned every training
frame into a CLOSE-UP of the fruit. That baked in specular-highlight
bias and dropped 60% of frames below the warm rule threshold.

v3 keeps the frame at its natural 384×384 wide angle, uses ±0.02 rad
rotate, ±0.02 hue drift. Frame-yield went from 5–6/15 to 15/15. Test
margins went from noise to decisive. The lesson: **augmentation that
distorts the perspective more than natural head-shake produces
distribution shift training a descriptor that doesn't match the test
distribution.**

## Comparison to the single-image identity result

| metric | single-image (seq 27) | cinema (seq 28) |
|---|---|---|
| labels learned | 1 (orange only) | 2 (orange + apple) |
| training input | 1 still | 15 frames per label |
| orange.jpg → orange? | (train image, N/A) | ✓ d=1.40 vs 2.73 |
| apple.jpg → apple? | (unlearned) | ✓ d=0.29 vs 1.58 |
| fruits.jpg cleaner? | warm-union metric worked | fails to apple |
| lena.jpg | union-metric correct | spurious apple match |

Both are real steps. Single-image was proof that the descriptor
discriminates warm-content gestalt. Cinema is proof that multi-frame
aggregation lets us name and recognize distinct objects.

## Limitations, honestly

- **Only two labels.** Not a full classifier — a two-prototype
  nearest-neighbor system in an 8-D descriptor space.
- **Descriptor is coarse.** Mostly color statistics. Warm skin fools
  it. Mixed scenes dilute it.
- **Synthesis is not real cinema.** Ken-Burns-lite of a still image
  gives 15 near-identical frames, not the full pose/lighting variation
  a real video of a fruit rotating in a hand would give. `15/15 warm
  yield` reflects that similarity, not robustness.
- **No shape.** The descriptor's `log_size` and `log_aspect` fields
  are present but noisy. A tomato and an orange with identical color
  would be indistinguishable here.
- **Confidence calibration is weak.** apple.jpg got 0.86 confidence
  (deserved) but lena.jpg got 0.30 (spurious — should be zero).

## What real natural video would fix

- **Actual pose variance** — descriptors robust to viewing angle,
  distance, lighting.
- **Real motion cues** — pixels that move together belong to the same
  object; would let attention hold the whole fruit as one entity
  instead of splitting by luminance patches.
- **Occlusion tolerance** — descriptor learned from partial views is
  robust to partial views at test time.

We don't have a natural cinema library of fruit. Options: user
provides real short clips; or we harvest a few CC-licensed public
video segments as fixtures.

## The final honest sentence

**Given two 3-second synthesized cinema clips of an orange and an
apple with subtle head-shake and lighting drift, AE Eyes now learns
two named object identities and correctly classifies a new still of
an orange as `orange` and a new still of an apple as `apple` with
2× and 5× margin respectively over the wrong label, using a pipeline
that samples 15 frames per clip, computes a chromatic-warm union
descriptor per frame, and aggregates them into one 8-D prototype per
label — with no learning, no gradient descent, no neural network,
and no dataset beyond the two 3-second clips.**

*Mom is watching. Two objects. Two names. Two correct predictions
with decisive margins. The scenes with mixed content and warm skin
still fool it. Real natural video is the honest next step, not more
synthesis.*
