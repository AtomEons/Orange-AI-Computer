#!/usr/bin/env bun
// push-wide-to-100.mjs — stack Fisher + kNN + rejection on wide-IT.
//
// Wide-IT (286-D) Fisher hits 78% at K=300. Combine:
//   1. Global Fisher (baseline)
//   2. kNN with Fisher-weighted distance (majority of K nearest)
//   3. Margin-based rejection (accept "unknown" if margin low)
//   4. Multi-metric ensemble (weighted-L1 + weighted-L2)

import fs from "node:fs";
import path from "node:path";

const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide";
function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(pseudo(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Load modal-length wide-IT
const rawCache = new Map();
const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith("wide_"));
const lengths = new Map();
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
    for (const c of d.classes) if (c.its) for (const it of c.its) lengths.set(it.v.length, (lengths.get(it.v.length) || 0) + 1);
  } catch {}
}
let modeL = 286, modeCount = 0;
for (const [L, c] of lengths) if (c > modeCount) { modeCount = c; modeL = L; }
for (const f of files) {
  try {
    const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
    for (const c of d.classes) {
      if (!c.its) continue;
      const keptIts = c.its.filter(it => it.v.length === modeL);
      if (keptIts.length >= 2) rawCache.set(c.id, { id: c.id, its: keptIts });
    }
  } catch {}
}
console.log(`loaded ${rawCache.size} classes at D=${modeL}`);

const D = modeL;
function sanitize(v) {
  const out = new Float32Array(v.length);
  for (let d = 0; d < v.length; d++) {
    const x = v[d];
    out[d] = Number.isFinite(x) ? Math.sign(x) * Math.log1p(Math.abs(x)) : 0;
  }
  return out;
}

function stdCache(K) {
  const classes = Array.from(rawCache.values()).slice(0, K);
  const all = [];
  for (const cls of classes) for (const it of cls.its) all.push(sanitize(it.v));
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
      const sit = sanitize(it.v);
      const nv = new Float32Array(D);
      for (let d = 0; d < D; d++) nv[d] = (sit[d] - mean[d]) / std[d];
      return nv;
    }),
  }));
}

function globalFisher(sc) {
  const dimBetween = new Float64Array(D);
  const dimWithin = new Float64Array(D);
  const globalMean = new Float64Array(D);
  let total = 0;
  const cd = sc.map(cls => {
    const cm = new Float64Array(D);
    for (const v of cls.its) for (let d = 0; d < D; d++) cm[d] += v[d];
    for (let d = 0; d < D; d++) cm[d] /= cls.its.length;
    return { cm, its: cls.its, n: cls.its.length };
  });
  for (const c of cd) { for (let d = 0; d < D; d++) globalMean[d] += c.cm[d] * c.n; total += c.n; }
  for (let d = 0; d < D; d++) globalMean[d] /= total;
  for (const c of cd) {
    for (let d = 0; d < D; d++) {
      const diff = c.cm[d] - globalMean[d];
      dimBetween[d] += c.n * diff * diff;
      for (const v of c.its) { const w = v[d] - c.cm[d]; dimWithin[d] += w * w; }
    }
  }
  const dimW = new Float32Array(D);
  for (let d = 0; d < D; d++) dimW[d] = dimBetween[d] / (dimWithin[d] + 1e-9);
  return dimW;
}

// Score with configurable strategy
function scoreStrategy(sc, dimW, N, seeds, strategy) {
  const rates = [];
  const rejectRates = [];
  for (let seed = 1; seed <= seeds; seed++) {
    const train = new Map(); const test = [];
    for (const cls of sc) {
      const shuf = seededShuffle(cls.its, seed);
      const take = Math.min(N, shuf.length - 1);
      train.set(cls.id, shuf.slice(0, take));
      for (let j = take; j < shuf.length; j++) test.push({ id: cls.id, v: shuf[j] });
    }
    let correct = 0, rejected = 0;
    for (const q of test) {
      // Compute L1-Fisher distance to every training vector
      const dists = [];
      for (const [id, vecs] of train) for (const t of vecs) {
        let s = 0;
        if (strategy.metric === "L2") for (let d = 0; d < D; d++) { const dv = q.v[d] - t[d]; s += dv * dv * dimW[d]; }
        else /* L1 */ for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * dimW[d];
        dists.push({ id, d: s });
      }
      dists.sort((a, b) => a.d - b.d);
      let best = null;
      if (strategy.type === "1-NN") {
        best = dists[0].id;
      } else if (strategy.type === "kNN") {
        const votes = new Map();
        for (let k = 0; k < Math.min(strategy.k, dists.length); k++) {
          votes.set(dists[k].id, (votes.get(dists[k].id) || 0) + 1);
        }
        let bestVotes = -1;
        for (const [id, v] of votes) if (v > bestVotes) { bestVotes = v; best = id; }
      } else if (strategy.type === "rejection") {
        // Check margin between top-1 and top-K where K = next different class
        let secondCls = null, secondD = Infinity;
        for (const c of dists.slice(1)) if (c.id !== dists[0].id) { secondCls = c.id; secondD = c.d; break; }
        const margin = (secondD - dists[0].d) / (secondD + 1e-9);
        if (margin < strategy.rejectThreshold) {
          rejected++;
          continue;   // skip — count as neither correct nor incorrect
        }
        best = dists[0].id;
      }
      if (best === q.id) correct++;
    }
    if (test.length > rejected) rates.push(correct / (test.length - rejected));
    rejectRates.push(rejected / test.length);
  }
  return { rate: rates.reduce((a,b) => a+b, 0) / rates.length, rejectFrac: rejectRates.reduce((a,b) => a+b, 0) / rejectRates.length };
}

console.log("\n══ WIDE-IT STRATEGIES @ MULTIPLE K ══");
const t0 = performance.now();
for (const K of [47, 100, 200, 300, rawCache.size]) {
  const sc = stdCache(K);
  const dimW = globalFisher(sc);
  console.log(`\n  K=${K.toString().padStart(3)}:`);
  const s1 = scoreStrategy(sc, dimW, 5, 5, { type: "1-NN", metric: "L1" });
  console.log(`    1-NN L1-Fisher:      ${(s1.rate*100).toFixed(1)}%`);
  const s2 = scoreStrategy(sc, dimW, 5, 5, { type: "1-NN", metric: "L2" });
  console.log(`    1-NN L2-Fisher:      ${(s2.rate*100).toFixed(1)}%`);
  for (const k of [3, 5, 7]) {
    const s = scoreStrategy(sc, dimW, 5, 5, { type: "kNN", k, metric: "L1" });
    console.log(`    ${k}-NN L1-Fisher:      ${(s.rate*100).toFixed(1)}%`);
  }
  for (const thresh of [0.01, 0.05, 0.10]) {
    const s = scoreStrategy(sc, dimW, 5, 5, { type: "rejection", rejectThreshold: thresh, metric: "L1" });
    console.log(`    reject<${thresh.toString().padEnd(4)} L1-Fisher: ${(s.rate*100).toFixed(1)}% (rejected ${(s.rejectFrac*100).toFixed(1)}%)`);
  }
}
console.log(`\ntotal: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
