#!/usr/bin/env bun
// stage-fast-check.mjs — fast sanity check on staged cache.
// Sweeps class counts 47, 100, 200, 409 with just N=5 fixed, 20 seeds,
// to see WHERE the recognition drops (or if the whole cache is bad).

import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache";
const SHARD_SIZE = 10;

function shardPath(i) { return path.join(CACHE_DIR, `shard_${String(i).padStart(5, "0")}.json`); }
function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(pseudo(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Load cache
const cache = new Map();
for (let s = 0; s < 100; s++) {
  const p = shardPath(s);
  if (!fs.existsSync(p)) continue;
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const c of d.classes) if (c.its && c.its.length > 1) cache.set(c.id, c);
  } catch {}
}
console.log(`loaded ${cache.size} classes with ≥2 samples each`);
if (cache.size === 0) { console.log("no cache"); process.exit(1); }

// Sanity: what's an IT vector look like?
const firstClass = cache.values().next().value;
const firstIt = firstClass.its[0].v;
console.log(`sample IT vector: len=${firstIt.length}  first10=[${firstIt.slice(0, 10).map(v => v.toFixed(3)).join(",")}]`);
const lights = new Set();
for (const cls of cache.values()) for (const it of cls.its) lights.add(it.light);
console.log(`lighting conditions seen: ${Array.from(lights).join(", ")}`);

// Standardize + L1 with weights
const BLOCK_STARTS = [0, 12, 16, 22, 30, 40, 50, 60];
const BLOCK_LENS   = [12, 4, 6, 8, 10, 10, 10, 20];
const BLOCK_W_L1   = [5, 5, 2, 3, 3, 5, 2, 5];
const dimW = new Float32Array(80);
for (let b = 0; b < 8; b++) for (let d = BLOCK_STARTS[b]; d < BLOCK_STARTS[b] + BLOCK_LENS[b]; d++) dimW[d] = BLOCK_W_L1[b];

function scoreAtK(K, N, seeds) {
  // Take first K classes
  const classList = Array.from(cache.entries()).slice(0, K);
  // Standardize on the fly for THIS K subset
  const D = 80;
  const dimMean = new Float32Array(D), dimStd = new Float32Array(D);
  const all = [];
  for (const [, cls] of classList) for (const it of cls.its) all.push(it.v);
  const M = all.length;
  for (let d = 0; d < D; d++) {
    let m = 0; for (const v of all) m += v[d];
    m /= M;
    let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
    dimMean[d] = m; dimStd[d] = Math.sqrt(s2 / M) || 1;
  }
  const stdClasses = classList.map(([id, cls]) => ({
    id,
    its: cls.its.map(it => {
      const nv = new Float32Array(D);
      for (let d = 0; d < D; d++) nv[d] = (it.v[d] - dimMean[d]) / dimStd[d];
      return { v: nv, light: it.light };
    }),
  }));

  const rates = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const trainVecs = new Map();
    const test = [];
    for (const cls of stdClasses) {
      const shuf = seededShuffle(cls.its, seed);
      const take = Math.min(N, shuf.length - 1);
      trainVecs.set(cls.id, shuf.slice(0, take).map(x => x.v));
      for (let j = take; j < shuf.length; j++) test.push({ id: cls.id, v: shuf[j].v });
    }
    let correct = 0;
    for (const q of test) {
      let bestId = null, bestD = Infinity;
      for (const [id, vecs] of trainVecs) for (const t of vecs) {
        let sum = 0;
        for (let d = 0; d < D; d++) sum += Math.abs(q.v[d] - t[d]) * dimW[d];
        if (sum < bestD) { bestD = sum; bestId = id; }
      }
      if (bestId === q.id) correct++;
    }
    rates.push(correct / test.length);
  }
  const mean = rates.reduce((a,b) => a+b, 0) / rates.length;
  const sorted = rates.slice().sort((a,b) => a-b);
  return { K, N, mean, p025: sorted[Math.floor(0.025 * rates.length)] || sorted[0], p975: sorted[Math.floor(0.975 * rates.length)] || sorted[sorted.length-1] };
}

console.log("\n══ SCALING SANITY (N=5, 20 seeds each) ══");
for (const K of [47, 100, 200, 300, cache.size]) {
  const t0 = performance.now();
  const r = scoreAtK(K, 5, 20);
  const dt = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`  K=${K.toString().padStart(3)}  N=5  mean=${(r.mean*100).toFixed(1)}% [${(r.p025*100).toFixed(1)},${(r.p975*100).toFixed(1)}]  (${dt}s)`);
}

console.log("\n══ N-SWEEP at K=100 (10 seeds each) ══");
for (const N of [1, 3, 5, 7, 10, 15]) {
  const t0 = performance.now();
  const r = scoreAtK(100, N, 10);
  const dt = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`  K=100  N=${N.toString().padStart(2)}  mean=${(r.mean*100).toFixed(1)}%  (${dt}s)`);
}
