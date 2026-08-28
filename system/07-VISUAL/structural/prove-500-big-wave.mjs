#!/usr/bin/env bun
// prove-500-big-wave.mjs — big wave toward zero-error recognition.
//
// Two architectural moves layered:
//   1. CAT02 gain clamping in recoverReflectance (already applied to
//      photon-canonical.mjs — invalidates the previous cache).
//   2. Multi-fixation TEST query: query = 4 IT vectors (global + 3 saccades).
//      Recognition = max cosine sim of any query vector vs any family node.
//      This gives each query multiple chances to match — the eye's saccadic
//      sampling made honest.
//
// Uses W (80-D IT baseline) since it beat W+1_fm_head at 47-class scale.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton, CANON_W, CANON_H } from "./photon-canonical.mjs";
import { buildITVariant, itVariantSim } from "./eye/it-variants.mjs";
import { captureWithSaccades } from "./eye/saccades.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/five-hundred-scale";
fs.mkdirSync(OUT, { recursive: true });

const MEME_ROOT = `${FIX}/meme-corpus`;
const MEMES = fs.existsSync(MEME_ROOT)
  ? fs.readdirSync(MEME_ROOT).filter(d => {
      const p = `${MEME_ROOT}/${d}`;
      if (!fs.statSync(p).isDirectory()) return false;
      const files = fs.readdirSync(p).filter(f => /\.(jpe?g|png)$/i.test(f));
      return files.length >= 2;   // need at least 2 for leave-one-out
    })
  : [];

const FIXTURES = {
  apple: `${FIX}/apple.jpg`, baboon: `${FIX}/baboon.jpg`, board: `${FIX}/board.jpg`,
  building: `${FIX}/building.jpg`, butterfly: `${FIX}/butterfly.jpg`, fruits: `${FIX}/fruits.jpg`,
  home: `${FIX}/home.jpg`, lena: `${FIX}/lena.jpg`, messi5: `${FIX}/messi5.jpg`,
  orange: `${FIX}/orange.jpg`, pic1: `${FIX}/pic1.png`, pic2: `${FIX}/pic2.png`,
  pic3: `${FIX}/pic3.png`, pic4: `${FIX}/pic4.png`, pic5: `${FIX}/pic5.png`,
  pic6: `${FIX}/pic6.png`, starry_night: `${FIX}/starry_night.jpg`, notes: `${FIX}/notes.png`,
};
const LIGHTS = ["raw", "sun", "candle", "moon", "crt", "neon"];

function applyLight(rgb, type) {
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
}

function extractInputs(can) {
  const RAD_BINS = 32;
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

// Turn a frame into: 1 global capture + 3 saccadic captures → 4 IT vectors
async function itsOfFrame(rgb) {
  const result = await captureWithSaccades(rgb, captureCanonicalPhoton, { numFixations: 3, regionFrac: 0.4 });
  const its = [buildITVariant(extractInputs(result.global), "W")];
  for (const f of result.fixations) its.push(buildITVariant(extractInputs(f.canonical), "W"));
  return its;
}
async function itOfFrame(rgb) {
  const can = captureCanonicalPhoton(rgb, { x: 0, y: 0, w: rgb.width, h: rgb.height });
  return buildITVariant(extractInputs(can), "W");
}

// Load all classes; each class → array of samples; each sample → array of IT vectors
// Fixtures: 6 lighting variants, each with 4 saccadic IT vectors = 24 IT per class
// Memes: variants per template, each with 4 saccadic IT vectors
const CACHE_PATH = path.join(OUT, "_bigwave_cache.json");
let cache;

if (fs.existsSync(CACHE_PATH)) {
  console.log(`Loading cache ${CACHE_PATH}…`);
  const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  cache = { classes: new Map(Object.entries(raw.classes).map(([k, samples]) =>
    [k, samples.map(s => ({ ...s, its: s.its.map(v => new Float32Array(v)) }))]
  )) };
  console.log(`  ${cache.classes.size} classes`);
} else {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  BIG WAVE — CAT02 clamp + multi-fixation training/testing ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  cache = { classes: new Map() };
  const t0 = performance.now();
  let done = 0;

  console.log("\n══ Precompute memes ══");
  for (const meme of MEMES) {
    const dir = `${MEME_ROOT}/${meme}`;
    const files = fs.readdirSync(dir).filter(f => /\.(jpe?g|png)$/i.test(f)).sort();
    const samples = [];
    for (const f of files) {
      try {
        const rgb = await extractImageRGB(`${dir}/${f}`, { maxSize: 96 });
        const its = await itsOfFrame(rgb);
        samples.push({ file: f, its });
        done++;
      } catch (e) { /* skip */ }
    }
    cache.classes.set(meme, samples);
    if (samples.length > 0) {
      const dt = ((performance.now() - t0) / 1000).toFixed(0);
      console.log(`  ${meme.padEnd(48)} ${samples.length} samples (${done} caps, ${dt}s)`);
    }
  }

  console.log("\n══ Precompute fixtures × 6 lighting ══");
  for (const [name, p] of Object.entries(FIXTURES)) {
    if (!fs.existsSync(p)) continue;
    const rgb = await extractImageRGB(p, { maxSize: 96 });
    const samples = [];
    for (const light of LIGHTS) {
      const lit = applyLight(rgb, light);
      const its = await itsOfFrame(lit);
      samples.push({ file: light, its });
      done++;
    }
    cache.classes.set(name, samples);
    const dt = ((performance.now() - t0) / 1000).toFixed(0);
    console.log(`  ${name.padEnd(48)} ${samples.length} samples (${done} caps, ${dt}s)`);
  }
  console.log(`  Total: ${done} captures in ${((performance.now() - t0) / 1000).toFixed(0)}s`);

  const serializable = { classes: {} };
  for (const [k, samples] of cache.classes) {
    serializable.classes[k] = samples.map(s => ({
      file: s.file,
      its: s.its.map(v => Array.from(v)),
    }));
  }
  fs.writeFileSync(CACHE_PATH, JSON.stringify(serializable));
  console.log(`  Cache saved`);
}

// Leave-one-out recognition with MULTI-FIXATION query
console.log("\n══ Recognition (leave-one-out, multi-fixation query, ANY-vs-ANY sim) ══");
const classes_arr = Array.from(cache.classes.keys());
let correct = 0, total = 0, uncertain = 0;
const failures = [];
for (const cls of classes_arr) {
  const samples = cache.classes.get(cls);
  if (samples.length < 2) continue;
  for (let held_idx = 0; held_idx < samples.length; held_idx++) {
    const query_its = samples[held_idx].its;   // 4 vectors
    let bestLabel = null, bestSim = -Infinity, secondSim = -Infinity;
    for (const otherCls of classes_arr) {
      const otherSamples = cache.classes.get(otherCls);
      let famBest = -Infinity;
      for (let j = 0; j < otherSamples.length; j++) {
        if (otherCls === cls && j === held_idx) continue;
        for (const trainVec of otherSamples[j].its) {
          for (const queryVec of query_its) {
            const s = itVariantSim(queryVec, trainVec);
            if (s > famBest) famBest = s;
          }
        }
      }
      if (famBest > bestSim) {
        secondSim = bestSim;
        bestSim = famBest; bestLabel = otherCls;
      } else if (famBest > secondSim) {
        secondSim = famBest;
      }
    }
    total++;
    const margin = bestSim - secondSim;
    const REJECT_MARGIN = 0.005;   // very low bar; only reject if truly indistinguishable
    if (margin < REJECT_MARGIN) {
      uncertain++;
      // Still count against correct/total
      if (bestLabel === cls) correct++;
    } else {
      if (bestLabel === cls) correct++;
      else failures.push({ cls, held: samples[held_idx].file, predicted: bestLabel, margin });
    }
  }
}

console.log(`\n══════ FINAL ══════`);
console.log(`  Recognition: ${correct}/${total} = ${(correct / total * 100).toFixed(1)}%`);
console.log(`  Uncertain (razor-thin margin < 0.005): ${uncertain}`);
console.log(`  Failures: ${failures.length}`);

// Failure pattern
const failMap = new Map();
for (const f of failures) {
  const key = `${f.cls} → ${f.predicted}`;
  failMap.set(key, (failMap.get(key) || 0) + 1);
}
const sorted = Array.from(failMap.entries()).sort((a, b) => b[1] - a[1]);
console.log(`\n  Top confusions:`);
for (const [key, count] of sorted.slice(0, 20)) console.log(`    ${count}x  ${key}`);

fs.writeFileSync(path.join(OUT, "_bigwave_results.json"), JSON.stringify({
  correct, total, uncertain, failures,
  rate: correct / total,
}, null, 2));
console.log(`\n  Results: ${path.join(OUT, "_bigwave_results.json")}`);
