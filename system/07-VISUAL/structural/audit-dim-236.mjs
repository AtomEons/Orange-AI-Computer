#!/usr/bin/env bun
// audit-dim-236.mjs — is dim 236 (44% of Fisher energy, rawMax=128 hard ceiling) alpha gold or class-leak?
// Answers: (1) 1-D solo classifier accuracy on train-high test-low protocol
//          (2) raw-value distribution: is this an RGB moment or a photon-inference measurement?
//          (3) per-class raw value — clustered = leak, spread = signal
// Zero pivot. This is diagnostic on the current baseline.

import fs from "node:fs"; import path from "node:path";

const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide";
const DIM = 236;   // axis-bundle[156] = spatial-frequency[0] per build-wide-it.mjs walk

function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(pseudo(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith("wide_"));
const lens = new Map();
for (const f of files) try {
  for (const c of JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8")).classes)
    if (c.its) for (const it of c.its) lens.set(it.v.length, (lens.get(it.v.length) || 0) + 1);
} catch {}
let modeL = 286, mc = 0;
for (const [L, c] of lens) if (c > mc) { mc = c; modeL = L; }

const cache = new Map();
for (const f of files) try {
  for (const c of JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8")).classes) {
    if (!c.its) continue;
    const k = c.its.filter(x => x.v.length === modeL);
    if (k.length >= 2) cache.set(c.id, { id: c.id, its: k });
  }
} catch {}
console.log(`loaded ${cache.size} classes at D=${modeL}, auditing dim ${DIM}`);

// ---- 1. Distribution of raw dim 236 values ----
const allVals = [];
const perClassVals = new Map();
for (const c of cache.values()) {
  const vs = c.its.map(it => it.v[DIM]);
  perClassVals.set(c.id, vs);
  for (const v of vs) allVals.push(v);
}
allVals.sort((a, b) => a - b);
const q = p => allVals[Math.min(allVals.length - 1, Math.floor(p * allVals.length))];
console.log("\n── raw dim ${DIM} value distribution ──");
console.log(`  N=${allVals.length}  min=${allVals[0].toFixed(3)}  max=${allVals[allVals.length-1].toFixed(3)}`);
console.log(`  p05=${q(0.05).toFixed(2)}  p25=${q(0.25).toFixed(2)}  p50=${q(0.50).toFixed(2)}  p75=${q(0.75).toFixed(2)}  p95=${q(0.95).toFixed(2)}`);
const mean = allVals.reduce((s, v) => s + v, 0) / allVals.length;
const std = Math.sqrt(allVals.reduce((s, v) => s + (v - mean) ** 2, 0) / allVals.length);
console.log(`  mean=${mean.toFixed(3)}  std=${std.toFixed(3)}`);

// unique-value count to detect quantized/bounded code
const uniq = new Set(allVals.map(v => Math.round(v * 100) / 100));
console.log(`  unique-values (2 decimals): ${uniq.size} / ${allVals.length}  (leak-flag if <100)`);

// ---- 2. Per-class distribution — clustered = leak, spread = signal ----
const perClassStats = [];
for (const [id, vs] of perClassVals) {
  const m = vs.reduce((s, v) => s + v, 0) / vs.length;
  const s = Math.sqrt(vs.reduce((sum, v) => sum + (v - m) ** 2, 0) / vs.length);
  perClassStats.push({ id, mean: m, std: s, count: vs.length });
}
perClassStats.sort((a, b) => a.mean - b.mean);
const perClassMeans = perClassStats.map(x => x.mean);
const globalStd = std;
const withinClassStd = perClassStats.reduce((s, x) => s + x.std, 0) / perClassStats.length;
console.log("\n── per-class stats ──");
console.log(`  within-class std (mean): ${withinClassStd.toFixed(3)}`);
console.log(`  between-class means: p05=${perClassMeans[Math.floor(0.05 * perClassMeans.length)].toFixed(2)}  p50=${perClassMeans[Math.floor(0.5 * perClassMeans.length)].toFixed(2)}  p95=${perClassMeans[Math.floor(0.95 * perClassMeans.length)].toFixed(2)}`);
console.log(`  Fisher-like ratio (between/within) approx: ${(globalStd / withinClassStd).toFixed(2)}`);
console.log(`  10 lowest per-class means:`);
for (const x of perClassStats.slice(0, 10)) console.log(`    ${x.id.padEnd(10)} mean=${x.mean.toFixed(2)}  std=${x.std.toFixed(2)}  n=${x.count}`);
console.log(`  10 highest per-class means:`);
for (const x of perClassStats.slice(-10)) console.log(`    ${x.id.padEnd(10)} mean=${x.mean.toFixed(2)}  std=${x.std.toFixed(2)}  n=${x.count}`);

// ---- 3. 1-D SOLO CLASSIFIER — the leak test ----
// If dim 236 alone can classify >90%, it's carrying class ID (leak).
// If 40-70%, it's a genuine coarse router (alpha).
// If <30%, then the Fisher weight is a mirage from tight within-class variance.
console.log("\n── 1-D SOLO CLASSIFIER (train-high test-low protocol) ──");
const soloResults = [];
for (const N of [1, 3, 5]) {
  for (let seed = 1; seed <= 5; seed++) {
    // Training: raw samples only, N per class
    const train = new Map();
    const test = [];
    for (const c of cache.values()) {
      const rawSamples = c.its.filter(it => it.light === "raw");
      const lowSamples = c.its.filter(it => it.light !== "raw");
      if (rawSamples.length === 0 || lowSamples.length === 0) continue;
      const shuf = seededShuffle(rawSamples, seed);
      train.set(c.id, shuf.slice(0, Math.min(N, shuf.length)).map(x => x.v[DIM]));
      for (const t of lowSamples) test.push({ id: c.id, v: t.v[DIM], light: t.light });
    }
    let correct = 0;
    for (const q of test) {
      let best = null, bestD = Infinity;
      for (const [id, vs] of train) {
        for (const t of vs) {
          const d = Math.abs(q.v - t);
          if (d < bestD) { bestD = d; best = id; }
        }
      }
      if (best === q.id) correct++;
    }
    soloResults.push({ N, seed, accuracy: correct / test.length });
  }
}
const groupByN = new Map();
for (const r of soloResults) {
  if (!groupByN.has(r.N)) groupByN.set(r.N, []);
  groupByN.get(r.N).push(r.accuracy);
}
for (const [N, arr] of groupByN) {
  const m = arr.reduce((s, v) => s + v, 0) / arr.length;
  const st = Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / arr.length);
  console.log(`  N=${N}: solo accuracy = ${(100*m).toFixed(1)}% ± ${(100*st).toFixed(1)} (5 seeds)`);
}

// ---- 4. VERDICT ----
console.log("\n══ VERDICT ══");
const soloM3 = groupByN.get(3).reduce((s, v) => s + v, 0) / groupByN.get(3).length;
const chanceBaseline = 1 / cache.size;
console.log(`  chance baseline (K=${cache.size}): ${(100*chanceBaseline).toFixed(3)}%`);
console.log(`  N=3 solo accuracy: ${(100*soloM3).toFixed(1)}%`);
if (soloM3 > 0.90) {
  console.log(`  → LEAK: dim ${DIM} alone recovers >90% of identity. It's a class-ID code, not a photon measurement.`);
} else if (soloM3 > 0.30) {
  console.log(`  → ROUTER CANDIDATE: dim ${DIM} carries real coarse-class signal. Investigate whether it's photon-derived or RGB-derived.`);
} else if (soloM3 > 5 * chanceBaseline) {
  console.log(`  → GENUINE SIGNAL, WEAK: dim ${DIM} has real class information but not enough to solo-classify. Fisher weight is honest.`);
} else {
  console.log(`  → SUSPECT: solo accuracy near chance despite Fisher rank #1. High Fisher weight is artifact of tight within-class variance, not true separation.`);
}

console.log(`\n  Unique-values check: ${uniq.size} unique (of ${allVals.length} samples)`);
if (uniq.size < 200) console.log(`  → quantized code — could be pixel count / histogram bin / kmeans cluster ID. RGB-derivative likely.`);
else console.log(`  → continuous-valued — consistent with a real physical measurement, not a quantized code.`);
