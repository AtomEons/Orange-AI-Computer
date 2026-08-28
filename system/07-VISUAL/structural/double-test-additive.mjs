#!/usr/bin/env bun
// double-test-additive.mjs — Edison/Tesla W+n additive tests on train-high test-low.
//
// W = baseline (double-test-train-high running in parallel)
// W+1a = same but dim 236 EXCLUDED (uses today's leak proof, receipt seq 102)
// W+1b = same but restrict distance to top-K Fisher dims (K=10, 30, 80, 160), dim 236 excluded
// W+1c = flatten fix inline: NOT tested here (needs re-capture); staged for later
//
// If any W+1 beats baseline at same accuracy_ci95_lower with lower reject_frac, it stacks.
// Never regress winner. If none beats W, W stays winner.

import fs from "node:fs"; import path from "node:path";

const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide";
const OUT_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results";
fs.mkdirSync(OUT_DIR, { recursive: true });

const LEAK_DIM = 236;  // proved as mirage today, receipt seq 102

function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(pseudo(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

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

// Evaluate one variant at (N, reject, seed) — returns accuracy + reject_frac
function evalVariant(sc, N_train, seed, rejectThreshold, dimMask) {
  const trainingSC = sc.map(cls => ({
    id: cls.id,
    its: cls.its.filter(it => it.light === "raw"),
  })).filter(cls => cls.its.length > 0);
  const dimW = globalFisher(trainingSC);
  // zero out masked dims
  for (let d = 0; d < D; d++) if (!dimMask[d]) dimW[d] = 0;

  const train = new Map();
  const test = [];
  for (const cls of sc) {
    const rawSamples = cls.its.filter(it => it.light === "raw");
    const lowSamples = cls.its.filter(it => it.light !== "raw");
    if (rawSamples.length === 0 || lowSamples.length === 0) continue;
    const shuf = seededShuffle(rawSamples, seed);
    train.set(cls.id, shuf.slice(0, Math.min(N_train, shuf.length)).map(x => x.v));
    for (const t of lowSamples) test.push({ id: cls.id, v: t.v, light: t.light });
  }
  let correct = 0, rejected = 0;
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
    if (rejectThreshold > 0 && margin < rejectThreshold) { rejected++; continue; }
    if (dists[0].id === q.id) correct++;
  }
  const scored = test.length - rejected;
  return {
    accuracy: scored > 0 ? correct / scored : 0,
    rejectFrac: rejected / test.length,
    scored,
    correct,
    rejected,
  };
}

function bootstrapCI(vals, seed0 = 999, B = 300) {
  const boots = [];
  for (let b = 0; b < B; b++) {
    let s = 0;
    for (let i = 0; i < vals.length; i++) s += vals[Math.floor(pseudo(seed0 + b, i) * vals.length)];
    boots.push(s / vals.length);
  }
  boots.sort((a, b) => a - b);
  return [boots[Math.floor(0.025 * B)], boots[Math.floor(0.975 * B)]];
}

function mean(a) { return a.reduce((s, v) => s + v, 0) / a.length; }
function sd(a) { const m = mean(a); return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / a.length); }

const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
const Ns = [1, 3, 5];
const RJs = [0, 0.02, 0.05, 0.10];
const Ks = [47, 100, 300, rawCache.size];

// Precompute Fisher ranking on FULL cache (needed for top-K mask)
const scAll = stdCache(rawCache.size);
const dimWFull = globalFisher(scAll.map(cls => ({ id: cls.id, its: cls.its.filter(it => it.light === "raw") })));
dimWFull[LEAK_DIM] = 0;  // exclude leak dim
const dimRankByFisher = Array.from({ length: D }, (_, d) => d).sort((a, b) => dimWFull[b] - dimWFull[a]);

// Masks
const maskAllNoLeak = new Uint8Array(D); maskAllNoLeak.fill(1); maskAllNoLeak[LEAK_DIM] = 0;
const maskAllRaw    = new Uint8Array(D); maskAllRaw.fill(1);
const topKMask = k => {
  const m = new Uint8Array(D);
  for (let i = 0; i < k; i++) m[dimRankByFisher[i]] = 1;
  return m;
};

const variants = {
  W:       { name: "baseline (with dim 236)",  mask: maskAllRaw },
  Wp1a:    { name: "W+1a: dim 236 EXCLUDED",   mask: maskAllNoLeak },
  Wp1b160: { name: "W+1b: top-160 Fisher",     mask: topKMask(160) },
  Wp1b80:  { name: "W+1b: top-80 Fisher",      mask: topKMask(80) },
  Wp1b30:  { name: "W+1b: top-30 Fisher",      mask: topKMask(30) },
};

const grid = [];
const t0 = performance.now();

for (const K of Ks) {
  const sc = stdCache(K);
  console.log(`\n══ K=${K} ══`);
  for (const [vkey, v] of Object.entries(variants)) {
    for (const N of Ns) {
      for (const rj of RJs) {
        const accs = [];
        const rjs = [];
        for (const seed of seeds) {
          const r = evalVariant(sc, N, seed, rj, v.mask);
          accs.push(r.accuracy);
          rjs.push(r.rejectFrac);
        }
        const accMean = mean(accs);
        const accSd = sd(accs);
        const accCI = bootstrapCI(accs);
        const rjMean = mean(rjs);
        grid.push({ K, variant: vkey, name: v.name, N, reject: rj, accuracy_mean: accMean, accuracy_sd: accSd, accuracy_ci95: accCI, reject_frac_mean: rjMean });
        console.log(`  K=${String(K).padStart(3)} ${vkey.padEnd(8)} N=${N} rj=${rj.toFixed(3)}: acc=${(100*accMean).toFixed(1)}%±${(100*accSd).toFixed(1)} CI95[${(100*accCI[0]).toFixed(1)},${(100*accCI[1]).toFixed(1)}] rjfrac=${(100*rjMean).toFixed(1)}%`);
      }
    }
  }
}

const outFile = path.join(OUT_DIR, "additive_wp1_dim236_excluded.json");
fs.writeFileSync(outFile, JSON.stringify({
  D, classes: rawCache.size,
  seeds, Ns, RJs, Ks,
  variants: Object.fromEntries(Object.entries(variants).map(([k, v]) => [k, v.name])),
  dim_leak_excluded: LEAK_DIM,
  fisher_top_10: dimRankByFisher.slice(0, 10),
  fisher_top_30: dimRankByFisher.slice(0, 30),
  grid,
  duration_s: (performance.now() - t0) / 1000,
}, null, 2));

console.log(`\nwrote ${outFile}  duration=${((performance.now() - t0) / 1000).toFixed(0)}s`);

// ---- W+n verdict per K: does any variant BEAT baseline at same reject? ----
console.log("\n══ W+n VERDICT (Edison/Tesla: never regress winner) ══");
for (const K of Ks) {
  console.log(`\n  K=${K}:`);
  for (const N of Ns) {
    for (const rj of RJs) {
      const cells = grid.filter(g => g.K === K && g.N === N && g.reject === rj);
      const base = cells.find(c => c.variant === "W");
      const winners = cells.filter(c => c.variant !== "W" && c.accuracy_mean > base.accuracy_mean + 0.005);
      if (winners.length > 0) {
        const best = winners.sort((a, b) => b.accuracy_mean - a.accuracy_mean)[0];
        const delta = 100 * (best.accuracy_mean - base.accuracy_mean);
        console.log(`    N=${N} rj=${rj.toFixed(3)}: ${best.variant.padEnd(8)} beats W by ${delta.toFixed(1)}pp (${(100*base.accuracy_mean).toFixed(1)}% → ${(100*best.accuracy_mean).toFixed(1)}%)`);
      }
    }
  }
}
