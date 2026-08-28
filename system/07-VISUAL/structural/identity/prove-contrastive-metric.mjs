#!/usr/bin/env bun
// prove-contrastive-metric.mjs — Contrastive per-dim weight learning against
// store-wave2-photonic.json (21 concepts, ENRICHED, hits 88% at N=17).
//
// APPROACH:
//   For each concept, sample K_POS within-concept sig pairs (positives) and
//   K_NEG cross-concept sig pairs (negatives). Then for each dimension f:
//     contrastive[f] = avg_neg((q[f]-c[f])^2)  -  avg_pos((q[f]-c[f])^2)
//   Higher contrastive[f] means the dim SEPARATES concepts more than it varies
//   within a concept — pure zero-parameter statistic (no gradient descent).
//
//   Then multiply the Fisher weight by the (clamped, normalized) contrastive
//   weight. This gives dims that pass BOTH tests (Fisher-discriminative AND
//   contrastive-discriminative) the most metric authority.
//
// EVALUATION:
//   Leave-one-signature-out (LOSO): for each of the 105 sigs, remove it from
//   the store, rebuild concept medians, classify the removed sig with (a) plain
//   Fisher weights and (b) Fisher*Contrastive weights. Report both scores.
//
//   Also runs a cross-clip video-held-out check like prove-super-stack-video-
//   vote.mjs (last video per concept held out, 5-frame plurality vote) — this
//   is the operator's cross-clip metric.
//
// RECEIPT:
//   Prints command-line reproducer, scores, and misses. Exits 0.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import {
  flattenSignature,
  computeFisherRatioStats,
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
const STORE_PATH = argv[0] || path.join(CORPUS_ROOT, "store-wave2-photonic.json");
const SKIP_VIDEO = argv.includes("--skip-video");

console.log("=== CONTRASTIVE PER-DIM METRIC — vs. Fisher baseline ===\n");
console.log("Store: " + STORE_PATH);

if (!fs.existsSync(STORE_PATH)) {
  console.error("store not found: " + STORE_PATH);
  process.exit(2);
}

const STORE = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
const N_CONCEPTS = STORE.labels.length;
const N_SIGS_TOTAL = STORE.labels.reduce((a, r) => a + r.signatures.length, 0);
console.log("Concepts: " + N_CONCEPTS + "   Total sigs: " + N_SIGS_TOTAL);

// STEP 1: build standardized vector table (concept -> [Float32Array,...])
// Use the store's own computeFisherRatioStats to derive globalMean/globalStd
// and Fisher weights (baseline).
const fisherStats = computeFisherRatioStats(STORE);
if (!fisherStats) { console.error("failed to compute Fisher stats"); process.exit(1); }
const D = fisherStats.D;
console.log("D = " + D + " dimensions");

// Standardize each raw sig using the fitted globalMean/globalStd
const conceptVecs = new Map(); // label -> Float32Array[]
const conceptRawSigs = new Map(); // label -> raw sig[]
for (const row of STORE.labels) {
  const vecs = [];
  const sigs = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, {
      D,
      globalMean: fisherStats.globalMean,
      globalStd: fisherStats.globalStd,
    });
    vecs.push(std);
    sigs.push(s.sig);
  }
  conceptVecs.set(row.label, vecs);
  conceptRawSigs.set(row.label, sigs);
}

// STEP 2: compute CONTRASTIVE per-dim weight
//   pos[f] = mean over within-concept pairs of (a[f]-b[f])^2
//   neg[f] = mean over cross-concept pairs of (a[f]-b[f])^2
//   contrastive[f] = neg[f] - pos[f]      (higher = dim separates concepts more)
//
// Deterministic — use all valid pairs (small dataset, ~105 sigs).
const pos = new Float64Array(D);
const neg = new Float64Array(D);
let posCount = 0, negCount = 0;

const labels = [...conceptVecs.keys()];
for (let ci = 0; ci < labels.length; ci++) {
  const A = conceptVecs.get(labels[ci]);
  // POSITIVE pairs — within concept
  for (let i = 0; i < A.length; i++) for (let j = i + 1; j < A.length; j++) {
    for (let f = 0; f < D; f++) { const d = A[i][f] - A[j][f]; pos[f] += d * d; }
    posCount++;
  }
  // NEGATIVE pairs — this concept vs all other concepts, first-sig only (bounded fan-out)
  for (let cj = ci + 1; cj < labels.length; cj++) {
    const B = conceptVecs.get(labels[cj]);
    for (let i = 0; i < A.length; i++) for (let j = 0; j < B.length; j++) {
      for (let f = 0; f < D; f++) { const d = A[i][f] - B[j][f]; neg[f] += d * d; }
      negCount++;
    }
  }
}
for (let f = 0; f < D; f++) {
  pos[f] = posCount > 0 ? pos[f] / posCount : 0;
  neg[f] = negCount > 0 ? neg[f] / negCount : 0;
}
console.log("Positive pairs: " + posCount + "   Negative pairs: " + negCount);

// Contrastive weight: clamp to >= 0 (dims where pos > neg are actively harmful
// and should get zero authority, not negative).
const contrastive = new Float32Array(D);
let sumContrastive = 0;
for (let f = 0; f < D; f++) {
  const c = Math.max(0, neg[f] - pos[f]);
  contrastive[f] = c;
  sumContrastive += c;
}
// Normalize so sum = D — mean weight = 1
if (sumContrastive > 0) {
  const scale = D / sumContrastive;
  for (let f = 0; f < D; f++) contrastive[f] *= scale;
}

// Fusion: Fisher * Contrastive, renormalized to sum = D
const fisher = fisherStats.fisher;
const fused = new Float32Array(D);
let sumFused = 0;
for (let f = 0; f < D; f++) { fused[f] = fisher[f] * contrastive[f]; sumFused += fused[f]; }
if (sumFused > 0) {
  const scale = D / sumFused;
  for (let f = 0; f < D; f++) fused[f] *= scale;
}

// Diagnostic — top-10 contrastive dims and top-10 fused dims
function topDims(w, k = 10) {
  return [...w].map((v, f) => ({ f, v })).sort((a, b) => b.v - a.v).slice(0, k);
}
console.log("\nTop-10 CONTRASTIVE dims (idx: weight):");
for (const t of topDims(contrastive)) console.log("  dim " + t.f.toString().padStart(3) + ": " + t.v.toFixed(3));
console.log("Top-10 FUSED (Fisher*Contrastive) dims (idx: weight):");
for (const t of topDims(fused)) console.log("  dim " + t.f.toString().padStart(3) + ": " + t.v.toFixed(3));

// STEP 3: LOSO evaluation — for each sig, leave it out, rebuild concept
// median from remaining N-1 sigs (in that concept), classify. Compare Fisher
// vs Fused weights.
function classifyOne(qvec, ownerLabel, ownerIdx, weightVec) {
  let best = Infinity, bestLabel = null;
  let second = Infinity, secondLabel = null;
  for (const [label, vecs] of conceptVecs.entries()) {
    // Build median EXCLUDING owner's own sig if this concept is the owner
    const included = label === ownerLabel
      ? vecs.filter((_, i) => i !== ownerIdx)
      : vecs;
    if (!included.length) continue;
    // Compute median vector
    const median = new Float32Array(D);
    for (let f = 0; f < D; f++) {
      const col = included.map(v => v[f]).sort((a, b) => a - b);
      const n = col.length;
      median[f] = n % 2 ? col[(n - 1) >> 1] : 0.5 * (col[(n >> 1) - 1] + col[n >> 1]);
    }
    // Weighted distance
    let s = 0;
    for (let f = 0; f < D; f++) { const d = qvec[f] - median[f]; s += weightVec[f] * d * d; }
    const dist = Math.sqrt(s);
    if (dist < best) {
      if (bestLabel && bestLabel !== label) { second = best; secondLabel = bestLabel; }
      best = dist; bestLabel = label;
    } else if (dist < second && label !== bestLabel) {
      second = dist; secondLabel = label;
    }
  }
  return { winner: bestLabel, dist: best, second, secondLabel };
}

let fisherCorrect = 0, fisherWrong = 0;
let fusedCorrect  = 0, fusedWrong  = 0;
const fusedMisses = [];
const fisherMisses = [];

for (const [label, vecs] of conceptVecs.entries()) {
  for (let i = 0; i < vecs.length; i++) {
    const q = vecs[i];
    const rf = classifyOne(q, label, i, fisher);
    const rn = classifyOne(q, label, i, fused);
    if (rf.winner === label) fisherCorrect++;
    else { fisherWrong++; fisherMisses.push({ label, sig: i, got: rf.winner, dist: rf.dist.toFixed(3) }); }
    if (rn.winner === label) fusedCorrect++;
    else { fusedWrong++; fusedMisses.push({ label, sig: i, got: rn.winner, dist: rn.dist.toFixed(3) }); }
  }
}

const total = N_SIGS_TOTAL;
console.log("\n=== LOSO KNN (median) score ===");
console.log("Fisher baseline: " + fisherCorrect + "/" + total + " = " + Math.round(fisherCorrect / total * 100) + "%   wrong=" + fisherWrong);
console.log("Fused (F*C):     " + fusedCorrect  + "/" + total + " = " + Math.round(fusedCorrect  / total * 100) + "%   wrong=" + fusedWrong);

console.log("\n--- Fused misses (up to 20) ---");
for (const m of fusedMisses.slice(0, 20)) {
  console.log("  " + m.label.padEnd(20) + " sig[" + m.sig + "] -> " + (m.got || "-").padEnd(20) + " dist=" + m.dist);
}

// STEP 4 (optional): CROSS-CLIP video-held-out validation
// Last video per concept, 5 frames, plurality > 2/5. Compares Fisher vs Fused
// on the SAME frames extracted live via ffmpeg.
if (SKIP_VIDEO) {
  console.log("\n(skipped video cross-clip validation — --skip-video)");
  console.log("\nRepro: bun run C:/AtomEons/Orange5/07-VISUAL/structural/identity/prove-contrastive-metric.mjs " + STORE_PATH + " --skip-video");
  process.exit(0);
}

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }

// Flatten all standardized instances for KNN over ALL sigs (not median)
const instances = [];
for (const [label, vecs] of conceptVecs.entries()) {
  for (const v of vecs) instances.push({ label, vec: v });
}

function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

function recognizeFrame(frame, weightVec) {
  const candidates = [];
  for (const hg of ["warm_loose", "any"]) {
    const warm = extractWarmEntities(frame, { hue_gate: hg });
    if (!warm.length) continue;
    const u = signatureForUnion(frame, warm);
    if (u) candidates.push(u);
    for (const w of warm.slice(0, 5)) {
      for (const region of multiScaleRegions(w.region)) {
        const s = signatureForRegion(frame, region);
        if (s) candidates.push(s);
      }
    }
  }
  if (!candidates.length) return { winner: null };
  const qvecs = candidates.map(c => standardizeSignatureVector(flattenSignature(c), {
    D,
    globalMean: fisherStats.globalMean,
    globalStd: fisherStats.globalStd,
  }));
  let best = Infinity, bestLabel = null;
  for (const q of qvecs) {
    for (const inst of instances) {
      let s = 0;
      for (let f = 0; f < D; f++) { const d = q[f] - inst.vec[f]; s += weightVec[f] * d * d; }
      const dist = Math.sqrt(s);
      if (dist < best) { best = dist; bestLabel = inst.label; }
    }
  }
  return { winner: bestLabel };
}

console.log("\n=== CROSS-CLIP VIDEO-HELDOUT (last video per concept, plurality > 2/5) ===\n");
let fVidCorrect = 0, fVidWrong = 0, fVidTested = 0;
let nVidCorrect = 0, nVidWrong = 0, nVidTested = 0;
const fVidMisses = [], nVidMisses = [];

for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); }
  catch (e) { continue; }

  const fVotes = new Map(), nVotes = new Map();
  for (const f of frames) {
    const rf = recognizeFrame(f, fisher);
    const rn = recognizeFrame(f, fused);
    if (rf.winner) fVotes.set(rf.winner, (fVotes.get(rf.winner) || 0) + 1);
    if (rn.winner) nVotes.set(rn.winner, (nVotes.get(rn.winner) || 0) + 1);
  }
  const fRanked = [...fVotes.entries()].sort((a, b) => b[1] - a[1]);
  const nRanked = [...nVotes.entries()].sort((a, b) => b[1] - a[1]);
  const fVerdict = (fRanked[0]?.[1] ?? 0) > 2 ? fRanked[0][0] : null;
  const nVerdict = (nRanked[0]?.[1] ?? 0) > 2 ? nRanked[0][0] : null;

  fVidTested++; nVidTested++;
  if (fVerdict === row.label) fVidCorrect++; else if (fVerdict) { fVidWrong++; fVidMisses.push({ label: row.label, got: fVerdict, votes: fRanked }); }
  if (nVerdict === row.label) nVidCorrect++; else if (nVerdict) { nVidWrong++; nVidMisses.push({ label: row.label, got: nVerdict, votes: nRanked }); }

  const fMark = fVerdict === row.label ? "✓" : (fVerdict ? "✗" : "~");
  const nMark = nVerdict === row.label ? "✓" : (nVerdict ? "✗" : "~");
  console.log("  F " + fMark + "  N " + nMark + "  " + row.label.padEnd(18) +
    "  fisher=" + (fVerdict || "needs_review").padEnd(20) +
    "  fused=" + (nVerdict || "needs_review"));
}

console.log("\n=== CROSS-CLIP SCORE ===");
console.log("Fisher baseline: " + fVidCorrect + "/" + fVidTested + " = " + (fVidTested ? Math.round(fVidCorrect / fVidTested * 100) : 0) + "%   confWrong=" + fVidWrong);
console.log("Fused (F*C):     " + nVidCorrect + "/" + nVidTested + " = " + (nVidTested ? Math.round(nVidCorrect / nVidTested * 100) : 0) + "%   confWrong=" + nVidWrong);

if (fVidMisses.length) {
  console.log("\nFisher misses:");
  for (const m of fVidMisses) console.log("  " + m.label.padEnd(18) + " -> " + m.got + "  votes=" + JSON.stringify(m.votes.slice(0, 3)));
}
if (nVidMisses.length) {
  console.log("\nFused misses:");
  for (const m of nVidMisses) console.log("  " + m.label.padEnd(18) + " -> " + m.got + "  votes=" + JSON.stringify(m.votes.slice(0, 3)));
}

console.log("\nRepro: bun run C:/AtomEons/Orange5/07-VISUAL/structural/identity/prove-contrastive-metric.mjs " + STORE_PATH);
process.exit(0);
