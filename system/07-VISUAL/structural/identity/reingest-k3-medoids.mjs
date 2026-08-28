#!/usr/bin/env bun
// reingest-k3-medoids.mjs — 3 diverse frame-medoids per clip instead of 1.
// Triples per-clip training sig count — should help clock/strawberry (2 clips).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachSignaturesV2, richDistance } from "./identity-store-v2.mjs";
import { extractWarmEntities, signatureForUnion, HUMAN_GRADE_WEIGHTS } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
// Farthest-point-sample K sigs from N candidates
function fpsKFromSigs(sigs, K, weights) {
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

const argv = process.argv.slice(2);
const [conceptsPath, storeOutPath] = argv;
const { concepts } = JSON.parse(fs.readFileSync(conceptsPath, "utf-8"));

const STORE = { labels: [] };

console.log("=== K=3 MEDOIDS PER CLIP REINGEST ===\n");

for (const c of concepts) {
  const conceptDir = path.join(CORPUS_ROOT, slugify(c.label));
  if (!fs.existsSync(conceptDir)) { console.log("[SKIP] " + c.label + " — no dir"); continue; }
  const clips = fs.readdirSync(conceptDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f));
  if (!clips.length) { console.log("[SKIP] " + c.label + " — no clips"); continue; }
  const allSigs = [];
  for (const clip of clips) {
    try {
      const frames = await extractVideoFrames(path.join(conceptDir, clip), { frames: 8, size: 384 });
      const perClipSigs = [];
      for (const f of frames) {
        const warm = extractWarmEntities(f, { useLoose: !!c.loose });
        if (!warm.length) continue;
        const s = signatureForUnion(f, warm);
        if (s) perClipSigs.push(s);
      }
      if (perClipSigs.length >= 3) {
        allSigs.push(...fpsKFromSigs(perClipSigs, 3, HUMAN_GRADE_WEIGHTS));
      } else {
        allSigs.push(...perClipSigs);
      }
    } catch (e) { /* skip bad clips */ }
  }
  if (!allSigs.length) { console.log("[SKIP] " + c.label + " — no valid sigs"); continue; }
  attachSignaturesV2(STORE, c.label, allSigs, "youtube-k3-medoids", new Date().toISOString());
  STORE.labels[STORE.labels.length - 1].channel_weights = HUMAN_GRADE_WEIGHTS;
  console.log("  " + c.label.padEnd(18) + " " + allSigs.length + " sigs (from " + clips.length + " clips)");
}

fs.writeFileSync(storeOutPath, JSON.stringify(STORE, null, 2));
console.log("\nStore written: " + storeOutPath);
console.log("Total concepts: " + STORE.labels.length);
