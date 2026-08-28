#!/usr/bin/env bun
// prove-memes.mjs — score AEyes¹ on the meme corpus held-out set.
//
// Loads store-memes-enriched.json (28 trained labels × 4 sigs) and
// store-memes-heldout.json (100 slug -> heldout image path). For each of the
// 28 trained labels, score its variant-5 held-out image against the store
// with THREE classifiers:
//   (a) min-cand KNN with per-concept ceilings   (current baseline)
//   (b) prototype (mean-vec centroid) KNN
//   (c) NLL integration (Fisher-Hopfield attention integrated over candidates)
//
// Multi-scale regions (1.0, 0.7, 0.5) like prove-super-stack-video-vote.
// Honest receipts: real counts, top-5 confusion pairs per classifier.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "../prism.mjs";
import {
  candidatesForFrame,
} from "./recognize-human-grade.mjs";
import {
  attachFisherRatioToStore,
  flattenSignature,
  fisherWeightedDistance,
  standardizeSignatureVector,
} from "./fisher-ratio-signature.mjs";
import { buildWhitenerAndInstances, euclideanSq } from "./whitened-metric.mjs";

const CORPUS_ROOT = "C:/AtomEons/Orange5/07-VISUAL/fixtures/meme-corpus";
const STORE_PATH  = path.join(CORPUS_ROOT, "store-memes-enriched.json");
const HELDOUT_PATH = path.join(CORPUS_ROOT, "store-memes-heldout.json");

console.log("=== MEME HELD-OUT VALIDATION (3 classifiers) ===\n");
console.log("Store:   " + STORE_PATH);
console.log("Heldout: " + HELDOUT_PATH);

const STORE = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
const HELDOUT = JSON.parse(fs.readFileSync(HELDOUT_PATH, "utf-8"));

console.log("Trained labels: " + STORE.labels.length);
console.log("Heldout entries: " + Object.keys(HELDOUT).length);

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("Fisher attach failed"); process.exit(1); }
console.log("Fisher D = " + stats.D + " dimensions\n");

// Build per-instance flat vectors + per-concept prototype centroids.
const instances = [];
const conceptInstances = new Map();
for (const row of STORE.labels) {
  const perConcept = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const inst = { label: row.label, vec: std, sig: s.sig };
    instances.push(inst);
    perConcept.push(inst);
  }
  conceptInstances.set(row.label, perConcept);
}
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
const D = STORE.fisher_stats.D;

// Per-concept ceilings (same recipe as prove-super-stack-video-vote).
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++)
    for (let j = i + 1; j < insts.length; j++)
      dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
}

// Prototype centroids per concept (mean of standardized vectors).
const conceptPrototypes = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  const mean = new Float32Array(D);
  for (const inst of insts) for (let f = 0; f < D; f++) mean[f] += inst.vec[f];
  for (let f = 0; f < D; f++) mean[f] /= insts.length;
  conceptPrototypes.set(label, mean);
}

// FABLE MOVE 1: whitened metric on meme corpus (regression canary).
function sanitize(v) {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Number.isFinite(v[i]) ? v[i] : 0;
  return out;
}
const whGroups = [];
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) continue;
  whGroups.push({ label, vecs: insts.map(i => sanitize(i.vec)) });
}
console.log("Building whitener over " + whGroups.length + " concepts...");
const wh = buildWhitenerAndInstances(whGroups);
console.log("Ledoit-Wolf lambda = " + wh.lambda.toFixed(4) + "\n");

function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

async function candidatesForImage(imgPath) {
  let frame;
  try { frame = await extractImageRGB(imgPath, { maxSize: 384 }); }
  catch (e) { return { candidates: [], reason: "decode_fail" }; }
  // CANDIDATE PARITY: same generator as ingest (unions, both gates).
  const cands = candidatesForFrame(frame);
  if (!cands.length) return { candidates: [], reason: "no_warm_entities" };
  const qvecs = cands.map(c => ({
    sig: c,
    vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats),
  }));
  return { candidates: qvecs, reason: "ok" };
}

// Classifier A: min-cand KNN with per-concept ceilings.
function classifyKnnCeiling(qvecs) {
  let knnBest = Infinity, knnLabel = null;
  for (const q of qvecs) {
    for (const inst of instances) {
      const d = fisherWeightedDistance(q.vec, inst.vec, fw);
      if (d < knnBest) { knnBest = d; knnLabel = inst.label; }
    }
  }
  const ceiling = conceptCeilings.get(knnLabel) ?? 10.0;
  if (knnBest > ceiling) return { winner: null, dist: knnBest };
  return { winner: knnLabel, dist: knnBest };
}

// Classifier B: prototype centroid — best min over candidates against
// concept prototype means.
function classifyPrototype(qvecs) {
  let best = Infinity, bestLabel = null;
  for (const q of qvecs) {
    for (const [label, proto] of conceptPrototypes.entries()) {
      const d = fisherWeightedDistance(q.vec, proto, fw);
      if (d < best) { best = d; bestLabel = label; }
    }
  }
  return { winner: bestLabel, dist: best };
}

// FABLE MOVE 1: whitened KNN (Mahalanobis in raw = Euclidean in whitened).
function classifyWhitenedKnn(qvecs) {
  let best = Infinity, bestLabel = null;
  for (const q of qvecs) {
    const qw = wh.whiten(sanitize(q.vec));
    for (const inst of wh.whitenedInstances) {
      const d = euclideanSq(qw, inst.vec);
      if (d < best) { best = d; bestLabel = inst.label; }
    }
  }
  return { winner: bestLabel, dist: Math.sqrt(best) };
}
// FABLE MOVE 1 variant: whitened Fisher-softmax integration.
function classifyWhitenedNll(qvecs, beta = 3.0) {
  const perConcept = new Map();
  const allNegBetaD = [];
  const idx = [];
  const qws = qvecs.map(q => wh.whiten(sanitize(q.vec)));
  for (const qw of qws) {
    for (const inst of wh.whitenedInstances) {
      const d = Math.sqrt(euclideanSq(qw, inst.vec));
      allNegBetaD.push(-beta * d);
      idx.push(inst.label);
    }
  }
  if (!allNegBetaD.length) return { winner: null };
  const maxNeg = Math.max(...allNegBetaD);
  let sumExp = 0;
  const exps = new Array(allNegBetaD.length);
  for (let k = 0; k < allNegBetaD.length; k++) {
    exps[k] = Math.exp(allNegBetaD[k] - maxNeg);
    sumExp += exps[k];
  }
  const inv = sumExp > 0 ? 1 / sumExp : 0;
  for (let k = 0; k < exps.length; k++) {
    const lbl = idx[k];
    perConcept.set(lbl, (perConcept.get(lbl) || 0) + exps[k] * inv);
  }
  const ranked = [...perConcept.entries()].sort((a, b) => b[1] - a[1]);
  return { winner: ranked[0][0], mass: ranked[0][1] };
}

// Classifier C: NLL integration — Fisher-softmax over ALL (candidate, instance)
// pairs, marginalize into per-concept posterior mass, pick argmax.
// Higher beta = tighter; using beta=3.0 like fisherHopfield in video-vote.
function classifyNllIntegration(qvecs, beta = 3.0) {
  const perConcept = new Map();
  // Compute all distances first for global max-subtract in log-sum-exp.
  const allNegBetaD = [];
  const idx = []; // [{q, i, label}]
  for (const q of qvecs) {
    for (let i = 0; i < instances.length; i++) {
      const d = fisherWeightedDistance(q.vec, instances[i].vec, fw);
      allNegBetaD.push(-beta * d);
      idx.push(instances[i].label);
    }
  }
  if (!allNegBetaD.length) return { winner: null };
  const maxNeg = Math.max(...allNegBetaD);
  let sumExp = 0;
  const exps = new Array(allNegBetaD.length);
  for (let k = 0; k < allNegBetaD.length; k++) {
    exps[k] = Math.exp(allNegBetaD[k] - maxNeg);
    sumExp += exps[k];
  }
  const inv = sumExp > 0 ? 1 / sumExp : 0;
  for (let k = 0; k < exps.length; k++) {
    const lbl = idx[k];
    perConcept.set(lbl, (perConcept.get(lbl) || 0) + exps[k] * inv);
  }
  const ranked = [...perConcept.entries()].sort((a, b) => b[1] - a[1]);
  return { winner: ranked[0][0], mass: ranked[0][1] };
}

// Iterate only over the 28 TRAINED labels (they have a true unseen variant-5).
const trainedLabels = STORE.labels.map(r => r.label);
console.log("Scoring on " + trainedLabels.length + " trained held-out probes...\n");

let a_ok = 0, b_ok = 0, c_ok = 0, d_ok = 0, e_ok = 0;
let a_wrong = 0, b_wrong = 0, c_wrong = 0, d_wrong = 0, e_wrong = 0;
let a_review = 0, b_review = 0, c_review = 0, d_review = 0, e_review = 0;
let tested = 0, noCands = 0;

const confusionA = new Map(); // "true -> pred"
const confusionB = new Map();
const confusionC = new Map();
const confusionD = new Map();
const confusionE = new Map();
const perProbe = [];

function bump(map, key) { map.set(key, (map.get(key) || 0) + 1); }

for (const label of trainedLabels) {
  const heldoutPath = HELDOUT[label];
  if (!heldoutPath || !fs.existsSync(heldoutPath)) continue;
  const { candidates, reason } = await candidatesForImage(heldoutPath);
  if (!candidates.length) {
    console.log("  ~ " + label.padEnd(30) + " (no candidates: " + reason + ")");
    noCands++;
    tested++;
    continue;
  }
  const A = classifyKnnCeiling(candidates);
  const B = classifyPrototype(candidates);
  const C = classifyNllIntegration(candidates);
  const DR = classifyWhitenedKnn(candidates);
  const ER = classifyWhitenedNll(candidates);
  const okA = A.winner === label, okB = B.winner === label, okC = C.winner === label;
  const okD = DR.winner === label, okE = ER.winner === label;
  if (A.winner === null) a_review++; else if (okA) a_ok++; else { a_wrong++; bump(confusionA, label + " -> " + A.winner); }
  if (B.winner === null) b_review++; else if (okB) b_ok++; else { b_wrong++; bump(confusionB, label + " -> " + B.winner); }
  if (C.winner === null) c_review++; else if (okC) c_ok++; else { c_wrong++; bump(confusionC, label + " -> " + C.winner); }
  if (DR.winner === null) d_review++; else if (okD) d_ok++; else { d_wrong++; bump(confusionD, label + " -> " + DR.winner); }
  if (ER.winner === null) e_review++; else if (okE) e_ok++; else { e_wrong++; bump(confusionE, label + " -> " + ER.winner); }
  tested++;
  perProbe.push({ label, a: A.winner, b: B.winner, c: C.winner, d: DR.winner, e: ER.winner, okA, okB, okC, okD, okE });
  const gA = okA ? "A" : (A.winner === null ? "-" : "x");
  const gB = okB ? "B" : (B.winner === null ? "-" : "x");
  const gC = okC ? "C" : (C.winner === null ? "-" : "x");
  const gD = okD ? "D" : (DR.winner === null ? "-" : "x");
  const gE = okE ? "E" : (ER.winner === null ? "-" : "x");
  console.log("  [" + gA + gB + gC + gD + gE + "] " + label.padEnd(30) +
    " knn=" + String(A.winner ?? "review").padEnd(24) +
    " proto=" + String(B.winner ?? "review").padEnd(24) +
    " nll=" + String(C.winner ?? "review"));
}

function pct(n, d) { return d > 0 ? Math.round(n / d * 100) : 0; }

console.log("\n=== SCORES (side by side) ===");
console.log("Tested: " + tested + "  (no-candidate: " + noCands + ")");
console.log("Classifier A  min-cand KNN + ceilings : " + a_ok + "/" + tested + " = " + pct(a_ok, tested) + "%  (wrong=" + a_wrong + ", review=" + a_review + ")");
console.log("Classifier B  prototype centroid      : " + b_ok + "/" + tested + " = " + pct(b_ok, tested) + "%  (wrong=" + b_wrong + ", review=" + b_review + ")");
console.log("Classifier C  NLL integration         : " + c_ok + "/" + tested + " = " + pct(c_ok, tested) + "%  (wrong=" + c_wrong + ", review=" + c_review + ")");
console.log("Classifier D  WHITENED-KNN (Fable #1) : " + d_ok + "/" + tested + " = " + pct(d_ok, tested) + "%  (wrong=" + d_wrong + ", review=" + d_review + ")");
console.log("Classifier E  WHITENED-NLL (Fable #1) : " + e_ok + "/" + tested + " = " + pct(e_ok, tested) + "%  (wrong=" + e_wrong + ", review=" + e_review + ")");

function topN(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}
console.log("\n=== TOP-5 CONFUSIONS ===");
console.log("A (KNN+ceilings):");
for (const [k, v] of topN(confusionA, 5)) console.log("  " + v + "x  " + k);
console.log("B (prototype):");
for (const [k, v] of topN(confusionB, 5)) console.log("  " + v + "x  " + k);
console.log("C (NLL):");
for (const [k, v] of topN(confusionC, 5)) console.log("  " + v + "x  " + k);

// Consistency analysis across ALL FIVE classifiers.
const allAgreeCorrect = perProbe.filter(p => p.okA && p.okB && p.okC && p.okD && p.okE);
const anyDisagree = perProbe.filter(p => !(p.okA === p.okB && p.okB === p.okC && p.okC === p.okD && p.okD === p.okE));
console.log("\n=== CROSS-CLASSIFIER CONSISTENCY ===");
console.log("All 5 classifiers correct: " + allAgreeCorrect.length + "/" + tested);
console.log("Any disagreement:          " + anyDisagree.length + "/" + tested);

const bestPct = Math.max(pct(a_ok, tested), pct(b_ok, tested), pct(c_ok, tested));
if (bestPct >= 90) {
  console.log("\n>>> BEST >= 90%. All-agree list:");
  for (const p of allAgreeCorrect) console.log("  " + p.label);
  console.log(">>> Disagreement list:");
  for (const p of anyDisagree) console.log("  " + p.label + " A=" + p.a + " B=" + p.b + " C=" + p.c);
} else if (bestPct < 80) {
  console.log("\n>>> BEST < 80%. Hypotheses on top 3 confusions below.");
}
