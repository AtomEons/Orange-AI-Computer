#!/usr/bin/env bun
// prove-asymmetric-fusion.mjs — test asymmetric fusion strategies on cached data.
//
// Cache from prove-500-big-wave.mjs has 4 IT vectors per sample.
// Try multiple recognition strategies without re-capturing:
//   A) query=1_global, family=1_global (baseline replay — should match earlier W)
//   B) query=1_global, family=4_all (asymmetric family expansion)
//   C) query=4_all,    family=1_global (asymmetric query expansion)
//   D) query=4_all,    family=4_all (big wave, already know = 80.1%)
//   E) query=1_global, family=1_global_and_saccadic_fused (family = mean-normalized fusion)

import fs from "node:fs";
import path from "node:path";
import { itVariantSim } from "./eye/it-variants.mjs";

const CACHE_PATH = "C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale/_bigwave_cache.json";
if (!fs.existsSync(CACHE_PATH)) { console.log("no cache"); process.exit(1); }

const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
const classes = new Map(Object.entries(raw.classes).map(([k, samples]) =>
  [k, samples.map(s => ({ file: s.file, its: s.its.map(v => new Float32Array(v)) }))]
));

function normalize(vec) {
  let n = 0;
  for (let i = 0; i < vec.length; i++) n += vec[i] * vec[i];
  n = Math.sqrt(n) || 1;
  const out = new Float32Array(vec.length);
  for (let i = 0; i < vec.length; i++) out[i] = vec[i] / n;
  return out;
}

function meanFuse(vectors) {
  const D = vectors[0].length;
  const out = new Float32Array(D);
  for (const v of vectors) for (let i = 0; i < D; i++) out[i] += v[i];
  for (let i = 0; i < D; i++) out[i] /= vectors.length;
  return normalize(out);
}

// Selectors return an array of IT vectors from a sample
const QSel = {
  global_only: (s) => [s.its[0]],
  all_4:       (s) => s.its,
  fused:       (s) => [meanFuse(s.its)],
};
const TSel = QSel;

function scoreStrategy(name, qSel, tSel) {
  const classes_arr = Array.from(classes.keys());
  let correct = 0, total = 0;
  for (const cls of classes_arr) {
    const samples = classes.get(cls);
    if (samples.length < 2) continue;
    for (let held_idx = 0; held_idx < samples.length; held_idx++) {
      const query_vecs = qSel(samples[held_idx]);
      let bestLabel = null, bestSim = -Infinity;
      for (const otherCls of classes_arr) {
        const otherSamples = classes.get(otherCls);
        let famBest = -Infinity;
        for (let j = 0; j < otherSamples.length; j++) {
          if (otherCls === cls && j === held_idx) continue;
          const train_vecs = tSel(otherSamples[j]);
          for (const tv of train_vecs) for (const qv of query_vecs) {
            const s = itVariantSim(qv, tv);
            if (s > famBest) famBest = s;
          }
        }
        if (famBest > bestSim) { bestSim = famBest; bestLabel = otherCls; }
      }
      total++;
      if (bestLabel === cls) correct++;
    }
  }
  return { name, correct, total, rate: correct / total };
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  ASYMMETRIC FUSION — try 5 query/family strategies fast   ║");
console.log("╚══════════════════════════════════════════════════════════╝");

const strategies = [
  ["A: baseline W (global only)",    QSel.global_only, TSel.global_only],
];

// Baseline
const A = scoreStrategy(strategies[0][0], strategies[0][1], strategies[0][2]);
console.log(`  ${A.name.padEnd(40)} ${A.correct}/${A.total} = ${(A.rate * 100).toFixed(1)}%`);

// NEW APPROACH — k-nearest-neighbors voting.
// Instead of max-sim wins, use top-K nearest training vectors, vote by class.
function scoreKNN(K, sel = QSel.global_only) {
  const classes_arr = Array.from(classes.keys());
  let correct = 0, total = 0;
  for (const cls of classes_arr) {
    const samples = classes.get(cls);
    if (samples.length < 2) continue;
    for (let held_idx = 0; held_idx < samples.length; held_idx++) {
      const query = sel(samples[held_idx])[0];
      // Collect (sim, label) for all training vectors
      const cands = [];
      for (const otherCls of classes_arr) {
        const otherSamples = classes.get(otherCls);
        for (let j = 0; j < otherSamples.length; j++) {
          if (otherCls === cls && j === held_idx) continue;
          for (const tv of sel(otherSamples[j])) {
            cands.push({ sim: itVariantSim(query, tv), label: otherCls });
          }
        }
      }
      cands.sort((a, b) => b.sim - a.sim);
      const topK = cands.slice(0, K);
      // Weighted vote by similarity
      const votes = new Map();
      for (const c of topK) votes.set(c.label, (votes.get(c.label) || 0) + c.sim);
      let bestLabel = null, bestVotes = -Infinity;
      for (const [l, v] of votes) if (v > bestVotes) { bestVotes = v; bestLabel = l; }
      total++;
      if (bestLabel === cls) correct++;
    }
  }
  return { name: `KNN K=${K}`, correct, total, rate: correct / total };
}

// Try KNN with various K
for (const K of [1, 3, 5, 7, 10, 15]) {
  const r = scoreKNN(K);
  console.log(`  KNN K=${K.toString().padStart(2)}                              ${r.correct}/${r.total} = ${(r.rate * 100).toFixed(1)}%`);
}

// NEW APPROACH — block-weighted cosine sim.
// The IT vector has 8 blocks (LGN 12 / V1 4 / V2 6 / V4 8 / ILC-Y 10 / ILC-RG 10 / ILC-BY 10 / axis 20).
// Try weighting per-block instead of uniform.
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

function blockSim(a, b, weights) {
  let sum = 0;
  for (let bi = 0; bi < BLOCKS.length; bi++) {
    const B = BLOCKS[bi];
    let s = 0;
    for (let i = B.start; i < B.start + B.len; i++) s += a[i] * b[i];
    sum += s * weights[bi];
  }
  return sum;
}

function scoreBlockWeights(weights, tag) {
  const classes_arr = Array.from(classes.keys());
  let correct = 0, total = 0;
  for (const cls of classes_arr) {
    const samples = classes.get(cls);
    if (samples.length < 2) continue;
    for (let held_idx = 0; held_idx < samples.length; held_idx++) {
      const q = samples[held_idx].its[0];
      let bestLabel = null, bestSim = -Infinity;
      for (const otherCls of classes_arr) {
        const otherSamples = classes.get(otherCls);
        let famBest = -Infinity;
        for (let j = 0; j < otherSamples.length; j++) {
          if (otherCls === cls && j === held_idx) continue;
          const t = otherSamples[j].its[0];
          const s = blockSim(q, t, weights);
          if (s > famBest) famBest = s;
        }
        if (famBest > bestSim) { bestSim = famBest; bestLabel = otherCls; }
      }
      total++;
      if (bestLabel === cls) correct++;
    }
  }
  return { name: tag, correct, total, rate: correct / total };
}

console.log();
// Try block-weight variants
const WEIGHT_SETS = {
  "shape_heavy":    [0.5, 1.5, 1.5, 1.5, 1.0, 0.7, 0.7, 1.5],   // suppress color
  "color_heavy":    [1.0, 0.5, 0.5, 0.5, 1.5, 1.5, 1.5, 0.7],   // suppress shape
  "cortex_heavy":   [0.5, 2.0, 2.0, 2.0, 0.7, 0.7, 0.7, 1.0],   // V1/V2/V4 dominant
  "axis_boost":     [1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 3.0],   // 3x axis
  "no_lgn":         [0.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0, 1.0],
  "no_ilc":         [1.0, 1.0, 1.0, 1.0, 0.0, 0.0, 0.0, 1.0],
  "V4_dominant":    [0.5, 1.0, 1.0, 3.0, 0.7, 0.7, 0.7, 1.0],
  "axis_dominant":  [0.3, 0.3, 0.3, 0.3, 0.5, 0.5, 0.5, 3.0],
  "cortex_axis":    [0.3, 1.5, 1.5, 1.5, 0.7, 0.7, 0.7, 2.0],
};
for (const [name, w] of Object.entries(WEIGHT_SETS)) {
  const r = scoreBlockWeights(w, name);
  console.log(`  block-w ${name.padEnd(20)} ${r.correct}/${r.total} = ${(r.rate * 100).toFixed(1)}%`);
}

// STACK on no_lgn winner (90.1%). Explore more single-block drops + boosts.
console.log("\n══ Stacked variants on no_lgn winner ══");
const NL = 0.0, K = 1.0;
const STACK_ON_NO_LGN = {
  "no_lgn_only":           [NL, K,   K,   K,   K,   K,   K,   K],
  "no_lgn_no_ilcY":        [NL, K,   K,   K,   NL,  K,   K,   K],
  "no_lgn_no_ilcRG":       [NL, K,   K,   K,   K,   NL,  K,   K],
  "no_lgn_no_ilcBY":       [NL, K,   K,   K,   K,   K,   NL,  K],
  "no_lgn_no_v1":          [NL, NL,  K,   K,   K,   K,   K,   K],
  "no_lgn_no_v2":          [NL, K,   NL,  K,   K,   K,   K,   K],
  "no_lgn_no_v4":          [NL, K,   K,   NL,  K,   K,   K,   K],
  "no_lgn_no_axis":        [NL, K,   K,   K,   K,   K,   K,   NL],
  "no_lgn_boost_axis":     [NL, K,   K,   K,   K,   K,   K,   2.0],
  "no_lgn_boost_v4":       [NL, K,   K,   3.0, K,   K,   K,   K],
  "no_lgn_boost_ilc_only": [NL, 0.3, 0.3, 0.3, 2.0, 2.0, 2.0, 0.3],
  "no_lgn_axis_dominant":  [NL, 0.5, 0.5, 0.5, 0.7, 0.7, 0.7, 3.0],
  "only_ilc":              [NL, NL,  NL,  NL,  K,   K,   K,   NL],
  "only_shape":            [NL, K,   K,   K,   NL,  NL,  NL,  K],
  "only_axis":             [NL, NL,  NL,  NL,  NL,  NL,  NL,  K],
  "only_ilcY_ilcRG_axis":  [NL, NL,  NL,  NL,  K,   K,   NL,  K],
  "no_lgn_no_v1_boost_axis": [NL, NL, K,   K,   K,   K,   K,   2.0],
  "shape_and_axis":        [NL, K,   K,   K,   NL,  NL,  NL,  1.5],
};
for (const [name, w] of Object.entries(STACK_ON_NO_LGN)) {
  const r = scoreBlockWeights(w, name);
  console.log(`  ${name.padEnd(28)} ${r.correct}/${r.total} = ${(r.rate * 100).toFixed(1)}%`);
}

// ITERATIVE PER-BLOCK OPTIMIZATION
// Start from all-ones. For each block, sweep {0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0}.
// Keep the best weight for that block, then move to next block. Repeat 3 passes.
console.log("\n══ Iterative per-block optimization (3 passes) ══");
const w = [1, 1, 1, 1, 1, 1, 1, 1];
const CANDIDATES = [0, 0.25, 0.5, 0.75, 1.0, 1.5, 2.0, 3.0];
let bestRate = scoreBlockWeights(w, "start").rate;
console.log(`  starting weights: [${w.join(",")}]  rate=${(bestRate*100).toFixed(1)}%`);
for (let pass = 1; pass <= 3; pass++) {
  console.log(`  --- pass ${pass} ---`);
  for (let b = 0; b < BLOCKS.length; b++) {
    let bestW = w[b], bestSubRate = -Infinity;
    for (const c of CANDIDATES) {
      const trial = w.slice(); trial[b] = c;
      const r = scoreBlockWeights(trial, `trial b${b}=${c}`);
      if (r.rate > bestSubRate) { bestSubRate = r.rate; bestW = c; }
    }
    if (bestSubRate > bestRate) {
      w[b] = bestW; bestRate = bestSubRate;
      console.log(`    block ${BLOCKS[b].name.padEnd(6)} → w=${bestW.toString().padEnd(4)}  new_best=${(bestRate*100).toFixed(1)}%`);
    } else {
      console.log(`    block ${BLOCKS[b].name.padEnd(6)} → no gain (kept w=${w[b]})`);
    }
  }
}
console.log(`\n  FINAL (pass 1): weights=[${w.join(",")}]  rate=${(bestRate*100).toFixed(1)}%`);

// FINER + RANDOM-RESTART search: many starting points, finer candidates
console.log("\n══ Random-restart with finer weight grid ══");
const FINE = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 0.85, 1.0, 1.15, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0];
let globalBestW = w.slice(), globalBestRate = bestRate;

// Deterministic pseudo-random seeds so re-runs match. 50 restarts.
const seeds = [];
for (let i = 1; i <= 50; i++) seeds.push(i * 31 + 17);
function pseudo(seed, i) {
  const x = Math.sin(seed * 9301 + i * 49297) * 233280;
  return x - Math.floor(x);
}

for (let restart = 0; restart < seeds.length; restart++) {
  const seed = seeds[restart];
  const start = new Array(8);
  for (let b = 0; b < 8; b++) {
    start[b] = FINE[Math.floor(pseudo(seed, b) * FINE.length)];
  }
  const cur = start.slice();
  let curRate = scoreBlockWeights(cur, "restart_start").rate;
  // Coordinate descent from this random start
  for (let pass = 0; pass < 4; pass++) {
    let improved = false;
    for (let b = 0; b < 8; b++) {
      let bestW = cur[b], bestSubRate = curRate;
      for (const c of FINE) {
        if (c === cur[b]) continue;
        const trial = cur.slice(); trial[b] = c;
        const r = scoreBlockWeights(trial, "trial").rate;
        if (r > bestSubRate) { bestSubRate = r; bestW = c; improved = true; }
      }
      cur[b] = bestW; curRate = bestSubRate;
    }
    if (!improved) break;
  }
  if (curRate > globalBestRate) {
    globalBestRate = curRate; globalBestW = cur.slice();
    console.log(`  restart ${restart}: NEW GLOBAL BEST rate=${(curRate*100).toFixed(1)}%  weights=[${cur.map(v => v.toFixed(2)).join(",")}]`);
  } else {
    console.log(`  restart ${restart}: local max ${(curRate*100).toFixed(1)}%  (global still ${(globalBestRate*100).toFixed(1)}%)`);
  }
}

console.log(`\n══ GLOBAL BEST after ${seeds.length} restarts ══`);
console.log(`  weights = [${globalBestW.map(v => v.toFixed(2)).join(", ")}]`);
console.log(`  rate    = ${(globalBestRate * 100).toFixed(1)}%  (${Math.round(globalBestRate * 282)}/282)`);

// ENSEMBLE — top-K configs vote per query
console.log("\n══ Ensemble of top-K weight configs ══");
// Rerun all 50 restarts, keep the ones at top-8
const configs = [];
for (const seed of seeds) {
  const start = new Array(8);
  for (let b = 0; b < 8; b++) start[b] = FINE[Math.floor(pseudo(seed, b) * FINE.length)];
  const cur = start.slice();
  let curRate = scoreBlockWeights(cur, "e").rate;
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let b = 0; b < 8; b++) {
      let bestW = cur[b], bestSubRate = curRate;
      for (const c of FINE) {
        if (c === cur[b]) continue;
        const trial = cur.slice(); trial[b] = c;
        const r = scoreBlockWeights(trial, "e").rate;
        if (r > bestSubRate) { bestSubRate = r; bestW = c; improved = true; }
      }
      cur[b] = bestW; curRate = bestSubRate;
    }
    if (!improved) break;
  }
  configs.push({ weights: cur.slice(), rate: curRate });
}
configs.sort((a, b) => b.rate - a.rate);
console.log(`  Top-5 configs found:`);
for (let i = 0; i < 5; i++) console.log(`    ${i+1}. rate=${(configs[i].rate * 100).toFixed(1)}%  weights=[${configs[i].weights.map(v => v.toFixed(2)).join(",")}]`);

// Ensemble: each query gets top-K predictions, majority wins.
function scoreEnsemble(K) {
  const classes_arr = Array.from(classes.keys());
  const topConfigs = configs.slice(0, K);
  let correct = 0, total = 0;
  for (const cls of classes_arr) {
    const samples = classes.get(cls);
    if (samples.length < 2) continue;
    for (let held_idx = 0; held_idx < samples.length; held_idx++) {
      const q = samples[held_idx].its[0];
      const votes = new Map();
      for (const cfg of topConfigs) {
        let bestLabel = null, bestSim = -Infinity;
        for (const otherCls of classes_arr) {
          const otherSamples = classes.get(otherCls);
          let famBest = -Infinity;
          for (let j = 0; j < otherSamples.length; j++) {
            if (otherCls === cls && j === held_idx) continue;
            const t = otherSamples[j].its[0];
            const s = blockSim(q, t, cfg.weights);
            if (s > famBest) famBest = s;
          }
          if (famBest > bestSim) { bestSim = famBest; bestLabel = otherCls; }
        }
        votes.set(bestLabel, (votes.get(bestLabel) || 0) + 1);
      }
      let winner = null, winnerVotes = -Infinity;
      for (const [l, v] of votes) if (v > winnerVotes) { winnerVotes = v; winner = l; }
      total++;
      if (winner === cls) correct++;
    }
  }
  return { correct, total, rate: correct / total };
}

for (const K of [3, 5, 8, 12, 20]) {
  const r = scoreEnsemble(K);
  console.log(`  ensemble top-${K.toString().padStart(2)}: ${r.correct}/${r.total} = ${(r.rate * 100).toFixed(1)}%`);
}

fs.writeFileSync("C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale/_optimal_weights.json",
  JSON.stringify({ single_best: { weights: globalBestW, rate: globalBestRate }, top_configs: configs.slice(0, 20) }, null, 2));
