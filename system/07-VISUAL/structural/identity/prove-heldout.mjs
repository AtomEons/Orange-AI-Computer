#!/usr/bin/env bun
// prove-heldout.mjs — the HONEST validator.
//
// Wave 1a of the AE7-driven remediation:
// Train from the FIRST temporal half of each video, test on the SECOND
// temporal half. No frame is ever both trained and tested. This is the
// honest generalization measurement AEyes¹ owes the receipt.
//
// Extra concepts (human_skin / animal_face / yellow_building) that only
// have a single exemplar are EXCLUDED from the held-out validation and
// noted in the report. They are structurally incapable of a held-out
// score without additional distinct photographs.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { extractImageRGB } from "../prism.mjs";
import { activeCurate } from "../ingest/active-curation.mjs";
import { attachSignaturesV2 } from "./identity-store-v2.mjs";
import {
  extractWarmEntities,
  signatureForUnion,
  recognizeHumanGradeFrame,
  recognizeHumanGradeImage,
  HUMAN_GRADE_CEILING,
  HUMAN_GRADE_WEIGHTS,
} from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");

const N_TOTAL_FRAMES = 20;
const TRAIN_HALF = 10;

async function extractDisjointHalves(videoPath) {
  const frames = await extractVideoFrames(videoPath, { frames: N_TOTAL_FRAMES, size: 384 });
  return {
    trainFrames: frames.slice(0, TRAIN_HALF),
    testFrames: frames.slice(TRAIN_HALF),
  };
}

function buildStoreSignatures(trainFrames, K = 8) {
  const sigs = [];
  for (const f of trainFrames) {
    const warm = extractWarmEntities(f, { useLoose: false });
    if (!warm.length) continue;
    const s = signatureForUnion(f, warm);
    if (s) sigs.push(s);
  }
  if (!sigs.length) return [];
  const cur = activeCurate(sigs, Math.min(K, sigs.length));
  return cur.selected.map((i) => sigs[i]);
}

console.log("=== HELD-OUT VALIDATOR — Wave 1a ===\n");
console.log("Discipline: train on FIRST-half video frames, test on SECOND-half. No overlap.\n");
console.log("Ceiling: " + HUMAN_GRADE_CEILING + " (unchanged from smoke test)");
console.log("Frames per video: " + N_TOTAL_FRAMES + " total (" + TRAIN_HALF + " train / " + (N_TOTAL_FRAMES - TRAIN_HALF) + " test)\n");

const STORE = { labels: [] };

console.log("splitting orange video...");
const orange = await extractDisjointHalves(path.join(CINEMA, "baby-watches-orange.mp4"));
const orangeSigs = buildStoreSignatures(orange.trainFrames);
attachSignaturesV2(STORE, "orange", orangeSigs, "cinema-first-half", "2026-07-07T00:00:00Z");
console.log("  train=" + orange.trainFrames.length + "  test=" + orange.testFrames.length + "  sigs=" + orangeSigs.length);

console.log("splitting apple video...");
const apple = await extractDisjointHalves(path.join(CINEMA, "baby-watches-apple.mp4"));
const appleSigs = buildStoreSignatures(apple.trainFrames);
attachSignaturesV2(STORE, "apple", appleSigs, "cinema-first-half", "2026-07-07T00:00:00Z");
console.log("  train=" + apple.trainFrames.length + "  test=" + apple.testFrames.length + "  sigs=" + appleSigs.length);

for (const row of STORE.labels) row.channel_weights = HUMAN_GRADE_WEIGHTS;

console.log("");
console.log("NOTE: human_skin / animal_face / yellow_building excluded — only one exemplar exists");
console.log("      Wave 2 (YouTube corpus) will provide multi-exemplar training for those concepts.");
console.log("");

// TEST 1: score orange test frames
console.log("--- ORANGE (held-out test frames) ---");
let orangeCorrect = 0, orangeConfWrong = 0;
for (let i = 0; i < orange.testFrames.length; i++) {
  const r = recognizeHumanGradeFrame(orange.testFrames[i], STORE, { useLoose: false });
  const ok = r.emit_action === "recognized_as" && r.winner === "orange";
  const wrong = r.emit_action === "recognized_as" && r.winner !== "orange";
  if (ok) orangeCorrect++;
  if (wrong) orangeConfWrong++;
  const mark = ok ? "✓" : (wrong ? "✗" : "?");
  console.log("  " + mark + " frame[" + (TRAIN_HALF + i) + "]  winner=" + (r.winner || "-").padEnd(6) + " dist=" + r.dist.toFixed(3).padStart(6) + "  emit=" + r.emit_action);
}
console.log("orange held-out: " + orangeCorrect + " / " + orange.testFrames.length + " correct · " + orangeConfWrong + " confident-wrong");

// TEST 2: score apple test frames
console.log("\n--- APPLE (held-out test frames) ---");
let appleCorrect = 0, appleConfWrong = 0;
for (let i = 0; i < apple.testFrames.length; i++) {
  const r = recognizeHumanGradeFrame(apple.testFrames[i], STORE, { useLoose: false });
  const ok = r.emit_action === "recognized_as" && r.winner === "apple";
  const wrong = r.emit_action === "recognized_as" && r.winner !== "apple";
  if (ok) appleCorrect++;
  if (wrong) appleConfWrong++;
  const mark = ok ? "✓" : (wrong ? "✗" : "?");
  console.log("  " + mark + " frame[" + (TRAIN_HALF + i) + "]  winner=" + (r.winner || "-").padEnd(6) + " dist=" + r.dist.toFixed(3).padStart(6) + "  emit=" + r.emit_action);
}
console.log("apple held-out: " + appleCorrect + " / " + apple.testFrames.length + " correct · " + appleConfWrong + " confident-wrong");

// TEST 3: score reject fixtures (never trained)
console.log("\n--- REJECTS (never trained on any) ---");
const REJECTS = [
  { name: "basketball1.png", loose: false },
  { name: "basketball2.png", loose: false },
  { name: "messi5.jpg",      loose: true  },
  { name: "building.jpg",    loose: false },
  { name: "board.jpg",       loose: false },
  { name: "gradient.png",    loose: false },
  { name: "notes.png",       loose: false },
  { name: "butterfly.jpg",   loose: true  },
  { name: "pic5.png",        loose: true  },
  { name: "starry_night.jpg", loose: true },
];
let rejectCorrect = 0, rejectConfWrong = 0;
for (const rej of REJECTS) {
  const r = await recognizeHumanGradeImage(path.join(FIXTURES, rej.name), STORE, { useLoose: rej.loose });
  const ok = r.emit_action === "needs_review";
  if (ok) rejectCorrect++;
  else rejectConfWrong++;
  const mark = ok ? "✓" : "✗";
  const distStr = r.dist === Infinity ? "  ∞  " : r.dist.toFixed(3);
  console.log("  " + mark + " " + rej.name.padEnd(18) + " winner=" + (r.winner || "-").padEnd(6) + " dist=" + distStr + "  emit=" + r.emit_action);
}
console.log("rejects: " + rejectCorrect + " / " + REJECTS.length + " correct · " + rejectConfWrong + " confident-wrong");

// Also probe original static fixtures which SHOULD still match
console.log("\n--- ORIGINAL STATIC FIXTURES (orange.jpg, apple.jpg, fruits.jpg — still target for orange/apple) ---");
const staticTargets = [
  { name: "orange.jpg", expected: "orange", loose: false },
  { name: "apple.jpg",  expected: "apple",  loose: false },
  { name: "fruits.jpg", expected: "orange", loose: false },
];
let staticCorrect = 0, staticConfWrong = 0;
for (const t of staticTargets) {
  const r = await recognizeHumanGradeImage(path.join(FIXTURES, t.name), STORE, { useLoose: t.loose });
  const ok = r.emit_action === "recognized_as" && r.winner === t.expected;
  const wrong = r.emit_action === "recognized_as" && r.winner !== t.expected;
  if (ok) staticCorrect++;
  if (wrong) staticConfWrong++;
  const mark = ok ? "✓" : (wrong ? "✗" : "?");
  const distStr = r.dist === Infinity ? "  ∞  " : r.dist.toFixed(3);
  console.log("  " + mark + " " + t.name.padEnd(18) + " expect=" + t.expected.padEnd(6) + " winner=" + (r.winner || "-").padEnd(6) + " dist=" + distStr + "  emit=" + r.emit_action);
}
console.log("original static targets: " + staticCorrect + " / " + staticTargets.length + " correct · " + staticConfWrong + " confident-wrong");

// SUMMARY
const totalTests = orange.testFrames.length + apple.testFrames.length + REJECTS.length + staticTargets.length;
const totalCorrect = orangeCorrect + appleCorrect + rejectCorrect + staticCorrect;
const totalConfWrong = orangeConfWrong + appleConfWrong + rejectConfWrong + staticConfWrong;
const pct = Math.round(totalCorrect / totalTests * 100);
console.log("\n=== HELD-OUT SCORE ===");
console.log("Orange held-out frames: " + orangeCorrect + "/" + orange.testFrames.length);
console.log("Apple  held-out frames: " + appleCorrect + "/" + apple.testFrames.length);
console.log("Reject fixtures:        " + rejectCorrect + "/" + REJECTS.length);
console.log("Static targets:         " + staticCorrect + "/" + staticTargets.length);
console.log("");
console.log("TOTAL: " + totalCorrect + "/" + totalTests + " = " + pct + "%");
console.log("Confident-wrong (real independent definition): " + totalConfWrong);
console.log("");
if (totalConfWrong === 0 && totalCorrect === totalTests) {
  console.log("✅ HONEST 100% ON HELD-OUT SET");
  process.exit(0);
} else {
  console.log("Honest baseline established. Confident-wrong=" + totalConfWrong + " · gap=" + (totalTests - totalCorrect));
  // exit 0 anyway — this is a measurement, not a gate
  process.exit(0);
}
