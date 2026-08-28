#!/usr/bin/env bun
// sweep-5000.mjs — precompute-once, apply-many. 5280 configs on the
// N=17 photonic held-out set.
//
// Dimensions:
//   consensus      : OFF, ON                                   (2)
//   margin_ratio   : null, 0.50, 0.55, 0.60, 0.65, 0.70,
//                    0.75, 0.80, 0.85, 0.90, 0.95, 1.00       (12)
//   ceiling_mult   : 0.5, 0.7, 0.9, 1.0, 1.2, 1.5,
//                    1.8, 2.0, 2.3, 2.5, 3.0                  (11)
//   bio_threshold  : 0.2, 0.25, 0.3, 0.35, 0.4, 0.45,
//                    0.5, 0.55, 0.6, 0.7                      (10)
//   vote_threshold : 2, 3                                     (2)
// Total: 2 × 12 × 11 × 10 × 2 = 5280

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion, BIOLOGICAL_CONCEPTS } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const storePath = process.argv[2];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s)), nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}
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

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("no fisher"); process.exit(1); }
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

const instances = [];
const conceptInstances = new Map();
for (const row of STORE.labels) {
  const per = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const inst = { label: row.label, vec: std, sig: s.sig };
    instances.push(inst); per.push(inst);
  }
  conceptInstances.set(row.label, per);
}

// Per-concept max within-concept distance (for ceilings later)
const conceptMaxWithin = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  let maxD = 0;
  if (insts.length >= 2) {
    for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) {
      const d = fisherWeightedDistance(insts[i].vec, insts[j].vec, fw);
      if (d > maxD) maxD = d;
    }
  }
  conceptMaxWithin.set(label, maxD);
}

// Extract held-out frames + candidates + precompute best matches per candidate
console.log("Pre-caching frames + candidate matches...");
const testCases = [];   // per (concept, frame) — array of candidates with knn+hopfield results
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); } catch (e) { continue; }
  const frameData = [];
  for (const f of frames) {
    const candidates = [];
    for (const hg of ["warm_loose", "any"]) {
      const warm = extractWarmEntities(f, { hue_gate: hg });
      if (!warm.length) continue;
      const u = signatureForUnion(f, warm);
      if (u) candidates.push(u);
      for (const w of warm.slice(0, 5)) {
        for (const region of multiScaleRegions(w.region)) {
          const s = signatureForRegion(f, region);
          if (s) candidates.push(s);
        }
      }
    }
    if (!candidates.length) { frameData.push(null); continue; }
    // Global KNN across all candidates
    let knnBest = Infinity, knnLabel = null, knnKind = null, knnSecondDist = Infinity;
    for (const c of candidates) {
      const qvec = standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats);
      for (const inst of instances) {
        const d = fisherWeightedDistance(qvec, inst.vec, fw);
        if (d < knnBest) {
          if (knnLabel && knnLabel !== inst.label) knnSecondDist = knnBest;
          knnBest = d; knnLabel = inst.label; knnKind = c;
        } else if (d < knnSecondDist && inst.label !== knnLabel) {
          knnSecondDist = d;
        }
      }
    }
    // Hopfield (once per frame — use first candidate)
    const firstQvec = standardizeSignatureVector(flattenSignature(candidates[0]), STORE.fisher_stats);
    const hopfieldWinner = fisherHopfield(firstQvec, instances, fw);
    // Bio score from best candidate's subsurface
    let bioCombined = null;
    if (knnKind?._subsurface) {
      const sub = knnKind._subsurface;
      const t = sub.translucencyScore ?? 0, es = sub.edgeSoftness ?? 0, sg = sub.shadowGlowRatio ?? 0;
      bioCombined = 0.6 * t + 0.3 * es + 0.1 * sg;
    }
    frameData.push({ knnBest, knnLabel, knnSecondDist, hopfieldWinner, bioCombined });
  }
  testCases.push({ concept: row.label, frameData });
}
console.log("Test cases cached: " + testCases.length + " concepts × 5 frames");

// Sweep
const configs = [];
for (const consensus of [false, true]) {
  for (const margin of [null, 0.50, 0.55, 0.60, 0.65, 0.70, 0.75, 0.80, 0.85, 0.90, 0.95, 1.00]) {
    for (const ceilMult of [0.5, 0.7, 0.9, 1.0, 1.2, 1.5, 1.8, 2.0, 2.3, 2.5, 3.0]) {
      for (const bioT of [0.2, 0.25, 0.3, 0.35, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7]) {
        for (const voteT of [2, 3]) {
          configs.push({ consensus, margin, ceilMult, bioT, voteT });
        }
      }
    }
  }
}

console.log("\n=== SWEEP OF " + configs.length + " CONFIGS ===\n");
const results = [];
const start = Date.now();
for (let i = 0; i < configs.length; i++) {
  const cfg = configs[i];
  let correct = 0, tested = 0, confWrong = 0;
  for (const tc of testCases) {
    const votes = new Map();
    for (const fd of tc.frameData) {
      if (!fd) continue;
      const ceiling = (conceptMaxWithin.get(fd.knnLabel) ?? 5.0) * cfg.ceilMult || 5.0 * cfg.ceilMult;
      if (fd.knnBest > ceiling) continue;
      if (cfg.margin && fd.knnSecondDist !== Infinity && fd.knnBest / fd.knnSecondDist > cfg.margin) continue;
      if (cfg.consensus && fd.knnLabel !== fd.hopfieldWinner) continue;
      if (BIOLOGICAL_CONCEPTS.has(fd.knnLabel) && fd.bioCombined !== null && fd.bioCombined <= cfg.bioT) continue;
      votes.set(fd.knnLabel, (votes.get(fd.knnLabel) || 0) + 1);
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    const [winner, count] = ranked[0] || [null, 0];
    const verdict = count >= cfg.voteT ? winner : null;
    if (verdict === tc.concept) correct++;
    else if (verdict !== null) confWrong++;
    tested++;
  }
  results.push({ ...cfg, correct, tested, confWrong });
  if (i > 0 && i % 500 === 0) console.log("  [" + i + "/" + configs.length + "] elapsed " + Math.round((Date.now() - start) / 1000) + "s");
}
console.log("\nSweep done in " + Math.round((Date.now() - start) / 1000) + " seconds");

// Ranking: primary by correct desc, secondary by confWrong asc
results.sort((a, b) => (b.correct - a.correct) || (a.confWrong - b.confWrong));
console.log("\n=== TOP 20 CONFIGS ===");
for (let i = 0; i < 20 && i < results.length; i++) {
  const r = results[i];
  const pct = Math.round(r.correct / r.tested * 100);
  console.log(`  #${i + 1}: ${r.correct}/${r.tested}=${pct}% cw=${r.confWrong} :: consensus=${r.consensus} margin=${r.margin} ceil=${r.ceilMult} bio=${r.bioT} voteT=${r.voteT}`);
}

// Also: max recall with 0 conf-wrong
const clean = results.filter(r => r.confWrong === 0);
clean.sort((a, b) => b.correct - a.correct);
console.log("\n=== BEST 10 WITH ZERO CONFIDENT-WRONG ===");
for (let i = 0; i < 10 && i < clean.length; i++) {
  const r = clean[i];
  const pct = Math.round(r.correct / r.tested * 100);
  console.log(`  ${r.correct}/${r.tested}=${pct}% :: consensus=${r.consensus} margin=${r.margin} ceil=${r.ceilMult} bio=${r.bioT} voteT=${r.voteT}`);
}

// Save full results as JSON for further analysis
fs.writeFileSync(path.join(FIXTURES, "youtube-corpus", "sweep-5000-results.json"), JSON.stringify(results, null, 2));
console.log("\nFull results: 07-VISUAL/fixtures/youtube-corpus/sweep-5000-results.json");
