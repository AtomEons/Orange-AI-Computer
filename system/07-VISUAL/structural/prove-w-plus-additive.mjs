#!/usr/bin/env bun
// prove-w-plus-additive.mjs — Edison/Tesla method: hold W, test W+n additively.
//
// Protocol:
//   1. Capture all 19-class × 6-lighting = 114 samples ONCE. Cache inputs.
//   2. Score baseline W (80-D IT) → 17/19 baseline confirmed.
//   3. For each W+n variant, rebuild IT from cached inputs (millisecond),
//      score against cached test set, compare to W.
//   4. Report each variant vs W: correct count, delta, verdict.
//   5. Winners identified. Next round: stack winners (W+w+1).

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { buildITVariant, itVariantSim } from "./eye/it-variants.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/w-plus-additive";
fs.mkdirSync(OUT, { recursive: true });

const CLASSES = [
  { name: "apple", paths: [`${FIX}/apple.jpg`] },
  { name: "baboon", paths: [`${FIX}/baboon.jpg`] },
  { name: "basketball", paths: [`${FIX}/basketball1.png`, `${FIX}/basketball2.png`] },
  { name: "board", paths: [`${FIX}/board.jpg`] },
  { name: "building", paths: [`${FIX}/building.jpg`] },
  { name: "butterfly", paths: [`${FIX}/butterfly.jpg`] },
  { name: "fruits", paths: [`${FIX}/fruits.jpg`] },
  { name: "home", paths: [`${FIX}/home.jpg`] },
  { name: "lena", paths: [`${FIX}/lena.jpg`] },
  { name: "messi5", paths: [`${FIX}/messi5.jpg`] },
  { name: "orange", paths: [`${FIX}/orange.jpg`] },
  { name: "pic1", paths: [`${FIX}/pic1.png`] },
  { name: "pic2", paths: [`${FIX}/pic2.png`] },
  { name: "pic3", paths: [`${FIX}/pic3.png`] },
  { name: "pic4", paths: [`${FIX}/pic4.png`] },
  { name: "pic5", paths: [`${FIX}/pic5.png`] },
  { name: "pic6", paths: [`${FIX}/pic6.png`] },
  { name: "starry_night", paths: [`${FIX}/starry_night.jpg`] },
  { name: "notes", paths: [`${FIX}/notes.png`] },
];
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

/** Extract only the CACHEABLE inputs from a canonical (no big arrays). */
function extractInputs(can, RAD_BINS = 32) {
  // Extract RG/BY radial for it-variants
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
  const rProf = buildRadial(0);
  const rgProf = buildRadial(1);
  const byProf = buildRadial(2);

  return {
    lgnFlat: can.lgn.flat,
    v1Summary: can.v1_summary,
    v2Summary: can.v2_summary,
    v4Summary: can.v4_summary,
    ilcRProf: rProf,
    ilcRgProf: rgProf,
    ilcByProf: byProf,
    axisBundle: can.axis_bundle,
  };
}

console.log("╔══════════════════════════════════════════════════════════╗");
console.log("║  W+n EDISON/TESLA — hold winner, test additive candidates ║");
console.log("╚══════════════════════════════════════════════════════════╝");

const classes_arr = CLASSES.map(c => c.name);
const heldOutFor = (name) => LIGHTS[classes_arr.indexOf(name) % LIGHTS.length];

const CACHE_PATH = path.join(OUT, "_input_cache.json");

// Load cache from disk if available; else compute
let cache;
if (fs.existsSync(CACHE_PATH)) {
  console.log(`\n══ Loading cached inputs from ${CACHE_PATH} ══`);
  const raw = JSON.parse(fs.readFileSync(CACHE_PATH, "utf8"));
  cache = {
    train: new Map(Object.entries(raw.train)),
    test: raw.test,
  };
  console.log(`  ${cache.test.length} test + ${Array.from(cache.train.values()).reduce((s,a)=>s+a.length,0)} train inputs loaded`);
} else {
  console.log("\n══ Precompute canonicals (once) ══");
  cache = { train: new Map(), test: [] };
  const t0 = performance.now();
  let done = 0;
  for (const c of CLASSES) {
    cache.train.set(c.name, []);
    const held = heldOutFor(c.name);
    for (let vi = 0; vi < c.paths.length; vi++) {
      const p = c.paths[vi];
      if (!fs.existsSync(p)) continue;
      const rgb = await extractImageRGB(p, { maxSize: 192 });
      for (const light of LIGHTS) {
        const lit = applyLight(rgb, light);
        const can = captureCanonicalPhoton(lit, { x: 0, y: 0, w: lit.width, h: lit.height });
        const inputs = extractInputs(can);
        done++;
        if (light === held && vi === 0) {
          cache.test.push({ class: c.name, held_condition: held, inputs });
        } else {
          cache.train.get(c.name).push({ inputs, condition: light + "_v" + vi });
        }
      }
    }
    const t_now = performance.now();
    console.log(`  ${c.name.padEnd(14)} cached (${done} samples, ${((t_now - t0) / 1000).toFixed(0)}s)`);
  }
  console.log(`  Total cache: ${((performance.now() - t0) / 1000).toFixed(0)}s`);
  // Save cache
  const serializable = {
    train: Object.fromEntries(cache.train),
    test: cache.test,
  };
  fs.writeFileSync(CACHE_PATH, JSON.stringify(serializable));
  console.log(`  Cache saved to ${CACHE_PATH}`);
}

// Now run W and all W+n variants — FAST because just IT rebuild + cosine sim
function scoreVariant(variant) {
  const trainVecs = new Map();
  for (const [label, members] of cache.train) {
    trainVecs.set(label, members.map(m => buildITVariant(m.inputs, variant)));
  }
  let correct = 0, total = 0;
  const failures = [];
  for (const t of cache.test) {
    const query = buildITVariant(t.inputs, variant);
    let bestLabel = null, bestSim = -Infinity, secondSim = -Infinity, secondLabel = null;
    for (const [label, vecs] of trainVecs) {
      let famBest = -Infinity;
      for (const v of vecs) {
        const s = itVariantSim(query, v);
        if (s > famBest) famBest = s;
      }
      if (famBest > bestSim) {
        secondSim = bestSim; secondLabel = bestLabel;
        bestSim = famBest; bestLabel = label;
      } else if (famBest > secondSim) {
        secondSim = famBest; secondLabel = label;
      }
    }
    total++;
    if (bestLabel === t.class) correct++;
    else failures.push({ class: t.class, held: t.held_condition, predicted: bestLabel, margin: bestSim - secondSim });
  }
  return { variant, correct, total, failures };
}

const VARIANTS = [
  "W",
  "W+1_fm_head",
  "W+GRAND_1",
  "W+GRAND_2",
  "W+GRAND_3",
  "W+GRAND_4",
  "W+ALL_WINNERS",
  "W+FOCUSED_starrynight",
  "W+narrow_LGN_only",
];

console.log("\n══ W baseline + 12 additive candidates ══");
const results = {};
let W_correct = null;
for (const v of VARIANTS) {
  const r = scoreVariant(v);
  results[v] = r;
  if (v === "W") W_correct = r.correct;
  const delta = W_correct === null ? "" : (r.correct > W_correct ? `+${r.correct - W_correct}` : r.correct < W_correct ? `${r.correct - W_correct}` : "±0");
  const verdict = W_correct === null ? "BASELINE" : r.correct > W_correct ? "WINNER" : r.correct === W_correct ? "TIE" : "LOSER";
  console.log(`  ${v.padEnd(28)}  ${r.correct}/${r.total}  Δ=${delta.padEnd(3)}  ${verdict}`);
  if (r.failures.length > 0) {
    for (const f of r.failures) {
      console.log(`      FAIL ${f.class.padEnd(14)}× ${f.held.padEnd(6)} → ${f.predicted.padEnd(14)} (margin ${f.margin.toFixed(3)})`);
    }
  }
}

fs.writeFileSync(path.join(OUT, "_variant_results.json"), JSON.stringify(results, null, 2));
console.log(`\n  Results: ${path.join(OUT, "_variant_results.json")}`);

// Identify winners for next-round stacking
const winners = Object.values(results).filter(r => r.variant !== "W" && r.correct > W_correct);
if (winners.length > 0) {
  console.log(`\n  WINNERS (${winners.length}):`);
  for (const w of winners) console.log(`    ${w.variant}  (${w.correct}/${w.total}, Δ=+${w.correct - W_correct})`);
  console.log(`  → Next round: stack these into W+w+1 candidates`);
} else {
  console.log(`\n  No single W+n winner beat W=${W_correct}. Consider W+w+n (stack two winners) or new candidate class.`);
}
