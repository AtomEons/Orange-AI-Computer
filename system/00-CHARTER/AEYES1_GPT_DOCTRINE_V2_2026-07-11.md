# AEyes¹ — GPT Doctrine v2 (Architectural Pivot)
**Date:** 2026-07-11 (later same day)
**Author of state:** GPT (Architect voice, trilane) via Ætom ÆoNs
**Status:** GOVERNING architectural addendum to `AEYES1_GPT_DOCTRINE_2026-07-11.md`
**Response to:** Claude's ledger of PH cache bug + Phase A expanded (spine seq 106)

---

## Interpretation of the finding

`persistent_homology` is preserving distinctions that the current retinal, cortical, and scalar-axis summaries erase. **AWE's best working representation is not IT-like. It is topological structure extracted from the light field.**

**Warning:** the other axes' EMITTED representations fail Phase A. This does NOT prove their PRE-POOLED response maps carry no signal. Local information may exist and be destroyed by the pooling law, not by the physics.

The 78% current recognition is not evidence that wide-IT was almost complete. It is evidence that **a robust topological signal was powerful enough to partially survive a lossy architecture and carry much of the recognition burden alone.** That is scientifically stronger — it names exactly where to rebuild.

---

## Architectural pivot

### DEMOTE
```
axis_bundle → wide-IT → IT-80 → recognition
```

### PROMOTE
```
linear photon field
    ├── persistent topology spine
    ├── spatial-color cell field
    ├── local contour field
    ├── local texture field
    └── other physically grounded lanes
             ↓
      Photon Capture Record
```

`wide-IT` and `IT-80` become OPTIONAL summaries. They are no longer the authoritative eye output.

---

## New working hypothesis

```
Topology       → identity-stable structure
Spatial color  → arrangement + chromatic identity
Localized contour and texture → discriminative detail
Fixation geometry             → binds them into a complete photon print
```

---

## Fix spatial_color first (Wave 1 Step 2)

The 27-cell array silently dropped by `build-wide-it.mjs` flatten filter is a direct implementation defect with experimental evidence behind the repair (Phase A #2 axis).

Do **NOT** flatten into 27 anonymous numbers. Preserve each cell as a structured unit:

```javascript
{
  cellId,
  row,
  column,
  eccentricity,
  luminance,
  redGreen,
  blueYellow,
  saturation,
  confidence
}
```

Test three forms independently to expose where the remaining two collapses occur:
1. raw spatial-color cells
2. flattened spatial-color vector
3. IT-compressed spatial-color contribution

---

## Persistent homology becomes the spine

Keep global 0-D barcode summary for compatibility. Immediately build the more useful form:

```
global persistence
+ per-fixation persistence
+ per-cell persistence
+ cross-scale persistence
```

Global barcode says structures were born and merged across intensity thresholds. Localized barcode says WHERE. Two visually different objects can share similar global topology counts while differing completely in spatial arrangement.

Structure:
```javascript
{
  globalBarcode,
  fixationBarcodes: [
    { fixationId, x, y, scale, h0Persistence, localIntensityRange, localColorState }
  ],
  spatialRelations
}
```

Extensions:
- H0 persistence (connected components) — current
- H1 persistence (holes, rings, enclosed structures) — for cups, wheels, letters, faces
- Cubical persistence over luminance, opponent color, edge-energy fields

---

## Failed axes: pre-pooling audit before retirement

For every axis:
```
source response map
→ local cells
→ pooled scalar
→ wide-IT contribution
→ IT-80 contribution
```

If the response map distinguishes the probe but the scalar fails, the AXIS is not rubble — the POOLING LAW is.

Expected outcomes:
- `edge`: local map useful, global scalar useless
- `texture`: local frequency placement useful, aggregate energy useless
- `fourier_mellin`: may require registration or phase preservation
- `spatial_frequency`: dim 236 scalar was mirage (seq 102), source spectrum may still carry structure
- `hu_moments`: probably too globally compressed
- `photon_histogram`: loses spatial arrangement by design

---

## Promotion rule (new invariant)

> **No global scalar may represent a spatial field unless it passes an explicit information-conservation test.**

---

## New Wave 1 order (replaces prior Wave 1)

1. Lock seq 104 (done — Phase A pilot receipted)
2. Restore all 27 spatial_color cells as structured records
3. Add pre-pooling taps to every axis (source response maps exposed)
4. Emit localized persistent-homology records by cell and fixation
5. Build PhotonCaptureRecord v1:
   - raw evidence reference
   - topology spine
   - spatial-color field
   - unpooled axis maps
   - fixation geometry
   - confidence metadata
6. Rerun the 12-pair Phase A bank
7. Add anti-topology probes designed to collide under global H0
8. Retire only axes whose SOURCE MAPS also fail
9. Bypass IT-80 for capture qualification
10. Begin orange N-saturation only after PhotonCaptureRecord passes

---

## Next adversarial probes (anti-topology bank)

Test what global persistent homology cannot guarantee:
- same component topology, different spatial arrangement
- same silhouette, different interior
- same color distribution, rearranged colors
- same number of regions, different geometry
- same H0 barcode, different H1 structure
- same category, different instance
- nearby categories with similar shape
- partial occlusion

Concrete pairs:
- orange vs orange basketball
- apple vs red ball
- donut vs solid disk
- mug vs bowl
- face vs face-like pattern
- striped animal vs striped fabric
- letters O, C, Q and 0

---

## What supersedes

- `AWE_3_GOVERNING_STATE_2026-07-09.md` §7 finish-line — already superseded by v1 doctrine, now further refined
- `AEYES1_HIDDEN_ALPHA_INVENTORY_2026-07-11.md` Wave 1 order — replaced by new Wave 1 above
- All prior Wave-1 "cheap metric fixes" — deprioritized in favor of the architectural rebuild

## What is preserved

- AWE-3 cortex chain — the STAGES (iris/CAT02/rod/retinal/LGN/V1/V2/V4) STAY; their pooled scalar outputs stop being authoritative. Their pre-pooled response maps become new inputs to PhotonCaptureRecord.
- All prior receipts (spine 1-106) intact
- Mom's Law, backend-only, Bun-only, zero paid deps, receipts-or-nothing
- Two-phase doctrine v1: qualify eye first, then saturate one object

## Governance

- Any deviation routed through Orange5 spine as `action: "awe.doctrine.amend"`
- Ledger for this amendment: pending seq
- Mom's Law: full effort, receipts every step

👁️ 🍊 🐺
