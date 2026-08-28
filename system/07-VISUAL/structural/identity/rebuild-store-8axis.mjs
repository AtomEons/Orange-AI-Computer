#!/usr/bin/env bun
// Rebuild identity store using the FULL 8-axis buildRichSignature — now
// that subsurface + colorRatio + spatialFreq are wired in. Uses the same
// cinema clips (baby-watches-orange.mp4, baby-watches-apple.mp4).
//
// Output: fixtures/perfect-eyes/identity-store-perfect-8axis.json

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { computeDescriptor, computeUnionDescriptor } from "./descriptor.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { subsurfaceSummaryForRegion } from "../axes/subsurface-axis.mjs";
import { colorRatioSummaryForRegion } from "../axes/color-ratio-axis.mjs";
import { spatialFrequencySummaryForRegion } from "../axes/spatial-frequency-axis.mjs";
import { buildRichSignature, attachSignaturesV2, richDistance, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";
import { activeCurate } from "../ingest/active-curation.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");

const AXES = ["R","G","B","L","M","gamma","RG","BY"];

function toL(R, G, B) { const L = new Float32Array(R.length); for (let i = 0; i < R.length; i++) L[i] = 0.30*R[i]+0.59*G[i]+0.11*B[i]; return L; }
function isWarm(d) { return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5; }

function buildFrame8Sig(f) {
  const W = f.width, H = f.height;
  const combo = attentionMultiAxisV2(f.R, f.G, f.B, W, H, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const warm = [];
  for (const e of combo.entities) {
    const d = computeDescriptor(e.region, f.R, f.G, f.B, W, H);
    if (isWarm(d)) warm.push(e);
  }
  if (!warm.length) return null;
  const colorDesc = computeUnionDescriptor(warm.map((x) => x.region), f.R, f.G, f.B, W, H);
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const e of warm) { if (e.region[0]<x0) x0=e.region[0]; if (e.region[1]<y0) y0=e.region[1]; if (e.region[0]+e.region[2]>x1) x1=e.region[0]+e.region[2]; if (e.region[1]+e.region[3]>y1) y1=e.region[1]+e.region[3]; }
  const region = [x0, y0, x1-x0, y1-y0];
  const L = toL(f.R, f.G, f.B);
  return buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, W, H, region),
    textureSummaryForRegion(L, W, H, region),
    specularSummaryForRegion(L, W, H, region),
    spatialColorSummaryForRegion(f.R, f.G, f.B, W, H, region),
    // NEW 3 axes:
    subsurfaceSummaryForRegion(f.R, f.G, f.B, W, H, region),
    colorRatioSummaryForRegion(f.R, f.G, f.B, W, H, region),
    spatialFrequencySummaryForRegion(L, W, H, region),
  );
}

async function watchVideo(videoPath, N = 15) {
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  const sigs = [];
  for (const f of frames) {
    const s = buildFrame8Sig(f);
    if (s) sigs.push(s);
  }
  return sigs;
}

console.log("=== REBUILD STORE — 8-axis rich signatures ===\n");
console.log("watching orange cinema...");
const orangeAll = await watchVideo(path.join(CINEMA, "baby-watches-orange.mp4"));
console.log("  " + orangeAll.length + "/15 sigs built");

console.log("watching apple cinema...");
const appleAll = await watchVideo(path.join(CINEMA, "baby-watches-apple.mp4"));
console.log("  " + appleAll.length + "/15 sigs built");

// Active-curate to 8 most diverse per concept
const orangeCur = activeCurate(orangeAll, 8, { weights: DEFAULT_CHANNEL_WEIGHTS });
const appleCur = activeCurate(appleAll, 8, { weights: DEFAULT_CHANNEL_WEIGHTS });
const orangeKept = orangeCur.selected.map((i) => orangeAll[i]);
const appleKept = appleCur.selected.map((i) => appleAll[i]);

const store = { labels: [] };
attachSignaturesV2(store, "orange", orangeKept, "baby-watches-orange.mp4 8-axis curated", "2026-07-06T00:00:00Z");
attachSignaturesV2(store, "apple",  appleKept,  "baby-watches-apple.mp4 8-axis curated",  "2026-07-06T00:00:00Z");

const outPath = path.join(FIXTURES, "perfect-eyes", "identity-store-perfect-8axis.json");
fs.writeFileSync(outPath, JSON.stringify(store, null, 2));
console.log("\n=== WRITTEN ===");
console.log("path: " + outPath);
console.log("orange sigs:", store.labels[0].signatures.length);
console.log("apple sigs: ", store.labels[1].signatures.length);
console.log("sample orange sig keys:", Object.keys(store.labels[0].signatures[0].sig));
if (store.labels[0].signatures[0].sig.subsurface) console.log("subsurface WIRED IN");
if (store.labels[0].signatures[0].sig.colorRatio) console.log("colorRatio WIRED IN");
if (store.labels[0].signatures[0].sig.spatialFreq) console.log("spatialFreq WIRED IN");
