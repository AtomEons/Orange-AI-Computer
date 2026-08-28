#!/usr/bin/env bun
// reenrich-fast.mjs — resumable enrichment. Skip concepts already in store.
// Halved frames-per-clip and clip cap for 4x speedup on 63-concept run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { extractWarmEntities, signatureForUnion } from "../identity/recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const OUT = process.argv[2] || "C:/AtomEons/Orange5/07-VISUAL/fixtures/youtube-corpus/store-wave2-merged-enriched.json";
const FRAMES_PER_CLIP = 4;
const MAX_CLIPS = 2;
const MAX_SIGS = 8;

function normalizeLabel(dirName) {
  if (dirName === "orange") return "orange_fruit";
  if (dirName === "apple") return "apple_fruit";
  return dirName;
}

// Load existing store (resume)
let STORE = { labels: [] };
if (fs.existsSync(OUT)) {
  try { STORE = JSON.parse(fs.readFileSync(OUT, "utf-8")); } catch (_) { STORE = { labels: [] }; }
}
const done = new Set(STORE.labels.map(r => r.label));
console.log("Resume: " + done.size + " concepts already enriched");

const conceptDirs = fs.readdirSync(CORPUS_ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();
console.log("Total concept dirs: " + conceptDirs.length + " · to process: " + conceptDirs.filter(d => !done.has(normalizeLabel(d))).length);

const t0 = Date.now();
let processed = 0;
for (const dir of conceptDirs) {
  const label = normalizeLabel(dir);
  if (done.has(label)) continue;
  const p = path.join(CORPUS_ROOT, dir);
  const clips = fs.readdirSync(p).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (!clips.length) { console.log("  " + dir + " (skip: no clips)"); continue; }
  const trainingClips = (clips.length >= 2 ? clips.slice(0, -1) : clips).slice(0, MAX_CLIPS);
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
    } catch (e) { /* skip broken */ }
    if (sigs.length >= MAX_SIGS) break;
  }
  if (!sigs.length) { console.log("  " + dir + " (skip: no sigs)"); continue; }
  const trimmed = sigs.slice(0, MAX_SIGS);
  STORE.labels.push({ label, signatures: trimmed });
  processed++;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log("  " + dir + " → " + label + " · " + trimmed.length + " sigs · elapsed=" + elapsed + "s");
  fs.writeFileSync(OUT, JSON.stringify(STORE));
}
fs.writeFileSync(OUT, JSON.stringify(STORE));
console.log("\nDONE · total labels in store: " + STORE.labels.length + " · new this run: " + processed);
