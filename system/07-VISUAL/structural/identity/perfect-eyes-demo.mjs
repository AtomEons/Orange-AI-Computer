#!/usr/bin/env bun
// PERFECT-EYES demo — the full stack fires end-to-end.
//
// Pipeline:
//   1. Extract 15 frames per cinema clip (orange, apple)
//   2. Build rich signature per frame: 8-axis color + edge + texture +
//      specular + spatial-color (5 channels total)
//   3. Active curation: keep the K=8 most-diverse signatures per concept
//      (farthest-point sampling in descriptor space)
//   4. Multi-signature identity store — NO aggregation
//   5. Also build a concept graph and PRIMES orange <-> apple (siblings)
//   6. Test on 4 stills using Hopfield retrieval (softmax over signature bank)
//   7. Compare vs the seq-31 baseline (single-aggregated cinema-v3 8-axis)

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { computeDescriptor, computeUnionDescriptor } from "./descriptor.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { buildRichSignature, attachSignaturesV2, richDistance, recognizeV2, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";
import { activeCurate, diversityScore } from "../ingest/active-curation.mjs";
import { emptyGraph, findOrCreateConcept, attachSignature, addEdge, saveGraph, graphStats } from "../graph/concept-graph.mjs";
import { bindCoOccurrence, updateFromObservation } from "../perception/prediction-error.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const OUT = path.join(FIXTURES, "perfect-eyes");
fs.mkdirSync(OUT, { recursive: true });

const AXES = ["R","G","B","L","M","gamma","RG","BY"];
const N_FRAMES = 15, K_CURATED = 8;

// Chromatic-warm rule
function isWarm(d) {
  return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5;
}

function toLuminance(R, G, B) {
  const N = R.length;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  return L;
}

// Build a rich signature for a whole frame using warm-union region
function buildFrameSignature(R, G, B, width, height) {
  const combo = attentionMultiAxisV2(R, G, B, width, height, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const warm = [];
  for (const e of combo.entities) {
    const d = computeDescriptor(e.region, R, G, B, width, height);
    if (isWarm(d)) warm.push(e);
  }
  if (!warm.length) return null;
  const colorDesc = computeUnionDescriptor(warm.map((w) => w.region), R, G, B, width, height);

  // Merged bbox for the warm content
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of warm) {
    if (e.region[0] < x0) x0 = e.region[0];
    if (e.region[1] < y0) y0 = e.region[1];
    if (e.region[0] + e.region[2] > x1) x1 = e.region[0] + e.region[2];
    if (e.region[1] + e.region[3] > y1) y1 = e.region[1] + e.region[3];
  }
  const region = [x0, y0, x1 - x0, y1 - y0];

  const L = toLuminance(R, G, B);
  const edgeSum = edgeSummaryForRegion(L, width, height, region);
  const texSum  = textureSummaryForRegion(L, width, height, region);
  const specSum = specularSummaryForRegion(L, width, height, region);
  const spatSum = spatialColorSummaryForRegion(R, G, B, width, height, region);

  return buildRichSignature(colorDesc, edgeSum, texSum, specSum, spatSum);
}

async function watchVideoRich(videoPath) {
  console.log(`  extracting ${N_FRAMES} frames from ${path.basename(videoPath)}...`);
  const frames = await extractVideoFrames(videoPath, { frames: N_FRAMES, size: 384 });
  const sigs = [];
  for (const f of frames) {
    const s = buildFrameSignature(f.R, f.G, f.B, f.width, f.height);
    if (s) sigs.push(s);
  }
  console.log(`  → ${sigs.length}/${frames.length} rich signatures built`);
  return sigs;
}

console.log("=== PERFECT-EYES DEMO ===\n");

// ---- TRAIN ----
console.log("STEP 1: build rich signatures from cinema");
const orangeSigs = await watchVideoRich(path.join(CINEMA, "baby-watches-orange.mp4"));
const appleSigs  = await watchVideoRich(path.join(CINEMA, "baby-watches-apple.mp4"));

// ---- ACTIVE CURATION ----
console.log("\nSTEP 2: active curation (farthest-point sampling) — keep K most diverse");
const orangeCurated = activeCurate(orangeSigs, K_CURATED, { weights: DEFAULT_CHANNEL_WEIGHTS });
const appleCurated  = activeCurate(appleSigs,  K_CURATED, { weights: DEFAULT_CHANNEL_WEIGHTS });
const orangeKept = orangeCurated.selected.map((i) => orangeSigs[i]);
const appleKept  = appleCurated.selected.map((i) => appleSigs[i]);
console.log(`  orange: kept ${orangeKept.length}/${orangeSigs.length}  diversity=${diversityScore(orangeKept).toFixed(3)}  (all-frames diversity=${diversityScore(orangeSigs).toFixed(3)})`);
console.log(`  apple:  kept ${appleKept.length}/${appleSigs.length}  diversity=${diversityScore(appleKept).toFixed(3)}  (all-frames diversity=${diversityScore(appleSigs).toFixed(3)})`);

// ---- MULTI-SIGNATURE STORE ----
const store = { labels: [] };
attachSignaturesV2(store, "orange", orangeKept, "baby-watches-orange.mp4 curated K=8", "2026-07-06T00:00:00Z");
attachSignaturesV2(store, "apple",  appleKept,  "baby-watches-apple.mp4 curated K=8",  "2026-07-06T00:00:00Z");
fs.writeFileSync(path.join(OUT, "identity-store-perfect.json"), JSON.stringify(store, null, 2));

// ---- CONCEPT GRAPH ----
const graph = emptyGraph();
const orangeC = findOrCreateConcept(graph, "orange", { channel_weights: { color: 1.0, edge: 0.4, texture: 0.4, specular: 0.3, spatial: 0.5 } });
const appleC  = findOrCreateConcept(graph, "apple",  { channel_weights: { color: 1.0, edge: 0.5, texture: 0.5, specular: 0.4, spatial: 0.5 } });
// Both are IS_A fruit (implicit sibling class)
const fruitC = findOrCreateConcept(graph, "fruit");
addEdge(graph, orangeC.id, "IS_A", fruitC.id, 1.0);
addEdge(graph, appleC.id,  "IS_A", fruitC.id, 1.0);
addEdge(graph, orangeC.id, "SIMILAR_TO", appleC.id, 0.6);
// Attach each stored signature as a graph node too (for graph-native retrieval)
for (const s of orangeKept) attachSignature(graph, orangeC.id, s, "orange-cinema-curated");
for (const s of appleKept)  attachSignature(graph, appleC.id,  s, "apple-cinema-curated");
saveGraph(path.join(OUT, "concept-graph.json"), graph);
const gs = graphStats(graph);
console.log(`\nSTEP 3: concept graph — ${gs.total_nodes} nodes, ${gs.total_edges} edges  (${JSON.stringify(gs.by_node_type)})`);

// ---- TEST ----
console.log("\nSTEP 4: test on 4 stills — TWO recognition modes\n");

const TESTS = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];
const EXPECTED = { "orange.jpg": "orange", "apple.jpg": "apple", "fruits.jpg": "orange", "lena.jpg": null };

async function testStill(imgName) {
  const rgb = await extractImageRGB(path.join(FIXTURES, imgName), { maxSize: 384 });
  const testSig = buildFrameSignature(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  if (!testSig) return { imgName, warm: false };

  // Mode A: recognizeV2 = nearest-of-N per concept
  const modeA = recognizeV2(testSig, store, { max_distance: 1.0, top_k: 3 });
  // Mode B: Hopfield attractor retrieval
  const modeB = hopfieldRetrieve(testSig, store, { beta: 5.0, iters: 3 });

  return { imgName, warm: true, modeA, modeB };
}

const results = [];
for (const t of TESTS) {
  const r = await testStill(t);
  results.push(r);
  if (!r.warm) { console.log(`  ${t.padEnd(15)} — no warm content, no signature to test`); continue; }
  const a = r.modeA, b = r.modeB;
  const want = EXPECTED[t];
  const aOK = want === null ? (a.rejected || a.distance > 1.0) : (a.winner === want && !a.rejected);
  const bOK = want === null ? (b.sharpness < 0.4) : (b.winner === want);
  console.log(`  ${t.padEnd(15)} EXPECT ${want ?? "no-match"}`);
  console.log(`    [A nearest-of-N] winner=${a.winner} kMean=${a.distance.toFixed(3)} best=${a.best.toFixed(3)} conf=${a.confidence.toFixed(2)}${a.rejected ? " REJECTED" : ""}  ${aOK ? "✓" : "✗"}`);
  console.log(`    [B Hopfield]     winner=${b.winner} mass=${b.winnerMass.toFixed(3)} sharpness=${b.sharpness.toFixed(3)} bestD=${b.winnerBestDistance.toFixed(3)}  ${bOK ? "✓" : "✗"}`);
  console.log("");
}

// ---- SCORE ----
let aScore = 0, bScore = 0, total = 0;
for (const r of results) {
  if (!r.warm) {
    const want = EXPECTED[r.imgName];
    if (want === null) { aScore++; bScore++; }
    total++;
    continue;
  }
  total++;
  const want = EXPECTED[r.imgName];
  const aOK = want === null ? (r.modeA.rejected || r.modeA.distance > 1.0) : (r.modeA.winner === want && !r.modeA.rejected);
  const bOK = want === null ? (r.modeB.sharpness < 0.4) : (r.modeB.winner === want);
  if (aOK) aScore++;
  if (bOK) bScore++;
}
console.log(`=== SCORE ===`);
console.log(`Mode A (nearest-of-N over ${K_CURATED} sigs): ${aScore}/${total}`);
console.log(`Mode B (Hopfield attractor):                  ${bScore}/${total}`);

// ---- Prediction-error learning demo: feed the test observations back ----
console.log(`\nSTEP 5: prediction-error learning — observe results, bind co-occurrence`);
let learned = 0;
for (const r of results) {
  if (!r.warm) continue;
  const update = updateFromObservation(graph, orangeC.id, r.modeA.winner, r.modeA.distance);
  console.log(`  ${r.imgName.padEnd(15)} → ${update.kind}${update.episode_id ? " ep=" + update.episode_id : ""}`);
  if (update.kind !== "no_update") learned++;
}
// Bind orange + apple as co-observed (they always appear in the same fruit taxonomy)
bindCoOccurrence(graph, orangeC.id, appleC.id);
saveGraph(path.join(OUT, "concept-graph.json"), graph);
const gs2 = graphStats(graph);
console.log(`  graph now: ${gs2.total_nodes} nodes, ${gs2.total_edges} edges  (${JSON.stringify(gs2.by_node_type)})`);

// ---- Save results ----
fs.writeFileSync(path.join(OUT, "demo-results.json"), JSON.stringify({
  store_size: { orange: orangeKept.length, apple: appleKept.length },
  diversity: {
    orange_curated: diversityScore(orangeKept),
    orange_all: diversityScore(orangeSigs),
    apple_curated: diversityScore(appleKept),
    apple_all: diversityScore(appleSigs),
  },
  scores: { mode_A: `${aScore}/${total}`, mode_B: `${bScore}/${total}` },
  graph: gs2,
  results,
}, null, 2));
console.log(`\nartifacts: ${OUT}`);
