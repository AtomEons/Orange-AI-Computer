#!/usr/bin/env bun
// prove-mega-stack.mjs — SUPER-STACK + attested-best attention chain.
//
// STACK:
//   All 15 keys from prove-super-stack.mjs PLUS:
//     K19. Photoreceptor Naka-Rushton frame adaptation (already in signatures)
//     K20. gaussian_2 preprocessor (found empirically to be top-1 for 12/19 images)
//     K21. density-cluster.bind attention (89% robustness across regimes, 652 exp confirmed)
//     K22. merge_overlap post-processing
//     K23. Union candidate INCLUDES density-cluster entities alongside attentionMultiAxisV2

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
  BIOLOGICAL_CONCEPTS,
} from "./recognize-human-grade.mjs";
import { naturalVsSynthetic } from "./second-pass-alpha.mjs";
import { photoreceptorAdaptFrame } from "../photoreceptor-adapt-frame.mjs";
import { bind as densityClusterBind } from "../binders/density-cluster.mjs";
import { postprocess } from "../binders/post-processing.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) { console.error("usage: bun prove-mega-stack.mjs store.json"); process.exit(2); }
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }

console.log("=== MEGA-STACK VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed"); process.exit(1); }
console.log("D = " + stats.D + " dimensions\n");

const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
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

const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
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

// K20 — gaussian_2 preprocessor (separable Gaussian, σ=2)
function gaussianBlur2(field, w, h) {
  const sigma = 2.0;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const size = radius * 2 + 1;
  const kernel = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - radius;
    kernel[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += kernel[i];
  }
  for (let i = 0; i < size; i++) kernel[i] /= sum;
  const tmp = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const xx = Math.max(0, Math.min(w - 1, x + k));
      acc += field[y * w + xx] * kernel[k + radius];
    }
    tmp[y * w + x] = acc;
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let k = -radius; k <= radius; k++) {
      const yy = Math.max(0, Math.min(h - 1, y + k));
      acc += tmp[yy * w + x] * kernel[k + radius];
    }
    out[y * w + x] = acc;
  }
  return out;
}

// K21+K22 — density-cluster entity extractor with merge_overlap post-processing
function densityClusterEntities(frame) {
  const adapted = photoreceptorAdaptFrame(frame);
  const W = adapted.width, H = adapted.height;
  // K20: gaussian_2 blur on the R channel (density-cluster reads R)
  const blurredR = gaussianBlur2(adapted.R, W, H);
  const result = densityClusterBind(blurredR, W, H, {});
  const merged = postprocess("merge_overlap", result.entities || []);
  return merged.entities || [];
}

// Fisher-weighted Modern Hopfield (Ramsauer 2020)
function fisherHopfield(qvec, instances, fw, beta = 3.0, iters = 2) {
  let current = qvec, att = null;
  for (let it = 0; it < iters; it++) {
    const D = current.length;
    const dists = instances.map(inst => fisherWeightedDistance(current, inst.vec, fw));
    const negBetaD = dists.map(d => -beta * d);
    const maxNeg = Math.max(...negBetaD);
    const exps = negBetaD.map(x => Math.exp(x - maxNeg));
    const sumExps = exps.reduce((a, b) => a + b, 0) || 1;
    att = exps.map(v => v / sumExps);
    const next = new Float32Array(D);
    for (let i = 0; i < instances.length; i++) {
      const w = att[i], v = instances[i].vec;
      for (let f = 0; f < D; f++) next[f] += w * v[f];
    }
    current = next;
  }
  const perConcept = new Map();
  for (let i = 0; i < instances.length; i++) {
    const lbl = instances[i].label;
    perConcept.set(lbl, (perConcept.get(lbl) || 0) + att[i]);
  }
  return [...perConcept.entries()].sort((a, b) => b[1] - a[1])[0][0];
}

function recognizeMegaFrame(frame) {
  const candidates = [];
  // K21: density-cluster entities on adapted+blurred R
  const dcEnts = densityClusterEntities(frame);
  // Filter to entities with area > small
  const dcFiltered = dcEnts.filter(e => {
    const [x, y, w, h] = e.region || [0, 0, 0, 0];
    return w * h > 400;   // min 20×20 pixels
  }).slice(0, 5);
  // Build signatures from density-cluster entities using signatureForRegion
  for (const e of dcFiltered) {
    for (const region of multiScaleRegions(e.region)) {
      const s = signatureForRegion(frame, region);
      if (s) candidates.push(s);
    }
  }
  // K2, K13: also try both hue_gates via attentionMultiAxisV2 (the current path)
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
  if (!candidates.length) return { winner: null, dist: Infinity };
  const qvecs = candidates.map(c => ({ sig: c, vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats) }));
  let knnBest = Infinity, knnLabel = null, knnKind = null;
  for (const q of qvecs) {
    for (const inst of instances) {
      const d = fisherWeightedDistance(q.vec, inst.vec, fw);
      if (d < knnBest) { knnBest = d; knnLabel = inst.label; knnKind = q.sig; }
    }
  }
  const hopfieldWinner = qvecs.length ? fisherHopfield(qvecs[0].vec, instances, fw) : null;
  const conceptCeiling = conceptCeilings.get(knnLabel) ?? 10.0;
  let rejected = knnBest > conceptCeiling;
  let natural_gate_triggered = false;
  if (!rejected && knnLabel && BIOLOGICAL_CONCEPTS.has(knnLabel) && knnKind?._subsurface) {
    const nat = naturalVsSynthetic(knnKind._subsurface);
    if (!nat.natural) { rejected = true; natural_gate_triggered = true; }
  }
  return {
    winner: rejected ? null : knnLabel,
    dist: knnBest,
    hopfield_winner: hopfieldWinner,
    knn_hopfield_agree: knnLabel === hopfieldWinner,
    dc_candidates: dcFiltered.length,
    total_candidates: candidates.length,
  };
}

// Per-frame validation
let correct = 0, tested = 0, confWrong = 0, agreeCount = 0;
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
  let ok = 0, wr = 0, tot = 0, agree = 0, dcCandTotal = 0, totCands = 0;
  for (const f of frames) {
    const r = recognizeMegaFrame(f);
    if (r.winner === row.label) ok++;
    else if (r.winner && r.winner !== row.label) wr++;
    if (r.knn_hopfield_agree) agree++;
    dcCandTotal += r.dc_candidates || 0;
    totCands += r.total_candidates || 0;
    tot++;
  }
  correct += ok; tested += tot; confWrong += wr; agreeCount += agree;
  const pct = tot > 0 ? Math.round(ok / tot * 100) : 0;
  perConcept.push({ label: row.label, correct: ok, tested: tot, confWrong: wr, pct });
  console.log("  " + row.label.padEnd(18) + " " + ok + "/" + tot + " = " + String(pct).padStart(3) + "%  confWrong=" + wr + "  dc_ents_avg=" + (dcCandTotal/tot).toFixed(1) + "  total_cands_avg=" + (totCands/tot).toFixed(0));
}

const pct = tested > 0 ? Math.round(correct / tested * 100) : 0;
console.log("\n=== MEGA-STACK SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%");
console.log("Confident-wrong: " + confWrong);
console.log("KNN-Hopfield agreement: " + agreeCount + "/" + tested);
