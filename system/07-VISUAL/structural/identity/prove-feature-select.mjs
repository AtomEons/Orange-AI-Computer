#!/usr/bin/env bun
// prove-feature-select.mjs — top-K Fisher-dim feature selection.
// Rank all dims by Fisher weight; use only top K in the distance.
// Noise dims (Fisher near 0) can still influence the L2 sum; masking them out
// may cleanly separate a currently confused pair like clock/cat.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion, BIOLOGICAL_CONCEPTS } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const STORE = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

console.log("=== FEATURE-SELECT (top-K Fisher dims) · N=" + STORE.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const fisher = STORE.fisher_stats.fisher;
const D = fisher.length;

// Rank dims by Fisher weight (desc)
const dimRank = [...Array(D).keys()].sort((a, b) => fisher[b] - fisher[a]);
console.log("D=" + D + " · top-10 dims: " + dimRank.slice(0, 10).map(i => i + "(" + fisher[i].toFixed(2) + ")").join(", ") + "\n");

// Prep standardized instances
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

function makeMask(K) {
  const mask = new Uint8Array(D);
  for (let i = 0; i < K; i++) mask[dimRank[i]] = 1;
  return mask;
}
function distMasked(a, b, mask) { let d = 0; for (let i = 0; i < D; i++) if (mask[i] && Number.isFinite(a[i]) && Number.isFinite(b[i])) { const x = a[i] - b[i]; d += fisher[i] * x * x; } return Math.sqrt(d); }

function computeCeilings(mask) {
  const ceilings = new Map();
  for (const [label, insts] of conceptInstances.entries()) {
    if (insts.length < 2) { ceilings.set(label, Infinity); continue; }
    const dists = [];
    for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) dists.push(distMasked(insts[i].vec, insts[j].vec, mask));
    dists.sort((a, b) => a - b);
    ceilings.set(label, dists[dists.length - 1] * 1.8);
  }
  return ceilings;
}
function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s)), nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

// Precompute frame candidates
console.log("Precomputing candidates...");
const framesCache = [];
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); } catch (e) { continue; }
  const frameCandidates = [];
  for (const f of frames) {
    const cs = [];
    for (const hg of ["warm_loose", "any"]) {
      const warm = extractWarmEntities(f, { hue_gate: hg });
      if (!warm.length) continue;
      const u = signatureForUnion(f, warm); if (u) cs.push(u);
      for (const w of warm.slice(0, 5)) for (const region of multiScaleRegions(w.region)) {
        const s = signatureForRegion(f, region); if (s) cs.push(s);
      }
    }
    frameCandidates.push(cs.map(c => standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats)));
  }
  framesCache.push({ label: row.label, frameCandidates });
}
console.log("Cached " + framesCache.length + " videos\n");

function score(K) {
  const mask = makeMask(K);
  const ceilings = computeCeilings(mask);
  let correct = 0, tested = 0, confWrong = 0;
  const misses = [];
  for (const { label, frameCandidates } of framesCache) {
    const videoVotes = new Map();
    for (const qvecs of frameCandidates) {
      if (!qvecs.length) continue;
      let best = Infinity, bestLabel = null;
      for (const q of qvecs) for (const inst of instances) {
        const d = distMasked(q, inst.vec, mask);
        if (d < best) { best = d; bestLabel = inst.label; }
      }
      if (best <= (ceilings.get(bestLabel) ?? Infinity)) videoVotes.set(bestLabel, (videoVotes.get(bestLabel) || 0) + 1);
    }
    const rank = [...videoVotes.entries()].sort((a, b) => b[1] - a[1]);
    const [w, c] = rank[0] || [null, 0];
    const verdict = c >= 3 ? w : null;
    const ok = verdict === label; const wr = verdict !== null && verdict !== label;
    if (ok) correct++; if (wr) confWrong++;
    if (!ok) misses.push({ label, verdict, votes: rank.slice(0, 3) });
    tested++;
  }
  return { K, correct, tested, confWrong, pct: tested ? Math.round(correct / tested * 100) : 0, misses };
}

const Ks = [8, 12, 16, 20, 24, 32, 40, 48, 60, 80, 100, 128, D];
const results = [];
for (const K of Ks) {
  const r = score(K);
  console.log("K=" + String(K).padStart(3) + "  " + r.correct + "/" + r.tested + " (" + r.pct + "%) confWrong=" + r.confWrong);
  results.push(r);
}
results.sort((a, b) => b.pct - a.pct || a.confWrong - b.confWrong);
console.log("\n=== TOP 3 ===");
for (let i = 0; i < 3 && i < results.length; i++) {
  const r = results[i];
  console.log(String(i + 1) + ". K=" + r.K + " → " + r.pct + "% (" + r.correct + "/" + r.tested + ") confWrong=" + r.confWrong);
  console.log("   misses: " + r.misses.slice(0, 6).map(m => m.label + "→" + (m.verdict || "?")).join(" | "));
}
