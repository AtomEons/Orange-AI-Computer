#!/usr/bin/env bun
// Baby watches cinema — v3.
//
// The operator's directive:
//   "you have to layeer it on a r, g, b, L, M
//    red, green, blue, light, mono, maybe gamma"
//
// Widen the axis basis. Instead of Y+RG+BY (v2, 3 axes), run attention on:
//   R, G, B — each raw color channel
//   L       — Rec.601 luminance
//   M       — unweighted mean brightness
//   gamma   — gamma-corrected luminance
// Plus optionally keep RG, BY. Total: 6 or 8 axes.
//
// Compare 3-axis (v2 baseline) vs 6-axis (operator's ask) vs 8-axis (superset).

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2, DEFAULT_AXES, WIDE_AXES } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { computeDescriptor, computeUnionDescriptor, aggregateDescriptors, descriptorDistance } from "./descriptor.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const OUT = path.join(FIXTURES, "baby-learn");
fs.mkdirSync(OUT, { recursive: true });

const V2_AXES = ["L", "RG", "BY"];               // strategy B baseline (renamed L instead of Y for clarity)
const V3_6_AXES = ["R", "G", "B", "L", "M", "gamma"];
const V3_8_AXES = ["R", "G", "B", "L", "M", "gamma", "RG", "BY"];

const STRATEGIES = [
  { key: "v2_3", label: "v2 baseline (L+RG+BY)", axes: V2_AXES },
  { key: "v3_6", label: "v3 wide (R+G+B+L+M+gamma)", axes: V3_6_AXES },
  { key: "v3_8", label: "v3 superset (R+G+B+L+M+gamma+RG+BY)", axes: V3_8_AXES },
];

// Chromatic-warm rule from sweep-108 winner
const WARM_RG_MIN = 0.02;
const WARM_R_MINUS_B_MIN = 0.25;
const MAX_DIST = 1.0;      // sweep-108 empirical threshold

function isWarm(d) {
  return d
    && d.mean_RG > WARM_RG_MIN
    && d.mean_R > d.mean_B + WARM_R_MINUS_B_MIN
    && d.mean_R + d.mean_G > 0.5
    && d.mean_B < 0.5;
}

function warmUnion(entities, R, G, B, width, height) {
  const warm = [];
  for (const e of entities) {
    const d = computeDescriptor(e.region, R, G, B, width, height);
    if (isWarm(d)) warm.push(e);
  }
  if (!warm.length) return null;
  return { descriptor: computeUnionDescriptor(warm.map(w => w.region), R, G, B, width, height), count: warm.length };
}

async function watchVideo(videoPath, axes, N = 15) {
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  const perFrame = [];
  for (const f of frames) {
    const combo = attentionMultiAxisV2(f.R, f.G, f.B, f.width, f.height, { axes, minVotes: 1, preproc: "gaussian_1" });
    const wu = warmUnion(combo.entities, f.R, f.G, f.B, f.width, f.height);
    if (wu) perFrame.push(wu.descriptor);
  }
  if (!perFrame.length) return { yield: 0, N: frames.length, descriptor: null };
  return { yield: perFrame.length, N: frames.length, descriptor: aggregateDescriptors(perFrame) };
}

async function testStill(imgPath, axes, store) {
  const rgb = await extractImageRGB(imgPath, { maxSize: 384 });
  const combo = attentionMultiAxisV2(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, { axes, minVotes: 1, preproc: "gaussian_1" });
  const wu = warmUnion(combo.entities, rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  if (!wu) return { winner: null, winnerDist: Infinity, distances: {} };
  const dists = {};
  for (const k of Object.keys(store)) dists[k] = descriptorDistance(wu.descriptor, store[k]);
  const sorted = Object.entries(dists).sort((a, b) => a[1] - b[1]);
  return { winner: sorted[0][0], winnerDist: sorted[0][1], distances: dists };
}

console.log("=== BABY WATCHES CINEMA v3 — wide axis basis ===\n");
console.log(`  warm rule: RG > ${WARM_RG_MIN}, R - B > ${WARM_R_MINUS_B_MIN}`);
console.log(`  reject threshold: max_distance = ${MAX_DIST}\n`);

const TESTS = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];
const EXPECTED = { "orange.jpg": "orange", "apple.jpg": "apple", "fruits.jpg": "orange", "lena.jpg": null };

const results = {};
for (const s of STRATEGIES) {
  console.log(`\n▸ [${s.key}] ${s.label}  axes=[${s.axes.join(", ")}]`);

  const orangeT = await watchVideo(path.join(CINEMA, "baby-watches-orange.mp4"), s.axes);
  const appleT  = await watchVideo(path.join(CINEMA, "baby-watches-apple.mp4"), s.axes);
  console.log(`  yields: orange=${orangeT.yield}/${orangeT.N}, apple=${appleT.yield}/${appleT.N}`);
  if (!orangeT.descriptor || !appleT.descriptor) {
    console.log(`  ! could not train both labels — skipping tests`);
    results[s.key] = { trained: false };
    continue;
  }
  console.log(`  trained descriptors:`);
  console.log(`    orange: R=${orangeT.descriptor.mean_R.toFixed(3)} G=${orangeT.descriptor.mean_G.toFixed(3)} B=${orangeT.descriptor.mean_B.toFixed(3)} RG=${orangeT.descriptor.mean_RG.toFixed(3)} BY=${orangeT.descriptor.mean_BY.toFixed(3)}`);
  console.log(`    apple:  R=${appleT.descriptor.mean_R.toFixed(3)} G=${appleT.descriptor.mean_G.toFixed(3)} B=${appleT.descriptor.mean_B.toFixed(3)} RG=${appleT.descriptor.mean_RG.toFixed(3)} BY=${appleT.descriptor.mean_BY.toFixed(3)}`);

  const store = { orange: orangeT.descriptor, apple: appleT.descriptor };
  let correct = 0, total = 0;
  const testDetails = {};
  for (const t of TESTS) {
    total++;
    const r = await testStill(path.join(FIXTURES, t), s.axes, store);
    testDetails[t] = r;
    const dStr = Object.entries(r.distances || {}).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(", ");
    const want = EXPECTED[t];
    if (want === null) {
      const rejected = r.winnerDist === Infinity || r.winnerDist > MAX_DIST;
      if (rejected) correct++;
      console.log(`  ${t.padEnd(15)} EXPECT no-match — GOT ${r.winner || "(no desc)"} d=${r.winnerDist === Infinity ? "∞" : r.winnerDist.toFixed(3)} — ${rejected ? "✓ rejected" : "✗ accepted spuriously"}   [${dStr}]`);
    } else {
      const right = r.winner === want && r.winnerDist <= MAX_DIST;
      if (right) correct++;
      console.log(`  ${t.padEnd(15)} EXPECT '${want}' — GOT '${r.winner || "(no desc)"}' d=${r.winnerDist === Infinity ? "∞" : r.winnerDist.toFixed(3)} — ${right ? "✓" : "✗"}   [${dStr}]`);
    }
  }
  console.log(`  → ${correct}/${total} correct`);
  results[s.key] = { trained: true, correct, total, testDetails, orangeDesc: orangeT.descriptor, appleDesc: appleT.descriptor, yields: { orange: orangeT.yield, apple: appleT.yield } };
}

console.log("\n=== SUMMARY ===");
for (const s of STRATEGIES) {
  const r = results[s.key];
  if (!r?.trained) console.log(`  [${s.key}] ${s.label}: DID NOT TRAIN`);
  else console.log(`  [${s.key}] ${s.label}: ${r.correct}/${r.total}`);
}

fs.writeFileSync(path.join(OUT, "cinema-v3-results.json"), JSON.stringify({ strategies: STRATEGIES, results, threshold: MAX_DIST }, null, 2));
console.log(`\nresults written: ${path.join(OUT, "cinema-v3-results.json")}`);
