#!/usr/bin/env bun
// prove-alt-metrics.mjs — video-vote validator that sweeps DISTANCE METRIC
// and AGGREGATION. The 5280-config sweep proved the standard knobs are dead
// so we vary what actually shapes the retrieval:
//   metric  ∈ {fisherL2, cosine, correlation, minPerDim, chi2, l1}
//   agg     ∈ {minCand, meanCand, votePlurality}
//   voteT   ∈ {2, 3}
// = 6 × 3 × 2 = 36 configs

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

console.log("=== ALT-METRIC SWEEP · N=" + STORE.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const fisher = STORE.fisher_stats.fisher;
const D = fisher.length;

// Prep instances (standardized)
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

// Distance functions (all take standardized vecs; NaN → skip that dim)
function d_fisherL2(a, b) { let d = 0; for (let i = 0; i < D; i++) { const x = a[i] - b[i]; if (Number.isFinite(x)) d += fisher[i] * x * x; } return Math.sqrt(d); }
function d_cosine(a, b) { let dot = 0, na = 0, nb = 0; for (let i = 0; i < D; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } if (!na || !nb) return 2; return 1 - dot / Math.sqrt(na * nb); }
function d_correlation(a, b) {
  let ma = 0, mb = 0, k = 0;
  for (let i = 0; i < D; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { ma += a[i]; mb += b[i]; k++; }
  if (!k) return 2; ma /= k; mb /= k;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < D; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { const da = a[i] - ma, db = b[i] - mb; dot += da * db; na += da * da; nb += db * db; }
  if (!na || !nb) return 2;
  return 1 - dot / Math.sqrt(na * nb);
}
function d_minPerDim(a, b) { let s = 0, k = 0; for (let i = 0; i < D; i++) { const x = Math.abs(a[i] - b[i]); if (Number.isFinite(x)) { s += fisher[i] * Math.min(x, 3.0); k++; } } return s / Math.max(1, k); }
function d_chi2(a, b) { let s = 0; for (let i = 0; i < D; i++) { const A = Math.abs(a[i]) + 1e-6, B = Math.abs(b[i]) + 1e-6; if (Number.isFinite(A) && Number.isFinite(B)) { const num = (A - B) * (A - B); s += fisher[i] * num / (A + B); } } return s; }
function d_l1(a, b) { let s = 0; for (let i = 0; i < D; i++) { const x = Math.abs(a[i] - b[i]); if (Number.isFinite(x)) s += fisher[i] * x; } return s; }

const METRICS = { fisherL2: d_fisherL2, cosine: d_cosine, correlation: d_correlation, minPerDim: d_minPerDim, chi2: d_chi2, l1: d_l1 };

// Per-metric per-concept ceilings
function computeCeilings(metricFn) {
  const ceilings = new Map();
  for (const [label, insts] of conceptInstances.entries()) {
    if (insts.length < 2) { ceilings.set(label, Infinity); continue; }
    const dists = [];
    for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) dists.push(metricFn(insts[i].vec, insts[j].vec));
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

// Precompute candidates per held-out frame
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
      const u = signatureForUnion(f, warm);
      if (u) cs.push(u);
      for (const w of warm.slice(0, 5)) for (const region of multiScaleRegions(w.region)) {
        const s = signatureForRegion(f, region); if (s) cs.push(s);
      }
    }
    const qvecs = cs.map(c => ({ sig: c, vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats) }));
    frameCandidates.push(qvecs);
  }
  framesCache.push({ label: row.label, frameCandidates });
}
console.log("Cached " + framesCache.length + " video candidate sets\n");

function scoreConfig(metricName, agg, voteT) {
  const metricFn = METRICS[metricName];
  const ceilings = computeCeilings(metricFn);
  let correct = 0, tested = 0, confWrong = 0;
  const misses = [];
  for (const { label, frameCandidates } of framesCache) {
    const videoVotes = new Map();
    for (const qvecs of frameCandidates) {
      if (!qvecs.length) continue;
      let winner = null;
      if (agg === "minCand") {
        let best = Infinity, bestLabel = null;
        for (const q of qvecs) for (const inst of instances) {
          const d = metricFn(q.vec, inst.vec);
          if (d < best) { best = d; bestLabel = inst.label; }
        }
        if (best <= (ceilings.get(bestLabel) ?? Infinity)) winner = bestLabel;
      } else if (agg === "meanCand") {
        // for each concept, mean distance across candidates × min-per-inst
        const perConcept = new Map();
        for (const q of qvecs) {
          for (const inst of instances) {
            const d = metricFn(q.vec, inst.vec);
            const cur = perConcept.get(inst.label);
            if (!cur || d < cur.minD) perConcept.set(inst.label, { minD: d });
          }
        }
        let best = Infinity, bestLabel = null;
        for (const [l, v] of perConcept.entries()) if (v.minD < best) { best = v.minD; bestLabel = l; }
        if (best <= (ceilings.get(bestLabel) ?? Infinity)) winner = bestLabel;
      } else if (agg === "votePlurality") {
        const cvotes = new Map();
        for (const q of qvecs) {
          let best = Infinity, bestLabel = null;
          for (const inst of instances) {
            const d = metricFn(q.vec, inst.vec);
            if (d < best) { best = d; bestLabel = inst.label; }
          }
          if (best <= (ceilings.get(bestLabel) ?? Infinity)) cvotes.set(bestLabel, (cvotes.get(bestLabel) || 0) + 1);
        }
        const ranked = [...cvotes.entries()].sort((a, b) => b[1] - a[1]);
        if (ranked.length) {
          const [w, c] = ranked[0]; const total = ranked.reduce((a, [, v]) => a + v, 0);
          if (c / total >= 0.5) winner = w;
        }
      }
      if (winner) videoVotes.set(winner, (videoVotes.get(winner) || 0) + 1);
    }
    const rank = [...videoVotes.entries()].sort((a, b) => b[1] - a[1]);
    const [vw, vc] = rank[0] || [null, 0];
    const verdict = vc >= voteT ? vw : null;
    const ok = verdict === label;
    const wr = verdict !== null && verdict !== label;
    if (ok) correct++;
    if (wr) confWrong++;
    if (!ok) misses.push({ label, verdict, votes: rank.slice(0, 3) });
    tested++;
  }
  return { correct, tested, confWrong, pct: tested ? Math.round(correct / tested * 100) : 0, misses };
}

const results = [];
for (const m of Object.keys(METRICS)) {
  for (const agg of ["minCand", "meanCand", "votePlurality"]) {
    for (const voteT of [2, 3]) {
      const r = scoreConfig(m, agg, voteT);
      const key = m + "|" + agg + "|voteT=" + voteT;
      console.log(key.padEnd(40) + " → " + r.correct + "/" + r.tested + " (" + r.pct + "%) confWrong=" + r.confWrong);
      results.push({ metric: m, agg, voteT, ...r });
    }
  }
}
results.sort((a, b) => b.pct - a.pct || a.confWrong - b.confWrong);
console.log("\n=== TOP 5 ===");
for (let i = 0; i < 5 && i < results.length; i++) {
  const r = results[i];
  console.log(String(i + 1).padStart(2) + ". " + r.metric + " · " + r.agg + " · voteT=" + r.voteT + " · " + r.pct + "% (" + r.correct + "/" + r.tested + ") confWrong=" + r.confWrong);
  console.log("   misses: " + r.misses.slice(0, 6).map(m => m.label + "→" + (m.verdict || "?")).join("  "));
}

fs.writeFileSync(process.argv[3] || "alt-metric-results.json", JSON.stringify(results, null, 2));
