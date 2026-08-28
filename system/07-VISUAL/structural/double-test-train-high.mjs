#!/usr/bin/env bun
// double-test-train-high.mjs — proper proof of the train-high test-low biological protocol.
//
// Operator rule 2026-07-11: "yes doesnt mean yes. no doesnt mean no. a double tested. proven. is a yes or a no."
//
// Sweep:
//   N_train  ∈ {1, 2, 3, 4, 5, 7, 10}
//   seed     ∈ {1..10}       (double the 5-seed prior run)
//   reject   ∈ {0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.10}
//   K        ∈ {47, 100, 200, 300, all}
// Per cell: accuracy, reject_fraction, per-lighting {sun,candle,moon,crt,neon} breakdown,
//           per-class rejection counts (which classes actually reject?), bootstrap-95 CI over seeds.
// Fisher weights computed from TRAINING pool only (no test-set leakage).

import fs from "node:fs"; import path from "node:path";

const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide";
const OUT_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results";
fs.mkdirSync(OUT_DIR, { recursive: true });

function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(pseudo(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// ---- load ----
const rawCache = new Map();
const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith("wide_"));
const lengths = new Map();
for (const f of files) try {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
  for (const c of d.classes) if (c.its) for (const it of c.its) lengths.set(it.v.length, (lengths.get(it.v.length) || 0) + 1);
} catch {}
let modeL = 286, modeCount = 0;
for (const [L, c] of lengths) if (c > modeCount) { modeCount = c; modeL = L; }
for (const f of files) try {
  const d = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8"));
  for (const c of d.classes) {
    if (!c.its) continue;
    const keptIts = c.its.filter(it => it.v.length === modeL);
    if (keptIts.length >= 2) rawCache.set(c.id, { id: c.id, its: keptIts });
  }
} catch {}
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
      return { v: nv, light: it.light };
    }),
  }));
}

function globalFisher(source) {
  const dimBetween = new Float64Array(D);
  const dimWithin = new Float64Array(D);
  const globalMean = new Float64Array(D);
  let total = 0;
  const cd = source.map(cls => {
    const cm = new Float64Array(D);
    for (const v of cls.its) for (let d = 0; d < D; d++) cm[d] += v.v[d];
    for (let d = 0; d < D; d++) cm[d] /= cls.its.length;
    return { cm, its: cls.its, n: cls.its.length };
  });
  for (const c of cd) { for (let d = 0; d < D; d++) globalMean[d] += c.cm[d] * c.n; total += c.n; }
  for (let d = 0; d < D; d++) globalMean[d] /= total;
  for (const c of cd) for (let d = 0; d < D; d++) {
    const diff = c.cm[d] - globalMean[d];
    dimBetween[d] += c.n * diff * diff;
    for (const v of c.its) { const w = v.v[d] - c.cm[d]; dimWithin[d] += w * w; }
  }
  const dimW = new Float32Array(D);
  for (let d = 0; d < D; d++) dimW[d] = dimBetween[d] / (dimWithin[d] + 1e-9);
  return dimW;
}

const LIGHTS = ["sun", "candle", "moon", "crt", "neon"];

// One (N, seed, reject) evaluation: returns per-lighting stats + per-class reject counts
function evalOne(sc, N_train, seed, rejectThreshold) {
  // Build training pool from RAW samples only per class
  const trainingSC = sc.map(cls => ({
    id: cls.id,
    its: cls.its.filter(it => it.light === "raw"),
  })).filter(cls => cls.its.length > 0);
  if (trainingSC.length === 0) return null;

  const dimW = globalFisher(trainingSC);

  // Per-seed: shuffle raw samples, take N, test on ALL non-raw
  const train = new Map();
  const test = [];
  for (const cls of sc) {
    const rawSamples = cls.its.filter(it => it.light === "raw");
    const lowSamples = cls.its.filter(it => it.light !== "raw");
    if (rawSamples.length === 0 || lowSamples.length === 0) continue;
    const shuf = seededShuffle(rawSamples, seed);
    const take = Math.min(N_train, shuf.length);
    train.set(cls.id, shuf.slice(0, take).map(x => x.v));
    for (const t of lowSamples) test.push({ id: cls.id, v: t.v, light: t.light });
  }

  let correct = 0, rejected = 0;
  const perLightCorrect = new Map(), perLightTotal = new Map(), perLightReject = new Map();
  const perClassReject = new Map(), perClassTotal = new Map();
  for (const q of test) {
    const dists = [];
    for (const [id, vecs] of train) for (const t of vecs) {
      let s = 0;
      for (let d = 0; d < D; d++) s += Math.abs(q.v[d] - t[d]) * dimW[d];
      dists.push({ id, d: s });
    }
    dists.sort((a, b) => a.d - b.d);
    let secondD = Infinity;
    for (const c of dists.slice(1)) if (c.id !== dists[0].id) { secondD = c.d; break; }
    const margin = (secondD - dists[0].d) / (secondD + 1e-9);
    perClassTotal.set(q.id, (perClassTotal.get(q.id) || 0) + 1);
    if (rejectThreshold > 0 && margin < rejectThreshold) {
      rejected++;
      perLightReject.set(q.light, (perLightReject.get(q.light) || 0) + 1);
      perClassReject.set(q.id, (perClassReject.get(q.id) || 0) + 1);
      continue;
    }
    perLightTotal.set(q.light, (perLightTotal.get(q.light) || 0) + 1);
    if (dists[0].id === q.id) {
      correct++;
      perLightCorrect.set(q.light, (perLightCorrect.get(q.light) || 0) + 1);
    }
  }
  const scored = test.length - rejected;
  return {
    testTotal: test.length,
    correct,
    rejected,
    scored,
    accuracy: scored > 0 ? correct / scored : 0,
    rejectFrac: rejected / test.length,
    perLight: Object.fromEntries(LIGHTS.map(l => [l, {
      correct: perLightCorrect.get(l) || 0,
      total: perLightTotal.get(l) || 0,
      rejected: perLightReject.get(l) || 0,
      accuracy: (perLightTotal.get(l) || 0) > 0 ? (perLightCorrect.get(l) || 0) / perLightTotal.get(l) : 0,
    }])),
    perClassReject: Object.fromEntries(Array.from(perClassReject.entries())),
    perClassTotal: Object.fromEntries(Array.from(perClassTotal.entries())),
  };
}

// Multi-seed sweep with bootstrap CI
function sweepSeeds(sc, N_train, rejectThreshold, seeds) {
  const runs = [];
  for (const seed of seeds) {
    const r = evalOne(sc, N_train, seed, rejectThreshold);
    if (r) runs.push(r);
  }
  const accs = runs.map(r => r.accuracy);
  const rjs = runs.map(r => r.rejectFrac);
  const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
  const sd = a => { const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / a.length); };
  // Bootstrap 95% CI over seeds
  const B = 500;
  const bootMeans = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < accs.length; i++) {
      s += accs[Math.floor(pseudo(b, i) * accs.length)];
    }
    bootMeans.push(s / accs.length);
  }
  bootMeans.sort((a, b) => a - b);
  const ci_lo = bootMeans[Math.floor(0.025 * B)];
  const ci_hi = bootMeans[Math.floor(0.975 * B)];

  // Aggregate per-light
  const perLightAgg = {};
  for (const l of LIGHTS) {
    const cs = runs.map(r => r.perLight[l]);
    perLightAgg[l] = {
      accuracy: mean(cs.map(x => x.accuracy)),
      total_mean: mean(cs.map(x => x.total)),
      rejected_mean: mean(cs.map(x => x.rejected)),
    };
  }

  // Class-level rejection: how many classes get rejected consistently?
  const classRejectCount = new Map();
  const classTotalCount = new Map();
  for (const r of runs) {
    for (const [id, n] of Object.entries(r.perClassReject)) classRejectCount.set(id, (classRejectCount.get(id) || 0) + n);
    for (const [id, n] of Object.entries(r.perClassTotal)) classTotalCount.set(id, (classTotalCount.get(id) || 0) + n);
  }
  const classRejectRates = [];
  for (const [id, tot] of classTotalCount.entries()) {
    const rj = classRejectCount.get(id) || 0;
    classRejectRates.push({ id, rate: tot > 0 ? rj / tot : 0, total: tot });
  }
  classRejectRates.sort((a, b) => b.rate - a.rate);

  return {
    N: N_train,
    reject: rejectThreshold,
    seeds: seeds.length,
    accuracy_mean: mean(accs),
    accuracy_sd: sd(accs),
    accuracy_ci95: [ci_lo, ci_hi],
    reject_frac_mean: mean(rjs),
    reject_frac_sd: sd(rjs),
    perLight: perLightAgg,
    top20_reject_classes: classRejectRates.slice(0, 20),
    bottom20_reject_classes: classRejectRates.filter(x => x.rate === 0).slice(0, 20),
    always_rejected_count: classRejectRates.filter(x => x.rate >= 0.9).length,
    never_rejected_count: classRejectRates.filter(x => x.rate === 0).length,
  };
}

const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const Ks = [47, 100, 200, 300, rawCache.size];
const Ns = [1, 2, 3, 4, 5, 7, 10];
const RJs = [0, 0.005, 0.01, 0.02, 0.03, 0.05, 0.075, 0.10];

const grid = [];
const t0 = performance.now();
for (const K of Ks) {
  console.log(`\n══ K=${K} ══`);
  const sc = stdCache(K);
  for (const N of Ns) {
    for (const rj of RJs) {
      const res = sweepSeeds(sc, N, rj, seeds);
      grid.push({ K, ...res });
      const ci = res.accuracy_ci95;
      console.log(`  K=${String(K).padStart(3)} N=${String(N).padStart(2)} reject<${String(rj).padStart(5)}: acc=${(100*res.accuracy_mean).toFixed(1)}%±${(100*res.accuracy_sd).toFixed(1)} CI95[${(100*ci[0]).toFixed(1)},${(100*ci[1]).toFixed(1)}] rj=${(100*res.reject_frac_mean).toFixed(1)}%  neon=${(100*res.perLight.neon.accuracy).toFixed(1)} crt=${(100*res.perLight.crt.accuracy).toFixed(1)} sun=${(100*res.perLight.sun.accuracy).toFixed(1)} candle=${(100*res.perLight.candle.accuracy).toFixed(1)} moon=${(100*res.perLight.moon.accuracy).toFixed(1)}  always-rej=${res.always_rejected_count} never-rej=${res.never_rejected_count}`);
    }
  }
}

const outFile = path.join(OUT_DIR, "double_test_train_high.json");
fs.writeFileSync(outFile, JSON.stringify({
  D, classes: rawCache.size,
  seeds, Ks, Ns, RJs,
  grid,
  timestamp: "2026-07-11",
  duration_s: (performance.now() - t0) / 1000,
}, null, 2));

console.log(`\nwrote ${outFile}  duration=${((performance.now() - t0) / 1000).toFixed(0)}s`);

// Verdict block — the yes/no proof under charter §7 discipline
console.log("\n══ VERDICT ══");
// Find best (accuracy_ci95_lower, reject_frac) tradeoff at each K
for (const K of Ks) {
  const cells = grid.filter(g => g.K === K);
  const noReject = cells.filter(g => g.reject === 0);
  const bestNoReject = noReject.sort((a, b) => b.accuracy_ci95[0] - a.accuracy_ci95[0])[0];
  const above95CI = cells.filter(g => g.accuracy_ci95[0] >= 0.95);
  const bestAbove95 = above95CI.sort((a, b) => a.reject_frac_mean - b.reject_frac_mean)[0];
  console.log(`  K=${K}:`);
  console.log(`    no-reject   best: N=${bestNoReject.N} acc=${(100*bestNoReject.accuracy_mean).toFixed(1)}% CI95=[${(100*bestNoReject.accuracy_ci95[0]).toFixed(1)},${(100*bestNoReject.accuracy_ci95[1]).toFixed(1)}]`);
  console.log(`    ≥95%CI-lo   best: ${bestAbove95 ? `N=${bestAbove95.N} reject<${bestAbove95.reject} acc=${(100*bestAbove95.accuracy_mean).toFixed(1)}% rejfrac=${(100*bestAbove95.reject_frac_mean).toFixed(1)}%` : "NO CELL passes 95% CI lower bound"}`);
}
