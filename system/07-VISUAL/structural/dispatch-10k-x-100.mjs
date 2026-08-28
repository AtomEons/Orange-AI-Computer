#!/usr/bin/env bun
// dispatch-10k-x-100.mjs — statistical proof, answering 5 questions.
//
// GOVERNED BY: 00-CHARTER/AWE_3_GOVERNING_STATE_2026-07-09.md (Orange5 spine seq 93)
//
// The 5 questions this dispatch must answer:
//   1. Statistical Magic N (with strict pre-execution definition)
//   2. NEON/CRT cross-illuminant identity matrix
//   3. Collision behavior at 10K (intra/inter margins, open-set)
//   4. Storage truth (full recognition substrate, not just vector payload)
//   5. Scaling law curve (47 → 10,000 classes)
//
// TERMINOLOGY: reports "412 derived measurements", "~221 encoded bits of
// representational capacity" — NOT "29× more information".
//
// STANDALONE — pure Bun, no workflow. Runs on AI computer:
//   bun C:/AtomEons/Orange5/07-VISUAL/structural/dispatch-10k-x-100.mjs
//
// Parallel workers via PROC_RANK / PROC_WORKERS env vars.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton, CANON_W, CANON_H } from "./photon-canonical.mjs";

// ============ CONFIG ============
const CONFIG = {
  TARGET_CLASSES: 10000,
  SAMPLES_PER_CLASS: 100,
  CAPTURE_MAXSIZE: 96,
  CACHE_DIR: "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache",
  RESULT_DIR: "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results",

  // Magic-N pre-execution definition (charter §4.1)
  MAGIC_N_THRESHOLD: 0.95,       // aggregate accuracy floor (95%-CI lower bound)
  NEON_FAIL_CEILING: 0.05,       // max NEON failure rate allowed at magic N
  CRT_FAIL_CEILING:  0.05,       // max CRT failure rate allowed at magic N
  OPEN_SET_MARGIN:   0.02,       // reject-as-unknown if margin < this

  BOOTSTRAP_SEEDS:   500,
  N_SWEEP:           [1,2,3,4,5,6,7,8,9,10,11,13,15,17,20,25,30,40,50,75,100],
  SCALING_STEPS:     [47, 100, 250, 500, 1000, 2500, 5000, 10000],

  CORPUS_ROOTS: [
    "C:/AtomEons/Orange5/07-VISUAL/fixtures",
    // Add on AI machine:
    // "D:/datasets/imagenet21k",
    // "D:/datasets/laion400m/images",
  ],
};

fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });
fs.mkdirSync(CONFIG.RESULT_DIR, { recursive: true });

// ============ CORPUS DISCOVERY ============
function walkImages(root, out = []) {
  if (!fs.existsSync(root)) return out;
  const entries = fs.readdirSync(root, { withFileTypes: true });
  for (const e of entries) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkImages(p, out);
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
  }
  return out;
}

const t0 = performance.now();
const t = () => ((performance.now() - t0) / 1000).toFixed(0);

console.log(`[${t()}s] ═══ 10K × 100 STATISTICAL PROOF (5-question output) ═══`);
console.log(`[${t()}s] governed by: 00-CHARTER/AWE_3_GOVERNING_STATE_2026-07-09.md`);
let allImages = [];
for (const root of CONFIG.CORPUS_ROOTS) {
  const found = walkImages(root);
  console.log(`[${t()}s] discovered ${found.length} images under ${root}`);
  allImages = allImages.concat(found);
}
if (allImages.length === 0) { console.log("ERROR: no images"); process.exit(1); }

const classes = [];
for (let i = 0; i < CONFIG.TARGET_CLASSES; i++) {
  const src = allImages[i % allImages.length];
  const cycle = Math.floor(i / allImages.length);
  classes.push({ id: `cls_${i}`, source: src, seed_offset: cycle * 10007, replica: cycle });
}
console.log(`[${t()}s] ${classes.length} classes prepared`);

// ============ AUGMENTATION GRID (guarantees NEON + CRT presence) ============
const LIGHTINGS = ["raw","sun","candle","moon","crt","neon"];
const ROTATIONS = [0,45,90,135,180,225,270,315];
const SCALES = [1.0,0.85,0.70,1.25];
const CROPS = ["full","center70","top","bottom"];
const BRIGHTS = [1.0,0.85,1.15];
const CONTRASTS = [1.0,0.85,1.15];

function augmentationsForClass(seed) {
  const list = [];
  const rng = (i) => { const x = Math.sin(seed + i * 12345.6789) * 233280; return x - Math.floor(x); };
  // Locked slots: every class gets each lighting isolated
  for (const l of LIGHTINGS) list.push({ lighting: l, rotation: 0, scale: 1.0, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const r of ROTATIONS) list.push({ lighting: "raw", rotation: r, scale: 1.0, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const s of SCALES) list.push({ lighting: "raw", rotation: 0, scale: s, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const c of CROPS) list.push({ lighting: "raw", rotation: 0, scale: 1.0, crop: c, bright: 1.0, contrast: 1.0 });
  for (const b of BRIGHTS) list.push({ lighting: "raw", rotation: 0, scale: 1.0, crop: "full", bright: b, contrast: 1.0 });
  for (const c of CONTRASTS) list.push({ lighting: "raw", rotation: 0, scale: 1.0, crop: "full", bright: 1.0, contrast: c });
  // ALSO explicit cross-illuminant slots for cross-lighting matrix (NEON+CRT with pose/scale/crop)
  const CROSS_ILLUM = ["neon","crt"];
  for (const l of CROSS_ILLUM) for (const r of [45,90,135]) list.push({ lighting: l, rotation: r, scale: 1.0, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const l of CROSS_ILLUM) for (const s of [0.85,1.25]) list.push({ lighting: l, rotation: 0, scale: s, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const l of CROSS_ILLUM) for (const c of ["center70","top"]) list.push({ lighting: l, rotation: 0, scale: 1.0, crop: c, bright: 1.0, contrast: 1.0 });
  // Fill remaining
  const need = CONFIG.SAMPLES_PER_CLASS - list.length;
  for (let i = 0; i < need; i++) {
    list.push({
      lighting: LIGHTINGS[Math.floor(rng(i*7+1) * LIGHTINGS.length)],
      rotation: ROTATIONS[Math.floor(rng(i*7+2) * ROTATIONS.length)],
      scale: SCALES[Math.floor(rng(i*7+3) * SCALES.length)],
      crop: CROPS[Math.floor(rng(i*7+4) * CROPS.length)],
      bright: BRIGHTS[Math.floor(rng(i*7+5) * BRIGHTS.length)],
      contrast: CONTRASTS[Math.floor(rng(i*7+6) * CONTRASTS.length)],
    });
  }
  return list.slice(0, CONFIG.SAMPLES_PER_CLASS);
}

function applyAug(rgb, aug) {
  const W = rgb.width, H = rgb.height;
  const R = new Float32Array(rgb.R), G = new Float32Array(rgb.G), B = new Float32Array(rgb.B);
  // Crop
  let x0 = 0, y0 = 0, cw = W, ch = H;
  if (aug.crop === "center70") { cw = Math.floor(W*0.7); ch = Math.floor(H*0.7); x0 = Math.floor((W-cw)/2); y0 = Math.floor((H-ch)/2); }
  else if (aug.crop === "top") { ch = Math.floor(H/2); }
  else if (aug.crop === "bottom") { y0 = Math.floor(H/2); ch = H - y0; }
  const cN = cw * ch;
  const cR = new Float32Array(cN), cG = new Float32Array(cN), cB = new Float32Array(cN);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = (y+y0)*W + (x+x0), d = y*cw + x;
    cR[d] = R[s]; cG[d] = G[s]; cB[d] = B[s];
  }
  // Rotate
  let rW = cw, rH = ch, rR = cR, rG = cG, rB = cB;
  if (aug.rotation !== 0) {
    const th = -aug.rotation * Math.PI / 180, cT = Math.cos(th), sT = Math.sin(th), cx = cw/2, cy = ch/2;
    rR = new Float32Array(cN); rG = new Float32Array(cN); rB = new Float32Array(cN);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = Math.round(cT*(x-cx) - sT*(y-cy) + cx);
      const sy = Math.round(sT*(x-cx) + cT*(y-cy) + cy);
      if (sx >= 0 && sx < cw && sy >= 0 && sy < ch) {
        const src = sy*cw + sx, dst = y*cw + x;
        rR[dst] = cR[src]; rG[dst] = cG[src]; rB[dst] = cB[src];
      }
    }
  }
  // Scale
  let sW = rW, sH = rH, sR = rR, sG = rG, sB = rB;
  if (aug.scale !== 1.0) {
    sW = Math.max(16, Math.floor(rW * aug.scale)); sH = Math.max(16, Math.floor(rH * aug.scale));
    const sN = sW * sH;
    sR = new Float32Array(sN); sG = new Float32Array(sN); sB = new Float32Array(sN);
    for (let y = 0; y < sH; y++) for (let x = 0; x < sW; x++) {
      const px = Math.min(rW-1, Math.floor(x/aug.scale)), py = Math.min(rH-1, Math.floor(y/aug.scale));
      const d = y*sW + x, s = py*rW + px;
      sR[d] = rR[s]; sG[d] = rG[s]; sB[d] = rB[s];
    }
  }
  // Lighting + brightness + contrast
  const bN = sW * sH;
  for (let i = 0; i < bN; i++) {
    let r = sR[i], g = sG[i], b = sB[i];
    switch (aug.lighting) {
      case "sun":    r *= 1.15; g *= 1.08; b *= 0.88; break;
      case "candle": r *= 1.35*0.72; g *= 0.82*0.72; b *= 0.35*0.72; break;
      case "moon":   r *= 0.28; g *= 0.38; b *= 0.72; break;
      case "crt":    r *= 0.28; g *= 1.12; b *= 0.28; break;
      case "neon":   { const a = (r+g+b)/3; r = a + (r-a)*2.6; g = a + (g-a)*2.6; b = a + (b-a)*2.6; r *= 1.25; b *= 1.25; g *= 0.65; break; }
    }
    r *= aug.bright; g *= aug.bright; b *= aug.bright;
    r = (r-128)*aug.contrast + 128; g = (g-128)*aug.contrast + 128; b = (b-128)*aug.contrast + 128;
    sR[i] = Math.min(255, Math.max(0, r)); sG[i] = Math.min(255, Math.max(0, g)); sB[i] = Math.min(255, Math.max(0, b));
  }
  return { R: sR, G: sG, B: sB, width: sW, height: sH, W: sW, H: sH };
}

// ============ CAPTURE (chunked, resumable) ============
function shardPath(i) { return path.join(CONFIG.CACHE_DIR, `shard_${String(i).padStart(5, "0")}.json`); }
const SHARD_SIZE = 10;

async function processShard(idx) {
  const p = shardPath(idx);
  if (fs.existsSync(p)) {
    try { const d = JSON.parse(fs.readFileSync(p, "utf8")); if (d.classes && d.classes.length) return d; } catch {}
  }
  const start = idx * SHARD_SIZE, end = Math.min(start + SHARD_SIZE, classes.length);
  const shard = { shard_idx: idx, classes: [] };
  for (let ci = start; ci < end; ci++) {
    const cls = classes[ci];
    let rgb;
    try { rgb = await extractImageRGB(cls.source, { maxSize: CONFIG.CAPTURE_MAXSIZE }); } catch { continue; }
    const augs = augmentationsForClass(cls.seed_offset);
    const its = [];
    for (const aug of augs) {
      try {
        const augRgb = applyAug(rgb, aug);
        const can = captureCanonicalPhoton(augRgb, { x: 0, y: 0, w: augRgb.width, h: augRgb.height });
        its.push({ v: Array.from(can.it_vector), light: aug.lighting, rot: aug.rotation, scale: aug.scale, crop: aug.crop, bright: aug.bright, contrast: aug.contrast });
      } catch {}
    }
    shard.classes.push({ id: cls.id, source: cls.source, replica: cls.replica, its });
  }
  fs.writeFileSync(p, JSON.stringify(shard));
  return shard;
}

const totalShards = Math.ceil(classes.length / SHARD_SIZE);
console.log(`[${t()}s] capture: ${classes.length} classes × ${CONFIG.SAMPLES_PER_CLASS} = ${classes.length * CONFIG.SAMPLES_PER_CLASS} captures across ${totalShards} shards`);

const rank = Number(process.env.PROC_RANK ?? 0);
const workers = Number(process.env.PROC_WORKERS ?? 1);
console.log(`[${t()}s] worker rank=${rank}/${workers}`);
for (let s = 0; s < totalShards; s++) {
  if (s % workers !== rank) continue;
  const st = performance.now();
  const shard = await processShard(s);
  const done = shard.classes.reduce((a, c) => a + c.its.length, 0);
  const dt = ((performance.now()-st)/1000).toFixed(1);
  if (s % 25 === 0 || s === totalShards - 1) {
    const eta = ((performance.now() - t0) / (s+1)) * (totalShards - s - 1) / 60000;
    console.log(`[${t()}s] shard ${s+1}/${totalShards} in ${dt}s (${done} caps)  ETA ${eta.toFixed(0)}min`);
  }
}
console.log(`[${t()}s] capture complete`);

// If we're a non-rank-0 worker, exit — rank 0 does the analysis
if (rank !== 0 && workers > 1) { console.log(`[${t()}s] worker ${rank} done, exiting`); process.exit(0); }

// ============ LOAD MERGED CACHE ============
console.log(`[${t()}s] loading merged cache…`);
const cache = new Map();
for (let s = 0; s < totalShards; s++) {
  const p = shardPath(s);
  if (!fs.existsSync(p)) continue;
  const d = JSON.parse(fs.readFileSync(p, "utf8"));
  for (const c of d.classes) if (c.its && c.its.length) cache.set(c.id, c);
}
console.log(`[${t()}s] cache: ${cache.size} classes`);

// ============ STATISTICS TOOLKIT ============
const D = 80;
function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(pseudo(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
function l1(a, b) { let s = 0; for (let d = 0; d < D; d++) s += Math.abs(a[d] - b[d]); return s; }
function bootstrapCI(values, alpha = 0.05) {
  const sorted = values.slice().sort((a,b) => a-b);
  const lo = sorted[Math.max(0, Math.floor(alpha/2 * sorted.length))];
  const hi = sorted[Math.min(sorted.length-1, Math.ceil((1-alpha/2) * sorted.length))];
  const median = sorted[Math.floor(sorted.length/2)];
  const mean = values.reduce((s,v) => s+v, 0) / values.length;
  return { mean, median, p025: lo, p975: hi };
}

// ============ QUESTION 4.5 — SCALING LAW CURVE ============
console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  QUESTION 4.5 — SCALING LAW (accuracy vs class count)`);
console.log(`══════════════════════════════════════════════════════════`);
const scaling = [];
for (const K of CONFIG.SCALING_STEPS) {
  if (K > cache.size) break;
  // For each seed, take a random subset of K classes and score at N=5 (magic candidate)
  const rates = [];
  for (let seed = 1; seed <= 100; seed++) {
    const allIds = Array.from(cache.keys());
    const shuffled = seededShuffle(allIds, seed);
    const subset = shuffled.slice(0, K);
    const trainVecs = new Map();
    const test = [];
    for (const cid of subset) {
      const its = cache.get(cid).its;
      const s2 = seededShuffle(its, seed + 12345);
      const n = Math.min(5, s2.length - 1);
      trainVecs.set(cid, s2.slice(0, n).map(x => x.v));
      for (let j = n; j < s2.length; j++) test.push({ cid, v: s2[j].v });
    }
    let correct = 0;
    for (const q of test) {
      let bestCid = null, bestD = Infinity;
      for (const [cid, vecs] of trainVecs) for (const t of vecs) {
        const d = l1(q.v, t);
        if (d < bestD) { bestD = d; bestCid = cid; }
      }
      if (bestCid === q.cid) correct++;
    }
    rates.push(correct / test.length);
  }
  const ci = bootstrapCI(rates);
  scaling.push({ K, ...ci });
  console.log(`  K=${K.toString().padStart(5)}: mean=${(ci.mean*100).toFixed(2)}%  95%CI=[${(ci.p025*100).toFixed(2)}, ${(ci.p975*100).toFixed(2)}]`);
}

// ============ QUESTION 4.1 — MAGIC N SWEEP (at full 10K) ============
console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  QUESTION 4.1 — MAGIC N SWEEP AT ${cache.size} CLASSES`);
console.log(`══════════════════════════════════════════════════════════`);
const nCurve = [];
for (const N of CONFIG.N_SWEEP) {
  const rates = [];
  const macros = [];  // macro (per-class) rates
  const perClass100 = [];
  const lightFails = new Map();
  for (let seed = 1; seed <= CONFIG.BOOTSTRAP_SEEDS; seed++) {
    const trainVecs = new Map();
    const test = [];
    const perClassCorrect = new Map();
    const perClassTotal = new Map();
    for (const [cid, cls] of cache) {
      if (!cls.its || cls.its.length < 2) continue;
      const s2 = seededShuffle(cls.its, seed);
      const take = Math.min(N, s2.length - 1);
      trainVecs.set(cid, s2.slice(0, take).map(x => x.v));
      for (let j = take; j < s2.length; j++) test.push({ cid, v: s2[j].v, light: s2[j].light });
      perClassCorrect.set(cid, 0);
      perClassTotal.set(cid, s2.length - take);
    }
    let correct = 0;
    for (const q of test) {
      let bestCid = null, bestD = Infinity;
      for (const [cid, vecs] of trainVecs) for (const t of vecs) {
        const d = l1(q.v, t);
        if (d < bestD) { bestD = d; bestCid = cid; }
      }
      if (bestCid === q.cid) {
        correct++;
        perClassCorrect.set(q.cid, perClassCorrect.get(q.cid) + 1);
      } else {
        lightFails.set(q.light, (lightFails.get(q.light) || 0) + 1);
      }
    }
    rates.push(correct / test.length);
    // Macro accuracy = mean of per-class accuracies
    const perClassRates = [];
    let n100 = 0;
    for (const [cid, tot] of perClassTotal) {
      const rr = tot > 0 ? perClassCorrect.get(cid) / tot : 0;
      perClassRates.push(rr);
      if (rr === 1) n100++;
    }
    macros.push(perClassRates.reduce((s,v) => s+v, 0) / perClassRates.length);
    perClass100.push(n100);
  }
  const overall = bootstrapCI(rates);
  const macro = bootstrapCI(macros);
  const cls100 = bootstrapCI(perClass100);
  const lightRates = {};
  const totalFails = Array.from(lightFails.values()).reduce((s,v) => s+v, 0);
  for (const [l, f] of lightFails) lightRates[l] = f / totalFails;

  nCurve.push({ N, overall, macro, classes_at_100pct: cls100, lightFailFractions: lightRates });
  console.log(`  N=${N.toString().padStart(3)}: overall mean=${(overall.mean*100).toFixed(2)}% [${(overall.p025*100).toFixed(2)},${(overall.p975*100).toFixed(2)}]  macro=${(macro.mean*100).toFixed(2)}%  cls@100%=${cls100.mean.toFixed(0)}/${cache.size}  neonFrac=${((lightRates.neon || 0)*100).toFixed(1)}%  crtFrac=${((lightRates.crt || 0)*100).toFixed(1)}%`);
}

// Determine Magic N per charter §4.1 strict definition
let magicN = null;
for (const row of nCurve) {
  const neonFail = row.lightFailFractions.neon || 0;
  const crtFail  = row.lightFailFractions.crt || 0;
  if (row.overall.p025 >= CONFIG.MAGIC_N_THRESHOLD && neonFail <= CONFIG.NEON_FAIL_CEILING && crtFail <= CONFIG.CRT_FAIL_CEILING) {
    magicN = row.N; break;
  }
}
console.log(`\n  MAGIC N (strict): ${magicN ?? "NOT REACHED"}  (threshold=${CONFIG.MAGIC_N_THRESHOLD}, NEON≤${CONFIG.NEON_FAIL_CEILING}, CRT≤${CONFIG.CRT_FAIL_CEILING})`);

// ============ QUESTION 4.2 — CROSS-ILLUMINANT MATRIX ============
console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  QUESTION 4.2 — NEON / CRT CROSS-ILLUMINANT MATRIX`);
console.log(`══════════════════════════════════════════════════════════`);
// For each ref-lighting × query-lighting, measure per-class recognition
// (train only on ref-lighting samples of the class, test only on query-lighting samples)
const LIGHT_KEYS = LIGHTINGS;   // ["raw","sun","candle","moon","crt","neon"]
const matrix = {};
for (const refL of LIGHT_KEYS) {
  matrix[refL] = {};
  for (const queryL of LIGHT_KEYS) {
    let correct = 0, total = 0;
    // Build ref training set: 1 vector per class where lighting=refL
    const trainByClass = new Map();
    for (const [cid, cls] of cache) {
      const refs = cls.its.filter(x => x.light === refL);
      if (refs.length === 0) continue;
      trainByClass.set(cid, refs[0].v);
    }
    // For each class, iterate query samples matching queryL
    for (const [cid, cls] of cache) {
      const queries = cls.its.filter(x => x.light === queryL);
      for (const q of queries) {
        let bestCid = null, bestD = Infinity;
        for (const [tCid, tVec] of trainByClass) {
          if (tCid === cid && queryL === refL) continue;  // same-sample if lighting matches
          const d = l1(q.v, tVec);
          if (d < bestD) { bestD = d; bestCid = tCid; }
        }
        total++;
        if (bestCid === cid) correct++;
      }
    }
    matrix[refL][queryL] = total > 0 ? correct / total : null;
  }
}
console.log(`  Rows: reference lighting.  Columns: query lighting.`);
const header = "  Ref\\Query    " + LIGHT_KEYS.map(l => l.padEnd(8)).join("");
console.log(header);
for (const refL of LIGHT_KEYS) {
  const row = "  " + refL.padEnd(12) + "  " + LIGHT_KEYS.map(qL => {
    const r = matrix[refL][qL];
    return r === null ? "  n/a  " : `${(r*100).toFixed(1)}%`.padEnd(8);
  }).join("");
  console.log(row);
}

// ============ QUESTION 4.3 — COLLISION BEHAVIOR ============
console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  QUESTION 4.3 — COLLISION BEHAVIOR AT ${cache.size} CLASSES`);
console.log(`══════════════════════════════════════════════════════════`);
// Sample distances (full N² is too expensive at 1M vectors — sample 2000 vectors)
const sampleVecs = [];
for (const [cid, cls] of cache) for (const it of cls.its) sampleVecs.push({ cid, v: it.v });
const N_SAMPLE = Math.min(3000, sampleVecs.length);
const sample = seededShuffle(sampleVecs, 42).slice(0, N_SAMPLE);
console.log(`  sampling ${N_SAMPLE} vectors for O(N²) collision analysis`);
const intraDists = [], interDists = [], nearestImpostorDists = [];
let recipNNColls = 0, classCollisions = 0;
const nearestNeighborOf = new Map();
for (let i = 0; i < sample.length; i++) {
  let bestSameD = Infinity, bestOtherD = Infinity;
  let bestOtherCid = null;
  for (let j = 0; j < sample.length; j++) {
    if (j === i) continue;
    const d = l1(sample[i].v, sample[j].v);
    if (sample[j].cid === sample[i].cid) {
      if (d < bestSameD) bestSameD = d;
      intraDists.push(d);
    } else {
      if (d < bestOtherD) { bestOtherD = d; bestOtherCid = sample[j].cid; }
      interDists.push(d);
    }
  }
  nearestImpostorDists.push(bestOtherD);
  nearestNeighborOf.set(i, bestOtherCid);
  if (bestOtherD < bestSameD) classCollisions++;
}
// Reciprocal nearest neighbor collisions
for (let i = 0; i < sample.length; i++) {
  const nn = nearestNeighborOf.get(i);
  if (nn && sample.findIndex(s => s.cid === nn) !== -1) {
    const other = sample.findIndex(s => s.cid === nn);
    if (nearestNeighborOf.get(other) === sample[i].cid) recipNNColls++;
  }
}

const intraStat = bootstrapCI(intraDists.length ? seededShuffle(intraDists, 1).slice(0, 5000) : [0]);
const interStat = bootstrapCI(interDists.length ? seededShuffle(interDists, 1).slice(0, 5000) : [0]);
const impostorStat = bootstrapCI(nearestImpostorDists);
const margin = interStat.p025 - intraStat.p975;
console.log(`  intra-class L1  mean=${intraStat.mean.toFixed(3)} 95%CI=[${intraStat.p025.toFixed(3)}, ${intraStat.p975.toFixed(3)}]`);
console.log(`  inter-class L1  mean=${interStat.mean.toFixed(3)} 95%CI=[${interStat.p025.toFixed(3)}, ${interStat.p975.toFixed(3)}]`);
console.log(`  nearest impostor mean=${impostorStat.mean.toFixed(3)}`);
console.log(`  SEPARATION MARGIN (inter_p025 − intra_p975) = ${margin.toFixed(3)} ${margin > 0 ? "✓ POSITIVE" : "✗ NEGATIVE — collision zone"}`);
console.log(`  same-class-nearest-vs-impostor collisions: ${classCollisions}/${N_SAMPLE} = ${(classCollisions/N_SAMPLE*100).toFixed(1)}%`);
console.log(`  reciprocal-NN collisions: ${recipNNColls}`);

// Open-set: reject if margin between top1 and top2 < OPEN_SET_MARGIN
let openSetCorrect = 0, openSetRejected = 0, openSetForced = 0;
for (const q of seededShuffle(sample, 99).slice(0, 500)) {
  const dists = [];
  for (const other of sample) if (other !== q) dists.push({ cid: other.cid, d: l1(q.v, other.v) });
  dists.sort((a,b) => a.d - b.d);
  const top1 = dists[0], top2 = dists[1];
  const marg = (top2.d - top1.d) / (top2.d + 1e-9);
  if (marg < CONFIG.OPEN_SET_MARGIN) openSetRejected++;
  else {
    if (top1.cid === q.cid) openSetCorrect++;
    else openSetForced++;
  }
}
console.log(`  open-set (500 queries): correct=${openSetCorrect}  rejected(uncertain)=${openSetRejected}  forced-wrong=${openSetForced}`);

// ============ QUESTION 4.4 — STORAGE TRUTH ============
console.log(`\n══════════════════════════════════════════════════════════`);
console.log(`  QUESTION 4.4 — STORAGE TRUTH (full recognition substrate)`);
console.log(`══════════════════════════════════════════════════════════`);
const K = cache.size, samplesPerClass = Math.min(...Array.from(cache.values()).map(c => c.its.length));
const nAtMagic = magicN ?? 5;
const bytes = {
  it_vector_payload: nAtMagic * K * 80 * 4,               // float32
  class_exposure_index: nAtMagic * K * 8,                  // pointer per exposure
  identity_keys: K * 32,                                    // 32B UUID per class
  distance_search_index_estimate: K * nAtMagic * 16,        // typical KD-tree/HNSW overhead
  lighting_metadata: nAtMagic * K * 8,                      // 8B per exposure (light + rot + scale + crop)
  capture_provenance: nAtMagic * K * 64,                    // source path + timestamp
  raw_evidence_refs: nAtMagic * K * 32,                     // pointer or hash to preserved photon_print
  pattern_engine_graph_overhead_estimate: K * 128,          // ~8 edges × 16B each per class
};
let total = 0;
for (const [k, v] of Object.entries(bytes)) { console.log(`  ${k.padEnd(45)} ${(v/1024/1024).toFixed(2).padStart(10)} MB`); total += v; }
const totalGB = total / 1024 / 1024 / 1024;
console.log(`  ${"TOTAL RESIDENT FOOTPRINT".padEnd(45)} ${(total/1024/1024).toFixed(2).padStart(10)} MB  (${totalGB.toFixed(3)} GB)`);
console.log(`  ${"5 GB BUDGET".padEnd(45)} ${totalGB <= 5 ? "✓ WITHIN LAW" : "✗ EXCEEDS — needs quantization or hierarchy"}`);

// Quantization projections (deterministic, still needs rank-preservation receipt)
console.log(`\n  Quantization projections (float32 → smaller, needs NN-rank receipt before adopting):`);
const quantFactors = { float32: 1, float16: 2, int8: 4, int4_packed: 8 };
for (const [k, f] of Object.entries(quantFactors)) {
  const q = bytes.it_vector_payload / f;
  const projTotal = total - bytes.it_vector_payload + q;
  console.log(`    ${k.padEnd(16)}  IT payload=${(q/1024/1024).toFixed(2)} MB  total=${(projTotal/1024/1024/1024).toFixed(3)} GB`);
}

// ============ WRITE REPORT ============
const report = {
  charter: "AWE_3_GOVERNING_STATE_2026-07-09",
  config: CONFIG,
  cache_size: cache.size,
  scaling_law: scaling,
  n_curve: nCurve,
  magic_n_strict: magicN,
  cross_illuminant_matrix: matrix,
  collisions: {
    intra: intraStat, inter: interStat, margin,
    same_class_vs_impostor_collisions: classCollisions,
    recip_NN_collisions: recipNNColls,
    open_set: { correct: openSetCorrect, rejected: openSetRejected, forced: openSetForced },
  },
  storage: { bytes, total_bytes: total, total_gb: totalGB, within_5gb: totalGB <= 5 },
};
const reportPath = path.join(CONFIG.RESULT_DIR, `report_${Date.now()}.json`);
fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
console.log(`\n[${t()}s] report: ${reportPath}`);
console.log(`[${t()}s] ═══ 5-QUESTION DISPATCH COMPLETE ═══`);
