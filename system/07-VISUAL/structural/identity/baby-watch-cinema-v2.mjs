#!/usr/bin/env bun
// Baby watches cinema — v2.
//
// The operator's directive:
//   "video is motion. think of it as fast single frames of photons, motion
//    infers, add word + motion + awareness + object recog you get a full
//    picture of the scene almost."
//
// Plus: use the tri-axis combo (Y+RG+BY) — the three regimes the
// 5000-experiment sweep found.
//
// This version:
//   1. Tri-axis attention combo per frame (Y+RG+BY, IoU-voting merge)
//   2. Motion field per adjacent-frame pair
//   3. Descriptor aggregation compared under THREE strategies:
//      A. warm-only union            (cinema v1 baseline)
//      B. tri-axis warm-only union   (attention layer upgrade)
//      C. motion-gated tri-axis warm (attention + motion filter)
//
// Reports per-strategy trained descriptor + per-strategy test distances.
// Honest comparison; no fake-green.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { preprocess } from "../binders/preprocessing.mjs";
import { postprocess } from "../binders/post-processing.mjs";
import { bind as densityBind } from "../binders/density-cluster.mjs";
import { attentionMultiAxis } from "../multi-axis-attention.mjs";
import { temporalDerivative, motionMaskAuto, entityMotionRatio, motionSummary } from "../motion.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import {
  computeDescriptor, computeUnionDescriptor,
  aggregateDescriptors, descriptorDistance,
} from "./descriptor.mjs";
import { loadStore, saveStore, learnLabel, recognize } from "./identity-store.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const OUT = path.join(FIXTURES, "baby-learn");
fs.mkdirSync(OUT, { recursive: true });
const STORE = path.join(OUT, "identity-store-cinema-v2.json");

// v1 baseline: Y-only single-axis attention (matches cinema v1 pipeline)
function attentionYOnly(cR, cG, cB, width, height) {
  const Y = new Float32Array(cR.length);
  for (let i = 0; i < cR.length; i++) Y[i] = 0.30 * cR[i] + 0.59 * cG[i] + 0.11 * cB[i];
  const pre = preprocess("gaussian_2", photoreceptorResponse(Y, initAdaptationState(), null).R, width, height);
  const raw = densityBind(pre.R2, width, height, {}).entities || [];
  const { entities } = postprocess("merge_overlap", raw, { frameArea: width * height });
  return entities;
}

// Chromatic-warm rule (same everywhere)
function isWarmDesc(d) {
  return d
    && d.mean_RG > 0.03
    && d.mean_R > d.mean_B + 0.15
    && d.mean_R + d.mean_G > 0.5
    && d.mean_B < 0.5;
}

// Warm-union descriptor from a set of entities
function warmUnion(entities, R, G, B, width, height) {
  const warm = [];
  for (const e of entities) {
    const d = computeDescriptor(e.region, R, G, B, width, height);
    if (isWarmDesc(d)) warm.push({ entity: e, descriptor: d });
  }
  if (!warm.length) return null;
  const regions = warm.map((w) => w.entity.region);
  const union = computeUnionDescriptor(regions, R, G, B, width, height);
  return { entities: warm.map((w) => w.entity), descriptor: union, count: warm.length };
}

// Motion-gated warm-union — like warmUnion but only entities where a
// fraction of pixels exceed the motion threshold.
function motionGatedWarmUnion(entities, R, G, B, width, height, mask, minMotionRatio = 0.15) {
  const warm = [];
  for (const e of entities) {
    const d = computeDescriptor(e.region, R, G, B, width, height);
    if (!isWarmDesc(d)) continue;
    const motionFrac = entityMotionRatio(e.region, mask, width, height);
    if (motionFrac >= minMotionRatio) warm.push({ entity: e, descriptor: d, motionFrac });
  }
  if (!warm.length) return null;
  const regions = warm.map((w) => w.entity.region);
  const union = computeUnionDescriptor(regions, R, G, B, width, height);
  return { entities: warm.map((w) => w.entity), descriptor: union, count: warm.length, motionFracs: warm.map(w => w.motionFrac) };
}

async function watchVideoV2(videoPath, label, N = 15) {
  console.log(`  extracting ${N} frames from ${path.basename(videoPath)}...`);
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  console.log(`  ${frames.length} frames loaded (${frames[0].width}x${frames[0].height})`);

  const perFrame = { A: [], B: [], C: [] };
  const yields = { A: 0, B: 0, C: 0 };
  const motionStats = [];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];

    // A. Y-only warm-union (v1 baseline)
    const ents_Y = attentionYOnly(f.R, f.G, f.B, f.width, f.height);
    const wA = warmUnion(ents_Y, f.R, f.G, f.B, f.width, f.height);
    if (wA) { perFrame.A.push(wA.descriptor); yields.A++; }

    // B. Tri-axis (union of Y+RG+BY combo entities)
    const combo = attentionMultiAxis(f.R, f.G, f.B, f.width, f.height, { minVotes: 1 });
    const wB = warmUnion(combo.entities, f.R, f.G, f.B, f.width, f.height);
    if (wB) { perFrame.B.push(wB.descriptor); yields.B++; }

    // C. Motion-gated tri-axis
    let wC = null;
    if (i + 1 < frames.length) {
      const M = temporalDerivative(f, frames[i + 1]);
      const mm = motionMaskAuto(M, 0.75);
      motionStats.push(motionSummary(M));
      wC = motionGatedWarmUnion(combo.entities, f.R, f.G, f.B, f.width, f.height, mm.mask, 0.15);
    } else if (i > 0) {
      const M = temporalDerivative(frames[i - 1], f);
      const mm = motionMaskAuto(M, 0.75);
      motionStats.push(motionSummary(M));
      wC = motionGatedWarmUnion(combo.entities, f.R, f.G, f.B, f.width, f.height, mm.mask, 0.15);
    }
    if (wC) { perFrame.C.push(wC.descriptor); yields.C++; }
  }

  console.log(`  strategy yields: A(Y-only)=${yields.A}/${frames.length}  B(tri-axis)=${yields.B}/${frames.length}  C(motion-gated)=${yields.C}/${frames.length}`);
  if (motionStats.length) {
    const mm = motionStats.reduce((a, b) => ({ mean: a.mean + b.mean, max: Math.max(a.max, b.max), std: a.std + b.std }), { mean: 0, max: 0, std: 0 });
    console.log(`  motion: mean=${(mm.mean/motionStats.length).toFixed(4)} avg-std=${(mm.std/motionStats.length).toFixed(4)} max=${mm.max.toFixed(4)}  (higher = more between-frame motion)`);
  }

  const agg = {};
  for (const k of ["A", "B", "C"]) agg[k] = perFrame[k].length ? aggregateDescriptors(perFrame[k]) : null;

  return { yields, aggregated: agg, motionStats };
}

console.log("=== BABY WATCHES CINEMA v2 (tri-axis + motion) ===\n");

console.log("STEP 1: baby watches baby-watches-orange.mp4 — parent says 'orange'");
const orangeTrain = await watchVideoV2(path.join(CINEMA, "baby-watches-orange.mp4"), "orange", 15);

console.log("\nSTEP 2: baby watches baby-watches-apple.mp4 — parent says 'apple'");
const appleTrain = await watchVideoV2(path.join(CINEMA, "baby-watches-apple.mp4"), "apple", 15);

// Build three separate stores, one per strategy
const stores = { A: { labels: [] }, B: { labels: [] }, C: { labels: [] } };
for (const strat of ["A", "B", "C"]) {
  if (orangeTrain.aggregated[strat]) {
    stores[strat] = learnLabel(stores[strat], "orange", orangeTrain.aggregated[strat], `baby-watches-orange.mp4 [${strat}]`, "2026-07-06T00:00:00Z");
  }
  if (appleTrain.aggregated[strat]) {
    stores[strat] = learnLabel(stores[strat], "apple", appleTrain.aggregated[strat], `baby-watches-apple.mp4 [${strat}]`, "2026-07-06T00:00:00Z");
  }
}
saveStore(STORE, stores);

console.log("\n=== TRAINED DESCRIPTORS ===");
for (const strat of ["A", "B", "C"]) {
  const nameMap = { A: "Y-only (v1 baseline)", B: "tri-axis (Y+RG+BY combo)", C: "motion-gated tri-axis" };
  console.log(`\n[${strat}] ${nameMap[strat]}:`);
  for (const row of stores[strat].labels) {
    const d = row.descriptor;
    console.log(`  ${row.label.padEnd(6)} R=${d.mean_R.toFixed(3)} G=${d.mean_G.toFixed(3)} B=${d.mean_B.toFixed(3)} RG=${d.mean_RG.toFixed(3)} BY=${d.mean_BY.toFixed(3)}`);
  }
}

// Test on stills
console.log("\n=== TESTING on stills ===\n");

async function testStill(imgName) {
  const p = path.join(FIXTURES, imgName);
  const rgb = await extractImageRGB(p, { maxSize: 384 });

  // Compute test descriptor per strategy — for A use Y-only warm-union; for B/C use tri-axis warm-union (no motion at test time — single still)
  const testDescs = {};
  const ents_Y = attentionYOnly(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  const wA = warmUnion(ents_Y, rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  testDescs.A = wA?.descriptor ?? null;

  const combo = attentionMultiAxis(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, { minVotes: 1 });
  const wB = warmUnion(combo.entities, rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  testDescs.B = wB?.descriptor ?? null;
  testDescs.C = wB?.descriptor ?? null; // no motion for still — use tri-axis attention for both

  const perStrat = {};
  for (const strat of ["A", "B", "C"]) {
    const store = stores[strat];
    const desc = testDescs[strat];
    if (!desc || !store.labels.length) { perStrat[strat] = null; continue; }
    const dists = {};
    for (const row of store.labels) dists[row.label] = descriptorDistance(desc, row.descriptor);
    const winner = Object.entries(dists).sort((a, b) => a[1] - b[1])[0];
    perStrat[strat] = { winner: winner[0], winnerDist: winner[1], distances: dists };
  }
  return { imgName, perStrat };
}

const tests = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];
const expected = { "orange.jpg": "orange", "apple.jpg": "apple", "fruits.jpg": "orange", "lena.jpg": null };

const results = [];
for (const t of tests) results.push(await testStill(t));

for (const strat of ["A", "B", "C"]) {
  const nameMap = { A: "Y-only (v1 baseline)", B: "tri-axis (Y+RG+BY)", C: "motion-gated tri-axis" };
  console.log(`\n[${strat}] ${nameMap[strat]}:`);
  let correct = 0, total = 0;
  for (const r of results) {
    const ps = r.perStrat[strat];
    if (!ps) { console.log(`  ${r.imgName.padEnd(15)} NO DESCRIPTOR`); continue; }
    total++;
    const want = expected[r.imgName];
    const distStr = Object.entries(ps.distances).map(([k,v]) => `${k}=${v.toFixed(3)}`).join(", ");
    if (want === null) {
      // no-fruit image — success if winner distance is HIGH (i.e., >1.5)
      const rejected = ps.winnerDist > 1.5;
      if (rejected) correct++;
      console.log(`  ${r.imgName.padEnd(15)} EXPECT no-strong-match — GOT ${ps.winner} d=${ps.winnerDist.toFixed(3)} — ${rejected ? "✓ far" : "✗ spurious close"}   [${distStr}]`);
    } else {
      const right = ps.winner === want;
      if (right) correct++;
      console.log(`  ${r.imgName.padEnd(15)} EXPECT '${want}' — GOT '${ps.winner}' d=${ps.winnerDist.toFixed(3)} — ${right ? "✓" : "✗"}   [${distStr}]`);
    }
  }
  console.log(`  → ${correct}/${total} correct`);
}
console.log(`\nstore written: ${STORE}`);
