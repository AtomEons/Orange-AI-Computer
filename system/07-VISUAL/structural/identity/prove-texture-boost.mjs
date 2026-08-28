#!/usr/bin/env bun
// prove-texture-boost.mjs — Attack: augment Fisher-KNN signature with a
// texture-vocabulary bag-of-visual-words axis derived from
// retinal-transform.textureVocabularyFull.
//
// Rationale (from signature_gap recon): the current 172-dim vector's texture
// block is 10 dims (log meanVar, lbpEntropy, 8 LBP-code ranks). It captures
// LOCAL binary pattern presence but NOT the DIRECTIONAL texture pattern
// distribution across the region (orientation-histogram fingerprint of
// texture cells). textureVocabularyFull yields per-cell 8-bin orientation
// histograms; we hash-bucket those into a 16-bin GLOBAL bag-of-words so
// they are cross-frame comparable, and concatenate to the flattened
// signature. Zero learned parameters. Deterministic. Store untouched on
// disk — augmentation happens on-the-fly.
//
// Method:
//   - Load photonic store (N=21 concepts, ENRICHED, hits 88% baseline).
//   - For each concept: enumerate clips on disk; last = held-out; rest = train.
//   - Build 172-dim Fisher templates from the store's stored 172-dim sigs
//     (baseline path, so we're not throwing away known signal).
//   - AUGMENT: compute texture-vocab-16 vector per stored sig by extracting
//     the concept's train clips, running warm-entity → union region →
//     textureVocabularyFull(L cropped to region) → hash-bucket cellCodes.
//     Concept-level texture-vocab template = mean over per-clip histograms.
//   - Compute Fisher stats separately for the 16-dim texture block (within,
//     between, per-dim weights), append to the store's Fisher stats.
//   - For each held-out video: extract 5 frames; compute per-frame 172-dim
//     candidate sigs (via existing signatureForUnion/Region multi-scale)
//     AND per-frame texture-vocab-16 vector (union region); concatenate;
//     Fisher-weighted KNN. Vote plurality > 2/5.
//
// Bun-only. No paid deps. Backend only.

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
  toL,
} from "./recognize-human-grade.mjs";
import { photoreceptorAdaptFrame } from "../photoreceptor-adapt-frame.mjs";
import { textureVocabularyFull } from "../retinal-transform.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const TVOCAB_BINS = 16;

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error("usage: bun prove-texture-boost.mjs <store.json>");
  process.exit(2);
}
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }

// -----------------------------------------------------------------------------
// Texture-vocabulary bag-of-visual-words
// -----------------------------------------------------------------------------

// FNV-1a 32-bit hash — deterministic, no learned parameter.
function fnv1a(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Crop L (full-frame luminance) to region [x,y,w,h] returning
 * { subL, subW, subH } clipped to frame bounds.
 */
function cropL(L, W, H, region) {
  const [rx, ry, rw, rh] = region;
  const x0 = Math.max(0, Math.floor(rx));
  const y0 = Math.max(0, Math.floor(ry));
  const x1 = Math.min(W, Math.floor(rx + rw));
  const y1 = Math.min(H, Math.floor(ry + rh));
  const subW = x1 - x0;
  const subH = y1 - y0;
  if (subW < 8 || subH < 8) return null;
  const subL = new Float32Array(subW * subH);
  for (let yy = 0; yy < subH; yy++) {
    const srcRow = (y0 + yy) * W + x0;
    const dstRow = yy * subW;
    for (let xx = 0; xx < subW; xx++) subL[dstRow + xx] = L[srcRow + xx];
  }
  return { subL, subW, subH };
}

/**
 * Compute 16-bin texture-vocab histogram (hash-bucketed bag-of-visual-words).
 * Returns Float32Array(16), L1-normalized. Deterministic. Zero learned params.
 */
function textureVocabHistogram(L, W, H, region) {
  const crop = cropL(L, W, H, region);
  if (!crop) return new Float32Array(TVOCAB_BINS);
  const { subL, subW, subH } = crop;
  const { vocabulary, cellCodes } = textureVocabularyFull(subL, subW, subH);
  // Build code -> signature-string map, then hash-bucket each cell into TVOCAB_BINS.
  const codeToSig = new Map();
  for (const v of vocabulary) codeToSig.set(v.code, v.signature);
  const hist = new Float32Array(TVOCAB_BINS);
  let total = 0;
  for (let i = 0; i < cellCodes.length; i++) {
    const code = cellCodes[i];
    const sig = codeToSig.get(code);
    if (!sig) continue;
    const bucket = fnv1a(sig) % TVOCAB_BINS;
    hist[bucket]++;
    total++;
  }
  if (total > 0) for (let b = 0; b < TVOCAB_BINS; b++) hist[b] /= total;
  return hist;
}

/**
 * From ONE frame + warm-entity extraction, compute a texture-vocab histogram
 * on the union region of warm entities. Returns null if no warm entity.
 */
function textureVocabForFrame(frame, hueGate) {
  const warm = extractWarmEntities(frame, { hue_gate: hueGate });
  if (!warm.length) return null;
  const adapted = photoreceptorAdaptFrame(frame);
  const W = adapted.width, H = adapted.height;
  const L = toL(adapted.R, adapted.G, adapted.B);
  // Union bounding box
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of warm) {
    if (e.region[0] < x0) x0 = e.region[0];
    if (e.region[1] < y0) y0 = e.region[1];
    if (e.region[0] + e.region[2] > x1) x1 = e.region[0] + e.region[2];
    if (e.region[1] + e.region[3] > y1) y1 = e.region[1] + e.region[3];
  }
  const region = [x0, y0, x1 - x0, y1 - y0];
  return textureVocabHistogram(L, W, H, region);
}

// -----------------------------------------------------------------------------
// Load store, attach Fisher stats (baseline 172-dim path)
// -----------------------------------------------------------------------------

console.log("=== TEXTURE-BOOST ATTACK (bag-of-visual-words, hash-bucketed) ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("attachFisherRatioToStore failed"); process.exit(1); }
console.log("Baseline D = " + stats.D + " dimensions");
console.log("Adding " + TVOCAB_BINS + "-dim texture-vocab bag-of-words axis");
console.log("Augmented D = " + (stats.D + TVOCAB_BINS) + "\n");

// -----------------------------------------------------------------------------
// Compute per-concept texture-vocab TRAINING template from disk clips (all-but-last)
// -----------------------------------------------------------------------------

const TRAIN_FRAMES_PER_CLIP = 3;
const conceptTvocabTrain = new Map();  // label -> array of 16-dim histograms (one per training frame)

console.log("--- Extracting training texture-vocab histograms from disk ---");
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) { console.log("  ! " + row.label + " — no dir, skipping"); continue; }
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) {
    // Only one clip: use it for both train and skip test (matches held-out validator behavior)
    console.log("  ~ " + row.label + " — <2 clips, held-out will skip");
  }
  const trainFiles = files.length >= 2 ? files.slice(0, -1) : [];
  const perClipHists = [];
  for (const f of trainFiles) {
    let frames;
    try { frames = await extractVideoFrames(path.join(dir, f), { frames: TRAIN_FRAMES_PER_CLIP, size: 384 }); }
    catch (e) { continue; }
    for (const fr of frames) {
      for (const hg of ["warm_loose", "any"]) {
        const h = textureVocabForFrame(fr, hg);
        if (h) { perClipHists.push(h); break; }
      }
    }
  }
  conceptTvocabTrain.set(row.label, perClipHists);
  console.log("  " + row.label.padEnd(18) + " " + perClipHists.length + " training histograms");
}

// -----------------------------------------------------------------------------
// Compute Fisher stats FOR THE 16-dim texture-vocab block (within/between)
// -----------------------------------------------------------------------------

function computeTvocabFisher() {
  const D = TVOCAB_BINS;
  // Global mean/std
  const allVecs = [];
  for (const hs of conceptTvocabTrain.values()) allVecs.push(...hs);
  if (!allVecs.length) return { fisher: new Float32Array(D).fill(1), gMean: new Float32Array(D), gStd: new Float32Array(D).fill(1), templates: new Map() };
  const gMean = new Float32Array(D);
  for (const v of allVecs) for (let f = 0; f < D; f++) gMean[f] += v[f];
  for (let f = 0; f < D; f++) gMean[f] /= allVecs.length;
  const gStd = new Float32Array(D);
  for (const v of allVecs) for (let f = 0; f < D; f++) { const d = v[f] - gMean[f]; gStd[f] += d * d; }
  for (let f = 0; f < D; f++) gStd[f] = Math.sqrt(Math.max(gStd[f] / Math.max(1, allVecs.length - 1), 1e-8));

  // Standardize per-concept histograms
  const conceptStd = new Map();
  for (const [label, hs] of conceptTvocabTrain.entries()) {
    const stdVecs = hs.map(v => {
      const o = new Float32Array(D);
      for (let f = 0; f < D; f++) o[f] = (v[f] - gMean[f]) / gStd[f];
      return o;
    });
    conceptStd.set(label, stdVecs);
  }

  // Per-concept mean / median / variance (on standardized)
  const templates = new Map();   // label -> Float32Array(D) — median template (standardized)
  const perConceptMean = [];
  const perConceptVar = [];
  for (const [label, stdVecs] of conceptStd.entries()) {
    if (!stdVecs.length) continue;
    const mean = new Float32Array(D);
    const median = new Float32Array(D);
    for (let f = 0; f < D; f++) {
      let s = 0;
      const col = new Array(stdVecs.length);
      for (let i = 0; i < stdVecs.length; i++) { s += stdVecs[i][f]; col[i] = stdVecs[i][f]; }
      mean[f] = s / stdVecs.length;
      col.sort((a, b) => a - b);
      const N = col.length;
      median[f] = N % 2 ? col[(N - 1) >> 1] : 0.5 * (col[(N >> 1) - 1] + col[N >> 1]);
    }
    const variance = new Float32Array(D);
    for (let f = 0; f < D; f++) {
      let s = 0;
      for (const v of stdVecs) { const d = v[f] - mean[f]; s += d * d; }
      variance[f] = stdVecs.length > 1 ? s / (stdVecs.length - 1) : 0;
    }
    templates.set(label, median);
    perConceptMean.push(mean);
    perConceptVar.push(variance);
  }

  const within = new Float32Array(D);
  for (let f = 0; f < D; f++) {
    let s = 0;
    for (const v of perConceptVar) s += v[f];
    within[f] = perConceptVar.length ? s / perConceptVar.length : 0;
  }
  const cMean = new Float32Array(D);
  for (let f = 0; f < D; f++) {
    let s = 0;
    for (const m of perConceptMean) s += m[f];
    cMean[f] = perConceptMean.length ? s / perConceptMean.length : 0;
  }
  const between = new Float32Array(D);
  for (let f = 0; f < D; f++) {
    let s = 0;
    for (const m of perConceptMean) { const d = m[f] - cMean[f]; s += d * d; }
    between[f] = perConceptMean.length > 1 ? s / (perConceptMean.length - 1) : 0;
  }
  const fisher = new Float32Array(D);
  let sumF = 0;
  for (let f = 0; f < D; f++) { fisher[f] = between[f] / (within[f] + 1e-6); sumF += fisher[f]; }
  if (sumF > 0) { const scale = D / sumF; for (let f = 0; f < D; f++) fisher[f] *= scale; }
  return { fisher, gMean, gStd, templates };
}

const tvocabFisher = computeTvocabFisher();
console.log("\n--- Texture-vocab Fisher weights ---");
console.log("  fisher[16] = [" + Array.from(tvocabFisher.fisher).map(x => x.toFixed(2)).join(", ") + "]");
const tvocabWeightSum = Array.from(tvocabFisher.fisher).reduce((a, b) => a + b, 0);
console.log("  weight sum = " + tvocabWeightSum.toFixed(2) + " (target ≈ " + TVOCAB_BINS + ")");

// -----------------------------------------------------------------------------
// Build augmented instances (172-dim standardized + 16-dim standardized) for KNN
// -----------------------------------------------------------------------------

const instances = [];
const conceptInstances = new Map();
const BASE_D = stats.D;
const AUG_D = BASE_D + TVOCAB_BINS;

for (const row of STORE.labels) {
  const tTmpl = tvocabFisher.templates.get(row.label);
  if (!tTmpl) { console.log("  ! " + row.label + " — no texture template, skipping in instances"); continue; }
  const perConcept = [];
  for (const s of row.signatures) {
    const rawBase = flattenSignature(s.sig);
    const stdBase = standardizeSignatureVector(rawBase, STORE.fisher_stats);
    // Concatenate concept's texture-vocab template (already standardized).
    // Every stored sig of the same concept gets the SAME 16-dim texture tail,
    // which is a defensible choice given the store lacks per-sig clip provenance.
    const augVec = new Float32Array(AUG_D);
    for (let f = 0; f < BASE_D; f++) augVec[f] = stdBase[f];
    for (let f = 0; f < TVOCAB_BINS; f++) augVec[BASE_D + f] = tTmpl[f];
    const inst = { label: row.label, vec: augVec, sig: s.sig };
    instances.push(inst);
    perConcept.push(inst);
  }
  conceptInstances.set(row.label, perConcept);
}

// Fisher weights: base 172 from STORE.fisher_stats.fisher, 16 from tvocabFisher.fisher
const fisherAug = new Float32Array(AUG_D);
for (let f = 0; f < BASE_D; f++) fisherAug[f] = STORE.fisher_stats.fisher[f];
for (let f = 0; f < TVOCAB_BINS; f++) fisherAug[BASE_D + f] = tvocabFisher.fisher[f];
const fwAug = { fisher: fisherAug };

// Per-concept ceilings from augmented distances (self-similarity)
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++)
    for (let j = i + 1; j < insts.length; j++)
      dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fwAug));
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
}

// Per-concept natural mean (unchanged from baseline)
const conceptNaturalMean = new Map();
for (const row of STORE.labels) {
  const scores = [];
  for (const s of row.signatures) {
    const sub = s.sig?.subsurface;
    if (sub) {
      const t = sub.translucencyScore ?? 0;
      const es = sub.edgeSoftness ?? 0;
      const sg = sub.shadowGlowRatio ?? 0;
      scores.push(0.6 * t + 0.3 * es + 0.1 * sg);
    }
  }
  if (scores.length) conceptNaturalMean.set(row.label, scores.reduce((a, b) => a + b, 0) / scores.length);
}

// -----------------------------------------------------------------------------
// Per-frame recognizer (augmented, mirrors prove-super-stack-video-vote.mjs)
// -----------------------------------------------------------------------------

function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

function standardizeTvocab(rawHist) {
  const D = TVOCAB_BINS;
  const out = new Float32Array(D);
  for (let f = 0; f < D; f++) out[f] = (rawHist[f] - tvocabFisher.gMean[f]) / tvocabFisher.gStd[f];
  return out;
}

function recognizeFrameAug(frame) {
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

  // Compute one texture-vocab-16 for the frame using warm-loose union.
  let frameTvocab = null;
  for (const hg of ["warm_loose", "any"]) {
    const h = textureVocabForFrame(frame, hg);
    if (h) { frameTvocab = h; break; }
  }
  const stdTvocab = frameTvocab ? standardizeTvocab(frameTvocab) : new Float32Array(TVOCAB_BINS);

  // Build augmented query vectors (base standardized + std texture-vocab-16).
  const qvecs = candidates.map(c => {
    const base = standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats);
    const aug = new Float32Array(AUG_D);
    for (let f = 0; f < BASE_D; f++) aug[f] = base[f];
    for (let f = 0; f < TVOCAB_BINS; f++) aug[BASE_D + f] = stdTvocab[f];
    return { sig: c, vec: aug };
  });

  let knnBest = Infinity, knnLabel = null, knnKind = null;
  let knnSecond = Infinity, knnSecondLabel = null;
  for (const q of qvecs) {
    for (const inst of instances) {
      const d = fisherWeightedDistance(q.vec, inst.vec, fwAug);
      if (d < knnBest) {
        if (knnLabel && knnLabel !== inst.label) { knnSecond = knnBest; knnSecondLabel = knnLabel; }
        knnBest = d; knnLabel = inst.label; knnKind = q.sig;
      } else if (d < knnSecond && inst.label !== knnLabel) {
        knnSecond = d; knnSecondLabel = inst.label;
      }
    }
  }
  const conceptCeiling = conceptCeilings.get(knnLabel) ?? 10.0;
  if (knnBest > conceptCeiling) return { winner: null };
  // Subsurface consistency gate (mirrors baseline)
  if (knnKind?._subsurface) {
    const sub = knnKind._subsurface;
    const t = sub.translucencyScore ?? 0;
    const es = sub.edgeSoftness ?? 0;
    const sg = sub.shadowGlowRatio ?? 0;
    const queryNat = 0.6 * t + 0.3 * es + 0.1 * sg;
    const winnerNat = conceptNaturalMean.get(knnLabel);
    if (winnerNat !== undefined && Math.abs(queryNat - winnerNat) > 0.15) {
      return { winner: null };
    }
  }
  return { winner: knnLabel };
}

// -----------------------------------------------------------------------------
// Held-out video vote (mirrors prove-super-stack-video-vote.mjs)
// -----------------------------------------------------------------------------

console.log("\n--- Held-out video vote ---");
let correctVideos = 0, testedVideos = 0, confWrongVideos = 0;
const misses = [];
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); }
  catch (e) { continue; }
  const votes = new Map();
  for (const f of frames) {
    const r = recognizeFrameAug(f);
    if (r.winner) votes.set(r.winner, (votes.get(r.winner) || 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [videoWinner, videoWinnerCount] = ranked[0] || [null, 0];
  const videoVerdict = videoWinnerCount > 2 ? videoWinner : null;
  const ok = videoVerdict === row.label;
  const wr = videoVerdict !== null && videoVerdict !== row.label;
  if (ok) correctVideos++;
  if (wr) { confWrongVideos++; misses.push({ label: row.label, verdict: videoVerdict, votes: ranked.slice(0, 3) }); }
  else if (!ok) { misses.push({ label: row.label, verdict: videoVerdict || "needs_review", votes: ranked.slice(0, 3) }); }
  testedVideos++;
  const pct = ok ? "✓" : (wr ? "✗" : "~");
  console.log("  " + pct + " " + row.label.padEnd(18) + " verdict=" + (videoVerdict || "needs_review").padEnd(20) + " votes=" + JSON.stringify(ranked.slice(0, 3)));
}

console.log("\n=== TEXTURE-BOOST VIDEO-VOTE SCORE ===");
const pct = testedVideos > 0 ? Math.round(correctVideos / testedVideos * 100) : 0;
console.log("Total: " + correctVideos + "/" + testedVideos + " = " + pct + "%");
console.log("Confident-wrong videos: " + confWrongVideos);
console.log("Misses (" + misses.length + "):");
for (const m of misses) console.log("  - " + m.label + " -> " + m.verdict + " votes=" + JSON.stringify(m.votes));
console.log("\nBASELINE (fisher-KNN, prove-super-stack-video-vote.mjs on same store): 88% (15/17)");
console.log("Store: " + storePath);
