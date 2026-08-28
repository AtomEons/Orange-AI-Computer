#!/usr/bin/env bun
// train-high-test-low.mjs — the correct recognition protocol.
//
// Train on high-quality (raw, clean) samples only.
// Test on ALL degraded versions (lighting shifts, rotations, scales,
// brightness/contrast, NEON/CRT extremes).
//
// The augmentation grid in dispatch-wide-it.mjs is:
//   slots 0..5  = 6 pure lightings (raw, sun, candle, moon, crt, neon)
//   slots 6..13 = 8 rotations at RAW lighting
//   slots 14..16 = 3 scales at RAW
//   slots 17..19 = 3 brightness
//   slots 20..22 = 3 contrast
//   slots 23..34 = NEON + CRT with rotation/scale
//
// "High quality" = raw lighting, no transform: slot 0.
// "Multiple clean views" = slots 0 (raw) + first few rotations at raw (slots 6-9)
//   — these ARE the clean training samples the operator specified.
// "Low quality" = everything else, especially NEON/CRT + rotations.

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

// Split each class into HIGH-QUALITY (raw lighting) and LOW-QUALITY (everything else)
// The wide-IT cache stores 'light' as one of raw/sun/candle/moon/crt/neon.
// High-quality training pool: light === "raw" (which happens to include rotations
// applied at raw lighting, scale/brightness/contrast variants of raw).
// Low-quality test pool: light in { sun, candle, moon, crt, neon }.

function stdCache(K) {
  const classes = Array.from(rawCache.values()).slice(0, K);
  // Compute per-dim mean/std from ALL vectors (training + test) for consistent normalization
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
      return { v: nv, light: it.light };
    }),
  }));
}

function globalFisher(sc, trainOnly = null) {
  // trainOnly: if given, only compute Fisher from training vectors (subset per class)
  const source = trainOnly || sc;
  const dimBetween = new Float64Array(D);
  const dimWithin = new Float64Array(D);
  const globalMean = new Float64Array(D);
  let total = 0;
  const cd = source.map(cls => {
    const cm = new Float64Array(D);
    for (const v of cls.its) for (let d = 0; d < D; d++) cm[d] += v.v ? v.v[d] : v[d];
    for (let d = 0; d < D; d++) cm[d] /= cls.its.length;
    return { cm, its: cls.its, n: cls.its.length };
  });
  for (const c of cd) { for (let d = 0; d < D; d++) globalMean[d] += c.cm[d] * c.n; total += c.n; }
  for (let d = 0; d < D; d++) globalMean[d] /= total;
  for (const c of cd) {
    for (let d = 0; d < D; d++) {
      const diff = c.cm[d] - globalMean[d];
      dimBetween[d] += c.n * diff * diff;
      for (const v of c.its) {
        const val = v.v ? v.v[d] : v[d];
        const w = val - c.cm[d]; dimWithin[d] += w * w;
      }
    }
  }
  const dimW = new Float32Array(D);
  for (let d = 0; d < D; d++) dimW[d] = dimBetween[d] / (dimWithin[d] + 1e-9);
  return dimW;
}

// TRAIN HIGH: use only raw-lighting samples from each class
// TEST LOW:  use only degraded (non-raw) samples
function scoreTrainHighTestLow(sc, N_train, rejectThreshold = null) {
  // Build Fisher weights from TRAINING pool ONLY (avoid leakage of test-set variance)
  const trainingSC = sc.map(cls => ({
    id: cls.id,
    its: cls.its.filter(it => it.light === "raw").slice(0, 999),  // all raw variants available
  })).filter(cls => cls.its.length > 0);
  if (trainingSC.length === 0) return { rate: 0, rejectFrac: 1, note: "no raw training samples" };

  const dimW = globalFisher(trainingSC);
  const rates = [];
  const rejectRates = [];
  const perLightCorrect = new Map(), perLightTotal = new Map();

  for (let seed = 1; seed <= 5; seed++) {
    // For each class: take N_train random raw samples as training; rest of class is IGNORED for training
    // Test set = ALL non-raw samples across all classes
    const train = new Map();
    const test = [];
    for (const cls of sc) {
      const rawSamples = cls.its.filter(it => it.light === "raw");
      const lowSamples = cls.its.filter(it => it.light !== "raw");
      if (rawSamples.length === 0 || lowSamples.length === 0) continue;
      const shufRaw = seededShuffle(rawSamples, seed);
      const take = Math.min(N_train, shufRaw.length);
      train.set(cls.id, shufRaw.slice(0, take).map(x => x.v));
      for (const t of lowSamples) test.push({ id: cls.id, v: t.v, light: t.light });
    }
    let correct = 0, rejected = 0;
    for (const q of test) {
      // Find nearest training vector across all classes
      const dists = [];
      for (const [id, vecs] of train) for (const t of vecs) {
        let s = 0;
        for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * dimW[d];
        dists.push({ id, d: s });
      }
      dists.sort((a, b) => a.d - b.d);
      let secondCls = null, secondD = Infinity;
      for (const c of dists.slice(1)) if (c.id !== dists[0].id) { secondCls = c.id; secondD = c.d; break; }
      const margin = (secondD - dists[0].d) / (secondD + 1e-9);
      if (rejectThreshold !== null && margin < rejectThreshold) {
        rejected++;
        continue;
      }
      const predicted = dists[0].id;
      perLightTotal.set(q.light, (perLightTotal.get(q.light) || 0) + 1);
      if (predicted === q.id) {
        correct++;
        perLightCorrect.set(q.light, (perLightCorrect.get(q.light) || 0) + 1);
      }
    }
    const scored = test.length - rejected;
    if (scored > 0) rates.push(correct / scored);
    rejectRates.push(rejected / test.length);
  }
  return {
    rate: rates.reduce((a,b) => a+b, 0) / rates.length,
    rejectFrac: rejectRates.reduce((a,b) => a+b, 0) / rejectRates.length,
    perLight: Object.fromEntries(Array.from(perLightTotal.entries()).map(([l, t]) => [l, (perLightCorrect.get(l) || 0) / t])),
  };
}

console.log("\n══ TRAIN HIGH (raw only) → TEST LOW (all degraded) ══");
const t0 = performance.now();
for (const K of [47, 100, 200, 300, rawCache.size]) {
  const sc = stdCache(K);
  console.log(`\n  K=${K}:`);
  for (const N of [1, 2, 3, 5]) {
    const s = scoreTrainHighTestLow(sc, N, null);
    console.log(`    N=${N}  raw (no reject):  ${(s.rate*100).toFixed(1)}%  per-light: ${JSON.stringify(Object.fromEntries(Object.entries(s.perLight).map(([l,r]) => [l, +(r*100).toFixed(1)])))}`);
  }
  for (const thresh of [0.01, 0.05, 0.10]) {
    const s = scoreTrainHighTestLow(sc, 3, thresh);
    console.log(`    N=3 reject<${thresh}: ${(s.rate*100).toFixed(1)}% (rejected ${(s.rejectFrac*100).toFixed(1)}%)`);
  }
}
console.log(`\ntotal: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
