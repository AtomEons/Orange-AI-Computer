#!/usr/bin/env bun
// dispatch-staged.mjs — incremental capture-test cycles.
//
// Operator directive (2026-07-10, feedback_incremental_capture_test.md):
//   "DOWNLOAD 10K TEST 10K DL 50K TEST THAT. ETC DONT DL ALL THEN TEST AND
//    IT NOT WORK."
//
// Stage-gated dispatch. Cache is chunked, resumable. Each stage:
//   1. Ensures shards up to that stage's capture-count exist (captures if not).
//   2. Runs the 5-question test suite ON THE SUBSET captured so far.
//   3. Reports pass/fail per gate.
//   4. If PASS: prompts operator to run next stage. If FAIL: HALTS.
//
// Usage:
//   bun dispatch-staged.mjs --stage 1           # capture + test stage 1
//   bun dispatch-staged.mjs --stage 2           # capture stage 2 additional + test all
//   bun dispatch-staged.mjs --stage 3           # etc.
//   bun dispatch-staged.mjs --report            # just re-run test on existing cache
//
// Parallel via PROC_RANK / PROC_WORKERS env, same as before.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton, CANON_W, CANON_H } from "./photon-canonical.mjs";

// ============ STAGE PLAN ============
const STAGES = [
  { name: "stage-1", target_captures:   10_000, classes:   100 },   // 100 × 100
  { name: "stage-2", target_captures:   50_000, classes:   500 },   // 500 × 100
  { name: "stage-3", target_captures:  250_000, classes:  2_500 },
  { name: "stage-4", target_captures:  500_000, classes:  5_000 },
  { name: "stage-5", target_captures: 1_000_000, classes: 10_000 },
];

const ARG_STAGE = (() => {
  const idx = process.argv.indexOf("--stage");
  return idx >= 0 ? Number(process.argv[idx + 1]) : null;
})();
const ARG_REPORT = process.argv.includes("--report");
if (!ARG_STAGE && !ARG_REPORT) {
  console.log("usage: bun dispatch-staged.mjs --stage <1..5> | --report");
  console.log("stages:");
  for (let i = 0; i < STAGES.length; i++) console.log(`  ${i + 1}: ${STAGES[i].name} (${STAGES[i].target_captures} captures, ${STAGES[i].classes} classes)`);
  process.exit(0);
}

const CONFIG = {
  SAMPLES_PER_CLASS: 100,
  CAPTURE_MAXSIZE: 96,
  CACHE_DIR:  "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/cache",
  RESULT_DIR: "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results",
  BOOTSTRAP_SEEDS: 200,
  N_SWEEP: [1,2,3,4,5,6,7,8,9,10,11,13,15,17,20,25,30],
  // Gates that must PASS for the stage to be considered successful:
  MAGIC_N_THRESHOLD: 0.95,    // 95%-CI lower bound
  NEON_FAIL_CEILING: 0.05,
  CRT_FAIL_CEILING:  0.05,
  COLLISION_PHASE_TRANSITION_MAX: 0.10,   // max class-collision rate before we flag phase transition
  STORAGE_5GB_CEILING_BYTES: 5 * 1024 * 1024 * 1024,
  CORPUS_ROOTS: [ "C:/AtomEons/Orange5/07-VISUAL/fixtures" ],
};

fs.mkdirSync(CONFIG.CACHE_DIR, { recursive: true });
fs.mkdirSync(CONFIG.RESULT_DIR, { recursive: true });

const t0 = performance.now();
const t = () => ((performance.now() - t0) / 1000).toFixed(0);

// ============ CORPUS DISCOVERY ============
function walkImages(root, out = []) {
  if (!fs.existsSync(root)) return out;
  for (const e of fs.readdirSync(root, { withFileTypes: true })) {
    const p = path.join(root, e.name);
    if (e.isDirectory()) walkImages(p, out);
    else if (/\.(jpe?g|png)$/i.test(e.name)) out.push(p);
  }
  return out;
}
let allImages = [];
for (const root of CONFIG.CORPUS_ROOTS) allImages = allImages.concat(walkImages(root));
if (allImages.length === 0) { console.log("no images found"); process.exit(1); }
console.log(`[${t()}s] ${allImages.length} source images`);

// ============ AUGMENTATION GRID (NEON + CRT locked) ============
const LIGHTINGS = ["raw","sun","candle","moon","crt","neon"];
const ROTATIONS = [0,45,90,135,180,225,270,315];
const SCALES = [1.0,0.85,0.70,1.25];
const CROPS = ["full","center70","top","bottom"];
const BRIGHTS = [1.0,0.85,1.15];
const CONTRASTS = [1.0,0.85,1.15];

function augmentationsForClass(seed) {
  const list = [];
  const rng = (i) => { const x = Math.sin(seed + i * 12345.6789) * 233280; return x - Math.floor(x); };
  for (const l of LIGHTINGS) list.push({ lighting: l, rotation: 0, scale: 1.0, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const r of ROTATIONS) list.push({ lighting: "raw", rotation: r, scale: 1.0, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const s of SCALES) list.push({ lighting: "raw", rotation: 0, scale: s, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const c of CROPS) list.push({ lighting: "raw", rotation: 0, scale: 1.0, crop: c, bright: 1.0, contrast: 1.0 });
  for (const b of BRIGHTS) list.push({ lighting: "raw", rotation: 0, scale: 1.0, crop: "full", bright: b, contrast: 1.0 });
  for (const c of CONTRASTS) list.push({ lighting: "raw", rotation: 0, scale: 1.0, crop: "full", bright: 1.0, contrast: c });
  for (const l of ["neon","crt"]) for (const r of [45,90,135]) list.push({ lighting: l, rotation: r, scale: 1.0, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const l of ["neon","crt"]) for (const s of [0.85,1.25]) list.push({ lighting: l, rotation: 0, scale: s, crop: "full", bright: 1.0, contrast: 1.0 });
  for (const l of ["neon","crt"]) for (const c of ["center70","top"]) list.push({ lighting: l, rotation: 0, scale: 1.0, crop: c, bright: 1.0, contrast: 1.0 });
  const need = CONFIG.SAMPLES_PER_CLASS - list.length;
  for (let i = 0; i < need; i++) list.push({
    lighting: LIGHTINGS[Math.floor(rng(i*7+1) * LIGHTINGS.length)],
    rotation: ROTATIONS[Math.floor(rng(i*7+2) * ROTATIONS.length)],
    scale: SCALES[Math.floor(rng(i*7+3) * SCALES.length)],
    crop: CROPS[Math.floor(rng(i*7+4) * CROPS.length)],
    bright: BRIGHTS[Math.floor(rng(i*7+5) * BRIGHTS.length)],
    contrast: CONTRASTS[Math.floor(rng(i*7+6) * CONTRASTS.length)],
  });
  return list.slice(0, CONFIG.SAMPLES_PER_CLASS);
}

function applyAug(rgb, aug) {
  const W = rgb.width, H = rgb.height;
  const R = new Float32Array(rgb.R), G = new Float32Array(rgb.G), B = new Float32Array(rgb.B);
  let x0 = 0, y0 = 0, cw = W, ch = H;
  if (aug.crop === "center70") { cw = Math.floor(W*0.7); ch = Math.floor(H*0.7); x0 = Math.floor((W-cw)/2); y0 = Math.floor((H-ch)/2); }
  else if (aug.crop === "top") { ch = Math.floor(H/2); }
  else if (aug.crop === "bottom") { y0 = Math.floor(H/2); ch = H - y0; }
  const cR = new Float32Array(cw*ch), cG = new Float32Array(cw*ch), cB = new Float32Array(cw*ch);
  for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
    const s = (y+y0)*W + (x+x0), d = y*cw + x;
    cR[d] = R[s]; cG[d] = G[s]; cB[d] = B[s];
  }
  let rW = cw, rH = ch, rR = cR, rG = cG, rB = cB;
  if (aug.rotation !== 0) {
    const th = -aug.rotation * Math.PI / 180, cT = Math.cos(th), sT = Math.sin(th), cx = cw/2, cy = ch/2;
    rR = new Float32Array(cw*ch); rG = new Float32Array(cw*ch); rB = new Float32Array(cw*ch);
    for (let y = 0; y < ch; y++) for (let x = 0; x < cw; x++) {
      const sx = Math.round(cT*(x-cx) - sT*(y-cy) + cx), sy = Math.round(sT*(x-cx) + cT*(y-cy) + cy);
      if (sx >= 0 && sx < cw && sy >= 0 && sy < ch) {
        const src = sy*cw + sx, dst = y*cw + x;
        rR[dst] = cR[src]; rG[dst] = cG[src]; rB[dst] = cB[src];
      }
    }
  }
  let sW = rW, sH = rH, sR = rR, sG = rG, sB = rB;
  if (aug.scale !== 1.0) {
    sW = Math.max(16, Math.floor(rW*aug.scale)); sH = Math.max(16, Math.floor(rH*aug.scale));
    sR = new Float32Array(sW*sH); sG = new Float32Array(sW*sH); sB = new Float32Array(sW*sH);
    for (let y = 0; y < sH; y++) for (let x = 0; x < sW; x++) {
      const px = Math.min(rW-1, Math.floor(x/aug.scale)), py = Math.min(rH-1, Math.floor(y/aug.scale));
      const d = y*sW + x, s = py*rW + px;
      sR[d] = rR[s]; sG[d] = rG[s]; sB[d] = rB[s];
    }
  }
  const bN = sW*sH;
  for (let i = 0; i < bN; i++) {
    let r = sR[i], g = sG[i], b = sB[i];
    switch (aug.lighting) {
      case "sun":    r *= 1.15; g *= 1.08; b *= 0.88; break;
      case "candle": r *= 1.35*0.72; g *= 0.82*0.72; b *= 0.35*0.72; break;
      case "moon":   r *= 0.28; g *= 0.38; b *= 0.72; break;
      case "crt":    r *= 0.28; g *= 1.12; b *= 0.28; break;
      case "neon":   { const a = (r+g+b)/3; r = a+(r-a)*2.6; g = a+(g-a)*2.6; b = a+(b-a)*2.6; r *= 1.25; b *= 1.25; g *= 0.65; break; }
    }
    r *= aug.bright; g *= aug.bright; b *= aug.bright;
    r = (r-128)*aug.contrast + 128; g = (g-128)*aug.contrast + 128; b = (b-128)*aug.contrast + 128;
    sR[i] = Math.min(255, Math.max(0, r)); sG[i] = Math.min(255, Math.max(0, g)); sB[i] = Math.min(255, Math.max(0, b));
  }
  return { R: sR, G: sG, B: sB, width: sW, height: sH, W: sW, H: sH };
}

// ============ SHARDS ============
const SHARD_SIZE = 10;
function shardPath(i) { return path.join(CONFIG.CACHE_DIR, `shard_${String(i).padStart(5,"0")}.json`); }

function classSpec(idx) {
  const src = allImages[idx % allImages.length];
  const cycle = Math.floor(idx / allImages.length);
  return { id: `cls_${idx}`, source: src, seed_offset: cycle * 10007, replica: cycle };
}

async function processShard(sIdx) {
  const p = shardPath(sIdx);
  if (fs.existsSync(p)) {
    try { const d = JSON.parse(fs.readFileSync(p, "utf8")); if (d.classes && d.classes.length) return d; } catch {}
  }
  const start = sIdx * SHARD_SIZE, end = start + SHARD_SIZE;
  const shard = { shard_idx: sIdx, classes: [] };
  for (let ci = start; ci < end; ci++) {
    const cls = classSpec(ci);
    let rgb;
    try { rgb = await extractImageRGB(cls.source, { maxSize: CONFIG.CAPTURE_MAXSIZE }); } catch { continue; }
    const augs = augmentationsForClass(cls.seed_offset);
    const its = [];
    for (const aug of augs) {
      try {
        const augRgb = applyAug(rgb, aug);
        const can = captureCanonicalPhoton(augRgb, { x: 0, y: 0, w: augRgb.width, h: augRgb.height });
        its.push({ v: Array.from(can.it_vector), light: aug.lighting });
      } catch {}
    }
    shard.classes.push({ id: cls.id, source: cls.source, replica: cls.replica, its });
  }
  fs.writeFileSync(p, JSON.stringify(shard));
  return shard;
}

// ============ CAPTURE FOR STAGE ============
async function ensureCaptureForStage(stageIdx) {
  const stage = STAGES[stageIdx];
  const shardsNeeded = Math.ceil(stage.classes / SHARD_SIZE);
  const rank = Number(process.env.PROC_RANK ?? 0);
  const workers = Number(process.env.PROC_WORKERS ?? 1);
  console.log(`[${t()}s] STAGE ${stageIdx + 1} (${stage.name}) — target ${stage.classes} classes = ${shardsNeeded} shards`);
  console.log(`[${t()}s] worker rank=${rank}/${workers}`);
  for (let s = 0; s < shardsNeeded; s++) {
    if (s % workers !== rank) continue;
    if (fs.existsSync(shardPath(s))) continue;
    const st = performance.now();
    await processShard(s);
    const dt = ((performance.now() - st) / 1000).toFixed(1);
    if (s % 10 === 0 || s === shardsNeeded - 1) {
      const eta = ((performance.now() - t0) / (s + 1)) * (shardsNeeded - s - 1) / 60000;
      console.log(`[${t()}s] shard ${s + 1}/${shardsNeeded} in ${dt}s  ETA ${eta.toFixed(0)}min`);
    }
  }
  console.log(`[${t()}s] capture for stage ${stageIdx + 1} complete`);
}

// ============ TEST ============
function pseudo(seed, i) { const x = Math.sin(seed * 9301 + i * 49297) * 233280; return x - Math.floor(x); }
function seededShuffle(arr, seed) {
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(pseudo(seed, i) * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
// PROVEN winning recognition: dim-standardize + block-weighted L1.
// Weights are the L1-best from the 47-class receipts (spine seq 92).
const BLOCK_WEIGHTS_L1 = [5, 5, 2, 3, 3, 5, 2, 5];   // lgn, v1, v2, v4, ilcY, ilcRG, ilcBY, axis
const BLOCK_STARTS = [0, 12, 16, 22, 30, 40, 50, 60];
const BLOCK_LENS   = [12, 4, 6, 8, 10, 10, 10, 20];
function makeDimWeights(blockW) {
  const dw = new Float32Array(80);
  for (let b = 0; b < 8; b++) for (let d = BLOCK_STARTS[b]; d < BLOCK_STARTS[b] + BLOCK_LENS[b]; d++) dw[d] = blockW[b];
  return dw;
}
const DIM_WEIGHTS = makeDimWeights(BLOCK_WEIGHTS_L1);
// Standardization stats computed from cache — populated at test time
let dimMean = null, dimStd = null;
function standardizeCache(cache) {
  const all = [];
  for (const cls of cache.values()) for (const it of cls.its) all.push(it.v);
  const N = all.length;
  dimMean = new Float32Array(80); dimStd = new Float32Array(80);
  for (let d = 0; d < 80; d++) {
    let m = 0; for (const v of all) m += v[d];
    m /= N;
    let s2 = 0; for (const v of all) s2 += (v[d] - m) ** 2;
    dimMean[d] = m; dimStd[d] = Math.sqrt(s2 / N) || 1;
  }
  // Standardize all vectors in place (creates new arrays inside cache entries)
  for (const cls of cache.values()) {
    for (const it of cls.its) {
      const nv = new Float32Array(80);
      for (let d = 0; d < 80; d++) nv[d] = (it.v[d] - dimMean[d]) / dimStd[d];
      it.v = nv;
    }
  }
}
function l1(a, b) {
  let s = 0;
  for (let d = 0; d < 80; d++) s += Math.abs(a[d] - b[d]) * DIM_WEIGHTS[d];
  return s;
}
function bootstrapCI(v, alpha = 0.05) {
  const s = v.slice().sort((a,b) => a-b);
  return {
    mean: v.reduce((x,y) => x+y, 0) / v.length,
    median: s[Math.floor(s.length/2)],
    p025: s[Math.floor(alpha/2 * s.length)],
    p975: s[Math.floor((1-alpha/2) * s.length)],
  };
}

function loadCache(maxClasses) {
  const cache = new Map();
  const shardsNeeded = Math.ceil(maxClasses / SHARD_SIZE);
  for (let s = 0; s < shardsNeeded; s++) {
    const p = shardPath(s);
    if (!fs.existsSync(p)) continue;
    try {
      const d = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const c of d.classes) if (c.its && c.its.length) {
        cache.set(c.id, c);
        if (cache.size >= maxClasses) return cache;
      }
    } catch {}
  }
  return cache;
}

function runTestSuite(cache, tag) {
  console.log(`\n══════ 5-QUESTION TEST @ ${cache.size} classes (${tag}) ══════`);
  console.log(`  Recognition: L1 + dim-standardize + block-weights [${BLOCK_WEIGHTS_L1.join(",")}]`);
  standardizeCache(cache);
  const gates = { magic_n_passed: false, neon_gate: false, crt_gate: false, collision_gate: false, storage_gate: false };

  // Q4.1 magic N (bounded sweep)
  const nCurve = [];
  for (const N of CONFIG.N_SWEEP) {
    const rates = [], lightFails = new Map();
    for (let seed = 1; seed <= CONFIG.BOOTSTRAP_SEEDS; seed++) {
      const trainVecs = new Map(), test = [];
      for (const [cid, cls] of cache) {
        if (cls.its.length < 2) continue;
        const s = seededShuffle(cls.its, seed);
        const take = Math.min(N, s.length - 1);
        trainVecs.set(cid, s.slice(0, take).map(x => x.v));
        for (let j = take; j < s.length; j++) test.push({ cid, v: s[j].v, light: s[j].light });
      }
      let ok = 0;
      for (const q of test) {
        let bC = null, bD = Infinity;
        for (const [cid, vecs] of trainVecs) for (const t of vecs) {
          const d = l1(q.v, t);
          if (d < bD) { bD = d; bC = cid; }
        }
        if (bC === q.cid) ok++;
        else lightFails.set(q.light, (lightFails.get(q.light) || 0) + 1);
      }
      rates.push(ok / test.length);
    }
    const ci = bootstrapCI(rates);
    const totalFails = Array.from(lightFails.values()).reduce((s,v) => s+v, 0) || 1;
    const lightFrac = Object.fromEntries(Array.from(lightFails.entries()).map(([l,f]) => [l, f/totalFails]));
    nCurve.push({ N, ci, lightFrac });
    console.log(`  N=${N.toString().padStart(2)}: mean=${(ci.mean*100).toFixed(2)}% [${(ci.p025*100).toFixed(2)},${(ci.p975*100).toFixed(2)}] neonFrac=${((lightFrac.neon||0)*100).toFixed(1)}% crtFrac=${((lightFrac.crt||0)*100).toFixed(1)}%`);
  }
  let magicN = null;
  for (const row of nCurve) {
    if (row.ci.p025 >= CONFIG.MAGIC_N_THRESHOLD && (row.lightFrac.neon||0) <= CONFIG.NEON_FAIL_CEILING && (row.lightFrac.crt||0) <= CONFIG.CRT_FAIL_CEILING) {
      magicN = row.N; break;
    }
  }
  gates.magic_n_passed = magicN !== null;
  if (magicN) {
    const r = nCurve.find(x => x.N === magicN);
    gates.neon_gate = (r.lightFrac.neon || 0) <= CONFIG.NEON_FAIL_CEILING;
    gates.crt_gate = (r.lightFrac.crt || 0) <= CONFIG.CRT_FAIL_CEILING;
  }
  console.log(`  MAGIC N = ${magicN ?? "NOT REACHED"}`);

  // Q4.3 collision behavior (light sampling)
  const sampleVecs = [];
  for (const cls of cache.values()) for (const it of cls.its) sampleVecs.push({ cid: cls.id, v: it.v });
  const N_SAMPLE = Math.min(2000, sampleVecs.length);
  const sample = seededShuffle(sampleVecs, 42).slice(0, N_SAMPLE);
  const intra = [], inter = []; let classColl = 0;
  for (let i = 0; i < sample.length; i++) {
    let bestSameD = Infinity, bestOtherD = Infinity;
    for (let j = 0; j < sample.length; j++) {
      if (j === i) continue;
      const d = l1(sample[i].v, sample[j].v);
      if (sample[j].cid === sample[i].cid) { if (d < bestSameD) bestSameD = d; intra.push(d); }
      else { if (d < bestOtherD) bestOtherD = d; inter.push(d); }
    }
    if (bestOtherD < bestSameD) classColl++;
  }
  const intraCI = intra.length ? bootstrapCI(intra) : { p025: 0, p975: 0, mean: 0 };
  const interCI = inter.length ? bootstrapCI(inter) : { p025: 0, p975: 0, mean: 0 };
  const margin = interCI.p025 - intraCI.p975;
  const collRate = classColl / N_SAMPLE;
  gates.collision_gate = collRate <= CONFIG.COLLISION_PHASE_TRANSITION_MAX && margin > 0;
  console.log(`  COLLISIONS: intra p025=${intraCI.p025.toFixed(3)} p975=${intraCI.p975.toFixed(3)}  inter p025=${interCI.p025.toFixed(3)} p975=${interCI.p975.toFixed(3)}  margin=${margin.toFixed(3)}  same-class-nearest-vs-impostor=${collRate.toFixed(3)}`);

  // Q4.4 storage truth
  const K = cache.size, nAt = magicN ?? 5;
  const bytes = nAt * K * 80 * 4 + nAt * K * 8 + K * 32 + nAt * K * 16 + nAt * K * 8 + nAt * K * 64 + nAt * K * 32 + K * 128;
  gates.storage_gate = bytes <= CONFIG.STORAGE_5GB_CEILING_BYTES;
  console.log(`  STORAGE: ${(bytes/1024/1024/1024).toFixed(3)} GB  (5 GB budget ${gates.storage_gate ? "✓ within" : "✗ exceeds"})`);

  // GATE SUMMARY
  const allGatesPass = Object.values(gates).every(g => g === true);
  console.log(`\n══════ GATES ══════`);
  for (const [g, pass] of Object.entries(gates)) console.log(`  ${g.padEnd(20)} ${pass ? "PASS ✓" : "FAIL ✗"}`);
  console.log(`  STAGE ${allGatesPass ? "PASSED — safe to expand to next stage" : "FAILED — do NOT expand until fixed"}`);

  const reportPath = path.join(CONFIG.RESULT_DIR, `${tag}_${Date.now()}.json`);
  fs.writeFileSync(reportPath, JSON.stringify({ tag, class_count: cache.size, magic_n: magicN, nCurve, gates, allGatesPass, collision: { intra: intraCI, inter: interCI, margin, class_coll_rate: collRate }, storage_bytes: bytes }, null, 2));
  console.log(`  report → ${reportPath}`);
  return { allGatesPass, magicN, reportPath };
}

// ============ RUN ============
if (ARG_REPORT) {
  // Just run the test suite on whatever's cached
  const cache = loadCache(1000000);
  runTestSuite(cache, `report-only`);
  process.exit(0);
}

const stageIdx = ARG_STAGE - 1;
if (stageIdx < 0 || stageIdx >= STAGES.length) {
  console.log(`invalid stage ${ARG_STAGE} (1..${STAGES.length})`);
  process.exit(1);
}

await ensureCaptureForStage(stageIdx);

// Rank 0 does the test pass; other ranks exit after capture.
const rank = Number(process.env.PROC_RANK ?? 0);
if (rank !== 0) { console.log(`[${t()}s] worker ${rank} done, exiting`); process.exit(0); }

const stage = STAGES[stageIdx];
const cache = loadCache(stage.classes);
console.log(`[${t()}s] loaded ${cache.size} classes from cache`);
const result = runTestSuite(cache, stage.name);

if (result.allGatesPass) {
  console.log(`\n[${t()}s] ✓ STAGE ${ARG_STAGE} PASSED. Ready for stage ${ARG_STAGE + 1}. Run:`);
  if (ARG_STAGE < STAGES.length) console.log(`  bun ${process.argv[1]} --stage ${ARG_STAGE + 1}`);
  else console.log(`  (all stages complete)`);
} else {
  console.log(`\n[${t()}s] ✗ STAGE ${ARG_STAGE} FAILED gates. Fix architecture before proceeding.`);
  process.exit(1);
}
