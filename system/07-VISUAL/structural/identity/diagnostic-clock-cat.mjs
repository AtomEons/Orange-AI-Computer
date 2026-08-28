#!/usr/bin/env bun
// diagnostic-clock-cat.mjs — dump Fisher weight ranking + per-dim contribution
// for clock vs cat confusion.

import fs from "node:fs";
import { attachFisherRatioToStore, flattenSignature, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractWarmEntities, signatureForUnion } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const STORE = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));
attachFisherRatioToStore(STORE);

const catRow = STORE.labels.find(r => r.label === "cat");
const clockRow = STORE.labels.find(r => r.label === "clock");
if (!catRow || !clockRow) { console.log("no cat/clock"); process.exit(1); }

const catStd = catRow.signatures.map(s => standardizeSignatureVector(flattenSignature(s.sig), STORE.fisher_stats));
const clockStd = clockRow.signatures.map(s => standardizeSignatureVector(flattenSignature(s.sig), STORE.fisher_stats));

console.log("cat sigs: " + catStd.length + " · clock sigs: " + clockStd.length);
const D = catStd[0].length;
console.log("D = " + D);
console.log("");

// Per-dim: contrast between cat and clock, weighted by Fisher weight
const contrasts = [];
for (let f = 0; f < D; f++) {
  const catMean = catStd.reduce((a, v) => a + v[f], 0) / catStd.length;
  const clockMean = clockStd.reduce((a, v) => a + v[f], 0) / clockStd.length;
  const contrast = Math.abs(catMean - clockMean);
  const weight = STORE.fisher_stats.fisher[f];
  contrasts.push({ f, catMean, clockMean, contrast, weight, weightedContrast: contrast * weight });
}
contrasts.sort((a, b) => b.weightedContrast - a.weightedContrast);

console.log("Top 20 dims contributing to clock-vs-cat distance:");
for (let i = 0; i < 20 && i < contrasts.length; i++) {
  const c = contrasts[i];
  console.log("  dim " + String(c.f).padStart(3) + " cat_mean=" + c.catMean.toFixed(2).padStart(6) + " clock_mean=" + c.clockMean.toFixed(2).padStart(6) + " diff=" + c.contrast.toFixed(2).padStart(5) + " × weight=" + c.weight.toFixed(3).padStart(5) + " = " + c.weightedContrast.toFixed(3));
}

// Load clock's held-out clip and test its signature vs cat/clock
const clockDir = path.join(CORPUS_ROOT, "clock");
const clockFiles = fs.readdirSync(clockDir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
if (clockFiles.length >= 2) {
  const heldOut = path.join(clockDir, clockFiles.at(-1));
  console.log("\nHeld-out clock clip: " + clockFiles.at(-1));
  const frames = await extractVideoFrames(heldOut, { frames: 3, size: 384 });
  for (let fi = 0; fi < frames.length; fi++) {
    const warm = extractWarmEntities(frames[fi], { hue_gate: "any" });
    if (!warm.length) { console.log("  frame " + fi + ": no warm"); continue; }
    const q = signatureForUnion(frames[fi], warm);
    if (!q) continue;
    const qvec = standardizeSignatureVector(flattenSignature(q), STORE.fisher_stats);
    // Distance to each cat sig
    console.log("\nFrame " + fi + ":");
    for (let ci = 0; ci < catStd.length; ci++) {
      let d = 0;
      for (let f = 0; f < D; f++) {
        const diff = qvec[f] - catStd[ci][f];
        d += STORE.fisher_stats.fisher[f] * diff * diff;
      }
      console.log("  → cat_sig[" + ci + "]  Fisher-dist = " + Math.sqrt(d).toFixed(3));
    }
    for (let ci = 0; ci < clockStd.length; ci++) {
      let d = 0;
      for (let f = 0; f < D; f++) {
        const diff = qvec[f] - clockStd[ci][f];
        d += STORE.fisher_stats.fisher[f] * diff * diff;
      }
      console.log("  → clock_sig[" + ci + "] Fisher-dist = " + Math.sqrt(d).toFixed(3));
    }
  }
}
