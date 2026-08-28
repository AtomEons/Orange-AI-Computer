#!/usr/bin/env bun
// prove-all-on-store.mjs — run baseline + 3 alt classifiers on a given store,
// report all scores in one pass. Use for quick apples-to-apples comparison
// once store-wave2-merged-enriched.json is ready.
//
// Classifiers:
//   1. Baseline: super-stack video-vote (current 88% recognizer)
//   2. Prototype: mean-vec centroid per concept
//   3. Rank-fusion: Borda across fisherL2 + cosine + L1
//   4. NLL: sum-log-distance integration across frames

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { candidatesForFrame, BIOLOGICAL_CONCEPTS } from "./recognize-human-grade.mjs";
import { buildWhitenerAndInstances, euclideanSq } from "./whitened-metric.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const STORE_PATH = process.argv[2];
if (!STORE_PATH) { console.error("usage: prove-all-on-store.mjs STORE_PATH"); process.exit(1); }
const STORE = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));

console.log("=== PROVE-ALL · STORE: " + path.basename(STORE_PATH) + " · N=" + STORE.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
const D = fw.fisher.length;
console.log("D=" + D + "\n");

// Instances
const instances = [];
const conceptInstances = new Map();
for (const row of STORE.labels) {
  const per = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const inst = { label: row.label, vec: std };
    instances.push(inst); per.push(inst);
  }
  conceptInstances.set(row.label, per);
}
const labels = [...conceptInstances.keys()];

// Prototypes
const prototypes = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (!insts.length) continue;
  const proto = new Float32Array(D);
  const counts = new Uint32Array(D);
  for (const inst of insts) for (let i = 0; i < D; i++) if (Number.isFinite(inst.vec[i])) { proto[i] += inst.vec[i]; counts[i]++; }
  for (let i = 0; i < D; i++) proto[i] = counts[i] ? proto[i] / counts[i] : NaN;
  prototypes.set(label, proto);
}

// FABLE MOVE 1: build within-class whitener with Ledoit-Wolf shrinkage.
// Sanitize NaN → 0 for the covariance computation (equivalent to imputing
// missing dims to the concept mean, which is what Fisher stats do too).
function sanitize(v) {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Number.isFinite(v[i]) ? v[i] : 0;
  return out;
}
const whGroups = [];
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) continue;   // need ≥2 samples per concept for within-class variance
  whGroups.push({ label, vecs: insts.map(i => sanitize(i.vec)) });
}
console.log("Building whitener over " + whGroups.length + " concepts...");
const wh = buildWhitenerAndInstances(whGroups);
console.log("Ledoit-Wolf lambda = " + wh.lambda.toFixed(4) + " (0 = pure sample cov, 1 = diagonal target)\n");
// Whitened prototypes (whiten each concept mean once)
const whProtos = new Map();
for (const [label, mu] of wh.meansWhitened.entries()) whProtos.set(label, mu);

// Ceilings for baseline (KNN)
const ceilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { ceilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
  dists.sort((a, b) => a - b);
  ceilings.set(label, dists[dists.length - 1] * 1.8);
}

function d_cosine(a, b) { let dot = 0, na = 0, nb = 0; for (let i = 0; i < D; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } if (!na || !nb) return 2; return 1 - dot / Math.sqrt(na * nb); }
function d_l1(a, b) { let s = 0; for (let i = 0; i < D; i++) { const x = Math.abs(a[i] - b[i]); if (Number.isFinite(x)) s += fw.fisher[i] * x; } return s; }

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s)), nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

// Precompute all frame candidates
console.log("Precomputing candidates...");
const cache = [];
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label === "orange_fruit" ? "orange" : row.label === "apple_fruit" ? "apple" : row.label));
  const dirAlt = fs.existsSync(dir) ? dir : path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dirAlt)) continue;
  const files = fs.readdirSync(dirAlt).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dirAlt, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); } catch (e) { continue; }
  const perFrame = [];
  for (const f of frames) {
    // CANDIDATE PARITY: same generator as ingest (unions, both gates).
    const cs = candidatesForFrame(f);
    perFrame.push(cs.map(c => standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats)));
  }
  cache.push({ label: row.label, perFrame });
}
console.log("Cached " + cache.length + " videos\n");

function classifyBaseline({ perFrame }) {
  const votes = new Map();
  for (const qvecs of perFrame) {
    if (!qvecs.length) continue;
    let best = Infinity, bestLabel = null;
    for (const q of qvecs) for (const inst of instances) {
      const d = fisherWeightedDistance(q, inst.vec, fw);
      if (d < best) { best = d; bestLabel = inst.label; }
    }
    if (best <= (ceilings.get(bestLabel) ?? Infinity)) votes.set(bestLabel, (votes.get(bestLabel) || 0) + 1);
  }
  const rank = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [w, c] = rank[0] || [null, 0];
  return c > 2 ? w : null;
}
function classifyPrototype({ perFrame }) {
  const votes = new Map();
  for (const qvecs of perFrame) {
    if (!qvecs.length) continue;
    let best = Infinity, bestLabel = null;
    for (const q of qvecs) for (const [label, proto] of prototypes.entries()) {
      const d = fisherWeightedDistance(q, proto, fw);
      if (d < best) { best = d; bestLabel = label; }
    }
    votes.set(bestLabel, (votes.get(bestLabel) || 0) + 1);
  }
  const rank = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [w, c] = rank[0] || [null, 0];
  return c > 2 ? w : null;
}
function classifyRankFusion({ perFrame }) {
  const METRICS = { l2: fisherWeightedDistance, cos: d_cosine, l1: d_l1 };
  const videoVotes = new Map();
  for (const qvecs of perFrame) {
    if (!qvecs.length) continue;
    const borda = new Map();
    for (const [mname, mfn] of Object.entries(METRICS)) {
      const perConcept = new Map();
      for (const q of qvecs) for (const inst of instances) {
        const d = mname === "l2" ? mfn(q, inst.vec, fw) : mfn(q, inst.vec);
        const cur = perConcept.get(inst.label);
        if (!cur || d < cur) perConcept.set(inst.label, d);
      }
      const ranked = [...perConcept.entries()].sort((a, b) => a[1] - b[1]);
      for (let i = 0; i < ranked.length; i++) borda.set(ranked[i][0], (borda.get(ranked[i][0]) || 0) + (labels.length - i));
    }
    const ranked = [...borda.entries()].sort((a, b) => b[1] - a[1]);
    if (ranked.length) videoVotes.set(ranked[0][0], (videoVotes.get(ranked[0][0]) || 0) + 1);
  }
  const rank = [...videoVotes.entries()].sort((a, b) => b[1] - a[1]);
  const [w, c] = rank[0] || [null, 0];
  return c > 2 ? w : null;
}
function classifyNLL({ perFrame }) {
  const nll = new Map();
  for (const l of labels) nll.set(l, 0);
  let used = 0;
  for (const qvecs of perFrame) {
    if (!qvecs.length) continue;
    used++;
    for (const l of labels) {
      const insts = conceptInstances.get(l);
      let best = Infinity;
      for (const q of qvecs) for (const inst of insts) {
        const d = fisherWeightedDistance(q, inst.vec, fw);
        if (d < best) best = d;
      }
      nll.set(l, nll.get(l) + Math.log(1 + best));
    }
  }
  if (used < 3) return null;
  const ranked = [...nll.entries()].sort((a, b) => a[1] - b[1]);
  const [w, nw] = ranked[0], [, nr] = ranked[1];
  return nr - nw > 0.05 ? w : null;
}

// FABLE MOVE 1: full within-class-whitened Mahalanobis KNN.
// Query is whitened once per candidate; then plain Euclidean in whitened
// space equals Mahalanobis in raw. Nuisance directions get discounted
// automatically because their whitened coordinates are large.
function classifyWhitened({ perFrame }) {
  const votes = new Map();
  for (const qvecs of perFrame) {
    if (!qvecs.length) continue;
    let best = Infinity, bestLabel = null;
    for (const q of qvecs) {
      const qw = wh.whiten(sanitize(q));
      for (const inst of wh.whitenedInstances) {
        const d = euclideanSq(qw, inst.vec);
        if (d < best) { best = d; bestLabel = inst.label; }
      }
    }
    if (bestLabel) votes.set(bestLabel, (votes.get(bestLabel) || 0) + 1);
  }
  const rank = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [w, c] = rank[0] || [null, 0];
  return c > 2 ? w : null;
}
// FABLE MOVE 1 variant: NLL integration in whitened space.
function classifyWhitenedNLL({ perFrame }) {
  const nll = new Map();
  for (const l of labels) nll.set(l, 0);
  let used = 0;
  for (const qvecs of perFrame) {
    if (!qvecs.length) continue;
    used++;
    const qws = qvecs.map(q => wh.whiten(sanitize(q)));
    for (const l of labels) {
      let bestSq = Infinity;
      for (const inst of wh.whitenedInstances) {
        if (inst.label !== l) continue;
        for (const qw of qws) {
          const d = euclideanSq(qw, inst.vec);
          if (d < bestSq) bestSq = d;
        }
      }
      nll.set(l, nll.get(l) + Math.log(1 + Math.sqrt(bestSq)));
    }
  }
  if (used < 3) return null;
  const ranked = [...nll.entries()].sort((a, b) => a[1] - b[1]);
  const [w, nw] = ranked[0], [, nr] = ranked[1];
  return nr - nw > 0.05 ? w : null;
}

const CLASSIFIERS = [
  { name: "baseline", fn: classifyBaseline },
  { name: "prototype", fn: classifyPrototype },
  { name: "rankFusion", fn: classifyRankFusion },
  { name: "NLL", fn: classifyNLL },
  { name: "whitened-KNN", fn: classifyWhitened },
  { name: "whitened-NLL", fn: classifyWhitenedNLL },
];

for (const { name, fn } of CLASSIFIERS) {
  let correct = 0, tested = 0, confWrong = 0;
  const misses = [];
  for (const entry of cache) {
    const verdict = fn(entry);
    const ok = verdict === entry.label;
    const wr = verdict !== null && verdict !== entry.label;
    if (ok) correct++; if (wr) confWrong++;
    if (!ok) misses.push(entry.label + "→" + (verdict || "?"));
    tested++;
  }
  const pct = tested ? Math.round(correct / tested * 100) : 0;
  console.log(name.padEnd(12) + " " + correct + "/" + tested + " = " + pct + "% · confWrong=" + confWrong);
  if (misses.length && misses.length <= 12) console.log("  misses: " + misses.join(", "));
  else if (misses.length) console.log("  misses (" + misses.length + "): " + misses.slice(0, 12).join(", ") + " ...");
}
