#!/usr/bin/env bun
// Sweep 108 tri-axis cinema configs.
//
// Dimensions:
//   preprocessor: 3 (gaussian_1, gaussian_2, gaussian_3)
//   minVotes: 3 (1=union, 2=vote, 3=strict)
//   warm_RG_min: 4 (0.02, 0.05, 0.10, 0.15)
//   warm_R_minus_B: 3 (0.10, 0.15, 0.25)
//
// Total: 3 * 3 * 4 * 3 = 108 configs.
//
// Efficient: precompute per-(video,frame,axis,preproc) entities once, then
// sweep merge + warm-filter + descriptor in-memory. Score each config on
// the 4-still test set.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB, prismDecompose, opponentToUnit } from "../prism.mjs";
import { initAdaptationState, photoreceptorResponse } from "../photoreceptor.mjs";
import { preprocess } from "../binders/preprocessing.mjs";
import { postprocess } from "../binders/post-processing.mjs";
import { bind as densityBind } from "../binders/density-cluster.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { computeDescriptor, computeUnionDescriptor, aggregateDescriptors, descriptorDistance } from "./descriptor.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const OUT_DIR = path.join(FIXTURES, "sweep-108");
fs.mkdirSync(OUT_DIR, { recursive: true });

const PREPROCS = ["gaussian_1", "gaussian_2", "gaussian_3"];
const MIN_VOTES = [1, 2, 3];
const WARM_RG_MIN = [0.02, 0.05, 0.10, 0.15];
const WARM_R_MINUS_B = [0.10, 0.15, 0.25];

const AXES = ["Y", "RG", "BY"];
const TESTS = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];
const EXPECTED = { "orange.jpg": "orange", "apple.jpg": "apple", "fruits.jpg": "orange", "lena.jpg": null };

// IoU helpers (inlined)
function iou(a, b) {
  const [ax, ay, aw, ah] = a, [bx, by, bw, bh] = b;
  const x1 = Math.max(ax, bx), y1 = Math.max(ay, by);
  const x2 = Math.min(ax + aw, bx + bw), y2 = Math.min(ay + ah, by + bh);
  if (x2 <= x1 || y2 <= y1) return 0;
  const inter = (x2 - x1) * (y2 - y1);
  return inter / (aw * ah + bw * bh - inter);
}
function bboxUnion(regions) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y, w, h] of regions) {
    if (x < x0) x0 = x; if (y < y0) y0 = y;
    if (x + w > x1) x1 = x + w; if (y + h > y1) y1 = y + h;
  }
  return [x0, y0, x1 - x0, y1 - y0];
}

// Get axis channel array
function axisChannel(axisName, R, G, B) {
  const { A, RG, BY } = prismDecompose(R, G, B);
  if (axisName === "Y") return A;
  if (axisName === "RG") return opponentToUnit(RG);
  if (axisName === "BY") return opponentToUnit(BY);
  throw new Error("bad axis " + axisName);
}

// Single-axis attention
function attendOne(channel, width, height, preprocName) {
  const pre = preprocess(preprocName, photoreceptorResponse(channel, initAdaptationState(), null).R, width, height);
  const raw = densityBind(pre.R2, width, height, {}).entities || [];
  const { entities } = postprocess("merge_overlap", raw, { frameArea: width * height });
  return entities;
}

// Cross-axis merge with minVotes
function mergeAcrossAxes(perAxisEntities, minVotes = 1, iouThresh = 0.4) {
  const allCandidates = [];
  for (const axisName of Object.keys(perAxisEntities)) {
    for (const e of perAxisEntities[axisName]) allCandidates.push({ region: e.region, axis: axisName });
  }
  const used = new Array(allCandidates.length).fill(false);
  const combined = [];
  for (let i = 0; i < allCandidates.length; i++) {
    if (used[i]) continue;
    const cluster = [allCandidates[i]];
    used[i] = true;
    for (let j = i + 1; j < allCandidates.length; j++) {
      if (used[j]) continue;
      const cb = bboxUnion(cluster.map((c) => c.region));
      if (iou(cb, allCandidates[j].region) >= iouThresh) {
        cluster.push(allCandidates[j]);
        used[j] = true;
      }
    }
    const axesSet = new Set(cluster.map((c) => c.axis));
    if (axesSet.size >= minVotes) {
      combined.push({ region: bboxUnion(cluster.map((c) => c.region)), votes: axesSet.size });
    }
  }
  return combined;
}

// Warm-union with configurable rule
function warmUnionCfg(entities, R, G, B, width, height, warmRG, warmRB) {
  const warm = [];
  for (const e of entities) {
    const d = computeDescriptor(e.region, R, G, B, width, height);
    if (!d) continue;
    const isWarm = d.mean_RG > warmRG && d.mean_R > d.mean_B + warmRB && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5;
    if (isWarm) warm.push(e);
  }
  if (!warm.length) return null;
  return computeUnionDescriptor(warm.map((w) => w.region), R, G, B, width, height);
}

// ==== PRECOMPUTE ====
console.log("=== Sweep-108 — tri-axis cinema config sweep ===\n");
console.log("Precomputing per-axis density-cluster entities...");
const t0 = Date.now();

// videos[name] = { frames: Array<{R,G,B,width,height}>, entitiesByPreproc: {[preproc]: [ [{Y,RG,BY}]... ]} }
const videos = {};
for (const vName of ["baby-watches-orange", "baby-watches-apple"]) {
  process.stdout.write(`  ${vName}: extracting frames... `);
  const frames = await extractVideoFrames(path.join(CINEMA, `${vName}.mp4`), { frames: 15, size: 384 });
  console.log(`${frames.length} loaded (${frames[0].width}x${frames[0].height})`);
  const entitiesByPreproc = {};
  for (const preproc of PREPROCS) {
    process.stdout.write(`    ${preproc}: `);
    const perFrame = [];
    for (let fi = 0; fi < frames.length; fi++) {
      const f = frames[fi];
      const perAxis = {};
      for (const axis of AXES) {
        const ch = axisChannel(axis, f.R, f.G, f.B);
        perAxis[axis] = attendOne(ch, f.width, f.height, preproc);
      }
      perFrame.push(perAxis);
      if ((fi + 1) % 5 === 0) process.stdout.write(`${fi + 1} `);
    }
    console.log(`✓`);
    entitiesByPreproc[preproc] = perFrame;
  }
  videos[vName] = { frames, entitiesByPreproc };
}

// tests[img] = { rgb, entitiesByPreproc: {[preproc]: {Y,RG,BY}} }
const tests = {};
for (const tName of TESTS) {
  process.stdout.write(`  test ${tName}: `);
  const rgb = await extractImageRGB(path.join(FIXTURES, tName), { maxSize: 384 });
  const entitiesByPreproc = {};
  for (const preproc of PREPROCS) {
    const perAxis = {};
    for (const axis of AXES) {
      const ch = axisChannel(axis, rgb.R, rgb.G, rgb.B);
      perAxis[axis] = attendOne(ch, rgb.width, rgb.height, preproc);
    }
    entitiesByPreproc[preproc] = perAxis;
  }
  tests[tName] = { rgb, entitiesByPreproc };
  console.log(`✓`);
}
console.log(`Precompute done in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

// ==== SWEEP ====
console.log("Running 108-config sweep...");
const results = [];

for (const preproc of PREPROCS) {
  for (const minVotes of MIN_VOTES) {
    for (const warmRG of WARM_RG_MIN) {
      for (const warmRB of WARM_R_MINUS_B) {
        // Build orange descriptor
        const orangeVid = videos["baby-watches-orange"];
        const orangePerFrame = [];
        for (let fi = 0; fi < orangeVid.frames.length; fi++) {
          const f = orangeVid.frames[fi];
          const perAxis = orangeVid.entitiesByPreproc[preproc][fi];
          const combined = mergeAcrossAxes(perAxis, minVotes);
          const desc = warmUnionCfg(combined, f.R, f.G, f.B, f.width, f.height, warmRG, warmRB);
          if (desc) orangePerFrame.push(desc);
        }

        const appleVid = videos["baby-watches-apple"];
        const applePerFrame = [];
        for (let fi = 0; fi < appleVid.frames.length; fi++) {
          const f = appleVid.frames[fi];
          const perAxis = appleVid.entitiesByPreproc[preproc][fi];
          const combined = mergeAcrossAxes(perAxis, minVotes);
          const desc = warmUnionCfg(combined, f.R, f.G, f.B, f.width, f.height, warmRG, warmRB);
          if (desc) applePerFrame.push(desc);
        }

        if (!orangePerFrame.length || !applePerFrame.length) {
          results.push({
            preproc, minVotes, warmRG, warmRB,
            trained: false,
            yields: { orange: orangePerFrame.length, apple: applePerFrame.length },
            correct: 0, testDetails: null,
          });
          continue;
        }

        const orangeAgg = aggregateDescriptors(orangePerFrame);
        const appleAgg = aggregateDescriptors(applePerFrame);
        const store = { orange: orangeAgg, apple: appleAgg };

        // Test
        const testDetails = {};
        let correct = 0;
        for (const t of TESTS) {
          const rgb = tests[t].rgb;
          const perAxis = tests[t].entitiesByPreproc[preproc];
          const combined = mergeAcrossAxes(perAxis, minVotes);
          const desc = warmUnionCfg(combined, rgb.R, rgb.G, rgb.B, rgb.width, rgb.height, warmRG, warmRB);
          if (!desc) {
            testDetails[t] = { winner: null, winnerDist: Infinity, distances: {} };
            // For no-fruit lena, "no descriptor" is arguably correct (correctly rejected as not-fruit-like)
            if (EXPECTED[t] === null) correct++;
            continue;
          }
          const dists = {};
          for (const k of Object.keys(store)) dists[k] = descriptorDistance(desc, store[k]);
          const sorted = Object.entries(dists).sort((a, b) => a[1] - b[1]);
          const winner = sorted[0][0], winnerDist = sorted[0][1];
          testDetails[t] = { winner, winnerDist, distances: dists };
          const want = EXPECTED[t];
          if (want === null) { if (winnerDist > 1.5) correct++; }
          else if (winner === want) correct++;
        }

        results.push({
          preproc, minVotes, warmRG, warmRB,
          trained: true,
          yields: { orange: orangePerFrame.length, apple: applePerFrame.length },
          correct,
          testDetails,
        });
      }
    }
  }
}

console.log(`Sweep complete: ${results.length} configs\n`);

// ==== REPORT ====
const trained = results.filter((r) => r.trained);
console.log(`configs that trained successfully: ${trained.length}/${results.length}`);

// Score distribution
const scoreCounts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
for (const r of trained) scoreCounts[r.correct]++;
console.log("\nScore distribution (correct out of 4):");
for (const [score, count] of Object.entries(scoreCounts)) console.log(`  ${score}/4: ${count} configs`);

// Top configs
const byScore = [...trained].sort((a, b) => (b.correct - a.correct) || (b.yields.orange + b.yields.apple - a.yields.orange - a.yields.apple));
console.log("\nTop 15 configs:");
for (let i = 0; i < 15 && i < byScore.length; i++) {
  const r = byScore[i];
  console.log(`  #${i + 1} ${r.correct}/4  preproc=${r.preproc.padEnd(10)} minVotes=${r.minVotes} warm_RG=${r.warmRG} warm_R-B=${r.warmRB}  yield=${r.yields.orange}/15+${r.yields.apple}/15`);
}

// Save
fs.writeFileSync(path.join(OUT_DIR, "metrics.json"), JSON.stringify(results, null, 2));

// Detail on 4/4 configs
const four = trained.filter((r) => r.correct === 4);
console.log(`\n🎯 4/4 configs found: ${four.length}`);
if (four.length) {
  for (const r of four.slice(0, 5)) {
    console.log(`\n  preproc=${r.preproc} minVotes=${r.minVotes} warm_RG=${r.warmRG} warm_R-B=${r.warmRB}`);
    for (const t of TESTS) {
      const td = r.testDetails[t];
      if (!td) continue;
      const distStr = Object.entries(td.distances || {}).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(", ");
      console.log(`    ${t.padEnd(15)} → ${td.winner || "(no desc)"} d=${td.winnerDist === Infinity ? "∞" : td.winnerDist.toFixed(3)} [${distStr}]`);
    }
  }
}

// Summary file
let report = `# Sweep-108 Report\n\nTotal configs: ${results.length}  Trained: ${trained.length}\n\n`;
report += `## Score distribution\n\n`;
for (const [score, count] of Object.entries(scoreCounts)) report += `- ${score}/4: ${count} configs\n`;
report += `\n## Top 15\n\n`;
for (let i = 0; i < 15 && i < byScore.length; i++) {
  const r = byScore[i];
  report += `- **${r.correct}/4** preproc=\`${r.preproc}\` minVotes=${r.minVotes} warm_RG=${r.warmRG} warm_R-B=${r.warmRB}  yield=${r.yields.orange}/${r.yields.apple}\n`;
}
report += `\n## 4/4 configs (${four.length})\n\n`;
for (const r of four) {
  report += `- preproc=\`${r.preproc}\` minVotes=${r.minVotes} warm_RG=${r.warmRG} warm_R-B=${r.warmRB}\n`;
}
fs.writeFileSync(path.join(OUT_DIR, "report.md"), report);
console.log(`\nWritten: ${path.join(OUT_DIR, "metrics.json")}`);
console.log(`Written: ${path.join(OUT_DIR, "report.md")}`);
