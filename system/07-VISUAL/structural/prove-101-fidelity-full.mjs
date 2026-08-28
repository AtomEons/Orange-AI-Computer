#!/usr/bin/env bun
// prove-101-fidelity-full.mjs — everything the eye produces, catalogued.
//
// The 854% figure only counted 15 canonical fields. The eye's output is much
// richer — every axis-bundle scalar, every V1 orientation channel, every
// retinal-12 field, LGN sub-streams, V4 shape descriptors, IT identity vector,
// axis coefficients (162 scalars), shape/spectral moments, iris/rod/camera
// state, illuminant estimate. This enumerates everything.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton, CANON_W, CANON_H } from "./photon-canonical.mjs";
import { compute12Channels } from "./retinal-12.mjs";
import { v1Response } from "./eye/v1-orientation.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/photon-print-101";
fs.mkdirSync(OUT, { recursive: true });

const PHOTOS = [
  { name: "lena", path: `${FIX}/lena.jpg` },
  { name: "baboon", path: `${FIX}/baboon.jpg` },
  { name: "orange", path: `${FIX}/orange.jpg` },
];

function shannonEntropy(values, bins) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v; if (v > mx) mx = v;
  }
  const range = (mx - mn) || 1;
  const hist = new Uint32Array(bins);
  let n = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v)) continue;
    const b = Math.max(0, Math.min(bins - 1, Math.floor((v - mn) / range * bins)));
    hist[b]++; n++;
  }
  if (n === 0) return 0;
  let H = 0;
  for (let i = 0; i < bins; i++) {
    if (hist[i] === 0) continue;
    const p = hist[i] / n;
    H -= p * Math.log2(p);
  }
  return H;
}

function scalarEntropyEstimate(scalars) {
  // For a set of scalars, treat as float values and compute entropy at 256 bins.
  if (scalars.length === 0) return 0;
  return shannonEntropy(new Float32Array(scalars), 256);
}

function luminance(R, G, B) {
  const N = R.length;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.2126 * R[i] + 0.7152 * G[i] + 0.0722 * B[i];
  return L;
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  101% — FULL CATALOG of what the eye's canonical carries  ║");
console.log("╚══════════════════════════════════════════════════════════╝");

const category_totals = { fields: 0, scalars: 0, extra_fields: 0, extra_scalars: 0 };
const rows = [];

for (const p of PHOTOS) {
  if (!fs.existsSync(p.path)) continue;
  const rgb = await extractImageRGB(p.path, { maxSize: 192 });
  const in_L = luminance(rgb.R, rgb.G, rgb.B);
  const input_entropy = shannonEntropy(in_L, 256);

  const can = captureCanonicalPhoton(rgb, { x: 0, y: 0, w: rgb.width, h: rgb.height });
  const CN = CANON_W * CANON_H;

  const buckets = [];

  // ─── 1) Original 15 fields (baseline) ─────────
  const orig = 0;
  let origH = 0;
  const oY = new Float32Array(CN), oRG = new Float32Array(CN), oBY = new Float32Array(CN);
  for (let i = 0; i < CN; i++) {
    oY[i] = can.opponent_map[i * 3 + 0];
    oRG[i] = can.opponent_map[i * 3 + 1];
    oBY[i] = can.opponent_map[i * 3 + 2];
  }
  origH += shannonEntropy(oY, 256) + shannonEntropy(oRG, 256) + shannonEntropy(oBY, 256);
  for (let c = 0; c < 4; c++) {
    const F = new Float32Array(CN);
    for (let i = 0; i < CN; i++) F[i] = can.retinal_map[i * 4 + c];
    origH += shannonEntropy(F, 256);
  }
  for (let c = 0; c < 3; c++) {
    const F = new Float32Array(CN);
    for (let i = 0; i < CN; i++) F[i] = can.depth_map[i * 3 + c];
    origH += shannonEntropy(F, 256);
  }
  for (let c = 0; c < 3; c++) {
    const F = new Float32Array(CN);
    for (let i = 0; i < CN; i++) F[i] = can.multiscale_edges[i * 3 + c];
    origH += shannonEntropy(F, 256);
  }
  origH += shannonEntropy(can.saliency_map, 256);
  origH += shannonEntropy(can.preserved_luminance, 256);
  buckets.push({ category: "orig-15-fields", count: 15, entropy: origH });

  // ─── 2) Reflectance map (3 body chromaticity channels + valid mask) ─────
  let refH = 0;
  for (let c = 0; c < 4; c++) {
    const F = new Float32Array(CN);
    for (let i = 0; i < CN; i++) F[i] = can.reflectance_map[i * 4 + c];
    refH += shannonEntropy(F, 256);
  }
  buckets.push({ category: "reflectance-4-channels", count: 4, entropy: refH });

  // ─── 3) V1 orientation-scale fields (24 channels) ─────
  const perceptLum = can.preserved_luminance || oY;
  const v1 = v1Response(perceptLum, CANON_W, CANON_H);
  let v1H = 0;
  for (const f of v1.fields) v1H += shannonEntropy(f.field, 256);
  buckets.push({ category: "V1-24-orientation-fields", count: v1.fields.length, entropy: v1H });

  // ─── 4) Retinal-12 spatial fields (12 channel maps) ─────
  const lin_frame = {
    R: new Float32Array(rgb.R.length),
    G: new Float32Array(rgb.G.length),
    B: new Float32Array(rgb.B.length),
    width: rgb.width, height: rgb.height,
  };
  for (let i = 0; i < rgb.R.length; i++) {
    lin_frame.R[i] = rgb.R[i] / 255;
    lin_frame.G[i] = rgb.G[i] / 255;
    lin_frame.B[i] = rgb.B[i] / 255;
  }
  const r12 = compute12Channels(lin_frame, lin_frame, {}, {});
  let r12H = 0;
  const r12Keys = ["ch1_onSustained", "ch2_offSustained", "ch3_onTransient", "ch4_offTransient",
                   "ch5_up", "ch6_down", "ch7_right", "ch8_left",
                   "ch9_localEdge", "ch10_objectMotion", "ch11_uniformity", "ch12_sustainedDS"];
  for (const k of r12Keys) if (r12[k]) r12H += shannonEntropy(r12[k], 256);
  buckets.push({ category: "retinal-12-fields", count: 12, entropy: r12H });

  // ─── 5) Rod field ─────
  let rodH = 0;
  if (can.rod && can.rod.field) rodH = shannonEntropy(can.rod.field, 256);
  buckets.push({ category: "rod-scotopic-field", count: 1, entropy: rodH });

  // ─── 6) All axis-bundle scalars (15 axes, ~162 scalars) ─────
  let axisH = 0;
  let axisCount = 0;
  const collectedAxisScalars = [];
  for (const [axisName, axis] of Object.entries(can.axis_bundle)) {
    if (!axis || axis._error) continue;
    for (const [k, v] of Object.entries(axis)) {
      if (k.startsWith("_")) continue;
      if (typeof v === "number" && Number.isFinite(v)) {
        collectedAxisScalars.push(v);
        axisCount++;
      }
    }
  }
  axisH = scalarEntropyEstimate(collectedAxisScalars);
  buckets.push({ category: "axis-bundle-scalars", count: axisCount, entropy: axisH });

  // ─── 7) Shape + spectral moments ─────
  let momH = scalarEntropyEstimate([...can.shape_moments, ...can.spectral_moments]);
  buckets.push({ category: "shape+spectral-moments", count: can.shape_moments.length + can.spectral_moments.length, entropy: momH });

  // ─── 8) LGN flat + parvo + magno + konio scalars ─────
  const lgnScalars = [];
  for (const v of Object.values(can.lgn.flat)) if (typeof v === "number") lgnScalars.push(v);
  for (const v of Object.values(can.lgn.parvo)) if (typeof v === "number") lgnScalars.push(v);
  for (const v of Object.values(can.lgn.magno)) if (typeof v === "number") lgnScalars.push(v);
  for (const v of Object.values(can.lgn.konio)) if (typeof v === "number") lgnScalars.push(v);
  const lgnH = scalarEntropyEstimate(lgnScalars);
  buckets.push({ category: "LGN-scalars", count: lgnScalars.length, entropy: lgnH });

  // ─── 9) V1 summary + V2 + V4 summaries ─────
  const cortexScalars = [];
  for (const v of Object.values(can.v1_summary)) if (typeof v === "number") cortexScalars.push(v);
  for (const v of Object.values(can.v2_summary)) if (typeof v === "number") cortexScalars.push(v);
  for (const v of Object.values(can.v4_summary)) if (typeof v === "number") cortexScalars.push(v);
  const cortexH = scalarEntropyEstimate(cortexScalars);
  buckets.push({ category: "V1+V2+V4-summary-scalars", count: cortexScalars.length, entropy: cortexH });

  // ─── 10) IT identity vector (80-D) ─────
  const itH = shannonEntropy(can.it_vector, 256);
  buckets.push({ category: "IT-identity-vector", count: can.it_vector.length, entropy: itH });

  // ─── 11) retinal_12 summary scalars ─────
  const r12sH = scalarEntropyEstimate(Object.values(can.retinal_12).filter(v => typeof v === "number"));
  buckets.push({ category: "retinal-12-summary-scalars", count: Object.keys(can.retinal_12).length, entropy: r12sH });

  // ─── 12) Iris + camera + illuminant meta ─────
  const metaScalars = [
    can.iris.aperture_gain, can.iris.dr_stops_in, can.iris.dr_stops_out,
    can.meta.camera.gamma, can.meta.camera.exposure, can.meta.camera.noise_sigma,
    ...can.meta.camera.wb, ...can.meta.illuminant.c, can.meta.illuminant.confidence,
    can.rod ? can.rod.saturated_frac : 0,
    can.rod ? can.rod.sensitivity_gain : 0,
  ].filter(v => typeof v === "number" && Number.isFinite(v));
  const metaH = scalarEntropyEstimate(metaScalars);
  buckets.push({ category: "iris+camera+illum+rod-meta", count: metaScalars.length, entropy: metaH });

  // Sum + print
  const total_H = buckets.reduce((s, b) => s + b.entropy, 0);
  const total_units = buckets.reduce((s, b) => s + b.count, 0);
  const ratio = total_H / (input_entropy || 1);

  console.log(`\n  ${p.name.padEnd(10)}  input=${input_entropy.toFixed(2)} bits`);
  for (const b of buckets) {
    console.log(`    ${b.category.padEnd(35)} ${String(b.count).padStart(4)} unit${b.count === 1 ? " " : "s"}  H=${b.entropy.toFixed(1)} bits`);
  }
  console.log(`    ${"".padEnd(35)} ${String(total_units).padStart(4)} TOTAL   H=${total_H.toFixed(1)} bits  ratio=${(ratio * 100).toFixed(0)}%`);

  rows.push({ photo: p.name, input_entropy, buckets, total_H, total_units, ratio });
}

const mean_ratio = rows.reduce((s, r) => s + r.ratio, 0) / rows.length;
const mean_units = rows.reduce((s, r) => s + r.total_units, 0) / rows.length;
console.log("\n══════ SUMMARY ══════");
console.log(`  Mean total output units per capture: ${mean_units.toFixed(0)}`);
console.log(`  Mean total entropy: ${(rows.reduce((s, r) => s + r.total_H, 0) / rows.length).toFixed(1)} bits`);
console.log(`  Mean input entropy: ${(rows.reduce((s, r) => s + r.input_entropy, 0) / rows.length).toFixed(1)} bits`);
console.log(`  Mean derived-information ratio: ${(mean_ratio * 100).toFixed(0)}% of input`);

fs.writeFileSync(path.join(OUT, "_full_catalog.json"), JSON.stringify(rows, null, 2));
console.log(`\n  Full catalog: ${path.join(OUT, "_full_catalog.json")}`);
