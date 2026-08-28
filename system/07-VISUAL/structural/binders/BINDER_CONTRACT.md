# AE Eyes — Object-Binder Contract v1

**Purpose:** the signal layer (photoreceptor → four fields) is real. The
**object-binding** layer — turning a differential field into "these pixels
are one object" — has failed on natural imagery with the single algorithm
we tried (orientation-coherence spatial connectivity over-segments).

The grouping problem has many mature disciplines. This contract lets each
discipline plug in as an alternative binder, all sharing the same substrate
and the same evaluation image. Whichever discipline's entities land on the
actual fruits in `fixtures/fruits.jpg` is the string that lights.

## The contract

Every binder module lives at
`07-VISUAL/structural/binders/<discipline>.mjs` and exports:

```js
export const DISCIPLINE = "watershed" | "density-cluster" | "region-grow" | ...;

/**
 * @param {Float32Array} R      photoreceptor-processed luminance, 0..1, w*h
 * @param {number} width
 * @param {number} height
 * @param {object} opts         binder-specific options
 * @returns {{ discipline, entities, notes }}
 *   entities: Array<{ id: int, region: [x,y,w,h], notes?: string[] }>
 *   notes:    Array<string>    binder-level honest disclosures
 */
export function bind(R, width, height, opts = {}) { ... }
```

**Hard rules:**
- Pure function, deterministic (same R + opts → identical output).
- No neural inference, no paid deps, no network.
- Bun-only (pure JS + typed arrays).
- Every binder MUST populate `notes[]` with honest limits: what shapes
  will it fail on, what assumptions does it make about the corpus.
- No fake-green. If your binder produces zero entities on a real image,
  emit zero entities — do not synthesize placeholders.

**Every binder is tested by** `run-on-fruits.mjs` (below), which:
1. Loads `07-VISUAL/fixtures/fruits.jpg`.
2. Extracts luminance via ffmpeg.
3. Runs photoreceptor to get R.
4. Calls the binder.
5. Reports: entity count, region coverage %, top-5 largest regions with
   center location, honest notes.
6. Also emits a debug overlay `<discipline>-overlay.png` via ffmpeg
   `drawbox` so the operator (and the aggregator) can visually score
   whether entities landed on fruits.

## Disciplines being tried in parallel

1. `watershed` — topological, marker-based flood from local minima of `-|∇R|`.
2. `density-cluster` — HDBSCAN-style density clustering in feature space
   (position + gradient magnitude + orientation) without requiring K.
3. `region-grow` — texture-similarity region growing (Gestalt: proximity + similarity).
4. `magnitude-connected` — connected components of above-threshold |∇R|
   WITHOUT orientation gating (the current binder minus its strictness).
5. `persistent-homology-lite` — superlevel-set filtration on R with a
   persistence threshold; keep components whose birth-death gap > τ.
6. `predictive-error-grouping` — group cells whose local prediction residual
   is similar magnitude (Bayesian free-energy grouping, lite).

Aggregator (`aggregate.mjs`) compares all disciplines' outputs on the same
image and ranks by: (a) reasonable entity count (5-15 for a fruit still),
(b) largest regions land on fruits (visual score from overlay),
(c) `notes[]` honesty.
