#!/usr/bin/env bun
// prove-part-attention.mjs — Part-based attention (4-quadrant sub-region KNN).
//
// HYPOTHESIS: signatureForUnion averages the whole warm-entity bbox, so
// fine-grained pairs (orange vs lime, cat vs dog) collide because the average
// wipes discriminative local structure. Splitting the union region into 4
// sub-regions (TL, TR, BL, BR) and computing a signature per PART preserves
// local color/texture/pattern gradients.
//
// PIPELINE (per held-out video, 5 frames):
//   1. warm-entity detect → union bbox
//   2. split bbox into 4 quadrants (min 8x8 each; else skip that part)
//   3. per-part signatureForRegion → flatten → standardize → Fisher-weighted
//      nearest-neighbor over ALL stored per-clip instances
//   4. per-frame concept vote = plurality over 4 parts + 1 union
//   5. per-video vote = plurality over 5 frames (> 2/5 wins else needs_review)
//
// Metric: fisherWeightedDistance. No frame-level plurality gating on part votes
// (per constraint — gating knobs proven dead).
//
// USAGE: bun prove-part-attention.mjs <store.json>

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import {
  attachFisherRatioToStore,
  flattenSignature,
  fisherWeightedDistance,
  standardizeSignatureVector,
} from "./fisher-ratio-signature.mjs";
import {
  extractWarmEntities,
  signatureForUnion,
  signatureForRegion,
} from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error("usage: bun prove-part-attention.mjs store.json");
  process.exit(2);
}
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

console.log("=== PART-BASED ATTENTION VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed attaching Fisher stats"); process.exit(1); }
console.log("D = " + stats.D + " dimensions\n");

// Build per-instance standardized vectors from store (used as KNN memory).
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
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

// Per-concept ceilings (same recipe as super-stack-video-vote).
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++) {
    for (let j = i + 1; j < insts.length; j++) {
      dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
    }
  }
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
}

/**
 * Split a bbox [x, y, w, h] into 4 quadrants.
 * Returns [] if the bbox is too small to yield ≥8x8 quadrants.
 */
function quadrantRegions(region) {
  const [x, y, w, h] = region;
  const halfW = Math.floor(w / 2);
  const halfH = Math.floor(h / 2);
  if (halfW < 8 || halfH < 8) return [];
  return [
    [x, y, halfW, halfH],                        // TL
    [x + halfW, y, w - halfW, halfH],            // TR
    [x, y + halfH, halfW, h - halfH],            // BL
    [x + halfW, y + halfH, w - halfW, h - halfH],// BR
  ];
}

/**
 * KNN over all instances; returns nearest concept label + distance,
 * respecting per-concept ceiling.
 */
function nearestConcept(qvec) {
  let bestD = Infinity, bestLabel = null;
  for (const inst of instances) {
    const d = fisherWeightedDistance(qvec, inst.vec, fw);
    if (d < bestD) { bestD = d; bestLabel = inst.label; }
  }
  if (bestLabel == null) return { label: null, dist: bestD };
  const ceil = conceptCeilings.get(bestLabel) ?? 10.0;
  if (bestD > ceil) return { label: null, dist: bestD };
  return { label: bestLabel, dist: bestD };
}

/**
 * Recognize ONE frame: union sig + 4 part sigs → 5 concept votes.
 * Returns the concept with the highest vote sum (weighted by 1/dist).
 * Ties broken by lowest sum-of-distances.
 */
function recognizeFramePartAttention(frame) {
  // extract warm entities under both loose and any gates (same as super-stack)
  let unionSig = null;
  let unionRegion = null;
  for (const hg of ["warm_loose", "any"]) {
    const warm = extractWarmEntities(frame, { hue_gate: hg });
    if (!warm.length) continue;
    const u = signatureForUnion(frame, warm);
    if (!u) continue;
    unionSig = u;
    // rebuild union region bbox (same math as signatureForUnion)
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const e of warm) {
      if (e.region[0] < x0) x0 = e.region[0];
      if (e.region[1] < y0) y0 = e.region[1];
      if (e.region[0] + e.region[2] > x1) x1 = e.region[0] + e.region[2];
      if (e.region[1] + e.region[3] > y1) y1 = e.region[1] + e.region[3];
    }
    unionRegion = [x0, y0, x1 - x0, y1 - y0];
    break;
  }
  if (!unionSig || !unionRegion) return { winner: null };

  // Gather candidates: union + 4 quadrants
  const parts = [];
  parts.push({ tag: "union", sig: unionSig });
  const quads = quadrantRegions(unionRegion);
  const partTags = ["TL", "TR", "BL", "BR"];
  for (let i = 0; i < quads.length; i++) {
    const s = signatureForRegion(frame, quads[i]);
    if (s) parts.push({ tag: partTags[i], sig: s });
  }

  // Per-part nearest-concept
  const partVotes = new Map();  // concept -> weighted score (1/(dist + eps))
  const partSums = new Map();   // concept -> raw sum of distances
  const partCounts = new Map(); // concept -> count
  for (const p of parts) {
    const raw = flattenSignature(p.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const { label, dist } = nearestConcept(std);
    if (label == null) continue;
    const w = 1.0 / (dist + 1e-3);
    partVotes.set(label, (partVotes.get(label) || 0) + w);
    partSums.set(label, (partSums.get(label) || 0) + dist);
    partCounts.set(label, (partCounts.get(label) || 0) + 1);
  }
  if (partVotes.size === 0) return { winner: null };

  // Ranked by weighted score desc, tie-break by lower avg distance.
  const ranked = [...partVotes.entries()].map(([lbl, score]) => {
    const cnt = partCounts.get(lbl);
    const avgD = partSums.get(lbl) / cnt;
    return { lbl, score, cnt, avgD };
  }).sort((a, b) => (b.score - a.score) || (a.avgD - b.avgD));

  return { winner: ranked[0].lbl, ranked, totalParts: parts.length };
}

let correctVideos = 0, testedVideos = 0, confWrongVideos = 0;
const detail = [];
const misses = [];

for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try {
    frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 });
  } catch (e) {
    continue;
  }

  // Per-video plurality vote over 5 frames
  const videoVotes = new Map();
  for (const f of frames) {
    const r = recognizeFramePartAttention(f);
    if (r.winner) videoVotes.set(r.winner, (videoVotes.get(r.winner) || 0) + 1);
  }
  const ranked = [...videoVotes.entries()].sort((a, b) => b[1] - a[1]);
  const [videoWinner, videoWinnerCount] = ranked[0] || [null, 0];
  // require > 2/5 (majority of 5 frames), same rule as super-stack-video-vote
  const videoVerdict = videoWinnerCount > 2 ? videoWinner : null;

  const ok = videoVerdict === row.label;
  const wr = videoVerdict !== null && videoVerdict !== row.label;
  if (ok) correctVideos++;
  if (wr) { confWrongVideos++; misses.push({ concept: row.label, predicted: videoVerdict, votes: ranked }); }
  else if (!ok) { misses.push({ concept: row.label, predicted: "needs_review", votes: ranked }); }
  testedVideos++;

  detail.push({ label: row.label, videoVerdict, votes: ranked, ok, wr });
  const mark = ok ? "PASS" : (wr ? "WRONG" : "REVW");
  console.log("  " + mark.padEnd(6) + " " + row.label.padEnd(24) +
              " verdict=" + (videoVerdict || "needs_review").padEnd(22) +
              " votes=" + JSON.stringify(ranked.slice(0, 3)));
}

console.log("\n=== PART-ATTENTION SCORE ===");
const pct = testedVideos > 0 ? (correctVideos / testedVideos * 100) : 0;
console.log("Total: " + correctVideos + "/" + testedVideos + " = " + pct.toFixed(1) + "%");
console.log("Confident-wrong videos: " + confWrongVideos);
console.log("Store: " + storePath);
console.log("\n=== MISSES ===");
for (const m of misses) {
  console.log("  " + m.concept.padEnd(24) + " -> " + m.predicted);
}
