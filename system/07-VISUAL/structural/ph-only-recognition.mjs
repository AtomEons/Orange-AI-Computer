#!/usr/bin/env bun
// ph-only-recognition.mjs — recognition using ONLY persistent_homology axis (6 dims).
// This is the natural test after Phase A named persistent_homology as sole survivor.
//
// If PH-only beats baseline wide-IT (~78% raw / 95.9% rejection-gated),
// the current architecture is losing signal by mixing Phase-A-failing axes with the one working axis.
//
// Dims [172..177] of the 286-D wide-IT per build-wide-it.mjs AXIS_ORDER walk:
//   IT-80: [0..79]
//   radial_photon (33): [80..112]
//   photon_histogram (30): [113..142]
//   photon_correlation (6): [143..148]
//   subsurface (4): [149..152]
//   spatial_color (0 — dropped by flatten)
//   color_ratio (9): [153..161]
//   texture_vocab (8): [162..169]
//   hu_moments (2): [170..171]
//   persistent_homology (6): [172..177]   ← THE SOLE PHASE A SURVIVOR
//   dichromatic (14): [178..191]
//   fourier_mellin (37): [192..228]
//   texture (2): [229..230]
//   edge (2): [231..232]
//   specular (3): [233..235]
//   spatial_frequency (6): [236..241]     ← THE MIRAGE AXIS

import fs from "node:fs"; import path from "node:path";

const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide";
const OUT_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results";
fs.mkdirSync(OUT_DIR, { recursive: true });

const PH_START = 172, PH_END = 178;   // 6 dims

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

const D = 6;   // ONLY persistent_homology

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
  for (const cls of classes) for (const it of cls.its) {
    const s = sanitize(it.v);
    const ph = new Float32Array(D);
    for (let d = 0; d < D; d++) ph[d] = s[PH_START + d];
    all.push(ph);
  }
  const mean = new Float32Array(D), std = new Float32Array(D);
  const M = all.length;
  for (let d = 0; d < D; d++) {
    let m = 0; for (const v of all) m += v[d]; m /= M;
    let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
    mean[d] = m; std[d] = Math.sqrt(s2 / M) || 1;
  }
  let ix = 0;
  return classes.map(cls => ({
    id: cls.id,
    its: cls.its.map(it => {
      const nv = new Float32Array(D);
      for (let d = 0; d < D; d++) nv[d] = (all[ix][d] - mean[d]) / std[d];
      ix++;
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

function scorePH(sc, N_train, seed, rejectThreshold, mode = "train-high-test-low") {
  const dimW = globalFisher(sc);

  const train = new Map();
  const test = [];
  for (const cls of sc) {
    if (mode === "train-high-test-low") {
      const rawSamples = cls.its.filter(it => it.light === "raw");
      const lowSamples = cls.its.filter(it => it.light !== "raw");
      if (rawSamples.length === 0 || lowSamples.length === 0) continue;
      const shuf = seededShuffle(rawSamples, seed);
      train.set(cls.id, shuf.slice(0, Math.min(N_train, shuf.length)).map(x => x.v));
      for (const t of lowSamples) test.push({ id: cls.id, v: t.v, light: t.light });
    } else {  // random split
      const shuf = seededShuffle(cls.its, seed);
      train.set(cls.id, shuf.slice(0, N_train).map(x => x.v));
      for (let j = N_train; j < shuf.length; j++) test.push({ id: cls.id, v: shuf[j].v, light: shuf[j].light });
    }
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
    scored, correct, rejected,
  };
}

const seeds = [1, 2, 3, 4, 5];
const Ks = [47, 100, 300, rawCache.size];
const Ns = [1, 3, 5];
const RJs = [0, 0.05, 0.10];

console.log("\n══ PH-ONLY (6 dims, persistent_homology axis) — TRAIN-HIGH TEST-LOW ══");
const results = [];
for (const K of Ks) {
  const sc = stdCache(K);
  console.log(`\n  K=${K}:`);
  for (const N of Ns) {
    for (const rj of RJs) {
      const accs = [], rjs = [];
      for (const seed of seeds) {
        const r = scorePH(sc, N, seed, rj, "train-high-test-low");
        accs.push(r.accuracy); rjs.push(r.rejectFrac);
      }
      const accM = accs.reduce((a, b) => a + b, 0) / accs.length;
      const accS = Math.sqrt(accs.reduce((s, v) => s + (v - accM) ** 2, 0) / accs.length);
      const rjM = rjs.reduce((a, b) => a + b, 0) / rjs.length;
      results.push({ mode: "train-high-test-low", K, N, reject: rj, accuracy_mean: accM, accuracy_sd: accS, reject_frac_mean: rjM });
      console.log(`    N=${N} rj=${rj.toFixed(2)}: acc=${(100*accM).toFixed(1)}%±${(100*accS).toFixed(1)} rjfrac=${(100*rjM).toFixed(1)}%`);
    }
  }
}

console.log("\n══ PH-ONLY (6 dims, persistent_homology axis) — RANDOM SPLIT ══");
for (const K of Ks) {
  const sc = stdCache(K);
  console.log(`\n  K=${K}:`);
  for (const N of Ns) {
    for (const rj of RJs) {
      const accs = [], rjs = [];
      for (const seed of seeds) {
        const r = scorePH(sc, N, seed, rj, "random");
        accs.push(r.accuracy); rjs.push(r.rejectFrac);
      }
      const accM = accs.reduce((a, b) => a + b, 0) / accs.length;
      const accS = Math.sqrt(accs.reduce((s, v) => s + (v - accM) ** 2, 0) / accs.length);
      const rjM = rjs.reduce((a, b) => a + b, 0) / rjs.length;
      results.push({ mode: "random", K, N, reject: rj, accuracy_mean: accM, accuracy_sd: accS, reject_frac_mean: rjM });
      console.log(`    N=${N} rj=${rj.toFixed(2)}: acc=${(100*accM).toFixed(1)}%±${(100*accS).toFixed(1)} rjfrac=${(100*rjM).toFixed(1)}%`);
    }
  }
}

fs.writeFileSync(path.join(OUT_DIR, "ph_only_recognition.json"), JSON.stringify({
  date: "2026-07-11",
  dims_used: `[${PH_START}..${PH_END - 1}] persistent_homology (6 dims)`,
  results,
}, null, 2));

console.log("\n══ VERDICT ══");
console.log("Baseline reference: random-split L1-Fisher 1-NN on full 286-D wide-IT: 78% raw / 95.9% rj<0.10");
console.log("If PH-only random-split matches or exceeds this, current architecture is losing signal by mixing failing axes.");
