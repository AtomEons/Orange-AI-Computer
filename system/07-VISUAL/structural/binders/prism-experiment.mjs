#!/usr/bin/env bun
// Prism experiment — run the champion binder (watershed) on each of the three
// prism axes separately, then also on their fusion. Compare to the Y-only
// baseline from the sweep-1000 winner.
//
// This is not a full sweep. It is one focused test of the operator's hypothesis:
// does chromatic-opponent input reveal object boundaries that Y-only misses?
//
// Runs on fruits.jpg (highest color content of our 5 images) — the strongest
// test bed for chromaticity.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB, prismDecompose, opponentToUnit } from "../prism.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { bind as watershedBind } from "./watershed.mjs";
import { bind as densityBind } from "./density-cluster.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const IMG = path.join(FIXTURES, "fruits.jpg");
const OUT_DIR = path.join(FIXTURES, "prism-experiment");
fs.mkdirSync(OUT_DIR, { recursive: true });

console.log("=== PRISM EXPERIMENT on fruits.jpg ===");
console.log("Hypothesis: watershed on chromatic-opponent channels reveals object");
console.log("boundaries that Y-luminance-only cannot see.");
console.log("");

const t0 = Date.now();

// 1. Extract RGB.
const { R, G, B, width, height } = await extractImageRGB(IMG);
console.log(`RGB extracted: ${width}x${height}`);

// 2. Prism decompose.
const { A, RG, BY, notes: prismNotes } = prismDecompose(R, G, B);
console.log(`prism axes: achromatic A, red-green RG, blue-yellow BY`);

// Report per-axis statistics.
function stats(X, name) {
  let mn = Infinity, mx = -Infinity, sum = 0;
  for (let i = 0; i < X.length; i++) { if (X[i] < mn) mn = X[i]; if (X[i] > mx) mx = X[i]; sum += X[i]; }
  const mean = sum / X.length;
  let sqsum = 0;
  for (let i = 0; i < X.length; i++) sqsum += (X[i] - mean) ** 2;
  const std = Math.sqrt(sqsum / X.length);
  console.log(`  ${name.padEnd(15)} range=[${mn.toFixed(3)}, ${mx.toFixed(3)}] mean=${mean.toFixed(3)} std=${std.toFixed(3)}`);
}
stats(A, "A (achromatic)");
stats(RG, "RG (red-green)");
stats(BY, "BY (blue-yellow)");

// 3. Rescale opponent channels to [0, 1] for photoreceptor.
const RGu = opponentToUnit(RG);
const BYu = opponentToUnit(BY);

// 4. Photoreceptor on each channel (independent adaptation state per channel).
function runReceptor(X) {
  const pr = photoreceptorResponse(X, initAdaptationState(), null);
  return pr.R;
}
const rA  = runReceptor(A);
const rRG = runReceptor(RGu);
const rBY = runReceptor(BYu);

// 5. Run watershed on each channel.
console.log("");
console.log("--- watershed per axis ---");
const results = {};
for (const [name, channel] of Object.entries({ A: rA, RG: rRG, BY: rBY })) {
  const t = Date.now();
  const res = watershedBind(channel, width, height, {});
  const ents = res.entities;
  const areas = ents.map((e) => (e.region?.[2] ?? 0) * (e.region?.[3] ?? 0));
  const totalArea = areas.reduce((a, b) => a + b, 0);
  const coverage = totalArea / (width * height);
  const largest = areas.length ? Math.max(...areas) : 0;
  const largestFrac = largest / (width * height);
  results[name] = { entities: ents, coverage, largestFrac, ms: Date.now() - t };
  console.log(`  ${name}: ${ents.length} entities, coverage ${(coverage*100).toFixed(1)}%, largest ${(largestFrac*100).toFixed(1)}%, ${results[name].ms}ms`);
}

// 6. Fuse: union of all entities across all three axes.
console.log("");
console.log("--- fusion strategies ---");
const allEntities = [];
let nextId = 0;
for (const [axis, r] of Object.entries(results)) {
  for (const e of r.entities) {
    allEntities.push({ ...e, id: nextId++, from_axis: axis });
  }
}
console.log(`  union: ${allEntities.length} total entities across all three axes`);

// 7. Draw overlays.
async function drawOverlay(entities, outPath) {
  const colors = ["red", "yellow", "cyan", "magenta", "lime", "orange", "white"];
  const boxes = entities
    .slice()
    .sort((a, b) => ((b.region?.[2] ?? 0) * (b.region?.[3] ?? 0)) - ((a.region?.[2] ?? 0) * (a.region?.[3] ?? 0)))
    .slice(0, 15);
  const filters = boxes.map((e, i) => {
    const r = e.region || [0, 0, 0, 0];
    const c = colors[i % colors.length];
    return `drawbox=x=${r[0]}:y=${r[1]}:w=${r[2]}:h=${r[3]}:color=${c}:thickness=2`;
  }).join(",");
  const proc = Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", IMG, "-vf", filters || "null", outPath],
  });
  return proc.exitCode === 0;
}

for (const [axis, r] of Object.entries(results)) {
  await drawOverlay(r.entities, path.join(OUT_DIR, `watershed-${axis}-overlay.png`));
}
await drawOverlay(allEntities, path.join(OUT_DIR, `watershed-union-overlay.png`));

// 8. Also try density-cluster on RG (which had color emphasis).
console.log("");
console.log("--- density-cluster on RG (color-space) ---");
const dcOnRG = densityBind(rRG, width, height, {});
console.log(`  density on RG: ${dcOnRG.entities.length} entities`);
await drawOverlay(dcOnRG.entities, path.join(OUT_DIR, `density-RG-overlay.png`));

const totalMs = Date.now() - t0;
console.log("");
console.log(`sweep complete in ${totalMs}ms`);
console.log(`overlays written to: ${OUT_DIR}`);
console.log("");
console.log("Compare against the baseline (Y-only watershed on fruits.jpg):");
console.log("  fixtures/binder-sweep-1000/fruits-top1-identity_watershed_identity-overlay.png");
console.log("  → 5 entities, 42.9% cov, 17.9% max box");
