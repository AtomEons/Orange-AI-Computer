#!/usr/bin/env bun
// phase-a-tap-pilot.mjs — two-lane pilot per GPT doctrine v4 (spine seq 112).
//
// Wire spatial_color (control, Phase A 12P/0W/0C) + texture (failure, Phase A 0P/5W/7C).
// Run 12 probe pairs. Compute per-tap preservation ratio at T0/T1/T2/T3.
// Diagnose each per GPT's decision tree:
//   T0 fails         -> extractor formulation inadequate
//   T0 passes, T1 fails -> sampling/canonicalization defect
//   T1 passes, T2 fails -> pooling destroys structure
//   T2 passes, T3 fails -> aggregate/IT projection destroys structure
//
// If pilot cannot cleanly (a) reproduce spatial_color pass, and (b) localize texture failure,
// DO NOT wire the remaining 5 axes yet.

import fs from "node:fs"; import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { spatialColorTapForRegion } from "./taps/spatial-color-tap.mjs";
import { textureTapForRegion } from "./taps/texture-tap.mjs";
import { l2n, verdictForTap } from "./axis-tap.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results";
fs.mkdirSync(OUT_DIR, { recursive: true });

const bcinema = `${FIX}/baby-cinema/frames-single`;
const same = `${FIX}/same-material`;
const babylearn = `${FIX}/baby-learn`;

const PROBES = [
  { A: `${FIX}/orange.jpg`, B: `${FIX}/baboon.jpg`, property: "orange-vs-baboon", category: "wild-diff" },
  { A: `${FIX}/apple.jpg`, B: `${FIX}/baboon.jpg`, property: "apple-vs-baboon", category: "wild-diff" },
  { A: `${FIX}/orange.jpg`, B: `${FIX}/basketball1.png`, property: "orange-vs-basketball", category: "wild-diff" },
  { A: `${FIX}/orange.jpg`, B: `${FIX}/apple.jpg`, property: "orange-vs-apple", category: "cat-diff" },
  { A: `${FIX}/basketball1.png`, B: `${FIX}/basketball2.png`, property: "basketball1-vs-basketball2", category: "cat-diff" },
  { A: `${FIX}/orange.jpg`, B: `${bcinema}/orange_t1.5.png`, property: "orange-still-vs-video", category: "same-diff-src" },
  { A: `${FIX}/apple.jpg`, B: `${bcinema}/apple_t1.5.png`, property: "apple-still-vs-video", category: "same-diff-src" },
  { A: `${FIX}/orange.jpg`, B: `${same}/hue-shifted-orange-red.jpg`, property: "orange-hue-shifted-red", category: "hue-shift" },
  { A: `${FIX}/apple.jpg`, B: `${same}/hue-shifted-apple-orange.jpg`, property: "apple-hue-shifted-orange", category: "hue-shift" },
  { A: `${babylearn}/01-train-orange.png`, B: `${babylearn}/02-test-apple.png`, property: "train-orange-vs-test-apple", category: "cat-diff" },
  { A: `${babylearn}/01-train-orange.png`, B: `${babylearn}/02-test-fruits.png`, property: "train-orange-vs-fruits", category: "same-diff-src" },
  { A: `${babylearn}/01-train-orange.png`, B: `${babylearn}/02-test-lena.png`, property: "train-orange-vs-lena", category: "wild-diff" },
];

const NOISE_SIGMA = 0.005;   // sub-JND, per doctrine v3
const NOISE_ITERS = 3;

function tinyNoise(rgb, iter) {
  const out = { ...rgb, R: new Float32Array(rgb.R), G: new Float32Array(rgb.G), B: new Float32Array(rgb.B) };
  for (let i = 0; i < rgb.R.length; i++) {
    const seed = iter * rgb.R.length + i;
    const nx = Math.sin(seed * 12.9898) * 43758.5453; const n = (nx - Math.floor(nx) - 0.5) * NOISE_SIGMA;
    const ny = Math.sin(seed * 78.233) * 43758.5453;  const m = (ny - Math.floor(ny) - 0.5) * NOISE_SIGMA;
    const nz = Math.sin(seed * 37.719) * 43758.5453;  const o = (nz - Math.floor(nz) - 0.5) * NOISE_SIGMA;
    out.R[i] = Math.min(1, Math.max(0, rgb.R[i] + n));
    out.G[i] = Math.min(1, Math.max(0, rgb.G[i] + m));
    out.B[i] = Math.min(1, Math.max(0, rgb.B[i] + o));
  }
  return out;
}

function computeTapsForImage(rgb) {
  const region = [0, 0, rgb.width, rgb.height];
  return {
    spatial_color: spatialColorTapForRegion(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, region),
    texture: textureTapForRegion(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, region),
  };
}

function tapLevelData(tap, level) {
  const t = tap.taps[level];
  if (!t || !t.present) return null;
  // The raw data was consumed by buildTapLevel — we stored dataHash + shape only there.
  // But we still need actual data for l2n distance. Return the level from before buildTap.
  // Since buildTapLevel replaces data with metadata, this pilot needs access to raw arrays.
  // See separate raw store below.
  return null;
}

// To avoid buildTap swallowing the data, pilot code snapshots raw levels before wrapping.
// Simpler: rebuild taps here and keep raw refs.
function computeRawTaps(rgb) {
  const region = [0, 0, rgb.width, rgb.height];
  const sc = spatialColorTapForRegion(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, region);
  const tx = textureTapForRegion(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, region);
  return { spatial_color: sc, texture: tx };
}

// The problem: buildTap replaces data with metadata. Solution: run the individual
// tap-computation functions again but keep the numeric arrays too.
// Cleanest: fork the tap functions here to also return raw arrays.

function extractLevels(rgb, axisId, computeFn) {
  const region = [0, 0, rgb.width, rgb.height];
  const tap = computeFn(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, region);
  // We need the raw arrays back. buildTap in axis-tap.mjs stores dataHash + shape.
  // For pilot, recompute directly using axis internals — SIMPLER: change buildTapLevel to also keep data.
  return tap;
}

// ---- Since data is captured in tap.taps.<level>.dataHash + shape but NOT the actual arrays,
// we compute distances DURING tap construction. This pilot instead rebuilds the taps with a
// data-preserving variant. Simplest fix: patch axis-tap to include data by reference for pilot.

// Import a data-preserving builder by re-doing tap construction inline here.
import { spatialColorSummaryForRegion } from "./axes/spatial-color-axis.mjs";
import { localVariance, lbpCodes, textureSummaryForRegion } from "./axes/texture-axis.mjs";

const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;

function scLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  // T0: [R, G, B, L] flattened
  const t0 = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    t0[i] = R[i]; t0[N + i] = G[i]; t0[N * 2 + i] = B[i];
    t0[N * 3 + i] = REC709_R * R[i] + REC709_G * G[i] + REC709_B * B[i];
  }
  // T1: 9 cells × 3 channel means
  const cellW = w / 3, cellH = h / 3;
  const sumR = new Array(9).fill(0), sumG = new Array(9).fill(0), sumB = new Array(9).fill(0), cnt = new Array(9).fill(0);
  for (let y = 0; y < h; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const i = y * w + x;
      sumR[c] += R[i]; sumG[c] += G[i]; sumB[c] += B[i]; cnt[c]++;
    }
  }
  const t1 = new Float32Array(27);
  for (let c = 0; c < 9; c++) { const n = cnt[c] || 1; t1[c * 3] = sumR[c] / n; t1[c * 3 + 1] = sumG[c] / n; t1[c * 3 + 2] = sumB[c] / n; }
  // T2: 45 pooled scalars
  const pool = spatialColorSummaryForRegion(R, G, B, w, h, [0, 0, w, h]);
  const keys = Object.keys(pool).filter(k => !k.startsWith("_")).sort();
  const t2 = new Float32Array(keys.length);
  for (let i = 0; i < keys.length; i++) t2[i] = pool[keys[i]];
  return { T0: t0, T1: t1, T2: t2, T3: t2 };  // T3 == T2 (spatial_color unmodified by aggregate)
}

function txLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = REC709_R * R[i] + REC709_G * G[i] + REC709_B * B[i];
  const t0 = L;
  // Local: 9 cells × [meanVar, hist_0..255] = 9 × 257
  const varField = localVariance(L, w, h, 5);
  const lbp = lbpCodes(L, w, h);
  const cellW = w / 3, cellH = h / 3;
  const cellVarSum = new Array(9).fill(0), cellCount = new Array(9).fill(0);
  const cellHist = Array.from({ length: 9 }, () => new Float32Array(256));
  for (let y = 0; y < h; y++) {
    const cy = Math.min(2, Math.floor(y / cellH));
    for (let x = 0; x < w; x++) {
      const cx = Math.min(2, Math.floor(x / cellW));
      const c = cy * 3 + cx;
      const i = y * w + x;
      cellVarSum[c] += varField[i]; cellHist[c][lbp[i]]++; cellCount[c]++;
    }
  }
  const t1 = new Float32Array(9 * 257);
  for (let c = 0; c < 9; c++) {
    const n = cellCount[c] || 1;
    t1[c * 257] = cellVarSum[c] / n;
    for (let b = 0; b < 256; b++) t1[c * 257 + 1 + b] = cellHist[c][b] / n;
  }
  // T2: 2 pooled scalars
  const pool = textureSummaryForRegion(L, w, h, [0, 0, w, h]);
  const t2 = new Float32Array([pool.textureMeanVariance, pool.lbpEntropy]);
  return { T0: t0, T1: t1, T2: t2, T3: t2 };
}

// ---- pilot ----
const t0 = performance.now();

// Cache noise floors per source image
const noiseFloors = new Map();
const sourceImages = [...new Set(PROBES.flatMap(p => [p.A, p.B]))];
for (const src of sourceImages) {
  console.log(`  computing noise floor: ${path.basename(src)}`);
  const rgb = await extractImageRGB(src, { maxSize: 384 });
  const anchorSc = scLevels(rgb);
  const anchorTx = txLevels(rgb);
  const noises = { spatial_color: { T0: 0, T1: 0, T2: 0, T3: 0 }, texture: { T0: 0, T1: 0, T2: 0, T3: 0 } };
  for (let iter = 0; iter < NOISE_ITERS; iter++) {
    const nrgb = tinyNoise(rgb, iter);
    const sc = scLevels(nrgb), tx = txLevels(nrgb);
    for (const lvl of ["T0", "T1", "T2", "T3"]) {
      noises.spatial_color[lvl] += l2n(anchorSc[lvl], sc[lvl]);
      noises.texture[lvl] += l2n(anchorTx[lvl], tx[lvl]);
    }
  }
  for (const axis of ["spatial_color", "texture"]) {
    for (const lvl of ["T0", "T1", "T2", "T3"]) noises[axis][lvl] /= NOISE_ITERS;
  }
  noiseFloors.set(src, { spatial_color: { anchor: anchorSc, noise: noises.spatial_color }, texture: { anchor: anchorTx, noise: noises.texture } });
}
console.log(`\nnoise floors computed for ${noiseFloors.size} sources`);

// Run probes
console.log("\n══ TWO-LANE TAP PILOT: spatial_color (control) + texture (failure lane) ══\n");
const results = [];
for (const probe of PROBES) {
  const nfA = noiseFloors.get(probe.A);
  const nfB = noiseFloors.get(probe.B);
  const rgbB = await extractImageRGB(probe.B, { maxSize: 384 });
  const bSc = scLevels(rgbB), bTx = txLevels(rgbB);
  const probeResult = { probe: probe.property, category: probe.category, axes: {} };
  for (const [axis, refA, refB] of [
    ["spatial_color", nfA.spatial_color, { anchor: bSc, noise: nfB.spatial_color.noise }],
    ["texture",       nfA.texture,       { anchor: bTx, noise: nfB.texture.noise }],
  ]) {
    const levels = {};
    for (const lvl of ["T0", "T1", "T2", "T3"]) {
      const gap = l2n(refA.anchor[lvl], refB.anchor[lvl]);
      const v = verdictForTap(gap, refA.noise[lvl], refB.noise[lvl]);
      levels[lvl] = { verdict: v.verdict, gap: v.gap, noise: v.noise, ratio: v.ratio };
    }
    // Diagnose per GPT's decision tree
    let diagnosis = "UNRESOLVED";
    if (levels.T0.verdict === "COLLAPSED" || levels.T0.verdict === "COLLAPSED_CONSTANT") diagnosis = "SOURCE_FAILS - extractor inadequate";
    else if (levels.T1.verdict === "COLLAPSED" || levels.T1.verdict === "COLLAPSED_CONSTANT") diagnosis = "LOCAL_FAILS - sampling defect";
    else if (levels.T2.verdict === "COLLAPSED" || levels.T2.verdict === "COLLAPSED_CONSTANT") diagnosis = "POOLED_FAILS - pooling destroys structure";
    else if (levels.T3.verdict === "COLLAPSED" || levels.T3.verdict === "COLLAPSED_CONSTANT") diagnosis = "AGGREGATE_FAILS - IT projection destroys";
    else diagnosis = `ALL PRESERVED`;
    probeResult.axes[axis] = { levels, diagnosis };
    console.log(`  ${probe.property.padEnd(38)} ${axis.padEnd(15)} T0=${levels.T0.verdict.padEnd(20)} T1=${levels.T1.verdict.padEnd(20)} T2=${levels.T2.verdict.padEnd(20)} T3=${levels.T3.verdict.padEnd(20)}  ${diagnosis}`);
  }
  results.push(probeResult);
}

// Roll-up
console.log("\n══ PILOT ROLL-UP ══");
for (const axis of ["spatial_color", "texture"]) {
  const counts = { T0: {}, T1: {}, T2: {}, T3: {} };
  for (const r of results) {
    for (const lvl of ["T0", "T1", "T2", "T3"]) {
      const v = r.axes[axis].levels[lvl].verdict;
      counts[lvl][v] = (counts[lvl][v] || 0) + 1;
    }
  }
  console.log(`\n  ${axis}:`);
  for (const lvl of ["T0", "T1", "T2", "T3"]) {
    const c = counts[lvl];
    console.log(`    ${lvl}: ${Object.entries(c).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  }
  const diagnoses = {};
  for (const r of results) {
    const d = r.axes[axis].diagnosis;
    diagnoses[d] = (diagnoses[d] || 0) + 1;
  }
  console.log(`    diagnoses:`);
  for (const [d, n] of Object.entries(diagnoses)) console.log(`      ${n}× ${d}`);
}

fs.writeFileSync(path.join(OUT_DIR, "phase_a_tap_pilot.json"), JSON.stringify({
  date: "2026-07-11",
  doctrine: "GPT v4 (spine seq 112)",
  axes: ["spatial_color", "texture"],
  noise_sigma: NOISE_SIGMA,
  noise_iters: NOISE_ITERS,
  probes: PROBES.length,
  results,
  duration_s: (performance.now() - t0) / 1000,
}, null, 2));
console.log(`\nwrote phase_a_tap_pilot.json  duration=${((performance.now() - t0) / 1000).toFixed(0)}s`);
