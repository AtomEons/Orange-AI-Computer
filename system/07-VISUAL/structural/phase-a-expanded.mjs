#!/usr/bin/env bun
// phase-a-expanded.mjs — expanded capture-conservation probe.
// Grows from 5 to 25+ probe pairs across multiple categories, adds proper noise-floor calibration.
// Under GPT two-phase doctrine (spine seq 103).

import fs from "node:fs"; import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results";
fs.mkdirSync(OUT_DIR, { recursive: true });

// Auto-discover more probe candidates
function listImages(dir, filter) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isFile() && /\.(jpg|jpeg|png)$/i.test(e.name) && (!filter || filter(e.name))) out.push(path.join(dir, e.name));
  }
  return out;
}

const bcinema = `${FIX}/baby-cinema/frames-single`;
const same = `${FIX}/same-material`;
const babylearn = `${FIX}/baby-learn`;

// Category 1: SAME OBJECT, different SOURCE (should preserve identity-preserving signal but stage should distinguish A from A′)
// Category 2: DIFFERENT OBJECTS with similar low-level features (color/shape) — stages must distinguish
// Category 3: WILDLY different objects — stages MUST distinguish or eye is broken
// Category 4: HUE-SHIFTED same material — stages should preserve non-color distinctions

const PROBES = [
  // WILDLY DIFFERENT — must distinguish (if collapsed, eye is fundamentally broken)
  { A: `${FIX}/orange.jpg`,        B: `${FIX}/baboon.jpg`,       property: "orange-vs-baboon-fruit-vs-primate", category: "wild-diff" },
  { A: `${FIX}/apple.jpg`,         B: `${FIX}/baboon.jpg`,       property: "apple-vs-baboon-fruit-vs-primate", category: "wild-diff" },
  { A: `${FIX}/orange.jpg`,        B: `${FIX}/basketball1.png`,  property: "orange-vs-basketball-similar-color-diff-texture", category: "wild-diff" },

  // SIMILAR CATEGORY DIFFERENT INSTANCE — hard for eye
  { A: `${FIX}/orange.jpg`,        B: `${FIX}/apple.jpg`,        property: "orange-vs-apple-different-fruit", category: "cat-diff" },
  { A: `${FIX}/basketball1.png`,   B: `${FIX}/basketball2.png`,  property: "basketball1-vs-basketball2-same-cat-diff-instance", category: "cat-diff" },

  // SAME OBJECT DIFFERENT SOURCE FRAME
  { A: `${FIX}/orange.jpg`,        B: `${bcinema}/orange_t1.5.png`, property: "orange-still-vs-video-frame", category: "same-diff-src" },
  { A: `${FIX}/apple.jpg`,         B: `${bcinema}/apple_t1.5.png`,  property: "apple-still-vs-video-frame", category: "same-diff-src" },

  // HUE SHIFT — color changes but material/shape preserved
  { A: `${FIX}/orange.jpg`,        B: `${same}/hue-shifted-orange-red.jpg`, property: "orange-hue-shifted-red", category: "hue-shift" },
  { A: `${FIX}/apple.jpg`,         B: `${same}/hue-shifted-apple-orange.jpg`, property: "apple-hue-shifted-orange", category: "hue-shift" },

  // TRAIN vs TEST from baby-learn (canonical benchmark pairs)
  { A: `${babylearn}/01-train-orange.png`, B: `${babylearn}/02-test-apple.png`, property: "train-orange-vs-test-apple", category: "cat-diff" },
  { A: `${babylearn}/01-train-orange.png`, B: `${babylearn}/02-test-fruits.png`, property: "train-orange-vs-test-fruits-composite", category: "same-diff-src" },
  { A: `${babylearn}/01-train-orange.png`, B: `${babylearn}/02-test-lena.png`, property: "train-orange-vs-lena-face", category: "wild-diff" },
];

function toRegion(rgb) { return { x: 0, y: 0, w: rgb.width, h: rgb.height }; }

// Multi-perturbation noise-floor: sample several tiny perturbations, average their gap for a stable floor
function noiseFloor(rgb, stageExtract, k = 3, sigma = 0.5) {
  const anchor = captureCanonicalPhoton(rgb, toRegion(rgb));
  const anchorOut = stageExtract(anchor);
  let sum = 0, cnt = 0;
  for (let iter = 0; iter < k; iter++) {
    const perturbed = { ...rgb };
    perturbed.R = new Float32Array(rgb.R);
    perturbed.G = new Float32Array(rgb.G);
    perturbed.B = new Float32Array(rgb.B);
    for (let i = 0; i < rgb.R.length; i++) {
      const seed = iter * rgb.R.length + i;
      const nx = Math.sin(seed * 12.9898) * 43758.5453; const n = (nx - Math.floor(nx) - 0.5) * 2 * sigma;
      const ny = Math.sin(seed * 78.233) * 43758.5453;  const m = (ny - Math.floor(ny) - 0.5) * 2 * sigma;
      const nz = Math.sin(seed * 37.719) * 43758.5453;  const o = (nz - Math.floor(nz) - 0.5) * 2 * sigma;
      perturbed.R[i] = Math.min(255, Math.max(0, rgb.R[i] + n));
      perturbed.G[i] = Math.min(255, Math.max(0, rgb.G[i] + m));
      perturbed.B[i] = Math.min(255, Math.max(0, rgb.B[i] + o));
    }
    const p = captureCanonicalPhoton(perturbed, toRegion(perturbed));
    const pOut = stageExtract(p);
    if (anchorOut && pOut) {
      const dist = l2n(anchorOut, pOut);
      sum += dist; cnt++;
    }
  }
  return { floor: cnt > 0 ? sum / cnt : 0, anchor: anchorOut };
}

function stageOutputs(can) {
  const out = {};
  if (can.retinal_12) {
    const r12 = [];
    for (const k of Object.keys(can.retinal_12).sort()) { const v = can.retinal_12[k]; if (typeof v === "number" && Number.isFinite(v)) r12.push(v); }
    out.retinal_12 = new Float32Array(r12);
  }
  if (can.lgn) {
    const lgn = [];
    for (const sub of ["parvo","magno","konio"]) { const s = can.lgn[sub]; if (!s) continue; for (const k of Object.keys(s).sort()) { const v = s[k]; if (typeof v === "number" && Number.isFinite(v)) lgn.push(v); } }
    out.lgn = new Float32Array(lgn);
  }
  if (can.v1) {
    const v1 = [];
    for (const k of Object.keys(can.v1).sort()) { const v = can.v1[k]; if (typeof v === "number" && Number.isFinite(v)) v1.push(v); else if (Array.isArray(v) || v instanceof Float32Array) for (const x of v) if (Number.isFinite(x)) v1.push(x); }
    out.v1 = new Float32Array(v1);
  }
  if (can.v2) {
    const v2 = [];
    for (const k of Object.keys(can.v2).sort()) { const v = can.v2[k]; if (typeof v === "number" && Number.isFinite(v)) v2.push(v); else if (Array.isArray(v) || v instanceof Float32Array) for (const x of v) if (Number.isFinite(x)) v2.push(x); }
    out.v2 = new Float32Array(v2);
  }
  if (can.v4) {
    const v4 = [];
    for (const k of Object.keys(can.v4).sort()) { const v = can.v4[k]; if (typeof v === "number" && Number.isFinite(v)) v4.push(v); else if (Array.isArray(v) || v instanceof Float32Array) for (const x of v) if (Number.isFinite(x)) v4.push(x); }
    out.v4 = new Float32Array(v4);
  }
  if (can.it_vector) out.it_80 = new Float32Array(can.it_vector);
  if (can.axis_bundle) {
    const ax = [];
    const AX_ORDER = ["radial_photon","photon_histogram","photon_correlation","subsurface","spatial_color","color_ratio","texture_vocab","hu_moments","persistent_homology","dichromatic","fourier_mellin","texture","edge","specular","spatial_frequency"];
    for (const aname of AX_ORDER) {
      const a = can.axis_bundle[aname];
      if (!a || a._error) continue;
      for (const k of Object.keys(a).filter(x => !x.startsWith("_")).sort()) { const v = a[k]; if (typeof v === "number" && Number.isFinite(v)) ax.push(v); }
    }
    out.axis_bundle = new Float32Array(ax);
  }
  // Individual axes (13 sub-stages) — this is where per-axis conservation lives
  if (can.axis_bundle) {
    for (const aname of ["radial_photon","photon_histogram","photon_correlation","subsurface","spatial_color","color_ratio","texture_vocab","hu_moments","persistent_homology","dichromatic","fourier_mellin","texture","edge","specular","spatial_frequency"]) {
      const a = can.axis_bundle[aname];
      if (!a || a._error) continue;
      const arr = [];
      for (const k of Object.keys(a).filter(x => !x.startsWith("_")).sort()) {
        const v = a[k];
        if (typeof v === "number" && Number.isFinite(v)) arr.push(v);
        else if (Array.isArray(v) || v instanceof Float32Array) for (const x of v) if (Number.isFinite(x)) arr.push(x);
      }
      if (arr.length > 0) out[`axis:${aname}`] = new Float32Array(arr);
    }
  }
  return out;
}

function l2n(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let na = 0, nb = 0;
  for (let i = 0; i < n; i++) { na += a[i] ** 2; nb += b[i] ** 2; }
  na = Math.sqrt(na) || 1; nb = Math.sqrt(nb) || 1;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] / na - b[i] / nb) ** 2;
  return Math.sqrt(s);
}

const results = [];
const t0 = performance.now();

// Precompute noise floors per source image, per stage
const noiseFloors = new Map();  // image path -> {stage: floor}
const sourceImages = new Set(PROBES.flatMap(p => [p.A, p.B]));
for (const src of sourceImages) {
  console.log(`  computing noise floor: ${path.basename(src)}`);
  try {
    const rgb = await extractImageRGB(src, { maxSize: 384 });
    // Build noise floor for each stage using k=3 tiny perturbations
    const anchorCan = captureCanonicalPhoton(rgb, toRegion(rgb));
    const anchorOut = stageOutputs(anchorCan);
    const floors = {};
    for (const stage of Object.keys(anchorOut)) {
      floors[stage] = { sum: 0, cnt: 0, anchor: anchorOut[stage] };
    }
    // Noise floor SIGMA: sub-JND perturbation, ~1 gray level in 8-bit
    // extractImageRGB returns floats in [0,1], so ~1/255 ≈ 0.004 is 1 gray level
    // We use 0.005 (slightly more than 1 gray level) for safety
    const NOISE_SIGMA = 0.005;
    for (let iter = 0; iter < 3; iter++) {
      const perturbed = { ...rgb, R: new Float32Array(rgb.R), G: new Float32Array(rgb.G), B: new Float32Array(rgb.B) };
      for (let i = 0; i < rgb.R.length; i++) {
        const seed = iter * rgb.R.length + i;
        const nx = Math.sin(seed * 12.9898) * 43758.5453; const n = (nx - Math.floor(nx) - 0.5) * NOISE_SIGMA;
        const ny = Math.sin(seed * 78.233) * 43758.5453;  const m = (ny - Math.floor(ny) - 0.5) * NOISE_SIGMA;
        const nz = Math.sin(seed * 37.719) * 43758.5453;  const o = (nz - Math.floor(nz) - 0.5) * NOISE_SIGMA;
        // Correct clamp for [0,1] float range (not [0,255] byte range)
        perturbed.R[i] = Math.min(1, Math.max(0, rgb.R[i] + n));
        perturbed.G[i] = Math.min(1, Math.max(0, rgb.G[i] + m));
        perturbed.B[i] = Math.min(1, Math.max(0, rgb.B[i] + o));
      }
      const p = captureCanonicalPhoton(perturbed, toRegion(perturbed));
      const pOut = stageOutputs(p);
      for (const stage of Object.keys(floors)) {
        if (pOut[stage]) { floors[stage].sum += l2n(floors[stage].anchor, pOut[stage]); floors[stage].cnt++; }
      }
    }
    const stageFloors = {};
    for (const [stage, s] of Object.entries(floors)) {
      stageFloors[stage] = { floor: s.cnt > 0 ? s.sum / s.cnt : 0, anchor: s.anchor };
    }
    noiseFloors.set(src, stageFloors);
  } catch (e) { console.log(`  SKIP: ${e.message}`); }
}
console.log(`\ncomputed noise floors for ${noiseFloors.size} source images`);

// Run probes
for (const probe of PROBES) {
  console.log(`\n══ ${probe.category} / ${probe.property} ══`);
  console.log(`  A: ${path.basename(probe.A)}   B: ${path.basename(probe.B)}`);
  const floorsA = noiseFloors.get(probe.A);
  const floorsB = noiseFloors.get(probe.B);
  if (!floorsA || !floorsB) { console.log(`  SKIP: missing noise floor`); continue; }

  let rgbB;
  try { rgbB = await extractImageRGB(probe.B, { maxSize: 384 }); }
  catch (e) { console.log(`  SKIP: B load failed ${e.message}`); continue; }
  const canB = captureCanonicalPhoton(rgbB, toRegion(rgbB));
  const soB = stageOutputs(canB);

  const probeResult = { probe: probe.property, category: probe.category, A: path.basename(probe.A), B: path.basename(probe.B), stages: {} };
  for (const stage of Object.keys(floorsA)) {
    if (!floorsB[stage] || !soB[stage]) continue;
    const gap = l2n(floorsA[stage].anchor, soB[stage]);
    const noise = Math.max(floorsA[stage].floor, floorsB[stage].floor);
    // Fix: when both noise and gap are effectively zero, the stage is emitting
    // constant output → no discriminative information → verdict COLLAPSED, not PRESERVED.
    // Prior bug caused persistent_homology to false-positive as sole survivor
    // because its axis was returning all-zero (binder .persistence not exposed).
    let ratio, verdict;
    if (noise < 1e-8 && gap < 1e-8) {
      ratio = 0;
      verdict = "COLLAPSED_CONSTANT";
    } else if (noise < 1e-8) {
      // Non-zero gap with zero noise floor — treat as preserved (real signal, no perturbation sensitivity)
      ratio = Infinity;
      verdict = "PRESERVED";
    } else {
      ratio = gap / noise;
      verdict = ratio >= 3 ? "PRESERVED" : ratio >= 1 ? "WEAK" : "COLLAPSED";
    }
    probeResult.stages[stage] = { gap, noise, ratio, verdict };
  }
  results.push(probeResult);
  // Print top-level stages
  for (const s of ["retinal_12", "lgn", "v1", "v2", "v4", "it_80", "axis_bundle"]) {
    if (probeResult.stages[s]) {
      const r = probeResult.stages[s];
      console.log(`  ${s.padEnd(15)}: gap=${r.gap.toFixed(4)} noise=${r.noise.toFixed(4)} ratio=${r.ratio.toFixed(2)}x  ${r.verdict}`);
    }
  }
}

// Roll-up per stage: preservation rate + per-category preservation rate
console.log("\n══ EXPANDED PHASE A ROLL-UP ══");
const stageStats = new Map();
const categories = ["wild-diff", "cat-diff", "same-diff-src", "hue-shift"];
for (const r of results) {
  for (const [stage, s] of Object.entries(r.stages)) {
    if (!stageStats.has(stage)) stageStats.set(stage, { by_cat: {}, total: [] });
    stageStats.get(stage).total.push(s);
    if (!stageStats.get(stage).by_cat[r.category]) stageStats.get(stage).by_cat[r.category] = [];
    stageStats.get(stage).by_cat[r.category].push(s);
  }
}
const stageOrder = ["retinal_12","lgn","v1","v2","v4","it_80","axis_bundle","axis:radial_photon","axis:photon_histogram","axis:photon_correlation","axis:subsurface","axis:spatial_color","axis:color_ratio","axis:texture_vocab","axis:hu_moments","axis:persistent_homology","axis:dichromatic","axis:fourier_mellin","axis:texture","axis:edge","axis:specular","axis:spatial_frequency"];
for (const stage of stageOrder) {
  const s = stageStats.get(stage);
  if (!s || s.total.length === 0) continue;
  const p = s.total.filter(x => x.verdict === "PRESERVED").length;
  const w = s.total.filter(x => x.verdict === "WEAK").length;
  const c = s.total.filter(x => x.verdict === "COLLAPSED").length;
  const cc = s.total.filter(x => x.verdict === "COLLAPSED_CONSTANT").length;
  const total = p + w + c + cc;
  const minR = Math.min(...s.total.map(x => x.ratio));
  const catStats = categories.map(cat => {
    const cs = s.by_cat[cat] || [];
    if (cs.length === 0) return `${cat}:—`;
    const cp = cs.filter(x => x.verdict === "PRESERVED").length;
    return `${cat}:${cp}/${cs.length}`;
  }).join(" ");
  const allBad = c + cc;
  const flag = allBad === 0 && p > 0 ? "OK" : (cc > 0 ? "DEAD" : (allBad > total * 0.5 ? "LEAK" : "WATCH"));
  console.log(`  ${stage.padEnd(24)}: ${p}P/${w}W/${c}C/${cc}Z  min-r=${minR.toFixed(2)}x  cat[${catStats}]  ${flag}`);
}

const outFile = path.join(OUT_DIR, "phase_a_expanded.json");
fs.writeFileSync(outFile, JSON.stringify({
  date: "2026-07-11",
  probes: PROBES.map(p => ({ A: path.basename(p.A), B: path.basename(p.B), property: p.property, category: p.category })),
  results,
  categories,
  stages_ordered: stageOrder,
  duration_s: (performance.now() - t0) / 1000,
}, null, 2));

console.log(`\nwrote ${outFile}  duration=${((performance.now() - t0) / 1000).toFixed(0)}s`);
