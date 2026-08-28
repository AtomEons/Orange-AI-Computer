// 07-VISUAL/structural/retinal-transform.mjs
//
// M3 — AE Eyes RETINAL TRANSFORM (Path 2 of AE Eyes).
//
// Compiles a light-field input (single image or short frame sequence) into
// an ae.structural-tokens.v1 record via four deterministic signal-processing
// operations. NON-NEURAL. NO TRAINING. NO PAID DEPS.
//
// The four fields:
//   1. Spatial gradient       ∇L            (Sobel, pure JS)
//   2. Temporal derivative    ∂L/∂t         (frame-diff for sequences; null for stills)
//   3. Log intensity          log(L + ε)    (ε = 1/255, deterministic)
//   4. Motion correlation     corr(∇L, t)   (block matching, sequences only)
//
// Contract:  Every emitted record MUST validate against
//   09-SCHEMAS/ae-structural-tokens.v1.schema.json
// and satisfy Mom's Law: every record's `notes[]` MUST disclose what
// this transform could NOT see for this input.
//
// Design notes:
//   - Backend only. Bun/Node compatible ES module. Zero external deps.
//   - Input is a pre-decoded luminance plane (Uint8/Float32) with {width, height}.
//     Encoded input (PNG/JPEG/MP4) must be routed through the ffmpeg helper
//     at 07-VISUAL/structural/luminance-ffmpeg.mjs before calling us. That
//     keeps decode dependencies out of this module's surface area.
//   - Determinism guarantee: same (data, meta) → identical record byte-for-byte.
//     No wall clock read. No RNG. Any `extracted_at_ms` in provenance is passed
//     in by the caller (or defaulted to 0 for tests).

import { createHash } from "node:crypto";

// ---- Constants (all documented, none tuned by hand-fitting) ---------------

export const TRANSLATOR_VERSION = "ae.retinal-transform.v1.0.0-m3";
const LOG_EPS = 1 / 255;                 // log(L+ε) per prompt contract
const TEXTURE_VOCAB_MAX = 64;            // schema-compatible upper bound
const TEXTURE_ORIENTATION_BINS = 8;      // 0..π split into 8 wedges
const MOTION_COHERENCE_THRESHOLD = 0.35; // below → occlusion event
const SCENE_CUT_DELTA_STD = 3.0;         // ∂L/∂t burst detector (std-multiples)
const LIGHTING_SHIFT_DELTA = 0.05;       // mean-luminance shift, 0..1 units
const CAMERA_MOTION_MIN_COHERENCE = 0.55;
const BLOCK_SIZE = 8;                    // block-matching window
const SEARCH_RADIUS = 4;                 // block-matching search radius
const ENTITY_MIN_BLOCKS = 3;             // cluster size gate

// ---- Public API -----------------------------------------------------------

/**
 * Compile a single luminance frame into an ae.structural-tokens.v1 record.
 * @param {{data: Uint8Array|Float32Array, meta: FrameMeta}} args
 * @returns {Promise<StructuralTokensV1>}
 */
export async function transformImage({ data, meta }) {
  assertLuminance(data, meta, "transformImage");
  const width = meta.width | 0;
  const height = meta.height | 0;
  const L = normalize(data); // Float32 in [0,1]

  // Field 1: spatial gradient (Sobel)
  const grad = sobel(L, width, height);
  // Field 3: log(L + ε)
  const logL = logIntensity(L);

  // Texture vocabulary — orientation histograms bucketed into ≤ 64 codes.
  // We compute the full orientation-aware version because it's also what the
  // clustering wants for the still-image path.
  const { vocabulary, cellCodes, cellOrientations, cellMags, cols, rows } =
    textureVocabularyFull(L, width, height);

  // Entities on a still image: cluster spatially connected cells whose
  // gradient orientation AND magnitude are coherent (same texture code +
  // above-noise magnitude). Single-timestep — no motion.
  const entities = clusterStillEntitiesV2({
    cellCodes, cellOrientations, cellMags,
    cols, rows, blockSize: 8, width, height,
  });

  const record = baseRecord({
    path: "retinal",
    sourceKind: meta.source_kind || "unknown",
    sourceId: meta.source_id,
    extractedAtMs: normalizeExtractedAtMs(meta.extracted_at_ms),
    photometric: photometricBlock(meta, width, height),
    temporal: {
      duration_ms: 0,
      frame_count: 1,
      ...(Number.isFinite(meta.sample_rate_hz) ? { sample_rate_hz: meta.sample_rate_hz } : {}),
    },
    retinalFields: {
      gradient_energy_mean: meanMag(grad),
      // No temporal derivative on a still image — MUST be honestly disclosed.
      temporal_derivative_mean: 0,
      log_intensity_range: minMax(logL),
      // No motion correlation on a still image. Schema requires number ∈ [0,1];
      // we emit 0 and disclose in notes[].
      motion_correlation_coherence: 0,
    },
    entities,
    textureVocabulary: vocabulary,
    occlusionEvents: [], // sequence-only signal
    temporalMarkers: [], // sequence-only signal
  });

  record.notes = honestNotesForStill(meta, L, entities);
  record.id = deterministicId(record, "image");
  return record;
}

/**
 * Compile a short luminance sequence into an ae.structural-tokens.v1 record.
 * @param {{frames: Array<{data:Uint8Array|Float32Array, ts_ms:number}>, meta: SequenceMeta}} args
 * @returns {Promise<StructuralTokensV1>}
 */
export async function transformSequence({ frames, meta }) {
  if (!Array.isArray(frames) || frames.length < 1) {
    throw new Error("transformSequence: frames must be a non-empty array");
  }
  if (frames.length === 1) {
    // Degenerate case — route through still path and disclose.
    return transformImage({ data: frames[0].data, meta });
  }
  const width = meta.width | 0;
  const height = meta.height | 0;
  const N = frames.length;

  // Normalize + validate each frame.
  const Ls = new Array(N);
  const tsMs = new Array(N);
  for (let i = 0; i < N; i++) {
    assertLuminance(frames[i].data, meta, `frame ${i}`);
    Ls[i] = normalize(frames[i].data);
    tsMs[i] = Number.isFinite(frames[i].ts_ms) ? Math.trunc(frames[i].ts_ms) : (i * inferFrameMs(meta));
  }
  const durationMs = Math.max(0, tsMs[N - 1] - tsMs[0]);

  // Field 1: spatial gradient on each frame (we retain the last & first for cluster/motion).
  const grads = Ls.map((L) => sobel(L, width, height));

  // Field 2: temporal derivative — frame-diff magnitudes per interior frame.
  const dLdt = new Array(N - 1);
  for (let i = 1; i < N; i++) {
    dLdt[i - 1] = frameDiffMag(Ls[i], Ls[i - 1]);
  }
  const temporalDerivativeMean = mean(dLdt);

  // Field 3: log(L+ε) range across the whole sequence.
  let logMin = Infinity, logMax = -Infinity;
  for (const L of Ls) {
    const [mn, mx] = minMax(logIntensity(L));
    if (mn < logMin) logMin = mn;
    if (mx > logMax) logMax = mx;
  }

  // Field 4: local motion correlation via block matching between consecutive
  // frames. Emits per-block motion vectors + a scalar "coherence" summary.
  const motion = blockMotionSequence(Ls, width, height);

  // Global gradient-energy mean across the sequence.
  const gradMean = mean(grads.map((g) => meanMag(g)));

  // Texture vocabulary derived from the first frame; sequence vocabulary
  // re-uses the same codebook (deterministic per source kind).
  const { vocabulary, cellCodes } = textureVocabularyFull(Ls[0], width, height);

  // Entities: cluster spatiotemporal regions whose gradient signature persists
  // AND whose motion signature is coherent across the sequence.
  const entities = clusterSequenceEntities({
    cellCodes,
    grads,
    motion,
    tsMs,
    width,
    height,
  });

  // Occlusion events: timestamps where motion coherence dropped below threshold.
  const occlusionEvents = motion.perStep
    .map((s, i) => (s.coherence < MOTION_COHERENCE_THRESHOLD
      ? { ts_ms: tsMs[i + 1], kind: "prediction_break", residual_energy: 1 - s.coherence }
      : null))
    .filter(Boolean);

  // Temporal markers: scene cuts, lighting shifts, camera motion.
  const temporalMarkers = deriveTemporalMarkers({
    dLdt, Ls, motion, tsMs,
  });

  const meanCoherence = motion.perStep.length
    ? mean(motion.perStep.map((s) => s.coherence))
    : 0;

  const record = baseRecord({
    path: "retinal",
    sourceKind: meta.source_kind || "unknown",
    sourceId: meta.source_id,
    extractedAtMs: normalizeExtractedAtMs(meta.extracted_at_ms),
    photometric: photometricBlock(meta, width, height),
    temporal: {
      duration_ms: durationMs,
      frame_count: N,
      ...(Number.isFinite(meta.sample_rate_hz)
        ? { sample_rate_hz: meta.sample_rate_hz }
        : (durationMs > 0 ? { sample_rate_hz: (N - 1) * 1000 / durationMs } : {})),
    },
    retinalFields: {
      gradient_energy_mean: gradMean,
      temporal_derivative_mean: temporalDerivativeMean,
      log_intensity_range: [logMin, logMax],
      motion_correlation_coherence: clamp01(meanCoherence),
    },
    entities,
    textureVocabulary: vocabulary,
    occlusionEvents,
    temporalMarkers,
  });

  record.notes = honestNotesForSequence(meta, Ls, dLdt, motion, entities);
  record.id = deterministicId(record, "sequence");
  return record;
}

// ---- Signal-processing kernels (pure JS, deterministic) -------------------

/** Normalize input to Float32 in [0,1]. Non-mutating. */
function normalize(buf) {
  if (buf instanceof Float32Array) {
    // Assume caller respected the [0,1] contract; still clamp for safety.
    const out = new Float32Array(buf.length);
    for (let i = 0; i < buf.length; i++) {
      const v = buf[i];
      out[i] = v < 0 ? 0 : v > 1 ? 1 : v;
    }
    return out;
  }
  const out = new Float32Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = buf[i] / 255;
  return out;
}

/** Sobel 3x3 gradient magnitude field. Returns Float32Array of same size. */
export function sobel(L, w, h) {
  const out = new Float32Array(w * h);
  // Border pixels get gradient 0 (schema-neutral zero-pad).
  for (let y = 1; y < h - 1; y++) {
    const yn = (y - 1) * w;
    const y0 = y * w;
    const yp = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      // Sobel X:   [-1 0 1; -2 0 2; -1 0 1]
      const gx =
        -L[yn + x - 1] + L[yn + x + 1]
        - 2 * L[y0 + x - 1] + 2 * L[y0 + x + 1]
        - L[yp + x - 1] + L[yp + x + 1];
      // Sobel Y:   [-1 -2 -1; 0 0 0; 1 2 1]
      const gy =
        -L[yn + x - 1] - 2 * L[yn + x] - L[yn + x + 1]
        + L[yp + x - 1] + 2 * L[yp + x] + L[yp + x + 1];
      out[y0 + x] = Math.hypot(gx, gy);
    }
  }
  return out;
}

/**
 * Sobel with orientation. Returns { mag: Float32, ori: Float32 }.
 * ori ∈ [0, π) — undirected orientation (0-degree gradient = vertical edge).
 */
function sobelWithOrientation(L, w, h) {
  const mag = new Float32Array(w * h);
  const ori = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    const yn = (y - 1) * w;
    const y0 = y * w;
    const yp = (y + 1) * w;
    for (let x = 1; x < w - 1; x++) {
      const gx =
        -L[yn + x - 1] + L[yn + x + 1]
        - 2 * L[y0 + x - 1] + 2 * L[y0 + x + 1]
        - L[yp + x - 1] + L[yp + x + 1];
      const gy =
        -L[yn + x - 1] - 2 * L[yn + x] - L[yn + x + 1]
        + L[yp + x - 1] + 2 * L[yp + x] + L[yp + x + 1];
      mag[y0 + x] = Math.hypot(gx, gy);
      // atan2 returns (-π, π]; fold to [0, π) for undirected orientation
      let a = Math.atan2(gy, gx);
      if (a < 0) a += Math.PI;
      if (a >= Math.PI) a -= Math.PI;
      ori[y0 + x] = a;
    }
  }
  return { mag, ori };
}

/** Frame-diff magnitude: element-wise |L1 - L0|. */
function frameDiffMag(L1, L0) {
  if (L1.length !== L0.length) {
    throw new Error(`frameDiffMag: length mismatch ${L1.length} vs ${L0.length}`);
  }
  const N = L1.length;
  let sum = 0;
  for (let i = 0; i < N; i++) sum += Math.abs(L1[i] - L0[i]);
  return sum / N;
}

/** log(L + ε) per prompt contract. Returns Float32Array. */
export function logIntensity(L) {
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) out[i] = Math.log(L[i] + LOG_EPS);
  return out;
}

/**
 * Block-matching motion field between consecutive frame pairs.
 * Returns { perStep: [{ blocks: [{bx,by,vx,vy,ssd}...], coherence: number }] }.
 * Coherence = length of the mean normalized-motion vector across all blocks
 * with above-noise motion. Perfectly aligned motion → 1; random → ~0.
 */
function blockMotionSequence(Ls, w, h) {
  const perStep = [];
  const B = BLOCK_SIZE;
  const R = SEARCH_RADIUS;
  const cols = Math.floor(w / B);
  const rows = Math.floor(h / B);
  for (let f = 1; f < Ls.length; f++) {
    const A = Ls[f - 1];
    const Bf = Ls[f];
    const blocks = [];
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        const x0 = bx * B;
        const y0 = by * B;
        const { vx, vy, ssd } = matchBlock(A, Bf, w, h, x0, y0, B, R);
        blocks.push({ bx, by, vx, vy, ssd });
      }
    }
    perStep.push({ blocks, coherence: coherenceFor(blocks) });
  }
  return { perStep, cols, rows, blockSize: B };
}

/** Sum-of-squared-differences block match with integer-pixel search. */
function matchBlock(A, Bf, w, h, x0, y0, B, R) {
  let bestVx = 0, bestVy = 0, bestSSD = Infinity;
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      if (x0 + dx < 0 || y0 + dy < 0 || x0 + dx + B > w || y0 + dy + B > h) continue;
      let ssd = 0;
      for (let yy = 0; yy < B; yy++) {
        const aRow = (y0 + yy) * w + x0;
        const bRow = (y0 + yy + dy) * w + x0 + dx;
        for (let xx = 0; xx < B; xx++) {
          const d = A[aRow + xx] - Bf[bRow + xx];
          ssd += d * d;
        }
      }
      if (ssd < bestSSD) {
        bestSSD = ssd; bestVx = dx; bestVy = dy;
      }
    }
  }
  return { vx: bestVx, vy: bestVy, ssd: bestSSD };
}

/**
 * Length of the mean unit-motion vector over blocks that moved above noise.
 * If most blocks agree on direction, coherence → 1. If motion is random or
 * mostly zero, coherence → 0.
 */
function coherenceFor(blocks) {
  let sumUx = 0, sumUy = 0, n = 0;
  for (const b of blocks) {
    const m = Math.hypot(b.vx, b.vy);
    if (m < 0.5) continue; // sub-pixel noise
    sumUx += b.vx / m;
    sumUy += b.vy / m;
    n++;
  }
  if (n === 0) return 0;
  const meanMag = Math.hypot(sumUx / n, sumUy / n);
  return clamp01(meanMag);
}

// ---- Texture vocabulary ---------------------------------------------------

/**
 * Orientation-aware texture vocabulary. Grid is BLOCK_SIZE × BLOCK_SIZE.
 * Each cell's signature is a base64 8-bin orientation histogram normalized
 * to [0,15] integer weights → deterministic, schema-compatible strings.
 * Returns:
 *   vocabulary        : [{code, signature, frequency}]  (frequency ≥ 1)
 *   cellCodes         : Uint16Array of length cols*rows — each cell's code
 *   cellOrientations  : Float32Array of length cols*rows — dominant orientation per cell (0..π)
 *   cellMags          : Float32Array of length cols*rows — dominant gradient magnitude per cell
 *   cols, rows        : grid dims
 */
export function textureVocabularyFull(L, w, h) {
  const { mag, ori } = sobelWithOrientation(L, w, h);
  const B = BLOCK_SIZE;
  const cols = Math.floor(w / B);
  const rows = Math.floor(h / B);
  const cellCodes = new Uint16Array(cols * rows);
  const cellOrientations = new Float32Array(cols * rows);
  const cellMags = new Float32Array(cols * rows);
  const sigCounts = new Map();

  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const hist = new Array(TEXTURE_ORIENTATION_BINS).fill(0);
      let sumM = 0;
      // orientation-weighted histogram
      let dominantOri = 0, dominantMag = 0;
      for (let yy = 0; yy < B; yy++) {
        const y = by * B + yy;
        for (let xx = 0; xx < B; xx++) {
          const x = bx * B + xx;
          const idx = y * w + x;
          const m = mag[idx];
          if (m <= 0) continue;
          const a = ori[idx];
          const bin = Math.min(TEXTURE_ORIENTATION_BINS - 1,
            Math.max(0, Math.floor((a / Math.PI) * TEXTURE_ORIENTATION_BINS)));
          hist[bin] += m;
          sumM += m;
          if (m > dominantMag) { dominantMag = m; dominantOri = a; }
        }
      }
      // Normalize
      if (sumM > 0) for (let k = 0; k < hist.length; k++) hist[k] /= sumM;
      const sig = base64Signature(hist.map((v) => Math.round(v * 15)));
      let entry = sigCounts.get(sig);
      if (!entry) {
        if (sigCounts.size >= TEXTURE_VOCAB_MAX) {
          entry = { code: TEXTURE_VOCAB_MAX - 1, frequency: 0, signature: sig };
        } else {
          entry = { code: sigCounts.size, frequency: 0, signature: sig };
        }
        sigCounts.set(sig, entry);
      }
      entry.frequency++;
      cellCodes[by * cols + bx] = entry.code;
      cellOrientations[by * cols + bx] = dominantOri;
      cellMags[by * cols + bx] = dominantMag;
    }
  }

  const vocabulary = Array.from(sigCounts.values())
    .sort((a, b) => a.code - b.code)
    .map((v) => ({ code: v.code, signature: v.signature, frequency: v.frequency }));

  return { vocabulary, cellCodes, cellOrientations, cellMags, cols, rows };
}

// ---- Entity clustering ----------------------------------------------------

/**
 * Still-image entities V2: cluster spatially connected cells whose gradient
 * magnitude is above the frame's mean AND whose orientation is coherent with
 * neighbors (within π/4). Emits texture_codes but NO motion_field — single
 * timestep can't observe motion, disclosed in notes[].
 */
function clusterStillEntitiesV2({ cellCodes, cellOrientations, cellMags, cols, rows, blockSize, width, height }) {
  // Threshold: cells with magnitude above the frame-mean qualify for
  // clustering. This gates out noise/flat regions without leaning on
  // vocabulary-code identity.
  let sum = 0;
  for (let i = 0; i < cellMags.length; i++) sum += cellMags[i];
  const meanMagCells = cellMags.length ? sum / cellMags.length : 0;
  const magGate = meanMagCells * 0.5; // 50% of frame-mean = "signal"

  const worthy = new Uint8Array(cols * rows);
  for (let i = 0; i < worthy.length; i++) worthy[i] = cellMags[i] > magGate ? 1 : 0;

  // Connected-component labeling with orientation-coherence edge test.
  const ORI_TOL = Math.PI / 4; // 45 degrees, undirected
  const label = new Int32Array(cols * rows).fill(-1);
  const clusters = [];
  const seedIndices = [];
  for (let i = 0; i < worthy.length; i++) if (worthy[i]) seedIndices.push(i);

  for (const seed of seedIndices) {
    if (label[seed] !== -1) continue;
    const cid = clusters.length;
    const stack = [seed];
    const members = [];
    while (stack.length) {
      const idx = stack.pop();
      if (label[idx] !== -1 || !worthy[idx]) continue;
      label[idx] = cid;
      const bx = idx % cols;
      const by = (idx - bx) / cols;
      members.push([bx, by]);
      const oriHere = cellOrientations[idx];
      const neighbors = [];
      if (bx + 1 < cols) neighbors.push(idx + 1);
      if (bx - 1 >= 0)   neighbors.push(idx - 1);
      if (by + 1 < rows) neighbors.push(idx + cols);
      if (by - 1 >= 0)   neighbors.push(idx - cols);
      for (const nIdx of neighbors) {
        if (label[nIdx] !== -1 || !worthy[nIdx]) continue;
        const dOri = angleDelta(oriHere, cellOrientations[nIdx]);
        if (dOri <= ORI_TOL) stack.push(nIdx);
      }
    }
    if (members.length >= ENTITY_MIN_BLOCKS) {
      clusters.push({ members });
    } else {
      // Undo labels so smaller clusters don't blockade later, larger ones.
      for (const [bxx, byy] of members) label[byy * cols + bxx] = -1;
    }
  }

  return clusters.map((c, i) => {
    // Bounding box in pixel coordinates from member cell (bx, by) pairs.
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const [bx, by] of c.members) {
      if (bx < minX) minX = bx;
      if (by < minY) minY = by;
      if (bx > maxX) maxX = bx;
      if (by > maxY) maxY = by;
    }
    const rx = minX * blockSize;
    const ry = minY * blockSize;
    const rw = Math.min(width - rx, (maxX - minX + 1) * blockSize);
    const rh = Math.min(height - ry, (maxY - minY + 1) * blockSize);
    return {
      id: i,
      first_seen_ms: 0,
      last_seen_ms: 0,
      region: [rx, ry, rw, rh],
      motion_field: [], // still image: motion is UNOBSERVABLE
      texture_codes: uniqueCodesFor(c.members, cellCodes, cols),
      prediction_residual_norm: 0,
    };
  });
}

/** Undirected angular difference (both in [0, π), result in [0, π/2]). */
function angleDelta(a, b) {
  let d = Math.abs(a - b);
  if (d > Math.PI / 2) d = Math.PI - d;
  return d;
}

/**
 * Sequence entities: cluster spatiotemporal regions whose gradient magnitude
 * persists across frames AND whose block-motion signature is coherent.
 * Emits sparse motion_field samples per entity.
 */
function clusterSequenceEntities({ cellCodes, cellRegions, grads, motion, tsMs, width, height }) {
  const B = motion.blockSize;
  const cols = motion.cols;
  const rows = motion.rows;

  // Persistence map: how many frames each cell had above-mean gradient magnitude.
  const persistence = new Uint16Array(cols * rows);
  const meanG = grads.reduce((s, g) => s + meanMag(g), 0) / grads.length;
  for (let f = 0; f < grads.length; f++) {
    const g = grads[f];
    for (let by = 0; by < rows; by++) {
      for (let bx = 0; bx < cols; bx++) {
        let sum = 0;
        for (let yy = 0; yy < B; yy++) {
          const y = by * B + yy;
          for (let xx = 0; xx < B; xx++) {
            const x = bx * B + xx;
            sum += g[y * width + x];
          }
        }
        const mean = sum / (B * B);
        if (mean > meanG) persistence[by * cols + bx]++;
      }
    }
  }

  // A cell is "entity-worthy" if it persisted at least 60% of frames.
  const gate = Math.ceil(grads.length * 0.6);
  const worthy = new Uint8Array(cols * rows);
  for (let i = 0; i < worthy.length; i++) worthy[i] = persistence[i] >= gate ? 1 : 0;

  // Connected-component labeling on `worthy`.
  const label = new Int32Array(cols * rows).fill(-1);
  const clusters = [];
  for (let by = 0; by < rows; by++) {
    for (let bx = 0; bx < cols; bx++) {
      const i0 = by * cols + bx;
      if (!worthy[i0] || label[i0] !== -1) continue;
      const cid = clusters.length;
      const members = [];
      const stack = [i0];
      while (stack.length) {
        const idx = stack.pop();
        if (label[idx] !== -1 || !worthy[idx]) continue;
        label[idx] = cid;
        const bxx = idx % cols;
        const byy = (idx - bxx) / cols;
        members.push([bxx, byy]);
        if (bxx + 1 < cols) stack.push(idx + 1);
        if (bxx - 1 >= 0) stack.push(idx - 1);
        if (byy + 1 < rows) stack.push(idx + cols);
        if (byy - 1 >= 0) stack.push(idx - cols);
      }
      if (members.length >= ENTITY_MIN_BLOCKS) {
        clusters.push({ members });
      } else {
        // Undo labels so smaller clusters don't leave holes.
        for (const [bxx, byy] of members) label[byy * cols + bxx] = -1;
      }
    }
  }

  // For each entity, sample motion vectors from motion.perStep for cells that
  // lie inside the entity's bounding block-set.
  return clusters.map((c, i) => {
    const memberSet = new Set(c.members.map(([x, y]) => `${x},${y}`));
    const motionField = [];
    for (let f = 0; f < motion.perStep.length; f++) {
      const step = motion.perStep[f];
      // Aggregate motion within the entity's members for this step.
      let sx = 0, sy = 0, ssdAcc = 0, n = 0;
      for (const b of step.blocks) {
        if (!memberSet.has(`${b.bx},${b.by}`)) continue;
        sx += b.vx; sy += b.vy; ssdAcc += b.ssd; n++;
      }
      if (n === 0) continue;
      const vx = sx / n;
      const vy = sy / n;
      const dtMs = Math.max(1, tsMs[f + 1] - tsMs[f]);
      const conf = 1 - clamp01(ssdAcc / (n * B * B * 1.0)); // rough
      // Normalize vx, vy to frame-units per second so scale is stable
      motionField.push({
        ts_ms: tsMs[f + 1],
        vx: (vx / width) * (1000 / dtMs),
        vy: (vy / height) * (1000 / dtMs),
        confidence: clamp01(conf),
        region: bboxOfMembers(c.members, B).map((v, k) =>
          k < 2 ? v / (k === 0 ? width : height) : v / (k === 2 ? width : height)
        ),
      });
    }
    return {
      id: i,
      first_seen_ms: tsMs[0],
      last_seen_ms: tsMs[tsMs.length - 1],
      motion_field: motionField,
      texture_codes: uniqueCodesFor(c.members, cellCodes, cols),
      prediction_residual_norm: motionField.length
        ? mean(motionField.map((m) => 1 - m.confidence))
        : 0,
    };
  });
}

// ---- Temporal markers -----------------------------------------------------

function deriveTemporalMarkers({ dLdt, Ls, motion, tsMs }) {
  const markers = [];

  // Scene cuts: ∂L/∂t burst > mean + k·std
  if (dLdt.length > 1) {
    const m = mean(dLdt);
    const s = std(dLdt, m);
    for (let i = 0; i < dLdt.length; i++) {
      if (dLdt[i] > m + SCENE_CUT_DELTA_STD * s) {
        markers.push({
          ts_ms: tsMs[i + 1],
          kind: "scene_cut",
          magnitude: dLdt[i],
          detail: { threshold: m + SCENE_CUT_DELTA_STD * s },
        });
      }
    }
  }

  // Lighting shift: mean(L) delta between consecutive frames > threshold
  const meanLs = Ls.map((L) => {
    let s = 0; for (let i = 0; i < L.length; i++) s += L[i];
    return s / L.length;
  });
  for (let i = 1; i < meanLs.length; i++) {
    const delta = meanLs[i] - meanLs[i - 1];
    if (Math.abs(delta) >= LIGHTING_SHIFT_DELTA) {
      markers.push({
        ts_ms: tsMs[i],
        kind: "lighting_change",
        magnitude: Math.abs(delta),
        detail: { delta_luminance: delta },
      });
    }
  }

  // Camera motion: high global coherence + non-zero mean vector
  for (let i = 0; i < motion.perStep.length; i++) {
    const step = motion.perStep[i];
    if (step.coherence < CAMERA_MOTION_MIN_COHERENCE) continue;
    let sx = 0, sy = 0, n = 0;
    for (const b of step.blocks) {
      if (Math.hypot(b.vx, b.vy) < 0.5) continue;
      sx += b.vx; sy += b.vy; n++;
    }
    if (n === 0) continue;
    const gvx = sx / n, gvy = sy / n;
    markers.push({
      ts_ms: tsMs[i + 1],
      kind: "camera_motion",
      magnitude: Math.hypot(gvx, gvy),
      detail: { global_vx: gvx, global_vy: gvy, coherence: step.coherence },
    });
  }

  return markers;
}

// ---- Base record assembly + honest notes ---------------------------------

function baseRecord({
  path, sourceKind, sourceId, extractedAtMs,
  photometric, temporal, retinalFields, entities,
  textureVocabulary, occlusionEvents, temporalMarkers,
}) {
  const provenance = {
    path,
    source_kind: sourceKind,
    translator_version: TRANSLATOR_VERSION,
    extracted_at_ms: extractedAtMs,
  };
  if (sourceId) provenance.source_id = sourceId;

  const record = {
    schema: "ae.structural-tokens.v1",
    provenance,
    photometric,
    temporal,
    entities: entities || [],
    occlusion_events: occlusionEvents || [],
    texture_vocabulary: textureVocabulary || [],
    temporal_markers: temporalMarkers || [],
    retinal_fields: retinalFields,
    notes: [],
  };
  return record;
}

function photometricBlock(meta, width, height) {
  const cs = meta.color_space;
  const allowed = new Set(["srgb", "rec709", "rec2020", "aces", "linear", "unknown"]);
  return {
    color_space: allowed.has(cs) ? cs : "unknown",
    ...(Number.isFinite(meta.gamma) ? { gamma: meta.gamma } : {}),
    ...(Array.isArray(meta.luminance_range_nits) && meta.luminance_range_nits.length === 2
      ? { luminance_range_nits: meta.luminance_range_nits.slice(0, 2) } : {}),
    ...(meta.hdr_curve && ["sdr","hlg","pq","unknown"].includes(meta.hdr_curve)
      ? { hdr_curve: meta.hdr_curve } : {}),
    resolution: [width, height],
  };
}

function honestNotesForStill(meta, L, entities) {
  const notes = [
    "retinal: single-frame input — ∂L/∂t is unobservable (no temporal derivative).",
    "retinal: single-frame input — motion correlation is unobservable (motion_correlation_coherence set to 0).",
  ];
  if (!meta.color_space) notes.push("retinal: color_space unspecified — spectral response unknown.");
  if (meta.channels && meta.channels !== 1) {
    notes.push("retinal: input collapsed to grayscale (Y channel only) prior to transform.");
  } else if (meta.channels === 1 || meta.grayscale === true) {
    notes.push("retinal: input is grayscale (single luminance plane) — no chrominance information available.");
  }
  if (entities.length === 0) {
    notes.push("retinal: no persistent gradient clusters passed the entity gate — the image may be near-uniform or below the noise floor.");
  }
  return notes;
}

function honestNotesForSequence(meta, Ls, dLdt, motion, entities) {
  const notes = [];
  if (Ls.length < 3) {
    notes.push("retinal: sequence has < 3 frames — temporal derivative statistics have very low degrees of freedom.");
  }
  if (meta.sample_rate_hz && meta.sample_rate_hz < 15) {
    notes.push(`retinal: input frame rate ${meta.sample_rate_hz} Hz is low — ∂L/∂t is aliased for motion faster than half that rate.`);
  }
  if (!meta.color_space) notes.push("retinal: color_space unspecified — spectral response unknown.");
  if (meta.channels === 1 || meta.grayscale === true) {
    notes.push("retinal: input is grayscale (single luminance plane) — no chrominance information available.");
  }
  const meanCoh = motion.perStep.length
    ? motion.perStep.reduce((s, x) => s + x.coherence, 0) / motion.perStep.length
    : 0;
  if (meanCoh < MOTION_COHERENCE_THRESHOLD) {
    notes.push(`retinal: mean motion coherence ${meanCoh.toFixed(2)} below threshold — occlusion/novel-content regions may dominate.`);
  }
  if (entities.length === 0) {
    notes.push("retinal: no persistent spatiotemporal entities detected — either no coherent motion or the sequence is texture-poor.");
  }
  return notes;
}

// ---- Helpers --------------------------------------------------------------

function meanMag(field) {
  let s = 0;
  for (let i = 0; i < field.length; i++) s += field[i];
  return field.length ? s / field.length : 0;
}
function minMax(field) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
  if (!isFinite(mn)) mn = 0;
  if (!isFinite(mx)) mx = 0;
  return [mn, mx];
}
function mean(arr) {
  if (!arr.length) return 0;
  let s = 0; for (const v of arr) s += v; return s / arr.length;
}
function std(arr, m) {
  if (arr.length < 2) return 0;
  let s = 0; for (const v of arr) s += (v - m) * (v - m);
  return Math.sqrt(s / (arr.length - 1));
}
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

function boundingRegion(members) {
  let xMin = Infinity, yMin = Infinity, xMax = -Infinity, yMax = -Infinity;
  for (const [bx, by] of members) {
    if (bx < xMin) xMin = bx; if (bx > xMax) xMax = bx;
    if (by < yMin) yMin = by; if (by > yMax) yMax = by;
  }
  return [xMin, yMin, xMax - xMin + 1, yMax - yMin + 1];
}

function bboxOfMembers(members, B) {
  const [bx0, by0, bw, bh] = boundingRegion(members);
  return [bx0 * B, by0 * B, bw * B, bh * B];
}

function uniqueCodesFor(members, cellCodes, cols) {
  const set = new Set();
  for (const [bx, by] of members) set.add(cellCodes[by * cols + bx]);
  return Array.from(set).sort((a, b) => a - b);
}

function base64Signature(bins) {
  // Compact deterministic signature: pack 8 integer bins (0..255) as bytes.
  const buf = Buffer.alloc(bins.length);
  for (let i = 0; i < bins.length; i++) {
    const v = Math.max(0, Math.min(255, Math.round(bins[i])));
    buf[i] = v;
  }
  return buf.toString("base64");
}

function inferFrameMs(meta) {
  if (Number.isFinite(meta.sample_rate_hz) && meta.sample_rate_hz > 0) {
    return Math.round(1000 / meta.sample_rate_hz);
  }
  return 33; // ~30 fps default
}

function normalizeExtractedAtMs(v) {
  // Contract: deterministic when caller passes a number; 0 by default so
  // record ids are stable in tests.
  if (Number.isFinite(v)) return Math.trunc(v);
  return 0;
}

function assertLuminance(data, meta, ctx) {
  if (!data || (typeof data.length !== "number")) {
    throw new Error(`${ctx}: data must be a typed array (Uint8Array or Float32Array)`);
  }
  const w = meta?.width | 0, h = meta?.height | 0;
  if (!w || !h) throw new Error(`${ctx}: meta.{width,height} required`);
  if (data.length !== w * h) {
    throw new Error(`${ctx}: data.length=${data.length} does not match width*height=${w * h}`);
  }
}

function deterministicId(record, kind) {
  // sha256 over provenance + structural summary. NO id in the input.
  const {id: _drop, ...body} = record;
  const summary = JSON.stringify({
    kind,
    prov: record.provenance,
    photo: record.photometric,
    temp: record.temporal,
    rf: record.retinal_fields,
    // Structural counts only — full arrays would blow up id computation
    entities: (record.entities || []).length,
    occlusion_events: (record.occlusion_events || []).length,
    texture_vocabulary: (record.texture_vocabulary || []).length,
    temporal_markers: (record.temporal_markers || []).length,
    notes: (record.notes || []).length,
  });
  return createHash("sha256").update(summary).digest("hex").slice(0, 32);
}

// ---- Public helpers exposed for testing -----------------------------------

export const __retinalInternals = Object.freeze({
  sobel,
  sobelWithOrientation,
  frameDiffMag,
  logIntensity,
  blockMotionSequence,
  textureVocabularyFull,
  angleDelta,
  LOG_EPS,
  TRANSLATOR_VERSION,
  MOTION_COHERENCE_THRESHOLD,
});
