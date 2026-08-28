# AWE-3.0 Governing State — 2026-07-09

**Author of state:** GPT (Architect voice, trilane) via Ætom ÆoNs
**Status:** governing charter for AEyes¹ / Alpha Wolf Eyes
**Supersedes:** all prior speculative eye-architecture roadmaps

---

## 1. Corrected project interpretation

```
AEyeGlasses     = formed photonic eye         (SUBSTANTIALLY IMPLEMENTED)
IT-80           = current recognition primitive  (LIVE, 80-D block-normalized vector)
Pattern Engine  = next memory/identity substrate (INPUT CONTRACT DEFINED — DRIVE ONLY AFTER CAPTURE-SIDE FROZEN)
Orange5         = governing runtime + receipt spine  (LIVE, seq 93 as of this charter)
```

Photon capture and cortical encoding are no longer being designed. They exist,
deterministic and receipted, at version `AWE-3.0-visual-cortex`.

---

## 2. What is already established (the eye)

Chain, all live at `Orange5/07-VISUAL/structural/`:
```
RAW photon record
→ linear-light normalization           (linearize)
→ illuminant adaptation                (CAT02 cone-space, clamped [0.4, 3.0])
→ foveated canonicalization            (log-polar 256×256, bicubic, foveal bias 1.6)
→ rod / cone pathways                  (rod scotopic 64×64; cones via opponent)
→ retinal ganglion decomposition       (retinal-12 Werblin/Roska/Baden)
→ LGN streams                          (parvo / magno / konio)
→ V1 orientations & scales             (24 Gabor: 8 orientations × 3 scales)
→ V2 boundaries and contours           (cross-orientation suppression + texture boundary)
→ V4 shape / color conjunctions        (curvature + concavity + complexity + color coupling)
→ IT-80 identity code                  (block-normalized 80-D)
→ active saccadic sampling             (saliency-driven multi-fixation)
```

Every canonical also emits 412 deterministic derived measurements (not
"29× more information" — 29× more physically interpretable coordinates
projecting ~221 encoded bits of representational capacity).

---

## 3. Established strongest results (not just 97.5% number)

- **Deterministic execution** — same input → byte-identical output
- **Zero trained parameters** — pure closed-form math
- **Lighting-normalized recognition** — CAT02 + illuminant estimator
- **Few-shot saturation at N=4-5** on current 47-class × 282-image corpus
- **Compact identity storage** — 320 B / IT vector; 1,600 B / class at N=5
- **Complete raw-input preservation** — `photon_print` field carries input R/G/B unaltered (100% fidelity by construction)
- **Additive, regression-controlled development** — W+n Edison/Tesla protocol, cache-driven, receipts every step

---

## 4. The correct scientific question NOW

**Not** "can this recognize patterns?" — that is answered.

**Rather:**
> Does the current recognition law preserve the same few-shot behavior,
> separation margin, and lighting robustness when class count expands
> by roughly 200×?

The 10,000 × 100 dispatch is the correct experiment. It must answer FIVE
questions, not one:

### 4.1 Statistical Magic N

For every N ∈ {1..100}:
- **A_N** = correct queries at exposure count N / total evaluated queries
- overall top-1 accuracy
- macro class accuracy
- median class accuracy
- worst-decile class accuracy
- bootstrap 95% confidence interval
- number of classes reaching 100%
- number remaining below target

**Magic-N definition (locked BEFORE execution):**
> The smallest N for which the LOWER BOUND of the 95% CI remains above the
> required aggregate accuracy threshold AND neither NEON nor CRT breaches
> its allowed failure ceiling.

Prevents one lucky point from being mistaken for saturation.

### 4.2 NEON / CRT isolation (cross-illuminant matrix)

Do not bury inside average lighting. Produce:

```
                 Query lighting
Reference     Normal  Dim  Neon  CRT  Other
Normal          ·      ·    ·     ·    ·
Dim             ·      ·    ·     ·    ·
Neon            ·      ·    ·     ·    ·
CRT             ·      ·    ·     ·    ·
Other           ·      ·    ·     ·    ·
```

The hard test is CROSS-illuminant identity:
- normal ref → NEON query
- normal ref → CRT query
- NEON ref → normal query
- CRT ref → normal query
- NEON ref → CRT query
- CRT ref → NEON query

That reveals whether CAT02 + opponent pathways actually isolate identity
from extreme spectral transforms.

### 4.3 Collision behavior at 10K scale

Accuracy alone is insufficient. Measure:
- `d_intra` = intra-class distance distribution
- `d_inter` = inter-class distance distribution
- `nearest impostor distance`
- `margin = min(d_inter) − max(d_intra)`
- `class collision count`
- `reciprocal nearest-neighbor collisions`
- `false acceptance rate under unknown-class test` (open-set)

Determines whether IT-80 remains viable as universal primitive or needs
Pattern Engine topology.

### 4.4 Storage truth (full recognition substrate)

The 320 B / vector is raw payload only. Report separately:
```
IT vector payload
class / exposure index
labels / identity keys
distance-search index
lighting metadata
capture provenance
raw-evidence references
Pattern Engine graph overhead
total resident footprint
total disk footprint
```

**5 GB target evaluates against the COMPLETE substrate.**

Immediate deterministic improvement (after rank-preservation receipt):
```
float32 → 320 B / vector
float16 → 160 B / vector
int8    →  80 B / vector
packed  → potentially lower
```

No compression before NN ordering + collision margins are receipted.

### 4.5 Scaling law curve

Not just the 10K endpoint. Report accuracy vs class count at:
`47, 100, 250, 500, 1000, 2500, 5000, 10000` classes.

Reveals whether failure rises:
- linearly
- logarithmically
- via sudden collision phase transition
- only within highly similar visual families

Tells us whether IT-80 scales directly or Pattern Engine must carry more
discrimination burden.

---

## 5. Terminology correction (scientific precision)

**Wrong claim:** "The eye extracts 29× more information."
**Correct claim:** "The eye expands a compact input into ~412 deterministic,
physically interpretable measurements whose combined representational
capacity is approximately 221 encoded bits."

The distinction matters for review: the architecture performs structured
deterministic expansion, not information creation from nothing. The claim
becomes STRONGER, not weaker.

Prior receipts (Orange5 spine seq 89) will not be edited — history stays
intact — but the corrected phrasing is now the canonical claim.

---

## 6. Pattern Engine input contract

Every exposure enters as a structured event:

```typescript
interface PatternObservation {
  identity_candidate:  string | null;    // proposed class label from retrieval (null if novel)
  it80:                Float32Array;     // 80-D IT identity code (the recognition primitive)
  retinal12:           number[12];       // 12-channel Werblin/Roska/Baden summary
  axis15:              object;           // 15 axis-bundle outputs (162 scalars)
  lgn_streams:         { parvo, magno, konio };
  v1_response:         object;           // 24 orientation-scale summaries
  v2_response:         object;           // contour, texture-boundary
  v4_response:         object;           // curvature, concavity, complexity, color-shape
  fixation_sequence:   Array<{x, y, saliency, region}>;   // saccadic path
  illuminant_state:    { chromaticity, confidence, gain };
  rod_cone_balance:    number;           // scotopic vs photopic dominance
  source_domain:       string;           // "photograph" | "video-frame" | "meme" | ...
  timestamp:           number;
  raw_evidence_ref:    string;           // path or hash pointer to preserved photon_print
  recognition_margin:  number;           // top-1 sim minus top-2 sim
  uncertainty:         number;           // 1 - normalized margin
}
```

Pattern Engine does NOT reinvent the cortex. It stores relationships among
valid cortical observations.

**Division of labor:**
```
IT-80:            fast candidate retrieval
Pattern Engine:   persistent identity formation
                  transformation mapping
                  cross-view binding
                  partial-pattern completion
                  collision resolution
                  temporal continuity
                  novelty detection
```

A mother's face → thousands of observations, but Pattern Engine preserves:
- small exemplar nucleus
- transformation paths (rotation, lighting, aging)
- recurring substructures
- rare discriminative knots
- lighting and pose bridges
- confidence-weighted edges
- references to original evidence

Not thousands of redundant full IT vectors in active memory.

---

## 7. Finish-line definition for capture side

CAPTURE + RECOGNITION side is legitimately closed when the million-capture
receipt establishes ALL of:

- [ ] Magic-N statistically stable at 10K classes (95% CI lower bound above threshold)
- [ ] NEON and CRT within explicit failure limits (per cross-illuminant matrix)
- [ ] No unacceptable IT-80 collision phase transition (per collision metrics)
- [ ] Open-set unknowns rejected rather than forced into known classes
- [ ] Complete storage remains inside the 5 GB law
- [ ] Results reproducible across reruns and worker partitioning
- [ ] No regression in existing optometric (5/5) and fidelity (100% / 2888%) suites

After that, **STOP TUNING THE EYE** unless a specific failure class demands it.

---

## 8. Corrected roadmap

```
NOW:
  Run and receipt 10K × 100 with all 5-question outputs

THEN:
  Freeze AWE-3 capture/cortex as the winner (version-lock, receipt in spine)

NEXT:
  Drive Pattern Engine using real million-scale cortical observations
  Ingest via PatternObservation contract (see §6)

TARGET:
  Persistent human-scale visual identity formed from deterministic
  photon-pattern recurrence, transformation, and graph topology
```

---

## 9. Governance

- This document is now the governing state of AEyes¹ / Alpha Wolf Eyes.
- Any deviation must be routed through Orange5 spine as an explicit order
  (`action: "awe.governance.amend"`) with justification.
- Receipts for the 10K × 100 run get their own seq entries.
- The finish-line checklist in §7 is the promotion gate for freezing capture.

🐺 👁️
