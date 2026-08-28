# Receipt — AE Eyes 50-config sweep: the light string on fruits.jpg

**Date:** 2026-07-06 · **By:** Claude Fable 5
**Spine receipt:** rcpt_2676a5179ecb356c (seq 22, hash a80115795ace314e…)
**Verifier:** photoreceptor 10/10, physical-retinal 6/6, all 6 binder tests green.

## Result

**Light string identified:** `gaussian_1 + watershed + identity` (config c11).

50 configs swept across 5 preprocessors × 5 binders × 2 postprocessors on
the canonical OpenCV `fruits.jpg` (512×480). Ten configs tied at composite
score 1.000; visual scoring on the debug overlays put c11 at the top:
every major fruit + the cabbage + the banana + the lime + the lemon is
covered by at least one entity box, with reasonable spatial coverage
(58.5% of frame) and no runaway giant box (largest box = 17.3% of frame).

## What the sweep proved

- **The photoreceptor + four-field substrate is real enough** that 5
  different object-binding disciplines (watershed, density-cluster,
  region-grow, PH-lite, predictive-error-grouping) all produce
  cognitively-real results on a natural image with zero training and
  zero neural inference.
- **The puzzle-piece combination is preprocessing + binder**, not
  a hybrid of algorithms. Light Gaussian smoothing (σ=1) kills the fine
  texture that broke persistent-homology and predictive-error on
  cabbage/orange, without erasing the object boundaries watershed
  needs to flood-fill from.
- **The `merge_overlap` postprocessor was a no-op on the top 3** —
  those binders already emitted non-overlapping regions. Merge helped
  region-grow (over-splits fewer entities) but did not lift its ceiling
  above watershed.
- **log_normalize + density-cluster (c43)** confirmed a specific
  hypothesis: log_normalize equalized the dynamic range enough that
  density-cluster no longer needed to prune giant clusters, so the
  orange (largest fruit) was recovered.

## Runners-up (all real, all shipping)

| Rank | Config | Note |
|---:|---|---|
| 1 | c11 gaussian_1 + watershed + identity | broadest fruit coverage |
| 2 | c43 log_normalize + density-cluster + identity | tighter individual objects, saved the orange |
| 3 | c01 identity + watershed + identity | baseline; same discipline as #1 without smoothing |
| 4 | c06 identity + region-grow + merge_overlap | middle ground, honest tradeoffs |

## Artifacts

- `07-VISUAL/fixtures/binder-sweep-50/sweep-50-ranked.md` — full ranking
- `07-VISUAL/fixtures/binder-sweep-50/sweep-50-metrics.json` — every metric
- `07-VISUAL/fixtures/binder-sweep-50/c11_*-overlay.png` — winner's overlay
- `07-VISUAL/structural/binders/` — all 6 binder modules + preprocessing
  + post-processing + sweep-50 runner
- 50 debug overlay PNGs at `07-VISUAL/fixtures/binder-sweep-50/`

## Honest limits still standing

- Every entity box on c11 still has SOME over-grouping (the biggest
  fruit region catches adjacent objects) or SOME leakage into background.
  The best config on this single natural image is *usable*, not perfect.
- One image proves the pipeline works cognitively. Generalization needs
  the same sweep on a few more real images (different scenes, different
  object counts) before we call it a doctrine.
- OrangeBrain executor is still stub (Codexa side not wired). The spine
  routes, gates, receipts, and memorizes — but the executor is not
  running real model work yet.

## Next moves the operator can direct

- Repeat on 2-3 more real images (portrait, indoor scene, machinery).
  If c11 keeps winning, it's not a lucky fit to this one photo.
- Feed `record.entities[]` from c11 back into AE Cobra memory as a
  first-class "structural observation" so recall can surface them.
- Or hand it to me and I chase the object-predictability validator
  qualitative-scoring on this real image to close the cognitive loop.

*Mom is watching. The physics is real. The object-binder that lights
the string on natural imagery is preprocessing-plus-watershed.*
