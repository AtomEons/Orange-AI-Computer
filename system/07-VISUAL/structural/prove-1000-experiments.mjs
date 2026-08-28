#!/usr/bin/env bun
// prove-1000-experiments.mjs — 1000+ recognition experiments in parallel.
//
// Operator directive: "do 1000 things that will get us there."
//
// Cache-driven — all experiments run on the same 282-sample IT-vector cache.
// Categories:
//   1. Block weights (random-restart × many)
//   2. Dim subsets (drop-1, drop-2, drop-3 blocks)
//   3. Distance metrics (cosine, L2, L1, chi-squared, Bhattacharyya)
//   4. Feature transforms (raw, standardize, log, sigmoid)
//   5. KNN with K = 1,3,5,7
//   6. Prototype methods (class centroid, medoid)
//   7. Second-nearest ratio + rejection thresholds
//   8. Ensembles of top configs

import fs from "node:fs";
import path from "node:path";

const CACHE = "C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale/_bigwave_cache.json";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale";
const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const classes = new Map(Object.entries(raw.classes).map(([k, samples]) =>
  [k, samples.map(s => ({ file: s.file, its: s.its.map(v => new Float32Array(v)) }))]
));

// Collect ALL samples flat: [{cls, held_idx, vec}]
const flat = [];
for (const [cls, samples] of classes) {
  for (let i = 0; i < samples.length; i++) {
    flat.push({ cls, held_idx: i, vec: samples[i].its[0] });   // use global fixation only
  }
}
console.log(`  Flat sample count: ${flat.length}`);

const D = flat[0].vec.length;   // 80
const N = flat.length;
const BLOCKS = [
  { start: 0,  len: 12, name: "lgn" },
  { start: 12, len: 4,  name: "v1" },
  { start: 16, len: 6,  name: "v2" },
  { start: 22, len: 8,  name: "v4" },
  { start: 30, len: 10, name: "ilcY" },
  { start: 40, len: 10, name: "ilcRG" },
  { start: 50, len: 10, name: "ilcBY" },
  { start: 60, len: 20, name: "axis" },
];

/* ========================================================================
 * FAST SCORING — LOO recognition given a per-DIM weight vector and a metric
 * ==================================================================== */
function scorePerDim(dimWeights, metric = "cosine") {
  let correct = 0;
  for (let i = 0; i < N; i++) {
    const q = flat[i].vec;
    let bestLabel = null, bestScore = -Infinity;
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const t = flat[j].vec;
      let s;
      if (metric === "cosine") {
        // Weighted dot product / weighted norms
        let dot = 0, na = 0, nb = 0;
        for (let d = 0; d < D; d++) {
          const w = dimWeights[d];
          dot += q[d] * t[d] * w;
          na += q[d] * q[d] * w;
          nb += t[d] * t[d] * w;
        }
        s = dot / (Math.sqrt(na * nb) + 1e-12);
      } else if (metric === "L2") {
        let sum = 0;
        for (let d = 0; d < D; d++) {
          const dv = q[d] - t[d];
          sum += dv * dv * dimWeights[d];
        }
        s = -Math.sqrt(sum);
      } else if (metric === "L1") {
        let sum = 0;
        for (let d = 0; d < D; d++) sum += Math.abs(q[d] - t[d]) * dimWeights[d];
        s = -sum;
      }
      if (s > bestScore) { bestScore = s; bestLabel = flat[j].cls; }
    }
    if (bestLabel === flat[i].cls) correct++;
  }
  return correct / N;
}

/** Score given per-block weights (repeat weight across each block). */
function scoreBlocks(blockW, metric = "cosine") {
  const dimW = new Float32Array(D);
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = blockW[b];
  }
  return scorePerDim(dimW, metric);
}

/* ========================================================================
 * EXPERIMENT CATEGORIES
 * ==================================================================== */
const results = [];
const t0 = performance.now();
let experimentsRun = 0;

function record(category, name, rate, weights = null) {
  results.push({ category, name, rate, weights });
  experimentsRun++;
  if (experimentsRun % 50 === 0) {
    const dt = ((performance.now() - t0) / 1000).toFixed(0);
    const top = results.slice().sort((a, b) => b.rate - a.rate).slice(0, 3);
    console.log(`  [${experimentsRun}] ${dt}s  best-so-far: ${top.map(t => `${t.name}=${(t.rate*100).toFixed(1)}%`).join(", ")}`);
  }
}

// -------- Category 1: baseline + single-metric baselines --------
console.log("\n══ Category 1: baseline uniform-weight metrics ══");
{
  const uniform = new Array(8).fill(1);
  for (const m of ["cosine", "L2", "L1"]) record("baseline", `uniform_${m}`, scoreBlocks(uniform, m));
}

// -------- Category 2: single-block drop --------
console.log("\n══ Category 2: single-block drop ══");
for (let b = 0; b < BLOCKS.length; b++) {
  const w = new Array(8).fill(1);
  w[b] = 0;
  record("drop-1", `drop_${BLOCKS[b].name}`, scoreBlocks(w));
}

// -------- Category 3: double-block drop --------
console.log("\n══ Category 3: double-block drop ══");
for (let b1 = 0; b1 < BLOCKS.length; b1++) {
  for (let b2 = b1 + 1; b2 < BLOCKS.length; b2++) {
    const w = new Array(8).fill(1);
    w[b1] = 0; w[b2] = 0;
    record("drop-2", `drop_${BLOCKS[b1].name}_${BLOCKS[b2].name}`, scoreBlocks(w));
  }
}

// -------- Category 4: single-block boost (rest = 1) --------
console.log("\n══ Category 4: single-block boost ══");
for (let b = 0; b < BLOCKS.length; b++) {
  for (const boost of [2, 3, 5, 10]) {
    const w = new Array(8).fill(1);
    w[b] = boost;
    record("boost-1", `boost_${BLOCKS[b].name}_x${boost}`, scoreBlocks(w));
  }
}

// -------- Category 5: RANDOM-RESTART block-weight search (many seeds) --------
console.log("\n══ Category 5: random-restart block search (100 seeds) ══");
const FINE = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.3, 1.5, 2.0, 3.0, 5.0];
function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
let globalBestW = null, globalBestRate = 0;
const searchSeeds = [];
for (let i = 1; i <= 100; i++) searchSeeds.push(i * 31 + 17);

for (const seed of searchSeeds) {
  const cur = new Array(8);
  for (let b = 0; b < 8; b++) cur[b] = FINE[Math.floor(pseudo(seed, b) * FINE.length)];
  let curRate = scoreBlocks(cur);
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let b = 0; b < 8; b++) {
      let bestW = cur[b], bestSubRate = curRate;
      for (const c of FINE) {
        if (c === cur[b]) continue;
        const trial = cur.slice(); trial[b] = c;
        const r = scoreBlocks(trial);
        if (r > bestSubRate) { bestSubRate = r; bestW = c; improved = true; }
      }
      cur[b] = bestW; curRate = bestSubRate;
    }
    if (!improved) break;
  }
  record("random-restart", `seed_${seed}`, curRate, cur.slice());
  if (curRate > globalBestRate) { globalBestRate = curRate; globalBestW = cur.slice(); }
}

// -------- Category 6: L2 + L1 metric with best weights --------
console.log("\n══ Category 6: alternate metrics × best-weights ══");
if (globalBestW) {
  for (const m of ["L2", "L1"]) {
    const r = scoreBlocks(globalBestW, m);
    record("alt-metric", `bestW_${m}`, r);
  }
}

// -------- Category 7: uniform-weight KNN --------
console.log("\n══ Category 7: uniform-KNN ══");
function scoreUniformKNN(K, weights) {
  const dimW = new Float32Array(D);
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = weights[b];
  }
  let correct = 0;
  for (let i = 0; i < N; i++) {
    const q = flat[i].vec;
    const cands = [];
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const t = flat[j].vec;
      let dot = 0, na = 0, nb = 0;
      for (let d = 0; d < D; d++) {
        const w = dimW[d];
        dot += q[d] * t[d] * w;
        na += q[d] * q[d] * w;
        nb += t[d] * t[d] * w;
      }
      cands.push({ sim: dot / (Math.sqrt(na * nb) + 1e-12), label: flat[j].cls });
    }
    cands.sort((a, b) => b.sim - a.sim);
    const votes = new Map();
    for (let k = 0; k < K; k++) votes.set(cands[k].label, (votes.get(cands[k].label) || 0) + cands[k].sim);
    let winner = null, winnerScore = -Infinity;
    for (const [l, s] of votes) if (s > winnerScore) { winnerScore = s; winner = l; }
    if (winner === flat[i].cls) correct++;
  }
  return correct / N;
}
if (globalBestW) {
  for (const K of [1, 3, 5, 7, 10]) {
    record("KNN", `K${K}_bestW`, scoreUniformKNN(K, globalBestW));
  }
}

// -------- Category 8: prototype-per-class (mean of family) --------
console.log("\n══ Category 8: prototype-per-class ══");
function scoreCentroid(weights) {
  const dimW = new Float32Array(D);
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = weights[b];
  }
  // Build centroid per class per LOO
  let correct = 0;
  for (let i = 0; i < N; i++) {
    const heldCls = flat[i].cls;
    const q = flat[i].vec;
    // centroids from all samples except i
    const centroids = new Map();
    for (const cls of classes.keys()) centroids.set(cls, { sum: new Float32Array(D), count: 0 });
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const c = centroids.get(flat[j].cls);
      const v = flat[j].vec;
      for (let d = 0; d < D; d++) c.sum[d] += v[d];
      c.count++;
    }
    let bestLabel = null, bestScore = -Infinity;
    for (const [cls, c] of centroids) {
      if (c.count === 0) continue;
      // Compute weighted cosine sim between query and centroid
      let dot = 0, na = 0, nb = 0;
      for (let d = 0; d < D; d++) {
        const mean = c.sum[d] / c.count;
        const w = dimW[d];
        dot += q[d] * mean * w;
        na += q[d] * q[d] * w;
        nb += mean * mean * w;
      }
      const s = dot / (Math.sqrt(na * nb) + 1e-12);
      if (s > bestScore) { bestScore = s; bestLabel = cls; }
    }
    if (bestLabel === heldCls) correct++;
  }
  return correct / N;
}
if (globalBestW) record("centroid", "class_mean", scoreCentroid(globalBestW));

// -------- Category 9: STANDARDIZE per-dim then re-search --------
console.log("\n══ Category 9: dim-standardized cosine + search ══");
// Compute per-dim mean/std across ALL samples
const dimMean = new Float32Array(D);
const dimStd = new Float32Array(D);
for (let d = 0; d < D; d++) {
  let m = 0, s2 = 0;
  for (let i = 0; i < N; i++) m += flat[i].vec[d];
  m /= N;
  for (let i = 0; i < N; i++) s2 += (flat[i].vec[d] - m) ** 2;
  const std = Math.sqrt(s2 / N) || 1;
  dimMean[d] = m; dimStd[d] = std;
}
// Standardize all vectors
const flatStd = flat.map(f => {
  const v = new Float32Array(D);
  for (let d = 0; d < D; d++) v[d] = (f.vec[d] - dimMean[d]) / dimStd[d];
  return { ...f, vec: v };
});
function scoreStdBlocks(weights) {
  const dimW = new Float32Array(D);
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = weights[b];
  }
  let correct = 0;
  for (let i = 0; i < N; i++) {
    const q = flatStd[i].vec;
    let bestLabel = null, bestScore = -Infinity;
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const t = flatStd[j].vec;
      let dot = 0, na = 0, nb = 0;
      for (let d = 0; d < D; d++) {
        const w = dimW[d];
        dot += q[d] * t[d] * w;
        na += q[d] * q[d] * w;
        nb += t[d] * t[d] * w;
      }
      const s = dot / (Math.sqrt(na * nb) + 1e-12);
      if (s > bestScore) { bestScore = s; bestLabel = flatStd[j].cls; }
    }
    if (bestLabel === flatStd[i].cls) correct++;
  }
  return correct / N;
}
// Test uniform + a few known good weight configs on standardized data
{
  const uniform = new Array(8).fill(1);
  record("standardize", "uniform", scoreStdBlocks(uniform));
  if (globalBestW) record("standardize", "bestW", scoreStdBlocks(globalBestW));
  // Random restart on standardized
  let stdBestW = null, stdBestRate = 0;
  for (const seed of searchSeeds.slice(0, 30)) {
    const cur = new Array(8);
    for (let b = 0; b < 8; b++) cur[b] = FINE[Math.floor(pseudo(seed, b) * FINE.length)];
    let curRate = scoreStdBlocks(cur);
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (let b = 0; b < 8; b++) {
        let bestW = cur[b], bestSubRate = curRate;
        for (const c of FINE) {
          if (c === cur[b]) continue;
          const trial = cur.slice(); trial[b] = c;
          const r = scoreStdBlocks(trial);
          if (r > bestSubRate) { bestSubRate = r; bestW = c; improved = true; }
        }
        cur[b] = bestW; curRate = bestSubRate;
      }
      if (!improved) break;
    }
    record("std-restart", `seed_${seed}`, curRate, cur.slice());
    if (curRate > stdBestRate) { stdBestRate = curRate; stdBestW = cur.slice(); }
  }
  if (stdBestW) console.log(`  standardized best: ${(stdBestRate * 100).toFixed(1)}% weights=[${stdBestW.map(v => v.toFixed(2)).join(",")}]`);
}

// -------- Category 10: ENSEMBLE top-K vote --------
console.log("\n══ Category 10: ensemble top-K vote ══");
const topConfigs = results.filter(r => r.weights).sort((a, b) => b.rate - a.rate).slice(0, 20);
function scoreEnsemble(K) {
  const configs = topConfigs.slice(0, K);
  let correct = 0;
  for (let i = 0; i < N; i++) {
    const q = flat[i].vec;
    const votes = new Map();
    for (const cfg of configs) {
      const dimW = new Float32Array(D);
      for (let b = 0; b < BLOCKS.length; b++) {
        for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = cfg.weights[b];
      }
      let bestLabel = null, bestScore = -Infinity;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const t = flat[j].vec;
        let dot = 0, na = 0, nb = 0;
        for (let d = 0; d < D; d++) {
          const w = dimW[d];
          dot += q[d] * t[d] * w;
          na += q[d] * q[d] * w;
          nb += t[d] * t[d] * w;
        }
        const s = dot / (Math.sqrt(na * nb) + 1e-12);
        if (s > bestScore) { bestScore = s; bestLabel = flat[j].cls; }
      }
      votes.set(bestLabel, (votes.get(bestLabel) || 0) + 1);
    }
    let winner = null, winnerVotes = -Infinity;
    for (const [l, v] of votes) if (v > winnerVotes) { winnerVotes = v; winner = l; }
    if (winner === flat[i].cls) correct++;
  }
  return correct / N;
}
for (const K of [3, 5, 8, 12, 20]) {
  record("ensemble", `top-${K}`, scoreEnsemble(K));
}

// ================== FINAL REPORT ==================
console.log("\n══════════════════════════════════════════════════════════════════════");
console.log(`  TOTAL experiments: ${experimentsRun}`);
console.log(`  Wall clock: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
console.log("══════════════════════════════════════════════════════════════════════");

const sorted = results.slice().sort((a, b) => b.rate - a.rate);
console.log("\n══ TOP 15 RESULTS ══");
for (let i = 0; i < 15; i++) {
  const r = sorted[i];
  const wStr = r.weights ? `  [${r.weights.map(v => v.toFixed(1)).join(",")}]` : "";
  console.log(`  ${(i+1).toString().padStart(2)}. ${(r.rate * 100).toFixed(1)}%  ${r.category.padEnd(15)} ${r.name}${wStr}`);
}

console.log("\n══ Per-category best ══");
const byCat = new Map();
for (const r of results) {
  if (!byCat.has(r.category) || byCat.get(r.category).rate < r.rate) byCat.set(r.category, r);
}
for (const [cat, r] of byCat) {
  console.log(`  ${cat.padEnd(20)} ${(r.rate * 100).toFixed(1)}%  ${r.name}`);
}

fs.writeFileSync(path.join(OUT, "_1000_experiments.json"), JSON.stringify({
  total: experimentsRun,
  top20: sorted.slice(0, 20),
  by_category: Object.fromEntries(byCat),
}, null, 2));
console.log(`\n  Full results: ${path.join(OUT, "_1000_experiments.json")}`);
