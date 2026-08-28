#!/usr/bin/env bun
// prove-photon-temporal.mjs — Alpha Wolf Eyes multi-frame temporal canonical.
//
// Extracts a short frame sequence from a real video clip, runs the sequence
// through captureCanonicalPhotonSequence, and reports:
//   - per-frame single-canonical MSE (baseline)
//   - inter-frame temporal channel presence
//   - motion signature (ON/OFF transient + 4 direction-selective channels)
//
// Success: temporal channels are non-empty when the scene has motion, near-
// zero when frames are static. Direction-selective channels align with
// dominant motion direction.

import fs from "node:fs";
import path from "node:path";
import { extractVideoFrames } from "./video-frames.mjs";
import { captureCanonicalPhotonSequence, canonicalPhotonMSE } from "./photon-canonical.mjs";

const CORPUS = "C:/AtomEons/Orange5/07-VISUAL/fixtures/youtube-corpus";

async function loadFrames(dir, nFrames = 4) {
  const p = path.join(CORPUS, dir);
  const clips = fs.readdirSync(p).filter(f => /\.(mp4|mkv|webm)$/i.test(f));
  if (!clips.length) return null;
  return await extractVideoFrames(path.join(p, clips[0]), { frames: nFrames, size: 384 });
}

function channelStats(map, nChannels) {
  const nPix = map.length / nChannels;
  const stats = [];
  for (let c = 0; c < nChannels; c++) {
    let s = 0, mx = 0;
    for (let i = 0; i < nPix; i++) {
      const v = map[i * nChannels + c];
      s += v; if (v > mx) mx = v;
    }
    stats.push({ mean: s / nPix, max: mx });
  }
  return stats;
}

console.log("=== ALPHA WOLF EYES — TEMPORAL CANONICAL (MULTI-FRAME) ===\n");

const dirs = fs.readdirSync(CORPUS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const testDirs = ["orange", "banana"].filter(d => dirs.includes(d));
if (!testDirs.length) { console.error("no test dirs"); process.exit(1); }

for (const dir of testDirs) {
  console.log("--- " + dir + " ---");
  const frames = await loadFrames(dir, 4);
  if (!frames || frames.length < 2) { console.log("  fewer than 2 frames extracted, skip"); continue; }
  console.log("  extracted " + frames.length + " frames");

  const seq = await captureCanonicalPhotonSequence(frames, { computeFlow: true });
  console.log("  canonical sequence produced: " + seq.length + " canonicals");

  // Per-frame same-scene consistency (adjacent frames should be very similar)
  for (let i = 0; i < seq.length - 1; i++) {
    const mse = canonicalPhotonMSE(seq[i], seq[i + 1]);
    console.log("  MSE(frame " + i + " ↔ frame " + (i + 1) + ") = " + mse.toExponential(3));
    if (seq[i + 1].temporal_map) {
      const stats = channelStats(seq[i + 1].temporal_map, seq[i + 1].temporal_channels);
      const names = seq[i + 1].temporal_channels === 6
        ? ["ON-trans", "OFF-trans", "DS-up", "DS-down", "DS-left", "DS-right"]
        : ["ON-trans", "OFF-trans"];
      const summary = stats.map((s, k) => names[k] + ":" + s.mean.toFixed(3)).join(", ");
      console.log("    temporal: " + summary);
      const maxOf = (idx) => stats[idx].max;
      const dirMax = seq[i + 1].temporal_channels === 6
        ? [
            { name: "up", v: maxOf(2) },
            { name: "down", v: maxOf(3) },
            { name: "left", v: maxOf(4) },
            { name: "right", v: maxOf(5) },
          ]
        : [];
      if (dirMax.length) {
        dirMax.sort((a, b) => b.v - a.v);
        console.log("    dominant motion: " + dirMax[0].name + " (max=" + dirMax[0].v.toFixed(3) + ")");
      }
    }
  }
  console.log();
}
