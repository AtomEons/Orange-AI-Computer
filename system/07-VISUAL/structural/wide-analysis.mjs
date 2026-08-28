#!/usr/bin/env bun
// wide-analysis.mjs — analyze wide-IT vectors when they land.
// Runs global Fisher, per-class Fisher (fixed), and Mahalanobis on 286-D vectors.

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

// Load whatever's been captured so far
const rawCache = new Map();
let wide_dim = null;
if (fs.existsSync(CACHE_DIR)) {
  // First pass: find modal dim (most common length)
  const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith("wide_"));
  const lengths = new Map();
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
      for (const c of d.classes) if (c.its) for (const it of c.its) {
        lengths.set(it.v.length, (lengths.get(it.v.length) || 0) + 1);
      }
    } catch {}
  }
  let modeL = 0, modeCount = 0;
  for (const [L, c] of lengths) if (c > modeCount) { modeCount = c; modeL = L; }
  wide_dim = modeL;
  console.log(`modal dim: ${modeL} (${modeCount} vectors)`);
  // Second pass: keep only vectors of modal length
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
}
console.log(`loaded ${rawCache.size} classes at wide_dim=${wide_dim}`);
if (rawCache.size < 10) { console.log("not enough data yet — wait for more captures"); process.exit(0); }

const D = wide_dim;

// Sanitize: log-scale any dim with outliers, robust to scale differences.
// Applies log(1+|x|)*sign(x) to every dim. Preserves ordering.
function sanitize(v) {
  const out = new Float32Array(v.length);
  for (let d = 0; d < v.length; d++) {
    const x = v[d];
    if (!Number.isFinite(x)) out[d] = 0;
    else out[d] = Math.sign(x) * Math.log1p(Math.abs(x));
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

function scoreFisher(sc, dimW, N, seeds) {
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
      for (const [id, vecs] of train) for (const t of vecs) {
        let s = 0;
        for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * dimW[d];
        if (s < bestD) { bestD = s; best = id; }
      }
      if (best === q.id) correct++;
    }
    if (test.length) rates.push(correct / test.length);
  }
  return rates.reduce((a,b) => a+b, 0) / rates.length;
}

console.log("\n══ WIDE-IT FISHER @ MULTIPLE K ══");
const t0 = performance.now();
const K_max = rawCache.size;
const K_test = [];
for (const K of [47, 100, 200, 300, 400, K_max]) if (K <= K_max) K_test.push(K);

for (const K of K_test) {
  const sc = stdCache(K);
  const dimW = globalFisher(sc);
  const rate = scoreFisher(sc, dimW, 5, 5);
  console.log(`  K=${K.toString().padStart(3)} (wide=${D}D)  Fisher rate=${(rate*100).toFixed(1)}%`);
}
console.log(`total: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
