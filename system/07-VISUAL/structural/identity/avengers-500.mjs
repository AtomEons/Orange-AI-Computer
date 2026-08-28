#!/usr/bin/env bun
// AVENGERS 500 — puzzle-solving grid search across the skin-tone synthesis + recognition stack.
//
// Grid:
//   texture_shrink  : [1.0, 0.7, 0.5, 0.3, 0.15]         (5) — skin peel-bumpiness
//   specular_shrink : [1.0, 0.7, 0.5, 0.3, 0.15]         (5) — skin glossiness
//   skin_color_wt   : [0.8, 1.0, 1.2, 1.5]               (4) — chromatic emphasis on skin
//   Hopfield_beta   : [2, 5, 10, 20, 40]                 (5) — attractor sharpness
//
// Total: 5 × 5 × 4 × 5 = 500 configs
//
// Test set: orange.jpg → orange, apple.jpg → apple, fruits.jpg → orange, lena.jpg → human_skin
//
// Scoring per config:
//   +1 per correct top-1  (max 4)
//   +0.5 per decisive verdict (mass > 0.6 AND uncertainty < 0.4)
//   -1 per spurious human_skin match on orange.jpg / apple.jpg / fruits.jpg
//
// Precompute 4 test rich-sigs ONCE (they don't depend on config), rebuild
// store per (texture, specular) variant (25 variants), sweep recognition
// weights (20 per store).

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { computeDescriptor, computeUnionDescriptor } from "./descriptor.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { buildRichSignature, attachSignaturesV2, updateChannelWeights, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";
import { hueRotateSignature, FITZPATRICK_HUE_OFFSETS } from "./skin-tone-synthesis.mjs";
import { exposeUncertainty } from "./second-pass-alpha.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "avengers-500");
fs.mkdirSync(OUT, { recursive: true });
const BASE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect.json"), "utf8"));

const TESTS = [
  { name: "orange.jpg", expected: "orange" },
  { name: "apple.jpg",  expected: "apple" },
  { name: "fruits.jpg", expected: "orange" },
  { name: "lena.jpg",   expected: "human_skin" },
];
const AXES = ["R","G","B","L","M","gamma","RG","BY"];

// ── Precompute test rich sigs ──
function toL(R, G, B) {
  const N = R.length;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  return L;
}
function isWarm(d) {
  return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5;
}
async function buildTestSig(name) {
  const rgb = await extractImageRGB(path.join(FIXTURES, name), { maxSize: 384 });
  const W = rgb.width, H = rgb.height;
  const combo = attentionMultiAxisV2(rgb.R, rgb.G, rgb.B, W, H, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const warm = [];
  for (const e of combo.entities) {
    const d = computeDescriptor(e.region, rgb.R, rgb.G, rgb.B, W, H);
    if (isWarm(d)) warm.push(e);
  }
  if (!warm.length) return null;
  const colorDesc = computeUnionDescriptor(warm.map((x) => x.region), rgb.R, rgb.G, rgb.B, W, H);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of warm) {
    if (e.region[0] < x0) x0 = e.region[0];
    if (e.region[1] < y0) y0 = e.region[1];
    if (e.region[0] + e.region[2] > x1) x1 = e.region[0] + e.region[2];
    if (e.region[1] + e.region[3] > y1) y1 = e.region[1] + e.region[3];
  }
  const region = [x0, y0, x1 - x0, y1 - y0];
  const L = toL(rgb.R, rgb.G, rgb.B);
  return buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, W, H, region),
    textureSummaryForRegion(L, W, H, region),
    specularSummaryForRegion(L, W, H, region),
    spatialColorSummaryForRegion(rgb.R, rgb.G, rgb.B, W, H, region),
  );
}

console.log("=== AVENGERS 500 ===");
console.log("precomputing 4 test signatures...");
const testSigs = {};
for (const t of TESTS) testSigs[t.name] = await buildTestSig(t.name);
console.log("  built " + Object.values(testSigs).filter(Boolean).length + "/4 test sigs\n");

// ── Grid ──
const TEXTURE_SHRINK = [1.0, 0.7, 0.5, 0.3, 0.15];
const SPECULAR_SHRINK = [1.0, 0.7, 0.5, 0.3, 0.15];
const SKIN_COLOR_WT = [0.8, 1.0, 1.2, 1.5];
const HOPFIELD_BETA = [2, 5, 10, 20, 40];

// Build a store variant with skin synthesized under (tShrink, sShrink)
function buildStoreVariant(tShrink, sShrink, colorWt) {
  const store = JSON.parse(JSON.stringify(BASE));  // clone
  const orangeRow = store.labels.find((r) => r.label === "orange");
  const synth = [];
  for (const off of FITZPATRICK_HUE_OFFSETS) {
    for (const s of orangeRow.signatures) {
      const rot = hueRotateSignature(s.sig, off.rad);
      // Non-color perturbation: skin is smoother + less glossy than orange peel
      rot.texture.meanVariance *= tShrink;
      rot.specular.glossinessScore *= sShrink;
      rot.specular.brightFraction *= sShrink;
      rot.specular.cov *= (0.7 + 0.3 * sShrink);
      synth.push(rot);
    }
  }
  attachSignaturesV2(store, "human_skin", synth, "avengers-500", "2026-07-06T00:00:00Z");
  updateChannelWeights(store, "human_skin", {
    color:    colorWt,
    edge:     0.5,
    texture:  1.3,
    specular: 0.4,
    spatial:  0.8,
  });
  return store;
}

// Score a config against the 4 test sigs at a given β
function scoreConfig(store, beta) {
  let correct = 0, decisive = 0, spuriousSkin = 0;
  const detail = {};
  for (const t of TESTS) {
    const sig = testSigs[t.name];
    if (!sig) { detail[t.name] = { skip: true }; continue; }
    const ret = hopfieldRetrieve(sig, store, { beta, iters: 3 });
    const unc = exposeUncertainty(ret);
    detail[t.name] = { winner: ret.winner, mass: ret.winnerMass, uncertainty: unc.uncertainty, verdict: unc.verdict };
    if (ret.winner === t.expected) correct++;
    if (unc.verdict === "decisive") decisive++;
    if (t.name !== "lena.jpg" && ret.winner === "human_skin") spuriousSkin++;
  }
  const score = correct + 0.5 * decisive - 1.0 * spuriousSkin;
  return { correct, decisive, spuriousSkin, score, detail };
}

// ── Sweep ──
console.log("running 500-config grid...\n");
const results = [];
const t0 = Date.now();
let n = 0;
for (const tShrink of TEXTURE_SHRINK) {
  for (const sShrink of SPECULAR_SHRINK) {
    for (const colorWt of SKIN_COLOR_WT) {
      const store = buildStoreVariant(tShrink, sShrink, colorWt);
      for (const beta of HOPFIELD_BETA) {
        const s = scoreConfig(store, beta);
        results.push({
          config: { texture_shrink: tShrink, specular_shrink: sShrink, skin_color_wt: colorWt, beta },
          ...s,
        });
        n++;
      }
    }
  }
}
const elapsed = (Date.now() - t0) / 1000;
console.log("500 configs swept in " + elapsed.toFixed(1) + "s (" + (500/elapsed).toFixed(0) + " configs/sec)");

// ── Ranking ──
results.sort((a, b) => (b.score - a.score) || (b.correct - a.correct) || (b.decisive - a.decisive));

const perfect = results.filter((r) => r.correct === 4);
const spuriousFree = results.filter((r) => r.spuriousSkin === 0);
console.log("\n=== SCORE DISTRIBUTION ===");
const scoreCounts = {};
for (const r of results) scoreCounts[r.correct + "/4"] = (scoreCounts[r.correct + "/4"] || 0) + 1;
for (const [k, v] of Object.entries(scoreCounts).sort()) console.log("  " + k + " correct: " + v + " configs");
console.log("\n" + perfect.length + " configs hit 4/4");
console.log(spuriousFree.length + " configs are spurious-skin-free\n");

console.log("=== TOP 15 CONFIGS ===");
for (let i = 0; i < 15 && i < results.length; i++) {
  const r = results[i];
  const c = r.config;
  console.log(
    "#" + String(i + 1).padStart(2) +
    " score=" + r.score.toFixed(1).padStart(4) +
    " correct=" + r.correct + "/4" +
    " decisive=" + r.decisive + "/4" +
    " spuriousSkin=" + r.spuriousSkin +
    "  tShrink=" + c.texture_shrink + " sShrink=" + c.specular_shrink + " colorWt=" + c.skin_color_wt + " β=" + c.beta,
  );
}

if (perfect.length > 0) {
  console.log("\n=== BEST 4/4 CONFIG DETAIL ===");
  const best = perfect[0];
  console.log("config: tShrink=" + best.config.texture_shrink + " sShrink=" + best.config.specular_shrink + " colorWt=" + best.config.skin_color_wt + " β=" + best.config.beta);
  for (const t of TESTS) {
    const d = best.detail[t.name];
    console.log("  " + t.name.padEnd(15) + " expected " + t.expected.padEnd(12) + " → " + d.winner.padEnd(12) + " mass=" + d.mass.toFixed(3) + " (" + d.verdict + ")");
  }
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results.slice(0, 100), null, 2));
console.log("\ntop-100 results: " + path.join(OUT, "results.json"));
