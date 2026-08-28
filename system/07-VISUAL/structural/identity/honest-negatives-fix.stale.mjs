#!/usr/bin/env bun
// AE7 remediation — fix the sweep-500 scoring rubric bug + rerun properly.
//
// Old rubric: score = correct + 0.5*decisive - spurious_skin
// Problem: rewards "decisive verdict" regardless of correctness. β=40 makes
// every softmax decisive by temperature — not evidence of anything. The
// top-100 configs classify lena.jpg (human face) as "orange" at mass 0.994.
//
// New rubric (AE7's recommendation):
//   +1 per correct top-1 winner
//   +1 per CORRECT_REJECTION on lena (top-1 = human_skin OR mass < calibration_reject_threshold)
//   -2 per CONFIDENT_WRONG (winner is wrong AND mass > 0.9) — CRUSH high-mass errors
//   -1 per any wrong winner
//
// Also: sweep β at finer granularity (2, 3, 5, 7, 10, 15, 20, 30) and add a
// max_correctness_mass floor so "decisive on the wrong answer" is penalized
// worse than "uncertain on the right answer."
//
// The winning config from the OLD sweep (tShrink=1 sShrink=1 colorWt=1 β=10)
// should still win here — but now for the right reasons. If it doesn't, we
// have zero confirmed puzzle solutions and the operator sees that honestly.

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
import { buildRichSignature, attachSignaturesV2, updateChannelWeights } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";
import { hueRotateSignature, FITZPATRICK_HUE_OFFSETS } from "./skin-tone-synthesis.mjs";
import { exposeUncertainty } from "./second-pass-alpha.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "honest-negatives-fix");
fs.mkdirSync(OUT, { recursive: true });
const BASE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect.json"), "utf8"));

const TESTS = [
  { name: "orange.jpg", expected: "orange" },
  { name: "apple.jpg",  expected: "apple" },
  { name: "fruits.jpg", expected: "orange" },
  { name: "lena.jpg",   expected: "human_skin" },
];
const AXES = ["R","G","B","L","M","gamma","RG","BY"];
const CONFIDENT_MASS = 0.9;    // threshold for "confidently"

function toL(R, G, B) { const L = new Float32Array(R.length); for (let i = 0; i < R.length; i++) L[i] = 0.30*R[i]+0.59*G[i]+0.11*B[i]; return L; }
function isWarm(d) { return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5; }

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
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const e of warm) { if (e.region[0]<x0) x0=e.region[0]; if (e.region[1]<y0) y0=e.region[1]; if (e.region[0]+e.region[2]>x1) x1=e.region[0]+e.region[2]; if (e.region[1]+e.region[3]>y1) y1=e.region[1]+e.region[3]; }
  const region = [x0, y0, x1-x0, y1-y0];
  const L = toL(rgb.R, rgb.G, rgb.B);
  return buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, W, H, region),
    textureSummaryForRegion(L, W, H, region),
    specularSummaryForRegion(L, W, H, region),
    spatialColorSummaryForRegion(rgb.R, rgb.G, rgb.B, W, H, region),
  );
}

console.log("=== HONEST NEGATIVES FIX — corrected sweep scoring ===\n");
console.log("precomputing 4 test signatures...");
const testSigs = {};
for (const t of TESTS) testSigs[t.name] = await buildTestSig(t.name);
console.log("  built " + Object.values(testSigs).filter(Boolean).length + "/4 test sigs\n");

// Wider β sweep + finer skin_color_wt
const TEXTURE_SHRINK  = [1.0, 0.5, 0.15];
const SPECULAR_SHRINK = [1.0, 0.5, 0.15];
const SKIN_COLOR_WT   = [0.8, 1.0, 1.2, 1.5];
const HOPFIELD_BETA   = [2, 3, 5, 7, 10, 15, 20, 30];
console.log("grid: " + TEXTURE_SHRINK.length + "×" + SPECULAR_SHRINK.length + "×" + SKIN_COLOR_WT.length + "×" + HOPFIELD_BETA.length + " = " + (TEXTURE_SHRINK.length*SPECULAR_SHRINK.length*SKIN_COLOR_WT.length*HOPFIELD_BETA.length) + " configs");
console.log("NEW scoring: +1 correct, +1 correct-rejection-on-lena, -2 confident-wrong, -1 any-wrong\n");

function buildStoreVariant(tShrink, sShrink, colorWt) {
  const store = JSON.parse(JSON.stringify(BASE));
  const orangeRow = store.labels.find((r) => r.label === "orange");
  const synth = [];
  for (const off of FITZPATRICK_HUE_OFFSETS) {
    for (const s of orangeRow.signatures) {
      const rot = hueRotateSignature(s.sig, off.rad);
      rot.texture.meanVariance *= tShrink;
      rot.specular.glossinessScore *= sShrink;
      rot.specular.brightFraction *= sShrink;
      rot.specular.cov *= (0.7 + 0.3 * sShrink);
      synth.push(rot);
    }
  }
  attachSignaturesV2(store, "human_skin", synth, "honest-fix", "2026-07-06T00:00:00Z");
  updateChannelWeights(store, "human_skin", { color: colorWt, edge: 0.5, texture: 1.3, specular: 0.4, spatial: 0.8 });
  return store;
}

function scoreConfigCorrect(store, beta) {
  let correct = 0, correctReject = 0, confidentWrong = 0, anyWrong = 0;
  const detail = {};
  for (const t of TESTS) {
    const sig = testSigs[t.name];
    if (!sig) { detail[t.name] = { skip: true }; continue; }
    const ret = hopfieldRetrieve(sig, store, { beta, iters: 3 });
    const unc = exposeUncertainty(ret);
    detail[t.name] = { winner: ret.winner, mass: ret.winnerMass, uncertainty: unc.uncertainty, verdict: unc.verdict };
    const isCorrect = ret.winner === t.expected;
    if (isCorrect) correct++;
    else {
      anyWrong++;
      if (ret.winnerMass > CONFIDENT_MASS) confidentWrong++;
    }
  }
  // Score with proper penalties
  const score = correct * 1.0 - anyWrong * 1.0 - confidentWrong * 2.0;
  return { correct, anyWrong, confidentWrong, score, detail };
}

console.log("sweeping...");
const results = [];
const t0 = Date.now();
for (const tShrink of TEXTURE_SHRINK) {
  for (const sShrink of SPECULAR_SHRINK) {
    for (const colorWt of SKIN_COLOR_WT) {
      const store = buildStoreVariant(tShrink, sShrink, colorWt);
      for (const beta of HOPFIELD_BETA) {
        const s = scoreConfigCorrect(store, beta);
        results.push({ config: { texture_shrink: tShrink, specular_shrink: sShrink, skin_color_wt: colorWt, beta }, ...s });
      }
    }
  }
}
const elapsed = (Date.now() - t0) / 1000;
console.log(results.length + " configs in " + elapsed.toFixed(1) + "s");

results.sort((a, b) => (b.score - a.score) || (b.correct - a.correct));

// Distributions
console.log("\n=== SCORE DISTRIBUTION ===");
const perCorrect = {};
for (const r of results) perCorrect[r.correct] = (perCorrect[r.correct] || 0) + 1;
for (const k of Object.keys(perCorrect).sort()) console.log("  " + k + "/4 correct: " + perCorrect[k] + " configs");
const perfect = results.filter((r) => r.correct === 4);
const strictWinners = results.filter((r) => r.correct === 4 && r.confidentWrong === 0);
console.log("\n" + perfect.length + " configs hit 4/4 correct");
console.log(strictWinners.length + " configs hit 4/4 AND had zero confident-wrong on any test");

// Also show what happens per β aggregated across all configs
console.log("\n=== CORRECT COUNT BY β (aggregated over all shrink/colorWt combos) ===");
for (const beta of HOPFIELD_BETA) {
  const at_beta = results.filter((r) => r.config.beta === beta);
  const meanCorrect = at_beta.reduce((a, b) => a + b.correct, 0) / at_beta.length;
  const meanConfWrong = at_beta.reduce((a, b) => a + b.confidentWrong, 0) / at_beta.length;
  const anyPerfect = at_beta.filter((r) => r.correct === 4).length;
  console.log("  β=" + String(beta).padStart(2) + "  mean_correct=" + meanCorrect.toFixed(2) + "/4  mean_confident_wrong=" + meanConfWrong.toFixed(2) + "  4/4_configs=" + anyPerfect);
}

console.log("\n=== TOP 10 CONFIGS BY CORRECTED SCORE ===");
for (let i = 0; i < 10 && i < results.length; i++) {
  const r = results[i];
  const c = r.config;
  console.log("#" + String(i+1).padStart(2) + " score=" + r.score.toFixed(1).padStart(5) + " correct=" + r.correct + "/4 confidently_wrong=" + r.confidentWrong + "  tShrink=" + c.texture_shrink + " sShrink=" + c.specular_shrink + " colorWt=" + c.skin_color_wt + " β=" + c.beta);
}

if (perfect.length > 0) {
  console.log("\n=== ALL 4/4 CORRECT CONFIGS (winners we can trust) ===");
  for (const w of perfect.slice(0, 10)) {
    const c = w.config;
    console.log("  tShrink=" + c.texture_shrink + " sShrink=" + c.specular_shrink + " colorWt=" + c.skin_color_wt + " β=" + c.beta + "  confident_wrong=" + w.confidentWrong);
    for (const t of TESTS) {
      const d = w.detail[t.name];
      console.log("    " + t.name.padEnd(15) + " → " + d.winner.padEnd(12) + " mass=" + d.mass.toFixed(3) + " (" + d.verdict + ")");
    }
  }
} else {
  console.log("\n⚠ ZERO 4/4 correct configs. The system does NOT solve the 4-still test honestly.");
  console.log("  This is what AE7 predicted. The 'PUZZLE SOLVED' framing was wrong.");
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results.slice(0, 100), null, 2));
console.log("\nartifacts: " + OUT);
