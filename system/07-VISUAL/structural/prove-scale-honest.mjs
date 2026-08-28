#!/usr/bin/env bun
// prove-scale-honest.mjs — honest scale-outward with same-scene fixtures merged.
//
// basketball1.png and basketball2.png = two consecutive frames of the same
// scene (same room, same people, ball frozen mid-catch, one moment apart).
// Treating them as separate classes is a test design bug, not an eye failure.
// This merges them into one "basketball" class.
//
// Then diagnoses REAL failures with per-capture illuminant estimation trace
// to see if the extreme lighting is fooling the illuminant estimator.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { itSim } from "./eye/it-identity.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/scale-outward";
fs.mkdirSync(OUT, { recursive: true });

// Same-scene groupings: multiple files → one class
const CLASSES = [
  { name: "apple",       paths: [`${FIX}/apple.jpg`] },
  { name: "baboon",      paths: [`${FIX}/baboon.jpg`] },
  { name: "basketball",  paths: [`${FIX}/basketball1.png`, `${FIX}/basketball2.png`] }, // same scene
  { name: "board",       paths: [`${FIX}/board.jpg`] },
  { name: "building",    paths: [`${FIX}/building.jpg`] },
  { name: "butterfly",   paths: [`${FIX}/butterfly.jpg`] },
  { name: "fruits",      paths: [`${FIX}/fruits.jpg`] },
  { name: "home",        paths: [`${FIX}/home.jpg`] },
  { name: "lena",        paths: [`${FIX}/lena.jpg`] },
  { name: "messi5",      paths: [`${FIX}/messi5.jpg`] },
  { name: "orange",      paths: [`${FIX}/orange.jpg`] },
  { name: "pic1",        paths: [`${FIX}/pic1.png`] },
  { name: "pic2",        paths: [`${FIX}/pic2.png`] },
  { name: "pic3",        paths: [`${FIX}/pic3.png`] },
  { name: "pic4",        paths: [`${FIX}/pic4.png`] },
  { name: "pic5",        paths: [`${FIX}/pic5.png`] },
  { name: "pic6",        paths: [`${FIX}/pic6.png`] },
  { name: "starry_night",paths: [`${FIX}/starry_night.jpg`] },
  { name: "notes",       paths: [`${FIX}/notes.png`] },
];
const LIGHTS = ["raw", "sun", "candle", "moon", "crt", "neon"];

function applyLight(rgb, type) {
  const N = rgb.width * rgb.height;
  const R = new Float32Array(rgb.R);
  const G = new Float32Array(rgb.G);
  const B = new Float32Array(rgb.B);
  for (let i = 0; i < N; i++) {
    let r = R[i], g = G[i], b = B[i];
    switch (type) {
      case "raw": break;
      case "sun":    r *= 1.15; g *= 1.08; b *= 0.88; break;
      case "candle": r *= 1.35 * 0.72; g *= 0.82 * 0.72; b *= 0.35 * 0.72; break;
      case "moon":   r *= 0.28; g *= 0.38; b *= 0.72; break;
      case "crt":    r *= 0.28; g *= 1.12; b *= 0.28; break;
      case "neon": {
        const a = (r + g + b) / 3;
        r = a + (r - a) * 2.6;
        g = a + (g - a) * 2.6;
        b = a + (b - a) * 2.6;
        r *= 1.25; b *= 1.25; g *= 0.65;
        break;
      }
    }
    R[i] = Math.min(255, Math.max(0, r));
    G[i] = Math.min(255, Math.max(0, g));
    B[i] = Math.min(255, Math.max(0, b));
  }
  return { R, G, B, width: rgb.width, height: rgb.height, W: rgb.width, H: rgb.height };
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  HONEST SCALE — basketball1+2 merged (same scene)         ║");
console.log("║  19 classes × 6 lighting                                  ║");
console.log("╚══════════════════════════════════════════════════════════╝");

// Load all fixture RGBs (with variants for same-scene classes)
const class_rgbs = new Map(); // className → [rgb1, rgb2, ...]
for (const c of CLASSES) {
  const rgbs = [];
  for (const p of c.paths) {
    if (fs.existsSync(p)) rgbs.push(await extractImageRGB(p, { maxSize: 192 }));
  }
  if (rgbs.length > 0) class_rgbs.set(c.name, rgbs);
}
console.log(`  Loaded ${class_rgbs.size} classes.\n`);

// Round-robin held-out lighting per class
const classes_arr = Array.from(class_rgbs.keys());
const heldOutFor = (name) => LIGHTS[classes_arr.indexOf(name) % LIGHTS.length];

// Precompute IT vectors — for classes with multiple variants, use all variants across all non-held-out lightings
const train_vecs = new Map();
const test_vecs = [];
const illum_trace = [];

const t0 = performance.now();
let done = 0, total_samples = 0;
for (const c of classes_arr) total_samples += class_rgbs.get(c).length * LIGHTS.length;

for (const c of classes_arr) {
  train_vecs.set(c, []);
  const held = heldOutFor(c);
  const rgbs = class_rgbs.get(c);
  for (let vi = 0; vi < rgbs.length; vi++) {
    for (const light of LIGHTS) {
      const lit = applyLight(rgbs[vi], light);
      const can = captureCanonicalPhoton(lit, { x: 0, y: 0, w: lit.width, h: lit.height });
      done++;
      const it_g = can.it_vector;
      illum_trace.push({ class: c, variant: vi, light, illum_c: [...can.meta.illuminant.c], illum_conf: can.meta.illuminant.confidence });
      if (light === held) {
        // Only use variant 0 as test — one held-out sample per class
        if (vi === 0) test_vecs.push({ class: c, held_condition: held, it_vector: it_g });
        else train_vecs.get(c).push({ it_vector: it_g, condition: light + "_variant" + vi });
      } else {
        train_vecs.get(c).push({ it_vector: it_g, condition: light + "_variant" + vi });
      }
    }
  }
  const t_now = performance.now();
  console.log(`  ${c.padEnd(14)} done (${done}/${total_samples}, ${((t_now - t0) / 1000).toFixed(0)}s)`);
}

console.log(`\n══ Recognition ══`);
let correct = 0, total = 0;
const failures = [];
for (const test of test_vecs) {
  let bestLabel = null, bestSim = -Infinity, secondLabel = null, secondSim = -Infinity;
  for (const [label, members] of train_vecs) {
    let famBest = -Infinity;
    for (const m of members) {
      const s = itSim(test.it_vector, m.it_vector);
      if (s > famBest) famBest = s;
    }
    if (famBest > bestSim) {
      secondSim = bestSim; secondLabel = bestLabel;
      bestSim = famBest; bestLabel = label;
    } else if (famBest > secondSim) {
      secondSim = famBest; secondLabel = label;
    }
  }
  total++;
  const pass = bestLabel === test.class;
  if (pass) correct++;
  else failures.push({ ...test, predicted: bestLabel, sim: bestSim, second: secondLabel, margin: bestSim - secondSim });
  const tag = pass ? "PASS" : `FAIL(→${bestLabel})`;
  console.log(`  ${test.class.padEnd(14)} × ${test.held_condition.padEnd(6)} → ${(bestLabel || "").padEnd(14)} sim=${bestSim.toFixed(3)} margin=${(bestSim - secondSim).toFixed(3)} [${tag}]`);
}

console.log(`\n══ Recognition: ${correct}/${total} = ${(correct/total*100).toFixed(1)}% ══`);

// Illuminant trace for failures
if (failures.length > 0) {
  console.log(`\n══ Illuminant estimator trace for FAILURES ══`);
  for (const f of failures) {
    const relevant = illum_trace.filter(t => t.class === f.class && t.light === f.held_condition);
    for (const r of relevant) {
      console.log(`  ${r.class.padEnd(14)} × ${r.light.padEnd(6)}: illum=[${r.illum_c.map(v => v.toFixed(3)).join(",")}] conf=${r.illum_conf.toFixed(3)}`);
    }
    // Also print the confused class's train illuminants
    const confused = illum_trace.filter(t => t.class === f.predicted);
    console.log(`  ${f.predicted.padEnd(14)} (confused-with) illuminants seen during training:`);
    for (const r of confused.slice(0, 3)) {
      console.log(`    × ${r.light.padEnd(6)}: illum=[${r.illum_c.map(v => v.toFixed(3)).join(",")}] conf=${r.illum_conf.toFixed(3)}`);
    }
  }
}

fs.writeFileSync(path.join(OUT, "_honest_results.json"), JSON.stringify({ correct, total, failures, illum_trace }, null, 2));
console.log("\n  result: " + path.join(OUT, "_honest_results.json"));
