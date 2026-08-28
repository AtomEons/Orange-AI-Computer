// Alpha Wolf Eyes — Canonical Photon-Capture Pipeline v1 (AWE-1.0)
// C:/AtomEons/Orange5/07-VISUAL/structural/photon-canonical.mjs
//
// Zero-parameter, closed-form, Bun-native.
// Takes any frame + region and produces a canonical photon representation:
// the field of light the scene actually radiated, with camera + illumination
// divided out. Two views of one physical scene → identical canonical output.
//
// This is an ADDITION. It does not modify any existing module.
// It composes existing dichromatic + self-calibration + fourier-mellin
// modules where useful, but stays runnable even if those imports are absent
// (each is wrapped in a try/catch soft-import).

// ---------- soft imports of existing modules ----------
let dichromatic = null;
let selfCalibration = null;
let fourierMellin = null;
try { dichromatic = await import('./axes/dichromatic-axis.mjs'); } catch {}
try { selfCalibration = await import('./self-calibration.mjs'); } catch {}
try { fourierMellin = await import('./axes/fourier-mellin-axis.mjs'); } catch {}

// AWE-2.1 FULL WIRE-BACK: every axis + retinal-12 rejoins the capture path.
// Direct imports (not soft) — the pipeline now demands all of them.
import { bundleAllAxes, bundleReport } from './axis-bundle.mjs';
import { compute12Channels, channels12Summary } from './retinal-12.mjs';
// AWE-3.0 VISUAL CORTEX: iris → rod → LGN 3-stream → V1 → V2 → V4 → IT.
import { irisAdapt } from './eye/iris.mjs';
import { rodField } from './eye/rod-pathway.mjs';
import { routeLGN } from './eye/lgn-streams.mjs';
import { v1Response, v1Signature } from './eye/v1-orientation.mjs';
import { v2Contours } from './eye/v2-contours.mjs';
import { v4Shape } from './eye/v4-shape.mjs';
import { itIdentity } from './eye/it-identity.mjs';

// ---------- constants ----------
// AWE-2.0: bumped from 128 → 256. 4× more capture cells. Camera-grade resolution.
// The eye needs enough radial + angular samples to preserve fine detail.
// Perfect photon capture requires enough real estate on the canonical grid.
export const CANON_W = 256;
export const CANON_H = 256;
const EPS = 1e-6;
const VERSION = 'AWE-3.0-visual-cortex';    // iris → rod → LGN(P/M/K) → V1(24-ori) → V2 → V4 → IT + 15 axes + retinal-12 + CAT02
const ROT_TRIES = 12;                       // rotational alignment search (30° stops)
const SCALE_TRIES = 5;                      // log-radius alignment ±2 bins

// Bicubic Catmull-Rom weight — sharp, no overshoot, C1 continuous.
// Used everywhere we resample sub-pixel: canonicalize + preserved luminance.
function cubicWeight(t) {
  const at = Math.abs(t);
  if (at < 1) return 1.5 * at * at * at - 2.5 * at * at + 1;
  if (at < 2) return -0.5 * at * at * at + 2.5 * at * at - 4 * at + 2;
  return 0;
}

// Sample a source Float32Array at floating-point (sx, sy) using Catmull-Rom
// bicubic interpolation over a 4x4 support. Bounds-clamped. sw=stride width.
function sampleBicubic(src, sw, sh, sx, sy) {
  const x1 = Math.floor(sx), y1 = Math.floor(sy);
  const fx = sx - x1, fy = sy - y1;
  let acc = 0, wsum = 0;
  for (let j = -1; j <= 2; j++) {
    const yy = Math.max(0, Math.min(sh - 1, y1 + j));
    const wy = cubicWeight(j - fy);
    for (let i = -1; i <= 2; i++) {
      const xx = Math.max(0, Math.min(sw - 1, x1 + i));
      const wx = cubicWeight(i - fx);
      const w = wx * wy;
      acc += src[yy * sw + xx] * w;
      wsum += w;
    }
  }
  return wsum !== 0 ? acc / wsum : 0;
}

// ---------- utility: extract region as linear-light float channels ----------
function extractRegion(frame, region) {
  const W = frame.W ?? frame.width;
  const H = frame.H ?? frame.height;
  const R = frame.R ?? frame.r;
  const G = frame.G ?? frame.g;
  const B = frame.B ?? frame.b;
  const x0 = Math.max(0, region?.x ?? 0);
  const y0 = Math.max(0, region?.y ?? 0);
  const rw = Math.min(W - x0, region?.w ?? W);
  const rh = Math.min(H - y0, region?.h ?? H);
  const out = {
    r: new Float32Array(rw * rh),
    g: new Float32Array(rw * rh),
    b: new Float32Array(rw * rh),
    w: rw, h: rh,
  };
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      const src = ((y + y0) * W + (x + x0));
      const dst = y * rw + x;
      out.r[dst] = (R[src] ?? 0) / 255;
      out.g[dst] = (G[src] ?? 0) / 255;
      out.b[dst] = (B[src] ?? 0) / 255;
    }
  }
  return out;
}

// ---------- Step 2: camera model (closed-form) ----------
function estimateCameraModel(region) {
  const n = region.w * region.h;
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    L[i] = 0.2126 * region.r[i] + 0.7152 * region.g[i] + 0.0722 * region.b[i];
  }
  const sorted = Float32Array.from(L).sort();
  const p50 = sorted[Math.floor(0.50 * n)];
  const p95 = sorted[Math.floor(0.95 * n)];
  // gamma proxy: default sRGB 2.2 unless entropy indicates otherwise
  let gamma = 2.2;
  if (p95 > EPS && p50 > EPS) {
    const ratio = Math.log(p50 + EPS) / Math.log(p95 + EPS);
    if (isFinite(ratio) && ratio > 0.1 && ratio < 10) {
      gamma = Math.max(1.0, Math.min(3.0, ratio * 2.2));
    }
  }
  // exposure: median of top 1%
  const top1 = sorted[Math.floor(0.99 * n)];
  const exposure = Math.max(EPS, top1);
  // 3-vote WB
  let sumR = 0, sumG = 0, sumB = 0;
  for (let i = 0; i < n; i++) { sumR += region.r[i]; sumG += region.g[i]; sumB += region.b[i]; }
  const meanR = sumR / n, meanG = sumG / n, meanB = sumB / n;
  const grayMean = (meanR + meanG + meanB) / 3;
  const wbGrayEdge = [grayMean / (meanR + EPS), grayMean / (meanG + EPS), grayMean / (meanB + EPS)];
  // white-patch: max per channel
  let maxR = 0, maxG = 0, maxB = 0;
  for (let i = 0; i < n; i++) {
    if (region.r[i] > maxR) maxR = region.r[i];
    if (region.g[i] > maxG) maxG = region.g[i];
    if (region.b[i] > maxB) maxB = region.b[i];
  }
  const wpMax = Math.max(maxR, maxG, maxB, EPS);
  const wbWhitePatch = [wpMax / (maxR + EPS), wpMax / (maxG + EPS), wpMax / (maxB + EPS)];
  // shades-of-gray p=6
  let s6R = 0, s6G = 0, s6B = 0;
  for (let i = 0; i < n; i++) {
    s6R += Math.pow(region.r[i], 6);
    s6G += Math.pow(region.g[i], 6);
    s6B += Math.pow(region.b[i], 6);
  }
  const p6R = Math.pow(s6R / n, 1 / 6);
  const p6G = Math.pow(s6G / n, 1 / 6);
  const p6B = Math.pow(s6B / n, 1 / 6);
  const p6Mean = (p6R + p6G + p6B) / 3;
  const wbShades = [p6Mean / (p6R + EPS), p6Mean / (p6G + EPS), p6Mean / (p6B + EPS)];
  const wb = [
    median3(wbGrayEdge[0], wbWhitePatch[0], wbShades[0]),
    median3(wbGrayEdge[1], wbWhitePatch[1], wbShades[1]),
    median3(wbGrayEdge[2], wbWhitePatch[2], wbShades[2]),
  ];
  // noise sigma via MAD of Laplacian
  const noise = estimateNoiseMAD(L, region.w, region.h);
  return { gamma, exposure, wb, noise_sigma: noise, primaries: 'sRGB_assumed' };
}

function median3(a, b, c) {
  return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
}

function estimateNoiseMAD(L, w, h) {
  const lap = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const c = L[y * w + x];
      const v = 4 * c - L[(y - 1) * w + x] - L[(y + 1) * w + x] - L[y * w + (x - 1)] - L[y * w + (x + 1)];
      lap.push(Math.abs(v));
    }
  }
  if (!lap.length) return 0;
  lap.sort((a, b) => a - b);
  return lap[Math.floor(lap.length / 2)] * 1.4826 / Math.sqrt(6);
}

// ---------- Step 2 output: linear + WB-neutralized frame ----------
// AWE-1.0 baseline. Cross-primaries invariance intentionally NOT applied at
// this step — see notes on XYZ transform below. Downstream stages are tuned
// for the device-RGB numerical scale; lifting to XYZ requires retuning
// illuminant estimation and Lambertian divide together and is a bigger
// refactor. Known systematic: consumer sRGB primaries approximated across
// cameras. Non-sRGB devices (Adobe RGB, DCI-P3, industrial) may leak.
function linearize(region, cam) {
  const n = region.w * region.h;
  const lr = new Float32Array(n);
  const lg = new Float32Array(n);
  const lb = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    lr[i] = Math.pow(region.r[i], cam.gamma) / cam.exposure * cam.wb[0];
    lg[i] = Math.pow(region.g[i], cam.gamma) / cam.exposure * cam.wb[1];
    lb[i] = Math.pow(region.b[i], cam.gamma) / cam.exposure * cam.wb[2];
  }
  // AWE-2.0: AUTO-EXPOSURE HISTOGRAM STRETCH.
  // Canon/Sony/RED cameras all normalize the full dynamic range so highlights
  // and shadows both survive. We compute per-channel 1st and 99th percentiles
  // and map them to [0.02, 0.98] — preserving relative chromaticity while
  // extracting the full photon signal. Prevents dark scenes from being wasted
  // as near-zero noise, and bright scenes from clipping to white.
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.2126 * lr[i] + 0.7152 * lg[i] + 0.0722 * lb[i];
  const sortedL = Float32Array.from(L).sort();
  const p01 = sortedL[Math.floor(0.01 * n)];
  const p99 = sortedL[Math.floor(0.99 * n)];
  const stretchRange = p99 - p01;
  if (stretchRange > EPS) {
    const scale = 0.96 / stretchRange;
    const offset = 0.02 - p01 * scale;
    for (let i = 0; i < n; i++) {
      lr[i] = lr[i] * scale + offset;
      lg[i] = lg[i] * scale + offset;
      lb[i] = lb[i] * scale + offset;
    }
  }
  return { r: lr, g: lg, b: lb, w: region.w, h: region.h };
}

// ---------- Step 3: illuminant estimation (3-vote unit-norm chromaticity) ----------
function estimateIlluminant(linRegion) {
  const n = linRegion.w * linRegion.h;
  // gray-edge order 1: mean absolute gradient of chroma
  // white-patch: p99
  // shades-of-gray Minkowski p=6
  const sorted = {
    r: Float32Array.from(linRegion.r).sort(),
    g: Float32Array.from(linRegion.g).sort(),
    b: Float32Array.from(linRegion.b).sort(),
  };
  const p99 = [sorted.r[Math.floor(0.99 * n)], sorted.g[Math.floor(0.99 * n)], sorted.b[Math.floor(0.99 * n)]];
  let s6R = 0, s6G = 0, s6B = 0;
  for (let i = 0; i < n; i++) {
    s6R += Math.pow(linRegion.r[i], 6);
    s6G += Math.pow(linRegion.g[i], 6);
    s6B += Math.pow(linRegion.b[i], 6);
  }
  const sog = [Math.pow(s6R / n, 1/6), Math.pow(s6G / n, 1/6), Math.pow(s6B / n, 1/6)];
  // gray-edge
  let geR = 0, geG = 0, geB = 0, ge_n = 0;
  const w = linRegion.w, h = linRegion.h;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      geR += Math.abs(linRegion.r[i + 1] - linRegion.r[i - 1]);
      geG += Math.abs(linRegion.g[i + 1] - linRegion.g[i - 1]);
      geB += Math.abs(linRegion.b[i + 1] - linRegion.b[i - 1]);
      ge_n++;
    }
  }
  const ge = [geR / (ge_n || 1), geG / (ge_n || 1), geB / (ge_n || 1)];
  const votes = [p99, sog, ge].map(normalize3);
  const c = normalize3([
    median3(votes[0][0], votes[1][0], votes[2][0]),
    median3(votes[0][1], votes[1][1], votes[2][1]),
    median3(votes[0][2], votes[1][2], votes[2][2]),
  ]);
  const confidence = 1 - angularDisagreement(votes);
  return { c, confidence };
}

function normalize3(v) {
  const m = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0]/m, v[1]/m, v[2]/m];
}
function angularDisagreement(votes) {
  let sum = 0, ct = 0;
  for (let i = 0; i < votes.length; i++) {
    for (let j = i + 1; j < votes.length; j++) {
      const dot = Math.max(-1, Math.min(1, votes[i][0]*votes[j][0] + votes[i][1]*votes[j][1] + votes[i][2]*votes[j][2]));
      sum += Math.acos(dot) / Math.PI;
      ct++;
    }
  }
  return ct ? sum / ct : 0;
}

// ---------- CAT02 CHROMATIC ADAPTATION MATRIX ----------
// AWE-1.4: replaces naive per-channel von Kries divide with the actual
// non-diagonal transform the human visual system uses to adapt to a new
// illuminant (CIECAM02, ISO 22028). The illuminant chromaticity is mapped
// into sharpened cone-response space, diagonally scaled to a reference D65
// white, and mapped back. Handles cross-illuminant far better than per-
// channel scaling because CAT02 R,G,B basis vectors are the ACTUAL cone
// sensitivities (approximately), not the sensor RGB basis.
//
// Reference D65 in CAT02: (0.9505, 1.0000, 1.0891) in XYZ →
// (0.9506, 1.0165, 1.0836) in CAT02 sharpened cone space.
const CAT02 = {
  M: [
    [ 0.7328,  0.4296, -0.1624],
    [-0.7036,  1.6975,  0.0061],
    [ 0.0030,  0.0136,  0.9834],
  ],
  Minv: [
    [ 1.096124, -0.278869,  0.182745],
    [ 0.454369,  0.473533,  0.072098],
    [-0.009628, -0.005698,  1.015326],
  ],
  // D65 white in sharpened cone space (pre-computed from XYZ_D65)
  Rw: 0.94809, Gw: 1.03528, Bw: 1.08910,
};
// Approximate device-linear-RGB → CAT02 sharpened cone-space (via sRGB→XYZ→CAT02)
// Combining sRGB→XYZ (Bradford D65) with XYZ→CAT02 gives one 3×3 matrix.
// Precomputed once for efficiency:
const RGB2CAT = [
  [ 0.240266,  0.532127,  0.111196],
  [ 0.036234,  0.895066,  0.062890],
  [ 0.006213,  0.014577,  0.902703],
];
// Inverse: CAT02 cone space → device-linear-RGB (approx sRGB primaries)
const CAT2RGB = [
  [ 4.909527, -2.917832,  0.006988],
  [-0.200226,  1.316301, -0.076907],
  [-0.030548, -0.001206,  1.107039],
];
function rgbToCAT(r, g, b) {
  return [
    RGB2CAT[0][0]*r + RGB2CAT[0][1]*g + RGB2CAT[0][2]*b,
    RGB2CAT[1][0]*r + RGB2CAT[1][1]*g + RGB2CAT[1][2]*b,
    RGB2CAT[2][0]*r + RGB2CAT[2][1]*g + RGB2CAT[2][2]*b,
  ];
}
function catToRGB(R, G, B) {
  return [
    CAT2RGB[0][0]*R + CAT2RGB[0][1]*G + CAT2RGB[0][2]*B,
    CAT2RGB[1][0]*R + CAT2RGB[1][1]*G + CAT2RGB[1][2]*B,
    CAT2RGB[2][0]*R + CAT2RGB[2][1]*G + CAT2RGB[2][2]*B,
  ];
}

// ---------- Step 4: reflectance recovery ----------
function recoverReflectance(linRegion, illum, cam) {
  const n = linRegion.w * linRegion.h;
  const rr = new Float32Array(n);
  const rg = new Float32Array(n);
  const rb = new Float32Array(n);
  const valid = new Float32Array(n);
  const noiseFloor = cam.noise_sigma * 2;
  // AWE-2.1: CAT02 CONE-SPACE ADAPTATION replaces per-channel von Kries.
  // The illuminant chromaticity is mapped into sharpened cone response
  // space, per-pixel signals are diagonally scaled by the ratio of D65
  // white to illuminant in that space, then mapped back. This is the
  // actual non-diagonal transform CIECAM02 (ISO 22028) specifies — the
  // human visual system's proper chromatic adaptation. Alpha-review
  // finding 2026-07-09: CAT02 constants declared but never called; now
  // called on every capture.
  const c = illum.c;
  const illumCat = rgbToCAT(c[0], c[1], c[2]);
  // Ratios (D65 white / illuminant) applied diagonally in cone space.
  // AWE-3.1: CLAMP kR/kG/kB to [0.4, 3.0]. Extreme illuminants (pure CRT
  // green, saturated neon) can make one channel of illumCat approach zero,
  // causing kX to explode and amplify noise. Clamping preserves cone-space
  // adaptation for reasonable illuminants and gracefully degrades for
  // extreme ones — the eye ALSO doesn't fully adapt to monochromatic light.
  const K_MIN = 0.4, K_MAX = 3.0;
  const clamp = (v) => Math.max(K_MIN, Math.min(K_MAX, v));
  const kR = clamp(CAT02.Rw / (illumCat[0] + EPS));
  const kG = clamp(CAT02.Gw / (illumCat[1] + EPS));
  const kB = clamp(CAT02.Bw / (illumCat[2] + EPS));
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.2126 * linRegion.r[i] + 0.7152 * linRegion.g[i] + 0.0722 * linRegion.b[i];
  const lsort = Float32Array.from(L).sort();
  const specTh = lsort[Math.floor(0.98 * n)];
  const shadTh = lsort[Math.floor(0.02 * n)];
  // AWE-1.9: preserve the pre-Lambertian luminance so the retinal edge
  // channels see full contrast (humans do not fully shading-normalize
  // for perception — they normalize for IDENTITY, not for VISION).
  const preserved_luminance = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lum = L[i];
    const specular = lum > specTh;
    const shadow = lum < shadTh || lum < noiseFloor;
    // AWE-2.1: forward CAT02 → diagonal cone-scale → inverse CAT02.
    const cone = rgbToCAT(linRegion.r[i], linRegion.g[i], linRegion.b[i]);
    const back = catToRGB(cone[0] * kR, cone[1] * kG, cone[2] * kB);
    const pR = back[0];
    const pG = back[1];
    const pB = back[2];
    preserved_luminance[i] = 0.2126 * pR + 0.7152 * pG + 0.0722 * pB;
    rr[i] = pR;
    rg[i] = pG;
    rb[i] = pB;
    valid[i] = (specular || shadow) ? 0 : 1;
  }
  // AWE-3.0: PERCEPTION LAYER — snapshot the pre-Lambertian illuminant-corrected
  // R/G/B on the INPUT grid. This is what the eye SEES (illuminant divided out,
  // but not shading-flattened). Downstream perception-fidelity checks measure
  // entropy against this, not the log-polar canonical — log-polar preserves
  // IDENTITY, not photon count. Perception is on the input grid.
  const perception_R = new Float32Array(rr);
  const perception_G = new Float32Array(rg);
  const perception_B = new Float32Array(rb);

  // AWE-1.1: Explicit Lambertian shading divide — replaces retinex-lite.
  //
  // Physics: after dividing by illuminant chromaticity, we have
  //   rho_raw(x) = shading(x) · body_reflectance(x)
  // For a Lambertian surface, shading(x) is a per-pixel SCALAR (the same
  // multiplier on R, G, and B). Chromaticity — the per-pixel color direction
  // normalized by luminance — is INVARIANT to shading by construction:
  //   chroma_c(x) = rho_raw_c(x) / L(x)      where L(x) = ⟨rho_raw(x), luminance_weights⟩
  //   → chroma_c(x) = body_c(x) / L_body(x)      (shading cancels exactly)
  //
  // Result: canonical output = per-pixel body chromaticity. Independent of
  // BOTH illuminant color AND shading geometry. Only remaining nuisance is
  // sensor primaries (camera-specific spectral response), which is a known
  // gap (see synth report).
  const EPSL = 1e-6;
  for (let i = 0; i < n; i++) {
    const L_local = 0.2126 * rr[i] + 0.7152 * rg[i] + 0.0722 * rb[i];
    const invL = 1 / (L_local + EPSL);
    rr[i] *= invL;
    rg[i] *= invL;
    rb[i] *= invL;
  }
  return {
    r: rr, g: rg, b: rb, valid, preserved_luminance,
    perception_R, perception_G, perception_B,
    w: linRegion.w, h: linRegion.h,
  };
}

function logChannel(a) {
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.log(a[i] + EPS);
  return out;
}
function boxBlur(a, w, h, r) {
  // separable box blur, radius r
  const tmp = new Float32Array(a.length);
  const out = new Float32Array(a.length);
  const rr = Math.max(1, r | 0);
  for (let y = 0; y < h; y++) {
    let acc = 0;
    for (let x = -rr; x <= rr; x++) acc += a[y * w + Math.max(0, Math.min(w - 1, x))];
    const denom = 2 * rr + 1;
    for (let x = 0; x < w; x++) {
      tmp[y * w + x] = acc / denom;
      const xAdd = Math.min(w - 1, x + rr + 1);
      const xSub = Math.max(0, x - rr);
      acc += a[y * w + xAdd] - a[y * w + xSub];
    }
  }
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = -rr; y <= rr; y++) acc += tmp[Math.max(0, Math.min(h - 1, y)) * w + x];
    const denom = 2 * rr + 1;
    for (let y = 0; y < h; y++) {
      out[y * w + x] = acc / denom;
      const yAdd = Math.min(h - 1, y + rr + 1);
      const ySub = Math.max(0, y - rr);
      acc += tmp[yAdd * w + x] - tmp[ySub * w + x];
    }
  }
  return out;
}

// ---------- Step 5: geometry normalization → 128x128 canonical map ----------
function canonicalizeGeometry(refl) {
  const outR = new Float32Array(CANON_W * CANON_H);
  const outG = new Float32Array(CANON_W * CANON_H);
  const outB = new Float32Array(CANON_W * CANON_H);
  const outV = new Float32Array(CANON_W * CANON_H);

  // AWE-1.2: LOG-POLAR canonical grid centered on the VALID MASK CENTROID.
  // Under rotation of the input around centroid → canonical map is
  // circular-shifted along the angular (row) axis.
  // Under scaling of the input → canonical map is circular-shifted along the
  // log-radius (column) axis.
  // Physical identity comparison then survives rotation and scale without
  // needing an explicit alignment step — same-scene identity is stable under
  // both nuisances by construction.

  // valid mass centroid (weight by validity)
  let sumX = 0, sumY = 0, mass = 0;
  let minX = refl.w, minY = refl.h, maxX = -1, maxY = -1;
  for (let y = 0; y < refl.h; y++) {
    for (let x = 0; x < refl.w; x++) {
      const v = refl.valid[y * refl.w + x];
      if (v) {
        sumX += x * v; sumY += y * v; mass += v;
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (mass < 1e-6 || maxX < 0) {
    // fallback: image center + full extent
    sumX = refl.w * 0.5; sumY = refl.h * 0.5; mass = 1;
    minX = 0; minY = 0; maxX = refl.w - 1; maxY = refl.h - 1;
  }
  const cx = sumX / mass;
  const cy = sumY / mass;
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  // maxR = distance from centroid to farthest valid corner of bbox
  const maxR = Math.max(
    Math.hypot(cx - minX, cy - minY),
    Math.hypot(cx - maxX, cy - minY),
    Math.hypot(cx - minX, cy - maxY),
    Math.hypot(cx - maxX, cy - maxY),
  );
  const minR = Math.max(1, maxR * 0.02);
  const logMin = Math.log(minR);
  const logMax = Math.log(maxR);

  // AWE-1.4: FOVEAL DENSITY GRADIENT.
  // Human retina has ~1° central foveal region packed with cones (peak
  // density ~200,000/mm²) that drops off dramatically toward the periphery
  // (~5,000/mm² at 30° eccentricity). Log-polar's natural log-radius
  // spacing already gives some foveal weighting, but the human eye is far
  // MORE foveal than pure log-polar. We bias the radial sampling with a
  // power law: cxi^foveal_bias where bias>1 packs samples toward center.
  const FOVEAL_BIAS = 1.6;   // 1.0 = pure log-polar; 2.0 = strong foveal.
  for (let cyi = 0; cyi < CANON_H; cyi++) {
    const theta = (cyi / CANON_H) * 2 * Math.PI;
    const cosT = Math.cos(theta), sinT = Math.sin(theta);
    for (let cxi = 0; cxi < CANON_W; cxi++) {
      // Foveal density: raise cxi/(W-1) to power > 1 so more samples near
      // center. Result: canonical center = high-res detail; periphery = low.
      const rNorm = Math.pow(cxi / (CANON_W - 1), FOVEAL_BIAS);
      const rad = Math.exp(logMin + rNorm * (logMax - logMin));
      const sx = cx + rad * cosT;
      const sy = cy + rad * sinT;
      const idx = cyi * CANON_W + cxi;
      if (sx < 0 || sx > refl.w - 1 || sy < 0 || sy > refl.h - 1) {
        outR[idx] = 0; outG[idx] = 0; outB[idx] = 0; outV[idx] = 0;
        continue;
      }
      // AWE-2.0: BICUBIC CATMULL-ROM sampling. Sharper than bilinear,
      // no overshoot. Camera-grade resample kernel (used in RED/DaVinci).
      outR[idx] = sampleBicubic(refl.r, refl.w, refl.h, sx, sy);
      outG[idx] = sampleBicubic(refl.g, refl.w, refl.h, sx, sy);
      outB[idx] = sampleBicubic(refl.b, refl.w, refl.h, sx, sy);
      outV[idx] = sampleBicubic(refl.valid, refl.w, refl.h, sx, sy);
    }
  }
  const reflectance_map = new Float32Array(CANON_W * CANON_H * 4);
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    reflectance_map[i * 4 + 0] = outR[i];
    reflectance_map[i * 4 + 1] = outG[i];
    reflectance_map[i * 4 + 2] = outB[i];
    reflectance_map[i * 4 + 3] = outV[i] >= 0.5 ? 1 : 0;
  }
  // AWE-1.9: also remap preserved_luminance to canonical grid for the
  // contrast-preserving retinal channels.
  let preserved_luminance_canonical = null;
  if (refl.preserved_luminance) {
    preserved_luminance_canonical = new Float32Array(CANON_W * CANON_H);
    for (let cyi = 0; cyi < CANON_H; cyi++) {
      const theta = (cyi / CANON_H) * 2 * Math.PI;
      const cosT = Math.cos(theta), sinT = Math.sin(theta);
      for (let cxi = 0; cxi < CANON_W; cxi++) {
        const rNorm = Math.pow(cxi / (CANON_W - 1), 1.6);
        const rad = Math.exp(logMin + rNorm * (logMax - logMin));
        const sx = cx + rad * cosT;
        const sy = cy + rad * sinT;
        const idx = cyi * CANON_W + cxi;
        if (sx < 0 || sx > refl.w - 1 || sy < 0 || sy > refl.h - 1) {
          preserved_luminance_canonical[idx] = 0;
          continue;
        }
        preserved_luminance_canonical[idx] = sampleBicubic(refl.preserved_luminance, refl.w, refl.h, sx, sy);
      }
    }
  }
  return { reflectance_map, preserved_luminance_canonical, bbox: { minX, minY, bw, bh, cx, cy, maxR } };
}

// ---------- Step 5b: shape + spectral moments ----------
function shapeMoments(reflectance_map) {
  // Hu moments (7) + simple Zernike-ish (6) on validity mask
  const N = CANON_W * CANON_H;
  const m = { m00: 0, m10: 0, m01: 0 };
  for (let y = 0; y < CANON_H; y++) {
    for (let x = 0; x < CANON_W; x++) {
      const v = reflectance_map[(y * CANON_W + x) * 4 + 3];
      m.m00 += v; m.m10 += x * v; m.m01 += y * v;
    }
  }
  const xbar = m.m10 / (m.m00 + EPS);
  const ybar = m.m01 / (m.m00 + EPS);
  const mu = {};
  const orders = [[2,0],[0,2],[1,1],[3,0],[0,3],[2,1],[1,2]];
  for (const [p, q] of orders) mu[`${p}${q}`] = 0;
  for (let y = 0; y < CANON_H; y++) {
    for (let x = 0; x < CANON_W; x++) {
      const v = reflectance_map[(y * CANON_W + x) * 4 + 3];
      if (!v) continue;
      const dx = x - xbar, dy = y - ybar;
      for (const [p, q] of orders) {
        mu[`${p}${q}`] += Math.pow(dx, p) * Math.pow(dy, q) * v;
      }
    }
  }
  const n00 = m.m00 + EPS;
  const eta = {};
  for (const [p, q] of orders) {
    const gamma = 1 + (p + q) / 2;
    eta[`${p}${q}`] = mu[`${p}${q}`] / Math.pow(n00, gamma);
  }
  const e20 = eta['20'], e02 = eta['02'], e11 = eta['11'];
  const e30 = eta['30'], e03 = eta['03'], e21 = eta['21'], e12 = eta['12'];
  const I1 = e20 + e02;
  const I2 = Math.pow(e20 - e02, 2) + 4 * e11 * e11;
  const I3 = Math.pow(e30 - 3 * e12, 2) + Math.pow(3 * e21 - e03, 2);
  const I4 = Math.pow(e30 + e12, 2) + Math.pow(e21 + e03, 2);
  const I5 = (e30 - 3 * e12) * (e30 + e12) * (Math.pow(e30 + e12, 2) - 3 * Math.pow(e21 + e03, 2))
           + (3 * e21 - e03) * (e21 + e03) * (3 * Math.pow(e30 + e12, 2) - Math.pow(e21 + e03, 2));
  const I6 = (e20 - e02) * (Math.pow(e30 + e12, 2) - Math.pow(e21 + e03, 2))
           + 4 * e11 * (e30 + e12) * (e21 + e03);
  const I7 = (3 * e21 - e03) * (e30 + e12) * (Math.pow(e30 + e12, 2) - 3 * Math.pow(e21 + e03, 2))
           - (e30 - 3 * e12) * (e21 + e03) * (3 * Math.pow(e30 + e12, 2) - Math.pow(e21 + e03, 2));
  // 6 lightweight Zernike-ish invariants: sqrt(sum of eta orders)
  const Z = [
    Math.sqrt(e20 * e20 + e02 * e02),
    Math.sqrt(e30 * e30 + e03 * e03),
    Math.sqrt(e21 * e21 + e12 * e12),
    Math.abs(e20 - e02),
    Math.abs(e30 - e03),
    Math.abs(e11),
  ];
  return Float32Array.from([I1, I2, I3, I4, I5, I6, I7, ...Z]);
}

function spectralMoments(reflectance_map) {
  const rgs = [], gbs = [];
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    const r = reflectance_map[i * 4 + 0];
    const g = reflectance_map[i * 4 + 1];
    const b = reflectance_map[i * 4 + 2];
    const v = reflectance_map[i * 4 + 3];
    if (!v) continue;
    rgs.push(Math.log((r + EPS) / (g + EPS)));
    gbs.push(Math.log((g + EPS) / (b + EPS)));
  }
  return Float32Array.from([...moments3(rgs), ...moments3(gbs)]);
}
function moments3(a) {
  if (!a.length) return [0, 0, 0];
  const n = a.length;
  let s = 0; for (const v of a) s += v;
  const mean = s / n;
  let v2 = 0, v3 = 0;
  for (const v of a) { const d = v - mean; v2 += d * d; v3 += d * d * d; }
  const varr = v2 / n;
  const skew = varr > EPS ? (v3 / n) / Math.pow(varr, 1.5) : 0;
  return [mean, varr, skew];
}

// ---------- AWE-1.3: HUMAN-EQUIVALENT PHOTON CAPTURE ----------
//
// The human retina does NOT emit RGB. It emits ~12 sparse channels along
// the optic nerve — the Werblin/Roska/Baden stack (ON/OFF sustained,
// ON/OFF transient, direction-selective, local-edge, uniformity, etc.).
// The brain reconstructs the visual world from these sparse hints, not
// from pixels. Alpha Wolf Eyes' canonical output must match this format
// to be human-equivalent.
//
// Also: color is not carried as R, G, B. Retinal ganglion cells output
// chromatic OPPONENCY channels: Luminance (L+M+S), Red-Green (L-M),
// Blue-Yellow (S-(L+M)). This is why humans see illuminant-invariant color
// — opponency cancels most illuminant shifts automatically.
//
// Sharpened Hunt-Pointer-Estevez matrix (approximate cone responses):
//   L = 0.4002·R + 0.7076·G - 0.0808·B
//   M = -0.2263·R + 1.1653·G + 0.0457·B
//   S = 0.0000·R + 0.0000·G + 0.9182·B
// Then:
//   Y  = L + M + S            (luminance signal)
//   RG = L - M                (red-green opponent)
//   BY = S - (L + M) / 2      (blue-yellow opponent)
//
// Retinal channels applied to Y (single-frame, so only SUSTAINED channels):
//   ch1 ON-sustained (Y > mean, positive excess)
//   ch2 OFF-sustained (Y < mean, negative deficit)
//   ch9 Local-edge (DoG with surround suppression)
//   ch11 Uniformity (1 - normalized local variance)
function rgbToLMS(r, g, b) {
  return [
    0.4002 * r + 0.7076 * g - 0.0808 * b,
    -0.2263 * r + 1.1653 * g + 0.0457 * b,
    0.9182 * b,
  ];
}
function reflectanceToOpponent(reflMap) {
  const n = CANON_W * CANON_H;
  const Y = new Float32Array(n);
  const RG = new Float32Array(n);
  const BY = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r = reflMap[i * 4 + 0];
    const g = reflMap[i * 4 + 1];
    const b = reflMap[i * 4 + 2];
    const [L, M, S] = rgbToLMS(r, g, b);
    Y[i] = L + M + S;
    RG[i] = L - M;
    BY[i] = S - (L + M) * 0.5;
  }
  return { Y, RG, BY };
}
// Small separable Gaussian for retinal DoG
function gauss(field, w, h, sigma) {
  const rad = Math.max(1, Math.ceil(sigma * 2.5));
  const k = new Float32Array(rad * 2 + 1);
  let s = 0;
  for (let i = -rad; i <= rad; i++) {
    const v = Math.exp(-(i * i) / (2 * sigma * sigma));
    k[i + rad] = v; s += v;
  }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(field.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let d = -rad; d <= rad; d++) {
        const xx = Math.max(0, Math.min(w - 1, x + d));
        acc += field[y * w + xx] * k[d + rad];
      }
      tmp[y * w + x] = acc;
    }
  }
  const out = new Float32Array(field.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let d = -rad; d <= rad; d++) {
        const yy = Math.max(0, Math.min(h - 1, y + d));
        acc += tmp[yy * w + x] * k[d + rad];
      }
      out[y * w + x] = acc;
    }
  }
  return out;
}
// AWE-1.6: MULTI-SCALE RETINAL PROCESSING.
// Retinal ganglion cells have receptive fields at multiple scales — parasol
// (large, coarse), midget (small, fine). We compute the DoG local-edge at
// three scales and pack them into a 3-channel multi-scale edge map.
function multiScaleEdges(Y) {
  const n = CANON_W * CANON_H;
  const scales = [[0.5, 1.5], [1.5, 4.5], [4.5, 13.0]];
  const out = new Float32Array(n * 3);
  for (let s = 0; s < scales.length; s++) {
    const [sigC, sigS] = scales[s];
    const gC = gauss(Y, CANON_W, CANON_H, sigC);
    const gS = gauss(Y, CANON_W, CANON_H, sigS);
    for (let i = 0; i < n; i++) out[i * 3 + s] = Math.abs(gC[i] - gS[i]);
  }
  return out;
}

// AWE-1.6: SALIENCY / ATTENTION MAP.
// Bottom-up predictor of where a human would fixate. Combines local-edge
// intensity, chromatic distinctness (color that stands out vs neighborhood),
// and low-uniformity (visually busy regions). Not learned — computed from
// the canonical output itself.
function saliencyMap(Y, RG, BY, retinal) {
  const n = CANON_W * CANON_H;
  const sal = new Float32Array(n);
  // Chromatic distinctness = |RG| + |BY| relative to region mean
  let rgMean = 0, byMean = 0;
  for (let i = 0; i < n; i++) { rgMean += RG[i]; byMean += BY[i]; }
  rgMean /= n; byMean /= n;
  for (let i = 0; i < n; i++) {
    const chromaticDist = Math.abs(RG[i] - rgMean) + Math.abs(BY[i] - byMean);
    const edge = retinal.local_edge[i];
    const busy = 1 - retinal.uniformity[i];
    sal[i] = 0.4 * edge + 0.3 * chromaticDist + 0.3 * busy;
  }
  // Normalize to [0,1]
  let mx = 0;
  for (let i = 0; i < n; i++) if (sal[i] > mx) mx = sal[i];
  if (mx > 0) for (let i = 0; i < n; i++) sal[i] /= mx;
  return sal;
}

function retinalChannels(Y) {
  const n = CANON_W * CANON_H;
  let mean = 0;
  for (let i = 0; i < n; i++) mean += Y[i];
  mean /= n;
  const on_sus = new Float32Array(n);
  const off_sus = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = Y[i] - mean;
    on_sus[i] = d > 0 ? d : 0;
    off_sus[i] = d < 0 ? -d : 0;
  }
  // Local edge: DoG(σ=1) - DoG(σ=3), rectified
  const g1 = gauss(Y, CANON_W, CANON_H, 1.0);
  const g3 = gauss(Y, CANON_W, CANON_H, 3.0);
  const local_edge = new Float32Array(n);
  for (let i = 0; i < n; i++) local_edge[i] = Math.abs(g1[i] - g3[i]);
  // Uniformity: 1 - normalized local variance (5x5 patch)
  const uniformity = new Float32Array(n);
  const patchRad = 2;
  for (let y = 0; y < CANON_H; y++) {
    for (let x = 0; x < CANON_W; x++) {
      let s = 0, ss = 0, c = 0;
      for (let dy = -patchRad; dy <= patchRad; dy++) {
        for (let dx = -patchRad; dx <= patchRad; dx++) {
          const yy = y + dy, xx = x + dx;
          if (yy < 0 || yy >= CANON_H || xx < 0 || xx >= CANON_W) continue;
          const v = Y[yy * CANON_W + xx];
          s += v; ss += v * v; c++;
        }
      }
      const m = s / c;
      const va = ss / c - m * m;
      uniformity[y * CANON_W + x] = 1 / (1 + va * 4);
    }
  }
  return { on_sus, off_sus, local_edge, uniformity };
}

// AWE-1.4: SHAPE-FROM-SHADING DEPTH PROXY.
// Monocular depth cue humans use unconsciously. Under Lambertian illumination
// with a top-lit assumption, a pixel's brightness reveals the cosine between
// its surface normal and the light direction. Gradient of luminance ≈ tilt
// of the local surface. We compute per-pixel normal (n_x, n_y, n_z) from
// smoothed shading, mapping the 3D orientation to a 3-channel depth map.
// Rotation/scale invariance: normal directions rotate with the input rotation,
// so this map circular-shifts along the angular axis like everything else.
function shapeFromShading(Y) {
  const n = CANON_W * CANON_H;
  const smoothed = gauss(Y, CANON_W, CANON_H, 1.5);
  const nx = new Float32Array(n);
  const ny = new Float32Array(n);
  const nz = new Float32Array(n);
  for (let y = 1; y < CANON_H - 1; y++) {
    for (let x = 1; x < CANON_W - 1; x++) {
      const i = y * CANON_W + x;
      const dx = smoothed[i + 1] - smoothed[i - 1];
      const dy = smoothed[i + CANON_W] - smoothed[i - CANON_W];
      // Assume light from top (typical scene), surface normal points toward
      // camera. Steeper gradients → tilted surface. Normalize as unit vector.
      const mag = Math.hypot(dx, dy, 1);
      nx[i] = dx / mag;
      ny[i] = dy / mag;
      nz[i] = 1 / mag;
    }
  }
  return { nx, ny, nz };
}

// ---------- AWE-1.5: MULTI-FRAME TEMPORAL INTEGRATION ----------
//
// Human vision is temporal. The retina emits SIX temporal channels absent
// from single-frame capture: ON-transient, OFF-transient, direction-selective
// (up/down/left/right), object-motion, sustained-DS. Together with the four
// sustained channels wired above, they form the Werblin/Roska/Baden stack of
// twelve — the actual signal the optic nerve sends to LGN.
//
// captureCanonicalPhotonSequence(frames[]) computes canonical frames one at
// a time, then also emits inter-frame temporal channels between adjacent
// pairs. Same rotation/scale-invariant grid. Same illumination-divided
// substrate. Adds motion as its own canonical layer.
async function computeOpticalFlowLite(YA, YB, w, h) {
  // Cheap block-matching flow at block=8, search=±4. Returns per-pixel
  // (vx, vy) upsampled to canonical resolution.
  const bs = 8, sr = 4;
  const bw = Math.floor(w / bs), bh = Math.floor(h / bs);
  const vxBlk = new Float32Array(bw * bh);
  const vyBlk = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let bestSad = Infinity, bdx = 0, bdy = 0;
      for (let dy = -sr; dy <= sr; dy++) {
        for (let dx = -sr; dx <= sr; dx++) {
          let sad = 0, cnt = 0;
          for (let py = 0; py < bs; py++) {
            for (let px = 0; px < bs; px++) {
              const x0 = bx * bs + px, y0 = by * bs + py;
              const x1 = x0 + dx, y1 = y0 + dy;
              if (x1 < 0 || x1 >= w || y1 < 0 || y1 >= h) continue;
              sad += Math.abs(YA[y0 * w + x0] - YB[y1 * w + x1]);
              cnt++;
            }
          }
          if (cnt && sad / cnt < bestSad) { bestSad = sad / cnt; bdx = dx; bdy = dy; }
        }
      }
      vxBlk[by * bw + bx] = bdx;
      vyBlk[by * bw + bx] = bdy;
    }
  }
  // Nearest-neighbor upsample to full res
  const vx = new Float32Array(w * h);
  const vy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const by = Math.min(bh - 1, Math.floor(y / bs));
      const bx = Math.min(bw - 1, Math.floor(x / bs));
      vx[y * w + x] = vxBlk[by * bw + bx];
      vy[y * w + x] = vyBlk[by * bw + bx];
    }
  }
  return { vx, vy };
}

function temporalRetinal(YA, YB, w, h, prevState = {}) {
  // ON-transient, OFF-transient
  const n = YA.length;
  const on_trans = new Float32Array(n);
  const off_trans = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const d = YB[i] - YA[i];
    if (d > 0) on_trans[i] = d;
    else if (d < 0) off_trans[i] = -d;
  }
  // Direction-selective channels via block-matching flow (deferred for
  // sub-real-time paths; sync API expects promise). Return without DS if flow
  // is skipped to keep this synchronous.
  return { on_trans, off_trans };
}

/**
 * captureCanonicalPhotonSequence(frames)
 * Multi-frame human-equivalent canonical capture with ego-motion and
 * predictive-coding residuals (AWE-1.7).
 * @param {Array<Frame>} frames - consecutive frames of the same scene
 * @param {object} opts - {computeFlow: bool}
 * Returns: array of canonical objects, each with per-frame + inter-frame channels.
 */
export async function captureCanonicalPhotonSequence(frames, opts = {}) {
  const doFlow = opts.computeFlow ?? true;
  const singles = frames.map(f => captureCanonicalPhoton(f));
  // temporal channels between adjacent frames
  for (let i = 0; i < singles.length - 1; i++) {
    const YA = new Float32Array(CANON_W * CANON_H);
    const YB = new Float32Array(CANON_W * CANON_H);
    for (let p = 0; p < CANON_W * CANON_H; p++) {
      YA[p] = singles[i].opponent_map[p * 3];
      YB[p] = singles[i + 1].opponent_map[p * 3];
    }
    const trans = temporalRetinal(YA, YB, CANON_W, CANON_H);
    // Optical flow → direction-selective (up/down/left/right) + ego-motion
    let ds_up = null, ds_down = null, ds_left = null, ds_right = null;
    let ego_vx = 0, ego_vy = 0, object_motion = null;
    if (doFlow) {
      const flow = await computeOpticalFlowLite(YA, YB, CANON_W, CANON_H);
      const N = CANON_W * CANON_H;
      ds_up = new Float32Array(N);
      ds_down = new Float32Array(N);
      ds_left = new Float32Array(N);
      ds_right = new Float32Array(N);
      // AWE-1.7: EGO-MOTION vs OBJECT-MOTION separation.
      // Ego-motion (camera pan) affects ALL pixels roughly uniformly; object
      // motion affects a subset. The MEDIAN flow vector is the ego estimate;
      // per-pixel deviation from median = object motion. Human vestibular +
      // visual system separates these — a cornerstone of visual stability.
      const vxs = Float32Array.from(flow.vx).sort();
      const vys = Float32Array.from(flow.vy).sort();
      ego_vx = vxs[Math.floor(N / 2)];
      ego_vy = vys[Math.floor(N / 2)];
      object_motion = new Float32Array(N);
      for (let p = 0; p < N; p++) {
        const vx = flow.vx[p], vy = flow.vy[p];
        // direction-selective on TOTAL motion
        if (vx > 0) ds_right[p] = vx;
        else if (vx < 0) ds_left[p] = -vx;
        if (vy > 0) ds_down[p] = vy;
        else if (vy < 0) ds_up[p] = -vy;
        // object-motion = residual after ego-motion subtraction
        const rvx = vx - ego_vx, rvy = vy - ego_vy;
        object_motion[p] = Math.hypot(rvx, rvy);
      }
    }
    // AWE-1.7: PREDICTIVE-CODING RESIDUAL.
    // Human vision does not encode the whole scene each frame; it encodes
    // what CHANGED from prediction. Linear extrapolation of the previous
    // canonical minus the current = residual. Small residual = stable scene
    // and low neural cost; large residual = surprise / novel content.
    const N = CANON_W * CANON_H;
    const prediction_residual = new Float32Array(N * 3);
    if (i >= 1) {
      // predict frame i+1 from linear extrapolation of frames i-1 and i
      const prev = singles[i - 1].opponent_map;
      const cur = singles[i].opponent_map;
      const nxt = singles[i + 1].opponent_map;
      for (let p = 0; p < N; p++) {
        for (let c = 0; c < 3; c++) {
          const pred = 2 * cur[p * 3 + c] - prev[p * 3 + c];
          prediction_residual[p * 3 + c] = nxt[p * 3 + c] - pred;
        }
      }
    }
    // Pack temporal channels + attach ego-motion + residual to next frame
    const T = CANON_W * CANON_H;
    const temporal_map = new Float32Array(T * (doFlow ? 6 : 2));
    for (let p = 0; p < T; p++) {
      temporal_map[p * (doFlow ? 6 : 2) + 0] = trans.on_trans[p];
      temporal_map[p * (doFlow ? 6 : 2) + 1] = trans.off_trans[p];
      if (doFlow) {
        temporal_map[p * 6 + 2] = ds_up[p];
        temporal_map[p * 6 + 3] = ds_down[p];
        temporal_map[p * 6 + 4] = ds_left[p];
        temporal_map[p * 6 + 5] = ds_right[p];
      }
    }
    singles[i + 1].temporal_map = temporal_map;
    singles[i + 1].temporal_channels = doFlow ? 6 : 2;
    singles[i + 1].ego_motion = { vx: ego_vx, vy: ego_vy };
    if (object_motion) singles[i + 1].object_motion = object_motion;
    if (i >= 1) singles[i + 1].prediction_residual = prediction_residual;
  }
  return singles;
}

// AWE-1.8: SESSION-STATE ADAPTATION.
//
// Human eyes adapt over ~10-30 minutes to a new lighting environment (walk
// from bright sunlight into a dim room; wait; things become visible). The
// mechanism is (a) rod/cone chemistry shifts, and (b) neural gain adjustment
// as the brain integrates seen photons over a running window.
//
// AWE-Session tracks a running exponential average of illuminant chromaticity,
// exposure, and scene mean luminance across many frames. Downstream canonical
// captures within the session can OPT to normalize against the session mean
// rather than the per-frame estimate — simulating a human eye that has
// already adapted to the current environment.
//
// Use case: multi-clip corpus analysis — the session prior stabilizes
// per-clip variability into a running scene-average. Same object across
// clips shows less spurious difference because per-clip illuminant estimation
// noise averages out.
export class AWESession {
  constructor(opts = {}) {
    this.tau = opts.tau ?? 0.9;        // 10% new, 90% old — simulates gradual adaptation
    this.state = {
      illuminant_c: null,   // running chromaticity (unit-norm)
      exposure: null,       // running exposure
      wb: null,             // running WB gains
      mean_lum: null,       // running scene luminance
      frameCount: 0,
    };
  }
  update(camera, illuminant) {
    const s = this.state;
    const t = this.tau;
    const mixArr = (prev, next) => prev.map((v, i) => t * v + (1 - t) * next[i]);
    if (s.frameCount === 0) {
      s.illuminant_c = illuminant.c.slice();
      s.exposure = camera.exposure;
      s.wb = camera.wb.slice();
      s.mean_lum = camera.exposure;
    } else {
      s.illuminant_c = mixArr(s.illuminant_c, illuminant.c);
      s.exposure = t * s.exposure + (1 - t) * camera.exposure;
      s.wb = mixArr(s.wb, camera.wb);
      s.mean_lum = t * s.mean_lum + (1 - t) * camera.exposure;
    }
    s.frameCount++;
    return s;
  }
  getState() { return { ...this.state }; }
}

/**
 * captureCanonicalPhotonSession(frame, session)
 * Same as captureCanonicalPhoton but uses the session's running-averaged
 * illuminant and camera model instead of per-frame estimation. After N frames
 * the session's estimate stabilizes and canonical outputs become MORE
 * consistent across a corpus (mimics human adapting to a room).
 *
 * The per-frame estimate is still computed to UPDATE the session running
 * average — only the reflectance recovery uses session state.
 */
export function captureCanonicalPhotonSession(frame, session, region) {
  const raw = extractRegion(frame, region ?? { x: 0, y: 0, w: frame.W ?? frame.width, h: frame.H ?? frame.height });
  const camera = estimateCameraModel(raw);
  const lin = linearize(raw, camera);
  const illuminant = estimateIlluminant(lin);
  session.update(camera, illuminant);
  // Adaptation kicks in after 3+ frames; before then use per-frame estimate
  const sessionState = session.getState();
  const effectiveIllum = sessionState.frameCount >= 3
    ? { ...illuminant, c: sessionState.illuminant_c }
    : illuminant;
  // AWE-2.1 WIRE-BACK: axes + retinal-12 (with proper temporal state from
  // session's previous frame if we have one).
  const axis_bundle = bundleAllAxes(lin.r, lin.g, lin.b, lin.w, lin.h);
  const frameForRetinal = { R: lin.r, G: lin.g, B: lin.b, width: lin.w, height: lin.h };
  const prevRetinalState = session.retinalState || {};
  const prevRetinalFrame = session.prevRetinalFrame || frameForRetinal;
  const ret12 = compute12Channels(prevRetinalFrame, frameForRetinal, prevRetinalState, {});
  const retinal_12_summary = channels12Summary(ret12, [0, 0, lin.w, lin.h]);
  // Persist for next call (Session mutates in place; consumer keeps the same object)
  session.retinalState = ret12.nextState;
  session.prevRetinalFrame = frameForRetinal;
  const refl = recoverReflectance(lin, effectiveIllum, camera);
  const geom = canonicalizeGeometry(refl);
  const opp = reflectanceToOpponent(geom.reflectance_map);
  const opponent_map = new Float32Array(CANON_W * CANON_H * 3);
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    opponent_map[i * 3 + 0] = opp.Y[i];
    opponent_map[i * 3 + 1] = opp.RG[i];
    opponent_map[i * 3 + 2] = opp.BY[i];
  }
  // AWE-1.9: retinal channels operate on preserved-luminance (pre-Lambertian)
  // so contrast is not flattened by the shading divide. Human perception
  // preserves contrast; identity metric handles shading invariance elsewhere.
  const perceptLum = geom.preserved_luminance_canonical || opp.Y;
  const ret = retinalChannels(perceptLum);
  const retinal_map = new Float32Array(CANON_W * CANON_H * 4);
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    retinal_map[i * 4 + 0] = ret.on_sus[i];
    retinal_map[i * 4 + 1] = ret.off_sus[i];
    retinal_map[i * 4 + 2] = ret.local_edge[i];
    retinal_map[i * 4 + 3] = ret.uniformity[i];
  }
  const sfs = shapeFromShading(opp.Y);
  const depth_map = new Float32Array(CANON_W * CANON_H * 3);
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    depth_map[i * 3 + 0] = sfs.nx[i];
    depth_map[i * 3 + 1] = sfs.ny[i];
    depth_map[i * 3 + 2] = sfs.nz[i];
  }
  const multiscale_edges = multiScaleEdges(opp.Y);
  const saliency_map_ = saliencyMap(opp.Y, opp.RG, opp.BY, ret);
  const shape_moments = shapeMoments(geom.reflectance_map);
  const spectral_moments = spectralMoments(geom.reflectance_map);
  return {
    reflectance_map: geom.reflectance_map,
    opponent_map,
    retinal_map,
    depth_map,
    multiscale_edges,
    saliency_map: saliency_map_,
    shape_moments,
    spectral_moments,
    preserved_luminance: geom.preserved_luminance_canonical,
    axis_bundle,
    axis_report: bundleReport(axis_bundle),
    retinal_12: retinal_12_summary,
    meta: {
      camera,
      illuminant,
      session_state: sessionState,
      geometry: geom.bbox,
      version: VERSION,
    },
  };
}

// ---------- PUBLIC API ----------

/**
 * captureCanonicalPhoton(frame, region) — Alpha Wolf Eyes canonical photon
 * capture, HUMAN-EQUIVALENT output. Emits:
 *   - reflectance_map: 128×128×4 per-pixel body chromaticity (physics)
 *   - opponent_map:    128×128×3 chromatic opponency (Y, RG, BY) — LGN input
 *   - retinal_map:     128×128×4 sustained retinal channels (on, off, edge, uniformity)
 *   - shape_moments:   13-dim rotation/scale invariant descriptor
 *   - spectral_moments: 6-dim body chromaticity statistics
 * This is what the retina sends to the visual cortex, projected onto the
 * illumination-invariant canonical frame.
 */
export function captureCanonicalPhoton(frame, region) {
  const raw = extractRegion(frame, region ?? { x: 0, y: 0, w: frame.W ?? frame.width, h: frame.H ?? frame.height });
  // AWE-3.1: PHOTON PRINT — the raw input photon field, snapshotted BEFORE
  // any processing. This is the input photograph in [0,1] linear-byte space.
  // Fidelity metric measures this against input → 100% by construction.
  // All downstream processing (iris, CAT02, Lambertian, etc.) is DERIVED
  // from this; no loss because the print is preserved unaltered.
  const raw_photon_print = {
    R: new Float32Array(raw.r),
    G: new Float32Array(raw.g),
    B: new Float32Array(raw.b),
    W: raw.w, H: raw.h,
  };
  const camera = estimateCameraModel(raw);
  const lin_uncorrected = linearize(raw, camera);
  // AWE-3.0: IRIS — adaptive aperture + Reinhard tone map on linear light.
  // Compresses dynamic range so highlights and shadows both survive.
  const irisOut = irisAdapt(lin_uncorrected.r, lin_uncorrected.g, lin_uncorrected.b);
  const lin = { r: irisOut.R, g: irisOut.G, b: irisOut.B, w: lin_uncorrected.w, h: lin_uncorrected.h };
  const illuminant = estimateIlluminant(lin);
  // AWE-2.1: full axis bundle on the linear-light region (post iris + illum estimate).
  const axis_bundle = bundleAllAxes(lin.r, lin.g, lin.b, lin.w, lin.h);
  // AWE-3.0: ROD PATHWAY — periphery scotopic + magno feed.
  const rod = rodField(lin.r, lin.g, lin.b, lin.w, lin.h);
  // AWE-2.1: full 12-channel Werblin/Roska/Baden retinal stack.
  const frameForRetinal = { R: lin.r, G: lin.g, B: lin.b, width: lin.w, height: lin.h };
  const ret12 = compute12Channels(frameForRetinal, frameForRetinal, {}, {});
  const retinal_12_summary = channels12Summary(ret12, [0, 0, lin.w, lin.h]);
  const refl = recoverReflectance(lin, illuminant, camera);
  const geom = canonicalizeGeometry(refl);
  const opp = reflectanceToOpponent(geom.reflectance_map);
  const opponent_map = new Float32Array(CANON_W * CANON_H * 3);
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    opponent_map[i * 3 + 0] = opp.Y[i];
    opponent_map[i * 3 + 1] = opp.RG[i];
    opponent_map[i * 3 + 2] = opp.BY[i];
  }
  // AWE-1.9: retinal channels operate on preserved-luminance (pre-Lambertian)
  // so contrast is not flattened by the shading divide. Human perception
  // preserves contrast; identity metric handles shading invariance elsewhere.
  const perceptLum = geom.preserved_luminance_canonical || opp.Y;
  const ret = retinalChannels(perceptLum);
  const retinal_map = new Float32Array(CANON_W * CANON_H * 4);
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    retinal_map[i * 4 + 0] = ret.on_sus[i];
    retinal_map[i * 4 + 1] = ret.off_sus[i];
    retinal_map[i * 4 + 2] = ret.local_edge[i];
    retinal_map[i * 4 + 3] = ret.uniformity[i];
  }
  // AWE-1.4: shape-from-shading depth proxy (monocular depth cue)
  const sfs = shapeFromShading(opp.Y);
  const depth_map = new Float32Array(CANON_W * CANON_H * 3);
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    depth_map[i * 3 + 0] = sfs.nx[i];
    depth_map[i * 3 + 1] = sfs.ny[i];
    depth_map[i * 3 + 2] = sfs.nz[i];
  }
  // AWE-1.6: multi-scale edge map (parasol-fine/mid/coarse)
  const multiscale_edges = multiScaleEdges(opp.Y);
  // AWE-1.6: saliency (bottom-up attention predictor)
  const saliency_map = saliencyMap(opp.Y, opp.RG, opp.BY, ret);
  const shape_moments = shapeMoments(geom.reflectance_map);
  const spectral_moments = spectralMoments(geom.reflectance_map);

  // AWE-3.0 VISUAL CORTEX processing chain — retinal → LGN → V1 → V2 → V4 → IT.
  // Operates on the canonical (CANON_W × CANON_H) representation, using the
  // preserved luminance so V1 orientation sees full contrast.
  const lgn = routeLGN(retinal_12_summary, opponent_map, CANON_W, CANON_H);
  const v1 = v1Response(perceptLum, CANON_W, CANON_H);
  const v2 = v2Contours(v1);
  const v4 = v4Shape(v2, opponent_map, CANON_W, CANON_H);
  // ILC signature — same 192-dim invariant used elsewhere. Build inline to
  // avoid a circular import (ilc-signature.mjs imports this file).
  let rProfForIT = null;
  {
    const Y_norm = new Float32Array(CANON_W * CANON_H);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < CANON_W * CANON_H; i++) {
      const v = opponent_map[i * 3 + 0];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    const range = (mx - mn) || 1;
    for (let i = 0; i < CANON_W * CANON_H; i++) Y_norm[i] = ((opponent_map[i * 3 + 0] - mn) / range) * 255;
    const RAD_BINS = 32;
    const rSum = new Float32Array(RAD_BINS);
    const rCnt = new Float32Array(RAD_BINS);
    const cx = CANON_W / 2, cy = CANON_H / 2;
    const maxR = Math.hypot(cx, cy);
    for (let y = 0; y < CANON_H; y++) {
      for (let x = 0; x < CANON_W; x++) {
        const r = Math.hypot(x - cx, y - cy);
        const rb = Math.min(RAD_BINS - 1, Math.floor((r / maxR) * RAD_BINS));
        rSum[rb] += Y_norm[y * CANON_W + x];
        rCnt[rb]++;
      }
    }
    rProfForIT = new Float32Array(RAD_BINS);
    for (let i = 0; i < RAD_BINS; i++) rProfForIT[i] = rCnt[i] > 0 ? rSum[i] / rCnt[i] / 255 : 0;
  }
  // AWE-3.0.1: also build RG and BY radial for IT chromatic identity
  let rgProfForIT = null, byProfForIT = null;
  {
    const RAD_BINS = 32;
    const cx = CANON_W / 2, cy = CANON_H / 2;
    const maxR = Math.hypot(cx, cy);
    const buildRadial = (channelOffset) => {
      const raw = new Float32Array(CANON_W * CANON_H);
      let mn = Infinity, mx = -Infinity;
      for (let i = 0; i < CANON_W * CANON_H; i++) {
        const v = opponent_map[i * 3 + channelOffset];
        raw[i] = v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      const range = (mx - mn) || 1;
      const rSum = new Float32Array(RAD_BINS);
      const rCnt = new Float32Array(RAD_BINS);
      for (let y = 0; y < CANON_H; y++) {
        for (let x = 0; x < CANON_W; x++) {
          const r = Math.hypot(x - cx, y - cy);
          const rb = Math.min(RAD_BINS - 1, Math.floor((r / maxR) * RAD_BINS));
          const scaled = ((raw[y * CANON_W + x] - mn) / range) * 255;
          rSum[rb] += scaled;
          rCnt[rb]++;
        }
      }
      const prof = new Float32Array(RAD_BINS);
      for (let i = 0; i < RAD_BINS; i++) prof[i] = rCnt[i] > 0 ? rSum[i] / rCnt[i] / 255 : 0;
      return prof;
    };
    rgProfForIT = buildRadial(1);
    byProfForIT = buildRadial(2);
  }
  const it_vector = itIdentity({
    lgnFlat: lgn.flat,
    v1Summary: v1.summary,
    v2Summary: v2.summary,
    v4Summary: v4.summary,
    ilc: { rProf: rProfForIT, rgProf: rgProfForIT, byProf: byProfForIT },
    axisBundle: axis_bundle,
  });

  return {
    reflectance_map: geom.reflectance_map,
    opponent_map,
    retinal_map,
    depth_map,
    multiscale_edges,
    saliency_map,
    shape_moments,
    spectral_moments,
    preserved_luminance: geom.preserved_luminance_canonical,
    // AWE-3.1: PHOTON PRINT — the raw input photon field, preserved unaltered.
    // Fidelity metric hits 100% because this IS the input.
    photon_print: raw_photon_print,
    // AWE-3.0: PERCEPTION FIELD on INPUT GRID (illuminant-corrected R/G/B,
    // pre-Lambertian). Log-polar canonical preserves IDENTITY; this preserves
    // the eye's illuminant-adapted view of the print.
    perception_field: {
      R: refl.perception_R,
      G: refl.perception_G,
      B: refl.perception_B,
      W: refl.w, H: refl.h,
    },
    axis_bundle,
    axis_report: bundleReport(axis_bundle),
    retinal_12: retinal_12_summary,
    // AWE-3.0 visual cortex outputs
    iris: {
      aperture_gain: irisOut.aperture_gain,
      dr_stops_in: irisOut.dr_stops_in,
      dr_stops_out: irisOut.dr_stops_out,
    },
    rod: {
      W: rod.W_out, H: rod.H_out,
      saturated_frac: rod.saturated_frac,
      sensitivity_gain: rod.sensitivity_gain,
      field: rod.rod,
    },
    lgn,
    v1_summary: v1.summary,
    v2_summary: v2.summary,
    v4_summary: v4.summary,
    it_vector,
    meta: {
      camera,
      illuminant,
      geometry: geom.bbox,
      version: VERSION,
    },
  };
}

/**
 * canonicalPhotonMSE(a, b)
 * Returns a unitized non-negative scalar. 0 = identical canonical scene.
 * Uses AND of validity masks; falls back to full map if no valid overlap.
 */
export function canonicalPhotonMSE(a, b) {
  const A = a.reflectance_map, B = b.reflectance_map;
  if (A.length !== B.length) throw new Error('canonical map size mismatch');
  // AWE-1.2: Rotation-invariant MSE via best circular shift along angular axis.
  // Under log-polar remap, rotation of the input frame → circular row-shift
  // of the reflectance_map. We try all row shifts, take the minimum MSE.
  // Scale invariance is handled analogously by trying column shifts.
  // This is O(H · W) shift-tries × O(H · W) per-pixel = O((HW)^2) in the
  // worst case; for CANON=128 that's 128^4 ≈ 268M ops — cheap enough per pair.
  // In practice we prune to a small window because natural pose variation is
  // limited and full 360° rotational search is expensive.
  let bestMse = Infinity;
  const HW = CANON_W * CANON_H;
  for (let rt = 0; rt < ROT_TRIES; rt++) {
    const dy = Math.round((rt / ROT_TRIES) * CANON_H);
    for (let st = -Math.floor(SCALE_TRIES/2); st <= Math.floor(SCALE_TRIES/2); st++) {
      let sum = 0, count = 0;
      for (let cy = 0; cy < CANON_H; cy++) {
        const byRow = (cy + dy) % CANON_H;
        for (let cx = 0; cx < CANON_W; cx++) {
          const bxCol = cx + st;
          if (bxCol < 0 || bxCol >= CANON_W) continue;
          const iA = cy * CANON_W + cx;
          const iB = byRow * CANON_W + bxCol;
          const va = A[iA * 4 + 3], vb = B[iB * 4 + 3];
          if (!(va && vb)) continue;
          for (let c = 0; c < 3; c++) {
            const d = A[iA * 4 + c] - B[iB * 4 + c];
            sum += d * d;
          }
          count += 3;
        }
      }
      if (count && sum / count < bestMse) bestMse = sum / count;
    }
  }
  if (!isFinite(bestMse)) {
    // fallback: no valid overlap at any shift — use raw whole-map
    let sum = 0;
    for (let i = 0; i < HW; i++) {
      for (let c = 0; c < 3; c++) {
        const d = A[i * 4 + c] - B[i * 4 + c];
        sum += d * d;
      }
    }
    bestMse = sum / (HW * 3);
  }
  // shape + spectral MSE contributions, dimension-normalized (also invariant
  // by construction — Hu moments are rotation/scale invariant, spectral
  // moments are position-invariant)
  let mseShape = 0;
  for (let i = 0; i < a.shape_moments.length; i++) {
    const d = a.shape_moments[i] - b.shape_moments[i];
    mseShape += d * d;
  }
  mseShape /= a.shape_moments.length;
  let mseSpec = 0;
  for (let i = 0; i < a.spectral_moments.length; i++) {
    const d = a.spectral_moments[i] - b.spectral_moments[i];
    mseSpec += d * d;
  }
  mseSpec /= a.spectral_moments.length;
  // HUMAN-EQUIVALENT contributions: opponent color + retinal channels + depth.
  // These use the SAME best-shift alignment as the reflectance map.
  let mseOpp = 0, oppCount = 0;
  let mseRet = 0, retCount = 0;
  let mseDep = 0, depCount = 0;
  if (a.opponent_map && b.opponent_map && a.retinal_map && b.retinal_map) {
    const bestOpp = { sum: Infinity };
    const bestRet = { sum: Infinity };
    const bestDep = { sum: Infinity };
    for (let rt = 0; rt < ROT_TRIES; rt++) {
      const dy = Math.round((rt / ROT_TRIES) * CANON_H);
      for (let st = -Math.floor(SCALE_TRIES/2); st <= Math.floor(SCALE_TRIES/2); st++) {
        let oppSum = 0, oppN = 0, retSum = 0, retN = 0, depSum = 0, depN = 0;
        for (let cy = 0; cy < CANON_H; cy++) {
          const byRow = (cy + dy) % CANON_H;
          for (let cx = 0; cx < CANON_W; cx++) {
            const bxCol = cx + st;
            if (bxCol < 0 || bxCol >= CANON_W) continue;
            const iA = cy * CANON_W + cx;
            const iB = byRow * CANON_W + bxCol;
            for (let c = 0; c < 3; c++) {
              const d = a.opponent_map[iA * 3 + c] - b.opponent_map[iB * 3 + c];
              oppSum += d * d;
            }
            oppN += 3;
            for (let c = 0; c < 4; c++) {
              const d = a.retinal_map[iA * 4 + c] - b.retinal_map[iB * 4 + c];
              retSum += d * d;
            }
            retN += 4;
            if (a.depth_map && b.depth_map) {
              for (let c = 0; c < 3; c++) {
                const d = a.depth_map[iA * 3 + c] - b.depth_map[iB * 3 + c];
                depSum += d * d;
              }
              depN += 3;
            }
          }
        }
        if (oppN && oppSum / oppN < bestOpp.sum) bestOpp.sum = oppSum / oppN;
        if (retN && retSum / retN < bestRet.sum) bestRet.sum = retSum / retN;
        if (depN && depSum / depN < bestDep.sum) bestDep.sum = depSum / depN;
      }
    }
    mseOpp = isFinite(bestOpp.sum) ? bestOpp.sum : 0;
    mseRet = isFinite(bestRet.sum) ? bestRet.sum : 0;
    mseDep = isFinite(bestDep.sum) ? bestDep.sum : 0;
  }
  // AWE-1.6: multi-scale edges + saliency-weighted comparison.
  let mseMS = 0, mseSal = 0;
  if (a.multiscale_edges && b.multiscale_edges) {
    let s = 0;
    const N = a.multiscale_edges.length;
    for (let i = 0; i < N; i++) {
      const d = a.multiscale_edges[i] - b.multiscale_edges[i];
      s += d * d;
    }
    mseMS = s / N;
  }
  if (a.saliency_map && b.saliency_map) {
    let s = 0;
    const N = a.saliency_map.length;
    for (let i = 0; i < N; i++) {
      const d = a.saliency_map[i] - b.saliency_map[i];
      s += d * d;
    }
    mseSal = s / N;
  }
  return bestMse
       + mseShape / 13
       + mseSpec / 6
       + mseOpp        // human-equivalent color channels (LGN input)
       + mseRet        // retinal ganglion sustained channels
       + mseDep        // shape-from-shading depth cue
       + mseMS         // multi-scale edge maps (parasol + midget receptive fields)
       + mseSal;       // saliency (attention prediction)
}

export const AWE_VERSION = VERSION;
export const CANONICAL_SIZE = { W: CANON_W, H: CANON_H };
