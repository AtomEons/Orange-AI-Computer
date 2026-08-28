#!/usr/bin/env bun
// prove-wave2-heldout.mjs — Wave 2c validator.
//
// Given a Wave 2 YouTube-corpus identity store, run held-out validation:
//   For each concept in the store, pick 1 held-out clip that was NOT
//   part of training (last downloaded video in the concept's dir), extract
//   frames, and score recognition.
//
// Every video is a temporal held-out for concept it trained. Wave 2 ingest
// keeps all downloaded videos in fixtures/youtube-corpus/{label}/. We split:
//   - First N-1 videos → training (already used, sigs in store)
//   - Last video → held-out test
//
// This gives us:
//   - Cross-video generalization score (train on 4 clips, test on 5th)
//   - The empirical accuracy curve at N=30 (or however many concepts landed)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { recognizeHumanGradeFrame, HUMAN_GRADE_WEIGHTS } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) { console.error("usage: bun prove-wave2-heldout.mjs store.json [--multiscale] [--hue-any]"); process.exit(2); }
const storePath = argv[0];
const enableMultiScale = argv.includes("--multiscale");
const enableHueAny = argv.includes("--hue-any");
const enableCeiling22 = argv.includes("--ceiling-2.2");   // higher ceiling for cross-source
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

const globalOpts = {
  multiScale: enableMultiScale,
  ceiling: enableCeiling22 ? 2.2 : undefined,
};
console.log("Mode:  multiScale=" + enableMultiScale + "  hue_any=" + enableHueAny + "  ceiling=" + (enableCeiling22 ? "2.2" : "1.8"));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

console.log("=== WAVE 2c — held-out validation on YouTube corpus ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);
console.log("");

// Verify per-concept weights populated
for (const row of STORE.labels) {
  if (!row.channel_weights) row.channel_weights = HUMAN_GRADE_WEIGHTS;
}

// For each concept, find held-out video (last one alphabetically since we can't easily know order)
let totalCorrect = 0, totalTested = 0, totalConfWrong = 0;
const conceptResults = [];

for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) { console.log("[SKIP] " + row.label + " — no corpus dir"); continue; }
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f));
  if (files.length < 2) { console.log("[SKIP] " + row.label + " — need >=2 videos for held-out (has " + files.length + ")"); continue; }
  // Use LAST video as held-out (arbitrary but consistent)
  const heldOut = path.join(dir, files.sort().at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 8, size: 384 }); }
  catch (e) { console.log("[FAIL frame extract] " + row.label + ": " + e.message); continue; }
  let correct = 0, confWrong = 0;
  const frameResults = [];
  for (let i = 0; i < frames.length; i++) {
    const useLoose = /animal|cat|dog|elephant|lion|giraffe|horse|building|house|castle|book|chair|clock|mountain|forest|ocean|snow|bicycle|airplane|boat|banana|watermelon|grape|carrot/.test(row.label);
    const perFrameOpts = enableHueAny
      ? { ...globalOpts, hue_gate: "any" }
      : { ...globalOpts, useLoose };
    const r = recognizeHumanGradeFrame(frames[i], STORE, perFrameOpts);
    const ok = r.emit_action === "recognized_as" && r.winner === row.label;
    const wrong = r.emit_action === "recognized_as" && r.winner !== row.label;
    if (ok) correct++;
    if (wrong) confWrong++;
    frameResults.push({ ok, wrong, winner: r.winner, dist: r.dist, confidence: r.confidence });
  }
  const pct = Math.round(correct / frames.length * 100);
  const line = row.label.padEnd(20) + " " + correct + "/" + frames.length + " = " + String(pct).padStart(3) + "%  confWrong=" + confWrong;
  console.log("  " + line);
  totalCorrect += correct;
  totalTested += frames.length;
  totalConfWrong += confWrong;
  conceptResults.push({ label: row.label, correct, tested: frames.length, confWrong, frameResults });
}

console.log("");
const pct = Math.round(totalCorrect / totalTested * 100);
console.log("=== WAVE 2c HELD-OUT SCORE ===");
console.log("Total correct: " + totalCorrect + " / " + totalTested + " = " + pct + "%");
console.log("Total confident-wrong: " + totalConfWrong);
console.log("Concepts tested: " + conceptResults.length);

// Store trace
const tracePath = storePath.replace(/\.json$/, "-wave2c-trace.json");
fs.writeFileSync(tracePath, JSON.stringify({
  timestamp: new Date().toISOString(),
  store_path: storePath,
  overall: { correct: totalCorrect, tested: totalTested, pct, conf_wrong: totalConfWrong },
  by_concept: conceptResults.map(r => ({ label: r.label, correct: r.correct, tested: r.tested, conf_wrong: r.confWrong })),
}, null, 2));
console.log("Trace: " + tracePath);
