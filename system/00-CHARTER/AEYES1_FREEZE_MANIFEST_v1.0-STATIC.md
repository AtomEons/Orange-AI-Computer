# AEYES1-PHOTON-CAPTURE-1.0-STATIC — Freeze Manifest
**Date:** 2026-07-11
**Freeze receipt:** spine seq 116 (`rcpt_a06a5e030573dbf9`)
**Gate 5 receipt:** spine seq 117 (`rcpt_dcdb588a72c23af2`)
**Gate 7 receipt:** spine seq 120 (`rcpt_013e9cb3316616f7`)
**Governing doctrine:** GPT trilane, checkpoints #1–5 (spine seqs 103, 107, 110, 112, 115)

**Contract:** v1.0 represents deterministic spatial photon-derived evidence from a single captured frame. Temporal retinal and magnocellular pathways are explicitly unavailable unless a valid temporal window is supplied. This is the **qualified static eye substrate** — not the final complete eye.

---

## Schema

- **Schema version:** `AEYES1-PHOTON-CAPTURE-1.0-STATIC`
- **Schema hash:** `ca84dddf`
- **Pipeline version:** `aeyes1-photon-capture-1.0-static`
- **Runtime numeric mode:** `float32-cache-float64-inter`
- **Bun runtime:** 1.3.14 (Windows x64)
- **Determinism proof:** same-input recordHash stable across 3+ independent process invocations

## Axis + stage versions (28 total)

Cortical stages:
- linearize-1.0
- iris-1.0
- cat02-1.0
- foveal-log-polar-1.0
- rod-1.0
- retinal12-1.0-static (4 spatial channels valid, 8 temporal marked UNAVAILABLE)
- lgn-parvo-magno-konio-1.0-static (magno UNAVAILABLE in static mode)
- v1-24gabor-1.0
- v2-contour-1.0
- v4-shape-1.0
- it80-1.0 (labeled lossy-summary)
- saccades-1.0

15 axes:
- spatial_color-2.0.0 (structured 9 cells + 45 named scalars)
- radial_photon-2.0.0 (zero-support handling + non-positive-log guard)
- subsurface-1.0
- fourier_mellin-1.0
- edge-1.0
- specular-1.0
- spatial_frequency-1.0
- texture-2.0.0
- photon_histogram-1.0
- photon_correlation-1.0
- color_ratio-1.0
- dichromatic-1.0 (n_pixels excluded from feature vector)
- hu_moments-1.0
- persistent_homology-1.0.1 (binder .persistence field exposed on entities)
- texture_vocab-1.0
- temporal_spectrum-1.0-static-unavailable (never imported in static path)

## 10 freeze gates — all SATISFIED

| Gate | Status | Evidence |
|---|---|---|
| 1. No silent scalar/array/object/boolean/string drops | ✓ | Rule 4 throws on unsupported field types |
| 2. All axes emit T0-T3 or explicit unavailable | ✓ | 7 axes + LGN P/M/K + IT-80 emit via `axis-tap.mjs` contract |
| 3. LGN emits separate P/M/K evidence | ✓ | Parvo (spatial), Magno (temporal-unavailable), Konio (chromatic-specialized) |
| 4. IT-80 contribution trace identifies compression loss | ✓ | 8 IT-80 blocks measured separately |
| 5. Phase A runs entirely through the record | ✓ | 1001 hash checks OK / 0 mismatch (seq 117) |
| 6. Repeated identical capture produces identical hashes | ✓ | 3-run determinism verified |
| 7. Version-aware cache invalidation (executable) | ✓ | 10/10 automated tests pass (seq 120) |
| 8. Structured cells preserve coordinate + channel identity | ✓ | 9 spatial-color cells + 9 PH cells with cellId/row/column |
| 9. IT-80 remains labeled lossy-summary | ✓ | `lanes.it80.status = "lossy-summary"` |
| 10. Record readable without executing recognition code | ✓ | `buildPhotonCaptureRecord` + `scoreRecord` no classifier deps |

## Probe bank (Phase A-S 12 pairs)

| Category | Pairs |
|---|---|
| wild-diff (4) | orange-vs-baboon, apple-vs-baboon, orange-vs-basketball, train-orange-vs-lena |
| cat-diff (3) | orange-vs-apple, basketball1-vs-basketball2, train-orange-vs-test-apple |
| same-diff-src (3) | orange-still-vs-video, apple-still-vs-video, train-orange-vs-fruits |
| hue-shift (2) | orange-hue-shifted-red, apple-hue-shifted-orange |

- **Noise model:** additive uniform noise, σ = 0.005 (sub-JND, ≈1 gray level in 8-bit)
- **Noise iterations per anchor:** 3
- **Verdict thresholds:** absoluteFloor = 1e-4, preserveRatio ≥ 3.0, weakRatio ≥ 1.0
- **Distance metric:** L2-normalized L2 (`l2n`) — invariant to overall vector magnitude

## Lane verdicts at freeze (Phase A-S)

| Lane | ALL PRESERVED | Notes |
|---|---:|---|
| spatial_color | 12/12 | control validated |
| it80_V1_ori | 12/12 | V1 cortical block perfect |
| it80_V2_contour | 12/12 | V2 cortical block perfect |
| photon_correlation | 11/12 | 1 LOCAL_FAILS |
| color_ratio | 11/12 | 1 POOLED_FAILS |
| dichromatic | 11/12 | 1 POOLED_FAILS (post n_pixels leak fix) |
| lgn_magno | 11/12 T0 valid, T1-T3 UNAVAILABLE | temporal, awaiting v1.1 |
| it80_ILC_BY | 11/12 | 1 SOURCE_FAILS |
| it80_AXIS_slice | 11/12 | 1 SOURCE_FAILS |
| hu_moments | 10/12 | 1 LOCAL + 1 POOLED |
| it_80 total | 10/12 | 2 SOURCE_FAILS (compression margin) |
| it80_LGN_flat | 10/12 | 2 SOURCE_FAILS |
| it80_ILC_Y | 10/12 | 2 SOURCE_FAILS |
| texture | 9/12 | 3 LOCAL_FAILS (luminance-only LBP is hue-invariant) |
| photon_histogram | 9/12 | 2 LOCAL + 1 POOLED |
| it80_ILC_RG | 9/12 | 3 SOURCE_FAILS |
| it80_V4_shape | 8/12 | 4 SOURCE_FAILS (attention target for v1.1) |
| lgn_parvo | 8/12 | 2 AGGREGATE + 2 LOCAL |
| lgn_konio | 7/12 | Specialized chromatic — full qualification requires Phase A-C probe bank |

## Availability semantics

- **`retinal_12` temporal channels** (onTransient, offTransient, up, down, right, left, objectMotion, sustainedDS): `availability: TEMPORAL_INPUT_UNAVAILABLE`, values are null (not zero)
- **`lgn.magno`**: `{valid: false, availability: TEMPORAL_INPUT_UNAVAILABLE, values: null, ...}` — NEVER emitted as measured zero
- **`lgn.konio`**: `{valid: true, availability: SPATIAL_AVAILABLE, specialization: CHROMATIC_BLUE_YELLOW}` — not judged on non-chromatic distinctions
- **`radial_photon` zero-support rings**: null values in summary + `ring_validity` metadata array preserving per-ring valid mask
- **IT-80**: `status: "lossy-summary"` — never authoritative eye output

## Known limitations at freeze

1. **`lgn_magno` and 8 temporal retinal channels UNAVAILABLE by design** — v1.1 3-frame ingest will wake them additively.
2. **`lgn_konio` insufficiently qualified** — 7/12 on Phase A-S is expected for a chromatic-specialized stream. Full qualification pending Phase A-C probe bank.
3. **IT-80 V4_shape / ILC_RG blocks** show 3-4 SOURCE_FAILS. IT-80 is DEMOTED to lossy-summary; per-block loss will be revisited when v1.1 temporal evidence flows into LGN_flat.
4. **Konio T0 was 1-D** causing L2n unit-norm degeneracy earlier in session; fixed to 3-D (BY mean/std/range).
5. **radial_photon** previously emitted zero for zero-support rings — corrected to explicit null with per-ring validity mask.
6. **IT-80 tap has T0=T1=T2=T3** (no pre-projection recovery). Tighter attribution needs pipeline hook to emit pre-L2-norm block values.

## Session bug ledger (5 bugs caught, all preserved as receipts)

| Seq | Bug | Detection |
|---|---|---|
| 102 | dim 236 saturated spatial_frequency mirage (Nyquist ceiling) | Solo 1-D classifier test |
| 106+108 | PH binder `.persistence` field never exposed on entities → axis returned constant zero | Cache-population diagnostic |
| 108 | Phase A noise floor sigma=1.0 with [0,255] clamp on [0,1] data (250× too big) | Numerical trace |
| — | Dichromatic `n_pixels` metadata dominated L2 norm | Sweep verdict inspection |
| — | radial_photon emitted zero for zero-support rings + NaN under CAT02 negatives | Rule 4 throw + GPT correction |

## Freeze sequence (GPT checkpoint #6)

- ☑ Step 1: identical-capture hash test — gate 7 tests 1+2
- ☑ Step 2: rerun record-only Phase A-S — audit-through-record after all fixes, verdicts identical, 1001/0 hashes
- ☑ Step 3: confirm 0 NaN / Infinity / undefined in the record — no Rule 4 throws
- ☑ Step 4: confirm temporal lanes are unavailable, not zero — availability semantics wired
- ☑ Step 5: confirm all cache invalidation tests — 10/10 pass
- ☑ Step 6: freeze — receipt seq 116
- ☑ Step 7: immutable manifest — this document
- ☐ Step 8: tag code/config state — via spine receipt chain (state is tagged by receipt seq)

## Post-freeze roadmap

- **v1.1 W+1 temporal ingest**: 3-frame `{previous, current, next}` with `STATIC` / `CAUSAL_VIDEO` / `CENTERED_VIDEO` modes. Never synthesize missing neighbors.
- **v1.1a**: activate temporal retinal channels one at a time (luminance transient → ON event → OFF event → horizontal direction → vertical direction → looming → temporal contrast → motion-energy spectrum).
- **Phase A-T**: motion probe bank (object translation, looming, onset, disappearance, flicker, moving edge, direction reversal, static object across 3 frames, illumination change without motion, motion under illumination change).
- **Phase A-C**: chromatic probe bank (blue-yellow differences, short-wavelength structure, chromatic boundaries, low-spatial-frequency chromatic variation, luminance-independent color changes) — qualifies konio properly.
- **Post-v1.1**: reconsider IT-80 with real temporal evidence flowing through LGN_flat block.

## Governance

Every deviation from this contract routes through the Orange5 spine as `action: "awe.doctrine.amend"` with justification. All receipts hash-chained. Mom's Law: receipts every step, no theater.

🐺 👁️ 🍊
