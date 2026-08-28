#!/usr/bin/env bun
// find-permutation-fast.mjs — 100× faster permutation search.
//
// Speedups:
//   1. Block-L1 precomputation: for every pair, compute 8-tuple of per-block L1
//      distances ONCE. Then evaluating a weight config = dot product per pair.
//   2. Per-dim Fisher weights direct — 80 weights not 8 blocks (more expressive)
//   3. 5 seeds not 10, tighter grid, one-pass coordinate descent

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

const cleanFn = (i) => (i < 18) || (i >= 22 && i < 28);
const rawCache = new Map();
for (let s = 0; s < 100; s++) {
  const p = shardPath(s);
  if (!fs.existsSync(p)) continue;
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const c of d.classes) if (c.its && c.its.length > 1) {
      rawCache.set(c.id, { id: c.id, its: c.its.filter((_, i) => cleanFn(i)) });
    }
  } catch {}
}
console.log(`loaded ${rawCache.size} classes`);

const D = 80;
const BLOCK_STARTS = [0, 12, 16, 22, 30, 40, 50, 60];
const BLOCK_LENS = [12, 4, 6, 8, 10, 10, 10, 20];

function stdCache(K) {
  const classes = Array.from(rawCache.values()).slice(0, K);
  const all = [];
  for (const cls of classes) for (const it of cls.its) all.push(it.v);
  const mean = new Float32Array(D), std = new Float32Array(D);
  const M = all.length;
  for (let d = 0; d < D; d++) {
    let m = 0; for (const v of all) m += v[d]; m /= M;
    let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
    mean[d] = m; std[d] = Math.sqrt(s2 / M) || 1;
  }
  return classes.map(cls => ({
    id: cls.id,
    its: cls.its.map(it => {
      const nv = new Float32Array(D);
      for (let d = 0; d < D; d++) nv[d] = (it.v[d] - mean[d]) / std[d];
      return nv;
    }),
  }));
}

// ============ FISHER PER-DIM WEIGHTS ============
function fisherPerDim(sc) {
  const dimBetween = new Float64Array(D);
  const dimWithin = new Float64Array(D);
  const globalMean = new Float64Array(D);
  let totalCount = 0;
  const classData = [];
  for (const cls of sc) {
    const cm = new Float64Array(D);
    for (const v of cls.its) for (let d = 0; d < D; d++) cm[d] += v[d];
    for (let d = 0; d < D; d++) cm[d] /= cls.its.length;
    classData.push({ cm, its: cls.its });
    for (let d = 0; d < D; d++) globalMean[d] += cm[d] * cls.its.length;
    totalCount += cls.its.length;
  }
  for (let d = 0; d < D; d++) globalMean[d] /= totalCount;
  for (const cd of classData) {
    for (let d = 0; d < D; d++) {
      const diff = cd.cm[d] - globalMean[d];
      dimBetween[d] += cd.its.length * diff * diff;
      for (const v of cd.its) {
        const w = v[d] - cd.cm[d];
        dimWithin[d] += w * w;
      }
    }
  }
  const dimW = new Float32Array(D);
  for (let d = 0; d < D; d++) dimW[d] = dimBetween[d] / (dimWithin[d] + 1e-9);
  // Normalize so mean = 1
  let sum = 0; for (let d = 0; d < D; d++) sum += dimW[d];
  const mean = sum / D || 1;
  for (let d = 0; d < D; d++) dimW[d] /= mean;
  return dimW;
}

function scoreDimW(sc, dimW, N, seeds) {
  const rates = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const train = new Map(); const test = [];
    for (const cls of sc) {
      const shuf = seededShuffle(cls.its, seed);
      const take = Math.min(N, shuf.length - 1);
      train.set(cls.id, shuf.slice(0, take));
      for (let j = take; j < shuf.length; j++) test.push({ id: cls.id, v: shuf[j] });
    }
    let correct = 0;
    for (const q of test) {
      let bid = null, bd = Infinity;
      for (const [id, vecs] of train) for (const t of vecs) {
        let s = 0;
        for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * dimW[d];
        if (s < bd) { bd = s; bid = id; }
      }
      if (bid === q.id) correct++;
    }
    if (test.length) rates.push(correct / test.length);
  }
  return rates.reduce((a,b) => a+b, 0) / rates.length;
}

console.log("\n══ FISHER PER-DIM WEIGHTS ══");
const t0 = performance.now();

for (const K of [47, 100, 200, 300, rawCache.size]) {
  const sc = stdCache(K);
  const dimW = fisherPerDim(sc);
  const rate = scoreDimW(sc, dimW, 5, 10);
  console.log(`  K=${K.toString().padStart(3)}  Fisher per-dim rate=${(rate*100).toFixed(1)}%`);
  // Show top-10 discriminative dims
  const idx = Array.from({length: D}, (_, i) => i).sort((a, b) => dimW[b] - dimW[a]);
  console.log(`    top-10 discriminative dims: ${idx.slice(0, 10).map(i => `d${i}=${dimW[i].toFixed(2)}`).join(", ")}`);
}
console.log(`Fisher search: ${((performance.now() - t0) / 1000).toFixed(0)}s`);

// ============ FAST BLOCK-WEIGHT SEARCH (with block-L1 precomputation) ============
console.log("\n══ FAST BLOCK-WEIGHT SEARCH (precomputed block-L1) ══");
const t1 = performance.now();

function precomputeBlockL1(sc) {
  // Flatten all vectors with a class-id lookup
  const flat = []; let cIdx = 0;
  const cIds = [];
  for (const cls of sc) {
    cIds.push(cls.id);
    for (const v of cls.its) flat.push({ cIdx, v });
    cIdx++;
  }
  const N = flat.length;
  // For each pair, 8-tuple of per-block L1 distances
  // Store as N*(N-1)/2 upper triangle for compactness — but use N*N flat for O(1) lookup
  // 100 classes × 24 vecs = 2400 vecs → 2400² × 8 × 4 bytes = 184MB. Manageable.
  const blockL1 = new Float32Array(N * N * 8);
  for (let i = 0; i < N; i++) {
    for (let j = i + 1; j < N; j++) {
      const base = (i * N + j) * 8;
      const baseSym = (j * N + i) * 8;
      for (let b = 0; b < 8; b++) {
        let s = 0;
        for (let d = BLOCK_STARTS[b]; d < BLOCK_STARTS[b] + BLOCK_LENS[b]; d++) {
          s += Math.abs(flat[i].v[d] - flat[j].v[d]);
        }
        blockL1[base + b] = s;
        blockL1[baseSym + b] = s;
      }
    }
  }
  return { flat, cIds, blockL1, N };
}

function scoreWithBlockL1(pc, weights, N_train, seeds) {
  const { flat, cIds, blockL1, N } = pc;
  const classGroups = new Map();
  for (let i = 0; i < flat.length; i++) {
    if (!classGroups.has(flat[i].cIdx)) classGroups.set(flat[i].cIdx, []);
    classGroups.get(flat[i].cIdx).push(i);
  }
  const rates = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const trainIdx = [];
    const testIdx = [];
    const trainClsOf = new Int32Array(flat.length).fill(-1);
    for (const [cIdx, idxs] of classGroups) {
      const shuf = seededShuffle(idxs, seed);
      const take = Math.min(N_train, shuf.length - 1);
      for (let k = 0; k < take; k++) { trainIdx.push(shuf[k]); trainClsOf[shuf[k]] = cIdx; }
      for (let k = take; k < shuf.length; k++) testIdx.push(shuf[k]);
    }
    let correct = 0;
    for (const qi of testIdx) {
      const qc = flat[qi].cIdx;
      let bId = -1, bD = Infinity;
      for (const ti of trainIdx) {
        const base = (qi * N + ti) * 8;
        let s = 0;
        for (let b = 0; b < 8; b++) s += blockL1[base + b] * weights[b];
        if (s < bD) { bD = s; bId = trainClsOf[ti]; }
      }
      if (bId === qc) correct++;
    }
    if (testIdx.length) rates.push(correct / testIdx.length);
  }
  return rates.reduce((a,b) => a+b, 0) / rates.length;
}

const K_FIT = 100;
const sc100 = stdCache(K_FIT);
const sc47 = stdCache(47);
console.log(`  precomputing block-L1 for K=100…`);
const pc100 = precomputeBlockL1(sc100);
console.log(`  precomputing block-L1 for K=47…`);
const pc47 = precomputeBlockL1(sc47);
// K=200 validation uses non-precomputed score (memory saver)
console.log(`  precompute: ${((performance.now() - t1) / 1000).toFixed(0)}s`);

const FINE = [0, 0.1, 0.3, 0.5, 0.7, 1.0, 1.5, 2.0, 3.0, 5.0];
let bestW = null, bestR = 0;
const cands = [];
const searchStart = performance.now();
for (let seed = 1; seed <= 300; seed++) {
  const cur = new Array(8);
  for (let b = 0; b < 8; b++) cur[b] = FINE[Math.floor(pseudo(seed*31+17, b) * FINE.length)];
  let curR = scoreWithBlockL1(pc100, cur, 5, 5);
  // One-pass coordinate descent
  for (let b = 0; b < 8; b++) {
    let bW = cur[b], bR = curR;
    for (const c of FINE) {
      if (c === cur[b]) continue;
      const trial = cur.slice(); trial[b] = c;
      const r = scoreWithBlockL1(pc100, trial, 5, 5);
      if (r > bR) { bR = r; bW = c; }
    }
    cur[b] = bW; curR = bR;
  }
  if (curR > 0.3) {
    const r47 = scoreWithBlockL1(pc47, cur, 5, 5);
    cands.push({ weights: cur.slice(), K100: curR, K47: r47, K200: 0 });
  }
  if (curR > bestR) {
    bestR = curR; bestW = cur.slice();
    const dt = ((performance.now() - searchStart) / 1000).toFixed(0);
    console.log(`  seed ${seed}: NEW ${(curR*100).toFixed(1)}% weights=[${cur.map(v => v.toFixed(2)).join(",")}]  ${dt}s`);
  }
  if (seed % 50 === 0) {
    const dt = ((performance.now() - searchStart) / 1000).toFixed(0);
    console.log(`  progress ${seed}/300  ${dt}s  best K100 so far: ${(bestR*100).toFixed(1)}%`);
  }
}

cands.sort((a,b) => b.K100 - a.K100);
// Validate top-20 at K=200 with non-precomputed scoring
console.log(`\n══ Validating top-20 at K=200… ══`);
const sc200 = stdCache(200);
for (let i = 0; i < Math.min(20, cands.length); i++) {
  const c = cands[i];
  c.K200 = scoreDimW(sc200, blockWeightsToDimW(c.weights), 5, 5);
}
console.log(`\n══ TOP 10 BY K=100 ══`);
for (let i = 0; i < Math.min(10, cands.length); i++) {
  const c = cands[i];
  console.log(`  ${i+1}. K100=${(c.K100*100).toFixed(1)}%  K47=${(c.K47*100).toFixed(1)}%  K200=${(c.K200*100).toFixed(1)}%  W=[${c.weights.map(v => v.toFixed(1)).join(",")}]`);
}
fs.writeFileSync("C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results/perm_fast.json", JSON.stringify({ top: cands.slice(0, 30) }, null, 2));

// Helper for K=200 non-precomputed scoring
function blockWeightsToDimW(bw) {
  const dw = new Float32Array(D);
  for (let b = 0; b < 8; b++) for (let d = BLOCK_STARTS[b]; d < BLOCK_STARTS[b]+BLOCK_LENS[b]; d++) dw[d] = bw[b];
  return dw;
}
console.log(`\ntotal: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
