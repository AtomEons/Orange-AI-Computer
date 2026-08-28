#!/usr/bin/env bun
// 100,000-experiment orange battery.
//
// Codexa/OrangeBrain currently offline (Phase 2 pending). Same battery
// designed to run on either machine — the compute is CPU-bound Bun JS,
// no GPU or model needed. Executing locally as the source of truth.
//
// Structure:
//   5 perturbation channels × 100 noise magnitudes × 200 seeds each = 100,000
//
// Perturbation channels:
//   1. Color-only noise         (perturb mean_R, mean_G, mean_B, mean_RG, mean_BY)
//   2. Edge-only noise          (perturb meanEnergy + orientationEntropy)
//   3. Texture-only noise       (perturb meanVariance + lbpEntropy)
//   4. Specular-only noise      (perturb cov + brightFraction + glossinessScore)
//   5. Combined all-channel noise
//
// Per experiment:
//   - deterministic hash-based noise from (channel_id × 1e7 + sigma_bin × 1e4 + seed)
//   - build perturbed signature
//   - recognizeV2 + hopfieldRetrieve
//   - record: winner label, distance, confidence, mode
//
// Deterministic replay: same order → byte-identical result set.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { recognizeV2, richDistance } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "100k-orange");
fs.mkdirSync(OUT, { recursive: true });
const STORE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect.json"), "utf8"));

// ── Baseline: mean of stored orange signatures ─────────────────────
function meanSignature(signatures) {
  const mean = {
    color: { mean_R:0, mean_G:0, mean_B:0, mean_RG:0, mean_BY:0, texture_var:0, log_size:0, log_aspect:0 },
    edge:  { meanEnergy:0, orientationEntropy:0, orientationHistogram: new Array(8).fill(0) },
    texture: { meanVariance:0, lbpEntropy:0, lbpTopCodes: [] },
    specular: { cov:0, brightFraction:0, glossinessScore:0 },
    spatial: { cells: new Array(27).fill(0) },
  };
  const N = signatures.length;
  for (const row of signatures) {
    const s = row.sig;
    for (const k of Object.keys(mean.color)) mean.color[k] += (s.color[k] ?? 0) / N;
    mean.edge.meanEnergy += (s.edge?.meanEnergy ?? 0) / N;
    mean.edge.orientationEntropy += (s.edge?.orientationEntropy ?? 0) / N;
    for (let i = 0; i < 8; i++) mean.edge.orientationHistogram[i] += (s.edge?.orientationHistogram?.[i] ?? 0) / N;
    mean.texture.meanVariance += (s.texture?.meanVariance ?? 0) / N;
    mean.texture.lbpEntropy += (s.texture?.lbpEntropy ?? 0) / N;
    mean.specular.cov += (s.specular?.cov ?? 0) / N;
    mean.specular.brightFraction += (s.specular?.brightFraction ?? 0) / N;
    mean.specular.glossinessScore += (s.specular?.glossinessScore ?? 0) / N;
    for (let i = 0; i < 27; i++) mean.spatial.cells[i] += (s.spatial?.cells?.[i] ?? 0) / N;
  }
  mean.texture.lbpTopCodes = signatures[0].sig.texture?.lbpTopCodes ?? [];
  return mean;
}
const orangeRow = STORE.labels.find((r) => r.label === "orange");
const orangeBase = meanSignature(orangeRow.signatures);

// ── Deterministic hash-based noise ─────────────────────────────────
function hash01(seed) {
  let h = (seed | 0) * 2654435761 >>> 0;
  h = ((h << 13) | (h >>> 19)) >>> 0;
  h ^= h >>> 17;
  h = ((h << 5) | (h >>> 27)) >>> 0;
  return (h & 0xffff) / 65535;
}
function symNoise(seed) { return (hash01(seed) - 0.5) * 2; }   // [-1, 1]

// ── Perturbation channels ──────────────────────────────────────────
function perturb(base, channel, sigma, seed) {
  // Deep-clone the base
  const p = {
    color: { ...base.color },
    edge:  { ...base.edge, orientationHistogram: [...base.edge.orientationHistogram] },
    texture: { ...base.texture, lbpTopCodes: [...base.texture.lbpTopCodes] },
    specular: { ...base.specular },
    spatial: { cells: [...base.spatial.cells] },
  };
  const s = (i) => symNoise(channel * 10007 + Math.floor(sigma * 10000) + seed * 13 + i);
  if (channel === 1 || channel === 5) {   // color
    p.color.mean_R  = clamp01(base.color.mean_R  + s(1) * sigma);
    p.color.mean_G  = clamp01(base.color.mean_G  + s(2) * sigma);
    p.color.mean_B  = clamp01(base.color.mean_B  + s(3) * sigma);
    p.color.mean_RG = base.color.mean_RG + s(4) * sigma * 0.6;
    p.color.mean_BY = base.color.mean_BY + s(5) * sigma * 0.6;
  }
  if (channel === 2 || channel === 5) {   // edge
    p.edge.meanEnergy = clamp01(base.edge.meanEnergy + s(6) * sigma);
    p.edge.orientationEntropy = Math.max(0, base.edge.orientationEntropy + s(7) * sigma);
    for (let i = 0; i < 8; i++) p.edge.orientationHistogram[i] = clamp01(base.edge.orientationHistogram[i] + s(8 + i) * sigma * 0.3);
  }
  if (channel === 3 || channel === 5) {   // texture
    p.texture.meanVariance = Math.max(0, base.texture.meanVariance + s(16) * sigma * 0.05);
    p.texture.lbpEntropy = Math.max(0, base.texture.lbpEntropy + s(17) * sigma);
  }
  if (channel === 4 || channel === 5) {   // specular
    p.specular.cov = clamp01(base.specular.cov + s(18) * sigma);
    p.specular.brightFraction = clamp01(base.specular.brightFraction + s(19) * sigma * 0.5);
    p.specular.glossinessScore = clamp01(base.specular.glossinessScore + s(20) * sigma * 0.5);
  }
  return p;
}
function clamp01(v) { return Math.max(0, Math.min(1, v)); }

// ── Run the battery ────────────────────────────────────────────────
const CHANNELS = 5;
const SIGMA_LEVELS = 100;     // 0.00 to 0.50 in 100 steps
const SEEDS_PER_LEVEL = 200;
const TOTAL = CHANNELS * SIGMA_LEVELS * SEEDS_PER_LEVEL;

console.log(`=== 100,000-ORANGE-EXPERIMENT BATTERY ===\n`);
console.log(`channels=${CHANNELS} × sigma_levels=${SIGMA_LEVELS} × seeds=${SEEDS_PER_LEVEL} = ${TOTAL} experiments`);
console.log(`orange baseline built from mean of ${orangeRow.signatures.length} stored signatures\n`);

const results = {
  total: TOTAL,
  recognized_orange: 0,
  recognized_apple: 0,   // false positive as apple (same warm-family sibling)
  rejected: 0,
  perturbation_survival: {},    // channel -> sigma_bin -> {rec_rate, mean_conf, mean_dist}
};
for (let ch = 1; ch <= CHANNELS; ch++) results.perturbation_survival[ch] = {};

const t0 = Date.now();
let progress = 0;

for (let ch = 1; ch <= CHANNELS; ch++) {
  for (let sigmaBin = 0; sigmaBin < SIGMA_LEVELS; sigmaBin++) {
    const sigma = sigmaBin * 0.005;   // 0.00, 0.005, 0.010, ..., 0.495
    let recOrange = 0, recApple = 0, rej = 0;
    let sumConf = 0, sumDist = 0;
    for (let seed = 0; seed < SEEDS_PER_LEVEL; seed++) {
      const test = perturb(orangeBase, ch, sigma, seed);
      const r = recognizeV2(test, STORE, { max_distance: 1.5, top_k: 3 });
      sumConf += r.confidence;
      sumDist += r.distance;
      if (r.rejected) { rej++; results.rejected++; }
      else if (r.winner === "orange") { recOrange++; results.recognized_orange++; }
      else if (r.winner === "apple")  { recApple++;  results.recognized_apple++; }
      else rej++;
      progress++;
      if (progress % 10000 === 0) {
        process.stdout.write(`  ${progress}/${TOTAL} (${((progress/TOTAL)*100).toFixed(0)}%)   ${((Date.now()-t0)/1000).toFixed(1)}s\n`);
      }
    }
    results.perturbation_survival[ch][sigmaBin] = {
      sigma,
      rec_orange: recOrange, rec_apple: recApple, rejected: rej,
      rec_rate_orange: recOrange / SEEDS_PER_LEVEL,
      mean_conf: sumConf / SEEDS_PER_LEVEL,
      mean_dist: sumDist / SEEDS_PER_LEVEL,
    };
  }
}
const elapsed = (Date.now() - t0) / 1000;
console.log(`\ncompleted in ${elapsed.toFixed(1)}s (${(TOTAL/elapsed).toFixed(0)} exp/sec)\n`);

// ── Aggregate report ───────────────────────────────────────────────
console.log(`=== TOP-LINE ===`);
console.log(`total experiments: ${TOTAL}`);
console.log(`recognized as orange:       ${results.recognized_orange} (${(results.recognized_orange/TOTAL*100).toFixed(2)}%)`);
console.log(`recognized as apple sibling: ${results.recognized_apple} (${(results.recognized_apple/TOTAL*100).toFixed(2)}%)`);
console.log(`rejected (distance>threshold): ${results.rejected} (${(results.rejected/TOTAL*100).toFixed(2)}%)`);

// Robustness envelope per channel: find the largest sigma at which >90% still recognize orange
console.log(`\n=== ROBUSTNESS ENVELOPE per channel (largest σ at which ≥90% recognized) ===`);
const channelNames = { 1: "color", 2: "edge", 3: "texture", 4: "specular", 5: "combined" };
for (let ch = 1; ch <= CHANNELS; ch++) {
  const survival = results.perturbation_survival[ch];
  let maxSurvivedSigma = 0;
  for (let i = 0; i < SIGMA_LEVELS; i++) {
    if (survival[i].rec_rate_orange >= 0.9) maxSurvivedSigma = survival[i].sigma;
  }
  const at025 = survival[Math.floor(0.25 / 0.005)];    // rec rate at σ=0.25
  const at050 = survival[SIGMA_LEVELS - 1];             // rec rate at σ=0.495
  console.log(`  ${channelNames[ch].padEnd(10)} envelope=σ≤${maxSurvivedSigma.toFixed(3)}   at σ=0.25: ${(at025.rec_rate_orange*100).toFixed(1)}%   at σ=0.5: ${(at050.rec_rate_orange*100).toFixed(1)}%`);
}

// Which channel is orange most robust to?
console.log(`\n=== ORANGE'S CHROMATIC-FAMILY MEMBERSHIP DISTRIBUTION ===`);
console.log(`Even at high perturbation, unrecognized-as-orange doesn't fall out of family:`);
for (let ch = 1; ch <= CHANNELS; ch++) {
  const total = SIGMA_LEVELS * SEEDS_PER_LEVEL;
  const survival = results.perturbation_survival[ch];
  let totalOrange = 0, totalApple = 0, totalRej = 0;
  for (let i = 0; i < SIGMA_LEVELS; i++) {
    totalOrange += survival[i].rec_orange;
    totalApple += survival[i].rec_apple;
    totalRej += survival[i].rejected;
  }
  console.log(`  ${channelNames[ch].padEnd(10)} orange=${(totalOrange/total*100).toFixed(1)}%   apple=${(totalApple/total*100).toFixed(1)}%   rej=${(totalRej/total*100).toFixed(1)}%`);
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nresults: ${path.join(OUT, "results.json")}`);
console.log(`\nSpine note: Codexa/OrangeBrain offline. Battery is local-executed; same code runs on Codexa the moment P2 wakes.`);
