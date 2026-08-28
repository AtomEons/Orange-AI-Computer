#!/usr/bin/env bun
// prove-fisher-knn-perconcept.mjs — Fisher-weighted KNN with per-concept
// ceilings learned from the within-concept Fisher-distance distribution.
//
// In Fisher-standardized space, per-concept ceiling = (max within-concept
// distance) × safety_factor. Guaranteed to accept all training instances
// of that concept; rejects everything more distant.
//
// Combined with global secondary ceiling to prevent stray matches from
// concepts whose within-variance is huge.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) { console.error("usage: bun prove-fisher-knn-perconcept.mjs store.json [--safety N]"); process.exit(2); }
const storePath = argv[0];
const safetyIdx = argv.indexOf("--safety");
const safety = safetyIdx >= 0 ? parseFloat(argv[safetyIdx + 1]) : 1.5;
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

console.log("=== FISHER-KNN + PER-CONCEPT CEILINGS ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);
console.log("Safety factor: " + safety + "\n");

console.log("computing Fisher stats...");
const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed"); process.exit(1); }
console.log("D = " + stats.D + " · dimensions total\n");

const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

// Precompute all standardized instances
const instances = [];
const conceptInstances = new Map();
for (const row of STORE.labels) {
  const perConcept = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const inst = { label: row.label, vec: std };
    instances.push(inst);
    perConcept.push(inst);
  }
  conceptInstances.set(row.label, perConcept);
}
console.log("Total instances: " + instances.length);

// Per-concept ceilings: max within-concept distance × safety
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 8.0); continue; }
  let maxWithin = 0;
  for (let i = 0; i < insts.length; i++) {
    for (let j = i + 1; j < insts.length; j++) {
      const d = fisherWeightedDistance(insts[i].vec, insts[j].vec, fw);
      if (d > maxWithin) maxWithin = d;
    }
  }
  conceptCeilings.set(label, maxWithin * safety);
}

console.log("per-concept ceilings (from within-concept max × safety):");
for (const [label, ceiling] of conceptCeilings.entries()) {
  console.log("  " + label.padEnd(18) + " ceiling=" + ceiling.toFixed(3));
}

// Validation
let correct = 0, tested = 0, confWrong = 0;
const perConcept = [];
console.log("");
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); }
  catch (e) { continue; }
  let ok = 0, wr = 0, tot = 0;
  for (const f of frames) {
    const useLoose = /animal|cat|dog|elephant|lion|giraffe|horse|building|house|castle|book|chair|clock|mountain|forest|ocean|snow|bicycle|airplane|boat|banana|watermelon|grape|carrot|sunflower/.test(row.label);
    const warm = extractWarmEntities(f, { useLoose });
    if (!warm.length) { tot++; continue; }
    const qsig = signatureForUnion(f, warm);
    if (!qsig) { tot++; continue; }
    const qvec = standardizeSignatureVector(flattenSignature(qsig), STORE.fisher_stats);
    // Find nearest instance
    let best = Infinity, bestLabel = null;
    for (const inst of instances) {
      const d = fisherWeightedDistance(qvec, inst.vec, fw);
      if (d < best) { best = d; bestLabel = inst.label; }
    }
    // Per-concept ceiling gate
    const ceiling = conceptCeilings.get(bestLabel) ?? 8.0;
    const rejected = best > ceiling;
    const winner = rejected ? null : bestLabel;
    if (winner === row.label) ok++;
    else if (!rejected) wr++;
    tot++;
  }
  correct += ok; tested += tot; confWrong += wr;
  const pct = tot > 0 ? Math.round(ok / tot * 100) : 0;
  perConcept.push({ label: row.label, correct: ok, tested: tot, confWrong: wr, pct });
  console.log("  " + row.label.padEnd(18) + " " + ok + "/" + tot + " = " + String(pct).padStart(3) + "%  confWrong=" + wr);
}

const pct = tested > 0 ? Math.round(correct / tested * 100) : 0;
console.log("\n=== FISHER-KNN PER-CONCEPT SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%");
console.log("Confident-wrong: " + confWrong);
