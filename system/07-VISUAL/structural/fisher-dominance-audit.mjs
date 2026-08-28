#!/usr/bin/env bun
// fisher-dominance-audit.mjs — top-K Fisher dim + saturation + bundle attribution on wide-IT cache.
// Read-only. Written from L6 review lane 2026-07-11.
//
// Verdict expected (from L6): dim 236 (rawMax=128 hard ceiling) alone carries 44% of total Fisher energy.
// axis-bundle[156] under the AXIS_ORDER walk → first scalar of spatial_frequency axis.
// Either alpha router or class-leaking bounded code — needs 1-D solo-classifier test.

import fs from "node:fs"; import path from "node:path";

const CACHE_DIR = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache-wide";

// Map dim index -> bundle name using build-wide-it.mjs order:
// [0..79]=IT-80, [80..241]=axis-bundle (162 scalars in AXIS_ORDER),
// [242..253]=retinal-12, [254..266]=LGN sub, [267..285]=shape+spectral moments
function bundleOf(d) {
  if (d < 80) return `IT-80[${d}]`;
  if (d < 242) return `axis-bundle[${d - 80}]`;
  if (d < 254) return `retinal-12[${d - 242}]`;
  if (d < 267) return `LGN[${d - 254}]`;
  return `shape+spectral[${d - 267}]`;
}

// ---- load modal-length wide-IT ----
const files = fs.readdirSync(CACHE_DIR).filter(f => f.startsWith("wide_"));
const lens = new Map();
for (const f of files) try {
  for (const c of JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8")).classes)
    if (c.its) for (const it of c.its) lens.set(it.v.length, (lens.get(it.v.length) || 0) + 1);
} catch {}
let modeL = 286, mc = 0;
for (const [L, c] of lens) if (c > mc) { mc = c; modeL = L; }
const raw = new Map();
for (const f of files) try {
  for (const c of JSON.parse(fs.readFileSync(path.join(CACHE_DIR, f), "utf8")).classes) {
    if (!c.its) continue;
    const k = c.its.filter(x => x.v.length === modeL);
    if (k.length >= 2) raw.set(c.id, { id: c.id, its: k });
  }
} catch {}
console.log(`loaded ${raw.size} classes at D=${modeL}`);

const D = modeL;

// ---- RAW-space stats before sanitize/standardize ----
const rawStats = { mean: new Float64Array(D), std: new Float64Array(D), max: new Float64Array(D) };
let M = 0;
for (const c of raw.values()) for (const it of c.its) {
  M++;
  for (let d = 0; d < D; d++) {
    const x = Number.isFinite(it.v[d]) ? it.v[d] : 0;
    rawStats.mean[d] += x;
    if (Math.abs(x) > rawStats.max[d]) rawStats.max[d] = Math.abs(x);
  }
}
for (let d = 0; d < D; d++) rawStats.mean[d] /= M;
for (const c of raw.values()) for (const it of c.its)
  for (let d = 0; d < D; d++) {
    const x = Number.isFinite(it.v[d]) ? it.v[d] : 0;
    rawStats.std[d] += (x - rawStats.mean[d]) ** 2;
  }
for (let d = 0; d < D; d++) rawStats.std[d] = Math.sqrt(rawStats.std[d] / M);

// ---- sanitize (sign * log1p) + global z-score ----
function sanitize(v) {
  const o = new Float32Array(v.length);
  for (let d = 0; d < v.length; d++) {
    const x = v[d];
    o[d] = Number.isFinite(x) ? Math.sign(x) * Math.log1p(Math.abs(x)) : 0;
  }
  return o;
}
const all = [];
for (const c of raw.values()) for (const it of c.its) all.push(sanitize(it.v));
const gMean = new Float32Array(D), gStd = new Float32Array(D);
for (let d = 0; d < D; d++) {
  let m = 0; for (const v of all) m += v[d]; m /= M;
  let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
  gMean[d] = m; gStd[d] = Math.sqrt(s2 / M) || 1;
}
const classes = [];
let ix = 0;
for (const c of raw.values()) {
  const its = [];
  for (let k = 0; k < c.its.length; k++) {
    const nv = new Float32Array(D);
    for (let d = 0; d < D; d++) nv[d] = (all[ix][d] - gMean[d]) / gStd[d];
    its.push(nv);
    ix++;
  }
  classes.push({ id: c.id, its });
}

// ---- Fisher per dim (between / within) ----
const bw = new Float64Array(D), wi = new Float64Array(D), Gm = new Float64Array(D);
let T = 0;
const cd = classes.map(c => {
  const cm = new Float64Array(D);
  for (const v of c.its) for (let d = 0; d < D; d++) cm[d] += v[d];
  for (let d = 0; d < D; d++) cm[d] /= c.its.length;
  return { cm, its: c.its, n: c.its.length };
});
for (const c of cd) { for (let d = 0; d < D; d++) Gm[d] += c.cm[d] * c.n; T += c.n; }
for (let d = 0; d < D; d++) Gm[d] /= T;
for (const c of cd) for (let d = 0; d < D; d++) {
  const df = c.cm[d] - Gm[d];
  bw[d] += c.n * df * df;
  for (const v of c.its) { const w = v[d] - c.cm[d]; wi[d] += w * w; }
}
const fisher = new Float32Array(D);
for (let d = 0; d < D; d++) fisher[d] = bw[d] / (wi[d] + 1e-9);
const total = fisher.reduce((a, b) => a + b, 0);

// ---- TOP 30 ----
const ranked = Array.from({ length: D }, (_, d) => d).sort((a, b) => fisher[b] - fisher[a]);
console.log("\n== TOP 30 DIMS BY FISHER ==");
for (let r = 0; r < 30; r++) {
  const d = ranked[r];
  console.log(`  rank ${String(r + 1).padStart(2)}: dim=${String(d).padStart(3)} fisher=${fisher[d].toFixed(4).padStart(9)} rawMean=${rawStats.mean[d].toExponential(2)} rawStd=${rawStats.std[d].toExponential(2)} rawMax=${rawStats.max[d].toExponential(2)} bundle=${bundleOf(d)}`);
}

// ---- Cumulative energy ----
console.log("\n== CUMULATIVE FISHER ENERGY ==");
for (const K of [10, 30, 80, 160]) {
  let cum = 0; for (let r = 0; r < K; r++) cum += fisher[ranked[r]];
  console.log(`  Top ${K} / ${D}: ${(100 * cum / total).toFixed(1)}%`);
}
console.log(`  Total Fisher = ${total.toFixed(2)}   mean per-dim = ${(total / D).toFixed(3)}`);

// ---- Bundle rollup ----
const bundleRange = [
  ["IT-80", 0, 80], ["axis-bundle", 80, 242], ["retinal-12", 242, 254],
  ["LGN", 254, 267], ["shape+spectral", 267, D],
];
console.log("\n== FISHER BY BUNDLE ==");
for (const [name, a, b] of bundleRange) {
  let s = 0; for (let d = a; d < b; d++) s += fisher[d];
  const n = b - a;
  console.log(`  ${name.padEnd(14)} (${String(n).padStart(3)} dims): ${(100 * s / total).toFixed(1)}% total   per-dim avg ${(s / n).toFixed(3)}`);
}

// ---- Top-30 composition ----
const comp = { "IT-80": 0, "axis-bundle": 0, "retinal-12": 0, "LGN": 0, "shape+spectral": 0 };
for (let r = 0; r < 30; r++) {
  const d = ranked[r];
  for (const [name, a, b] of bundleRange) if (d >= a && d < b) { comp[name]++; break; }
}
console.log("\n== TOP-30 COMPOSITION ==");
console.log(`  ` + Object.entries(comp).map(([k, v]) => `${k}: ${v}`).join("   "));

// ---- Saturation risk ----
console.log("\n== SATURATION-RISK DIMS (rawMax>100 OR rawStd>10) ==");
const sat = [];
for (let d = 0; d < D; d++) if (rawStats.max[d] > 100 || rawStats.std[d] > 10) sat.push(d);
for (const d of sat.slice(0, 20)) {
  console.log(`  dim=${String(d).padStart(3)} mean=${rawStats.mean[d].toExponential(2)}  std=${rawStats.std[d].toExponential(2)}  max=${rawStats.max[d].toExponential(2)}   fisher=${fisher[d].toFixed(2)}  ${bundleOf(d)}`);
}
console.log(`  (total: ${sat.length} dims)`);

// ---- Dead-dim check ----
let dead1 = 0, dead2 = 0;
for (let d = 0; d < D; d++) { if (fisher[d] < 0.001) dead1++; if (fisher[d] < 0.01) dead2++; }
console.log(`\n== DEAD-DIM CHECK ==`);
console.log(`  fisher<0.001: ${dead1} dims    fisher<0.01: ${dead2} dims`);

// ---- Percentiles ----
const fSort = Array.from(fisher).sort((a, b) => a - b);
const pct = p => fSort[Math.min(D - 1, Math.max(0, Math.floor(p * D)))];
console.log("\n== FISHER PERCENTILES ==");
console.log(`  p10=${pct(0.10).toFixed(3)}  p25=${pct(0.25).toFixed(3)}  p50=${pct(0.50).toFixed(3)}  p75=${pct(0.75).toFixed(3)}  p90=${pct(0.90).toFixed(3)}  p95=${pct(0.95).toFixed(3)}  p99=${pct(0.99).toFixed(3)}  p100=${pct(1.00).toFixed(2)}`);
