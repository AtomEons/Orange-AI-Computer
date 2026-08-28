// 07-VISUAL/structural/retinal-12.mjs
//
// The twelve retinal channels — Werblin/Roska stack + LGN gate.
//
// Reference: Roska & Werblin, Nature 2001 (10 stacked IPL strata); extended
// by Farrow & Masland (2011) and Baden et al. 2016 (Nature 529:345-350,
// >30 functional RGC output types via 2-photon calcium imaging over
// 11,000 cells).
// Kurzweil ("How to Create a Mind", 2012) cites the 12 as the sparse feature
// bundle the optic nerve delivers to LGN. The brain hallucinates the visual
// world from these 12 sparse hint channels — it does not process the pixels.
//
// This module implements each channel as a Bun-native function operating on
// Float32Array luminance / optical-flow fields. Persistent channels (1, 2,
// 11, 12) accept and return `prevState` so temporal integration works across
// frames. No parameters are learned. Deterministic.
//
// Output shape per channel: Float32Array of length width*height (may be
// coarser for downsampled retinal spatial resolution — currently full-res).
//
// Channels:
//   1  ON-Sustained             — persistent bright regions
//   2  OFF-Sustained            — persistent dark regions
//   3  ON-Transient             — sudden brightness increases
//   4  OFF-Transient            — sudden brightness decreases
//   5  DS Up
//   6  DS Down
//   7  DS Right (temporal)
//   8  DS Left (nasal)
//   9  Local Edge (W3/LED)      — DoG with surround suppression
//   10 Object Motion            — figure-vs-ground flow contrast
//   11 Uniformity               — inverse variance, temporally smoothed
//   12 Sustained DS             — low-pass ego-motion flow
//
// Pizza mode. Full depth. Zero learned parameters.

import { blockMatchFlow, upsampleField } from "./optical-flow.mjs";

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function fieldMean(F) {
  let s = 0;
  for (let i = 0; i < F.length; i++) s += F[i];
  return s / F.length;
}
function fieldMax(F) {
  let m = -Infinity;
  for (let i = 0; i < F.length; i++) if (F[i] > m) m = F[i];
  return m;
}
function fieldNormalize(F) {
  let m = 0;
  for (let i = 0; i < F.length; i++) if (F[i] > m) m = F[i];
  if (m <= 0) return F;
  const out = new Float32Array(F.length);
  for (let i = 0; i < F.length; i++) out[i] = F[i] / m;
  return out;
}
function fieldRelu(F) {
  const out = new Float32Array(F.length);
  for (let i = 0; i < F.length; i++) out[i] = F[i] > 0 ? F[i] : 0;
  return out;
}
function fieldNegRelu(F) {
  const out = new Float32Array(F.length);
  for (let i = 0; i < F.length; i++) out[i] = F[i] < 0 ? -F[i] : 0;
  return out;
}
function toLuminance(R, G, B) {
  const N = R.length;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  return L;
}
function gaussianBlur(L, w, h, sigma) {
  // Separable Gaussian, 6σ kernel
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  // Horizontal
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const xx = Math.max(0, Math.min(w - 1, x + k));
        acc += L[y * w + xx] * kernel[k + radius];
      }
      tmp[y * w + x] = acc;
    }
  }
  // Vertical
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let k = -radius; k <= radius; k++) {
        const yy = Math.max(0, Math.min(h - 1, y + k));
        acc += tmp[yy * w + x] * kernel[k + radius];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}

// ------------------------------------------------------------------
// Channels 1, 2 — ON/OFF Sustained
// ------------------------------------------------------------------
/**
 * ON-Sustained: fires where luminance exceeds the frame mean AND has been
 * bright across recent frames. Encodes stable illuminated surfaces.
 */
export function onSustained(L, w, h, prevOnSustained = null, tau = 0.7) {
  const mean = fieldMean(L);
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const excess = Math.max(0, L[i] - mean);
    const prev = prevOnSustained ? prevOnSustained[i] : 0;
    out[i] = tau * prev + (1 - tau) * excess;
  }
  return out;
}

/**
 * OFF-Sustained: fires where luminance is below mean AND stable.
 * Encodes persistent shadows, cavities, dark objects.
 */
export function offSustained(L, w, h, prevOffSustained = null, tau = 0.7) {
  const mean = fieldMean(L);
  const out = new Float32Array(L.length);
  for (let i = 0; i < L.length; i++) {
    const deficit = Math.max(0, mean - L[i]);
    const prev = prevOffSustained ? prevOffSustained[i] : 0;
    out[i] = tau * prev + (1 - tau) * deficit;
  }
  return out;
}

// ------------------------------------------------------------------
// Channels 3, 4 — ON/OFF Transient
// ------------------------------------------------------------------
/**
 * Split |ΔL| into signed positive (ON transient) and negative (OFF transient)
 * parts. Encodes flashes and disappearances separately.
 */
export function onOffTransient(L1, L2) {
  const N = L1.length;
  const onT = new Float32Array(N);
  const offT = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const d = L2[i] - L1[i];
    if (d > 0) onT[i] = d;
    else if (d < 0) offT[i] = -d;
  }
  return { onT, offT };
}

// ------------------------------------------------------------------
// Channels 5-8 — Direction Selective
// ------------------------------------------------------------------
/**
 * Project the optical-flow vector field (vx, vy) at each cell into four
 * directional maps. Each channel activates for motion in its preferred
 * direction only.
 *
 * Convention: +x = right (temporal), -x = left (nasal), -y = up (image
 * coordinates go top-down), +y = down.
 */
export function directionSelective(vx, vy) {
  const N = vx.length;
  const up = new Float32Array(N);
  const down = new Float32Array(N);
  const right = new Float32Array(N);
  const left = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    if (vy[i] < 0) up[i] = -vy[i];
    else if (vy[i] > 0) down[i] = vy[i];
    if (vx[i] > 0) right[i] = vx[i];
    else if (vx[i] < 0) left[i] = -vx[i];
  }
  return { up, down, right, left };
}

// ------------------------------------------------------------------
// Channel 9 — Local Edge Detector (surround-suppressed DoG)
// ------------------------------------------------------------------
/**
 * DoG (Difference of Gaussians) as the canonical LED response.
 *
 * The biological W3 cell has strong center-surround antagonism — it fires
 * only when the excitatory stimulus is confined to the receptive-field
 * center. If the stimulus extends into the surround, the surround
 * inhibition cancels the response. This suppresses long uniform edges
 * (like fence bars or continuous horizons) and highlights ISOLATED small
 * high-contrast features (fine texture, isolated corners).
 *
 * Implementation: |center DoG| gated by (1 − normalized_surround_signal).
 */
export function localEdgeDetector(L, w, h, sigmaCenter = 1.0, sigmaSurround = 3.0) {
  const gCenter = gaussianBlur(L, w, h, sigmaCenter);
  const gSurround = gaussianBlur(L, w, h, sigmaSurround);
  const dog = new Float32Array(w * h);
  for (let i = 0; i < dog.length; i++) dog[i] = Math.abs(gCenter[i] - gSurround[i]);
  // Surround-suppression: measure the "extended" signal (broader Gaussian)
  // and reduce edge response where it dominates.
  const surroundMag = gaussianBlur(dog, w, h, sigmaSurround * 2);
  const maxSur = fieldMax(surroundMag) || 1;
  const out = new Float32Array(w * h);
  for (let i = 0; i < dog.length; i++) {
    const suppression = surroundMag[i] / maxSur;   // 0..1
    out[i] = dog[i] * (1 - Math.min(1, suppression));
  }
  return fieldNormalize(out);
}

// ------------------------------------------------------------------
// Channel 10 — Object Motion Detector
// ------------------------------------------------------------------
/**
 * Figure-vs-ground flow contrast. Subtract the frame-median flow (assumed
 * to be ego-motion or background pan) from the local flow. What remains
 * is object-relative motion — the retinal signature of an independently-
 * moving figure.
 *
 * This is what fires when a bird flies across a scrolling landscape.
 */
export function objectMotionDetector(vx, vy) {
  const N = vx.length;
  // Median flow via O(N log N) sort — small block grids so cheap
  const vxSorted = Array.from(vx).sort((a, b) => a - b);
  const vySorted = Array.from(vy).sort((a, b) => a - b);
  const mid = Math.floor(N / 2);
  const medX = vxSorted[mid];
  const medY = vySorted[mid];
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const dx = vx[i] - medX;
    const dy = vy[i] - medY;
    out[i] = Math.hypot(dx, dy);
  }
  return fieldNormalize(out);
}

// ------------------------------------------------------------------
// Channel 11 — Uniformity Detector
// ------------------------------------------------------------------
/**
 * Inverse-variance response, temporally smoothed. Fires HIGH in regions
 * where local pixel statistics are stable ("nothing is happening here").
 * Encodes the background void that lets the brain compress attention onto
 * figure-of-interest regions.
 */
export function uniformityDetector(L, w, h, prevUniformity = null, windowSize = 5, tau = 0.8) {
  const half = windowSize >> 1;
  const N = w * h;
  const varField = new Float32Array(N);
  for (let y = half; y < h - half; y++) {
    for (let x = half; x < w - half; x++) {
      let sum = 0, sum2 = 0, count = 0;
      for (let dy = -half; dy <= half; dy++) {
        for (let dx = -half; dx <= half; dx++) {
          const v = L[(y + dy) * w + (x + dx)];
          sum += v; sum2 += v * v; count++;
        }
      }
      const mean = sum / count;
      const varv = Math.max(0, sum2 / count - mean * mean);
      varField[y * w + x] = varv;
    }
  }
  const maxVar = fieldMax(varField) || 1;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const uniformity = 1 - Math.min(1, varField[i] / maxVar);
    const prev = prevUniformity ? prevUniformity[i] : 0;
    out[i] = tau * prev + (1 - tau) * uniformity;
  }
  return out;
}

// ------------------------------------------------------------------
// Channel 12 — Sustained Direction Selective (ego-motion)
// ------------------------------------------------------------------
/**
 * Low-pass filter of the dominant flow direction. Encodes slow, sustained
 * directional motion — the retinal signature of a translating observer
 * moving through a static scene. Used by the brain for ego-motion
 * compensation.
 */
export function sustainedDS(vx, vy, prevSustained = null, tau = 0.9) {
  const N = vx.length;
  const magnitude = new Float32Array(N);
  for (let i = 0; i < N; i++) magnitude[i] = Math.hypot(vx[i], vy[i]);
  // Dominant direction as vector mean
  let sumX = 0, sumY = 0;
  for (let i = 0; i < N; i++) { sumX += vx[i]; sumY += vy[i]; }
  const dirX = sumX / N, dirY = sumY / N;
  const dirMag = Math.hypot(dirX, dirY) || 1;
  const ux = dirX / dirMag, uy = dirY / dirMag;
  // Per-pixel alignment with dominant direction × magnitude
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const align = Math.max(0, (vx[i] * ux + vy[i] * uy));  // dot product
    const raw = align;
    const prev = prevSustained ? prevSustained[i] : 0;
    out[i] = tau * prev + (1 - tau) * raw;
  }
  return fieldNormalize(out);
}

// ------------------------------------------------------------------
// Orchestrator — all 12 in one call
// ------------------------------------------------------------------
/**
 * @param {{R, G, B, width, height}} f1  previous frame (or null for first frame)
 * @param {{R, G, B, width, height}} f2  current frame
 * @param {object} [prevState] state carried from prior frame:
 *   { onSustained, offSustained, uniformity, sustainedDS }
 * @returns {{
 *   ch1_onSustained, ch2_offSustained,
 *   ch3_onTransient, ch4_offTransient,
 *   ch5_up, ch6_down, ch7_right, ch8_left,
 *   ch9_localEdge, ch10_objectMotion,
 *   ch11_uniformity, ch12_sustainedDS,
 *   width, height, flowGrid,
 *   nextState
 * }}
 */
export function compute12Channels(f1, f2, prevState = {}, opts = {}) {
  const w = f2.width, h = f2.height;
  const L2 = toLuminance(f2.R, f2.G, f2.B);
  const L1 = f1 ? toLuminance(f1.R, f1.G, f1.B) : L2;

  const ch1 = onSustained(L2, w, h, prevState.onSustained);
  const ch2 = offSustained(L2, w, h, prevState.offSustained);
  const { onT: ch3, offT: ch4 } = onOffTransient(L1, L2);

  // #107: accept precomputed optical flow to avoid duplicate work across
  // retinal-12 + motion.mjs + optical-flow.mjs on the same frame pair.
  const flow = opts.precomputedFlow ?? blockMatchFlow(L1, L2, w, h, { blockSize: 16, searchRadius: 8 });
  const vx = upsampleField(flow.vx, flow.cols, flow.rows, w, h, 16);
  const vy = upsampleField(flow.vy, flow.cols, flow.rows, w, h, 16);
  const ds = directionSelective(vx, vy);

  const ch9 = localEdgeDetector(L2, w, h, 1.0, 3.0);
  const ch10 = objectMotionDetector(vx, vy);
  const ch11 = uniformityDetector(L2, w, h, prevState.uniformity);
  const ch12 = sustainedDS(vx, vy, prevState.sustainedDS);

  return {
    ch1_onSustained: ch1, ch2_offSustained: ch2,
    ch3_onTransient: ch3, ch4_offTransient: ch4,
    ch5_up: ds.up, ch6_down: ds.down, ch7_right: ds.right, ch8_left: ds.left,
    ch9_localEdge: ch9, ch10_objectMotion: ch10,
    ch11_uniformity: ch11, ch12_sustainedDS: ch12,
    width: w, height: h,
    flowGrid: { vx: flow.vx, vy: flow.vy, cols: flow.cols, rows: flow.rows },
    nextState: {
      onSustained: ch1, offSustained: ch2,
      uniformity: ch11, sustainedDS: ch12,
    },
  };
}

/**
 * Summary statistics per channel for a region — used to build sparse feature
 * vector for identity-store consumption. Returns mean activation per channel
 * in the region, giving a 12-D descriptor.
 */
export function channels12Summary(channels, region) {
  const [x0, y0, rw, rh] = region;
  const w = channels.width, h = channels.height;
  const x1 = Math.min(w, x0 + rw), y1 = Math.min(h, y0 + rh);
  const xs = Math.max(0, x0), ys = Math.max(0, y0);
  const keys = [
    "ch1_onSustained","ch2_offSustained","ch3_onTransient","ch4_offTransient",
    "ch5_up","ch6_down","ch7_right","ch8_left",
    "ch9_localEdge","ch10_objectMotion","ch11_uniformity","ch12_sustainedDS",
  ];
  const out = {};
  for (const k of keys) {
    const F = channels[k];
    let sum = 0, count = 0;
    for (let y = ys; y < y1; y++) {
      for (let x = xs; x < x1; x++) {
        sum += F[y * w + x];
        count++;
      }
    }
    out[k.replace(/^ch\d+_/, "")] = count ? sum / count : 0;
  }
  return out;
}
