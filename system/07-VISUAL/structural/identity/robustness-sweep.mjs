#!/usr/bin/env bun
// Robustness sweep — one concept through many presentations.
//
// Operator: "orange in motion. talking orange. you laugh because you get why."
//
// The claim under test: the trained 'orange' concept should survive
// transformations that preserve the material (photon reflectance)
// signature, and correctly reject transformations that break it.
//
// Twelve presentations of orange.jpg:
//   1. original
//   2. hue +20° (slight color drift)
//   3. hue +45° (color pushed toward yellow)
//   4. hue -20° (drift toward red)
//   5. hue -60° (well into red)
//   6. rotated 45° (geometric)
//   7. rotated 90°
//   8. scaled 50% (smaller in frame)
//   9. scaled 150% (larger)
//  10. gaussian blur (out of focus)
//  11. brightness -30% (dim)
//  12. brightness +30% (bright)
//  13. gaussian noise (grainy)
//
// Success signature: original + hue drifts + geometric + scale + focus +
// brightness all match "orange" with mass > 0.7. Noise degrades gracefully.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { computeDescriptor, computeUnionDescriptor } from "./descriptor.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { buildRichSignature, recognizeV2 } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "robustness-sweep");
fs.mkdirSync(OUT, { recursive: true });
const STORE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect.json"), "utf8"));

const AXES = ["R","G","B","L","M","gamma","RG","BY"];

function isWarm(d) {
  return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5;
}
function toLuminance(R, G, B) {
  const N = R.length;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  return L;
}
function buildFrameSignature(R, G, B, w, h) {
  const combo = attentionMultiAxisV2(R, G, B, w, h, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const warm = [];
  for (const e of combo.entities) {
    const d = computeDescriptor(e.region, R, G, B, w, h);
    if (isWarm(d)) warm.push(e);
  }
  if (!warm.length) return null;
  const colorDesc = computeUnionDescriptor(warm.map(x => x.region), R, G, B, w, h);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of warm) {
    if (e.region[0] < x0) x0 = e.region[0];
    if (e.region[1] < y0) y0 = e.region[1];
    if (e.region[0] + e.region[2] > x1) x1 = e.region[0] + e.region[2];
    if (e.region[1] + e.region[3] > y1) y1 = e.region[1] + e.region[3];
  }
  const region = [x0, y0, x1 - x0, y1 - y0];
  const L = toLuminance(R, G, B);
  return buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, w, h, region),
    textureSummaryForRegion(L, w, h, region),
    specularSummaryForRegion(L, w, h, region),
    spatialColorSummaryForRegion(R, G, B, w, h, region),
  );
}

function runFfmpeg(inputPath, vf, outPath) {
  const proc = Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", inputPath, "-vf", vf, outPath],
  });
  if (proc.exitCode !== 0) throw new Error(`ffmpeg failed: ${new TextDecoder().decode(proc.stderr).slice(0, 200)}`);
}

const SRC = path.join(FIXTURES, "orange.jpg");

const PRESENTATIONS = [
  { key: "01-original",       vf: "null",                           tag: "control" },
  { key: "02-hue-plus-20",    vf: "hue=h=20",                       tag: "color drift +20°" },
  { key: "03-hue-plus-45",    vf: "hue=h=45",                       tag: "color drift +45° (toward yellow)" },
  { key: "04-hue-minus-20",   vf: "hue=h=-20",                      tag: "color drift -20°" },
  { key: "05-hue-minus-60",   vf: "hue=h=-60",                      tag: "color drift -60° (toward red)" },
  { key: "06-rotate-45",      vf: "rotate=45*PI/180:fillcolor=black", tag: "rotated 45°" },
  { key: "07-rotate-90",      vf: "rotate=90*PI/180:fillcolor=black", tag: "rotated 90°" },
  { key: "08-scale-50",       vf: "scale=iw*0.5:ih*0.5,pad=iw*2:ih*2:iw/2:ih/2:color=black", tag: "scaled to 50%" },
  { key: "09-scale-150",      vf: "scale=iw*1.5:ih*1.5,crop=iw/1.5:ih/1.5", tag: "scaled to 150% (crop)" },
  { key: "10-blur-heavy",     vf: "gblur=sigma=5",                  tag: "gaussian blur σ=5 (out of focus)" },
  { key: "11-dim",            vf: "eq=brightness=-0.3",             tag: "brightness -30%" },
  { key: "12-bright",         vf: "eq=brightness=0.3",              tag: "brightness +30%" },
  { key: "13-noise",          vf: "noise=alls=25:allf=t",           tag: "gaussian noise" },
];

console.log("=== ROBUSTNESS SWEEP — orange concept across 13 presentations ===\n");

async function testPresentation(p) {
  const outPath = path.join(OUT, `${p.key}.jpg`);
  runFfmpeg(SRC, p.vf, outPath);
  const rgb = await extractImageRGB(outPath, { maxSize: 384 });
  const sig = buildFrameSignature(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  if (!sig) return { ...p, warm: false };
  const A = recognizeV2(sig, STORE, { max_distance: 1.5, top_k: 3 });
  const B = hopfieldRetrieve(sig, STORE, { beta: 5.0, iters: 3 });
  return {
    ...p, warm: true,
    A_winner: A.winner, A_kMean: A.distance, A_conf: A.confidence,
    B_winner: B.winner, B_mass: B.winnerMass, B_sharpness: B.sharpness, B_bestD: B.winnerBestDistance,
  };
}

const results = [];
for (const p of PRESENTATIONS) {
  const r = await testPresentation(p);
  results.push(r);
  if (!r.warm) {
    console.log(`  ${r.key.padEnd(20)} ${r.tag.padEnd(35)} NO WARM CONTENT`);
    continue;
  }
  const aOK = r.A_winner === "orange" && r.A_kMean <= 1.5;
  const bOK = r.B_winner === "orange" && r.B_mass > 0.5;
  const badge = (aOK && bOK) ? "✓✓" : (aOK || bOK) ? "✓ " : "✗ ";
  console.log(`  ${r.key.padEnd(20)} ${r.tag.padEnd(35)} ${badge}  A[${r.A_winner} kM=${r.A_kMean.toFixed(2)}]  B[${r.B_winner} mass=${r.B_mass.toFixed(2)} bestD=${r.B_bestD.toFixed(2)}]`);
}

// Aggregate
const validResults = results.filter(r => r.warm);
const bothOK = validResults.filter(r => r.A_winner === "orange" && r.B_winner === "orange" && r.A_kMean <= 1.5);
const eitherOK = validResults.filter(r => (r.A_winner === "orange" && r.A_kMean <= 1.5) || (r.B_winner === "orange" && r.B_mass > 0.5));
console.log(`\n=== SUMMARY ===`);
console.log(`presentations tested: ${results.length}`);
console.log(`with warm content:    ${validResults.length}`);
console.log(`both modes → orange:  ${bothOK.length}/${validResults.length}`);
console.log(`either mode → orange: ${eitherOK.length}/${validResults.length}`);

// Hopfield mass distribution
const masses = validResults.filter(r => r.B_winner === "orange").map(r => r.B_mass).sort((a, b) => b - a);
if (masses.length) {
  console.log(`\nHopfield mass on orange match (higher = more decisive attractor):`);
  console.log(`  max:    ${masses[0].toFixed(3)}`);
  console.log(`  median: ${masses[Math.floor(masses.length / 2)].toFixed(3)}`);
  console.log(`  min:    ${masses[masses.length - 1].toFixed(3)}`);
}

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nartifacts: ${OUT}`);
