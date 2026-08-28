#!/usr/bin/env bun
// stage-diagnose.mjs — identify the augmentation that broke recognition.

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

// Re-read shards keeping ALL augmentation metadata this time
const cacheFull = new Map();
for (let s = 0; s < 100; s++) {
  const p = shardPath(s);
  if (!fs.existsSync(p)) continue;
  try {
    const d = JSON.parse(fs.readFileSync(p, "utf8"));
    for (const c of d.classes) if (c.its && c.its.length > 1) cacheFull.set(c.id, c);
  } catch {}
}
console.log(`loaded ${cacheFull.size} classes`);

// Look at what "light" tags we have per sample. Do samples carry rot/scale/crop info?
const firstClass = cacheFull.values().next().value;
const s0 = firstClass.its[0];
console.log(`sample keys: ${Object.keys(s0).join(", ")}`);

// The shard was built WITHOUT rot/scale/crop metadata in the its list, only .v and .light.
// Rebuild the augmentation grid deterministically to map each augmentation SLOT back
// to what (light, rot, scale, crop, bright, contrast) it was, then filter by criteria.
//
// From dispatch-staged.mjs augmentationsForClass: first 6 slots = pure-lighting.
// So its[0..5] should be lighting-only, no rotation, no scale, no crop.
// its[6..13] = rotations at raw lighting.
// its[14..17] = scales at raw.
// its[18..21] = crops at raw.
// its[22..24] = brightness at raw.
// its[25..27] = contrast at raw.
// its[28..33] = NEON + CRT with rotations.
// its[34..37] = NEON + CRT with scales.
// its[38..41] = NEON + CRT with crops.
// its[42..99] = random combinations.

const BLOCK_STARTS = [0, 12, 16, 22, 30, 40, 50, 60];
const BLOCK_LENS = [12, 4, 6, 8, 10, 10, 10, 20];
const BLOCK_W_L1 = [5, 5, 2, 3, 3, 5, 2, 5];
const dimW = new Float32Array(80);
for (let b = 0; b < 8; b++) for (let d = BLOCK_STARTS[b]; d < BLOCK_STARTS[b] + BLOCK_LENS[b]; d++) dimW[d] = BLOCK_W_L1[b];

// Test different subsets of augmentations
function scoreSubset(subsetTag, keepIdxFn, K, N, seeds) {
  const D = 80;
  const classList = Array.from(cacheFull.entries()).slice(0, K);
  // Filter its per class
  const filtered = classList.map(([id, cls]) => {
    const kept = [];
    for (let i = 0; i < cls.its.length; i++) if (keepIdxFn(i)) kept.push(cls.its[i]);
    return { id, its: kept };
  });
  // Standardize
  const all = [];
  for (const cls of filtered) for (const it of cls.its) all.push(it.v);
  if (all.length < 2) return { subsetTag, K, N, mean: 0, samples: 0 };
  const dimMean = new Float32Array(D), dimStd = new Float32Array(D);
  const M = all.length;
  for (let d = 0; d < D; d++) {
    let m = 0; for (const v of all) m += v[d]; m /= M;
    let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
    dimMean[d] = m; dimStd[d] = Math.sqrt(s2 / M) || 1;
  }
  const stdClasses = filtered.map(cls => ({
    id: cls.id,
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
      if (cls.its.length < 2) continue;
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
    if (test.length > 0) rates.push(correct / test.length);
  }
  if (rates.length === 0) return { subsetTag, K, N, mean: 0 };
  const mean = rates.reduce((a,b) => a+b, 0) / rates.length;
  return { subsetTag, K, N, mean, samples: all.length };
}

// A. Only lighting-only augmentations (first 6 slots)
// B. Only rotations (slots 6-13, all at raw)
// C. Only scales (slots 14-17)
// D. Only crops (slots 18-21)
// E. Rotation + lighting (0-13)
// F. All non-rotation (skip 6-13)
// G. FULL grid (all 100 slots)

// Clean grid: lighting + rotations + scales + brightness/contrast (no crops, no randoms)
const cleanFn = (i) => (i < 18) || (i >= 22 && i < 28);

console.log("\n══ CLEAN grid — K sweep with N=5, 20 seeds ══");
for (const K of [47, 100, 200, 300, cacheFull.size]) {
  const t0 = performance.now();
  const r = scoreSubset("clean", cleanFn, K, 5, 20);
  const dt = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`  K=${K.toString().padStart(3)}  mean=${(r.mean*100).toFixed(1)}%  (${r.samples} vecs total, ${dt}s)`);
}

console.log("\n══ CLEAN grid — N sweep at K=100, 20 seeds ══");
for (const N of [1, 3, 5, 7, 10]) {
  const t0 = performance.now();
  const r = scoreSubset("clean", cleanFn, 100, N, 20);
  const dt = ((performance.now() - t0) / 1000).toFixed(0);
  console.log(`  N=${N.toString().padStart(2)}  mean=${(r.mean*100).toFixed(1)}%  (${dt}s)`);
}

console.log("\n══ Explicit NEON/CRT cross-illuminant on CLEAN grid, K=47 ══");
// Train on all non-neon, non-crt; test on neon, crt
const nonExtreme = (it) => it.light !== "neon" && it.light !== "crt";
const isNeon = (it) => it.light === "neon";
const isCrt = (it) => it.light === "crt";
function scoreCross(K, trainFn, testFn) {
  const D = 80;
  const classList = Array.from(cacheFull.entries()).slice(0, K);
  const filtered = classList.map(([id, cls]) => {
    const kept = [];
    for (let i = 0; i < cls.its.length; i++) if (cleanFn(i)) kept.push(cls.its[i]);
    return { id, its: kept };
  });
  // Standardize
  const all = [];
  for (const cls of filtered) for (const it of cls.its) all.push(it.v);
  const dimMean = new Float32Array(D), dimStd = new Float32Array(D);
  const M = all.length;
  for (let d = 0; d < D; d++) {
    let m = 0; for (const v of all) m += v[d]; m /= M;
    let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
    dimMean[d] = m; dimStd[d] = Math.sqrt(s2 / M) || 1;
  }
  const trainVecs = new Map();
  const test = [];
  for (const cls of filtered) {
    const trainSet = cls.its.filter(trainFn).map(it => {
      const nv = new Float32Array(D);
      for (let d = 0; d < D; d++) nv[d] = (it.v[d] - dimMean[d]) / dimStd[d];
      return nv;
    });
    const testSet = cls.its.filter(testFn).map(it => {
      const nv = new Float32Array(D);
      for (let d = 0; d < D; d++) nv[d] = (it.v[d] - dimMean[d]) / dimStd[d];
      return { v: nv, id: cls.id };
    });
    if (trainSet.length && testSet.length) {
      trainVecs.set(cls.id, trainSet);
      for (const t of testSet) test.push(t);
    }
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
  return { correct, total: test.length, rate: test.length ? correct / test.length : 0 };
}
const nOnNeon = scoreCross(47, nonExtreme, isNeon);
console.log(`  train normal → test NEON:  ${nOnNeon.correct}/${nOnNeon.total} = ${(nOnNeon.rate*100).toFixed(1)}%`);
const nOnCrt = scoreCross(47, nonExtreme, isCrt);
console.log(`  train normal → test CRT:   ${nOnCrt.correct}/${nOnCrt.total} = ${(nOnCrt.rate*100).toFixed(1)}%`);
