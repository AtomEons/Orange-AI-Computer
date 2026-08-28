#!/usr/bin/env bun
// prove-fisher-fullstack.mjs — layer every substrate lever we have on top
// of Fisher-weighted KNN and measure the ceiling.
//
// Stack:
//   1. Tight-curation store (K=1 medoid per clip) — cleaner within-concept
//   2. Fisher-Ratio Signature Normalization — data-driven feature scaling
//   3. Fisher-weighted KNN (match query to nearest single instance)
//   4. Multi-scale + hue-any query candidates — cover pose/scale/hue variance
//   5. Per-concept ceiling from within-concept Fisher-distance distribution
//
// This is the maximum-effort deterministic-recognizer configuration.

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
if (argv.length < 1) { console.error("usage: bun prove-fisher-fullstack.mjs store.json"); process.exit(2); }
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

console.log("=== FISHER FULLSTACK VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);
console.log("Innovation stack: Fisher-Ratio Signature + KNN + multi-scale + hue-any query candidates + per-concept learned ceilings\n");

console.log("computing Fisher stats from store...");
const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed"); process.exit(1); }

// Precompute standardized instances
const instances = [];
for (const row of STORE.labels) {
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    instances.push({ label: row.label, vec: standardizeSignatureVector(raw, STORE.fisher_stats) });
  }
}
console.log("Instances: " + instances.length + " · Fisher-dim: " + stats.D);

const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

// Compute per-concept "internal-radius" ceilings from within-concept distances
// among training instances.
const conceptCeilings = new Map();
for (const row of STORE.labels) {
  const sigs = row.signatures.map(s => standardizeSignatureVector(flattenSignature(s.sig), STORE.fisher_stats));
  if (sigs.length < 2) { conceptCeilings.set(row.label, 5.0); continue; }
  const dists = [];
  for (let i = 0; i < sigs.length; i++) for (let j = i + 1; j < sigs.length; j++) dists.push(fisherWeightedDistance(sigs[i], sigs[j], fw));
  dists.sort((a, b) => a - b);
  const p75 = dists[Math.floor(dists.length * 0.75)];
  conceptCeilings.set(row.label, Math.max(2.0, Math.min(20.0, p75 * 1.5)));
}
console.log("per-concept ceilings computed (75th-percentile within-concept × 1.5)\n");

// Multi-scale, multi-region query candidate generator
function multiRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s)), nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

// Per-frame recognition — extract MANY candidates, match each to nearest instance
function recognizeFrame(frame) {
  // Try both warm gates so we don't miss non-warm concepts
  const candidatesUnion = [];
  for (const hg of ["warm_loose", "any"]) {
    const warm = extractWarmEntities(frame, { hue_gate: hg });
    if (!warm.length) continue;
    const u = signatureForUnion(frame, warm);
    if (u) candidatesUnion.push(u);
    for (const w of warm.slice(0, 5)) {
      for (const region of multiRegions(w.region)) {
        const s = signatureForRegion(frame, region);
        if (s) candidatesUnion.push(s);
      }
    }
  }
  if (!candidatesUnion.length) return { winner: null, dist: Infinity };
  // Match each candidate to nearest instance; take the (candidate, instance) pair with min distance
  let best = Infinity, bestLabel = null;
  for (const c of candidatesUnion) {
    const qvec = standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats);
    for (const inst of instances) {
      const d = fisherWeightedDistance(qvec, inst.vec, fw);
      if (d < best) { best = d; bestLabel = inst.label; }
    }
  }
  return { winner: bestLabel, dist: best };
}

// Validation loop
let correct = 0, tested = 0, confWrong = 0;
const perConcept = [];
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
    const r = recognizeFrame(f);
    const ceiling = conceptCeilings.get(r.winner) ?? 10.0;
    const rejected = r.dist > ceiling;
    const winner = rejected ? null : r.winner;
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
console.log("\n=== FULLSTACK SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%");
console.log("Confident-wrong: " + confWrong);
