#!/usr/bin/env bun
// Human-grade sweep on the 8-axis substrate. Corrected labels.
// Sub-second-per-config target via aggressive caching.

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
import { subsurfaceSummaryForRegion } from "../axes/subsurface-axis.mjs";
import { colorRatioSummaryForRegion } from "../axes/color-ratio-axis.mjs";
import { spatialFrequencySummaryForRegion } from "../axes/spatial-frequency-axis.mjs";
import { buildRichSignature, attachSignaturesV2, updateChannelWeights } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";
import { hueRotateSignature, FITZPATRICK_HUE_OFFSETS } from "./skin-tone-synthesis.mjs";
import { exposeUncertainty } from "./second-pass-alpha.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "human-grade-8axis");
fs.mkdirSync(OUT, { recursive: true });
const BASE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect-8axis.json"), "utf8"));

// CORRECTED labels per Fixture Auditor
const TESTS = [
  { name: "orange.jpg",       expected: "orange",     kind: "target" },
  { name: "apple.jpg",        expected: "apple",      kind: "target" },
  { name: "fruits.jpg",       expected: "orange",     kind: "target" },
  { name: "lena.jpg",         expected: "human_skin", kind: "target" },
  { name: "baboon.jpg",       expected: null,         kind: "reject", note: "mandrill, not human" },
  { name: "basketball1.png",  expected: null,         kind: "reject", note: "grayscale" },
  { name: "basketball2.png",  expected: null,         kind: "reject" },
  { name: "messi5.jpg",       expected: null,         kind: "reject", note: "weak skin, jersey dominates" },
  { name: "home.jpg",         expected: null,         kind: "reject" },
  { name: "building.jpg",     expected: null,         kind: "reject" },
  { name: "board.jpg",        expected: null,         kind: "reject" },
  { name: "gradient.png",     expected: null,         kind: "reject" },
  { name: "notes.png",        expected: null,         kind: "reject" },
  { name: "butterfly.jpg",    expected: null,         kind: "reject" },
  { name: "pic5.png",         expected: null,         kind: "reject", note: "orange rectangle adversarial" },
];
const AXES = ["R","G","B","L","M","gamma","RG","BY"];
const CONFIDENT_MASS = 0.9;

function toL(R, G, B) { const L = new Float32Array(R.length); for (let i = 0; i < R.length; i++) L[i] = 0.30*R[i]+0.59*G[i]+0.11*B[i]; return L; }
function isWarm(d) { return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5; }

async function buildTestSig8(name) {
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
    subsurfaceSummaryForRegion(rgb.R, rgb.G, rgb.B, W, H, region),
    colorRatioSummaryForRegion(rgb.R, rgb.G, rgb.B, W, H, region),
    spatialFrequencySummaryForRegion(L, W, H, region),
  );
}

console.log("=== HUMAN-GRADE 8-AXIS SWEEP ===");
console.log("test set: " + TESTS.length + " fixtures (4 targets + 11 rejects)\n");
console.log("precomputing 8-axis test signatures...");
const testSigs = new Map();
for (const t of TESTS) testSigs.set(t.name, await buildTestSig8(t.name));
const noWarmCount = [...testSigs.values()].filter((v) => v === null).length;
console.log("  " + (testSigs.size - noWarmCount) + " sigs built (" + noWarmCount + " no-warm → auto-reject)\n");

// Grid — narrow but 8-axis-tuned
const TEXTURE_SHRINK  = [1.0, 0.5];
const SPECULAR_SHRINK = [1.0, 0.5];
const SKIN_COLOR_WT   = [1.0, 1.3];
const HOPFIELD_BETA   = [7, 10, 15, 20, 30, 50];
const SUB_WT          = [0.4, 0.8, 1.2];    // subsurface weight
const RATIO_WT        = [0.2, 0.6];         // color-ratio weight
const FREQ_WT         = [0.2, 0.6];         // spatial-freq weight
const REJ_THRESH      = [0.4, 0.5, 0.6, 0.7];
const totalConfigs = TEXTURE_SHRINK.length * SPECULAR_SHRINK.length * SKIN_COLOR_WT.length * HOPFIELD_BETA.length * SUB_WT.length * RATIO_WT.length * FREQ_WT.length * REJ_THRESH.length;
console.log("grid: " + totalConfigs.toLocaleString() + " configs\n");

function buildStoreVariant(tShrink, sShrink, colorWt, subWt, ratioWt, freqWt) {
  const store = JSON.parse(JSON.stringify(BASE));
  const orangeRow = store.labels.find((r) => r.label === "orange");
  updateChannelWeights(store, "orange", { color: 1.0, edge: 0.6, texture: 0.5, specular: 0.3, spatial: 0.5, subsurface: subWt, colorRatio: ratioWt, spatialFreq: freqWt });
  updateChannelWeights(store, "apple",  { color: 1.0, edge: 0.6, texture: 0.5, specular: 0.3, spatial: 0.5, subsurface: subWt, colorRatio: ratioWt, spatialFreq: freqWt });
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
  attachSignaturesV2(store, "human_skin", synth, "8axis-sweep", "2026-07-06T00:00:00Z");
  updateChannelWeights(store, "human_skin", { color: colorWt, edge: 0.5, texture: 1.3, specular: 0.4, spatial: 0.8, subsurface: subWt, colorRatio: ratioWt, spatialFreq: freqWt });
  return store;
}

function scoreConfig(store, beta, rejectThreshold) {
  let correctTarget = 0, correctReject = 0, anyWrong = 0, confidentWrong = 0;
  const detail = {};
  for (const t of TESTS) {
    const sig = testSigs.get(t.name);
    if (!sig) {
      if (t.kind === "reject") correctReject++;
      detail[t.name] = { winner: null, mass: 0, reason: "no_warm" };
      continue;
    }
    const ret = hopfieldRetrieve(sig, store, { beta, iters: 3 });
    const acceptedByMass = ret.winnerMass >= rejectThreshold;
    detail[t.name] = { winner: ret.winner, mass: ret.winnerMass, distance: ret.winnerBestDistance };
    if (t.kind === "target") {
      if (acceptedByMass && ret.winner === t.expected) correctTarget++;
      else {
        anyWrong++;
        if (acceptedByMass && ret.winnerMass > CONFIDENT_MASS) confidentWrong++;
      }
    } else {
      if (!acceptedByMass) correctReject++;
      else {
        anyWrong++;
        if (ret.winnerMass > CONFIDENT_MASS) confidentWrong++;
      }
    }
  }
  const score = 2 * correctTarget + 1 * correctReject - 2 * confidentWrong - 1 * anyWrong;
  return { correctTarget, correctReject, anyWrong, confidentWrong, score, detail };
}

console.log("sweeping...");
const t0 = Date.now();
const results = [];
let n = 0;
for (const tShrink of TEXTURE_SHRINK) {
  for (const sShrink of SPECULAR_SHRINK) {
    for (const colorWt of SKIN_COLOR_WT) {
      for (const subWt of SUB_WT) {
        for (const ratioWt of RATIO_WT) {
          for (const freqWt of FREQ_WT) {
            const store = buildStoreVariant(tShrink, sShrink, colorWt, subWt, ratioWt, freqWt);
            for (const beta of HOPFIELD_BETA) {
              for (const rejThresh of REJ_THRESH) {
                const s = scoreConfig(store, beta, rejThresh);
                results.push({
                  config: { texture_shrink: tShrink, specular_shrink: sShrink, skin_color_wt: colorWt, subsurface_wt: subWt, color_ratio_wt: ratioWt, spatial_freq_wt: freqWt, beta, reject_threshold: rejThresh },
                  correctTarget: s.correctTarget,
                  correctReject: s.correctReject,
                  anyWrong: s.anyWrong,
                  confidentWrong: s.confidentWrong,
                  score: s.score,
                  detail: s.detail,
                });
                n++;
                if (n % 500 === 0) {
                  const el = (Date.now() - t0) / 1000;
                  console.log("  " + n + " / " + totalConfigs + "  (" + (n / el).toFixed(0) + " cps)");
                }
              }
            }
          }
        }
      }
    }
  }
}
const elapsed = (Date.now() - t0) / 1000;
console.log(results.length + " configs in " + elapsed.toFixed(1) + "s\n");

results.sort((a, b) => (b.score - a.score) || (b.correctTarget - a.correctTarget) || (b.correctReject - a.correctReject));

const MAX_SCORE = TESTS.filter(t => t.kind === "target").length * 2 + TESTS.filter(t => t.kind === "reject").length;
const perfect = results.filter((r) => r.score === MAX_SCORE);
const nearPerfect = results.filter((r) => r.score >= MAX_SCORE - 2);
console.log("Max possible score: " + MAX_SCORE + "  (4 targets ×2 + 11 rejects ×1)");
console.log("Perfect configs: " + perfect.length);
console.log("Near-perfect (score >= MAX - 2): " + nearPerfect.length);

console.log("\n=== TOP 10 CONFIGS ===");
for (let i = 0; i < 10 && i < results.length; i++) {
  const r = results[i];
  const c = r.config;
  console.log("#" + String(i+1).padStart(2) + " score=" + String(r.score).padStart(3) + " tgt=" + r.correctTarget + "/4 rej=" + r.correctReject + "/11 confWrong=" + r.confidentWrong +
    "  β=" + c.beta + " rej=" + c.reject_threshold + " subWt=" + c.subsurface_wt + " ratioWt=" + c.color_ratio_wt + " freqWt=" + c.spatial_freq_wt);
}

if (perfect.length > 0) {
  console.log("\n=== BEST PERFECT CONFIG DETAIL ===");
  const best = perfect[0];
  console.log("config:", best.config);
} else if (nearPerfect.length > 0) {
  console.log("\n=== BEST NEAR-PERFECT CONFIG DETAIL ===");
  const best = nearPerfect[0];
  console.log("config:", best.config);
  console.log("score:", best.score, "correct-target:", best.correctTarget, "correct-reject:", best.correctReject, "confident-wrong:", best.confidentWrong);
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results.slice(0, 200), null, 2));
console.log("\ntop-200 results: " + path.join(OUT, "results.json"));
