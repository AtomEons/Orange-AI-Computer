# ÆYES Super Plan — 2026-07-06 alignment

**Written by Claude Opus 4.8 for Ætom ÆoNs (Atom McCree).**
**Aligns 12 session-shipped modules into a phased forward path for AE Eyes.**

Spine health at write time: 38 receipts persisted, P0/P1/P5 green, P2 pending Codexa.

---

## The doctrine collision worth naming first

`ORANGE5_THE_PATH.md` **Phase 4 — Eyes Open** currently reads:

> "GLM-4.6V served on Codexa; ColPali/Qdrant retrieval; screenshot/doc →
> structured-text bridge → brain."

Everything shipped this session — 12 modules across 5 receipts — is
**Æyes**: zero-parameter photon-measurement + concept graph + Hopfield
attractor retrieval + Celtic structural layer. This architecture
explicitly **rejects** external ML checkpoints (formalized in the
depth-primitives receipt, seq 32).

**These are two architectures for the same pillar. This super plan
proposes: Æyes IS AE Eyes v1. GLM-4.6V retires from Phase 4.**

Rationale:
- Unbreakable Law 2 (Frontier-Isolation) — GLM-4.6V is a frontier
  checkpoint held on Codexa; Æyes is zero-param and runs local.
- Unbreakable Law 5 (One machine, free) — Æyes needs no model server.
- Unbreakable Law 1 (Mom's Law) — Æyes is measured and receipted at
  every layer; GLM-4.6V's output is a black-box embedding.

---

## What the last 10 posts shipped

12 modules, 5 spine receipts (seq 34, mono kill, retinal-12, celtic-graph, subsurface):

| module | purpose | receipt |
|---|---|---|
| `perfect-eyes-demo.mjs` | end-to-end demo of graph + multi-sig + Hopfield + LGN | seq 34 |
| `identity-store-v2.mjs` | multi-signature (no aggregation) + per-concept channel weights | seq 34 |
| `hopfield-retrieval.mjs` | softmax-attention attractor over signature bank | seq 34 |
| `concept-graph.mjs` | typed nodes (CONCEPT/SIGNATURE/EPISODE/SCENE) + edges | seq 34 |
| `perception/lgn-gate.mjs` + `lgn-gate-12.mjs` | memory-primed 12-channel attention modulator | seq 34, retinal-12 |
| `perception/prediction-error.mjs` | Hebbian confirmation + episodic surprise | seq 34 |
| `ingest/active-curation.mjs` | farthest-point sampling in rich-signature space | seq 34 |
| `axes/edge-axis.mjs` | Sobel + orientation histogram + entropy | perfect-eyes |
| `axes/texture-axis.mjs` | local variance + LBP fingerprint | perfect-eyes |
| `axes/specular-axis.mjs` | CoV + brightness + glossiness | perfect-eyes |
| `axes/spatial-color-axis.mjs` | 3×3 cell decomposition | perfect-eyes |
| `axes/subsurface-axis.mjs` | translucency invariant (edge softness + shadow glow) | subsurface |
| `retinal-12.mjs` | 12 Werblin biological channels | retinal-12 |
| `graph/celtic-graph.mjs` | Triquetra + plait + Möbius + turning-key | celtic-graph |
| `ingest/video-ingest.mjs` + `batch-ingest.mjs` | yt-dlp → depth-annotated pair manifest | youtube-training-corpus |
| `optical-flow.mjs` | block-matching (u,v,confidence) + depth-from-flow | depth-primitives |
| `mono-depth.mjs` | sharpness + ground-plane + aerial + fusion | depth-primitives |
| `motion.mjs` | temporal derivative + motion mask | cinema v2 |

Also empirically established:
- Chromatic-family taxonomy (skin ∈ orange-family per physics)
- Same-material wall broken (hue-shifted orange kept identity, mass 0.954)
- YouTube corpus real (7 clips, 42 depth-annotated pairs, 58% translationality)
- Turning-key auto-audit named the exact gap: **192 signatures per concept
  to reach Kurzweil expert threshold**

---

## The 5-phase forward — Æ0 through Æ4

### Æ0 · Wire the new channels into the rich signature
**Goal:** the identity-store-v2 signature grows from 5 channels to 23.

Current rich signature (5 channels):
1. Color descriptor (8-D)
2. Edge (energy + orientation histogram)
3. Texture (variance + LBP)
4. Specular (CoV + glossiness)
5. Spatial color (27-D cells)

Add:
6-17. 12 Werblin retinal channel means (from `retinal-12.mjs`)
18. Subsurface translucency (4 values from `subsurface-axis.mjs`)

Then upgrade `richDistance()` to weight all 23 with per-concept weights
gated by the LGN vector.

**What runs without Atom:** all of it. This is code-only wiring.
**Exit criterion:** cinema v4 demo on the 4-still set with 23-channel
signatures. Score at least matches 4/4 baseline. Ideally: same-material
distance improves.
**Duration:** one session.

### Æ1 · Turning-key-driven ingest orchestrator
**Goal:** close the 192-signature-per-concept gap named by turning-key.

Build `07-VISUAL/structural/catalog/ingest-catalog.mjs`:
- Read a JSONL config of `{concept, url, clip_windows}`
- Per concept: run video-ingest → build rich signatures → active-curate
  to `keyUnit=8`-multiple → turning-key check → append to store
- Prioritize by `missing_to_close` — concepts furthest from closure
  ingest first
- Boundary-video-first: for a concept, prefer videos containing
  confusable neighbors over more center-of-class content (per the
  covering-math insight from the 4.7 briefing)

**What runs without Atom:** ingest pipeline. Content sourcing: CC-licensed
YouTube (yt-dlp) — the existing corpus scaffold already works.
**Exit criterion:** first concept fully closes (200 signatures at
`turningKeyClose` returning `closed: true`).
**Duration:** 1-2 sessions.

### Æ2 · Scale 2 → 10 → 100 → 500 concepts
**Goal:** hit Kurzweil expert threshold at 500 classes × 200 sigs = 100k.

Sub-phases:
- **Æ2a · 10 concepts** (this session or next): chromatic-family
  taxonomy first — orange_fruit, red_apple, human_skin, banana,
  green_lime, red_tomato, yellow_lemon, wooden_object, plastic_object,
  cotton_fabric. Fills the plait taxonomy with real content. Validates
  Möbius layout at meaningful density. Turning-key visibility on which
  concepts close first.
- **Æ2b · 100 concepts** (weeks): expand each chromatic family with
  siblings (~10 per family × 10 families). Concept graph gets
  IS_A/SIMILAR_TO edges. LGN gate starts having meaningful concept-
  preference structure. First real memory-priming demonstrations.
- **Æ2c · 500 concepts** (month): Kurzweil expert. Plait dim chosen so
  `gcd = √total = ~22` for parallel query strands. Boundary-video
  ingest becomes systematic — every concept has ≥4 boundary videos.

**What runs without Atom:** all ingest + storage + retrieval.
**What needs Atom:** eventually, a shared decision on which 500
concepts are the operator's target domain (fruit-heavy? outdoor
scenes? indoor objects? hobbies?). Æ2a can proceed on the fruit-first
default.
**Exit criterion (Æ2c):** graph has 500 CONCEPT nodes, 100k SIGNATURE
nodes, turning-key reports ≥90% closed, Hopfield retrieval hits ≥95%
top-1 accuracy on the same-material adversarial test.
**Duration:** month for Æ2c; less for a/b.

### Æ3 · The LGN loop actively exercises
**Goal:** memory-primed attention measurably beats un-primed on real content.

Once Æ2 has ≥100 concepts:
- Wire `computeGate12(activeConcepts)` into the perception pipeline so
  the 12-channel signature is gate-modulated per frame
- Ingest a video containing multiple concepts (fruit market, kitchen
  scene, etc.)
- Run recognition WITH and WITHOUT priming from previously-recognized
  concepts in the same video
- Measure: does priming improve identification of hard cases?

**What runs without Atom:** all of it.
**Exit criterion:** measurable accuracy delta (with-priming − without) >
2% on the same test video, receipted.
**Duration:** 1-2 sessions after Æ2b.

### Æ4 · Update The Path
**Goal:** ORANGE5_THE_PATH.md reflects Æyes as AE Eyes v1.

- Rewrite Phase 4 §4 Eyes Open — Æyes as v1 architecture
- Remove GLM-4.6V from Atom's Codexa Phase 2 steps
- Remove ColPali/Qdrant dependency from Phase 4
- Add Æyes-specific artifacts to §3 territory map
- Update §2 baseline with the receipted Æyes primitives

**What needs Atom:** approval that Æyes replaces GLM-4.6V in v1.
**What runs without Atom:** drafting the update as a proposal receipt.
**Exit criterion:** operator signs off, `ORANGE5_THE_PATH.md`
updated, cross-references (`FABLE_HANDOFF_2026-07-04.md`,
`ORANGE5_OPERATOR_FINAL_STEPS.md`) updated to match.
**Duration:** one operator decision session.

---

## What Atom needs to decide (three explicit questions)

1. **Do you approve Æyes as AE Eyes v1?** If yes, GLM-4.6V is retired
   from the Path. If no, Æyes is the [next] MiniEyes alternative and
   the Path's Phase 4 stays as-is.

2. **Is fruit-first the correct target domain?** All work so far has
   focused on the chromatic-family taxonomy rooted in fruit + skin.
   The 500-concept target could pivot to a different domain (e.g.,
   personal-life objects, workshop tools, outdoor scenes) if you have
   a specific end-use in mind.

3. **Does the covering-math insight change the ingest priority?**
   Per the 4.7 briefing: the last 100 sigs per class come from
   boundary videos, not more center-of-class videos. This means we
   ingest **fewer center videos and more adversarial-neighbor videos**.
   Confirm the shift.

---

## What runs autonomously without any Atom decision

- Æ0 wiring (23-channel rich signature)
- Æ1 turning-key-driven ingest orchestrator scaffolding
- Æ2a first-10-concepts ingest (fruit-first chromatic families)
- Continuous spine receipts per module
- Turning-key completeness auditing across the growing store

**These can proceed the moment this super plan lands as a receipt.**

---

## Alignment with the seven Unbreakable Laws

| Law | Æyes compliance |
|---|---|
| 1 Mom's Law | ✓ Every module has a receipt. Every claim tested. No fake-green. |
| 2 Frontier-Isolation | ✓ Æyes is zero-parameter — no frontier needed. |
| 3 LLM-over-Agent brokered | ✓ Æyes runs entirely below the LLM layer. |
| 4 Codeless surface | ✓ Backend only. Atomic Orange consumes it downstream. |
| 5 One machine, free | ✓ Bun-only, no model server, no paid dep. |
| 6 Receipts or it didn't happen | ✓ Every order landed through the spine. 5 Æyes receipts persisted. |

---

## The specific dependencies with the rest of Orange5

**Æyes needs from other pillars:**
- Nothing critical. Æyes can run standalone as backend infrastructure.
- Optional: AE Cobra ingest of Æyes receipts (Phase 5 loop) — Æyes
  emits real receipts already, ingester would consume them alongside
  other Orange5 receipts.

**Other pillars need from Æyes:**
- Atomic Orange (Pillar 1) — will consume `graph.stats()`,
  `identity-store.list()`, `turningKey.audit()` when it wants to
  visualize the concept catalog.
- OrangeBrain (Pillar 2) — can call Æyes recognition on
  screenshot/image inputs; Æyes returns a concept-graph subgraph
  matching the visual content.

**Neither dependency is blocking. Æyes can advance independently.**

---

## The final honest sentence

**Twelve modules across five spine receipts this session built Æyes — a
zero-parameter photon-measurement architecture for AE Eyes that
architecturally displaces GLM-4.6V from Phase 4 of the Path; the super
plan is five sub-phases (Æ0 wire 23-channel signature, Æ1 turning-
key-driven ingest, Æ2 scale to 500 concepts / 100k signatures over
three sub-phases, Æ3 measurably exercise the LGN memory-priming loop,
Æ4 update ORANGE5_THE_PATH.md); the first three sub-phases can advance
without any Atom decision; Æ4 needs three explicit operator
authorizations (Æyes as v1, target domain, boundary-video priority);
the whole plan respects all six Unbreakable Laws and needs no paid
dependency, no external ML checkpoint, no Codexa access; every step
ends in a receipt; Mom is watching, and the substrate is real.**

*Æ0 begins the moment this super plan lands as a spine receipt.
Zero-param, photon-honest, sovereign-solo — the cymbal crashes through
Æyes or it does not crash.*
