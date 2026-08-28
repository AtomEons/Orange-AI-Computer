#!/usr/bin/env bun
// Baby watches cinema.
//
// The operator's original directive:
//   "test this on a video about what an apple is somehow yes? or similar
//    short meaning training. a baby watches an apple, a parent says its an
//    apple, thats it."
//
// This experiment:
//   1. Baby watches baby-watches-orange.mp4 (3 seconds, 45 frames). Parent
//      says "orange." Learn ONE aggregated descriptor from all frames.
//   2. Baby watches baby-watches-apple.mp4 (3 seconds, 45 frames). Parent
//      says "apple." Learn ONE aggregated descriptor from all frames.
//   3. Test on unseen stills (fruits.jpg, apple.jpg, orange.jpg, lena.jpg).
//      Report distance to each learned label. Success = correct nearest
//      label per test image.
//
// The key operation is per-frame warm-union descriptor computed on the
// empirical light-string pipeline (density-cluster + merge_overlap on
// Y-luminance), then aggregated across frames via mean.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { preprocess } from "../binders/preprocessing.mjs";
import { postprocess } from "../binders/post-processing.mjs";
import { bind as densityBind } from "../binders/density-cluster.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import {
  computeDescriptor,
  computeUnionDescriptor,
  aggregateDescriptors,
  descriptorDistance,
} from "./descriptor.mjs";
import { loadStore, saveStore, learnLabel, recognize } from "./identity-store.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const OUT = path.join(FIXTURES, "baby-learn");
fs.mkdirSync(OUT, { recursive: true });
const STORE = path.join(OUT, "identity-store-cinema.json");

// The same light-string pipeline, adapted for pre-extracted RGB
function attentionOnRGB(cR, cG, cB, width, height) {
  const Y = new Float32Array(cR.length);
  for (let i = 0; i < cR.length; i++) Y[i] = 0.30 * cR[i] + 0.59 * cG[i] + 0.11 * cB[i];
  const pre = preprocess("gaussian_2", photoreceptorResponse(Y, initAdaptationState(), null).R, width, height);
  const raw = densityBind(pre.R2, width, height, {}).entities || [];
  const { entities } = postprocess("merge_overlap", raw, { frameArea: width * height });
  return entities;
}

// Chromatic-warm rule (same as single-image experiment)
function pickWarmUnion(entities, R, G, B, width, height) {
  const warm = [];
  for (const e of entities) {
    const d = computeDescriptor(e.region, R, G, B, width, height);
    if (!d) continue;
    const isWarm = (d.mean_RG > 0.03)
                && (d.mean_R > d.mean_B + 0.15)
                && (d.mean_R + d.mean_G > 0.5)
                && (d.mean_B < 0.5);
    if (isWarm) warm.push({ entity: e, descriptor: d });
  }
  if (!warm.length) return null;
  const regions = warm.map((w) => w.entity.region);
  const union = computeUnionDescriptor(regions, R, G, B, width, height);
  return { entities: warm.map((w) => w.entity), descriptor: union, count: warm.length };
}

// Watch a video: extract N frames, compute per-frame warm-union descriptor,
// then aggregate across frames.
async function watchVideo(videoPath, label, N = 15) {
  console.log(`  extracting ${N} frames from ${path.basename(videoPath)}...`);
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  console.log(`  ${frames.length} frames loaded (${frames[0].width}x${frames[0].height})`);
  const perFrame = [];
  let framesWithWarm = 0;
  for (const f of frames) {
    const entities = attentionOnRGB(f.R, f.G, f.B, f.width, f.height);
    const pick = pickWarmUnion(entities, f.R, f.G, f.B, f.width, f.height);
    if (pick) {
      perFrame.push(pick.descriptor);
      framesWithWarm++;
    }
  }
  if (!perFrame.length) {
    console.log(`  ! no warm content found across any frame — cannot learn '${label}'`);
    return null;
  }
  const agg = aggregateDescriptors(perFrame);
  console.log(`  → ${framesWithWarm}/${frames.length} frames yielded warm content`);
  console.log(`  aggregated '${label}' descriptor:`);
  for (const [k, v] of Object.entries(agg)) console.log(`    ${k}: ${v.toFixed(4)}`);
  return { descriptor: agg, framesUsed: framesWithWarm, framesTotal: frames.length, perFrame };
}

console.log("=== BABY WATCHES CINEMA ===\n");

// --- Train "orange" from baby-watches-orange.mp4 ---
console.log("STEP 1: baby watches baby-watches-orange.mp4 — parent says 'orange'");
const orangeTrain = await watchVideo(path.join(CINEMA, "baby-watches-orange.mp4"), "orange", 15);
if (!orangeTrain) process.exit(1);

// --- Train "apple" from baby-watches-apple.mp4 ---
console.log("\nSTEP 2: baby watches baby-watches-apple.mp4 — parent says 'apple'");
const appleTrain = await watchVideo(path.join(CINEMA, "baby-watches-apple.mp4"), "apple", 15);
if (!appleTrain) process.exit(1);

let store = loadStore(STORE);
store = learnLabel(store, "orange", orangeTrain.descriptor, "baby-watches-orange.mp4 (15 frames)", "2026-07-06T00:00:00Z");
store = learnLabel(store, "apple",  appleTrain.descriptor,  "baby-watches-apple.mp4 (15 frames)",  "2026-07-06T00:00:00Z");
saveStore(STORE, store);
console.log(`\n  → stored 'orange' and 'apple' at ${STORE}`);

// --- Test on unseen stills ---
console.log("\n=== TESTING on stills (unseen — not in training) ===\n");

async function testStill(imgName) {
  const p = path.join(FIXTURES, imgName);
  const rgb = await extractImageRGB(p, { maxSize: 384 });
  const entities = attentionOnRGB(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  const pick = pickWarmUnion(entities, rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  const testDesc = pick ? pick.descriptor : null;
  const distances = {};
  for (const row of store.labels) {
    distances[row.label] = testDesc ? descriptorDistance(testDesc, row.descriptor) : Infinity;
  }
  const winner = Object.entries(distances).sort((a, b) => a[1] - b[1])[0];
  const rec = testDesc ? recognize(testDesc, store, { max_distance: 2.0 }) : null;
  console.log(`  ${imgName.padEnd(15)} → nearest: ${winner[0]} (d=${winner[1].toFixed(3)})   distances: ${Object.entries(distances).map(([k,v]) => `${k}=${v.toFixed(3)}`).join(", ")}   confidence=${(rec?.confidence ?? 0).toFixed(2)}`);
  return { imgName, distances, winner: winner[0], winnerDist: winner[1], confidence: rec?.confidence ?? 0 };
}

const tests = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];
const results = [];
for (const t of tests) results.push(await testStill(t));

// --- Verdict ---
console.log("\n=== VERDICT ===");
const expected = { "orange.jpg": "orange", "apple.jpg": "apple", "fruits.jpg": "orange", "lena.jpg": null };
let correct = 0, total = 0;
for (const r of results) {
  const want = expected[r.imgName];
  total++;
  if (want === null) {
    // No orange, no apple — hope for LOW confidence (system says "I don't know")
    const rejected = r.confidence < 0.20;
    if (rejected) { correct++; console.log(`  ${r.imgName.padEnd(15)} EXPECT no-strong-match — GOT ${r.winner} conf=${r.confidence.toFixed(2)} — ${rejected ? "✓ correctly uncertain" : "✗ spurious high confidence"}`); }
    else console.log(`  ${r.imgName.padEnd(15)} EXPECT no-strong-match — GOT ${r.winner} conf=${r.confidence.toFixed(2)} — ✗ spurious high confidence`);
  } else {
    const right = r.winner === want;
    if (right) correct++;
    console.log(`  ${r.imgName.padEnd(15)} EXPECT '${want}' — GOT '${r.winner}' d=${r.winnerDist.toFixed(3)} — ${right ? "✓" : "✗"}`);
  }
}
console.log(`\nOVERALL: ${correct}/${total} correct`);
console.log(`\nstore: ${STORE}`);
