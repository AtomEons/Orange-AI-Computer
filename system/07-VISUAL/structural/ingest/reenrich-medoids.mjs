#!/usr/bin/env bun
// reenrich-medoids.mjs — like reenrich-fast but curates with K-medoid (FPS)
// selection over ALL frames from ALL training clips. Produces diverse,
// representative training sigs. Fisher stats become stable.
//
// Reads existing enriched store (resumable) and only processes new concepts.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { candidatesForFrame, HUMAN_GRADE_WEIGHTS } from "../identity/recognize-human-grade.mjs";
import { richDistance } from "../identity/identity-store-v2.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const OUT = process.argv[2] || "C:/AtomEons/Orange5/07-VISUAL/fixtures/youtube-corpus/store-wave2-medoids-enriched.json";
const FRAMES_PER_CLIP = 6;   // extract more raw, then curate down
const MAX_CLIPS = 3;         // more training clips
const K_MEDOIDS = 8;         // target curated sigs per concept

function fpsK(sigs, K, weights) {
  if (sigs.length <= K) return sigs.slice();
  const picked = [0];
  const dToPicked = new Array(sigs.length).fill(Infinity);
  while (picked.length < K) {
    for (let i = 0; i < sigs.length; i++) {
      if (picked.includes(i)) { dToPicked[i] = -1; continue; }
      const d = Math.min(dToPicked[i], richDistance(sigs[i], sigs[picked[picked.length - 1]], weights));
      dToPicked[i] = d;
    }
    let best = -1, bestD = -1;
    for (let i = 0; i < sigs.length; i++) if (dToPicked[i] > bestD) { bestD = dToPicked[i]; best = i; }
    if (best < 0) break;
    picked.push(best);
  }
  return picked.map(i => sigs[i]);
}

function normalizeLabel(dirName) {
  if (dirName === "orange") return "orange_fruit";
  if (dirName === "apple") return "apple_fruit";
  return dirName;
}

let STORE = { labels: [] };
if (fs.existsSync(OUT)) {
  try { STORE = JSON.parse(fs.readFileSync(OUT, "utf-8")); } catch (_) { STORE = { labels: [] }; }
}
const done = new Set(STORE.labels.map(r => r.label));
console.log("Resume: " + done.size + " concepts already curated");

const conceptDirs = fs.readdirSync(CORPUS_ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();
console.log("Total concept dirs: " + conceptDirs.length);

const t0 = Date.now();
let processed = 0;
for (const dir of conceptDirs) {
  const label = normalizeLabel(dir);
  if (done.has(label)) continue;
  const p = path.join(CORPUS_ROOT, dir);
  const clips = fs.readdirSync(p).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (clips.length < 2) { console.log("  " + dir + " (skip: <2 clips)"); continue; }
  const trainingClips = clips.slice(0, -1).slice(0, MAX_CLIPS);
  const allSigs = [];
  for (const clipFile of trainingClips) {
    try {
      const frames = await extractVideoFrames(path.join(p, clipFile), { frames: FRAMES_PER_CLIP, size: 384 });
      for (const f of frames) {
        // CANDIDATE PARITY: same generator as recognition (unions, both gates).
        allSigs.push(...candidatesForFrame(f));
      }
    } catch (e) { /* skip */ }
  }
  if (allSigs.length < 2) { console.log("  " + dir + " (skip: <2 sigs)"); continue; }
  // FPS-select K diverse medoids
  const curated = fpsK(allSigs, K_MEDOIDS, HUMAN_GRADE_WEIGHTS);
  STORE.labels.push({ label, signatures: curated.map(s => ({ sig: s })) });
  processed++;
  const elapsed = ((Date.now() - t0) / 1000).toFixed(0);
  console.log("  " + dir + " → " + label + " · " + curated.length + " curated (from " + allSigs.length + ") · " + elapsed + "s");
  fs.writeFileSync(OUT, JSON.stringify(STORE));
}
fs.writeFileSync(OUT, JSON.stringify(STORE));
console.log("\nDONE · total labels in store: " + STORE.labels.length + " · new this run: " + processed);
