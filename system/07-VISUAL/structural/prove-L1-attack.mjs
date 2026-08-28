#!/usr/bin/env bun
// prove-L1-attack.mjs — L1 metric is the winning path. Push it hard.
//
// Round 1: 100 restarts got L1 to 97.5%. Try:
//   1. Identify the 7 failures at 97.5% L1 state.
//   2. 500 more restarts, finer weight grid.
//   3. Cross-metric ensemble: L1 winners + cosine winners.
//   4. Weighted-vote-by-margin ensemble.

import fs from "node:fs";

const CACHE = "C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale/_bigwave_cache.json";
const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const classes = new Map(Object.entries(raw.classes).map(([k, samples]) =>
  [k, samples.map(s => ({ file: s.file, its: s.its.map(v => new Float32Array(v)) }))]
));
const flat = [];
for (const [cls, samples] of classes) {
  for (let i = 0; i < samples.length; i++) flat.push({ cls, held_idx: i, vec: samples[i].its[0] });
}
const D = flat[0].vec.length, N = flat.length;
const BLOCKS = [
  { start: 0, len: 12, name: "lgn" }, { start: 12, len: 4, name: "v1" },
  { start: 16, len: 6, name: "v2" }, { start: 22, len: 8, name: "v4" },
  { start: 30, len: 10, name: "ilcY" }, { start: 40, len: 10, name: "ilcRG" },
  { start: 50, len: 10, name: "ilcBY" }, { start: 60, len: 20, name: "axis" },
];

// Standardize
const dimMean = new Float32Array(D), dimStd = new Float32Array(D);
for (let d = 0; d < D; d++) {
  let m = 0, s2 = 0;
  for (let i = 0; i < N; i++) m += flat[i].vec[d];
  m /= N;
  for (let i = 0; i < N; i++) s2 += (flat[i].vec[d] - m) ** 2;
  dimStd[d] = Math.sqrt(s2 / N) || 1;
  dimMean[d] = m;
}
const flatStd = flat.map(f => {
  const v = new Float32Array(D);
  for (let d = 0; d < D; d++) v[d] = (f.vec[d] - dimMean[d]) / dimStd[d];
  return { ...f, vec: v };
});

function scoreStd(weights, metric) {
  const dimW = new Float32Array(D);
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = weights[b];
  }
  let correct = 0;
  const failures = [], allBest = [];
  for (let i = 0; i < N; i++) {
    const q = flatStd[i].vec;
    let bestLabel = null, bestScore = -Infinity, secondScore = -Infinity;
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const t = flatStd[j].vec;
      let s;
      if (metric === "L1") {
        let sum = 0;
        for (let d = 0; d < D; d++) sum += Math.abs(q[d] - t[d]) * dimW[d];
        s = -sum;
      } else if (metric === "cosine") {
        let dot = 0, na = 0, nb = 0;
        for (let d = 0; d < D; d++) { const w = dimW[d]; dot += q[d] * t[d] * w; na += q[d] * q[d] * w; nb += t[d] * t[d] * w; }
        s = dot / (Math.sqrt(na * nb) + 1e-12);
      }
      if (s > bestScore) { secondScore = bestScore; bestScore = s; bestLabel = flatStd[j].cls; }
      else if (s > secondScore) secondScore = s;
    }
    allBest.push({ predicted: bestLabel, score: bestScore, margin: bestScore - secondScore });
    if (bestLabel === flat[i].cls) correct++;
    else failures.push({ i, cls: flat[i].cls, predicted: bestLabel, margin: bestScore - secondScore });
  }
  return { correct, rate: correct / N, failures, allBest };
}

function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  L1 ATTACK — 500 restarts + cross-metric ensemble         ║");
console.log("╚══════════════════════════════════════════════════════════╝");

console.log("\n══ Baseline: L1 with best known weights ══");
const L1_BEST_WEIGHTS = [5, 5, 2, 3, 3, 5, 2, 5];
const bA = scoreStd(L1_BEST_WEIGHTS, "L1");
console.log(`  Baseline L1: ${bA.correct}/${N} = ${(bA.rate * 100).toFixed(1)}%`);
console.log(`  ${bA.failures.length} failures:`);
for (const f of bA.failures) console.log(`    ${flat[f.i].cls.padEnd(45)} → ${(f.predicted || "").padEnd(45)}  margin=${f.margin.toFixed(4)}`);

console.log("\n══ 500 L1 restarts, coarse grid ══");
const FINE = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.3, 1.5, 2.0, 3.0, 5.0];
let L1BestRate = bA.rate, L1BestW = L1_BEST_WEIGHTS.slice(), L1BestRes = bA;
const l1cfgs = [];
for (let seed = 1; seed <= 500; seed++) {
  const s = seed * 31 + 17;
  const cur = new Array(8);
  for (let b = 0; b < 8; b++) cur[b] = FINE[Math.floor(pseudo(s, b) * FINE.length)];
  let curRes = scoreStd(cur, "L1");
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let b = 0; b < 8; b++) {
      let bestW = cur[b], bestSubRes = curRes;
      for (const c of FINE) {
        if (c === cur[b]) continue;
        const trial = cur.slice(); trial[b] = c;
        const r = scoreStd(trial, "L1");
        if (r.rate > bestSubRes.rate) { bestSubRes = r; bestW = c; improved = true; }
      }
      cur[b] = bestW; curRes = bestSubRes;
    }
    if (!improved) break;
  }
  if (curRes.rate >= 0.96) l1cfgs.push({ weights: cur.slice(), rate: curRes.rate, failIdx: new Set(curRes.failures.map(f => f.i)) });
  if (curRes.rate > L1BestRate) { L1BestRate = curRes.rate; L1BestW = cur.slice(); L1BestRes = curRes; }
  if (seed % 100 === 0) console.log(`  seed ${seed}: best-so-far ${(L1BestRate * 100).toFixed(1)}%  (${l1cfgs.length} configs ≥ 96%)`);
}
console.log(`  L1 BEST: ${L1BestRes.correct}/${N} = ${(L1BestRate * 100).toFixed(1)}%  weights=[${L1BestW.map(v => v.toFixed(2)).join(",")}]`);

console.log("\n══ Cross-metric ensemble: L1 winners + cosine winners ══");
// Get 200 cosine configs
const cosCfgs = [];
for (let seed = 1; seed <= 200; seed++) {
  const s = seed * 31 + 17;
  const cur = new Array(8);
  for (let b = 0; b < 8; b++) cur[b] = FINE[Math.floor(pseudo(s, b) * FINE.length)];
  let curRes = scoreStd(cur, "cosine");
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (let b = 0; b < 8; b++) {
      let bestW = cur[b], bestSubRes = curRes;
      for (const c of FINE) {
        if (c === cur[b]) continue;
        const trial = cur.slice(); trial[b] = c;
        const r = scoreStd(trial, "cosine");
        if (r.rate > bestSubRes.rate) { bestSubRes = r; bestW = c; improved = true; }
      }
      cur[b] = bestW; curRes = bestSubRes;
    }
    if (!improved) break;
  }
  if (curRes.rate >= 0.94) cosCfgs.push({ weights: cur.slice(), rate: curRes.rate, failIdx: new Set(curRes.failures.map(f => f.i)), metric: "cosine" });
}
for (const c of l1cfgs) c.metric = "L1";
console.log(`  L1 configs ≥ 96%: ${l1cfgs.length}`);
console.log(`  Cosine configs ≥ 94%: ${cosCfgs.length}`);

// Diverse-failure greedy across BOTH metric spaces
const allCfgs = [...l1cfgs, ...cosCfgs].sort((a, b) => b.rate - a.rate);
console.log(`  Total pool: ${allCfgs.length}`);

// Greedy set-cover: pick configs that maximize NEW correct answers
const currentlyCorrect = new Set();
const chosen = [];
for (let round = 0; round < 20; round++) {
  let bestAdd = null, bestNewCovered = -1;
  for (const cfg of allCfgs) {
    if (chosen.includes(cfg)) continue;
    let newly = 0;
    for (let i = 0; i < N; i++) if (!cfg.failIdx.has(i) && !currentlyCorrect.has(i)) newly++;
    if (newly > bestNewCovered) { bestNewCovered = newly; bestAdd = cfg; }
  }
  if (!bestAdd || bestNewCovered <= 0) break;
  chosen.push(bestAdd);
  for (let i = 0; i < N; i++) if (!bestAdd.failIdx.has(i)) currentlyCorrect.add(i);
  console.log(`  round ${round + 1}: add ${bestAdd.metric} config (rate ${(bestAdd.rate * 100).toFixed(1)}%, adds ${bestNewCovered} newly correct → union ${currentlyCorrect.size}/${N})`);
}
console.log(`  UNION upper bound: ${currentlyCorrect.size}/${N} = ${(currentlyCorrect.size / N * 100).toFixed(1)}%`);

// Actual majority vote across the diverse set
function ensembleVote(configs) {
  let correct = 0;
  const failures = [];
  for (let i = 0; i < N; i++) {
    const q = flatStd[i].vec;
    // Weighted votes by config's overall rate (higher rate → more say)
    const votes = new Map();
    for (const cfg of configs) {
      const dimW = new Float32Array(D);
      for (let b = 0; b < BLOCKS.length; b++) {
        for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = cfg.weights[b];
      }
      let bestLabel = null, bestScore = -Infinity;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const t = flatStd[j].vec;
        let s;
        if (cfg.metric === "L1") {
          let sum = 0;
          for (let d = 0; d < D; d++) sum += Math.abs(q[d] - t[d]) * dimW[d];
          s = -sum;
        } else {
          let dot = 0, na = 0, nb = 0;
          for (let d = 0; d < D; d++) { const w = dimW[d]; dot += q[d] * t[d] * w; na += q[d] * q[d] * w; nb += t[d] * t[d] * w; }
          s = dot / (Math.sqrt(na * nb) + 1e-12);
        }
        if (s > bestScore) { bestScore = s; bestLabel = flatStd[j].cls; }
      }
      votes.set(bestLabel, (votes.get(bestLabel) || 0) + cfg.rate);
    }
    let winner = null, winnerVotes = -Infinity;
    for (const [l, v] of votes) if (v > winnerVotes) { winnerVotes = v; winner = l; }
    if (winner === flat[i].cls) correct++;
    else failures.push({ i, cls: flat[i].cls, predicted: winner });
  }
  return { correct, rate: correct / N, failures };
}

console.log("\n══ Actual weighted majority vote (rate-weighted) ══");
for (const K of [3, 5, 7, 10, 15, chosen.length]) {
  if (K > chosen.length) continue;
  const sub = chosen.slice(0, K);
  const r = ensembleVote(sub);
  console.log(`  top-${K}: ${r.correct}/${N} = ${(r.rate * 100).toFixed(1)}%`);
}

// Final ensemble with all chosen
const finalR = ensembleVote(chosen);
console.log(`\n══ FINAL ══`);
console.log(`  Single-best L1: ${(L1BestRate * 100).toFixed(1)}%`);
console.log(`  Diverse ensemble (${chosen.length} configs): ${finalR.correct}/${N} = ${(finalR.rate * 100).toFixed(1)}%`);
console.log(`  Union upper bound: ${(currentlyCorrect.size / N * 100).toFixed(1)}%`);
console.log(`\n  Remaining failures (${finalR.failures.length}):`);
for (const f of finalR.failures) console.log(`    ${flat[f.i].cls} → ${f.predicted}`);

fs.writeFileSync("C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale/_L1_attack.json", JSON.stringify({
  L1_single: { rate: L1BestRate, weights: L1BestW },
  ensemble_rate: finalR.rate,
  ensemble_size: chosen.length,
  union_upper_bound: currentlyCorrect.size / N,
}, null, 2));
