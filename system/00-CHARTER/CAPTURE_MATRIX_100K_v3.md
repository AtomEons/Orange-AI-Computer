# Alpha Wolf Eyes — 100,000-Capture Matrix v3

Operator directive 2026-07-09: 100,000 canonical captures. Full pie. Right now.

Supersedes the v1 10-object 720-image protocol. This is the real dataset the physics substrate needs.

## Strategy: video acquisition, frame extraction

Shoot **one rich video per object**. Each video contains all the systematic variation baked into its 60–90 seconds — turntable rotation, lighting sweep, background swap. Extract ~1000 frames per video via ffmpeg. 100 objects × ~1000 frames = **100,000 captures**.

This is realistic in **8–10 focused shooting hours across a weekend** — versus 200+ hours of manual still-photography for the same coverage.

## 100 objects, chosen for maximally different physics

**Fruits and organics** (10): apple, orange, banana, lemon, tomato, grape, strawberry, mango, avocado, watermelon slice

**Vegetables and plants** (10): carrot, potato, onion, broccoli, lettuce leaf, green leaf, dried leaf, flower petal, moss, twig

**Woods and paper** (10): light wood block, dark wood block, bark, plywood edge, cardboard, white paper, printed paper, magazine page, corrugated brown, tissue

**Metals** (10): copper penny, silver coin, brass key, aluminum can, steel wrench, chrome bolt, gold ring or plated item, iron nail, brushed steel, black anodized

**Plastics and synthetics** (10): white plastic spoon, colored plastic toy, transparent plastic bottle, black plastic dial, foam block, rubber ball, silicone item, PVC pipe fragment, opaque tape, translucent tape

**Glass and ceramics** (10): drinking glass empty, drinking glass with water, mirror shard, coffee mug, china plate rim, glass marble, ceramic tile, unfired clay, glazed pottery, glass bead

**Textiles** (10): denim swatch, cotton white, cotton black, wool sweater, silk scarf, canvas, leather, felt, corduroy, linen

**Living surfaces** (10): human skin (back of hand — you), hair strand cluster, fingernail, palm, forearm, elbow, other skin under different tan/light, pet fur if available (dog/cat), feather, sponge

**Screens and prints** (10): phone screen off, phone screen white, phone screen showing photo of orange, laptop screen, TV screen, matte photo print, glossy photo print, e-ink screen if available, LED bulb face, neon light

**Liquids and misc** (10): water in glass, oil in glass, milk, orange juice, coffee, ice cube, wax candle, salt crystal pile, sand, mirror at angle

## Per-object shooting recipe (~5 minutes per object)

Fixed camera on tripod. Object on **turntable** (manual or motorized) at ~30 cm.

Recording begins. During the 60–90 second video:

1. **First 15 sec**: object rotates 90° under **warm 2700K LED** (soft warm bulb, off-frame diffused), white background
2. **15–30 sec**: rotate 90° under **cool 6500K LED** (daylight bulb), white background
3. **30–45 sec**: rotate 90° under **direct angled window light** (specular highlight varies with rotation), swap to dark background
4. **45–60 sec**: rotate 90° under **dim ambient** (all lights off except one soft distant lamp), dark background
5. **60–75 sec** (optional): rotate 90° under **fluorescent** (kitchen tube or cool fluorescent bulb)
6. **75–90 sec** (optional): rotate 90° **backlit** (light behind object, dim front) — shows edge translucency

**Filename**: `awe100k_{objectSlug}_{seq}.mp4` (e.g. `awe100k_orange_01.mp4`)

**Save to**: `C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-100k/{objectSlug}/`

## Equipment (all consumer-grade)

- Camera: phone or webcam or DSLR — anything that shoots 30fps at ≥1080p
- Tripod: any
- Turntable: motorized (~$15 Amazon) or manual — a lazy susan works
- Lights (minimum useful set):
  - Warm bulb 2700K (any soft-white LED)
  - Cool bulb 6500K (daylight LED)
  - Window with adjustable blind for angled directional
  - One "dim" state (single distant lamp)
- Backgrounds: one white paper/foamboard, one dark cloth
- Optional: second camera (phone or webcam) — reshoot 20-30 objects on the second camera to give the cross-camera calibration data the pipeline needs

## After the shoot — one command per side

```bash
# extract frames from every captured video into per-object frame stores
bun C:/AtomEons/Orange5/07-VISUAL/structural/ingest/awe100k-video-to-frames.mjs

# run every extracted frame through the canonical pipeline; build the corpus
bun C:/AtomEons/Orange5/07-VISUAL/structural/ingest/awe100k-frames-to-canonical.mjs

# build the k-NN node graph substrate over the 100K canonicals
bun C:/AtomEons/Orange5/07-VISUAL/structural/build-node-graph.mjs \
    C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-100k

# invariance ledger: which pipeline dims survive which nuisance axes?
bun C:/AtomEons/Orange5/07-VISUAL/structural/identity/prove-capture-matrix.mjs \
    C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-100k
```

## Milestone gates for the 100K dataset

- **G1 same-object under different light**: canonical MSE < 0.01. Fails → illuminant estimator needs tightening.
- **G2 same-object under different camera**: canonical MSE < 0.05. Fails → sensor primaries need proper CAT02.
- **G3 same-object under different angle**: canonical MSE reasonable at whatever pose invariance we've built.
- **G4 different-object separation**: mean cross-object MSE > 10× mean within-object MSE.
- **G5 node-graph coherence**: for each canonical, ≥ 80% of its 10 nearest neighbors share the same object label.

Each gate that fails **names a specific pipeline stage** to improve. This is what makes the 100K dataset load-bearing — every failure is diagnostic.

## Why 100K and not more

100K is enough to:
- Give each object 100+ intra-object comparisons under different conditions (statistically robust invariance measurement)
- Give the node graph enough density to test category-level clustering claims
- Cover the physics space widely enough that "our system is invariant to X" statements are grounded

Above 100K, the marginal information per capture drops sharply for the same shoot cost. Below 30K, statistical error dominates.

## What ships from this

At the end of the pipeline, we have:
- 100,000 canonical outputs on disk
- A node graph with ~1M edges
- An invariance ledger stating which dimensions of the canonical are invariant to which nuisances, measured
- A rejection surface — the canonical pipeline can say "unknown" honestly when a new input doesn't fit any node
- The zero-parameter recognition substrate the operator described

That is the substrate.
