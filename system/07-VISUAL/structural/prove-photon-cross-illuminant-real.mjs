#!/usr/bin/env bun
// prove-photon-cross-illuminant-real.mjs — Alpha Wolf Eyes real-image
// same-scene-under-two-illuminants test.
//
// Load a real JPEG, produce two views:
//   A: original
//   B: synthetically re-illuminated (multiply channels by warm→cool illuminant ratio)
// Feed both through captureCanonicalPhoton and compute canonicalPhotonMSE.
//
// Success criterion: MSE(A,B) → 0. Same physical scene, different illuminant
// should produce identical canonical output.
//
// Also test different-scene: MSE(A, D) with D = different real JPEG.
// Expected: MSE(A,B) << MSE(A,D).

import fs from "node:fs";
import path from "node:path";
import { extractVideoFrames } from "./video-frames.mjs";
import { captureCanonicalPhoton, canonicalPhotonMSE } from "./photon-canonical.mjs";

const CORPUS = "C:/AtomEons/Orange5/07-VISUAL/fixtures/youtube-corpus";

// Pull a mid-frame from a real object video.
async function frameFrom(dir) {
  const p = path.join(CORPUS, dir);
  const clips = fs.readdirSync(p).filter(f => /\.(mp4|mkv|webm)$/i.test(f));
  if (!clips.length) return null;
  const frames = await extractVideoFrames(path.join(p, clips[0]), { frames: 1, size: 384 });
  return frames?.[0] ?? null;
}

// Synthetic warming — conservative multipliers ≤1 so no channel clips.
// Physically = "same scene under warmer light" (attenuate G and B).
function reIlluminate(frame, ratio) {
  const R = new Float32Array(frame.R.length);
  const G = new Float32Array(frame.G.length);
  const B = new Float32Array(frame.B.length);
  for (let i = 0; i < R.length; i++) {
    R[i] = frame.R[i] * ratio[0];
    G[i] = frame.G[i] * ratio[1];
    B[i] = frame.B[i] * ratio[2];
  }
  return { R, G, B, width: frame.width, height: frame.height };
}

console.log("=== ALPHA WOLF EYES — CROSS-ILLUMINANT REAL-VIDEO-FRAME ===\n");

// Two colored-object concept dirs; pick from what exists.
const dirs = fs.readdirSync(CORPUS, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
const objectDirs = ["orange", "banana", "apple", "tomato", "carrot"].filter(d => dirs.includes(d));
if (objectDirs.length < 2) { console.error("need ≥ 2 object dirs; have: " + objectDirs.join(",")); process.exit(1); }
console.log("Image A: " + objectDirs[0] + " (real video frame)");
console.log("Image D: " + objectDirs[1] + " (real video frame)");
console.log();

const imgA = await frameFrom(objectDirs[0]);
const imgD = await frameFrom(objectDirs[1]);
if (!imgA || !imgD) { console.error("failed to extract frames"); process.exit(1); }

// Conservative warmer synthesis — no channel clips.
const warmer = [1.00, 0.90, 0.80];
const imgB = reIlluminate(imgA, warmer);

// Full-frame region
function fullRegion(f) { return { x: 0, y: 0, w: f.width, h: f.height }; }

const canA = captureCanonicalPhoton(imgA, fullRegion(imgA));
const canB = captureCanonicalPhoton(imgB, fullRegion(imgB));
const canD = captureCanonicalPhoton(imgD, fullRegion(imgD));

const mseSame = canonicalPhotonMSE(canA, canB);
const mseDiff = canonicalPhotonMSE(canA, canD);

console.log("A ← real video frame (" + objectDirs[0] + ")");
console.log("B ← A synthetically warmed with ratio [" + warmer.map(v => v.toFixed(2)).join(", ") + "] (no clipping)");
console.log("D ← different real video frame (" + objectDirs[1] + ")");
console.log();
console.log("A illum estimate     :", canA.meta.illuminant?.c?.map(v => v.toFixed(3)) ?? "n/a", "conf=" + (canA.meta.illuminant?.confidence?.toFixed(3) ?? "n/a"));
console.log("B illum estimate     :", canB.meta.illuminant?.c?.map(v => v.toFixed(3)) ?? "n/a", "conf=" + (canB.meta.illuminant?.confidence?.toFixed(3) ?? "n/a"));
console.log("D illum estimate     :", canD.meta.illuminant?.c?.map(v => v.toFixed(3)) ?? "n/a", "conf=" + (canD.meta.illuminant?.confidence?.toFixed(3) ?? "n/a"));
console.log();
console.log("MSE(same-scene A vs B, real image, synthetic re-illum) = " + mseSame.toExponential(4));
console.log("MSE(different-scene A vs D)                            = " + mseDiff.toExponential(4));
console.log("separation ratio (diff / same)                         = " + (mseDiff / Math.max(1e-12, mseSame)).toExponential(4));
console.log();
if (mseSame < 1e-3) console.log("verdict: REAL-IMAGE CROSS-ILLUMINANT — PASS (same-scene MSE below 1e-3)");
else console.log("verdict: SAME-SCENE MSE = " + mseSame.toExponential(3) + " — investigate residual source");
