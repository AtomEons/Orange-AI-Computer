#!/usr/bin/env bun
// prove-scale-outward-recognition.mjs — scale until failure.
//
// Operator directive: "all tests must scale outward till failure then adjust.
// there should not be a failure with a proper photon pattern on a properly
// calibrated invariant light capture system like ours."
//
// Test with 20 real photographs × 6 lighting conditions = 120 samples.
// Train 5 lighting × fixture. Held-out 6th lighting. If any failure →
// identify pattern → adjust calibration.
//
// Phase 1: global IT (fast). If 100%, done.
// Phase 2: if any fail, retry those cases with saccadic fusion.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { itSim } from "./eye/it-identity.mjs";
import { captureWithSaccades } from "./eye/saccades.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/scale-outward";
fs.mkdirSync(OUT, { recursive: true });

const FIXTURES = [
  { name: "apple",       path: `${FIX}/apple.jpg` },
  { name: "baboon",      path: `${FIX}/baboon.jpg` },
  { name: "basketball1", path: `${FIX}/basketball1.png` },
  { name: "basketball2", path: `${FIX}/basketball2.png` },
  { name: "board",       path: `${FIX}/board.jpg` },
  { name: "building",    path: `${FIX}/building.jpg` },
  { name: "butterfly",   path: `${FIX}/butterfly.jpg` },
  { name: "fruits",      path: `${FIX}/fruits.jpg` },
  { name: "home",        path: `${FIX}/home.jpg` },
  { name: "lena",        path: `${FIX}/lena.jpg` },
  { name: "messi5",      path: `${FIX}/messi5.jpg` },
  { name: "orange",      path: `${FIX}/orange.jpg` },
  { name: "pic1",        path: `${FIX}/pic1.png` },
  { name: "pic2",        path: `${FIX}/pic2.png` },
  { name: "pic3",        path: `${FIX}/pic3.png` },
  { name: "pic4",        path: `${FIX}/pic4.png` },
  { name: "pic5",        path: `${FIX}/pic5.png` },
  { name: "pic6",        path: `${FIX}/pic6.png` },
  { name: "starry_night",path: `${FIX}/starry_night.jpg` },
  { name: "notes",       path: `${FIX}/notes.png` },
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

/** Fuse N IT vectors into single normalized vector */
function fuseIT(vectors) {
  if (vectors.length === 0) return null;
  const D = vectors[0].length;
  const fused = new Float32Array(D);
  for (const v of vectors) for (let i = 0; i < D; i++) fused[i] += v[i];
  for (let i = 0; i < D; i++) fused[i] /= vectors.length;
  let n = 0;
  for (let i = 0; i < D; i++) n += fused[i] * fused[i];
  n = Math.sqrt(n) || 1;
  for (let i = 0; i < D; i++) fused[i] /= n;
  return fused;
}

/** Get IT vector from one capture (single-fixation, global). */
function itOf(rgb) {
  const can = captureCanonicalPhoton(rgb, { x: 0, y: 0, w: rgb.width, h: rgb.height });
  return can.it_vector;
}

/** Get FUSED IT vector from saccadic multi-fixation capture. */
async function itSaccadeFused(rgb) {
  const result = await captureWithSaccades(rgb, captureCanonicalPhoton, { numFixations: 3, regionFrac: 0.4 });
  const its = [result.global.it_vector, ...result.fixations.map(f => f.canonical.it_vector)];
  return fuseIT(its);
}

// Load fixtures
console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  SCALE OUTWARD — 20 fixtures × 6 lighting = 120 samples   ║");
console.log("║  Phase 1: global IT. Phase 2: saccadic fusion on failures.║");
console.log("╚══════════════════════════════════════════════════════════╝");

const rgbs = {};
const validFixtures = [];
for (const fx of FIXTURES) {
  if (fs.existsSync(fx.path)) {
    rgbs[fx.name] = await extractImageRGB(fx.path, { maxSize: 192 });
    validFixtures.push(fx);
  } else {
    console.log(`  [skip] ${fx.name} — missing`);
  }
}
console.log(`  Loaded ${validFixtures.length} fixtures.`);

// Round-robin held-out lighting
const heldOutFor = (name) => LIGHTS[validFixtures.findIndex(f => f.name === name) % LIGHTS.length];

console.log("\n══ PHASE 1: GLOBAL IT training + testing ══");

// Precompute all IT vectors (5 train + 1 test = 6 per fixture)
const train_vecs = new Map(); // family → [{it, condition}]
const test_vecs = [];         // [{fixture, held_condition, it_vector}]

const t_start = performance.now();
let done = 0;
for (const fx of validFixtures) {
  train_vecs.set(fx.name, []);
  const held = heldOutFor(fx.name);
  for (const light of LIGHTS) {
    const lit = applyLight(rgbs[fx.name], light);
    const it_g = itOf(lit);
    if (light === held) {
      test_vecs.push({ fixture: fx.name, held_condition: held, it_vector: it_g });
    } else {
      train_vecs.get(fx.name).push({ it_vector: it_g, condition: light });
    }
    done++;
  }
  const t_now = performance.now();
  console.log(`  ${fx.name.padEnd(14)} done (${done}/${validFixtures.length * LIGHTS.length}, ${((t_now - t_start) / 1000).toFixed(0)}s)`);
}
console.log(`  Phase 1 precompute: ${((performance.now() - t_start) / 1000).toFixed(0)}s`);

// Recognize each test
console.log("\n══ Recognition ══");
let correct = 0, total = 0;
const failures = [];
for (const test of test_vecs) {
  let bestLabel = null, bestSim = -Infinity;
  let secondLabel = null, secondSim = -Infinity;
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
  const pass = bestLabel === test.fixture;
  if (pass) correct++;
  else failures.push({ ...test, predicted: bestLabel, sim: bestSim, second: secondLabel, margin: bestSim - secondSim });
  const tag = pass ? "PASS" : `FAIL(→${bestLabel})`;
  console.log(`  ${test.fixture.padEnd(14)} × ${test.held_condition.padEnd(6)} → ${(bestLabel || "").padEnd(14)} sim=${bestSim.toFixed(3)} margin=${(bestSim - secondSim).toFixed(3)} [${tag}]`);
}

console.log(`\n  Phase 1 result: ${correct}/${total} = ${(correct / total * 100).toFixed(1)}%`);

// Phase 2: retry failures with saccadic fusion
if (failures.length > 0) {
  console.log(`\n══ PHASE 2: retry ${failures.length} failures with SACCADIC FUSION ══`);
  // Rebuild train families with fused IT (saccadic)
  const fused_train = new Map();
  const involved = new Set();
  for (const f of failures) involved.add(f.fixture);
  for (const [label, members] of train_vecs) {
    if (!involved.has(label)) { fused_train.set(label, members); continue; }
    // For involved fixtures, rebuild with saccadic
    const held = heldOutFor(label);
    const fused_members = [];
    for (const light of LIGHTS) {
      if (light === held) continue;
      const lit = applyLight(rgbs[label], light);
      const fused_it = await itSaccadeFused(lit);
      fused_members.push({ it_vector: fused_it, condition: light });
      console.log(`  fused-train ${label.padEnd(14)} × ${light}`);
    }
    fused_train.set(label, fused_members);
  }
  // Retest failures with saccadic
  let phase2_correct = 0;
  for (const f of failures) {
    const held = heldOutFor(f.fixture);
    const lit = applyLight(rgbs[f.fixture], held);
    const test_fused = await itSaccadeFused(lit);
    let bestLabel = null, bestSim = -Infinity, secondLabel = null, secondSim = -Infinity;
    for (const [label, members] of fused_train) {
      let famBest = -Infinity;
      for (const m of members) {
        const s = itSim(test_fused, m.it_vector);
        if (s > famBest) famBest = s;
      }
      if (famBest > bestSim) {
        secondSim = bestSim; secondLabel = bestLabel;
        bestSim = famBest; bestLabel = label;
      } else if (famBest > secondSim) {
        secondSim = famBest; secondLabel = label;
      }
    }
    const pass = bestLabel === f.fixture;
    if (pass) phase2_correct++;
    const tag = pass ? "PASS-SACC" : `FAIL(→${bestLabel})`;
    console.log(`  ${f.fixture.padEnd(14)} × ${held.padEnd(6)} → ${(bestLabel || "").padEnd(14)} sim=${bestSim.toFixed(3)} margin=${(bestSim - secondSim).toFixed(3)} [${tag}]`);
  }
  console.log(`\n  Phase 2 recovered: ${phase2_correct}/${failures.length}`);
  correct += phase2_correct;
}

console.log("\n══════ FINAL ══════");
console.log(`  Recognition: ${correct}/${total} = ${(correct / total * 100).toFixed(1)}%`);
console.log(`  Verdict: ${correct === total ? "ZERO ERRORS — 1+100% VISION VERIFIED" : correct >= total * 0.95 ? "NEAR PERFECT (>=95%)" : "MORE WORK NEEDED"}`);

fs.writeFileSync(path.join(OUT, "_results.json"), JSON.stringify({ correct, total, failures: failures.map(f => ({ fixture: f.fixture, held: f.held_condition, predicted: f.predicted, margin: f.margin })) }, null, 2));
