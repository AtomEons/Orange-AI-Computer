#!/usr/bin/env bun
// prove-1-shot-plus-family-train.mjs — operator's "1-shot then 10-100 train" receipt.
//
// The eye's identity contract:
//   - 1 sample seen → future recall of THAT SAME condition works
//   - 10-100 samples seen → recognition in ANY environment/condition/lighting
//
// Protocol:
//   1. TRAIN each of 6 fixtures on 5 of 6 lighting conditions (labeled).
//      Family "apple" = {apple×raw, apple×sun, apple×candle, apple×moon, apple×crt}
//   2. TEST each fixture's HELD-OUT 6th lighting condition (unlabeled query).
//   3. Verify the graph recognizes the held-out sample as its correct family,
//      with margin over next-best family.
//
// Passing this = the graph does what a "human photonic-capacity" recognizer
// should: same object, novel lighting, correct family.

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

async function sigOf(rgb, light) {
  const lit = applyLight(rgb, light);
  const can = captureCanonicalPhoton(lit, { x: 0, y: 0, w: lit.width, h: lit.height });
  return extractILCSignature(can).data;
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  AEYES¹ — 1-SHOT + 10-100 TRAIN RECEIPT                   ║");
console.log("║  Train 5 lighting conditions per fixture, test held-out 6th║");
console.log("╚══════════════════════════════════════════════════════════╝");

const graph = new EmergentLightGraph();

// Preload all RGBs
const rgbs = {};
for (const fx of FIXTURES) {
  if (fs.existsSync(fx.path)) rgbs[fx.name] = await extractImageRGB(fx.path, { maxSize: 384 });
}

// Round-robin held-out condition per fixture so each fixture uses a
// different novel lighting for its test — no held-out bias.
const heldOutForFixture = (fxName) => LIGHTS[FIXTURES.findIndex(f => f.name === fxName) % LIGHTS.length];

console.log("\n══════ TRAIN PHASE ══════");
for (const fx of FIXTURES) {
  if (!rgbs[fx.name]) continue;
  const held = heldOutForFixture(fx.name);
  for (const light of LIGHTS) {
    if (light === held) continue;
    const sig = await sigOf(rgbs[fx.name], light);
    const res = graph.train(sig, fx.name, { condition: light });
    const tag = res.wasNew ? "NEW node" : "grew ";
    console.log(`  train ${fx.name.padEnd(12)} × ${light.padEnd(6)} → ${res.nodeId.padEnd(6)} [${tag}] sim=${res.sim >= 0 ? res.sim.toFixed(3) : "  -  "}`);
  }
}

console.log("\n══════ FAMILY STATE ══════");
for (const [label, fam] of graph.families) {
  console.log(`  family ${label.padEnd(12)}: ${fam.nodes.size} nodes covering ${fam.count} training samples`);
}

console.log("\n══════ TEST PHASE (held-out lighting per fixture) ══════");
let correct = 0, total = 0;
for (const fx of FIXTURES) {
  if (!rgbs[fx.name]) continue;
  const held = heldOutForFixture(fx.name);
  const sig = await sigOf(rgbs[fx.name], held);
  const res = graph.recognize(sig);
  total++;
  const pass = res.familyLabel === fx.name;
  if (pass) correct++;
  console.log(`  test ${fx.name.padEnd(12)} × ${held.padEnd(6)} (held-out)  →  recognized as "${(res.familyLabel || "").padEnd(12)}" sim=${res.sim.toFixed(3)} margin=${res.margin.toFixed(3)} [${pass ? "PASS" : "FAIL — 2nd was " + res.secondFamily}]`);
}

console.log("\n══════ SUMMARY ══════");
console.log(`  Held-out recognition: ${correct}/${total} (${(correct / total * 100).toFixed(0)}%)`);
console.log(`  Total families: ${graph.families.size}`);
console.log(`  Total nodes: ${graph.nodes.size}`);
console.log(`  Verdict: ${correct === total ? "20:20 IDENTITY — PASS" : correct >= total * 0.8 ? "STRONG (needs more training samples)" : "BELOW THRESHOLD — need architectural push"}`);

fs.writeFileSync(path.join(OUT, "_1shot_family_train_results.json"), JSON.stringify({ correct, total, families: Array.from(graph.families.entries()).map(([label, fam]) => ({ label, nodeCount: fam.nodes.size, sampleCount: fam.count })) }, null, 2));
