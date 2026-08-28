#!/usr/bin/env bun
// Monochromatic test — grayscale the world.
//
// Question: does the identity discrimination we saw in cinema v2 come from
// COLOR or from SHAPE / SPATIAL structure? Collapse RGB to a single gray
// channel (R=G=B=Y_601) at ingestion time and rerun the cinema experiment
// with the same pipeline. If discrimination survives, we have shape-carried
// identity. If it collapses, we have proof that identity is chromatic.
//
// Uses cinema v2 pipeline (tri-axis + motion, strategy B — tri-axis warm
// union, since motion is trivially zero on grayscale-rotated video).

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxis } from "../multi-axis-attention.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { computeDescriptor, computeUnionDescriptor, aggregateDescriptors, descriptorDistance } from "./descriptor.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");

// Collapse RGB → grayscale (all three channels get Y_601 value)
function grayify(R, G, B) {
  const N = R.length;
  const gR = new Float32Array(N);
  const gG = new Float32Array(N);
  const gB = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const Y = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
    gR[i] = Y; gG[i] = Y; gB[i] = Y;
  }
  return { R: gR, G: gG, B: gB };
}

// Under grayscale RGB=Y, the mean_RG and mean_BY of any region will be zero.
// So the warm rule (mean_RG > 0.03) will FAIL for all entities.
// We need a mono warm rule — just require reasonable brightness.
function isBrightDesc(d) {
  return d && (d.mean_R + d.mean_G + d.mean_B > 0.6);
}

function brightUnion(entities, R, G, B, width, height) {
  const bright = [];
  for (const e of entities) {
    const d = computeDescriptor(e.region, R, G, B, width, height);
    if (isBrightDesc(d)) bright.push({ entity: e, descriptor: d });
  }
  if (!bright.length) return null;
  const regions = bright.map((w) => w.entity.region);
  const union = computeUnionDescriptor(regions, R, G, B, width, height);
  return { entities: bright.map((w) => w.entity), descriptor: union, count: bright.length };
}

async function watchMono(videoPath, label, N = 15) {
  console.log(`  extracting ${N} frames from ${path.basename(videoPath)}...`);
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  console.log(`  ${frames.length} frames loaded`);
  const perFrame = [];
  let yield_ = 0;
  for (const f of frames) {
    const g = grayify(f.R, f.G, f.B);
    // Tri-axis on grayscale: RG and BY will be near-zero so effectively Y-only
    const combo = attentionMultiAxis(g.R, g.G, g.B, f.width, f.height, { minVotes: 1 });
    const bU = brightUnion(combo.entities, g.R, g.G, g.B, f.width, f.height);
    if (bU) { perFrame.push(bU.descriptor); yield_++; }
  }
  console.log(`  → ${yield_}/${frames.length} frames yielded bright content`);
  const agg = perFrame.length ? aggregateDescriptors(perFrame) : null;
  if (agg) {
    console.log(`  aggregated '${label}' MONO descriptor:`);
    console.log(`    R=${agg.mean_R.toFixed(3)} G=${agg.mean_G.toFixed(3)} B=${agg.mean_B.toFixed(3)} RG=${agg.mean_RG.toFixed(3)} BY=${agg.mean_BY.toFixed(3)}`);
  }
  return agg;
}

async function testStillMono(imgPath, store) {
  const rgb = await extractImageRGB(imgPath, { maxSize: 384 });
  const g = grayify(rgb.R, rgb.G, rgb.B);
  const combo = attentionMultiAxis(g.R, g.G, g.B, rgb.width, rgb.height, { minVotes: 1 });
  const bU = brightUnion(combo.entities, g.R, g.G, g.B, rgb.width, rgb.height);
  if (!bU) return { winner: null, distances: {} };
  const dists = {};
  for (const label of Object.keys(store)) dists[label] = descriptorDistance(bU.descriptor, store[label]);
  const sorted = Object.entries(dists).sort((a, b) => a[1] - b[1]);
  return { winner: sorted[0][0], winnerDist: sorted[0][1], distances: dists };
}

console.log("=== MONO CINEMA TEST — collapse to grayscale ===\n");
console.log("STEP 1: baby watches (mono) baby-watches-orange.mp4");
const orangeAgg = await watchMono(path.join(CINEMA, "baby-watches-orange.mp4"), "orange", 15);
console.log("\nSTEP 2: baby watches (mono) baby-watches-apple.mp4");
const appleAgg = await watchMono(path.join(CINEMA, "baby-watches-apple.mp4"), "apple", 15);

const store = { orange: orangeAgg, apple: appleAgg };

console.log("\n=== TESTING (mono) on stills ===\n");
const tests = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];
const expected = { "orange.jpg": "orange", "apple.jpg": "apple", "fruits.jpg": "orange", "lena.jpg": null };
let correct = 0, total = 0;
for (const t of tests) {
  const r = await testStillMono(path.join(FIXTURES, t), store);
  total++;
  const want = expected[t];
  const dStr = Object.entries(r.distances).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(", ");
  if (want === null) {
    const far = r.winnerDist > 1.5;
    if (far) correct++;
    console.log(`  ${t.padEnd(15)} EXPECT no-match — GOT ${r.winner} d=${r.winnerDist.toFixed(3)} — ${far ? "✓ far" : "✗ close"}   [${dStr}]`);
  } else {
    const right = r.winner === want;
    if (right) correct++;
    console.log(`  ${t.padEnd(15)} EXPECT '${want}' — GOT '${r.winner}' d=${r.winnerDist.toFixed(3)} — ${right ? "✓" : "✗"}   [${dStr}]`);
  }
}
console.log(`\nOVERALL (mono): ${correct}/${total} correct`);
console.log(`\n(cinema v2 color: 3/4 correct — see rcpt_57c7a6091d959344 seq 29 for comparison)`);
