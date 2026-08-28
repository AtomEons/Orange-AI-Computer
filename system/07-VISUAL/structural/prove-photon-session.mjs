#!/usr/bin/env bun
// prove-photon-session.mjs — Alpha Wolf Eyes session-state adaptation bench.
//
// Runs multiple clips of the SAME concept through a persistent AWESession.
// After N frames the session's running illuminant estimate stabilizes,
// simulating a human eye adapting to a room. Result: canonical outputs across
// clips should become MORE consistent than per-clip independent processing.
//
// Same-concept cross-clip separation ratio should improve vs the stateless
// pipeline (prove-photon-two-real-clips baseline).

import fs from "node:fs";
import path from "node:path";
import { extractVideoFrames } from "./video-frames.mjs";
import { captureCanonicalPhoton, captureCanonicalPhotonSession, AWESession, canonicalPhotonMSE } from "./photon-canonical.mjs";

const CORPUS = "C:/AtomEons/Orange5/07-VISUAL/fixtures/youtube-corpus";

async function loadFrames(dir, nClips = 2, framesPerClip = 3) {
  const p = path.join(CORPUS, dir);
  if (!fs.existsSync(p)) return [];
  const clips = fs.readdirSync(p).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).slice(0, nClips);
  const all = [];
  for (const c of clips) {
    try {
      const fs2 = await extractVideoFrames(path.join(p, c), { frames: framesPerClip, size: 384 });
      all.push({ clip: c, frames: fs2 });
    } catch (e) { /* skip */ }
  }
  return all;
}

function fullRegion(f) { return { x: 0, y: 0, w: f.width, h: f.height }; }

console.log("=== ALPHA WOLF EYES — SESSION-STATE ADAPTATION ===\n");

const dirs = fs.readdirSync(CORPUS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const candidates = ["orange", "banana", "apple", "carrot", "tomato", "watermelon", "lemon", "grape"].filter(d => dirs.includes(d));

// Compare: per-frame (baseline) vs session (adapted)
const perFrameCanons = {};
const sessionCanons = {};

for (const label of candidates) {
  const clips = await loadFrames(label, 2, 3);
  if (clips.length < 1) continue;
  const stateless = [];
  const session = new AWESession({ tau: 0.7 });
  const stateful = [];
  for (const { clip, frames } of clips) {
    for (const f of frames) {
      stateless.push({ clip, canon: captureCanonicalPhoton(f, fullRegion(f)) });
      stateful.push({ clip, canon: captureCanonicalPhotonSession(f, session, fullRegion(f)) });
    }
  }
  perFrameCanons[label] = stateless;
  sessionCanons[label] = stateful;
}

function pairwise(canonsByLabel, tag) {
  const labels = Object.keys(canonsByLabel);
  const rows = [];
  for (const la of labels) {
    for (const lb of labels) {
      const A = canonsByLabel[la], B = canonsByLabel[lb];
      if (!A.length || !B.length) continue;
      const mses = [];
      for (let i = 0; i < A.length; i++) {
        for (let j = 0; j < B.length; j++) {
          if (la === lb && i >= j) continue;
          mses.push(canonicalPhotonMSE(A[i].canon, B[j].canon));
        }
      }
      if (!mses.length) continue;
      const avg = mses.reduce((a, x) => a + x, 0) / mses.length;
      rows.push({ pair: la + " ↔ " + lb, avg_mse: avg, n: mses.length, same: la === lb });
    }
  }
  const sameM = rows.filter(r => r.same);
  const diffM = rows.filter(r => !r.same);
  const meanSame = sameM.reduce((a, r) => a + r.avg_mse, 0) / Math.max(1, sameM.length);
  const meanDiff = diffM.reduce((a, r) => a + r.avg_mse, 0) / Math.max(1, diffM.length);
  console.log("[" + tag + "] mean same-concept MSE = " + meanSame.toExponential(3) + " · mean diff-concept MSE = " + meanDiff.toExponential(3) + " · separation " + (meanDiff / Math.max(1e-12, meanSame)).toFixed(3) + "x");
}

pairwise(perFrameCanons, "per-frame (baseline)");
pairwise(sessionCanons, "session-adapted");
