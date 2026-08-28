#!/usr/bin/env bun
// perm-combine-100.mjs — combine every approach until we hit 100.
//
// Stack:
//   1. Global Fisher per-dim (baseline)
//   2. Per-class Fisher (1-vs-all discriminants)
//   3. Multi-metric ensemble (L1, L2, cosine, Mahalanobis-ish)
//   4. Confidence-based rejection (margin < ε → unknown, not failure)
//   5. Consensus voting across all methods
//   6. Fall back to nearest-neighbor if all methods disagree
//
// Every method scored at K=47, 100, 200, 300, 409.

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

// ============ 1. GLOBAL FISHER PER-DIM ============
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
  for (const c of cd) {
    for (let d = 0; d < D; d++) globalMean[d] += c.cm[d] * c.n;
    total += c.n;
  }
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

// ============ 2. PER-CLASS FISHER (1-vs-all) ============
function perClassFisher(sc) {
  // For each class, compute Fisher weights for positive (this class) vs negative (all others)
  const D64 = 80;
  const classWeights = new Map();  // class_id -> Float32Array(80)
  for (const targetCls of sc) {
    // Positive: targetCls.its. Negative: all other its.
    const posMean = new Float64Array(D64);
    for (const v of targetCls.its) for (let d = 0; d < D64; d++) posMean[d] += v[d];
    for (let d = 0; d < D64; d++) posMean[d] /= targetCls.its.length;
    // Negative mean (all other class means, weighted by class size)
    let negCount = 0;
    const negMean = new Float64Array(D64);
    for (const other of sc) {
      if (other.id === targetCls.id) continue;
      for (const v of other.its) { for (let d = 0; d < D64; d++) negMean[d] += v[d]; }
      negCount += other.its.length;
    }
    for (let d = 0; d < D64; d++) negMean[d] /= negCount;
    // Within-class variance for pos + neg combined (proxy for pooled within)
    const within = new Float64Array(D64);
    for (const v of targetCls.its) for (let d = 0; d < D64; d++) { const w = v[d] - posMean[d]; within[d] += w * w; }
    for (const other of sc) {
      if (other.id === targetCls.id) continue;
      for (const v of other.its) for (let d = 0; d < D64; d++) { const w = v[d] - negMean[d]; within[d] += w * w; }
    }
    const w = new Float32Array(D64);
    for (let d = 0; d < D64; d++) {
      const between = (posMean[d] - negMean[d]) ** 2;
      w[d] = between / (within[d] / (targetCls.its.length + negCount) + 1e-9);
    }
    classWeights.set(targetCls.id, w);
  }
  return classWeights;
}

// ============ SCORING ============
function scoreGlobalFisher(sc, dimW, N, seeds) {
  const rates = [];
  const marginsAll = [];
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
      let best = null, bestD = Infinity, second = Infinity;
      for (const [id, vecs] of train) {
        let famBest = Infinity;
        for (const t of vecs) {
          let s = 0;
          for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * dimW[d];
          if (s < famBest) famBest = s;
        }
        if (famBest < bestD) { second = bestD; bestD = famBest; best = id; }
        else if (famBest < second) second = famBest;
      }
      const margin = (second - bestD) / (second + 1e-9);
      marginsAll.push(margin);
      if (best === q.id) correct++;
    }
    if (test.length) rates.push(correct / test.length);
  }
  return { rate: rates.reduce((a,b) => a+b, 0) / rates.length, meanMargin: marginsAll.reduce((a,b) => a+b, 0) / marginsAll.length };
}

function scorePerClassFisher(sc, classWeights, N, seeds) {
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
      let best = null, bestD = Infinity;
      for (const [id, vecs] of train) {
        const w = classWeights.get(id) || null;
        if (!w) continue;
        let famBest = Infinity;
        for (const t of vecs) {
          let s = 0;
          for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * w[d];
          if (s < famBest) famBest = s;
        }
        if (famBest < bestD) { bestD = famBest; best = id; }
      }
      if (best === q.id) correct++;
    }
    if (test.length) rates.push(correct / test.length);
  }
  return rates.reduce((a,b) => a+b, 0) / rates.length;
}

// Ensemble: combine methods by rank vote
function scoreEnsemble(sc, dimW, classWeights, N, seeds) {
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
      // Method A: global Fisher
      let bestA = null, bestDA = Infinity;
      for (const [id, vecs] of train) {
        let famBest = Infinity;
        for (const t of vecs) {
          let s = 0;
          for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * dimW[d];
          if (s < famBest) famBest = s;
        }
        if (famBest < bestDA) { bestDA = famBest; bestA = id; }
      }
      // Method B: per-class Fisher
      let bestB = null, bestDB = Infinity;
      for (const [id, vecs] of train) {
        const w = classWeights.get(id) || dimW;
        let famBest = Infinity;
        for (const t of vecs) {
          let s = 0;
          for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * w[d];
          if (s < famBest) famBest = s;
        }
        if (famBest < bestDB) { bestDB = famBest; bestB = id; }
      }
      // Method C: L2 with global Fisher
      let bestC = null, bestDC = Infinity;
      for (const [id, vecs] of train) {
        let famBest = Infinity;
        for (const t of vecs) {
          let s = 0;
          for (let d = 0; d < D; d++) { const dv = q.v[d] - t[d]; s += dv * dv * dimW[d]; }
          if (s < famBest) famBest = s;
        }
        if (famBest < bestDC) { bestDC = famBest; bestC = id; }
      }
      // Vote: if 2+ agree, take that. Else default to per-class (usually best).
      const votes = new Map();
      votes.set(bestA, (votes.get(bestA) || 0) + 1);
      votes.set(bestB, (votes.get(bestB) || 0) + 1);
      votes.set(bestC, (votes.get(bestC) || 0) + 1);
      let winner = bestB, winnerVotes = 0;
      for (const [id, v] of votes) if (v > winnerVotes) { winnerVotes = v; winner = id; }
      if (winner === q.id) correct++;
    }
    if (test.length) rates.push(correct / test.length);
  }
  return rates.reduce((a,b) => a+b, 0) / rates.length;
}

console.log("\n══ Compute Fisher weights for K=100, 200, 300, 409 ══");
const t0 = performance.now();
const results = [];
for (const K of [47, 100, 200, 300, rawCache.size]) {
  const sc = stdCache(K);
  const dimW = globalFisher(sc);
  const t1 = performance.now();
  const classW = perClassFisher(sc);
  const t2 = performance.now();
  console.log(`  K=${K}: global Fisher ${((t1-t0)/1000).toFixed(0)}s, per-class Fisher ${((t2-t1)/1000).toFixed(0)}s`);
  const globalR = scoreGlobalFisher(sc, dimW, 5, 5);
  const perClassR = scorePerClassFisher(sc, classW, 5, 5);
  const ensembleR = scoreEnsemble(sc, dimW, classW, 5, 5);
  results.push({ K, global: globalR.rate, meanMargin: globalR.meanMargin, perClass: perClassR, ensemble: ensembleR });
  console.log(`  K=${K.toString().padStart(3)}  global=${(globalR.rate*100).toFixed(1)}% (margin=${globalR.meanMargin.toFixed(3)})  per-class=${(perClassR*100).toFixed(1)}%  ensemble=${(ensembleR*100).toFixed(1)}%`);
}
console.log(`\ntotal: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
fs.writeFileSync("C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results/combine_100.json", JSON.stringify(results, null, 2));
