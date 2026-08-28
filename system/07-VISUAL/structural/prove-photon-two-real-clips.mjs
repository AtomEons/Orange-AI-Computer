#!/usr/bin/env bun
// prove-photon-two-real-clips.mjs — Alpha Wolf Eyes true-real-world test.
//
// No synthesis. Take TWO different video clips of the same concept (real
// illuminant differences, real camera differences, real content differences).
// Compare canonical outputs.
//
// The hardest test: same concept but genuinely different scenes (different
// camera, angle, background, actual light) — canonical should still be
// SIMILAR to same-concept frames, and MORE DIFFERENT from different-concept
// frames.

import fs from "node:fs";
import path from "node:path";
import { extractVideoFrames } from "./video-frames.mjs";
import { captureCanonicalPhoton, canonicalPhotonMSE } from "./photon-canonical.mjs";

const CORPUS = "C:/AtomEons/Orange5/07-VISUAL/fixtures/youtube-corpus";

async function grabFrames(dir, maxClips = 2) {
  const p = path.join(CORPUS, dir);
  if (!fs.existsSync(p)) return [];
  const clips = fs.readdirSync(p).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).slice(0, maxClips);
  const out = [];
  for (const c of clips) {
    try {
      const [f] = await extractVideoFrames(path.join(p, c), { frames: 1, size: 384 });
      if (f) out.push({ clip: c, frame: f });
    } catch (e) { /* skip */ }
  }
  return out;
}

function fullReg(f) { return { x: 0, y: 0, w: f.width, h: f.height }; }

console.log("=== ALPHA WOLF EYES — TWO REAL CLIPS OF SAME CONCEPT ===\n");

const dirs = fs.readdirSync(CORPUS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const candidates = ["orange", "banana", "apple", "carrot", "tomato", "watermelon", "lemon", "grape"].filter(d => dirs.includes(d));
if (candidates.length < 2) { console.error("need >= 2 object dirs"); process.exit(1); }
console.log("Testing pairs from:", candidates.join(", "));
console.log();

// Compute canonical for 2 clips per candidate, then all-pairs MSE
const canons = {};
for (const label of candidates) {
  const fs2 = await grabFrames(label, 2);
  if (fs2.length < 1) continue;
  canons[label] = fs2.map(({ clip, frame }) => ({ clip, canon: captureCanonicalPhoton(frame, fullReg(frame)) }));
}

console.log("Cross-clip MSE within same concept vs across concepts:\n");
const rows = [];
for (const labelA of Object.keys(canons)) {
  for (const labelB of Object.keys(canons)) {
    const listA = canons[labelA];
    const listB = canons[labelB];
    if (!listA.length || !listB.length) continue;
    if (labelA === labelB && listA.length < 2) continue;
    const mses = [];
    for (let i = 0; i < listA.length; i++) {
      for (let j = 0; j < listB.length; j++) {
        if (labelA === labelB && i >= j) continue;
        mses.push(canonicalPhotonMSE(listA[i].canon, listB[j].canon));
      }
    }
    if (!mses.length) continue;
    const avg = mses.reduce((a, x) => a + x, 0) / mses.length;
    rows.push({ pair: labelA + " ↔ " + labelB, avg_mse: avg, n_pairs: mses.length, same: labelA === labelB });
  }
}
rows.sort((a, b) => a.avg_mse - b.avg_mse);
for (const r of rows) {
  const tag = r.same ? "[SAME]" : "[DIFF]";
  console.log(tag + " " + r.pair.padEnd(30) + " avg MSE = " + r.avg_mse.toExponential(3) + "  (over " + r.n_pairs + " pair(s))");
}

const samePairs = rows.filter(r => r.same);
const diffPairs = rows.filter(r => !r.same);
if (samePairs.length && diffPairs.length) {
  const avgSame = samePairs.reduce((a, r) => a + r.avg_mse, 0) / samePairs.length;
  const avgDiff = diffPairs.reduce((a, r) => a + r.avg_mse, 0) / diffPairs.length;
  console.log("\n== SUMMARY ==");
  console.log("mean same-concept MSE : " + avgSame.toExponential(3));
  console.log("mean diff-concept MSE : " + avgDiff.toExponential(3));
  console.log("separation ratio      : " + (avgDiff / Math.max(1e-12, avgSame)).toExponential(3));
  if (avgDiff > avgSame) console.log("verdict: SAME-CONCEPT clusters BELOW DIFFERENT-CONCEPT — PASS");
  else console.log("verdict: same-concept MSE >= diff-concept — investigate content variability");
}
