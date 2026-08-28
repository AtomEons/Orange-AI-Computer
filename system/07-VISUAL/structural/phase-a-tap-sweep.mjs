#!/usr/bin/env bun
// phase-a-tap-sweep.mjs — full sweep across 7 axes with pilot-validated tap contract.
// Extends the two-lane pilot (spatial_color + texture) to include the 5 remaining
// questionable axes (photon_histogram, photon_correlation, color_ratio, dichromatic, hu_moments).
//
// LGN stage tap + IT-80 contribution trace are handled by separate modules (pending).

import fs from "node:fs"; import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { l2n, verdictForTap } from "./axis-tap.mjs";
import { spatialColorSummaryForRegion } from "./axes/spatial-color-axis.mjs";
import { localVariance, lbpCodes, textureSummaryForRegion } from "./axes/texture-axis.mjs";
import { phLevels, pcLevels, crLevels, dcLevels, huLevels } from "./taps/watch-lanes-taps.mjs";

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

const NOISE_SIGMA = 0.005;
const NOISE_ITERS = 3;
const REC709_R = 0.2126, REC709_G = 0.7152, REC709_B = 0.0722;

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

// Reuse the two-lane pilot's spatial_color and texture level extractors
function scLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const T0 = new Float32Array(N * 4);
  for (let i = 0; i < N; i++) {
    T0[i] = R[i]; T0[N + i] = G[i]; T0[N * 2 + i] = B[i];
    T0[N * 3 + i] = REC709_R * R[i] + REC709_G * G[i] + REC709_B * B[i];
  }
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
  const T1 = new Float32Array(27);
  for (let c = 0; c < 9; c++) { const n = cnt[c] || 1; T1[c * 3] = sumR[c] / n; T1[c * 3 + 1] = sumG[c] / n; T1[c * 3 + 2] = sumB[c] / n; }
  const pool = spatialColorSummaryForRegion(R, G, B, w, h, [0, 0, w, h]);
  const keys = Object.keys(pool).filter(k => !k.startsWith("_")).sort();
  const T2 = new Float32Array(keys.length);
  for (let i = 0; i < keys.length; i++) T2[i] = pool[keys[i]];
  return { T0, T1, T2, T3: T2 };
}

function txLevels(rgb) {
  const R = rgb.R, G = rgb.G, B = rgb.B, w = rgb.width, h = rgb.height;
  const N = w * h;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = REC709_R * R[i] + REC709_G * G[i] + REC709_B * B[i];
  const T0 = L;
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
  const T1 = new Float32Array(9 * 257);
  for (let c = 0; c < 9; c++) {
    const n = cellCount[c] || 1;
    T1[c * 257] = cellVarSum[c] / n;
    for (let b = 0; b < 256; b++) T1[c * 257 + 1 + b] = cellHist[c][b] / n;
  }
  const pool = textureSummaryForRegion(L, w, h, [0, 0, w, h]);
  const T2 = new Float32Array([pool.textureMeanVariance, pool.lbpEntropy]);
  return { T0, T1, T2, T3: T2 };
}

const AXES = {
  spatial_color: scLevels,
  texture: txLevels,
  photon_histogram: phLevels,
  photon_correlation: pcLevels,
  color_ratio: crLevels,
  dichromatic: dcLevels,
  hu_moments: huLevels,
};

const t0 = performance.now();
const sourceImages = [...new Set(PROBES.flatMap(p => [p.A, p.B]))];
const noiseFloors = new Map();

for (const src of sourceImages) {
  console.log(`  computing noise floor: ${path.basename(src)}`);
  const rgb = await extractImageRGB(src, { maxSize: 384 });
  const anchors = {};
  const noises = {};
  for (const [name, fn] of Object.entries(AXES)) {
    anchors[name] = fn(rgb);
    noises[name] = { T0: 0, T1: 0, T2: 0, T3: 0 };
  }
  for (let iter = 0; iter < NOISE_ITERS; iter++) {
    const nrgb = tinyNoise(rgb, iter);
    for (const [name, fn] of Object.entries(AXES)) {
      const nLev = fn(nrgb);
      for (const lvl of ["T0", "T1", "T2", "T3"]) noises[name][lvl] += l2n(anchors[name][lvl], nLev[lvl]);
    }
  }
  for (const name of Object.keys(AXES)) {
    for (const lvl of ["T0", "T1", "T2", "T3"]) noises[name][lvl] /= NOISE_ITERS;
  }
  noiseFloors.set(src, { anchors, noises });
}
console.log(`\nnoise floors computed for ${noiseFloors.size} sources`);

console.log("\n══ FULL SWEEP: 7 axes × 12 probes × 4 tap levels ══\n");
const results = [];
for (const probe of PROBES) {
  const nfA = noiseFloors.get(probe.A);
  const nfB = noiseFloors.get(probe.B);
  const rgbB = await extractImageRGB(probe.B, { maxSize: 384 });
  const bLevels = {};
  for (const [name, fn] of Object.entries(AXES)) bLevels[name] = fn(rgbB);

  const probeResult = { probe: probe.property, category: probe.category, axes: {} };
  for (const [name, _] of Object.entries(AXES)) {
    const levels = {};
    for (const lvl of ["T0", "T1", "T2", "T3"]) {
      const gap = l2n(nfA.anchors[name][lvl], bLevels[name][lvl]);
      const v = verdictForTap(gap, nfA.noises[name][lvl], nfB.noises[name][lvl]);
      levels[lvl] = { verdict: v.verdict, gap: v.gap, noise: v.noise, ratio: v.ratio };
    }
    let diagnosis = "ALL PRESERVED";
    if (["COLLAPSED", "COLLAPSED_CONSTANT"].includes(levels.T0.verdict)) diagnosis = "SOURCE_FAILS - extractor inadequate";
    else if (["COLLAPSED", "COLLAPSED_CONSTANT"].includes(levels.T1.verdict)) diagnosis = "LOCAL_FAILS - sampling defect";
    else if (["COLLAPSED", "COLLAPSED_CONSTANT"].includes(levels.T2.verdict)) diagnosis = "POOLED_FAILS - pooling destroys structure";
    else if (["COLLAPSED", "COLLAPSED_CONSTANT"].includes(levels.T3.verdict)) diagnosis = "AGGREGATE_FAILS - IT projection destroys";
    probeResult.axes[name] = { levels, diagnosis };
  }
  results.push(probeResult);
}

// Compact per-axis roll-up
console.log("\n══ SWEEP ROLL-UP ══");
for (const name of Object.keys(AXES)) {
  const counts = { T0: {}, T1: {}, T2: {}, T3: {} };
  const diagnoses = {};
  for (const r of results) {
    for (const lvl of ["T0", "T1", "T2", "T3"]) {
      const v = r.axes[name].levels[lvl].verdict;
      counts[lvl][v] = (counts[lvl][v] || 0) + 1;
    }
    diagnoses[r.axes[name].diagnosis] = (diagnoses[r.axes[name].diagnosis] || 0) + 1;
  }
  console.log(`\n  ${name}:`);
  for (const lvl of ["T0", "T1", "T2", "T3"]) {
    const c = counts[lvl];
    console.log(`    ${lvl}: ${Object.entries(c).map(([k, n]) => `${k}=${n}`).join(" ")}`);
  }
  for (const [d, n] of Object.entries(diagnoses)) console.log(`    ${n}× ${d}`);
}

fs.writeFileSync(path.join(OUT_DIR, "phase_a_tap_sweep.json"), JSON.stringify({
  date: "2026-07-11",
  doctrine: "GPT v4 (spine seq 112) — 7-axis sweep after two-lane pilot green (seq 113)",
  axes: Object.keys(AXES),
  noise_sigma: NOISE_SIGMA,
  probes: PROBES.length,
  results,
  duration_s: (performance.now() - t0) / 1000,
}, null, 2));
console.log(`\nwrote phase_a_tap_sweep.json  duration=${((performance.now() - t0) / 1000).toFixed(0)}s`);
