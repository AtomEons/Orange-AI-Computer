#!/usr/bin/env bun
// Depth first light — real temporal + spatial depth primitives.
//
// The operator's directive:
//   "it appears to be that we need a temporal + spatial system for accurate
//    depth perception, not a gimmick like current 2d to 3d tricks. im looking
//    for actual."
//
// This experiment runs three depth channels and reports honestly.
//
// Temporal:
//   - Block-matching optical flow (real per-cell (u,v) displacement)
//   - Depth from motion parallax: closer objects move more per frame
//
// Spatial (monocular, no learned priors):
//   - Sharpness map (local Laplacian variance) — near focal plane = closer
//   - Ground-plane prior — y-position → depth
//   - Aerial perspective — 1 - saturation (weak outdoor cue)
//
// Fusion:
//   - Weighted sum of all cues, per pixel
//
// Test on:
//   1. Adjacent frames from baby-watches-orange.mp4 → OF depth
//   2. Static stills orange.jpg, apple.jpg, fruits.jpg → mono depth
//   3. Per-entity depth from cinema v3 attention → depth-tagged entities

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { blockMatchFlow, depthFromFlow, upsampleField } from "../optical-flow.mjs";
import {
  sharpnessMap, groundPlanePrior, aerialPerspectiveMap,
  fuseDepthCues, depthSummary, entityMeanDepth,
} from "../mono-depth.mjs";
import { flowDivergenceAndCurl } from "../flow-geometry.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const OUT = path.join(FIXTURES, "depth-first-light");
fs.mkdirSync(OUT, { recursive: true });

function toLuminance(R, G, B) {
  const N = R.length;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  return L;
}

console.log("=== DEPTH FIRST LIGHT (temporal + spatial) ===\n");

// -------- TEMPORAL: optical flow depth on baby-watches-orange.mp4 --------
console.log("STEP 1: extracting adjacent frames from baby-watches-orange.mp4");
const frames = await extractVideoFrames(path.join(CINEMA, "baby-watches-orange.mp4"), { frames: 6, size: 384 });
console.log(`  ${frames.length} frames loaded (${frames[0].width}x${frames[0].height})\n`);

console.log("STEP 2: block-matching optical flow between consecutive frames");
const OF_BLOCK = 16, OF_R = 8;
const flowStats = [];
for (let i = 0; i + 1 < frames.length; i++) {
  const L1 = toLuminance(frames[i].R, frames[i].G, frames[i].B);
  const L2 = toLuminance(frames[i + 1].R, frames[i + 1].G, frames[i + 1].B);
  const flow = blockMatchFlow(L1, L2, frames[i].width, frames[i].height, { blockSize: OF_BLOCK, searchRadius: OF_R });
  const geom = flowDivergenceAndCurl(flow.vx, flow.vy, flow.cols, flow.rows);
  console.log(`  frame ${i}→${i+1}: cols×rows=${flow.cols}×${flow.rows}  meanMag=${flow.meanMagnitude.toFixed(2)}px  maxMag=${flow.maxMagnitude.toFixed(1)}px  div-energy=${geom.divergenceEnergyMean.toFixed(3)}  curl-energy=${geom.curlEnergyMean.toFixed(3)}  boundaryScore=${geom.boundaryScore.toFixed(3)}`);
  flowStats.push({ pair: `${i}→${i+1}`, meanMag: flow.meanMagnitude, maxMag: flow.maxMagnitude, divEnergy: geom.divergenceEnergyMean, curlEnergy: geom.curlEnergyMean, boundaryScore: geom.boundaryScore });
}

// -------- SPATIAL: monocular depth on natural stills --------
console.log("\nSTEP 3: monocular depth on natural stills");
const STILLS = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];
const monoResults = {};
for (const name of STILLS) {
  const rgb = await extractImageRGB(path.join(FIXTURES, name), { maxSize: 384 });
  const L = toLuminance(rgb.R, rgb.G, rgb.B);

  const sharpness = sharpnessMap(L, rgb.width, rgb.height, 5);
  const ground = groundPlanePrior(rgb.width, rgb.height, { horizonFrac: 0.4 });
  const aerial = aerialPerspectiveMap(rgb.R, rgb.G, rgb.B);

  // Cue weights — sharpness dominates on closeups; ground for scenes with ground.
  // We pass all three and let the reader judge.
  const fused = fuseDepthCues([
    { map: sharpness, weight: 0.5 },
    { map: ground, weight: 0.3 },
    { map: aerial, weight: 0.2 },
  ]);

  const sSum = depthSummary(sharpness);
  const gSum = depthSummary(ground);
  const aSum = depthSummary(aerial);
  const fSum = depthSummary(fused);
  console.log(`  ${name.padEnd(15)} sharp[μ=${sSum.mean.toFixed(3)},σ=${sSum.std.toFixed(3)},range=${sSum.range.toFixed(3)}]  aerial[μ=${aSum.mean.toFixed(3)}]  fused[μ=${fSum.mean.toFixed(3)},σ=${fSum.std.toFixed(3)}]`);

  monoResults[name] = { sharpness: sSum, ground: gSum, aerial: aSum, fused: fSum, width: rgb.width, height: rgb.height };

  // Attention entities + their fused depth
  const combo = attentionMultiAxisV2(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, { axes: ["R","G","B","L","M","gamma","RG","BY"], minVotes: 1 });
  const entDepths = [];
  for (const e of combo.entities.slice(0, 8)) {
    const d = entityMeanDepth(e.region, fused, rgb.width, rgb.height);
    entDepths.push({ region: e.region, depth: d, votes: e.votes });
  }
  entDepths.sort((a, b) => a.depth - b.depth);
  console.log(`    top entities by depth (nearest first):`);
  for (const ed of entDepths.slice(0, 5)) {
    console.log(`      region=[${ed.region.join(",")}] votes=${ed.votes} fused_depth=${ed.depth.toFixed(3)} ${ed.depth < 0.4 ? "← near" : ed.depth > 0.6 ? "← far" : ""}`);
  }
  monoResults[name].entities = entDepths;
}

// -------- COMBINED: OF depth + mono depth on video frames --------
console.log("\nSTEP 4: fused depth (OF + monocular) on middle video frame");
{
  const i = Math.floor(frames.length / 2);
  const f = frames[i];
  const L1 = toLuminance(f.R, f.G, f.B);
  const L2 = toLuminance(frames[i + 1].R, frames[i + 1].G, frames[i + 1].B);
  const flow = blockMatchFlow(L1, L2, f.width, f.height, { blockSize: OF_BLOCK, searchRadius: OF_R });
  const ofDepthBlock = depthFromFlow(flow.vx, flow.vy, flow.confidence);
  const ofDepth = upsampleField(ofDepthBlock, flow.cols, flow.rows, f.width, f.height, OF_BLOCK);
  const sharpness = sharpnessMap(L1, f.width, f.height, 5);
  const aerial = aerialPerspectiveMap(f.R, f.G, f.B);
  const fused = fuseDepthCues([
    { map: ofDepth, weight: 0.4 },
    { map: sharpness, weight: 0.4 },
    { map: aerial, weight: 0.2 },
  ]);
  const s = depthSummary(fused);
  console.log(`  video-frame fused: μ=${s.mean.toFixed(3)}  σ=${s.std.toFixed(3)}  range=${s.range.toFixed(3)}`);
  console.log(`  OF alone:  μ=${depthSummary(ofDepth).mean.toFixed(3)}  σ=${depthSummary(ofDepth).std.toFixed(3)}`);
  console.log(`  sharpness: μ=${depthSummary(sharpness).mean.toFixed(3)}  σ=${depthSummary(sharpness).std.toFixed(3)}`);
}

// -------- AUDIT MiDaS GAP --------
console.log("\n=== AUDIT: what MiDaS/ZoeDepth has that we don't ===");
const gaps = [
  { we_have: "block-matching OF (deterministic, no learning)",
    midas_has: "learned depth prior across millions of images",
    what_we_lack: "scene-context depth (indoor vs outdoor, foreground vs background regularities)" },
  { we_have: "sharpness / defocus map",
    midas_has: "semantic depth (roads are usually ground, walls are vertical planes)",
    what_we_lack: "object-category depth priors" },
  { we_have: "ground-plane prior (naive y-based)",
    midas_has: "horizon estimation + tilted-camera correction",
    what_we_lack: "camera-pose-aware ground-plane geometry" },
  { we_have: "aerial perspective (saturation → depth)",
    midas_has: "atmospheric-scattering-informed pixel-level depth",
    what_we_lack: "learned scattering coefficients" },
  { we_have: "flow-geometry div/curl (boundary detector)",
    midas_has: "consistent depth boundaries via learned edge features",
    what_we_lack: "learned edge-depth coherence" },
  { we_have: "PER-ENTITY depth reporting (mean depth over attention region)",
    midas_has: "dense per-pixel depth with sub-pixel precision",
    what_we_lack: "sub-pixel depth granularity" },
];
console.log(`\nWe have: 4 real classical depth channels + fusion.`);
console.log(`We lack: learned scene priors, semantic depth, camera-pose awareness.\n`);
for (const g of gaps) {
  console.log(`▸ we have:  ${g.we_have}`);
  console.log(`  MiDaS has: ${g.midas_has}`);
  console.log(`  we lack:  ${g.what_we_lack}\n`);
}

// -------- HONEST VERDICT --------
console.log("=== HONEST VERDICT ===");
console.log("Real temporal + spatial depth primitives are now on the board:");
console.log("  · block-matching optical flow (per-cell (u,v) displacement)");
console.log("  · depth-from-flow (motion parallax → relative depth)");
console.log("  · sharpness map (defocus proxy)");
console.log("  · ground-plane prior");
console.log("  · aerial perspective");
console.log("  · flow-geometry div/curl (boundary from motion discontinuity)");
console.log("");
console.log("What we can HONESTLY compute now:");
console.log("  · Relative depth ordering of moving objects in a video (motion parallax)");
console.log("  · Per-entity mean depth from attention regions");
console.log("  · Depth-tagged entity ranking (nearest-first)");
console.log("");
console.log("What we CANNOT do (MiDaS gap):");
console.log("  · Absolute-scale depth in meters");
console.log("  · Depth on a single still with high accuracy");
console.log("  · Semantic depth priors (roads/walls/sky)");
console.log("  · Camera-pose-aware corrections");
console.log("");
console.log("Deliverables:");
fs.writeFileSync(path.join(OUT, "flow-stats.json"), JSON.stringify(flowStats, null, 2));
fs.writeFileSync(path.join(OUT, "mono-results.json"), JSON.stringify(monoResults, null, 2));
console.log(`  ${path.join(OUT, "flow-stats.json")}`);
console.log(`  ${path.join(OUT, "mono-results.json")}`);
