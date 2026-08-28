#!/usr/bin/env bun
// perm-kernel-fisher.mjs — non-linear Fisher via RBF/polynomial kernels.
// Attacks: linear space caps at ~60% at K=300. Kernel-space Fisher might
// separate what linear cannot.

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
    for (const c of d.classes) if (c.its && c.its.length > 1) rawCache.set(c.id, { id: c.id, its: c.its.filter((_, i) => cleanFn(i)) });
  } catch {}
}
console.log(`loaded ${rawCache.size} classes`);

const D = 80;
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

// Kernel functions
function l2sq(a, b) { let s = 0; for (let d = 0; d < D; d++) { const dv = a[d] - b[d]; s += dv * dv; } return s; }
function rbf(a, b, gamma) { return Math.exp(-gamma * l2sq(a, b)); }
function poly(a, b, deg, c) {
  let dot = 0; for (let d = 0; d < D; d++) dot += a[d] * b[d];
  return Math.pow(dot / D + c, deg);
}

// Kernel NN — use similarity in kernel space
function scoreKernel(sc, kernel, N_train, seeds) {
  const rates = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const train = new Map(); const test = [];
    for (const cls of sc) {
      const shuf = seededShuffle(cls.its, seed);
      const take = Math.min(N_train, shuf.length - 1);
      train.set(cls.id, shuf.slice(0, take));
      for (let j = take; j < shuf.length; j++) test.push({ id: cls.id, v: shuf[j] });
    }
    let correct = 0;
    for (const q of test) {
      let best = null, bestS = -Infinity;
      for (const [id, vecs] of train) {
        let famBest = -Infinity;
        for (const t of vecs) {
          const s = kernel(q.v, t);
          if (s > famBest) famBest = s;
        }
        if (famBest > bestS) { bestS = famBest; best = id; }
      }
      if (best === q.id) correct++;
    }
    if (test.length) rates.push(correct / test.length);
  }
  return rates.reduce((a,b) => a+b, 0) / rates.length;
}

console.log("\n══ KERNEL FISHER SWEEP ══");
const t0 = performance.now();

// Sweep gamma for RBF and degree for polynomial
const K_TEST = [47, 100, 200, 300, rawCache.size];
const results = [];
for (const K of K_TEST) {
  const sc = stdCache(K);
  console.log(`\n  K=${K}:`);
  // RBF sweep
  for (const gamma of [0.001, 0.01, 0.05, 0.1, 0.5, 1.0]) {
    const rate = scoreKernel(sc, (a, b) => rbf(a, b, gamma), 5, 3);
    console.log(`    RBF γ=${gamma.toString().padEnd(5)}: ${(rate*100).toFixed(1)}%`);
    results.push({ K, method: `RBF γ=${gamma}`, rate });
  }
  // Poly sweep
  for (const deg of [2, 3, 4, 5]) {
    const rate = scoreKernel(sc, (a, b) => poly(a, b, deg, 1), 5, 3);
    console.log(`    Poly deg=${deg}: ${(rate*100).toFixed(1)}%`);
    results.push({ K, method: `Poly deg=${deg}`, rate });
  }
  // Linear reference
  const lin = scoreKernel(sc, (a, b) => { let s = 0; for (let d = 0; d < D; d++) s += a[d] * b[d]; return s; }, 5, 3);
  console.log(`    Linear (dot):     ${(lin*100).toFixed(1)}%`);
  results.push({ K, method: "Linear dot", rate: lin });
}

console.log(`\ntotal: ${((performance.now() - t0) / 1000).toFixed(0)}s`);

// Find best method per K
console.log("\n══ Winning kernel per K ══");
const byK = new Map();
for (const r of results) {
  if (!byK.has(r.K) || byK.get(r.K).rate < r.rate) byK.set(r.K, r);
}
for (const [K, r] of byK) {
  console.log(`  K=${K.toString().padStart(3)}  ${r.method.padEnd(15)}  ${(r.rate*100).toFixed(1)}%`);
}
fs.writeFileSync("C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results/kernel_fisher.json", JSON.stringify({ results, winners: Object.fromEntries(byK) }, null, 2));
