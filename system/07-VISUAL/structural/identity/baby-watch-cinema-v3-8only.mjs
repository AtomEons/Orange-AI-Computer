#!/usr/bin/env bun
// Isolated re-run of the 8-axis strategy (v3_8) after ffmpeg timeout.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { computeDescriptor, computeUnionDescriptor, aggregateDescriptors, descriptorDistance } from "./descriptor.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");

const AXES = ["R", "G", "B", "L", "M", "gamma", "RG", "BY"];
const WARM_RG_MIN = 0.02, WARM_R_MINUS_B_MIN = 0.25, MAX_DIST = 1.0;

function isWarm(d) {
  return d && d.mean_RG > WARM_RG_MIN && d.mean_R > d.mean_B + WARM_R_MINUS_B_MIN && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5;
}
function warmUnion(entities, R, G, B, w, h) {
  const warm = [];
  for (const e of entities) { const d = computeDescriptor(e.region, R, G, B, w, h); if (isWarm(d)) warm.push(e); }
  if (!warm.length) return null;
  return computeUnionDescriptor(warm.map(x => x.region), R, G, B, w, h);
}
async function watchVideo(videoPath, N = 15) {
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  const perFrame = [];
  for (const f of frames) {
    const combo = attentionMultiAxisV2(f.R, f.G, f.B, f.width, f.height, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
    const desc = warmUnion(combo.entities, f.R, f.G, f.B, f.width, f.height);
    if (desc) perFrame.push(desc);
  }
  return perFrame.length ? { yield: perFrame.length, N: frames.length, descriptor: aggregateDescriptors(perFrame) } : null;
}

console.log("=== CINEMA v3_8 isolated re-run ===");
console.log(`  axes=[${AXES.join(", ")}]  minVotes=1  preproc=gaussian_1  threshold=${MAX_DIST}\n`);

const orangeT = await watchVideo(path.join(CINEMA, "baby-watches-orange.mp4"));
const appleT  = await watchVideo(path.join(CINEMA, "baby-watches-apple.mp4"));
console.log(`orange yield: ${orangeT?.yield ?? 0}/15`);
console.log(`apple yield: ${appleT?.yield ?? 0}/15`);

if (!orangeT || !appleT) { console.log("training failed"); process.exit(1); }

console.log(`\ntrained descriptors:`);
console.log(`  orange: R=${orangeT.descriptor.mean_R.toFixed(3)} G=${orangeT.descriptor.mean_G.toFixed(3)} B=${orangeT.descriptor.mean_B.toFixed(3)} RG=${orangeT.descriptor.mean_RG.toFixed(3)} BY=${orangeT.descriptor.mean_BY.toFixed(3)}`);
console.log(`  apple:  R=${appleT.descriptor.mean_R.toFixed(3)} G=${appleT.descriptor.mean_G.toFixed(3)} B=${appleT.descriptor.mean_B.toFixed(3)} RG=${appleT.descriptor.mean_RG.toFixed(3)} BY=${appleT.descriptor.mean_BY.toFixed(3)}`);

const store = { orange: orangeT.descriptor, apple: appleT.descriptor };
const TESTS = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];
const EXPECTED = { "orange.jpg": "orange", "apple.jpg": "apple", "fruits.jpg": "orange", "lena.jpg": null };

console.log("\ntesting:");
let correct = 0;
for (const t of TESTS) {
  const rgb = await extractImageRGB(path.join(FIXTURES, t), { maxSize: 384 });
  const combo = attentionMultiAxisV2(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const desc = warmUnion(combo.entities, rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  const want = EXPECTED[t];
  if (!desc) {
    const ok = (want === null);
    if (ok) correct++;
    console.log(`  ${t.padEnd(15)} EXPECT ${want ?? "no-match"} — (no descriptor) — ${ok ? "✓ rejected" : "✗"}`);
    continue;
  }
  const dists = {};
  for (const k of Object.keys(store)) dists[k] = descriptorDistance(desc, store[k]);
  const sorted = Object.entries(dists).sort((a, b) => a[1] - b[1]);
  const winner = sorted[0][0], winnerDist = sorted[0][1];
  const dStr = Object.entries(dists).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(", ");
  if (want === null) {
    const ok = winnerDist > MAX_DIST;
    if (ok) correct++;
    console.log(`  ${t.padEnd(15)} EXPECT no-match — GOT ${winner} d=${winnerDist.toFixed(3)} — ${ok ? "✓ rejected" : "✗ spurious"}   [${dStr}]`);
  } else {
    const ok = winner === want && winnerDist <= MAX_DIST;
    if (ok) correct++;
    console.log(`  ${t.padEnd(15)} EXPECT '${want}' — GOT '${winner}' d=${winnerDist.toFixed(3)} — ${ok ? "✓" : "✗"}   [${dStr}]`);
  }
}
console.log(`\n→ v3_8: ${correct}/4`);
