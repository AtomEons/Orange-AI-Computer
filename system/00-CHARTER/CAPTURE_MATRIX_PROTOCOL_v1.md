# AEyes¹ 10-Object Capture Matrix — Protocol v1

Fable Move 5. The narrow physics-invariance test that must pass before the
Grand Test (100 concepts × 20 samples). ~2-3 hours of focused capture yields
the dataset that lets us MEASURE (not assume) which parts of the pipeline
survive which nuisance transformations. Deliverable: the invariance ledger.

## The 10 objects (chosen for maximally-different physics)

| # | Object | Why (physics stress) |
|---|---|---|
| 1 | **Orange** (whole fruit) | Dielectric, saturated body chromaticity, dimpled peel microtexture, subsurface scatter, roundness → primary sanity object |
| 2 | **Apple** (red or green) | Dielectric, waxy specular, close chromaticity neighbor to orange under some lights (color+shape stress) |
| 3 | **Coin** (US quarter or similar) | Metal, no body reflection, sharp specular, engraved microrelief |
| 4 | **Clear glass** (drinking glass, empty) | Transmissive + specular, refraction, near-total illuminant reflection at rims |
| 5 | **Wood block** (unpainted) | Diffuse dielectric, strong anisotropic grain texture, low specular |
| 6 | **White plastic item** (spoon or dish) | Dielectric, low body chromaticity (near-white), moderate specular |
| 7 | **Metal spoon** or key | Second metal for material-class replication |
| 8 | **Green leaf** (from any plant) | Living material, subsurface scatter through chlorophyll, distinctive absorption bands |
| 9 | **Fabric swatch** (any color, textured — denim/wool) | Diffuse dielectric, high texture spectrum, no specular |
| 10 | **White paper** (printer paper) | Near-Lambertian reference, close-to-neutral body |

## Conditions to sweep (fully crossed where feasible)

For each object, capture under **at least these 6 conditions**:

1. **Bright daylight** (near a window, mid-day, no direct sunbeam)
2. **Warm indoor LED** (typical 2700K bulb, room lights on)
3. **Cool fluorescent** OR cool LED (5000K+, kitchen or office ceiling)
4. **Dim ambient** (single lamp across the room, dusk-level)
5. **Direct light source** (angled — creates one strong specular)
6. **Backlit** (light behind object, showing edge translucency where applicable)

For **each lighting condition**, capture **at least 3 angles**: front, ~45°, side.

**Two backgrounds**: white surface (paper), dark surface (dark fabric or wood).

Two cameras if possible: phone + laptop webcam (or two different phones).

**Total per object**: 6 lights × 3 angles × 2 backgrounds ≈ 36 samples. Two
cameras doubles to ~72. Ten objects = 360-720 images. This is the corpus.

## Capture discipline (each shot must)

- Be in focus (tap-focus on the object).
- Fill at least 25% of the frame with the object (avoid extreme distance).
- Not touch the frame edges (need clean background for illuminant estimation).
- Be taken with **no filters, no HDR, no post-processing.** Raw camera default.
- Have its metadata preserved (EXIF: exposure, ISO, white balance if visible).

## Filename convention

`{object}_{light}_{angle}_{background}_{camera}_{seq}.jpg`

Examples:
- `orange_daylight_45deg_white_phone_01.jpg`
- `wood_warm-led_side_dark_webcam_02.jpg`

Where:
- `object` ∈ {orange, apple, coin, glass, wood, plastic, metal, leaf, fabric, paper}
- `light`  ∈ {daylight, warm-led, cool-fluor, dim, direct, backlit}
- `angle`  ∈ {front, 45deg, side}
- `background` ∈ {white, dark}
- `camera` ∈ {phone, webcam, phone2, ...}
- `seq` = 01, 02, ...

## Directory layout

Save to `C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-matrix/{object}/`.
The ingest script reads this structure directly.

## Ingest + evaluation (what runs after capture)

Once images land, a single command produces the invariance ledger:

```
bun C:/AtomEons/Orange5/07-VISUAL/structural/ingest/capture-matrix-ingest.mjs
bun C:/AtomEons/Orange5/07-VISUAL/structural/identity/prove-capture-matrix.mjs
```

The evaluator holds out one COMPLETE CONDITION at a time (e.g., train on all
lightings except "cool-fluor" for that object; test on cool-fluor). For each
of the ~15 held-out conditions per object, report:

1. Top-1 accuracy (of the 10 objects, was the held-out one correctly ID'd?)
2. Fitted illuminant vs true illuminant (chromatic distance)
3. Per-axis stability: which flatten-dims survived vs collapsed
4. Confidence calibration (residual vs true-positive rate)

## Pass criteria (Milestone 1)

- **Closed-set Top-1 ≥ 70%** on all held-out conditions
- **Unknown-gate ≥ 80%** rejection rate on a 3-object "novel" test set held
  entirely out of training (e.g. banana + spoon-tip + book — objects the
  system never saw)
- **Illuminant estimation error ≤ 15% chromatic distance** on average
- **Invariance ledger** produced and published as a receipt

Milestone 2: same but ≥ 90% Top-1.

## Practical notes

- **Do this in one session per object** where possible — moving objects
  between light setups is fine, but keep the object in frame consistently.
- **Wipe the object between conditions if it's shiny** — fingerprints add
  specular noise.
- **Don't correct for camera color mode** — the system MUST learn to handle
  whatever the sensor delivers.
- **A single afternoon** with these 10 objects and a lamp movable through
  the 6 lighting conditions is sufficient. Prep a rough table:

  ```
  Angle 1 (front) → light 1 → shoot both backgrounds → light 2 → shoot → ...
  ```

## Why this dataset, specifically

The Grand Test (100 × 20) is a MEASUREMENT problem. The 10-object matrix is
a PHYSICS problem — it's designed so that if the system fails, we know
exactly which physical assumption it violated. That is the difference
between "our recognizer scores X on Kaggle" and "our recognizer is invariant
to illuminant color within ±Y" — the second statement is worth building.

## When to run

After Fable Move 2 (dichromatic axis, complete) and either Move 3 (self-
calibration) or Move 4 (invariant coordinates), whichever lands first. The
capture is time-locked to Ætom; the code side is ready either way.
