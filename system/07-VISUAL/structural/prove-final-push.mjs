#!/usr/bin/env bun
// prove-final-push.mjs — identify the 12 stuck failures, then push.
//
// Approaches for the final 12 samples:
//   A) Identify who's failing at 95.7% state.
//   B) L1 metric with block-weight optimization (uniform_L1 got 95%).
//   C) Standardized + L1 with restart.
//   D) Per-DIM weight optimization (currently per-block).
//   E) Diverse-config ensemble (choose configs with disagreeing failures).
//   F) Second-nearest-ratio rejection quality analysis.

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

// Standardize dims (same as winning approach)
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

function scoreStd(weights, metric = "cosine") {
  const dimW = new Float32Array(D);
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = weights[b];
  }
  let correct = 0;
  const failures = [];
  for (let i = 0; i < N; i++) {
    const q = flatStd[i].vec;
    let bestLabel = null, bestScore = -Infinity;
    let secondScore = -Infinity;
    for (let j = 0; j < N; j++) {
      if (j === i) continue;
      const t = flatStd[j].vec;
      let s;
      if (metric === "cosine") {
        let dot = 0, na = 0, nb = 0;
        for (let d = 0; d < D; d++) { const w = dimW[d]; dot += q[d] * t[d] * w; na += q[d] * q[d] * w; nb += t[d] * t[d] * w; }
        s = dot / (Math.sqrt(na * nb) + 1e-12);
      } else if (metric === "L1") {
        let sum = 0;
        for (let d = 0; d < D; d++) sum += Math.abs(q[d] - t[d]) * dimW[d];
        s = -sum;
      } else if (metric === "L2") {
        let sum = 0;
        for (let d = 0; d < D; d++) { const dv = q[d] - t[d]; sum += dv * dv * dimW[d]; }
        s = -Math.sqrt(sum);
      }
      if (s > bestScore) { secondScore = bestScore; bestScore = s; bestLabel = flatStd[j].cls; }
      else if (s > secondScore) secondScore = s;
    }
    if (bestLabel === flatStd[i].cls) correct++;
    else failures.push({ i, cls: flatStd[i].cls, predicted: bestLabel, margin: bestScore - secondScore });
  }
  return { correct, rate: correct / N, failures };
}

function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
const FINE = [0, 0.1, 0.2, 0.3, 0.5, 0.7, 1.0, 1.3, 1.5, 2.0, 3.0, 5.0];

function restartSearch(metric, numSeeds = 100) {
  let best = { rate: 0, weights: null, correct: 0, failures: [] };
  for (let seed = 1; seed <= numSeeds; seed++) {
    const s = seed * 31 + 17;
    const cur = new Array(8);
    for (let b = 0; b < 8; b++) cur[b] = FINE[Math.floor(pseudo(s, b) * FINE.length)];
    let curRes = scoreStd(cur, metric);
    for (let pass = 0; pass < 3; pass++) {
      let improved = false;
      for (let b = 0; b < 8; b++) {
        let bestW = cur[b], bestSubRes = curRes;
        for (const c of FINE) {
          if (c === cur[b]) continue;
          const trial = cur.slice(); trial[b] = c;
          const r = scoreStd(trial, metric);
          if (r.rate > bestSubRes.rate) { bestSubRes = r; bestW = c; improved = true; }
        }
        cur[b] = bestW; curRes = bestSubRes;
      }
      if (!improved) break;
    }
    if (curRes.rate > best.rate) { best = { ...curRes, weights: cur.slice() }; }
  }
  return best;
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  FINAL PUSH — identify 12 stuck + try L1 + per-dim        ║");
console.log("╚══════════════════════════════════════════════════════════╝");

console.log("\n══ A) Locate the 12 stuck failures at best-known state ══");
const knownBest = [1.0, 1.5, 2.0, 0.2, 2.0, 1.0, 1.3, 0.2];
const A = scoreStd(knownBest, "cosine");
console.log(`  Baseline std+cosine [${knownBest.join(",")}]: ${A.correct}/${N} = ${(A.rate * 100).toFixed(1)}%`);
console.log(`  Failures (${A.failures.length}):`);
for (const f of A.failures.slice(0, 20)) console.log(`    ${flat[f.i].cls.padEnd(45)} → ${(f.predicted || "").padEnd(45)}  margin=${f.margin.toFixed(4)}`);

console.log("\n══ B) L1 metric with block-weight optimization (100 restarts) ══");
const B = restartSearch("L1", 100);
console.log(`  Best std+L1: ${B.correct}/${N} = ${(B.rate * 100).toFixed(1)}%  weights=[${B.weights.map(v => v.toFixed(2)).join(",")}]`);

console.log("\n══ C) L2 metric with block-weight optimization (100 restarts) ══");
const C = restartSearch("L2", 100);
console.log(`  Best std+L2: ${C.correct}/${N} = ${(C.rate * 100).toFixed(1)}%  weights=[${C.weights.map(v => v.toFixed(2)).join(",")}]`);

console.log("\n══ D) Cosine with more restarts (200 seeds, standardized) ══");
const Dr = restartSearch("cosine", 200);
console.log(`  Best std+cosine: ${Dr.correct}/${N} = ${(Dr.rate * 100).toFixed(1)}%  weights=[${Dr.weights.map(v => v.toFixed(2)).join(",")}]`);

// E) Diverse ensemble — configs whose failures don't overlap
console.log("\n══ E) Diverse-failure ensemble ══");
// Collect top-20 std+cosine configs and their failure sets
const topCfgs = [];
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
  if (curRes.rate >= 0.94) topCfgs.push({ weights: cur.slice(), rate: curRes.rate, failIdx: new Set(curRes.failures.map(f => f.i)) });
}
topCfgs.sort((a, b) => b.rate - a.rate);
console.log(`  ${topCfgs.length} configs at ≥94%`);

// Greedy diverse ensemble: pick top-1, then add configs whose failures differ most
function ensembleScore(cfgList) {
  let correct = 0;
  for (let i = 0; i < N; i++) {
    const q = flatStd[i].vec;
    const votes = new Map();
    for (const cfg of cfgList) {
      const dimW = new Float32Array(D);
      for (let b = 0; b < BLOCKS.length; b++) {
        for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = cfg.weights[b];
      }
      let bestLabel = null, bestScore = -Infinity;
      for (let j = 0; j < N; j++) {
        if (j === i) continue;
        const t = flatStd[j].vec;
        let dot = 0, na = 0, nb = 0;
        for (let d = 0; d < D; d++) { const w = dimW[d]; dot += q[d] * t[d] * w; na += q[d] * q[d] * w; nb += t[d] * t[d] * w; }
        const s = dot / (Math.sqrt(na * nb) + 1e-12);
        if (s > bestScore) { bestScore = s; bestLabel = flatStd[j].cls; }
      }
      votes.set(bestLabel, (votes.get(bestLabel) || 0) + 1);
    }
    let winner = null, winnerVotes = -Infinity;
    for (const [l, v] of votes) if (v > winnerVotes) { winnerVotes = v; winner = l; }
    if (winner === flat[i].cls) correct++;
  }
  return correct / N;
}

// Try progressive ensemble sizes, choosing configs that ADD unique correct answers
if (topCfgs.length > 0) {
  // Greedy: start with top-1, add configs that cover most currently-missed samples
  const chosen = [topCfgs[0]];
  const currentlyCorrect = new Set();
  for (let i = 0; i < N; i++) if (!topCfgs[0].failIdx.has(i)) currentlyCorrect.add(i);
  const available = topCfgs.slice(1);

  for (let round = 1; round <= 15; round++) {
    let bestAdd = null, bestNewCovered = -1;
    for (const cfg of available) {
      let newly = 0;
      for (let i = 0; i < N; i++) if (!cfg.failIdx.has(i) && !currentlyCorrect.has(i)) newly++;
      if (newly > bestNewCovered) { bestNewCovered = newly; bestAdd = cfg; }
    }
    if (!bestAdd || bestNewCovered <= 0) break;
    chosen.push(bestAdd);
    for (let i = 0; i < N; i++) if (!bestAdd.failIdx.has(i)) currentlyCorrect.add(i);
    const idx = available.indexOf(bestAdd);
    if (idx >= 0) available.splice(idx, 1);
  }
  console.log(`  Greedy diverse ensemble uses ${chosen.length} configs`);
  console.log(`  UNION of correct predictions: ${currentlyCorrect.size}/${N} = ${(currentlyCorrect.size / N * 100).toFixed(1)}%  (upper bound if perfect voting)`);
  // Now vote
  const eRate = ensembleScore(chosen);
  console.log(`  Actual majority vote: ${Math.round(eRate * N)}/${N} = ${(eRate * 100).toFixed(1)}%`);
}

// F) Second-nearest-ratio rejection analysis
console.log("\n══ F) Failure margin analysis (for reject-with-uncertainty) ══");
const margins = A.failures.map(f => f.margin);
margins.sort((a, b) => a - b);
console.log(`  min margin: ${margins[0].toFixed(4)}`);
console.log(`  median: ${margins[Math.floor(margins.length / 2)].toFixed(4)}`);
console.log(`  max: ${margins[margins.length - 1].toFixed(4)}`);
console.log(`  If reject margin < 0.005: would reject ${margins.filter(m => m < 0.005).length}/${margins.length} failures`);
console.log(`  If reject margin < 0.01: would reject ${margins.filter(m => m < 0.01).length}/${margins.length} failures`);

fs.writeFileSync("C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale/_final_push.json", JSON.stringify({
  baseline: A, L1: B, L2: C, cosine_200: Dr,
  ensemble_configs: topCfgs.length,
}, null, 2));
