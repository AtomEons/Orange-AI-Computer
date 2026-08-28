#!/usr/bin/env bun
// scaling-attack.mjs — Wave 1b of AE7-driven remediation.
//
// Measures the empirical concept capacity of the AEyes¹ substrate.
// Starting from the 5-concept baseline, add synthesized concepts one by
// one (each is a hue-rotated union descriptor from an existing concept
// via skin-tone-synthesis) and after each addition compute:
//
//   1. inter-concept min pairwise richDistance (the operating margin)
//   2. self-recognition score on the original 5 held-out fixtures
//
// The N at which either:
//   (a) inter-concept min-distance drops below current ceiling 1.8, or
//   (b) baseline recognition breaks
// IS the empirical concept capacity. Publish that number.
//
// This makes AE7 finding #5 measurable instead of anecdotal.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { extractImageRGB } from "../prism.mjs";
import { activeCurate } from "../ingest/active-curation.mjs";
import { attachSignaturesV2, richDistance, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";
import { hueRotateSignature } from "./skin-tone-synthesis.mjs";
import {
  extractWarmEntities,
  signatureForUnion,
  recognizeHumanGradeImage,
  HUMAN_GRADE_CEILING,
  HUMAN_GRADE_WEIGHTS,
} from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");

async function trainConceptFromVideo(videoPath, N = 15, K = 8) {
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  const sigs = [];
  for (const f of frames) {
    const warm = extractWarmEntities(f, { useLoose: false });
    if (!warm.length) continue;
    const s = signatureForUnion(f, warm);
    if (s) sigs.push(s);
  }
  const cur = activeCurate(sigs, K);
  return cur.selected.map((i) => sigs[i]);
}
async function trainConceptFromImage(name, loose) {
  const rgb = await extractImageRGB(path.join(FIXTURES, name), { maxSize: 384 });
  const warm = extractWarmEntities(rgb, { useLoose: loose });
  if (!warm.length) return [];
  const s = signatureForUnion(rgb, warm);
  return s ? [s] : [];
}

console.log("=== SCALING ATTACK HARNESS — Wave 1b ===\n");
console.log("Ceiling: " + HUMAN_GRADE_CEILING);
console.log("Method: add synthetic concepts (hue-rotated from orange) one by one; measure inter-concept min-distance + baseline recognition\n");

const STORE = { labels: [] };

// Base 5 concepts (same as prove-human-grade)
console.log("training base 5 concepts...");
attachSignaturesV2(STORE, "orange", await trainConceptFromVideo(path.join(CINEMA, "baby-watches-orange.mp4")), "cinema", "2026-07-07");
attachSignaturesV2(STORE, "apple",  await trainConceptFromVideo(path.join(CINEMA, "baby-watches-apple.mp4")),  "cinema", "2026-07-07");
attachSignaturesV2(STORE, "human_skin",      await trainConceptFromImage("lena.jpg",   false), "lena",   "2026-07-07");
attachSignaturesV2(STORE, "animal_face",     await trainConceptFromImage("baboon.jpg", true),  "baboon", "2026-07-07");
attachSignaturesV2(STORE, "yellow_building", await trainConceptFromImage("home.jpg",   true),  "home",   "2026-07-07");
for (const row of STORE.labels) row.channel_weights = HUMAN_GRADE_WEIGHTS;
console.log("  baseline store: " + STORE.labels.length + " concepts");

// Compute inter-concept min pairwise richDistance across ALL sig pairs
function interConceptMinDistance(store) {
  let minD = Infinity;
  let pair = [null, null];
  for (let i = 0; i < store.labels.length; i++) {
    for (let j = i + 1; j < store.labels.length; j++) {
      const w = HUMAN_GRADE_WEIGHTS;
      for (const s1 of store.labels[i].signatures) for (const s2 of store.labels[j].signatures) {
        const d = richDistance(s1.sig, s2.sig, w);
        if (d < minD) { minD = d; pair = [store.labels[i].label, store.labels[j].label]; }
      }
    }
  }
  return { min: minD, pair };
}

// Score the 3 genuine held-out static targets (orange.jpg, apple.jpg, fruits.jpg)
async function scoreBaseline(store) {
  const targets = [
    { name: "orange.jpg", expected: "orange", loose: false },
    { name: "apple.jpg",  expected: "apple",  loose: false },
    { name: "fruits.jpg", expected: "orange", loose: false },
  ];
  let ok = 0;
  for (const t of targets) {
    const r = await recognizeHumanGradeImage(path.join(FIXTURES, t.name), store, { useLoose: t.loose });
    if (r.emit_action === "recognized_as" && r.winner === t.expected) ok++;
  }
  return ok + "/3";
}

// Baseline reading
let base = interConceptMinDistance(STORE);
let baseScore = await scoreBaseline(STORE);
console.log("\nBaseline (5 concepts):");
console.log("  inter-concept min-distance: " + base.min.toFixed(3) + "  (pair: " + base.pair.join(" ↔ ") + ")");
console.log("  operating margin under ceiling 1.8: " + (base.min - HUMAN_GRADE_CEILING).toFixed(3));
console.log("  genuine held-out target score: " + baseScore);

// Add synthetic concepts by hue-rotating orange one at a time
// Use small angular steps to force concept collision detection
const ANGULAR_STEPS_DEG = [10, 25, 40, 55, 70, 85, 100, 115, 130, 145, 160, 180, 200, 220, 240, 260, 280, 300, 320, 340];
const orangeRow = STORE.labels.find(r => r.label === "orange");
if (!orangeRow) { console.log("no orange row"); process.exit(1); }

console.log("\n--- SCALING RUN (adding hue-rotated synthetics) ---");
let stopped = false;
let empiricalCapacity = STORE.labels.length;
let firstCollisionAtN = null;
let baselineBreakAtN = null;
const trace = [];
for (let step = 0; step < ANGULAR_STEPS_DEG.length; step++) {
  const deg = ANGULAR_STEPS_DEG[step];
  const rad = deg * Math.PI / 180;
  const rotated = orangeRow.signatures.map(s => ({ sig: hueRotateSignature(s.sig, rad) }));
  const label = "synth_" + deg + "deg";
  attachSignaturesV2(STORE, label, rotated.map(r => r.sig), "hue-rotated-orange", "2026-07-07");
  const N = STORE.labels.length;
  const dm = interConceptMinDistance(STORE);
  const marginUnderCeiling = dm.min - HUMAN_GRADE_CEILING;
  const score = await scoreBaseline(STORE);
  const scoreN = parseInt(score.split("/")[0], 10);

  const line = "N=" + String(N).padStart(3) + "  min_inter_dist=" + dm.min.toFixed(3).padStart(6) +
               "  (pair " + dm.pair.join("↔").padEnd(24) + ")" +
               "  margin=" + marginUnderCeiling.toFixed(3).padStart(6) +
               "  baseline=" + score;
  console.log("  " + line);
  trace.push({ N, min_inter_dist: dm.min, pair: dm.pair, margin_under_ceiling: marginUnderCeiling, baseline_score: score });

  // First inter-concept collision under ceiling
  if (firstCollisionAtN === null && dm.min < HUMAN_GRADE_CEILING) {
    firstCollisionAtN = N;
    console.log("     ↑ first collision detected: inter-concept min-distance < ceiling 1.8");
  }
  // Baseline break
  if (baselineBreakAtN === null && scoreN < 3) {
    baselineBreakAtN = N;
    console.log("     ↑ baseline recognition broke: " + score);
    empiricalCapacity = N - 1;
    stopped = true;
    break;
  }
  empiricalCapacity = N;
}

console.log("\n=== SCALING VERDICT ===");
console.log("Baseline concepts: 5");
console.log("Concepts added: " + (empiricalCapacity - 5) + " synthetic hue-rotated variants");
console.log("Empirical capacity BEFORE baseline break: N=" + empiricalCapacity);
console.log("First inter-concept collision under ceiling 1.8: " + (firstCollisionAtN ?? "not observed within " + ANGULAR_STEPS_DEG.length + " synthetic additions"));
console.log("Baseline recognition break: " + (baselineBreakAtN ?? "not observed"));
if (!stopped && firstCollisionAtN === null) {
  console.log("");
  console.log("Substrate held above ceiling for the full synthetic sweep. Larger corpus (Wave 2) required to see collision.");
}

// Persist the trace as JSON for the receipt
const outPath = path.join(FIXTURES, "perfect-eyes", "scaling-attack-trace.json");
fs.writeFileSync(outPath, JSON.stringify({ ceiling: HUMAN_GRADE_CEILING, baseline_N: 5, empirical_capacity: empiricalCapacity, first_collision_at_N: firstCollisionAtN, baseline_break_at_N: baselineBreakAtN, trace }, null, 2));
console.log("\nTrace written: " + outPath);
