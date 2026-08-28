#!/usr/bin/env bun
// stage-refit-weights.mjs — refit block weights on current staged cache.
// Fast 50-restart search on lighting-only subset at K=100 to find weights
// that work on THIS distribution.

import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache";
function shardPath(i) { return path.join(CACHE_DIR, `shard_${String(i).padStart(5,"0")}.json`); }
function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(pseudo(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const cache = new Map();
for (let s = 0; s < 100; s++) {
  const p = shardPath(s);
  if (!fs.existsSync(p)) continue;
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const c of d.classes) if (c.its && c.its.length > 1) cache.set(c.id, c);
  } catch {}
}
console.log(`loaded ${cache.size} classes`);

const BLOCK_STARTS = [0, 12, 16, 22, 30, 40, 50, 60];
const BLOCK_LENS = [12, 4, 6, 8, 10, 10, 10, 20];
const D = 80;

// Filter to lighting + rotations + scales + brightness/contrast (clean grid)
const cleanFn = (i) => (i < 18) || (i >= 22 && i < 28);

// Take first 100 classes, keep clean augmentation subset
const K_FIT = 100;
const classes = Array.from(cache.entries()).slice(0, K_FIT).map(([id, cls]) => ({
  id,
  its: cls.its.filter((_, i) => cleanFn(i)),
}));

// Standardize
const all = [];
for (const cls of classes) for (const it of cls.its) all.push(it.v);
const dimMean = new Float32Array(D), dimStd = new Float32Array(D);
const M = all.length;
for (let d = 0; d < D; d++) {
  let m = 0; for (const v of all) m += v[d]; m /= M;
  let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
  dimMean[d] = m; dimStd[d] = Math.sqrt(s2 / M) || 1;
}
const stdClasses = classes.map(cls => ({
  id: cls.id,
  its: cls.its.map(it => {
    const nv = new Float32Array(D);
    for (let d = 0; d < D; d++) nv[d] = (it.v[d] - dimMean[d]) / dimStd[d];
    return nv;
  }),
}));
console.log(`fit corpus: ${stdClasses.length} classes × ${stdClasses[0].its.length} avg samples`);

function scoreWeights(blockW, N, seeds) {
  const dimW = new Float32Array(D);
  for (let b = 0; b < 8; b++) for (let d = BLOCK_STARTS[b]; d < BLOCK_STARTS[b]+BLOCK_LENS[b]; d++) dimW[d] = blockW[b];
  const rates = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const train = new Map();
    const test = [];
    for (const cls of stdClasses) {
      const shuf = seededShuffle(cls.its, seed);
      const take = Math.min(N, shuf.length - 1);
      train.set(cls.id, shuf.slice(0, take));
      for (let j = take; j < shuf.length; j++) test.push({ id: cls.id, v: shuf[j] });
    }
    let correct = 0;
    for (const q of test) {
      let bestId = null, bestD = Infinity;
      for (const [id, vecs] of train) for (const t of vecs) {
        let sum = 0;
        for (let d = 0; d < D; d++) sum += Math.abs(q.v[d] - t[d]) * dimW[d];
        if (sum < bestD) { bestD = sum; bestId = id; }
      }
      if (bestId === q.id) correct++;
    }
    if (test.length) rates.push(correct / test.length);
  }
  return rates.reduce((a,b) => a+b, 0) / rates.length;
}

// Baseline: current weights
const BASELINE = [5, 5, 2, 3, 3, 5, 2, 5];
console.log(`baseline weights ${BASELINE.join(",")}: ${(scoreWeights(BASELINE, 5, 10)*100).toFixed(1)}%`);

// Random-restart search
const FINE = [0, 0.1, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 5.0];
let bestW = BASELINE.slice(), bestR = scoreWeights(bestW, 5, 10);
const t0 = performance.now();
for (let seed = 1; seed <= 50; seed++) {
  const cur = new Array(8);
  for (let b = 0; b < 8; b++) cur[b] = FINE[Math.floor(pseudo(seed*31+17, b) * FINE.length)];
  let curR = scoreWeights(cur, 5, 10);
  for (let pass = 0; pass < 2; pass++) {
    let improved = false;
    for (let b = 0; b < 8; b++) {
      let bW = cur[b], bSubR = curR;
      for (const c of FINE) {
        if (c === cur[b]) continue;
        const trial = cur.slice(); trial[b] = c;
        const r = scoreWeights(trial, 5, 10);
        if (r > bSubR) { bSubR = r; bW = c; improved = true; }
      }
      cur[b] = bW; curR = bSubR;
    }
    if (!improved) break;
  }
  if (curR > bestR) {
    bestR = curR; bestW = cur.slice();
    const dt = ((performance.now() - t0) / 1000).toFixed(0);
    console.log(`  seed ${seed}: NEW BEST ${(curR*100).toFixed(1)}% weights=[${cur.map(v => v.toFixed(2)).join(",")}]  (${dt}s)`);
  }
}

console.log(`\n══ REFIT WINNER ══`);
console.log(`  weights = [${bestW.map(v => v.toFixed(2)).join(", ")}]`);
console.log(`  fit-set rate (K=100, N=5) = ${(bestR*100).toFixed(1)}%`);

// Verify on held-out class count
console.log(`\n══ VALIDATE on larger K ══`);
for (const K of [47, 200, 300, cache.size]) {
  const cs = Array.from(cache.entries()).slice(0, K).map(([id, cls]) => ({
    id,
    its: cls.its.filter((_, i) => cleanFn(i)),
  }));
  const allV = [];
  for (const cls of cs) for (const it of cls.its) allV.push(it.v);
  const mn = new Float32Array(D), sd = new Float32Array(D);
  const Mv = allV.length;
  for (let d = 0; d < D; d++) {
    let m = 0; for (const v of allV) m += v[d]; m /= Mv;
    let s2 = 0; for (const v of allV) s2 += (v[d] - m) ** 2;
    mn[d] = m; sd[d] = Math.sqrt(s2 / Mv) || 1;
  }
  const stdCs = cs.map(cls => ({
    id: cls.id,
    its: cls.its.map(it => { const nv = new Float32Array(D); for (let d = 0; d < D; d++) nv[d] = (it.v[d] - mn[d]) / sd[d]; return nv; }),
  }));
  const dimW = new Float32Array(D);
  for (let b = 0; b < 8; b++) for (let d = BLOCK_STARTS[b]; d < BLOCK_STARTS[b]+BLOCK_LENS[b]; d++) dimW[d] = bestW[b];
  const rates = [];
  for (let seed = 1; seed <= 20; seed++) {
    const train = new Map(); const test = [];
    for (const cls of stdCs) {
      const shuf = seededShuffle(cls.its, seed);
      train.set(cls.id, shuf.slice(0, 5));
      for (let j = 5; j < shuf.length; j++) test.push({ id: cls.id, v: shuf[j] });
    }
    let ok = 0;
    for (const q of test) {
      let bid = null, bd = Infinity;
      for (const [id, vecs] of train) for (const t of vecs) {
        let s = 0; for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * dimW[d];
        if (s < bd) { bd = s; bid = id; }
      }
      if (bid === q.id) ok++;
    }
    if (test.length) rates.push(ok / test.length);
  }
  const m = rates.reduce((a,b) => a+b, 0) / rates.length;
  console.log(`  K=${K.toString().padStart(3)}  N=5  mean=${(m*100).toFixed(1)}%`);
}

fs.writeFileSync("C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results/refit_weights.json", JSON.stringify({ weights: bestW, fit_K: 100, fit_rate: bestR }, null, 2));
