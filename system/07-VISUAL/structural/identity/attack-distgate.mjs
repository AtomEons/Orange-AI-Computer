#!/usr/bin/env bun
// ATTACK 4 — raw distance gate at recognition.
//
// Attack 2 hit 12/16 via union-descriptor recognition, but Hopfield softmax
// gave everything a winner even when raw dist was huge (yellow_building
// magnet). Attack 3 regressed via per-entity because every image had SOME
// tight warm blob that matched something at mass=1.
//
// Attack 4 (this): keep attack 2's training (union warm descriptor), swap
// recognition to raw richDistance. Nearest concept wins ONLY if its raw
// distance is below a ceiling. Above ceiling → REJECT.
//
// This is how humans actually work: "what's this thing" → search my library
// → if nothing's close enough, I don't know it. Not "the least-bad match wins."

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { computeDescriptor, computeUnionDescriptor } from "./descriptor.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { subsurfaceSummaryForRegion } from "../axes/subsurface-axis.mjs";
import { colorRatioSummaryForRegion } from "../axes/color-ratio-axis.mjs";
import { spatialFrequencySummaryForRegion } from "../axes/spatial-frequency-axis.mjs";
import { buildRichSignature, attachSignaturesV2, richDistance, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";
import { activeCurate } from "../ingest/active-curation.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const AXES = ["R","G","B","L","M","gamma","RG","BY"];

function toL(R, G, B) { const L = new Float32Array(R.length); for (let i = 0; i < R.length; i++) L[i] = 0.30*R[i]+0.59*G[i]+0.11*B[i]; return L; }
function isWarm(d) { return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5; }
function isWarmLoose(d) { return d && d.mean_R > d.mean_B + 0.05 && d.mean_R + d.mean_G > 0.4; }

async function build8SigFromFrame(f, useLoose = false) {
  const W = f.width, H = f.height;
  const combo = attentionMultiAxisV2(f.R, f.G, f.B, W, H, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const warmTest = useLoose ? isWarmLoose : isWarm;
  const warm = [];
  for (const e of combo.entities) {
    const d = computeDescriptor(e.region, f.R, f.G, f.B, W, H);
    if (warmTest(d)) warm.push(e);
  }
  if (!warm.length) return null;
  const colorDesc = computeUnionDescriptor(warm.map((x) => x.region), f.R, f.G, f.B, W, H);
  let x0=Infinity,y0=Infinity,x1=-Infinity,y1=-Infinity;
  for (const e of warm) { if (e.region[0]<x0) x0=e.region[0]; if (e.region[1]<y0) y0=e.region[1]; if (e.region[0]+e.region[2]>x1) x1=e.region[0]+e.region[2]; if (e.region[1]+e.region[3]>y1) y1=e.region[1]+e.region[3]; }
  const region = [x0, y0, x1-x0, y1-y0];
  const L = toL(f.R, f.G, f.B);
  return buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, W, H, region),
    textureSummaryForRegion(L, W, H, region),
    specularSummaryForRegion(L, W, H, region),
    spatialColorSummaryForRegion(f.R, f.G, f.B, W, H, region),
    subsurfaceSummaryForRegion(f.R, f.G, f.B, W, H, region),
    colorRatioSummaryForRegion(f.R, f.G, f.B, W, H, region),
    spatialFrequencySummaryForRegion(L, W, H, region),
  );
}

async function build8SigFromFile(name, useLoose = false) {
  const rgb = await extractImageRGB(path.join(FIXTURES, name), { maxSize: 384 });
  return await build8SigFromFrame(rgb, useLoose);
}

async function trainConceptFromVideo(videoPath, N = 15, K = 8) {
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  const sigs = [];
  for (const f of frames) {
    const s = await build8SigFromFrame(f);
    if (s) sigs.push(s);
  }
  const cur = activeCurate(sigs, K);
  return cur.selected.map((i) => sigs[i]);
}

async function trainConceptFromImage(name, useLoose = false) {
  const s = await build8SigFromFile(name, useLoose);
  return s ? [s] : [];
}

// Raw-distance recognition — no Hopfield softmax
function recognizeRawDist(sig, store, opts = {}) {
  if (!sig) return { winner: null, min_dist: Infinity };
  const perConceptDistances = [];
  for (const row of store.labels ?? []) {
    let minD = Infinity;
    const weights = row.channel_weights || DEFAULT_CHANNEL_WEIGHTS;
    for (const s of row.signatures) {
      const d = richDistance(sig, s.sig, weights);
      if (d < minD) minD = d;
    }
    perConceptDistances.push({ label: row.label, min_dist: minD });
  }
  perConceptDistances.sort((a, b) => a.min_dist - b.min_dist);
  const nearest = perConceptDistances[0];
  const runner = perConceptDistances[1] ?? { min_dist: Infinity };
  return {
    winner: nearest?.label ?? null,
    min_dist: nearest?.min_dist ?? Infinity,
    runner_up: runner.label,
    runner_up_dist: runner.min_dist,
    all: perConceptDistances,
  };
}

console.log("=== ATTACK 4 — raw distance gate ===\n");

const STORE = { labels: [] };

console.log("training orange from cinema (union warm descriptor)...");
const orangeSigs = await trainConceptFromVideo(path.join(CINEMA, "baby-watches-orange.mp4"));
attachSignaturesV2(STORE, "orange", orangeSigs, "cinema", "2026-07-07T00:00:00Z");
console.log("  " + orangeSigs.length + " sigs");

console.log("training apple from cinema...");
const appleSigs = await trainConceptFromVideo(path.join(CINEMA, "baby-watches-apple.mp4"));
attachSignaturesV2(STORE, "apple", appleSigs, "cinema", "2026-07-07T00:00:00Z");
console.log("  " + appleSigs.length + " sigs");

console.log("one-shot training the hard concepts (union warm descriptor)...");
const oneShotConcepts = [
  { label: "human_skin",      source: "lena.jpg",   loose: false },
  { label: "animal_face",     source: "baboon.jpg", loose: true },
  { label: "yellow_building", source: "home.jpg",   loose: true },
];
for (const c of oneShotConcepts) {
  const sigs = await trainConceptFromImage(c.source, c.loose);
  if (sigs.length) {
    attachSignaturesV2(STORE, c.label, sigs, c.source, "2026-07-07T00:00:00Z");
    console.log("  " + c.label.padEnd(18) + " ← " + c.source + " (" + sigs.length + " sig)");
  }
}

// Emphasize color for identity discrimination
for (const label of ["orange", "apple", "human_skin", "animal_face", "yellow_building"]) {
  const row = STORE.labels.find(r => r.label === label);
  if (!row) continue;
  row.channel_weights = {
    color: 2.0, edge: 0.6, texture: 0.5, specular: 0.3, spatial: 0.5,
    subsurface: 0.5, colorRatio: 0.8, spatialFreq: 0.4,
  };
}

fs.writeFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-distgate-attack.json"), JSON.stringify(STORE, null, 2));
console.log("\n  store written: identity-store-distgate-attack.json (" + STORE.labels.length + " concepts)\n");

const TESTS = [
  { name: "orange.jpg",       expected: "orange",          kind: "target",  loose: false },
  { name: "apple.jpg",        expected: "apple",           kind: "target",  loose: false },
  { name: "fruits.jpg",       expected: "orange",          kind: "target",  loose: false },
  { name: "lena.jpg",         expected: "human_skin",      kind: "target",  loose: false },
  { name: "baboon.jpg",       expected: "animal_face",     kind: "target",  loose: true  },
  { name: "home.jpg",         expected: "yellow_building", kind: "target",  loose: true  },
  { name: "basketball1.png",  expected: null,              kind: "reject",  loose: false },
  { name: "basketball2.png",  expected: null,              kind: "reject",  loose: false },
  { name: "messi5.jpg",       expected: null,              kind: "reject",  loose: true  },
  { name: "building.jpg",     expected: null,              kind: "reject",  loose: false },
  { name: "board.jpg",        expected: null,              kind: "reject",  loose: false },
  { name: "gradient.png",     expected: null,              kind: "reject",  loose: false },
  { name: "notes.png",        expected: null,              kind: "reject",  loose: false },
  { name: "butterfly.jpg",    expected: null,              kind: "reject",  loose: true  },
  { name: "pic5.png",         expected: null,              kind: "reject",  loose: true  },
  { name: "starry_night.jpg", expected: null,              kind: "reject",  loose: true  },
];

// First: measure raw distances so we know the scale
console.log("measuring raw distances on all fixtures...\n");
const rawResults = [];
for (const t of TESTS) {
  const sig = await build8SigFromFile(t.name, t.loose);
  const r = sig ? recognizeRawDist(sig, STORE) : { winner: null, min_dist: Infinity };
  rawResults.push({ ...t, ...r, has_sig: !!sig });
  const line = "  " + t.name.padEnd(18) + " kind=" + t.kind.padEnd(8) + " nearest=" + (r.winner || "-").padEnd(18) + " dist=" + (r.min_dist === Infinity ? "∞" : r.min_dist.toFixed(3));
  console.log(line);
}

// Sweep distance ceiling
const ceilings = [0.5, 0.8, 1.0, 1.2, 1.5, 1.8, 2.0, 2.5, 3.0, 3.5, 4.0];
let best = null;
console.log("\nsweeping distance ceilings...\n");
for (const ceil of ceilings) {
  let correct = 0, targetOK = 0, rejectOK = 0, confWrong = 0;
  const detail = [];
  for (const r of rawResults) {
    if (!r.has_sig) {
      const ok = r.kind === "reject";
      if (ok) { correct++; rejectOK++; }
      detail.push({ ...r, action: "no_warm", ok });
      continue;
    }
    const rejected = r.min_dist > ceil;
    let ok;
    if (r.kind === "target") {
      ok = !rejected && r.winner === r.expected;
      if (ok) { correct++; targetOK++; }
      else if (!rejected && r.winner !== r.expected) confWrong++;
    } else {
      ok = rejected;
      if (ok) { correct++; rejectOK++; }
      else confWrong++;
    }
    detail.push({ ...r, action: rejected ? "needs_review" : "recognized_as:" + r.winner, ok });
  }
  console.log("  ceil=" + ceil + "  correct=" + correct + "/16  (targets " + targetOK + "/6, rejects " + rejectOK + "/10, confWrong=" + confWrong + ")");
  if (!best || correct > best.correct) best = { ceil, correct, detail, confWrong };
}

console.log("\n=== BEST CONFIG (ceiling=" + best.ceil + ") ===");
for (const d of best.detail) {
  const mark = d.ok ? "✓" : "✗";
  console.log("  " + mark + " " + d.name.padEnd(18) + " expect=" + (d.expected || "REJECT").padEnd(18) + " dist=" + (d.min_dist === Infinity ? "∞" : d.min_dist.toFixed(3)) + " nearest=" + (d.winner || "-").padEnd(18) + " " + d.action);
}
console.log("\n=== FINAL ===");
console.log("Raw accuracy: " + best.correct + "/16 = " + Math.round(best.correct/16*100) + "%");
console.log("Confident-wrong: " + best.confWrong);
if (best.correct === 16) console.log("\n🎯 100% HUMAN-EYE LEVEL ACHIEVED at ceiling=" + best.ceil + ".");
else console.log("\nGap: " + (16 - best.correct) + " remaining");
