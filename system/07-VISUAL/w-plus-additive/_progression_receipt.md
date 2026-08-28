# W+n Additive Experimenter Receipt — 2026-07-09

## Method (Edison/Tesla)
Hold winner W. Test W+n candidates additively, one at a time. Cache canonical inputs once (360s), then each variant is milliseconds. Never regress. Stack proven winners.

## Baseline
W = 80-D IT vector — 17/19 = 89.5% on 19 real photograph classes × 6 lighting conditions each.
Failures: butterfly × neon → board (margin 0.008), starry_night × neon → home (0.073)

## Round 1 (12 candidates)
Winners (18/19, +1):
- W+1_fm_head — added 4 Fourier-Mellin dims (fm_0..fm_3)
- W+5_downweight_LGN — LGN block × 0.7
- W+6_upweight_axis — axis-bundle block × 2.0

All fix butterfly × neon. All still fail on starry_night × neon.

## Round 2 (stacks of R1 winners)
7 variants tested. All stacks tie at 18/19 — none escape the starry_night ceiling.

## Round 3 (aggressive downweight_LGN + stacks)
Winners (18/19): W+17_dwLGN_0.5 (margin 0.004), W+20_dwLGN_0.4, W+21_dwLGN_0.3, W+22_dwLGN_0.2, W+1+17_..., W+1+22_..., W+1+17+6_all_stack.
Ceiling still 18/19. W+23_dwLGN_0.0 REGRESSED (16/19) — LGN block needed.

## Round 4 (shape-only / drop chromatic)
Winners (18/19): W+1+drop_ILC_RG_BY, W+1+sf_high, W+1+heavy_shape, W+extreme_shape_bias.
W+drop_ILC_RG_BY alone REGRESSED (16/19) — chromatic info needed too.

## Round 5 (grand stacks)
Winners (18/19): W+GRAND_1/3/4, W+FOCUSED_starrynight.
Wrong-answer margins for starry_night grew to 0.086-0.121 — the pipeline is CONFIDENT it's orange.

## Proven ceiling
**18/19 = 94.7%.** The starry_night painting × neon lighting failure is a fundamental limit of the current signature space. Every winner disagrees on whether starry_night → home or → orange, but they all agree starry_night ≠ starry_night under neon.

## Root cause hypothesis
- starry_night: swirls, dominant blue sky, yellow moon
- home: architecture, dominant blue sky, yellow palace
- orange: warm-color fruit
- Under neon (R×1.25, B×1.25, G×0.65, saturation×2.6), the pipeline's chromatic adaptation cannot fully undo the transformation. starry_night's post-adaptation signature falls into the region containing orange (warm) or home (blue-sky + yellow-palace).

## Next architectural moves (not tuning)
1. CAT02 gain clamping in photon-canonical.mjs — prevents amplification of noise under extreme illuminants
2. Multi-fixation TRAINING (not just testing) — saccadic captures grow the family manifold
3. Local chromatic adaptation (per-region CAT02 instead of global)
4. Add training augmentation with color-jitter transforms

## Locked-in W (new baseline for next round)
W = W+1_fm_head (fm_0..fm_3 added to IT block 8, IT dims 80→84). 18/19.
