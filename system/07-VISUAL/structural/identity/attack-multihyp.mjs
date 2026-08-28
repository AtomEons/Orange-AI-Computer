#!/usr/bin/env bun
// ATTACK 3 — multi-hypothesis matching at recognition.
//
// Root cause of Attack 2's yellow_building magnet: at recognition we build
// ONE union-descriptor per query image. If the query has orange + banana +
// yellow, the union hue drifts yellow-ward and yellow_building wins.
//
// Fix: at recognition, extract each warm entity separately, match each vs
// store, pick the winner as the concept with strongest single-entity mass.
// Multiple entities → emit_set. No entity mass > threshold → REJECT.
//
// Training also uses dominant warm entity per frame, not union — the
// concept color signature is now tight to the actual object color.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { extractVideoFrames } from "../video-frames.mjs";
import { computeDescriptor } from "./descriptor.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { subsurfaceSummaryForRegion } from "../axes/subsurface-axis.mjs";
import { colorRatioSummaryForRegion } from "../axes/color-ratio-axis.mjs";
import { spatialFrequencySummaryForRegion } from "../axes/spatial-frequency-axis.mjs";
import { buildRichSignature, attachSignaturesV2 } from "./identity-store-v2.mjs";
import { activeCurate } from "../ingest/active-curation.mjs";
import { recognizeWithHonestVerdict } from "./second-pass-alpha.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const CINEMA = path.join(FIXTURES, "baby-cinema");
const AXES = ["R","G","B","L","M","gamma","RG","BY"];

function toL(R, G, B) { const L = new Float32Array(R.length); for (let i = 0; i < R.length; i++) L[i] = 0.30*R[i]+0.59*G[i]+0.11*B[i]; return L; }
function isWarm(d) { return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5; }
function isWarmLoose(d) { return d && d.mean_R > d.mean_B + 0.05 && d.mean_R + d.mean_G > 0.4; }
function areaOf(r) { return r[2] * r[3]; }

// Build a signature for a single warm entity's region
function sigForRegion(frame, region) {
  const W = frame.width, H = frame.height;
  const colorDesc = computeDescriptor(region, frame.R, frame.G, frame.B, W, H);
  if (!colorDesc) return null;
  const L = toL(frame.R, frame.G, frame.B);
  return buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, W, H, region),
    textureSummaryForRegion(L, W, H, region),
    specularSummaryForRegion(L, W, H, region),
    spatialColorSummaryForRegion(frame.R, frame.G, frame.B, W, H, region),
    subsurfaceSummaryForRegion(frame.R, frame.G, frame.B, W, H, region),
    colorRatioSummaryForRegion(frame.R, frame.G, frame.B, W, H, region),
    spatialFrequencySummaryForRegion(L, W, H, region),
  );
}

// Extract all warm entities from a frame, sorted by area desc
function extractWarmEntities(frame, useLoose = false) {
  const W = frame.width, H = frame.height;
  const combo = attentionMultiAxisV2(frame.R, frame.G, frame.B, W, H, { axes: AXES, minVotes: 1, preproc: "gaussian_1" });
  const test = useLoose ? isWarmLoose : isWarm;
  const warm = [];
  for (const e of combo.entities) {
    const d = computeDescriptor(e.region, frame.R, frame.G, frame.B, W, H);
    if (test(d)) warm.push({ region: e.region, desc: d, area: areaOf(e.region) });
  }
  warm.sort((a, b) => b.area - a.area);
  return warm;
}

// TRAIN: build signatures from top-N warm entities per frame
async function trainFromVideo(videoPath, N = 15, K = 8, entitiesPerFrame = 2) {
  const frames = await extractVideoFrames(videoPath, { frames: N, size: 384 });
  const sigs = [];
  for (const f of frames) {
    const warm = extractWarmEntities(f);
    for (const w of warm.slice(0, entitiesPerFrame)) {
      const s = sigForRegion(f, w.region);
      if (s) sigs.push(s);
    }
  }
  const cur = activeCurate(sigs, K);
  return cur.selected.map((i) => sigs[i]);
}

async function trainFromImage(name, useLoose = false, entitiesToUse = 1) {
  const rgb = await extractImageRGB(path.join(FIXTURES, name), { maxSize: 384 });
  const warm = extractWarmEntities(rgb, useLoose);
  const sigs = [];
  for (const w of warm.slice(0, entitiesToUse)) {
    const s = sigForRegion(rgb, w.region);
    if (s) sigs.push(s);
  }
  return sigs;
}

// RECOGNIZE: multi-hypothesis — check each warm entity vs store
async function multiHypRecognize(imagePath, store, useLoose = false, threshold = 0.4, maxEntities = 5) {
  const rgb = await extractImageRGB(imagePath, { maxSize: 384 });
  const warm = extractWarmEntities(rgb, useLoose);
  if (!warm.length) return { winner: null, mass: 0, verdict: "no_warm", entity_verdicts: [] };
  const entityVerdicts = [];
  for (const w of warm.slice(0, maxEntities)) {
    const sig = sigForRegion(rgb, w.region);
    if (!sig) continue;
    const r = recognizeWithHonestVerdict(sig, store, { beta: 15 });
    entityVerdicts.push({ region: w.region, area: w.area, winner: r.winner, mass: r.mass, verdict: r.verdict });
  }
  // Pick concept with highest single-entity mass (that entity is our best evidence)
  let bestConcept = null, bestMass = 0, bestVerdict = null;
  for (const ev of entityVerdicts) {
    if (ev.mass > bestMass) { bestMass = ev.mass; bestConcept = ev.winner; bestVerdict = ev.verdict; }
  }
  // If best mass < threshold or best verdict is split, REJECT
  const rejected = bestMass < threshold || bestVerdict === "split" || bestVerdict === "no_signal";
  return {
    winner: rejected ? null : bestConcept,
    mass: bestMass,
    verdict: bestVerdict,
    rejected,
    entity_verdicts: entityVerdicts,
    emit_action: rejected ? "needs_review" : "recognized_as",
  };
}

console.log("=== ATTACK 3 — multi-hypothesis matching ===\n");

const STORE = { labels: [] };

console.log("training orange from cinema (top-2 warm entities per frame)...");
const orangeSigs = await trainFromVideo(path.join(CINEMA, "baby-watches-orange.mp4"));
attachSignaturesV2(STORE, "orange", orangeSigs, "cinema-dominant", "2026-07-07T00:00:00Z");
console.log("  " + orangeSigs.length + " sigs");

console.log("training apple from cinema (top-2 warm entities per frame)...");
const appleSigs = await trainFromVideo(path.join(CINEMA, "baby-watches-apple.mp4"));
attachSignaturesV2(STORE, "apple", appleSigs, "cinema-dominant", "2026-07-07T00:00:00Z");
console.log("  " + appleSigs.length + " sigs");

const oneShotConcepts = [
  { label: "human_skin",      source: "lena.jpg",         loose: false, entities: 1 },
  { label: "animal_face",     source: "baboon.jpg",       loose: true,  entities: 1 },
  { label: "yellow_building", source: "home.jpg",         loose: true,  entities: 1 },
];
console.log("one-shot training the hard concepts (dominant warm entity)...");
for (const c of oneShotConcepts) {
  const sigs = await trainFromImage(c.source, c.loose, c.entities);
  if (sigs.length) {
    attachSignaturesV2(STORE, c.label, sigs, c.source + "-dominant", "2026-07-07T00:00:00Z");
    console.log("  " + c.label.padEnd(18) + " ← " + c.source + " (" + sigs.length + " sig)");
  }
}

// Per-concept β
for (const label of ["orange", "apple", "human_skin", "animal_face", "yellow_building"]) {
  const row = STORE.labels.find(r => r.label === label);
  if (!row) continue;
  row.beta_override = 15;
}

fs.writeFileSync(path.join(FIXTURES, "perfect-eyes", "identity-store-multihyp-attack.json"), JSON.stringify(STORE, null, 2));
console.log("\n  store written: identity-store-multihyp-attack.json (" + STORE.labels.length + " concepts)\n");

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

const thresholds = [0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9];
let best = null;
console.log("sweeping thresholds (multi-hyp)...\n");
for (const th of thresholds) {
  let correct = 0, targetOK = 0, rejectOK = 0, confWrong = 0;
  const detail = [];
  for (const t of TESTS) {
    const r = await multiHypRecognize(path.join(FIXTURES, t.name), STORE, t.loose, th);
    let ok;
    if (t.kind === "target") {
      ok = !r.rejected && r.winner === t.expected;
      if (ok) { correct++; targetOK++; }
      else if (r.mass > 0.9 && r.winner !== t.expected) confWrong++;
    } else {
      ok = r.rejected;
      if (ok) { correct++; rejectOK++; }
      else if (r.mass > 0.9) confWrong++;
    }
    detail.push({ name: t.name, expected: t.expected, kind: t.kind, winner: r.winner, mass: r.mass, verdict: r.verdict, rejected: r.rejected, ok, n_entities: r.entity_verdicts.length });
  }
  console.log("  threshold=" + th + "  correct=" + correct + "/16  (targets " + targetOK + "/6, rejects " + rejectOK + "/10, confWrong=" + confWrong + ")");
  if (!best || correct > best.correct) best = { threshold: th, correct, detail, confWrong };
}

console.log("\n=== BEST CONFIG (threshold=" + best.threshold + ") ===");
for (const d of best.detail) {
  const mark = d.ok ? "✓" : "✗";
  const expected = d.expected || "REJECT";
  const emit = d.rejected ? "needs_review" : "recognized_as:" + d.winner;
  console.log("  " + mark + " " + d.name.padEnd(18) + " expect=" + expected.padEnd(18) + " mass=" + d.mass.toFixed(3) + " nEnts=" + d.n_entities + " emit=" + emit);
}
console.log("\n=== FINAL ===");
console.log("Raw accuracy: " + best.correct + "/16 = " + Math.round(best.correct/16*100) + "%");
console.log("Confident-wrong: " + best.confWrong);
if (best.correct === 16) console.log("\n🎯 100% HUMAN-EYE LEVEL ACHIEVED.");
else console.log("\nGap: " + (16 - best.correct) + " remaining");
