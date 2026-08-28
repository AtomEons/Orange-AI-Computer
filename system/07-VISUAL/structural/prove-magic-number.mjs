#!/usr/bin/env bun
// prove-magic-number.mjs — find the LEAST-NECESSARY training samples for 100%.
//
// Operator directive: "least necessary for a perfect train is the number i want
// you to find. its a magic number. find it. look at irregulars. its like 11 or
// something. its not alot."
//
// Method:
//   1. Sweep N-samples-per-class from N=1..∞ on the cached data.
//   2. For each N: train with N random IT vectors per class, test on the rest.
//   3. Repeat with 20 random seeds per N (average + best case).
//   4. Report the N at which we hit 100% (or plateau).
//   5. Look at IRREGULAR N (odd, prime, Fibonacci — maybe those beat even N).
//   6. Report storage: bytes per class × per sample × classes → GB total.

import fs from "node:fs";

const CACHE = "C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale/_bigwave_cache.json";
const raw = JSON.parse(fs.readFileSync(CACHE, "utf8"));
const classes = new Map(Object.entries(raw.classes).map(([k, samples]) =>
  [k, samples.map(s => ({ file: s.file, its: s.its.map(v => new Float32Array(v)) }))]
));

// Flatten to (cls, sample_idx, it_vector) — use global fixation only (idx 0)
// Then also try SACCADIC fixations as extra samples (each fixation = separate training sample)
// This effectively multiplies samples per class by 4 (global + 3 saccades).
function collectSamples(useSaccadic = false) {
  const perClass = new Map();
  for (const [cls, samples] of classes) {
    const list = [];
    for (let i = 0; i < samples.length; i++) {
      if (useSaccadic) {
        for (let k = 0; k < samples[i].its.length; k++) {
          list.push({ vec: samples[i].its[k], source: `${samples[i].file}_f${k}` });
        }
      } else {
        list.push({ vec: samples[i].its[0], source: samples[i].file });
      }
    }
    perClass.set(cls, list);
  }
  return perClass;
}

const D = 80;
const BLOCKS = [
  { start: 0, len: 12 }, { start: 12, len: 4 }, { start: 16, len: 6 }, { start: 22, len: 8 },
  { start: 30, len: 10 }, { start: 40, len: 10 }, { start: 50, len: 10 }, { start: 60, len: 20 },
];
const L1_BEST = [5, 5, 2, 3, 3, 5, 2, 5];

// Standardize
function standardizeAll(perClass) {
  const allVecs = [];
  for (const [cls, arr] of perClass) for (const s of arr) allVecs.push(s.vec);
  const N = allVecs.length;
  const dimMean = new Float32Array(D), dimStd = new Float32Array(D);
  for (let d = 0; d < D; d++) {
    let m = 0, s2 = 0;
    for (const v of allVecs) m += v[d];
    m /= N;
    for (const v of allVecs) s2 += (v[d] - m) ** 2;
    dimStd[d] = Math.sqrt(s2 / N) || 1;
    dimMean[d] = m;
  }
  const stdPerClass = new Map();
  for (const [cls, arr] of perClass) {
    const std = arr.map(s => {
      const nv = new Float32Array(D);
      for (let d = 0; d < D; d++) nv[d] = (s.vec[d] - dimMean[d]) / dimStd[d];
      return { ...s, vec: nv };
    });
    stdPerClass.set(cls, std);
  }
  return stdPerClass;
}

// Deterministic pseudo-random shuffle
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const r = (Math.sin(seed * 9301 + i * 49297) * 233280);
    const j = Math.floor((r - Math.floor(r)) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// L1 metric with weight
function l1Score(query, target, weights) {
  const dimW = new Float32Array(D);
  for (let b = 0; b < BLOCKS.length; b++) {
    for (let d = BLOCKS[b].start; d < BLOCKS[b].start + BLOCKS[b].len; d++) dimW[d] = weights[b];
  }
  let sum = 0;
  for (let d = 0; d < D; d++) sum += Math.abs(query[d] - target[d]) * dimW[d];
  return -sum;
}

// N-shot recognition: for each class, N random training samples;
// test held-out samples against ALL train sets. Returns (correct, total)
function measureNshot(perClass, N, seed, weights) {
  // For each class, seeded-shuffle its samples and take first N as train, rest as test
  const trainVecs = new Map();
  const testSamples = [];
  for (const [cls, arr] of perClass) {
    if (arr.length < 2) continue;
    const shuffled = seededShuffle(arr, seed + cls.charCodeAt(0));
    const take = Math.min(N, shuffled.length - 1);  // Always leave ≥1 for test
    trainVecs.set(cls, shuffled.slice(0, take).map(s => s.vec));
    for (const s of shuffled.slice(take)) testSamples.push({ cls, vec: s.vec });
  }
  let correct = 0;
  for (const q of testSamples) {
    let bestLabel = null, bestScore = -Infinity;
    for (const [cls, vecs] of trainVecs) {
      for (const t of vecs) {
        const s = l1Score(q.vec, t, weights);
        if (s > bestScore) { bestScore = s; bestLabel = cls; }
      }
    }
    if (bestLabel === q.cls) correct++;
  }
  return { correct, total: testSamples.length, rate: correct / testSamples.length };
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  MAGIC NUMBER — least-necessary training per class        ║");
console.log("╚══════════════════════════════════════════════════════════╝");

// STEP 1: Global-fixation only (each sample = 1 IT vector). Fixtures have 6 max.
const globalOnly = collectSamples(false);
const stdGlobal = standardizeAll(globalOnly);
const maxN_global = Math.min(...Array.from(globalOnly.values()).map(a => a.length));
console.log(`\n══ Global-fixation only (max ${maxN_global} samples/class): ══`);
console.log("  Class-size distribution:");
const sizes = new Map();
for (const arr of globalOnly.values()) sizes.set(arr.length, (sizes.get(arr.length) || 0) + 1);
for (const [size, count] of Array.from(sizes).sort((a, b) => a[0] - b[0])) console.log(`    ${size} samples: ${count} classes`);

const N_TEST = [1, 2, 3, 4, 5, 6];
console.log(`\n  N-shot sweep (20 seeds each, L1 metric with ${L1_BEST.join(",")} weights):`);
for (const N of N_TEST) {
  const rates = [];
  for (let seed = 1; seed <= 20; seed++) {
    const r = measureNshot(stdGlobal, N, seed, L1_BEST);
    rates.push(r.rate);
  }
  rates.sort((a, b) => b - a);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const best = rates[0], worst = rates[rates.length - 1];
  console.log(`    N=${N}:  mean=${(mean*100).toFixed(1)}%  best=${(best*100).toFixed(1)}%  worst=${(worst*100).toFixed(1)}%`);
}

// STEP 2: With saccadic (each sample = 4 IT vectors). Fixtures have 24 total, memes 4-24.
console.log(`\n══ With saccadic (each sample-file = 4 IT vectors, so max is 4× file count) ══`);
const saccadic = collectSamples(true);
const stdSacc = standardizeAll(saccadic);
const maxN_sacc = Math.min(...Array.from(saccadic.values()).map(a => a.length));
console.log(`  Max ${maxN_sacc} vectors per class`);

// Sweep including IRREGULAR N (odd, primes, Fibonacci)
const N_TEST_BIG = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 15, 17, 19, 21, 23];
console.log(`\n  N-shot sweep with irregulars (20 seeds each):`);
const N_results = {};
for (const N of N_TEST_BIG) {
  if (N > maxN_sacc) break;
  const rates = [];
  for (let seed = 1; seed <= 20; seed++) {
    const r = measureNshot(stdSacc, N, seed, L1_BEST);
    rates.push(r.rate);
  }
  rates.sort((a, b) => b - a);
  const mean = rates.reduce((s, r) => s + r, 0) / rates.length;
  const best = rates[0], worst = rates[rates.length - 1];
  N_results[N] = { mean, best, worst };
  const marker = (N === 11 || N === 5 || N === 7 || N === 13) ? " ⭐ (irregular)" : "";
  console.log(`    N=${N.toString().padStart(2)}:  mean=${(mean*100).toFixed(1)}%  best=${(best*100).toFixed(1)}%  worst=${(worst*100).toFixed(1)}%${marker}`);
}

// STEP 3: Storage estimate
console.log("\n══ Storage per class per sample ══");
const bytes_per_it = D * 4;   // 80 float32 = 320 bytes
console.log(`  IT vector: ${D} × 4B = ${bytes_per_it} bytes`);
const scenarios = [
  { N: 5, classes: 47 },
  { N: 11, classes: 47 },
  { N: 5, classes: 100 },
  { N: 11, classes: 100 },
  { N: 5, classes: 1000 },
  { N: 11, classes: 1000 },
  { N: 5, classes: 100000 },
  { N: 11, classes: 100000 },
];
console.log("  Storage across scale scenarios:");
for (const s of scenarios) {
  const total = bytes_per_it * s.N * s.classes;
  const mb = total / 1024 / 1024;
  const gb = mb / 1024;
  console.log(`    N=${s.N}, classes=${s.classes.toString().padStart(6)} → ${gb < 1 ? mb.toFixed(1) + " MB" : gb.toFixed(2) + " GB"} ${gb <= 5 ? "✓" : "✗ > 5 GB"}`);
}

// STEP 4: Report on magic number
console.log("\n══ MAGIC NUMBER ══");
// Find smallest N whose mean rate is at least 99%
let magicN = null;
for (const [N, r] of Object.entries(N_results).sort((a, b) => Number(a[0]) - Number(b[0]))) {
  if (r.mean >= 0.99 && magicN === null) { magicN = Number(N); }
}
if (magicN) {
  console.log(`  Smallest N with mean rate ≥ 99%: N=${magicN}`);
  console.log(`  Rate: mean=${(N_results[magicN].mean*100).toFixed(1)}%  best=${(N_results[magicN].best*100).toFixed(1)}%`);
  // Storage for 100k classes at magic N
  const total_100k = bytes_per_it * magicN * 100000;
  console.log(`  Storage at 100k classes: ${(total_100k / 1024 / 1024).toFixed(0)} MB (< 5 GB budget ✓)`);
} else {
  const bestSoFar = Object.entries(N_results).reduce((b, [N, r]) => r.mean > b.rate ? { N: Number(N), rate: r.mean } : b, { N: null, rate: 0 });
  console.log(`  99% not reached in tested range. Best: N=${bestSoFar.N} at ${(bestSoFar.rate*100).toFixed(1)}%`);
}

fs.writeFileSync("C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale/_magic_number.json", JSON.stringify({
  N_results,
  magicN,
  bytes_per_it,
  weights: L1_BEST,
}, null, 2));
