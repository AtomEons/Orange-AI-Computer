#!/usr/bin/env bun
// phase-a-capture-conservation.mjs — GPT doctrine (spine seq 103) Phase A probe.
//
// Question: does each stage of the AWE-3 pipeline PRESERVE distinctions a normally-sighted human
// could make, or does any stage COLLAPSE those distinctions?
//
// Method:
//   For each probe pair (A, B) where A and B are human-distinguishable:
//     stage_gap[k] = ||stage_output_k(A) − stage_output_k(B)||
//   For each stage:
//     noise_floor[k] = ||stage_output_k(A) − stage_output_k(A + tiny_noise)||
//   Verdict per stage per pair:
//     PRESERVED if stage_gap > 3 * noise_floor
//     WEAK      if stage_gap > 1 * noise_floor
//     COLLAPSED if stage_gap ≤ noise_floor
//
// This CANNOT be answered by recognition math. It is a direct probe.

import fs from "node:fs"; import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results";
fs.mkdirSync(OUT_DIR, { recursive: true });

// Probe pairs — each pair is (A, B, human-distinguishable-property-name)
const PROBES = [
  { A: `${FIX}/orange.jpg`,                                 B: `${FIX}/apple.jpg`,                                property: "different-fruit-similar-shape-color" },
  { A: `${FIX}/orange.jpg`,                                 B: `${FIX}/baby-cinema/frames-single/orange_t1.5.png`, property: "same-orange-different-source-frame" },
  { A: `${FIX}/orange.jpg`,                                 B: `${FIX}/same-material/hue-shifted-orange-red.jpg`, property: "same-material-hue-shifted" },
  { A: `${FIX}/orange.jpg`,                                 B: `${FIX}/basketball1.png`,                          property: "orange-vs-basketball-similar-color-different-texture" },
  { A: `${FIX}/apple.jpg`,                                  B: `${FIX}/baboon.jpg`,                               property: "apple-vs-baboon-very-different" },
];

function toRegion(rgb) { return { x: 0, y: 0, w: rgb.width, h: rgb.height }; }

// Add tiny noise for noise-floor estimate — a perturbation invisible to humans
function tinyNoise(rgb, sigma = 1.0) {
  const R = new Float32Array(rgb.R), G = new Float32Array(rgb.G), B = new Float32Array(rgb.B);
  const N = R.length;
  function box(seed) {
    let s = 0;
    for (let i = 0; i < 3; i++) { const x = Math.sin(seed + i * 137.5) * 43758.5453; s += x - Math.floor(x); }
    return (s - 1.5) * sigma;
  }
  for (let i = 0; i < N; i++) {
    R[i] = Math.min(255, Math.max(0, R[i] + box(i * 3.1)));
    G[i] = Math.min(255, Math.max(0, G[i] + box(i * 3.1 + 1)));
    B[i] = Math.min(255, Math.max(0, B[i] + box(i * 3.1 + 2)));
  }
  return { ...rgb, R, G, B, width: rgb.width, height: rgb.height };
}

// Extract stage outputs as flat Float32Array — one per stage, ordered
function stageOutputs(can) {
  const out = {};
  // Retinal-12 summary (12 dims)
  if (can.retinal_12) {
    const r12 = [];
    for (const k of Object.keys(can.retinal_12).sort()) {
      const v = can.retinal_12[k];
      if (typeof v === "number" && Number.isFinite(v)) r12.push(v);
    }
    out.retinal_12 = new Float32Array(r12);
  }
  // LGN parvo/magno/konio (~13 dims)
  if (can.lgn) {
    const lgn = [];
    for (const sub of ["parvo", "magno", "konio"]) {
      const s = can.lgn[sub];
      if (!s) continue;
      for (const k of Object.keys(s).sort()) {
        const v = s[k];
        if (typeof v === "number" && Number.isFinite(v)) lgn.push(v);
      }
    }
    out.lgn = new Float32Array(lgn);
  }
  // V1 — flatten sig if present
  if (can.v1) {
    const v1 = [];
    for (const k of Object.keys(can.v1).sort()) {
      const v = can.v1[k];
      if (typeof v === "number" && Number.isFinite(v)) v1.push(v);
      else if (Array.isArray(v) || v instanceof Float32Array) for (const x of v) if (Number.isFinite(x)) v1.push(x);
    }
    out.v1 = new Float32Array(v1);
  }
  // V2
  if (can.v2) {
    const v2 = [];
    for (const k of Object.keys(can.v2).sort()) {
      const v = can.v2[k];
      if (typeof v === "number" && Number.isFinite(v)) v2.push(v);
      else if (Array.isArray(v) || v instanceof Float32Array) for (const x of v) if (Number.isFinite(x)) v2.push(x);
    }
    out.v2 = new Float32Array(v2);
  }
  // V4
  if (can.v4) {
    const v4 = [];
    for (const k of Object.keys(can.v4).sort()) {
      const v = can.v4[k];
      if (typeof v === "number" && Number.isFinite(v)) v4.push(v);
      else if (Array.isArray(v) || v instanceof Float32Array) for (const x of v) if (Number.isFinite(x)) v4.push(x);
    }
    out.v4 = new Float32Array(v4);
  }
  // IT-80
  if (can.it_vector) out.it_80 = new Float32Array(can.it_vector);
  // Axis-bundle scalars (162 dims)
  if (can.axis_bundle) {
    const ax = [];
    const AX_ORDER = ["radial_photon","photon_histogram","photon_correlation","subsurface","spatial_color","color_ratio","texture_vocab","hu_moments","persistent_homology","dichromatic","fourier_mellin","texture","edge","specular","spatial_frequency"];
    for (const aname of AX_ORDER) {
      const a = can.axis_bundle[aname];
      if (!a || a._error) continue;
      for (const k of Object.keys(a).filter(x => !x.startsWith("_")).sort()) {
        const v = a[k];
        if (typeof v === "number" && Number.isFinite(v)) ax.push(v);
      }
    }
    out.axis_bundle = new Float32Array(ax);
  }
  return out;
}

// L2 distance between two Float32Arrays
function l2(a, b) {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

// L2-normalized L2 distance (cosine-flavored, invariant to overall scale)
function l2n(a, b) {
  const n = Math.min(a.length, b.length);
  let na = 0, nb = 0;
  for (let i = 0; i < n; i++) { na += a[i] ** 2; nb += b[i] ** 2; }
  na = Math.sqrt(na) || 1; nb = Math.sqrt(nb) || 1;
  let s = 0;
  for (let i = 0; i < n; i++) s += (a[i] / na - b[i] / nb) ** 2;
  return Math.sqrt(s);
}

const results = [];
const t0 = performance.now();

for (const probe of PROBES) {
  console.log(`\n══ PROBE: ${probe.property} ══`);
  console.log(`  A: ${path.basename(probe.A)}`);
  console.log(`  B: ${path.basename(probe.B)}`);

  let rgbA, rgbB;
  try { rgbA = await extractImageRGB(probe.A, { maxSize: 384 }); }
  catch (e) { console.log(`  SKIP: A load failed ${e.message}`); continue; }
  try { rgbB = await extractImageRGB(probe.B, { maxSize: 384 }); }
  catch (e) { console.log(`  SKIP: B load failed ${e.message}`); continue; }

  const canA = captureCanonicalPhoton(rgbA, toRegion(rgbA));
  const canB = captureCanonicalPhoton(rgbB, toRegion(rgbB));
  const rgbAnoise = tinyNoise(rgbA, 1.0);
  const canAnoise = captureCanonicalPhoton(rgbAnoise, toRegion(rgbAnoise));

  const soA = stageOutputs(canA);
  const soB = stageOutputs(canB);
  const soAn = stageOutputs(canAnoise);

  const stages = Object.keys(soA);
  const probeResult = { probe: probe.property, A: path.basename(probe.A), B: path.basename(probe.B), stages: {} };

  for (const stage of stages) {
    if (!soB[stage] || !soAn[stage]) continue;
    const gap = l2n(soA[stage], soB[stage]);
    const noise = l2n(soA[stage], soAn[stage]);
    const ratio = noise > 0 ? gap / noise : Infinity;
    const verdict = ratio >= 3 ? "PRESERVED" : ratio >= 1 ? "WEAK" : "COLLAPSED";
    console.log(`  ${stage.padEnd(15)}: gap=${gap.toFixed(4)} noise=${noise.toFixed(4)} ratio=${ratio.toFixed(2)}x  ${verdict}`);
    probeResult.stages[stage] = { gap, noise, ratio, verdict, dim: soA[stage].length };
  }
  results.push(probeResult);
}

const outFile = path.join(OUT_DIR, "phase_a_capture_conservation.json");
fs.writeFileSync(outFile, JSON.stringify({
  date: "2026-07-11",
  doctrine: "AEYES1_GPT_DOCTRINE_2026-07-11.md (spine seq 103)",
  probes: PROBES.map(p => ({ A: path.basename(p.A), B: path.basename(p.B), property: p.property })),
  results,
  duration_s: (performance.now() - t0) / 1000,
}, null, 2));

// Verdict roll-up: any stage that COLLAPSES on any pair is a leak
console.log("\n══ PHASE A ROLL-UP ══");
const stageVerdicts = new Map();
for (const r of results) {
  for (const [stage, s] of Object.entries(r.stages)) {
    if (!stageVerdicts.has(stage)) stageVerdicts.set(stage, []);
    stageVerdicts.get(stage).push({ probe: r.probe, verdict: s.verdict, ratio: s.ratio });
  }
}
for (const [stage, arr] of stageVerdicts) {
  const collapsed = arr.filter(x => x.verdict === "COLLAPSED").length;
  const weak = arr.filter(x => x.verdict === "WEAK").length;
  const preserved = arr.filter(x => x.verdict === "PRESERVED").length;
  const minR = Math.min(...arr.map(x => x.ratio));
  console.log(`  ${stage.padEnd(15)}: ${preserved}P / ${weak}W / ${collapsed}C   min-ratio=${minR.toFixed(2)}x   ${collapsed > 0 ? "LEAK CANDIDATE" : (weak > 0 ? "WATCH" : "OK")}`);
}
console.log(`\nwrote ${outFile}  duration=${((performance.now() - t0) / 1000).toFixed(0)}s`);
