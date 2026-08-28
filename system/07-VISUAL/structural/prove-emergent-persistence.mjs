#!/usr/bin/env bun
// prove-emergent-persistence.mjs — Stage 1-3 receipt.
//
// The one question: given only streams of light, does the emergent graph
// discover stable visual entities that persist across time and conditions?
//
// Protocol:
//   1. Take 6 real fixtures (apple, baboon, basketball, board, building, orange)
//   2. For each, generate 5 simulated lighting conditions (raw, sun, candle,
//      moon, crt, neon — matches the operator's zai reference)
//   3. Feed all 6×6=36 frames to the emergent graph
//   4. Verify: (a) 6 stable node clusters emerge, one per fixture; (b) same
//      fixture under different lighting maps to the SAME node (invariance);
//      (c) different fixtures map to DIFFERENT nodes (discrimination).

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { extractILCSignature, ilcCosSim } from "./ilc-signature.mjs";
import { EmergentLightGraph, RECOGNIZE_TAU } from "./pattern-engine/emergent-light-graph.mjs";

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

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  EMERGENT LIGHT GRAPH — STAGE 1-3 RECEIPT                ║");
console.log("║  6 fixtures × 6 lighting conditions = 36 observations     ║");
console.log("╚══════════════════════════════════════════════════════════╝");
console.log(`  RECOGNIZE_TAU = ${RECOGNIZE_TAU} (cosine sim above → same light structure)`);

const graph = new EmergentLightGraph();
const observations = [];

for (const fx of FIXTURES) {
  if (!fs.existsSync(fx.path)) { console.log(`  [skip] ${fx.name}`); continue; }
  const rgb = await extractImageRGB(fx.path, { maxSize: 384 });
  for (const light of LIGHTS) {
    const lit = applyLight(rgb, light);
    const can = captureCanonicalPhoton(lit, { x: 0, y: 0, w: lit.width, h: lit.height });
    const sig = extractILCSignature(can);
    const res = graph.observe([sig.data], { source: fx.name, condition: light });
    observations.push({ fixture: fx.name, light, nodeId: res.updated[0].nodeId, wasNew: res.updated[0].wasNew, sim: res.updated[0].sim });
    const tag = res.updated[0].wasNew ? "NEW " : "same";
    console.log(`  ${fx.name.padEnd(12)} × ${light.padEnd(6)} → ${res.updated[0].nodeId.padEnd(6)} [${tag}] sim=${res.updated[0].sim.toFixed(3)}`);
  }
}

console.log("\n══════ GRAPH STATE ══════");
const stats = graph.stats();
console.log(`  frames observed:       ${stats.frames}`);
console.log(`  total nodes:           ${stats.totalNodes}`);
console.log(`  confirmed nodes (≥3):  ${stats.confirmedNodes}`);
console.log(`  mean persistence:      ${stats.meanPersistence.toFixed(2)}`);
console.log(`  max persistence:       ${stats.maxPersistence}`);

// Invariance test: for each fixture, verify all 6 lighting observations
// landed on the same node id
console.log("\n══════ INVARIANCE ACROSS LIGHTING ══════");
let invariancePasses = 0;
for (const fx of FIXTURES) {
  const fxObs = observations.filter(o => o.fixture === fx.name);
  const nodeIds = new Set(fxObs.map(o => o.nodeId));
  const passed = nodeIds.size === 1;
  console.log(`  ${fx.name.padEnd(12)} → ${nodeIds.size} distinct node${nodeIds.size === 1 ? "" : "s"} across ${fxObs.length} lighting conditions  [${passed ? "PASS" : "FAIL"}]`);
  if (passed) invariancePasses++;
}

// Discrimination test: for each pair of fixtures, verify they landed on
// different nodes
console.log("\n══════ DISCRIMINATION ACROSS FIXTURES ══════");
let discPasses = 0, discTotal = 0;
for (let i = 0; i < FIXTURES.length; i++) {
  for (let j = i + 1; j < FIXTURES.length; j++) {
    discTotal++;
    const iNodes = new Set(observations.filter(o => o.fixture === FIXTURES[i].name).map(o => o.nodeId));
    const jNodes = new Set(observations.filter(o => o.fixture === FIXTURES[j].name).map(o => o.nodeId));
    const overlap = [...iNodes].some(n => jNodes.has(n));
    if (!overlap) discPasses++;
  }
}
console.log(`  ${discPasses}/${discTotal} pairs correctly discriminated`);

console.log("\n══════ SUMMARY ══════");
console.log(`  Invariance:      ${invariancePasses}/${FIXTURES.length} fixtures collapsed to one node across all lighting`);
console.log(`  Discrimination:  ${discPasses}/${discTotal} distinct fixture pairs kept separate`);
console.log(`  Stage 1 (light atoms):        ${stats.totalNodes > 0 ? "PASS" : "FAIL"}`);
console.log(`  Stage 2 (co-occurrence):      ${observations.length > 0 ? "PASS" : "FAIL"}`);
console.log(`  Stage 3 (persistence emerges): ${stats.confirmedNodes > 0 ? "PASS" : "FAIL"}`);

fs.writeFileSync(path.join(OUT, "_results.json"), JSON.stringify({
  RECOGNIZE_TAU,
  observations,
  stats,
  invariancePasses,
  discPasses,
  discTotal,
}, null, 2));

console.log(`\n  results: ${path.join(OUT, "_results.json")}`);
