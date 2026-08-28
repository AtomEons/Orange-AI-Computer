#!/usr/bin/env bun
// config-sweep.mjs — try 24 combinations of the "sort of worked" ideas.
// Operator: nothing is trash. Reuse+recycle+rethink+reengineer.
//
// Sweep dimensions:
//   consensus_gate:      OFF, ON              (2)
//   margin_ratio:        NONE, 0.70, 0.75, 0.80  (4)
//   fisher_min_sigs:     1 (all), 3           (2)
//   biological_threshold: 0.3 (loose), 0.55   (2)
// Total: 2 × 4 × 2 × 2 = 32 configs · per-video accuracy on 17 held-out clips.

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
const STORE_BASE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

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

// Pre-cache: extract all held-out frames ONCE (expensive)
console.log("Pre-caching held-out frames...");
const heldOutFrames = new Map();
for (const row of STORE_BASE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  try {
    const frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 });
    heldOutFrames.set(row.label, frames);
  } catch (e) {}
}
console.log("Held-out frames cached: " + heldOutFrames.size + " concepts");

// Pre-cache: extract query signatures per frame (very expensive)
console.log("Pre-caching query signatures per frame...");
const queryCache = new Map();  // label → [ [{sig}, {sig}, ...], ... ] per frame
for (const [label, frames] of heldOutFrames.entries()) {
  const perFrame = [];
  for (const frame of frames) {
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
    perFrame.push(candidates);
  }
  queryCache.set(label, perFrame);
}
console.log("Query cache built\n");

function testConfig({ consensus, margin, fisherMinSigs, bioThreshold }) {
  // Fisher stats per config (fisherMinSigs matters)
  const STORE = JSON.parse(JSON.stringify(STORE_BASE));  // deep copy so fisher stats attach fresh
  // Prune concepts with fewer sigs than fisherMinSigs from stats
  // Actually — that's set via monkey-patching flatten or duplicating computeFisherRatioStats.
  // For simplicity, use the current attachFisherRatioToStore and just filter after.
  const stats = attachFisherRatioToStore(STORE);
  if (!stats) return null;
  const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
  const instances = [];
  const conceptInstances = new Map();
  for (const row of STORE.labels) {
    if (fisherMinSigs > 1 && row.signatures.length < fisherMinSigs) continue;   // exclude from KNN if below min
    const per = [];
    for (const s of row.signatures) {
      const raw = flattenSignature(s.sig);
      const std = standardizeSignatureVector(raw, STORE.fisher_stats);
      const inst = { label: row.label, vec: std, sig: s.sig };
      instances.push(inst); per.push(inst);
    }
    conceptInstances.set(row.label, per);
  }
  const conceptCeilings = new Map();
  for (const [label, insts] of conceptInstances.entries()) {
    if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
    let maxD = 0;
    for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) {
      const d = fisherWeightedDistance(insts[i].vec, insts[j].vec, fw);
      if (d > maxD) maxD = d;
    }
    conceptCeilings.set(label, maxD * 1.8);
  }

  let correct = 0, tested = 0, confWrong = 0;
  const details = [];
  for (const [conceptLabel, framesCandidates] of queryCache.entries()) {
    const votes = new Map();
    for (const candidates of framesCandidates) {
      if (!candidates.length) continue;
      const qvecs = candidates.map(c => ({ sig: c, vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats) }));
      let knnBest = Infinity, knnLabel = null, knnKind = null, knnSecond = Infinity;
      for (const q of qvecs) {
        for (const inst of instances) {
          const d = fisherWeightedDistance(q.vec, inst.vec, fw);
          if (d < knnBest) {
            if (knnLabel && knnLabel !== inst.label) { knnSecond = knnBest; }
            knnBest = d; knnLabel = inst.label; knnKind = q.sig;
          } else if (d < knnSecond && inst.label !== knnLabel) {
            knnSecond = d;
          }
        }
      }
      const conceptCeiling = conceptCeilings.get(knnLabel) ?? 10.0;
      if (knnBest > conceptCeiling) continue;
      if (margin && knnSecond !== Infinity && knnBest / knnSecond > margin) continue;
      if (consensus) {
        const hopfieldWinner = fisherHopfield(qvecs[0].vec, instances, fw);
        if (knnLabel !== hopfieldWinner) continue;
      }
      if (knnLabel && BIOLOGICAL_CONCEPTS.has(knnLabel) && knnKind?._subsurface) {
        const sub = knnKind._subsurface;
        const t = sub.translucencyScore ?? 0, es = sub.edgeSoftness ?? 0, sg = sub.shadowGlowRatio ?? 0;
        const combined = 0.6 * t + 0.3 * es + 0.1 * sg;
        if (combined <= bioThreshold) continue;
      }
      votes.set(knnLabel, (votes.get(knnLabel) || 0) + 1);
    }
    const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
    const [videoWinner, videoCount] = ranked[0] || [null, 0];
    const verdict = videoCount > 2 ? videoWinner : null;
    const ok = verdict === conceptLabel;
    const wr = verdict !== null && verdict !== conceptLabel;
    if (ok) correct++;
    if (wr) confWrong++;
    tested++;
    details.push({ label: conceptLabel, verdict, ok, wr });
  }
  return { correct, tested, confWrong, details };
}

// Sweep
const configs = [];
for (const consensus of [false, true]) {
  for (const margin of [null, 0.70, 0.75, 0.80]) {
    for (const fisherMinSigs of [1, 3]) {
      for (const bioThreshold of [0.3, 0.55]) {
        configs.push({ consensus, margin, fisherMinSigs, bioThreshold });
      }
    }
  }
}

console.log("=== CONFIG SWEEP (" + configs.length + " configs) ===\n");
const results = [];
for (let i = 0; i < configs.length; i++) {
  const cfg = configs[i];
  const r = testConfig(cfg);
  if (!r) continue;
  const pct = Math.round(r.correct / r.tested * 100);
  const cfgStr = `consensus=${cfg.consensus?"ON ":"OFF"} margin=${cfg.margin?cfg.margin:"none"} fisherMin=${cfg.fisherMinSigs} bioT=${cfg.bioThreshold}`;
  console.log(`  ${cfgStr}  ${r.correct}/${r.tested}=${pct}%  cw=${r.confWrong}`);
  results.push({ cfg, correct: r.correct, tested: r.tested, pct, confWrong: r.confWrong, details: r.details });
}

results.sort((a, b) => (b.correct - a.correct) || (a.confWrong - b.confWrong));
console.log("\n=== TOP 5 ===");
for (let i = 0; i < 5 && i < results.length; i++) {
  const r = results[i];
  console.log(`  ${r.correct}/${r.tested}=${r.pct}% cw=${r.confWrong} :: ${JSON.stringify(r.cfg)}`);
}
