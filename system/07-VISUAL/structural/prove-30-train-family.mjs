#!/usr/bin/env bun
// prove-30-train-family.mjs — operator spec: 10-100 trains per family.
//
// Push each fixture through richer perturbation grid:
//   6 lighting conditions × 5 amplitude jitters = 30 training samples per fixture
// Test: 6 held-out combinations per fixture (novel lighting × jitter combos).
//
// With more samples the family manifold covers more of the variation surface
// → higher held-out recognition. This is the operator's contract in action.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { extractILCSignature } from "./ilc-signature.mjs";
import { EmergentLightGraph } from "./pattern-engine/emergent-light-graph.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/emergent-graph";
fs.mkdirSync(OUT, { recursive: true });

const FIXTURES = [
  { name: "apple",      path: `${FIX}/apple.jpg` },
  { name: "baboon",     path: `${FIX}/baboon.jpg` },
  { name: "basketball", path: `${FIX}/basketball1.png` },
  { name: "board",      path: `${FIX}/board.jpg` },
  { name: "building",   path: `${FIX}/building.jpg` },
  { name: "orange",     path: `${FIX}/baby-cinema/frames-single/orange_t1.5.png` },
];
const LIGHTS = ["raw", "sun", "candle", "moon", "crt", "neon"];
// Jitters vary intensity/contrast slightly per condition so families cover a
// wider surface (approximates real-world capture variability).
const JITTERS = [
  { name: "j0", scale: 1.0,  brightness: 0 },
  { name: "j1", scale: 0.9,  brightness: -6 },
  { name: "j2", scale: 1.1,  brightness: 6 },
  { name: "j3", scale: 0.85, brightness: 4 },
  { name: "j4", scale: 1.15, brightness: -3 },
];

function applyLightJitter(rgb, type, jitter) {
  const N = rgb.width * rgb.height;
  const R = new Float32Array(rgb.R);
  const G = new Float32Array(rgb.G);
  const B = new Float32Array(rgb.B);
  const s = jitter.scale, br = jitter.brightness;
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
    r = r * s + br;
    g = g * s + br;
    b = b * s + br;
    R[i] = Math.min(255, Math.max(0, r));
    G[i] = Math.min(255, Math.max(0, g));
    B[i] = Math.min(255, Math.max(0, b));
  }
  return { R, G, B, width: rgb.width, height: rgb.height, W: rgb.width, H: rgb.height };
}

async function sigOfLJ(rgb, light, jitter) {
  const lit = applyLightJitter(rgb, light, jitter);
  const can = captureCanonicalPhoton(lit, { x: 0, y: 0, w: lit.width, h: lit.height });
  return extractILCSignature(can).data;
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  AEYES¹ — 25-TRAIN + 5-TEST FAMILY RECEIPT                ║");
console.log("║  Per fixture: 5 lighting × 5 jitters = 25 train samples   ║");
console.log("║  Held-out: 1 lighting × 5 jitters = 5 held-out per fixture ║");
console.log("╚══════════════════════════════════════════════════════════╝");

const graph = new EmergentLightGraph();
const rgbs = {};
for (const fx of FIXTURES) {
  if (fs.existsSync(fx.path)) rgbs[fx.name] = await extractImageRGB(fx.path, { maxSize: 384 });
}

// Round-robin held-out lighting per fixture
const heldOutForFixture = (fxName) => LIGHTS[FIXTURES.findIndex(f => f.name === fxName) % LIGHTS.length];

console.log("\n══════ TRAIN PHASE ══════");
for (const fx of FIXTURES) {
  if (!rgbs[fx.name]) continue;
  const held = heldOutForFixture(fx.name);
  let sampleCount = 0;
  for (const light of LIGHTS) {
    if (light === held) continue;
    for (const jitter of JITTERS) {
      const sig = await sigOfLJ(rgbs[fx.name], light, jitter);
      graph.train(sig, fx.name, { condition: `${light}/${jitter.name}` });
      sampleCount++;
    }
  }
  const fam = graph.families.get(fx.name);
  console.log(`  ${fx.name.padEnd(12)}: trained ${sampleCount} samples → ${fam.nodes.size} nodes in family`);
}

console.log("\n══════ TEST PHASE (held-out lighting × all jitters) ══════");
let correct = 0, total = 0;
const perFixture = {};
for (const fx of FIXTURES) {
  if (!rgbs[fx.name]) continue;
  const held = heldOutForFixture(fx.name);
  perFixture[fx.name] = { correct: 0, total: 0, held };
  for (const jitter of JITTERS) {
    const sig = await sigOfLJ(rgbs[fx.name], held, jitter);
    const res = graph.recognize(sig);
    total++;
    perFixture[fx.name].total++;
    const pass = res.familyLabel === fx.name;
    if (pass) { correct++; perFixture[fx.name].correct++; }
  }
  const p = perFixture[fx.name];
  console.log(`  ${fx.name.padEnd(12)} × ${held.padEnd(6)} (held-out): ${p.correct}/${p.total} correct`);
}

console.log("\n══════ SUMMARY ══════");
console.log(`  Held-out recognition:  ${correct}/${total} (${(correct/total*100).toFixed(0)}%)`);
console.log(`  Total nodes:           ${graph.nodes.size}`);
console.log(`  Verdict: ${correct === total ? "20:20 IDENTITY — PASS" : correct >= total*0.85 ? "STRONG (>85%)" : correct >= total*0.7 ? "PROMISING (>70%)" : "BELOW"}`);

fs.writeFileSync(path.join(OUT, "_30_train_results.json"), JSON.stringify({ correct, total, perFixture, nodeCount: graph.nodes.size }, null, 2));
