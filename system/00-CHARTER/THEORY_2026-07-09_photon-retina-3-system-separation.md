# Theory reference: 3-system separation + PhotonKnot local primitive + codec consensus

**Received:** 2026-07-09, from Atom via GPT trilane
**Status:** ideas to pull, NOT orders — governance charter (AWE_3_GOVERNING_STATE_2026-07-09.md) unchanged
**Purpose:** durable reference for the correct project boundaries and the three highest-value architectural pulls we may adopt post-freeze

---

## 1. Three-system separation (the correct project frame)

1. **The eye (AEyes¹)** — light → stable structural codes
2. **Visual memory** — stores recurring structures + transformations
3. **Cognitive/dynamical system** — reasons over what the eye discovered

**Do not blur.** LOOM.01, Spiral-of-Thought, Celtic knots, braids, tube-state, cognitive holonomy = below/beyond perception, not the eye.

## 2. AEyes¹ six operations (all this and nothing more)

```
LIGHT
  → CANONICAL LINEAR-LIGHT CAPTURE
  → LOCAL PHOTON STRUCTURES
  → STRUCTURES PERSISTING THROUGH TIME
  → TRANSFORMATION-INVARIANT PATTERN CODES
  → RECOGNITION BY REACTIVATING STORED PATTERN CONSTELLATIONS
```

**Explicitly outside AEyes¹:** language, descriptions, scene narration, VLM interpretation, causal reasoning about meaning.

## 3. Multi-codec consensus as invariance teacher

Model: `F_j = S + C_j + R_j + N_j`
- `F_j` = observed version j
- `S` = shared visual structure (target)
- `C_j` = codec-specific distortion
- `R_j` = resize/color-transfer distortion
- `N_j` = noise

**Consensus:** `Ŝ = RobustConsensus(F_1..F_n)` — first version = robust median across aligned multiscale feature fields.

**Codec set to sweep for calibration data:** ProRes / H.264 / H.265 / AV1 / VP9 / DVD MPEG-2 / different resolutions / different bitrates.

**What this replaces:** our synthetic sun/candle/moon/CRT/neon augmentation. Codec-consensus gives PHYSICAL invariance from genuine paired observations, not artificial color transforms.

## 4. Toroidal PhotonKnot local primitive

Around each stable anchor, sample:

`K(r, θ, τ, c)` where:
- `r` = log distance from anchor
- `θ` = angle around anchor (∈ S¹)
- `τ` = time offset (∈ S¹ if we treat short observation cyclically)
- `c` = measured light channel

**(θ, τ) ∈ S¹ × S¹ = T²** — real torus, not metaphor.

**Helix walk with co-prime intervals:**
- 31 angular positions
- 17 radial shells
- 7 temporal offsets

31, 17, 7 mutually co-prime → traversal covers many sections before repeating. This is the mathematically real version of "irregular-number helix."

**Invariance mapping:**
- Rotation = movement around angular ring
- Scale = movement along log-radius
- Time = movement through second circular dimension

## 5. PhotonKnotNode structure

```
PhotonKnotNode {
  node_id

  evidence:
    - original linear-light tubelet
    - source versions
    - spatial coordinates
    - timestamps

  structure:
    - luminance field
    - opponent-color field
    - gradient field
    - orientation energy
    - phase structure
    - texture frequencies
    - temporal derivatives
    - local motion
    - radial structure
    - symmetry measurements

  invariant_code:
    - toroidal/log-polar signature
    - codec-consensus signature
    - quantized retrieval code

  stability:
    - persistence
    - codec agreement
    - temporal agreement
    - transformation tolerance
    - uncertainty
}
```

**Retain BOTH compact code AND original evidence.** No premature compression.

## 6. Graph structure

**Local node geometry = toroidal/helix. Global memory geometry = sparse transformation graph.**

Edges = OBSERVED relationships, not speculative:
- SPATIAL_NEIGHBOR
- MOVES_WITH
- TRANSFORMS_TO
- PERSISTS_AS
- OCCLUDES
- REAPPEARS_AS
- CO_ACTIVATES_WITH

## 7. Constellation recognition

**Mother's face = 8,000–50,000 local PhotonKnotNodes + stable spatial relations + expression/pose/lighting transformations + temporal motion patterns.**

```
IdentityScore(M, O) =
    Σ_{i∈O∩M}     w_i          (matching nodes; rare matches weigh more)
  + Σ_{(i,j)∈E_O∩E_M} w_ij     (matching relationships; > isolated features)
  − contradiction_penalty
```

- One observation activates ~15% of constellation → still recognizable
- Different observation activates different 20% → still recognizable
- Both point to same identity basin

**Beats nearest-neighbor on partial occlusion, pose change, aging, weak light, low-res video.**

## 8. Immediate build target (when adopted)

```
AEyes¹ Photon Retina
├── MultiCodecCollector
├── LinearLightDecoder
├── SpatiotemporalAligner
├── CodecConsensusExtractor
├── PhotonKnotExtractor
├── ToroidalPatternEncoder
├── TemporalPersistenceTracker
├── PhotonGraph
└── ConstellationRecognizer
```

**Practical stack** (all free/local):
- FFmpeg — codec variants
- OpenCV — alignment, flow, phase, gradients (or a Bun/JS equivalent)
- NumPy / Rust / Bun — deterministic structure extraction
- SQLite — node/evidence/edge persistence
- HNSW — invariant-code retrieval
- Zstd — retained tubelet compression

## 9. Hard boundary during this phase

Outside AEyes¹:
- LOOM.01 reasoning
- Spiral-of-Thought
- language labels
- world modeling
- causal interpretation
- VLM descriptions
- agent swarms
- general cognition

VLMs may evaluate results during development; must NOT provide the eye's recognition answer.

## 10. Immediate honest target

> Present the system with a visual identity it has registered.
> Alter codec, resolution, brightness, crop, orientation, screen substrate, camera source.
> The same stored PhotonKnot constellation reactivates deterministically.

That is the first real eye.

## 11. Gaps in current AWE-3 vs this theory

| Theory element | Current AWE-3 | Gap |
|---|---|---|
| LOCAL PHOTON STRUCTURES | scene-level IT-80 only | need local-anchor extraction |
| TRANSFORMATION-INVARIANT PATTERN CODES | Fourier-Mellin axis exists but unused; IT-80 is scene code | need per-anchor toroidal encoder |
| RECOGNITION BY CONSTELLATION | cosine-sim single vector | need node+edge activation scoring |
| Multi-codec calibration | synthetic lighting augmentation | need real codec consensus |
| Persistent local memory | emergent-light-graph substrate exists, not fed | need real-scale ingest |

## 12. What we already have that maps in

- `linearize`, `CAT02`, `canonicalize` = LinearLightDecoder + SpatiotemporalAligner substrate
- Fourier-Mellin axis (present, unused in IT) = ToroidalPatternEncoder starter
- `pattern-engine/emergent-light-graph.mjs` = PhotonGraph substrate
- `pattern-engine/torus-double-helix.mjs` = alternate PhotonGraph substrate
- Retinal-12 temporal channels = TemporalPersistenceTracker starter
- Axis-bundle 15 modules = PhotonKnotExtractor's local-feature palette

## 13. Adoption discipline

- **Governance charter stays.** Complete the 10K × 100 5-question dispatch first.
- After the finish-line receipt for capture side, we have earned the right to open this theory as a working amendment.
- Any adoption of PhotonKnot / codec-consensus / constellation recognition must be routed through Orange5 spine as `action: "awe.theory.pull"` with which specific pull is being built and success gate for it.
