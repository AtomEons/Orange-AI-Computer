# ALPHA WOLF EYES — Mission (2026-07-08)

Written by Ætom ÆoNs. Renames and supersedes the working title "AEyes¹" (which stood for a recognizer). This charter sits above the two Fable doctrines (`AEYES1_DOCTRINE_2026-07-08.md`, `AEYES1_PHOTON_INFERENCE_DOCTRINE_2026-07-08.md`) and the Fable-Ideas treatise (`FABLES_IDEAS_PHOTON_PATTERN_CAPTURE_AND_RECALL.md`) as the top-level mission statement. Where any of those describe recognition or classification success metrics, this charter overrides them.

## What Alpha Wolf Eyes IS

Alpha Wolf Eyes is a **photon-pattern capture system**.

Given any image, video, screen, or painting, the system produces a **canonical photon representation** of what the scene actually radiated — the field of light itself, with the camera and the illumination divided OUT.

**Two photos of the same physical scene under different cameras and different lights → IDENTICAL canonical output.**
**Two different scenes → measurably different canonical outputs.**

The success metric is not accuracy. It is:

- **Same-scene MSE → 0** on the canonical output.
- **Different-scene MSE → measurably large** on the canonical output.

## What it is NOT

- Not a classifier.
- Not a recognizer.
- Not a labeler.
- Not measured by top-1 accuracy on any benchmark corpus.

Every % accuracy number produced before this charter (100% memes, 96% NLL, 88% photonic, 20-25% YouTube) evaluated the WRONG signal. Those numbers are retracted as measurements of the Alpha Wolf Eyes mission. They may remain useful as regression canaries for the CLASSIFICATION-derivative task, but the mission is upstream.

## Reference systems

- **A camera** captures a photon pattern through optics + sensor. Lossy but real.
- **A great artist** copying a masterpiece maps the perceived photon pattern back onto canvas. Also lossy, also real.
- **The human eye** captures photon patterns via retinal encoding + neural correction. Nearer to perfect.

Alpha Wolf Eyes = the technical/computational version of what these do imperfectly.

## The physics target

The photon field arriving at a pixel plane is a function P(x, y, λ, t, ω). A camera samples it into P_camera(x, y, RGB, t=exposure, ω=lens). Lossy.

Alpha Wolf Eyes inverts what it can:

```
P_canonical = f_inverse(P_camera, estimated_camera, estimated_illumination)
```

Where f_inverse divides out:
- camera nonlinearity (gamma, tone map, WB, exposure, sensor noise)
- illumination color and intensity
- geometry (pose, scale, viewpoint) → canonical frame

Two views of the same scene → same P_canonical (up to sensor-lost information).

## Downstream ≠ mission

Recognition, matching, comparison become DETERMINISTIC LOOKUPS on canonical outputs. They inherit their correctness from the canonical output's correctness. The mission is the canonical output.

## Ordering

The build order this charter mandates:

1. **Camera-model estimation** — the pipeline knows what the sensor did.
2. **Illumination estimation + division** — the pipeline recovers body reflectance.
3. **Geometry normalization** — the pipeline chooses a canonical frame.
4. **Canonical output shape** — a fixed dimensioned object that same-scene identity can be measured against.
5. **Same-scene identity test** — synthetic pair of same body under wildly different lights → MSE approaches zero.
6. **Different-scene distinguishability test** — different body → measurably large MSE.
7. **Real-world receipt** — measure on actual clip pairs from the corpus.
8. **Downstream utilities** built ON TOP of canonical output.

## Standing rules

- Bun-native, zero learned parameters, no paid deps, no external ML.
- Every claim gets a receipt (Mom's Law).
- No fake-green.
- Do not quit until same-scene photon-identity is achieved.
- Reverse every AE7-driven rollback that removed photon-capture-aligned work.

## Retracted classification results

The following past claims are RETRACTED as measures of the Alpha Wolf Eyes mission and preserved only as historical notes on the classification-derivative task:

- 100% (30/30) on meme corpus, 4 of 5 classifiers, seq 74
- 96% (27/28) on meme corpus, NLL, seq 60
- 94% and 88% YouTube numbers (leaky, seq 62)
- 20-25% honest YouTube cross-clip
- Any Ledoit-Wolf λ / Fisher-ratio / subspace-recall accuracy number

These do not go to zero, but they are no longer the target.

## The bench

The Alpha Wolf Eyes bench is:

```
bun C:/AtomEons/Orange5/07-VISUAL/structural/prove-photon-identity.mjs
```

Reports two numbers:

- `same_scene_mse` — must approach 0
- `different_scene_mse` — must be measurably large

Every new module gets judged by whether it moves `same_scene_mse` toward 0 without collapsing `different_scene_mse`.
