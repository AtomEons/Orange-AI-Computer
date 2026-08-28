#!/usr/bin/env bun
// Same-material adversarial test.
//
// The 4.6 briefing predicted a wall at same-material objects.
// Controlled experiment: hue-shift orange.jpg → red. Everything else
// (texture, shape, specular, spatial) held constant. Ask perfect-eyes:
//
//   Q: Does the trained {orange, apple} store still say "orange" when
//      the surface material is orange-y but the color is apple-y?
//
// If yes → shape/texture channels are pulling weight. Substrate works.
// If no → color still dominates. The wall from the briefing is real.

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
const OUT = path.join(FIXTURES, "same-material");
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

// Controlled hue shift on orange.jpg
async function makeHueShifted(inputPath, outPath, hueDegrees) {
  const proc = Bun.spawnSync({
    cmd: ["ffmpeg", "-y", "-loglevel", "error", "-i", inputPath, "-vf", `hue=h=${hueDegrees}`, outPath],
  });
  if (proc.exitCode !== 0) throw new Error(`hue shift failed: ${new TextDecoder().decode(proc.stderr)}`);
}

async function testStill(imgName, label) {
  const rgb = await extractImageRGB(imgName, { maxSize: 384 });
  const sig = buildFrameSignature(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  if (!sig) return { label, warm: false };
  const modeA = recognizeV2(sig, STORE, { max_distance: 1.5, top_k: 3 });
  const modeB = hopfieldRetrieve(sig, STORE, { beta: 5.0, iters: 3 });
  return {
    label,
    warm: true,
    color: {
      R: sig.color.mean_R.toFixed(3), G: sig.color.mean_G.toFixed(3), B: sig.color.mean_B.toFixed(3),
      RG: sig.color.mean_RG.toFixed(3), BY: sig.color.mean_BY.toFixed(3),
    },
    texture: {
      variance: sig.texture.meanVariance.toFixed(4),
      lbp_entropy: sig.texture.lbpEntropy.toFixed(3),
    },
    specular: {
      cov: sig.specular.cov.toFixed(3),
      glossiness: sig.specular.glossinessScore.toFixed(3),
    },
    edge: {
      mean_energy: sig.edge.meanEnergy.toFixed(3),
      orientation_entropy: sig.edge.orientationEntropy.toFixed(3),
    },
    modeA_winner: modeA.winner, modeA_kMean: modeA.distance.toFixed(3), modeA_conf: modeA.confidence.toFixed(2),
    modeB_winner: modeB.winner, modeB_mass: modeB.winnerMass.toFixed(3), modeB_sharpness: modeB.sharpness.toFixed(3),
  };
}

console.log("=== SAME-MATERIAL ADVERSARIAL TEST ===\n");

// Baseline: control (unmodified originals)
const origOrange = path.join(FIXTURES, "orange.jpg");
const origApple = path.join(FIXTURES, "apple.jpg");

// Hue-shifted variants
const redOrange = path.join(OUT, "hue-shifted-orange-red.jpg");
const orangeApple = path.join(OUT, "hue-shifted-apple-orange.jpg");

console.log("STEP 1: creating controlled hue variants");
await makeHueShifted(origOrange, redOrange, 340);   // shift orange body toward red-magenta
await makeHueShifted(origApple, orangeApple, 30);   // shift apple body toward orange-yellow
console.log(`  ${redOrange}`);
console.log(`  ${orangeApple}\n`);

console.log("STEP 2: measure signatures");
const tests = [
  { path: origOrange, label: "control: orange.jpg (unmodified)" },
  { path: origApple, label: "control: apple.jpg (unmodified)" },
  { path: redOrange, label: "HUE-SHIFTED: orange shape/texture, red color" },
  { path: orangeApple, label: "HUE-SHIFTED: apple shape/texture, orange color" },
];

for (const t of tests) {
  const r = await testStill(t.path, t.label);
  console.log(`\n▸ ${r.label}`);
  if (!r.warm) { console.log(`  (no warm entity — cannot test)`); continue; }
  console.log(`  color:    R=${r.color.R} G=${r.color.G} B=${r.color.B}  RG=${r.color.RG}  BY=${r.color.BY}`);
  console.log(`  texture:  variance=${r.texture.variance}  LBP-entropy=${r.texture.lbp_entropy}`);
  console.log(`  specular: CoV=${r.specular.cov}  glossiness=${r.specular.glossiness}`);
  console.log(`  edge:     mean-energy=${r.edge.mean_energy}  orient-entropy=${r.edge.orientation_entropy}`);
  console.log(`  [A]  winner=${r.modeA_winner}  kMean=${r.modeA_kMean}  conf=${r.modeA_conf}`);
  console.log(`  [B]  winner=${r.modeB_winner}  mass=${r.modeB_mass}  sharpness=${r.modeB_sharpness}`);
}

console.log("\n=== INTERPRETATION ===");
console.log("If hue-shifted-orange-red WINS orange: shape/texture channels are dominant. Wall broken.");
console.log("If hue-shifted-orange-red WINS apple:  color still dominates. Wall is real.");
console.log("If hue-shifted-apple-orange WINS orange: symmetric confirmation of the same result.");
