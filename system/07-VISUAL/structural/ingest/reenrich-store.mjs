#!/usr/bin/env bun
// reenrich-store.mjs — rebuild identity-store sigs from downloaded clip files.
// The batch ingest processes were launched when signatureForUnion was 8-key.
// Their sigs lack hu_moments, photon_hist, photon_corr, radial_profile — the
// wins the recognizer at inference time DOES compute. Training/inference
// mismatch → collapse at scale.
//
// This script reads existing clip files under CORPUS_ROOT/<concept>/*.mp4
// and rebuilds signatures using TODAY's signatureForUnion. Store output
// is drop-in compatible with fisher-ratio-signature.mjs pipeline.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { extractWarmEntities, signatureForUnion } from "../identity/recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const OUT = process.argv[2] || "store-wave2-merged-enriched.json";
const FRAMES_PER_CLIP = 8;
const MAX_SIGS_PER_CONCEPT = 12;

const conceptDirs = fs.readdirSync(CORPUS_ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);
console.log("Found " + conceptDirs.length + " concept dirs\n");

// Label normalization: "orange" → "orange_fruit", "apple" → "apple_fruit" (matches ingest scripts)
function normalizeLabel(dirName) {
  if (dirName === "orange") return "orange_fruit";
  if (dirName === "apple") return "apple_fruit";
  return dirName;
}

const STORE = { labels: [] };
let done = 0;

for (const dir of conceptDirs) {
  const p = path.join(CORPUS_ROOT, dir);
  const clips = fs.readdirSync(p).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (!clips.length) { console.log("  " + dir + " (skip: no clips)"); continue; }
  // TRAINING = first N-1 clips; last clip reserved for held-out
  const trainingClips = clips.length >= 2 ? clips.slice(0, -1) : clips;
  const sigs = [];
  for (const clipFile of trainingClips) {
    try {
      const frames = await extractVideoFrames(path.join(p, clipFile), { frames: FRAMES_PER_CLIP, size: 384 });
      for (const f of frames) {
        const warm = extractWarmEntities(f, { useLoose: true });
        if (!warm.length) continue;
        const s = signatureForUnion(f, warm);
        if (s) sigs.push({ clip: clipFile, sig: s });
      }
    } catch (e) { /* skip broken clip */ }
    if (sigs.length >= MAX_SIGS_PER_CONCEPT) break;
  }
  if (!sigs.length) { console.log("  " + dir + " (skip: no sigs)"); continue; }
  const label = normalizeLabel(dir);
  const trimmed = sigs.slice(0, MAX_SIGS_PER_CONCEPT);
  STORE.labels.push({ label, signatures: trimmed });
  done++;
  console.log("  " + dir + " → " + label + " · " + trimmed.length + " enriched sigs");
  // Snapshot every 5 concepts to be safe
  if (done % 5 === 0) fs.writeFileSync(OUT, JSON.stringify(STORE));
}
fs.writeFileSync(OUT, JSON.stringify(STORE));
console.log("\nWrote " + OUT + " · " + STORE.labels.length + " concepts");
// Verify sig schema
const s0 = STORE.labels[0]?.signatures[0]?.sig;
if (s0) {
  console.log("Sample sig keys: " + Object.keys(s0).join(","));
  console.log("Has photon_hist: " + ("photon_hist" in s0));
  console.log("Has hu_moments: " + ("hu_moments" in s0));
}
