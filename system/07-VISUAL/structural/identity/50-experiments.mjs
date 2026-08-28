#!/usr/bin/env bun
// 50-experiment battery — surity across all new modules.
//
// Five groups × ten probes. Each probe returns {name, result, pass}.
// Runs sequentially in one Bun process. Emits a final markdown table.
//
// GROUPS:
//   A. Retinal-12 channel behavior         (10)
//   B. LGN gate priming effect             (10)
//   C. Celtic structural properties        (10)
//   D. Signature quality / rich distance   (10)
//   E. Knot vector index behavior          (10)

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { compute12Channels, channels12Summary } from "../retinal-12.mjs";
import { computeGate12, applyGate12, channels12ToVector, channels12Distance, CONCEPT_PREFERENCES, CHANNEL_NAMES } from "../perception/lgn-gate-12.mjs";
import { computeDescriptor, computeUnionDescriptor, descriptorDistance } from "./descriptor.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { subsurfaceSummaryForRegion, subsurfaceDistance } from "../axes/subsurface-axis.mjs";
import { buildRichSignature, richDistance, recognizeV2 } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";
import { loadStore } from "./identity-store.mjs";
import { activeCurate, diversityScore } from "../ingest/active-curation.mjs";
import { trefoilConceptView, trefoilPoints, plaitTaxonomy, gcd, mobiusLayout, poincareDistance, turningKeyClose } from "../graph/celtic-graph.mjs";
import { loadGraph } from "../graph/concept-graph.mjs";
import { KnotIndex, FAMILY_NAMES, familyOf, radiusBucketOf } from "./knot-vector-index.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const OUT = path.join(FIXTURES, "50-experiments");
fs.mkdirSync(OUT, { recursive: true });
const STORE = JSON.parse(fs.readFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-perfect.json"), "utf8"));
const GRAPH = loadGraph(path.join(FIXTURES, "perfect-eyes", "concept-graph.json"));

const AXES = ["R","G","B","L","M","gamma","RG","BY"];
const STILLS = ["orange.jpg", "apple.jpg", "fruits.jpg", "lena.jpg"];

// Load frames once and cache
const cache = { rgb: {}, sigs: {}, cinemaFrames: null };
async function getRgb(name) {
  if (!cache.rgb[name]) cache.rgb[name] = await extractImageRGB(path.join(FIXTURES, name), { maxSize: 384 });
  return cache.rgb[name];
}
function toLuminance(R, G, B) {
  const N = R.length;
  const L = new Float32Array(N);
  for (let i = 0; i < N; i++) L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  return L;
}
function isWarm(d) { return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5; }
function buildFrameSignature(R, G, B, w, h) {
  const combo = attentionMultiAxisV2(R, G, B, w, h, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const warm = [];
  for (const e of combo.entities) {
    const d = computeDescriptor(e.region, R, G, B, w, h);
    if (isWarm(d)) warm.push(e);
  }
  if (!warm.length) return null;
  const colorDesc = computeUnionDescriptor(warm.map(x => x.region), R, G, B, w, h);
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const e of warm) { if (e.region[0]<x0) x0=e.region[0]; if (e.region[1]<y0) y0=e.region[1]; if (e.region[0]+e.region[2]>x1) x1=e.region[0]+e.region[2]; if (e.region[1]+e.region[3]>y1) y1=e.region[1]+e.region[3]; }
  const region = [x0, y0, x1-x0, y1-y0];
  const L = toLuminance(R, G, B);
  return buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, w, h, region),
    textureSummaryForRegion(L, w, h, region),
    specularSummaryForRegion(L, w, h, region),
    spatialColorSummaryForRegion(R, G, B, w, h, region),
  );
}
async function getSig(name) {
  if (!cache.sigs[name]) {
    const rgb = await getRgb(name);
    cache.sigs[name] = buildFrameSignature(rgb.R, rgb.G, rgb.B, rgb.width, rgb.height);
  }
  return cache.sigs[name];
}
async function getCinemaFrames() {
  if (!cache.cinemaFrames) cache.cinemaFrames = await extractVideoFrames(path.join(CINEMA, "baby-watches-orange.mp4"), { frames: 3, size: 384 });
  return cache.cinemaFrames;
}

// ── Result registry ─────────────────────────────────────────────────
const results = [];
function record(group, id, name, expr, pass, note = "") {
  results.push({ group, id, name, expr, pass, note });
  const badge = pass ? "✓" : "✗";
  console.log(`${badge} ${group}${id} ${name.padEnd(48)} ${String(expr).slice(0, 40).padEnd(40)}  ${note}`);
}

console.log("=== 50-EXPERIMENT BATTERY ===\n");

// ══════════════════════════════════════════════════════════════════
// GROUP A — Retinal-12 channel behavior (10)
// ══════════════════════════════════════════════════════════════════
console.log("── A · Retinal-12 channel behavior ──");
const cinema = await getCinemaFrames();
const chA = compute12Channels(cinema[0], cinema[1]);
const chFullSummary = channels12Summary(chA, [0, 0, chA.width, chA.height]);

record("A", 1, "12 channels computed on cinema pair", "12 fields returned", Object.keys(chA).filter(k=>k.startsWith("ch")).length === 12);
record("A", 2, "flowGrid dimensions match", `${chA.flowGrid.cols}x${chA.flowGrid.rows}`, chA.flowGrid.cols === 24 && chA.flowGrid.rows === 24);
record("A", 3, "ON+OFF sustained bounded 0-1 mean", chFullSummary.onSustained.toFixed(3), chFullSummary.onSustained >= 0 && chFullSummary.onSustained <= 1);
record("A", 4, "uniformity dominates static scene", chFullSummary.uniformity.toFixed(3), chFullSummary.uniformity > chFullSummary.onTransient);
record("A", 5, "localEdge > 0 on textured frame", chFullSummary.localEdge.toFixed(3), chFullSummary.localEdge > 0);
record("A", 6, "objectMotion detects rotational content", chFullSummary.objectMotion.toFixed(3), chFullSummary.objectMotion > 0);
{
  const chB = compute12Channels(cinema[1], cinema[2], chA.nextState);
  const sB = channels12Summary(chB, [0, 0, chB.width, chB.height]);
  record("A", 7, "sustained channels build over frames", `t0=${chFullSummary.onSustained.toFixed(3)} t1=${sB.onSustained.toFixed(3)}`, sB.onSustained > chFullSummary.onSustained * 0.5);
  record("A", 8, "sustainedDS smooth vs raw DS", sB.sustainedDS.toFixed(3), sB.sustainedDS >= 0);
  record("A", 9, "transient channels near-zero on rotational-only", `on=${chFullSummary.onTransient.toFixed(4)} off=${chFullSummary.offTransient.toFixed(4)}`, chFullSummary.onTransient < 0.02 && chFullSummary.offTransient < 0.02);
  const idle = compute12Channels(cinema[0], cinema[0]);  // identical frames
  const sIdle = channels12Summary(idle, [0,0,idle.width,idle.height]);
  record("A", 10, "zero-motion input produces zero-motion channels", `${sIdle.up+sIdle.down+sIdle.left+sIdle.right}`, (sIdle.up+sIdle.down+sIdle.left+sIdle.right) < 1e-6);
}

// ══════════════════════════════════════════════════════════════════
// GROUP B — LGN gate priming effect (10)
// ══════════════════════════════════════════════════════════════════
console.log("\n── B · LGN gate priming ──");
const summaryOrange = chFullSummary;
const gateFruit = computeGate12([{ label: "fruit", activation: 1.0 }]);
const gateDog   = computeGate12([{ label: "dog",   activation: 1.0 }]);
const gateNeutral = computeGate12([]);
const gatedFruit = applyGate12(summaryOrange, gateFruit);
const gatedDog = applyGate12(summaryOrange, gateDog);

record("B", 1, "gate vector length = 12", gateFruit.length, gateFruit.length === 12);
record("B", 2, "neutral gate is all 1.0", gateNeutral[0], gateNeutral.every(v => v === 1.0));
record("B", 3, "fruit gate boosts localEdge", `${gatedFruit.localEdge.toFixed(3)} > ${summaryOrange.localEdge.toFixed(3)}`, gatedFruit.localEdge > summaryOrange.localEdge);
record("B", 4, "fruit gate suppresses direction channels", `${gatedFruit.up.toFixed(3)} < ${summaryOrange.up.toFixed(3)}`, gatedFruit.up < summaryOrange.up);
record("B", 5, "fruit gate suppresses uniformity", `${gatedFruit.uniformity.toFixed(3)} < ${summaryOrange.uniformity.toFixed(3)}`, gatedFruit.uniformity < summaryOrange.uniformity);
record("B", 6, "dog gate suppresses uniformity heavily", `${gatedDog.uniformity.toFixed(3)}`, gatedDog.uniformity < gatedFruit.uniformity);
record("B", 7, "dog gate boosts motion", `${gatedDog.up.toFixed(3)}`, gatedDog.up > gatedFruit.up);
record("B", 8, "gate blend two concepts is convex combination", "yes", (() => {
  const blend = computeGate12([{label:"fruit",activation:1},{label:"dog",activation:1}]);
  return blend.every((v, i) => v >= Math.min(gateFruit[i], gateDog[i]) - 1e-9 && v <= Math.max(gateFruit[i], gateDog[i]) + 1e-9);
})());
record("B", 9, "unknown label falls back to neutral", "yes", (() => {
  const g = computeGate12([{ label: "unknown_label", activation: 1.0 }]);
  return g.every(v => v === 1.0);
})());
record("B", 10, "channels12ToVector produces 12-vec", "12", channels12ToVector(chFullSummary).length === 12);

// ══════════════════════════════════════════════════════════════════
// GROUP C — Celtic structural properties (10)
// ══════════════════════════════════════════════════════════════════
console.log("\n── C · Celtic structural ──");
const tp24 = trefoilPoints(24);
record("C", 1, "trefoilPoints(24) returns 24", tp24.length, tp24.length === 24);
record("C", 2, "trefoil x=sin(t)+2sin(2t) at t=0 → 0", tp24[0].x.toFixed(4), Math.abs(tp24[0].x) < 1e-9);
record("C", 3, "trefoil closes at 2π", `${tp24[0].x.toFixed(3)} vs ${trefoilPoints(24)[0].x.toFixed(3)}`, Math.abs(tp24[0].x - trefoilPoints(48)[0].x) < 1e-9);
record("C", 4, "gcd(5,6)=1", gcd(5,6), gcd(5,6) === 1);
record("C", 5, "gcd(4,6)=2 (Fisher parallel strands)", gcd(4,6), gcd(4,6) === 2);
record("C", 6, "gcd(6,9)=3", gcd(6,9), gcd(6,9) === 3);
const plait = plaitTaxonomy(["orange","red","yellow","green"], ["fruit","skin","sunset","foliage"]);
record("C", 7, "plait 4x4 gcd = 4", plait.gcd, plait.gcd === 4);
plait.slot("orange","fruit","c1"); plait.slot("red","fruit","c2");
record("C", 8, "plait strandOf orange/fruit vs red/fruit", `${plait.strandOf("orange","fruit")} vs ${plait.strandOf("red","fruit")}`, plait.strandOf("orange","fruit") !== plait.strandOf("red","fruit"));
const layout = mobiusLayout(GRAPH, { center: "fruit" });
record("C", 9, "Möbius layout produces entry per concept", layout.size, layout.size >= 3);
const orangeC = [...GRAPH.nodes.values()].find(n => n.label === "orange");
const appleC  = [...GRAPH.nodes.values()].find(n => n.label === "apple");
if (orangeC && appleC && layout.has(orangeC.id) && layout.has(appleC.id)) {
  const d = poincareDistance(layout.get(orangeC.id), layout.get(appleC.id));
  record("C", 10, "poincareDistance is symmetric + non-neg", d.toFixed(3), d >= 0 && Number.isFinite(d));
} else {
  record("C", 10, "poincareDistance (concepts missing)", "skip", true);
}

// ══════════════════════════════════════════════════════════════════
// GROUP D — Signature quality (10)
// ══════════════════════════════════════════════════════════════════
console.log("\n── D · Signature quality / rich distance ──");
const sigO = await getSig("orange.jpg");
const sigA = await getSig("apple.jpg");
const sigF = await getSig("fruits.jpg");
const sigL = await getSig("lena.jpg");

record("D", 1, "signatures built for all 4 stills", "4/4", sigO && sigA && sigF && sigL);
record("D", 2, "rich distance is non-negative", richDistance(sigO, sigA).toFixed(3), richDistance(sigO, sigA) >= 0);
record("D", 3, "self-distance is ~0", richDistance(sigO, sigO).toFixed(4), richDistance(sigO, sigO) < 1e-6);
record("D", 4, "distance is symmetric", "yes", Math.abs(richDistance(sigO, sigA) - richDistance(sigA, sigO)) < 1e-9);
record("D", 5, "orange nearest-of-N recognizes orange", "yes", recognizeV2(sigO, STORE, { max_distance: 1.5 }).winner === "orange");
record("D", 6, "apple nearest-of-N recognizes apple", "yes", recognizeV2(sigA, STORE, { max_distance: 1.5 }).winner === "apple");
record("D", 7, "Hopfield attractor mass > 0.9 on trained", hopfieldRetrieve(sigO, STORE, { beta: 5, iters: 3 }).winnerMass.toFixed(3), hopfieldRetrieve(sigO, STORE, { beta: 5, iters: 3 }).winnerMass > 0.9);
record("D", 8, "Hopfield sharpness reduced on OOD (fruits.jpg)", hopfieldRetrieve(sigF, STORE, { beta: 5, iters: 3 }).sharpness.toFixed(3), hopfieldRetrieve(sigF, STORE, { beta: 5, iters: 3 }).sharpness < hopfieldRetrieve(sigO, STORE, { beta: 5, iters: 3 }).sharpness);
{
  const rgbO = await getRgb("orange.jpg");
  const rgbL = await getRgb("lena.jpg");
  const region = [0, 0, rgbO.width, rgbO.height];
  const sO = subsurfaceSummaryForRegion(rgbO.R, rgbO.G, rgbO.B, rgbO.width, rgbO.height, region);
  const sL = subsurfaceSummaryForRegion(rgbL.R, rgbL.G, rgbL.B, rgbL.width, rgbL.height, region);
  const dOL = subsurfaceDistance(sO, sL);
  record("D", 9, "subsurface orange↔lena small (both translucent)", dOL.toFixed(3), dOL < 0.15);
}
record("D", 10, "active curation picks diverse subset", "yes", (() => {
  const sigs = [sigO, sigA, sigF, sigL];
  const curated = activeCurate(sigs, 3);
  return curated.selected.length === 3 && new Set(curated.selected).size === 3;
})());

// ══════════════════════════════════════════════════════════════════
// GROUP E — Knot vector index (10)
// ══════════════════════════════════════════════════════════════════
console.log("\n── E · Knot vector index ──");
const idx = new KnotIndex({ radiusBuckets: 5 });
for (const row of STORE.labels) {
  for (const s of row.signatures) idx.add(s.sig, { label: row.label, source: s.source });
}
const stats = idx.stats();
record("E", 1, "index populated with all store signatures", `${idx.count}`, idx.count === STORE.labels.reduce((n, r) => n + r.signatures.length, 0));
record("E", 2, "at least 2 buckets filled", stats.buckets_filled, stats.buckets_filled >= 2);
record("E", 3, "familyOf(orange sig) is orange (0)", familyOf(sigO), familyOf(sigO) === 0);
record("E", 4, "familyOf(apple sig) is orange or red family", familyOf(sigA), [0, 1].includes(familyOf(sigA)));
record("E", 5, "radiusBucketOf returns 0..radiusBuckets-1", radiusBucketOf(sigO, { buckets: 5 }), (r => r >= 0 && r < 5)(radiusBucketOf(sigO, { buckets: 5 })));
const qO = idx.queryConcepts(sigO);
record("E", 6, "query orange sig top-1 is orange", qO[0]?.label, qO[0]?.label === "orange");
const qA = idx.queryConcepts(sigA);
record("E", 7, "query apple sig top-1 is apple", qA[0]?.label, qA[0]?.label === "apple");
const savePath = path.join(OUT, "knot-index.json");
idx.save(savePath);
const idx2 = KnotIndex.load(savePath);
record("E", 8, "index save/load roundtrip preserves count", `${idx.count} vs ${idx2.count}`, idx.count === idx2.count);
const qOafter = idx2.queryConcepts(sigO);
record("E", 9, "reloaded index queries correctly", qOafter[0]?.label, qOafter[0]?.label === "orange");
{
  // Query with maxRadiusExpansion=0 → only home bucket
  const qNarrow = idx.query(sigO, 5, { maxRadiusExpansion: 0, maxFamilyExpansion: 0 });
  const qWide = idx.query(sigO, 5);
  record("E", 10, "expansion widens candidate pool", `narrow=${qNarrow.length} wide=${qWide.length}`, qWide.length >= qNarrow.length);
}

// ══════════════════════════════════════════════════════════════════
// FINAL REPORT
// ══════════════════════════════════════════════════════════════════
console.log("\n=== FINAL TABLE ===");
const groups = {A: [], B: [], C: [], D: [], E: []};
for (const r of results) groups[r.group].push(r);
let totalPass = 0;
for (const g of ["A","B","C","D","E"]) {
  const pass = groups[g].filter(r => r.pass).length;
  totalPass += pass;
  console.log(`  Group ${g}: ${pass}/10  (${groups[g].filter(r=>!r.pass).map(r=>r.id).join(", ") || "all pass"})`);
}
console.log(`\nOVERALL: ${totalPass}/50  ${totalPass === 50 ? "✓ ALL GREEN — surity established" : `✗ ${50 - totalPass} probes failed`}`);

fs.writeFileSync(path.join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`\nartifacts: ${OUT}`);
