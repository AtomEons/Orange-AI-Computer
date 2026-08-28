#!/usr/bin/env bun
// prove-500-item-scale.mjs — 500-item test, operator directive 2026-07-09.
//
// Classes:
//   - 30 meme templates (6 variants each, natural content variation, no lighting)
//   - 19 real fixtures × 6 lighting = 114 samples
//   - Additional single-variant classes for volume
//
// Total: ~500 samples across ~50 classes.
//
// Protocol: hold-one-out per class. Train on all-but-one. Test on held-out.
// Use W = W+1_fm_head (Round 1 winner) IT variant.
// Cache all canonicals to disk. Report recognition rate + failure patterns.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { buildITVariant, itVariantSim } from "./eye/it-variants.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale";
fs.mkdirSync(OUT, { recursive: true });

// Auto-discover meme corpus classes: every subdirectory with ≥1 image is a class.
const MEME_ROOT = `${FIX}/meme-corpus`;
const MEMES = fs.existsSync(MEME_ROOT)
  ? fs.readdirSync(MEME_ROOT).filter(d => {
      const p = `${MEME_ROOT}/${d}`;
      if (!fs.statSync(p).isDirectory()) return false;
      const files = fs.readdirSync(p).filter(f => /\.(jpe?g|png)$/i.test(f));
      return files.length >= 1;
    })
  : [];

// FIXTURE classes — real photos with lighting variation
const FIXTURES_ONLY_RAW = [
  "apple", "baboon", "board", "building", "butterfly", "fruits", "home", "lena", "messi5",
  "orange", "pic1", "pic2", "pic3", "pic4", "pic5", "pic6", "starry_night", "notes",
];

const CACHE_PATH = path.join(OUT, "_500_cache.json");

function extractInputs(can, RAD_BINS = 32) {
  const CANON_W = 256, CANON_H = 256;
  const cx = CANON_W / 2, cy = CANON_H / 2;
  const maxR = Math.hypot(cx, cy);
  const buildRadial = (channelOffset) => {
    const rSum = new Float32Array(RAD_BINS), rCnt = new Float32Array(RAD_BINS);
    let mn = Infinity, mx = -Infinity;
    for (let i = 0; i < CANON_W * CANON_H; i++) {
      const v = can.opponent_map[i * 3 + channelOffset];
      if (v < mn) mn = v; if (v > mx) mx = v;
    }
    const range = (mx - mn) || 1;
    for (let y = 0; y < CANON_H; y++) {
      for (let x = 0; x < CANON_W; x++) {
        const r = Math.hypot(x - cx, y - cy);
        const rb = Math.min(RAD_BINS - 1, Math.floor((r / maxR) * RAD_BINS));
        const scaled = ((can.opponent_map[(y * CANON_W + x) * 3 + channelOffset] - mn) / range) * 255;
        rSum[rb] += scaled; rCnt[rb]++;
      }
    }
    const prof = new Float32Array(RAD_BINS);
    for (let i = 0; i < RAD_BINS; i++) prof[i] = rCnt[i] > 0 ? rSum[i] / rCnt[i] / 255 : 0;
    return Array.from(prof);
  };
  return {
    lgnFlat: can.lgn.flat,
    v1Summary: can.v1_summary,
    v2Summary: can.v2_summary,
    v4Summary: can.v4_summary,
    ilcRProf: buildRadial(0),
    ilcRgProf: buildRadial(1),
    ilcByProf: buildRadial(2),
    axisBundle: can.axis_bundle,
  };
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  500-ITEM RECOGNITION — memes + fixtures at scale         ║");
console.log("╚══════════════════════════════════════════════════════════╝");

let cache;
if (fs.existsSync(CACHE_PATH)) {
  console.log(`\n  Loading ${CACHE_PATH}…`);
  const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  cache = { classes: new Map(Object.entries(raw.classes)) };
  const total_samples = Array.from(cache.classes.values()).reduce((s, a) => s + a.length, 0);
  console.log(`  Loaded ${cache.classes.size} classes with ${total_samples} total samples`);
} else {
  console.log("\n══ Precompute canonicals ══");
  cache = { classes: new Map() };
  const t0 = performance.now();
  let total_captured = 0;

  // MEMES — variants per template (auto-discovered from meme-corpus/)
  for (const meme of MEMES) {
    const dir = `${MEME_ROOT}/${meme}`;
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => /\.(jpg|png)$/i.test(f)).sort();
    if (files.length === 0) continue;
    const inputs_arr = [];
    for (const f of files) {
      try {
        const rgb = await extractImageRGB(`${dir}/${f}`, { maxSize: 128 });
        const can = captureCanonicalPhoton(rgb, { x: 0, y: 0, w: rgb.width, h: rgb.height });
        inputs_arr.push({ inputs: extractInputs(can), file: f });
        total_captured++;
      } catch (e) { /* skip failed captures */ }
    }
    cache.classes.set(meme, inputs_arr);
    const dt = ((performance.now() - t0) / 1000).toFixed(0);
    console.log(`  ${meme.padEnd(48)} ${inputs_arr.length} variants (${total_captured} total, ${dt}s)`);
  }

  // FIXTURES with 6 lighting variations — reuse existing lighting transform
  const applyLight = (rgb, type) => {
    const N = rgb.width * rgb.height;
    const R = new Float32Array(rgb.R);
    const G = new Float32Array(rgb.G);
    const B = new Float32Array(rgb.B);
    for (let i = 0; i < N; i++) {
      let r = R[i], g = G[i], b = B[i];
      switch (type) {
        case "sun":    r *= 1.15; g *= 1.08; b *= 0.88; break;
        case "candle": r *= 1.35 * 0.72; g *= 0.82 * 0.72; b *= 0.35 * 0.72; break;
        case "moon":   r *= 0.28; g *= 0.38; b *= 0.72; break;
        case "crt":    r *= 0.28; g *= 1.12; b *= 0.28; break;
        case "neon": {
          const a = (r + g + b) / 3;
          r = a + (r - a) * 2.6; g = a + (g - a) * 2.6; b = a + (b - a) * 2.6;
          r *= 1.25; b *= 1.25; g *= 0.65; break;
        }
      }
      R[i] = Math.min(255, Math.max(0, r));
      G[i] = Math.min(255, Math.max(0, g));
      B[i] = Math.min(255, Math.max(0, b));
    }
    return { R, G, B, width: rgb.width, height: rgb.height, W: rgb.width, H: rgb.height };
  };
  const LIGHTS = ["raw", "sun", "candle", "moon", "crt", "neon"];

  const FIXTURE_PATHS = {
    apple: `${FIX}/apple.jpg`, baboon: `${FIX}/baboon.jpg`, board: `${FIX}/board.jpg`,
    building: `${FIX}/building.jpg`, butterfly: `${FIX}/butterfly.jpg`, fruits: `${FIX}/fruits.jpg`,
    home: `${FIX}/home.jpg`, lena: `${FIX}/lena.jpg`, messi5: `${FIX}/messi5.jpg`,
    orange: `${FIX}/orange.jpg`, pic1: `${FIX}/pic1.png`, pic2: `${FIX}/pic2.png`,
    pic3: `${FIX}/pic3.png`, pic4: `${FIX}/pic4.png`, pic5: `${FIX}/pic5.png`,
    pic6: `${FIX}/pic6.png`, starry_night: `${FIX}/starry_night.jpg`, notes: `${FIX}/notes.png`,
  };
  for (const [name, p] of Object.entries(FIXTURE_PATHS)) {
    if (!fs.existsSync(p)) continue;
    const rgb = await extractImageRGB(p, { maxSize: 128 });
    const inputs_arr = [];
    for (const light of LIGHTS) {
      try {
        const lit = applyLight(rgb, light);
        const can = captureCanonicalPhoton(lit, { x: 0, y: 0, w: lit.width, h: lit.height });
        inputs_arr.push({ inputs: extractInputs(can), file: `${light}` });
        total_captured++;
      } catch (e) { /* skip */ }
    }
    cache.classes.set(name, inputs_arr);
    const dt = ((performance.now() - t0) / 1000).toFixed(0);
    console.log(`  ${name.padEnd(48)} ${inputs_arr.length} variants (${total_captured} total, ${dt}s)`);
  }

  console.log(`  Total captured: ${total_captured} in ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ classes: Object.fromEntries(cache.classes) }));
  console.log(`  Cache saved to ${CACHE_PATH}`);
}

// Hold-one-out per class — leave-one-out cross-validation
function scoreVariant(variant) {
  let correct = 0, total = 0;
  const failures = [];
  const classes_arr = Array.from(cache.classes.keys());
  for (const cls of classes_arr) {
    const samples = cache.classes.get(cls);
    if (samples.length < 2) continue;
    for (let held_idx = 0; held_idx < samples.length; held_idx++) {
      const query = buildITVariant(samples[held_idx].inputs, variant);
      let bestLabel = null, bestSim = -Infinity, secondSim = -Infinity;
      for (const otherCls of classes_arr) {
        const otherSamples = cache.classes.get(otherCls);
        let famBest = -Infinity;
        for (let j = 0; j < otherSamples.length; j++) {
          if (otherCls === cls && j === held_idx) continue;  // exclude the held-out itself
          const trainVec = buildITVariant(otherSamples[j].inputs, variant);
          const s = itVariantSim(query, trainVec);
          if (s > famBest) famBest = s;
        }
        if (famBest > bestSim) {
          secondSim = bestSim;
          bestSim = famBest; bestLabel = otherCls;
        } else if (famBest > secondSim) {
          secondSim = famBest;
        }
      }
      total++;
      if (bestLabel === cls) correct++;
      else failures.push({ cls, held_idx, held_file: samples[held_idx].file, predicted: bestLabel, margin: bestSim - secondSim });
    }
  }
  return { variant, correct, total, failures };
}

console.log("\n══ Recognition (leave-one-out per class) ══");
const VARIANTS = ["W", "W+1_fm_head", "W+GRAND_1", "W+1+heavy_shape"];
const results = {};
for (const v of VARIANTS) {
  const r = scoreVariant(v);
  results[v] = r;
  console.log(`  ${v.padEnd(25)} ${r.correct}/${r.total}  =  ${(r.correct/r.total*100).toFixed(1)}%`);
}

const best = VARIANTS.reduce((b, v) => results[v].correct > results[b].correct ? v : b, "W");
console.log(`\n══ Best variant: ${best}  (${results[best].correct}/${results[best].total} = ${(results[best].correct/results[best].total*100).toFixed(1)}%) ══`);

// Failure pattern analysis for the best variant
const bestR = results[best];
console.log(`\n══ Failure patterns for ${best} (${bestR.failures.length} failures) ══`);
// Group failures by (from-class → to-class)
const failMap = new Map();
for (const f of bestR.failures) {
  const key = `${f.cls} → ${f.predicted}`;
  failMap.set(key, (failMap.get(key) || 0) + 1);
}
const sortedFailures = Array.from(failMap.entries()).sort((a, b) => b[1] - a[1]);
for (const [key, count] of sortedFailures.slice(0, 25)) {
  console.log(`  ${count}x  ${key}`);
}

// Which classes have the WORST recognition?
console.log(`\n══ Worst-performing classes (failure count) ══`);
const clsFailMap = new Map();
for (const f of bestR.failures) clsFailMap.set(f.cls, (clsFailMap.get(f.cls) || 0) + 1);
const worstClasses = Array.from(clsFailMap.entries()).sort((a, b) => b[1] - a[1]);
for (const [cls, count] of worstClasses.slice(0, 15)) {
  const total_in_class = cache.classes.get(cls).length;
  console.log(`  ${cls.padEnd(48)} ${count}/${total_in_class} failed`);
}

fs.writeFileSync(path.join(OUT, "_500_results.json"), JSON.stringify({ results, best }, null, 2));
console.log(`\n  Full results: ${path.join(OUT, "_500_results.json")}`);
