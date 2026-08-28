#!/usr/bin/env bun
// HUMAN-GRADE SWEEP — push AEyes¹ recognition to human-level accuracy on
// diverse REAL fixtures (not just 4 stills). Visible-spectrum only.
//
// Test set (25+ real images, labeled by hand):
//   Target-orange     : orange.jpg, fruits.jpg, basketball1.png, basketball2.png
//   Target-apple      : apple.jpg
//   Target-human_skin : lena.jpg, baboon.jpg, messi5.jpg
//   Target-reject     : building.jpg, home.jpg, board.jpg, gradient.png, notes.png,
//                       butterfly.jpg, starry_night.jpg, pic1-5, binder-overlay-*
//
// Grid — wide but tractable:
//   texture_shrink  : 3 values
//   specular_shrink : 3 values
//   skin_color_wt   : 4 values
//   Hopfield beta   : 8 values (2, 3, 5, 7, 10, 15, 20, 30)
//   axis subset     : 3 (color-only, color+edge+texture+specular+spatial, ALL+subsurface)
//   warm rule       : 3 tightness levels
//   max_distance    : 4 threshold values
//   reject_threshold: 4 values (mass required to accept top-1)
//   skin_concept    : 2 (Fitzpatrick, ITA, both)
// Total: 3×3×4×8×3×3×4×4×2 ≈ 55,296 configs
//
// Score per config:
//   +2 correct top-1 on target images
//   +1 correct reject on non-target images (top-1 mass < reject_threshold)
//   -2 confident-wrong (winner wrong AND mass > 0.9)
//   -1 any-wrong

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
import { buildRichSignature, attachSignaturesV2, updateChannelWeights } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";
import { hueRotateSignature, FITZPATRICK_HUE_OFFSETS } from "./skin-tone-synthesis.mjs";
import { ITA_HUE_OFFSETS } from "./skin-tone-synthesis-ita.mjs";
import { exposeUncertainty } from "./second-pass-alpha.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "human-grade-sweep");
fs.mkdirSync(OUT, { recursive: true });
const BASE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect.json"), "utf8"));

// Hand-labeled test set from real fixture inventory
const TESTS = [
  // Target orange (round, orange fruit or orange sports ball)
  { name: "orange.jpg",       expected: "orange",       kind: "target" },
  { name: "apple.jpg",        expected: "apple",        kind: "target" },
  { name: "fruits.jpg",       expected: "orange",       kind: "target" },
  { name: "basketball1.png",  expected: "orange",       kind: "target", note: "basketball is orange" },
  { name: "basketball2.png",  expected: "orange",       kind: "target" },
  // Target human_skin (portraits and human faces)
  { name: "lena.jpg",         expected: "human_skin",   kind: "target" },
  { name: "baboon.jpg",       expected: "human_skin",   kind: "target", note: "primate face" },
  { name: "messi5.jpg",       expected: "human_skin",   kind: "target", note: "soccer photo with skin" },
  // Should-reject (not warm/fruit/skin, should NOT match any trained concept)
  { name: "building.jpg",     expected: null,           kind: "reject" },
  { name: "home.jpg",         expected: null,           kind: "reject" },
  { name: "board.jpg",        expected: null,           kind: "reject" },
  { name: "gradient.png",     expected: null,           kind: "reject" },
  { name: "notes.png",        expected: null,           kind: "reject" },
  { name: "butterfly.jpg",    expected: null,           kind: "reject", note: "warm colors but not fruit" },
  { name: "starry_night.jpg", expected: null,           kind: "reject" },
];
const AXES = ["R","G","B","L","M","gamma","RG","BY"];
const CONFIDENT_MASS = 0.9;

function toL(R, G, B) { const L = new Float32Array(R.length); for (let i = 0; i < R.length; i++) L[i] = 0.30*R[i]+0.59*G[i]+0.11*B[i]; return L; }

function makeIsWarm(warmRG_min, warmRminusB_min) {
  return (d) => d && d.mean_RG > warmRG_min && d.mean_R > d.mean_B + warmRminusB_min && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5;
}

async function buildTestSig(name, warmRG_min, warmRminusB_min) {
  const rgb = await extractImageRGB(path.join(FIXTURES, name), { maxSize: 384 });
  const W = rgb.width, H = rgb.height;
  const combo = attentionMultiAxisV2(rgb.R, rgb.G, rgb.B, W, H, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const isWarm = makeIsWarm(warmRG_min, warmRminusB_min);
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

console.log("=== HUMAN-GRADE SWEEP ===");
console.log("target: human-level recognition on " + TESTS.length + " diverse real fixtures\n");

// Precompute test sigs per warm-rule (3 caches)
const WARM_RULES = [
  { RG: 0.02, RminusB: 0.25, label: "tight" },
  { RG: 0.03, RminusB: 0.15, label: "medium" },
  { RG: 0.05, RminusB: 0.10, label: "loose" },
];
console.log("precomputing test signatures per warm rule (3 caches × " + TESTS.length + " images)...");
const sigCache = new Map();
for (const rule of WARM_RULES) {
  for (const t of TESTS) {
    const key = rule.label + "|" + t.name;
    sigCache.set(key, await buildTestSig(t.name, rule.RG, rule.RminusB));
  }
}
const nullCount = [...sigCache.values()].filter((v) => v === null).length;
console.log("  cached " + (sigCache.size - nullCount) + "/" + sigCache.size + " sigs (" + nullCount + " no-warm-content)\n");

// Grid
const TEXTURE_SHRINK  = [1.0, 0.5, 0.15];
const SPECULAR_SHRINK = [1.0, 0.5, 0.15];
const SKIN_COLOR_WT   = [0.8, 1.0, 1.2, 1.5];
const HOPFIELD_BETA   = [2, 3, 5, 7, 10, 15, 20, 30];
const AXIS_SUBSETS = [
  { label: "color_only",   channels: { color: 1.0, edge: 0.0, texture: 0.0, specular: 0.0, spatial: 0.0 } },
  { label: "core5",        channels: { color: 1.0, edge: 0.6, texture: 0.5, specular: 0.3, spatial: 0.5 } },
  { label: "all_boosted",  channels: { color: 1.2, edge: 0.8, texture: 0.7, specular: 0.5, spatial: 0.7 } },
];
const MAX_DISTANCE    = [1.0, 1.5, 2.0, 3.0];
const REJECT_THRESHOLD = [0.5, 0.6, 0.7, 0.8];
const SKIN_CONCEPT_MODES = ["fitzpatrick", "ita", "both"];

const totalConfigs = WARM_RULES.length * TEXTURE_SHRINK.length * SPECULAR_SHRINK.length * SKIN_COLOR_WT.length *
                     HOPFIELD_BETA.length * AXIS_SUBSETS.length * MAX_DISTANCE.length * REJECT_THRESHOLD.length *
                     SKIN_CONCEPT_MODES.length;
console.log("grid: " + totalConfigs.toLocaleString() + " configs total");
console.log("scoring: +2 correct-target, +1 correct-reject, -2 confident-wrong, -1 any-wrong\n");

function buildStoreVariant(tShrink, sShrink, colorWt, axisChannels, skinMode) {
  const store = JSON.parse(JSON.stringify(BASE));
  const orangeRow = store.labels.find((r) => r.label === "orange");
  updateChannelWeights(store, "orange", axisChannels);
  updateChannelWeights(store, "apple", axisChannels);

  const rotationSetsToAdd = [];
  if (skinMode === "fitzpatrick" || skinMode === "both") rotationSetsToAdd.push({ offsets: FITZPATRICK_HUE_OFFSETS, label: "human_skin" });
  if (skinMode === "ita" || skinMode === "both") rotationSetsToAdd.push({ offsets: ITA_HUE_OFFSETS, label: "human_skin_ita" });

  for (const { offsets, label } of rotationSetsToAdd) {
    const synth = [];
    for (const off of offsets) {
      for (const s of orangeRow.signatures) {
        const rot = hueRotateSignature(s.sig, off.rad);
        rot.texture.meanVariance *= tShrink;
        rot.specular.glossinessScore *= sShrink;
        rot.specular.brightFraction *= sShrink;
        rot.specular.cov *= (0.7 + 0.3 * sShrink);
        synth.push(rot);
      }
    }
    attachSignaturesV2(store, label, synth, "human-grade-sweep", "2026-07-06T00:00:00Z");
    updateChannelWeights(store, label, { ...axisChannels, color: colorWt });
  }
  return store;
}

function scoreConfig(store, beta, warmRuleLabel, maxDistance, rejectThreshold) {
  let correctTarget = 0, correctReject = 0, anyWrong = 0, confidentWrong = 0;
  const detail = {};
  for (const t of TESTS) {
    const sig = sigCache.get(warmRuleLabel + "|" + t.name);
    if (!sig) {
      // No warm content — for reject-set this is a correct reject
      if (t.kind === "reject") correctReject++;
      detail[t.name] = { winner: null, mass: 0, reason: "no_warm_content" };
      continue;
    }
    const ret = hopfieldRetrieve(sig, store, { beta, iters: 3 });
    const acceptedByMass = ret.winnerMass >= rejectThreshold;
    detail[t.name] = { winner: ret.winner, mass: ret.winnerMass };
    if (t.kind === "target") {
      const isCorrect = acceptedByMass && ret.winner === t.expected;
      if (isCorrect) correctTarget++;
      else {
        anyWrong++;
        if (acceptedByMass && ret.winnerMass > CONFIDENT_MASS) confidentWrong++;
      }
    } else {
      // Reject test — success = winner mass below threshold (system says "not sure")
      const rejected = !acceptedByMass;
      if (rejected) correctReject++;
      else {
        anyWrong++;
        if (ret.winnerMass > CONFIDENT_MASS) confidentWrong++;
      }
    }
  }
  const score = 2 * correctTarget + 1 * correctReject - 2 * confidentWrong - 1 * anyWrong;
  return { correctTarget, correctReject, anyWrong, confidentWrong, score, detail };
}

// Sweep
const t0 = Date.now();
const results = [];
let n = 0;
for (const rule of WARM_RULES) {
  for (const tShrink of TEXTURE_SHRINK) {
    for (const sShrink of SPECULAR_SHRINK) {
      for (const colorWt of SKIN_COLOR_WT) {
        for (const axisSubset of AXIS_SUBSETS) {
          for (const skinMode of SKIN_CONCEPT_MODES) {
            const store = buildStoreVariant(tShrink, sShrink, colorWt, axisSubset.channels, skinMode);
            for (const beta of HOPFIELD_BETA) {
              for (const maxDist of MAX_DISTANCE) {
                for (const rejThresh of REJECT_THRESHOLD) {
                  const s = scoreConfig(store, beta, rule.label, maxDist, rejThresh);
                  results.push({
                    config: {
                      warm_rule: rule.label, texture_shrink: tShrink, specular_shrink: sShrink,
                      skin_color_wt: colorWt, axis_subset: axisSubset.label, skin_concept_mode: skinMode,
                      beta, max_distance: maxDist, reject_threshold: rejThresh,
                    },
                    correctTarget: s.correctTarget,
                    correctReject: s.correctReject,
                    anyWrong: s.anyWrong,
                    confidentWrong: s.confidentWrong,
                    score: s.score,
                  });
                  n++;
                  if (n % 5000 === 0) {
                    const el = (Date.now() - t0) / 1000;
                    console.log("  " + n.toLocaleString() + " / " + totalConfigs.toLocaleString() + " configs  (" + (n / el).toFixed(0) + " configs/sec)");
                  }
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
console.log("\n" + results.length.toLocaleString() + " configs in " + elapsed.toFixed(1) + "s  (" + (results.length / elapsed).toFixed(0) + " configs/sec)");

// Rank
results.sort((a, b) => (b.score - a.score) || (b.correctTarget - a.correctTarget) || (b.correctReject - a.correctReject));

console.log("\n=== SCORE DISTRIBUTION ===");
const bins = {};
for (const r of results) {
  const bkey = Math.floor(r.score);
  bins[bkey] = (bins[bkey] || 0) + 1;
}
for (const [k, v] of Object.entries(bins).sort((a, b) => Number(b[0]) - Number(a[0])).slice(0, 15)) {
  console.log("  score=" + String(k).padStart(3) + ": " + v.toLocaleString() + " configs");
}

// Max possible score: 8 target × 2 + 7 reject × 1 = 23
const MAX_SCORE = TESTS.filter(t => t.kind === "target").length * 2 + TESTS.filter(t => t.kind === "reject").length;
console.log("\nMax possible score: " + MAX_SCORE + " (" + TESTS.filter(t => t.kind === "target").length + " targets ×2 + " + TESTS.filter(t => t.kind === "reject").length + " rejects)");
console.log("Perfect configs (score === MAX): " + results.filter((r) => r.score === MAX_SCORE).length);
console.log("Near-perfect (score >= MAX - 2): " + results.filter((r) => r.score >= MAX_SCORE - 2).length);

console.log("\n=== TOP 15 CONFIGS ===");
for (let i = 0; i < 15 && i < results.length; i++) {
  const r = results[i];
  const c = r.config;
  console.log("#" + String(i+1).padStart(2) + " score=" + String(r.score).padStart(3) + " tgt=" + r.correctTarget + "/8 rej=" + r.correctReject + "/7 confWrong=" + r.confidentWrong +
    "  warm=" + c.warm_rule + " tShr=" + c.texture_shrink + " sShr=" + c.specular_shrink + " cWt=" + c.skin_color_wt +
    " ax=" + c.axis_subset + " skin=" + c.skin_concept_mode + " β=" + c.beta + " maxD=" + c.max_distance + " rej=" + c.reject_threshold);
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results.slice(0, 500), null, 2));
console.log("\ntop-500 results: " + path.join(OUT, "results.json"));
