#!/usr/bin/env bun
// reenrich-slice.mjs — like reenrich-store.mjs but processes a SLICE of concepts
// by index. Enables parallel workers. Usage:
//   bun reenrich-slice.mjs OUT_FILE START END
// where concepts are sorted alphabetically and slice = [START, END).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { extractWarmEntities, signatureForUnion } from "../identity/recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const [, , OUT, S_STR, E_STR] = process.argv;
if (!OUT || S_STR === undefined || E_STR === undefined) {
  console.error("usage: reenrich-slice.mjs OUT START END");
  process.exit(1);
}
const START = parseInt(S_STR, 10);
const END = parseInt(E_STR, 10);
const FRAMES_PER_CLIP = 8;
const MAX_SIGS = 12;

const conceptDirs = fs.readdirSync(CORPUS_ROOT, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort()
  .slice(START, END);
console.log("Slice[" + START + "," + END + "): " + conceptDirs.length + " concepts");

function normalizeLabel(dirName) {
  if (dirName === "orange") return "orange_fruit";
  if (dirName === "apple") return "apple_fruit";
  return dirName;
}

const STORE = { labels: [] };
for (const dir of conceptDirs) {
  const p = path.join(CORPUS_ROOT, dir);
  const clips = fs.readdirSync(p).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (!clips.length) { console.log("  " + dir + " (skip: no clips)"); continue; }
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
    } catch (e) { /* skip */ }
    if (sigs.length >= MAX_SIGS) break;
  }
  if (!sigs.length) { console.log("  " + dir + " (skip: no sigs)"); continue; }
  const label = normalizeLabel(dir);
  const trimmed = sigs.slice(0, MAX_SIGS);
  STORE.labels.push({ label, signatures: trimmed });
  console.log("  " + dir + " → " + label + " · " + trimmed.length + " sigs");
  fs.writeFileSync(OUT, JSON.stringify(STORE));
}
console.log("SLICE-DONE " + STORE.labels.length);
