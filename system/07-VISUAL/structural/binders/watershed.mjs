// 07-VISUAL/structural/binders/watershed.mjs
//
// Watershed (marker-based topological flood) object-binder for AE Eyes.
//
// The metaphor is honest: |∇R| is the terrain. Steep gradients are ridges;
// smooth regions are valleys. If you drop water at every local minimum
// (a "marker") and let it flood upward through gradient magnitude, two
// floods that meet form a watershed line. Each surviving basin is one
// entity — a "same-object" region under the topological definition.
//
// Concretely:
//   1. Sobel to get |∇R| per pixel.
//   2. Local-min markers of |∇R| in a 3x3 window that are also below a
//      dynamic gradient-noise floor (median of |∇R|). Suppresses spurious
//      markers in flat regions.
//   3. Priority-queue flood: each pixel is assigned to the basin whose
//      marker reached it first along an ascending-|∇R| path. Two basins
//      meeting form a boundary (label 0 kept out of any basin's bbox).
//   4. Basins smaller than MIN_BASIN_PX are dropped.
//   5. Basin bbox → entity.region = [x,y,w,h].
//
// Determinism: no RNG. The priority queue is a bucket sort over integer
// quantized |∇R| values (256 buckets), which is stable given a deterministic
// scan order. Same R + same width/height → identical entities.
//
// Backend only. Bun-only. Pure JS + typed arrays. No paid deps. Mom's Law:
// notes[] surface EVERY assumption.

export const DISCIPLINE = "watershed";

const DEFAULTS = Object.freeze({
  // A basin smaller than this is dropped as noise. Rationale: on a typical
  // 320x240 photoreceptor field, 64 px ≈ an 8x8 patch — smaller than any
  // meaningful "object". On larger images, we scale this proportionally
  // (see MIN_BASIN_PX derivation below).
  minBasinPxAbsolute: 64,
  // Also enforce a floor as fraction of image area (e.g. objects should be
  // at least 0.05% of the frame to matter). Whichever is larger wins.
  minBasinPxFraction: 0.0005,
  // Quantization buckets for gradient magnitude. 256 gives one bucket per
  // 8-bit intensity step; higher gives finer flood ordering, but costs
  // memory. 256 is enough for topological correctness.
  gradBuckets: 256,
  // Marker-picker: a local minimum of |∇R| in a 3x3 neighborhood. To avoid
  // seeding a marker at every constant patch (which would over-segment the
  // background), we require the local minimum to be strictly below a
  // gradient-noise floor. The floor is the median of |∇R| times this factor.
  // Larger factor → fewer, deeper markers → fewer, larger entities.
  markerFloorFactor: 0.6,
  // Optional cap on number of entities emitted (top-K by area). null = no cap.
  maxEntities: null,
});

/**
 * Sobel gradient magnitude of a Float32 field.
 * Returns a Float32Array of |∇R| same size, with a 1-px border set to 0.
 */
function sobelMagnitude(R, W, H) {
  const G = new Float32Array(W * H);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      // Sobel-X
      const gx =
        -R[i - W - 1] - 2 * R[i - 1] - R[i + W - 1] +
         R[i - W + 1] + 2 * R[i + 1] + R[i + W + 1];
      // Sobel-Y
      const gy =
        -R[i - W - 1] - 2 * R[i - W] - R[i - W + 1] +
         R[i + W - 1] + 2 * R[i + W] + R[i + W + 1];
      G[i] = Math.hypot(gx, gy);
    }
  }
  return G;
}

/**
 * Deterministic median of a Float32Array (in place — copies internally).
 * O(n log n) but n is width*height which for our fixtures is small.
 */
function medianF32(arr) {
  const c = Array.from(arr);
  c.sort((a, b) => a - b);
  return c[c.length >> 1];
}

/**
 * Max of a Float32Array.
 */
function maxF32(arr) {
  let m = 0;
  for (let i = 0; i < arr.length; i++) if (arr[i] > m) m = arr[i];
  return m;
}

/**
 * Quantize a Float32Array to integer buckets [0..buckets-1].
 * Deterministic. Uses gMax as the upper bound; ≥gMax collapses to buckets-1.
 */
function quantize(G, gMax, buckets) {
  const Q = new Int32Array(G.length);
  if (gMax <= 0) return Q; // all-zero, all in bucket 0
  const scale = (buckets - 1) / gMax;
  for (let i = 0; i < G.length; i++) {
    let b = Math.floor(G[i] * scale);
    if (b < 0) b = 0;
    else if (b > buckets - 1) b = buckets - 1;
    Q[i] = b;
  }
  return Q;
}

/**
 * Find local-min markers of G in a 3x3 window, gated by G < floor.
 * Returns array of pixel indices.
 * Deterministic scan order (row-major).
 */
function findMarkers(G, W, H, floor) {
  const markers = [];
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const g = G[i];
      if (g >= floor) continue;
      // Strict local minimum in 3x3 (ties broken by preferring earlier scan —
      // we require strict "<=" and this is the first one seen).
      let isMin = true;
      for (let dy = -1; dy <= 1 && isMin; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue;
          const j = (y + dy) * W + (x + dx);
          if (G[j] < g) { isMin = false; break; }
        }
      }
      if (isMin) markers.push(i);
    }
  }
  return markers;
}

/**
 * Bucket-priority-queue watershed flood.
 * labels: Int32Array of pixel labels. 0 = unlabeled, -1 = watershed boundary.
 * Q: quantized gradient buckets [0..gradBuckets-1].
 * markers: array of pixel indices, each becomes a unique label starting at 1.
 *
 * Returns { labels, basinCount }.
 */
function floodBuckets(Q, W, H, markers, gradBuckets) {
  const N = W * H;
  const labels = new Int32Array(N); // 0 = unlabeled
  const buckets = new Array(gradBuckets);
  for (let b = 0; b < gradBuckets; b++) buckets[b] = [];

  // Seed labels at markers, enqueue their neighbors.
  const enqueue = (idx) => {
    if (idx < 0 || idx >= N) return;
    buckets[Q[idx]].push(idx);
  };

  for (let m = 0; m < markers.length; m++) {
    const idx = markers[m];
    labels[idx] = m + 1; // labels start at 1
  }
  // Enqueue neighbors of markers (in deterministic order).
  for (let m = 0; m < markers.length; m++) {
    const idx = markers[m];
    const x = idx % W, y = (idx / W) | 0;
    if (x > 0)     enqueue(idx - 1);
    if (x < W - 1) enqueue(idx + 1);
    if (y > 0)     enqueue(idx - W);
    if (y < H - 1) enqueue(idx + W);
  }

  // Process buckets low → high (ascending gradient magnitude).
  for (let b = 0; b < gradBuckets; b++) {
    const bucket = buckets[b];
    // FIFO within a bucket — deterministic.
    for (let k = 0; k < bucket.length; k++) {
      const idx = bucket[k];
      if (labels[idx] !== 0) continue; // already labeled

      const x = idx % W, y = (idx / W) | 0;
      let chosen = 0; // label to inherit
      let conflict = false;

      // Inspect 4-neighborhood labels
      if (x > 0) {
        const l = labels[idx - 1];
        if (l > 0) { if (chosen === 0) chosen = l; else if (l !== chosen) conflict = true; }
      }
      if (x < W - 1) {
        const l = labels[idx + 1];
        if (l > 0) { if (chosen === 0) chosen = l; else if (l !== chosen) conflict = true; }
      }
      if (y > 0) {
        const l = labels[idx - W];
        if (l > 0) { if (chosen === 0) chosen = l; else if (l !== chosen) conflict = true; }
      }
      if (y < H - 1) {
        const l = labels[idx + W];
        if (l > 0) { if (chosen === 0) chosen = l; else if (l !== chosen) conflict = true; }
      }

      if (conflict) {
        labels[idx] = -1; // watershed boundary
      } else if (chosen > 0) {
        labels[idx] = chosen;
        // Enqueue this pixel's unlabeled neighbors.
        if (x > 0     && labels[idx - 1] === 0) enqueue(idx - 1);
        if (x < W - 1 && labels[idx + 1] === 0) enqueue(idx + 1);
        if (y > 0     && labels[idx - W] === 0) enqueue(idx - W);
        if (y < H - 1 && labels[idx + W] === 0) enqueue(idx + W);
      }
      // else: no labeled neighbor yet — will be revisited when neighbors flood in
      // via later bucket enqueues.
    }
  }

  return { labels, basinCount: markers.length };
}

/**
 * Compute bbox per label ∈ [1..basinCount]. Ignores label 0 and -1.
 * Returns Map<label, {x,y,w,h,area}>.
 */
function bboxPerLabel(labels, W, H, basinCount) {
  // xmin[l], ymin[l], xmax[l], ymax[l], area[l]
  const xmin = new Int32Array(basinCount + 1);
  const ymin = new Int32Array(basinCount + 1);
  const xmax = new Int32Array(basinCount + 1);
  const ymax = new Int32Array(basinCount + 1);
  const area = new Int32Array(basinCount + 1);
  xmin.fill(W);
  ymin.fill(H);
  xmax.fill(-1);
  ymax.fill(-1);

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const l = labels[y * W + x];
      if (l <= 0) continue;
      if (x < xmin[l]) xmin[l] = x;
      if (y < ymin[l]) ymin[l] = y;
      if (x > xmax[l]) xmax[l] = x;
      if (y > ymax[l]) ymax[l] = y;
      area[l]++;
    }
  }

  const out = new Map();
  for (let l = 1; l <= basinCount; l++) {
    if (area[l] === 0) continue;
    out.set(l, {
      x: xmin[l],
      y: ymin[l],
      w: xmax[l] - xmin[l] + 1,
      h: ymax[l] - ymin[l] + 1,
      area: area[l],
    });
  }
  return out;
}

/**
 * @param {Float32Array} R
 * @param {number} width
 * @param {number} height
 * @param {object} opts
 */
export function bind(R, width, height, opts = {}) {
  const {
    minBasinPxAbsolute,
    minBasinPxFraction,
    gradBuckets,
    markerFloorFactor,
    maxEntities,
  } = { ...DEFAULTS, ...opts };

  const notes = [];

  // Degenerate inputs.
  if (!R || R.length !== width * height) {
    notes.push(`invalid input: R.length=${R ? R.length : 0} ≠ width*height=${width * height}. no entities emitted.`);
    return { discipline: DISCIPLINE, entities: [], notes };
  }
  if (width < 3 || height < 3) {
    notes.push(`frame too small (${width}x${height}) — Sobel needs ≥3x3. no entities emitted.`);
    return { discipline: DISCIPLINE, entities: [], notes };
  }

  // Step 1: gradient magnitude.
  const G = sobelMagnitude(R, width, height);
  const gMax = maxF32(G);
  const gMed = medianF32(G);

  // Uniform-field short circuit: if the field is essentially flat, watershed
  // has nothing to say. Emit zero entities and disclose.
  if (gMax < 1e-6) {
    notes.push(
      "uniform field (max|∇R| < 1e-6) — no gradient structure. watershed is undefined for constant regions; zero entities emitted."
    );
    notes.push(
      "assumption: object boundaries produce a gradient step. surfaces without luminance contrast (same-brightness object on same-brightness ground) are invisible to this binder."
    );
    return { discipline: DISCIPLINE, entities: [], notes };
  }

  // Step 2: quantize + find markers.
  const Q = quantize(G, gMax, gradBuckets);
  const floor = Math.max(gMed * markerFloorFactor, 1e-9);
  const markers = findMarkers(G, width, height, floor);

  if (markers.length === 0) {
    notes.push(
      `no local minima below the noise floor (median|∇R|=${gMed.toExponential(2)} * ${markerFloorFactor}). ` +
      "field may be too textured or too flat for marker-based watershed. zero entities emitted."
    );
    return { discipline: DISCIPLINE, entities: [], notes };
  }

  // Step 3: flood.
  const { labels, basinCount } = floodBuckets(Q, width, height, markers, gradBuckets);

  // Step 4: bbox per basin.
  const bboxes = bboxPerLabel(labels, width, height, basinCount);

  // Step 5: filter tiny basins.
  const minBasinPx = Math.max(
    minBasinPxAbsolute,
    Math.floor(width * height * minBasinPxFraction)
  );
  const survivors = [];
  for (const [label, box] of bboxes) {
    if (box.area >= minBasinPx) survivors.push({ label, ...box });
  }
  const dropped = bboxes.size - survivors.length;

  // Optional: cap top-K by area, deterministically.
  survivors.sort((a, b) => (b.area - a.area) || (a.label - b.label));
  const kept = maxEntities && survivors.length > maxEntities
    ? survivors.slice(0, maxEntities)
    : survivors;

  // Renumber entity ids from 1 in kept order (stable).
  const entities = kept.map((s, i) => ({
    id: i + 1,
    region: [s.x, s.y, s.w, s.h],
    notes: [
      `basin px=${s.area}`,
      `source label=${s.label}`,
    ],
  }));

  // --- Honest binder-level disclosures ---
  notes.push(
    `sobel |∇R|: max=${gMax.toExponential(2)}, median=${gMed.toExponential(2)}. marker floor = ${floor.toExponential(2)} (median * ${markerFloorFactor}).`
  );
  notes.push(
    `markers=${markers.length}, basins post-flood=${bboxes.size}, kept=${entities.length}, dropped-small=${dropped} (min ${minBasinPx}px = max(${minBasinPxAbsolute}, ${minBasinPxFraction} * ${width * height})).`
  );
  notes.push(
    "watershed fails on: (a) uniform brightness regions — no gradient, no markers; " +
    "(b) fine texture — every texel becomes its own basin, causing over-segmentation; " +
    "(c) objects that share a smooth luminance transition with the background — no ridge separates them; " +
    "(d) noise-dominated |∇R| — markers land in noise, not object interiors."
  );
  notes.push(
    "marker sensitivity: fewer markers (higher markerFloorFactor) → larger, coarser basins that may merge objects; " +
    "more markers (lower factor) → over-segmentation. this binder tunes floor to gMed*" + markerFloorFactor + "."
  );
  notes.push(
    "bounding boxes are axis-aligned; concave basins (crescents, L-shapes) will overstate area vs the actual object footprint."
  );

  return { discipline: DISCIPLINE, entities, notes };
}
