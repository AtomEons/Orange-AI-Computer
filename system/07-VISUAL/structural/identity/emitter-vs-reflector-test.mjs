#!/usr/bin/env bun
// Emitter vs Reflector — does AEyes¹ discriminate object from color?
//
// Z.AI question: real orange fruit (reflector, has subsurface + specular +
// depth structure) vs LCD screen emitting solid orange (emitter, flat, no
// subsurface, no specular geometry) — same chromatic band but wildly
// different physical signatures.
//
// This experiment:
//   1. Measure orange.jpg — photograph of real fruit (baseline reflector)
//   2. Synthesize a flat-color patch at orange's mean color — proxy for
//      "LCD emitting solid orange" (perfectly uniform, no subsurface, no
//      specular highlight, no texture, no depth variation)
//   3. Compare the composite AEyes¹ signature — subsurface, specular, edge,
//      texture — and report distance in each channel
//   4. Verdict: if distances are large in subsurface/specular/texture even
//      though color distance is small, we've proven emitter/reflector
//      discrimination works.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { subsurfaceSummaryForRegion, subsurfaceDistance } from "../axes/subsurface-axis.mjs";
import { computeDescriptor, descriptorDistance } from "./descriptor.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "emitter-vs-reflector");
fs.mkdirSync(OUT, { recursive: true });

function toLuminance(R, G, B) {
  const L = new Float32Array(R.length);
  for (let i = 0; i < R.length; i++) L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  return L;
}

console.log("=== EMITTER vs REFLECTOR ===\n");

// ── Step 1: measure the real fruit photograph ──
console.log("Step 1: measure orange.jpg (real fruit reflector)");
const orange = await extractImageRGB(path.join(FIXTURES, "orange.jpg"), { maxSize: 384 });
const W = orange.width, H = orange.height;
const region = [0, 0, W, H];

const orangeL = toLuminance(orange.R, orange.G, orange.B);
const orangeDesc = computeDescriptor(region, orange.R, orange.G, orange.B, W, H);
const orangeEdge = edgeSummaryForRegion(orangeL, W, H, region);
const orangeTex = textureSummaryForRegion(orangeL, W, H, region);
const orangeSpec = specularSummaryForRegion(orangeL, W, H, region);
const orangeSpat = spatialColorSummaryForRegion(orange.R, orange.G, orange.B, W, H, region);
const orangeSub = subsurfaceSummaryForRegion(orange.R, orange.G, orange.B, W, H, region);

console.log(`  color:    R=${orangeDesc.mean_R.toFixed(3)} G=${orangeDesc.mean_G.toFixed(3)} B=${orangeDesc.mean_B.toFixed(3)}  RG=${orangeDesc.mean_RG.toFixed(3)} BY=${orangeDesc.mean_BY.toFixed(3)}`);
console.log(`  edge:     meanEnergy=${orangeEdge.meanEnergy.toFixed(4)}  orientEntropy=${orangeEdge.orientationEntropy.toFixed(3)}`);
console.log(`  texture:  variance=${orangeTex.textureMeanVariance.toFixed(6)}  LBP-entropy=${orangeTex.lbpEntropy.toFixed(3)}`);
console.log(`  specular: CoV=${orangeSpec.cov.toFixed(3)}  brightFrac=${orangeSpec.brightFraction.toFixed(3)}  glossiness=${orangeSpec.glossinessScore.toFixed(3)}`);
console.log(`  subsurf:  edgeSoft=${orangeSub.edgeSoftness.toFixed(3)}  shadowGlow=${orangeSub.shadowGlowRatio.toFixed(3)}  translucency=${orangeSub.translucencyScore.toFixed(3)}`);

// ── Step 2: synthesize a flat-color LCD-like patch ──
console.log("\nStep 2: synthesize LCD-like flat patch at orange's mean color");
const meanR = orangeDesc.mean_R, meanG = orangeDesc.mean_G, meanB = orangeDesc.mean_B;
const N = W * H;
const lcdR = new Float32Array(N);
const lcdG = new Float32Array(N);
const lcdB = new Float32Array(N);
for (let i = 0; i < N; i++) { lcdR[i] = meanR; lcdG[i] = meanG; lcdB[i] = meanB; }
// Also save a version with tiny gaussian noise (0.5%) — a REAL LCD would
// have quantization noise. This is more honest than pure flat.
const lcdRn = new Float32Array(N);
const lcdGn = new Float32Array(N);
const lcdBn = new Float32Array(N);
let seed = 42;
function rng() { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; }
for (let i = 0; i < N; i++) {
  lcdRn[i] = Math.max(0, Math.min(1, meanR + (rng() - 0.5) * 0.01));
  lcdGn[i] = Math.max(0, Math.min(1, meanG + (rng() - 0.5) * 0.01));
  lcdBn[i] = Math.max(0, Math.min(1, meanB + (rng() - 0.5) * 0.01));
}

async function measureRegion(R, G, B, label) {
  const L = toLuminance(R, G, B);
  const desc = computeDescriptor(region, R, G, B, W, H);
  const edge = edgeSummaryForRegion(L, W, H, region);
  const tex = textureSummaryForRegion(L, W, H, region);
  const spec = specularSummaryForRegion(L, W, H, region);
  const spat = spatialColorSummaryForRegion(R, G, B, W, H, region);
  const sub = subsurfaceSummaryForRegion(R, G, B, W, H, region);
  console.log(`\n  ${label}:`);
  console.log(`    color:    R=${desc.mean_R.toFixed(3)} G=${desc.mean_G.toFixed(3)} B=${desc.mean_B.toFixed(3)}  RG=${desc.mean_RG.toFixed(3)} BY=${desc.mean_BY.toFixed(3)}`);
  console.log(`    edge:     meanEnergy=${edge.meanEnergy.toFixed(4)}  orientEntropy=${edge.orientationEntropy.toFixed(3)}`);
  console.log(`    texture:  variance=${tex.textureMeanVariance.toFixed(6)}  LBP-entropy=${tex.lbpEntropy.toFixed(3)}`);
  console.log(`    specular: CoV=${spec.cov.toFixed(3)}  brightFrac=${spec.brightFraction.toFixed(3)}  glossiness=${spec.glossinessScore.toFixed(3)}`);
  console.log(`    subsurf:  edgeSoft=${sub.edgeSoftness.toFixed(3)}  shadowGlow=${sub.shadowGlowRatio.toFixed(3)}  translucency=${sub.translucencyScore.toFixed(3)}`);
  return { desc, edge, tex, spec, spat, sub };
}

const lcdFlat = await measureRegion(lcdR, lcdG, lcdB, "LCD flat");
const lcdNoisy = await measureRegion(lcdRn, lcdGn, lcdBn, "LCD with 1% quantization noise");

// ── Step 3: distance comparisons ──
console.log("\n=== DISTANCES: orange (real fruit) vs LCD-like patches ===");

function scalarDist(a, b) { return Math.abs(a - b); }

console.log("\nchannel-by-channel deltas — orange vs LCD-flat:");
console.log(`  color mean_RG:       ${scalarDist(orangeDesc.mean_RG, lcdFlat.desc.mean_RG).toFixed(4)}   ← both same-family orange`);
console.log(`  color mean_BY:       ${scalarDist(orangeDesc.mean_BY, lcdFlat.desc.mean_BY).toFixed(4)}   ← both same-family orange`);
console.log(`  edge meanEnergy:     ${scalarDist(orangeEdge.meanEnergy, lcdFlat.edge.meanEnergy).toFixed(4)}   ← orange has real edges, LCD has none`);
console.log(`  texture variance:    ${scalarDist(orangeTex.textureMeanVariance, lcdFlat.tex.textureMeanVariance).toFixed(4)}   ← peel texture vs zero`);
console.log(`  specular glossiness: ${scalarDist(orangeSpec.glossinessScore, lcdFlat.spec.glossinessScore).toFixed(4)}   ← peel highlight vs zero`);
console.log(`  subsurf translucency:${scalarDist(orangeSub.translucencyScore, lcdFlat.sub.translucencyScore).toFixed(4)}   ← peel scatters, screen doesnt`);
console.log(`  subsurf shadowGlow:  ${scalarDist(orangeSub.shadowGlowRatio, lcdFlat.sub.shadowGlowRatio).toFixed(4)}   ← peel scatters shadow, LCD flat`);
console.log(`  subsurf edgeSoft:    ${scalarDist(orangeSub.edgeSoftness, lcdFlat.sub.edgeSoftness).toFixed(4)}   ← peel bleeds, LCD sharp`);

console.log(`\ntotal subsurface distance:  orange↔LCD-flat  = ${subsurfaceDistance(orangeSub, lcdFlat.sub).toFixed(4)}`);
console.log(`total subsurface distance:  orange↔LCD-noisy = ${subsurfaceDistance(orangeSub, lcdNoisy.sub).toFixed(4)}`);

console.log(`\ntotal color descriptor distance (chromatic only):`);
console.log(`  orange↔LCD-flat  = ${descriptorDistance(orangeDesc, lcdFlat.desc).toFixed(4)}`);
console.log(`  orange↔LCD-noisy = ${descriptorDistance(orangeDesc, lcdNoisy.desc).toFixed(4)}`);

// ── Verdict ──
console.log("\n=== VERDICT ===");
const colorD = descriptorDistance(orangeDesc, lcdFlat.desc);
const subD = subsurfaceDistance(orangeSub, lcdFlat.sub);
const edgeD = scalarDist(orangeEdge.meanEnergy, lcdFlat.edge.meanEnergy);
const specD = scalarDist(orangeSpec.glossinessScore, lcdFlat.spec.glossinessScore);
const texD = scalarDist(orangeTex.textureMeanVariance, lcdFlat.tex.textureMeanVariance);
console.log(`  Color: orange and LCD-flat differ by only ${colorD.toFixed(3)} — same chromatic family (WOULD confuse a color-only system).`);
console.log(`  Non-color composite: subsurface=${subD.toFixed(3)}, edge=${edgeD.toFixed(3)}, texture=${texD.toFixed(3)}, specular=${specD.toFixed(3)}`);
if (subD > 0.1 || edgeD > 0.02 || specD > 0.05) {
  console.log(`  ✓ AEyes¹ discriminates emitter from reflector via non-color channels.`);
  console.log(`  ✓ A pure-color classifier would fuse them; AEyes¹ separates them.`);
} else {
  console.log(`  ✗ Composite failed to discriminate — investigate.`);
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify({
  orange: { color: orangeDesc, edge: orangeEdge, texture: orangeTex, specular: orangeSpec, subsurface: orangeSub },
  lcd_flat: lcdFlat,
  lcd_noisy: lcdNoisy,
  distances: {
    color_orange_lcdFlat: colorD,
    color_orange_lcdNoisy: descriptorDistance(orangeDesc, lcdNoisy.desc),
    subsurface_orange_lcdFlat: subD,
    subsurface_orange_lcdNoisy: subsurfaceDistance(orangeSub, lcdNoisy.sub),
    edge_meanEnergy: edgeD,
    specular_glossiness: specD,
    texture_variance: texD,
  },
}, null, 2));
console.log(`\nartifacts: ${OUT}`);
