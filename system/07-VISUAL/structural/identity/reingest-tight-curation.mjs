#!/usr/bin/env bun
// reingest-tight-curation.mjs — rebuild the identity store from downloaded
// YouTube corpus using TIGHT per-clip curation instead of active-diverse.
//
// For each downloaded clip:
//   1. Extract 5 evenly-spaced frames (middle of clip only)
//   2. Compute union warm signature per frame
//   3. Take the MEDIAN signature (K-medoid with K=1) as the clip's exemplar
//
// Each concept gets N-clip exemplar signatures. This produces a much
// tighter within-concept envelope (1 sig per clip vs 8 sigs from 15 frames
// active-curated wide).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachSignaturesV2, richDistance, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";
import { extractWarmEntities, signatureForUnion, HUMAN_GRADE_WEIGHTS } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

// K-medoid with K=1: pick the sig with smallest sum of distances to all others
function medoidOf(sigs, weights) {
  if (sigs.length === 0) return null;
  if (sigs.length === 1) return sigs[0];
  let bestIdx = 0, bestSum = Infinity;
  for (let i = 0; i < sigs.length; i++) {
    let sum = 0;
    for (let j = 0; j < sigs.length; j++) if (i !== j) sum += richDistance(sigs[i], sigs[j], weights);
    if (sum < bestSum) { bestSum = sum; bestIdx = i; }
  }
  return sigs[bestIdx];
}

async function tightSigForClip(clipPath, useLoose) {
  try {
    const frames = await extractVideoFrames(clipPath, { frames: 5, size: 384 });
    const sigs = [];
    for (const f of frames) {
      const warm = extractWarmEntities(f, { useLoose });
      if (!warm.length) continue;
      const s = signatureForUnion(f, warm);
      if (s) sigs.push(s);
    }
    return medoidOf(sigs, HUMAN_GRADE_WEIGHTS);
  } catch (e) {
    return null;
  }
}

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: bun reingest-tight-curation.mjs concepts.json store-out.json");
  process.exit(2);
}
const [conceptsPath, storeOutPath] = argv;
const { concepts } = JSON.parse(fs.readFileSync(conceptsPath, "utf-8"));

const STORE = { labels: [] };

console.log("=== TIGHT-CURATION REINGEST ===\n");
console.log("Method: K=1 medoid per clip (5 evenly-spaced frames → 1 median sig)\n");

for (const c of concepts) {
  const conceptDir = path.join(CORPUS_ROOT, slugify(c.label));
  if (!fs.existsSync(conceptDir)) { console.log("[SKIP] " + c.label + " — no dir"); continue; }
  const clips = fs.readdirSync(conceptDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f));
  if (!clips.length) { console.log("[SKIP] " + c.label + " — no clips"); continue; }
  const clipSigs = [];
  for (const clip of clips) {
    const sig = await tightSigForClip(path.join(conceptDir, clip), !!c.loose);
    if (sig) clipSigs.push(sig);
  }
  if (!clipSigs.length) { console.log("[SKIP] " + c.label + " — no valid sigs"); continue; }
  attachSignaturesV2(STORE, c.label, clipSigs, "youtube-tight", new Date().toISOString());
  STORE.labels[STORE.labels.length - 1].channel_weights = HUMAN_GRADE_WEIGHTS;
  console.log("  " + c.label.padEnd(18) + " " + clipSigs.length + " clip-medoid sigs");
}

fs.writeFileSync(storeOutPath, JSON.stringify(STORE, null, 2));
console.log("\nStore written: " + storeOutPath);
console.log("Total concepts: " + STORE.labels.length);
