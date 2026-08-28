#!/usr/bin/env bun
// prove-subspace.mjs — Fable Move 6 validator.
//
// For each concept in the store, build a photon-genome model (prototype +
// nuisance basis + residual quantiles). For each held-out video, extract
// candidate signatures per frame, ask each concept "does this fit your
// subspace?", and pick the concept whose subspace best explains the query —
// gated by the concept's own 95th-percentile training residual (unknown gate).
//
// Reports:
//   - closed-set accuracy (over the confident-answer set)
//   - unknown-gate honesty (how many probes triggered "unknown"?)
//   - confident-wrong count (verdicts inside the gate that were false)
//   - separation quality (winner-vs-runner-up residual ratio, per probe)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { candidatesForFrame } from "./recognize-human-grade.mjs";
import { buildConceptSubspace, recognizeFrameMultiCandidate } from "./subspace-recall.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const STORE_PATH = process.argv[2];
if (!STORE_PATH) { console.error("usage: prove-subspace.mjs STORE_PATH"); process.exit(1); }
const STORE = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));

console.log("=== PROVE-SUBSPACE · STORE: " + path.basename(STORE_PATH) + " · N=" + STORE.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const D = STORE.fisher_stats.D;
console.log("D=" + D + "\n");

// Build concept models
function sanitize(v) {
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = Number.isFinite(v[i]) ? v[i] : 0;
  return out;
}
console.log("Building " + STORE.labels.length + " concept subspaces...");
const conceptModels = new Map();
for (const row of STORE.labels) {
  const vecs = row.signatures.map(s => sanitize(standardizeSignatureVector(flattenSignature(s.sig), STORE.fisher_stats)));
  if (vecs.length < 2) continue;
  const model = buildConceptSubspace(vecs, { kMax: 4 });
  conceptModels.set(row.label, model);
}
console.log("Built " + conceptModels.size + " models. Sample stats:");
{
  let i = 0;
  for (const [label, m] of conceptModels.entries()) {
    if (i++ >= 5) break;
    console.log("  " + label.padEnd(20) + " n=" + m.n + " kEff=" + m.kEff + " Q50=" + m.residualQ50.toFixed(2) + " Q95=" + m.residualQ95.toFixed(2));
  }
}
console.log();

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s)), nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

console.log("Precomputing candidates for held-out clips...");
const cache = [];
for (const row of STORE.labels) {
  if (!conceptModels.has(row.label)) continue;
  const dir = path.join(CORPUS_ROOT, slugify(row.label === "orange_fruit" ? "orange" : row.label === "apple_fruit" ? "apple" : row.label));
  const dirAlt = fs.existsSync(dir) ? dir : path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dirAlt)) continue;
  const files = fs.readdirSync(dirAlt).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dirAlt, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); } catch (e) { continue; }
  const perFrame = [];
  for (const f of frames) {
    // CANDIDATE PARITY: same generator as ingest (unions, both gates).
    const cs = candidatesForFrame(f);
    perFrame.push(cs.map(c => sanitize(standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats))));
  }
  cache.push({ label: row.label, perFrame });
}
console.log("Cached " + cache.length + " videos.\n");

// Per-video verdict: aggregate frames by min-residual per concept, then pick concept.
function classifyVideo(entry) {
  const perConceptBest = new Map();
  for (const qvecs of entry.perFrame) {
    if (!qvecs.length) continue;
    const r = recognizeFrameMultiCandidate(qvecs, conceptModels);
    for (const alt of r.alternatives) {
      const cur = perConceptBest.get(alt.label);
      if (!cur || alt.residual < cur.residual) perConceptBest.set(alt.label, alt);
    }
  }
  if (!perConceptBest.size) return null;
  const ranked = [...perConceptBest.entries()].map(([label, s]) => ({ label, ...s })).sort((a, b) => a.normResidual - b.normResidual);
  const winner = ranked[0];
  const runnerUp = ranked[1];
  const separation = (runnerUp?.normResidual ?? Infinity) / Math.max(1e-6, winner.normResidual);
  // TWO-STAGE unknown gate (Move 6 refinement after seeing over-large radii
  // wash out too much of the honest signal):
  //   (a) winner's residual must be inside its OWN training radius (Q95)
  //   (b) winner must be at least 1.3× as normalized-close as runner-up
  // Both must hold to commit to a label. This kills "coincidentally slid
  // under a huge concept's radius" verdicts.
  const insideRadius = winner.residual <= winner.radius * 1.0;
  const cleanMargin = separation >= 1.3;
  const passes = insideRadius && cleanMargin;
  return {
    winner: passes ? winner.label : null,
    winnerResidual: winner.residual, winnerRadius: winner.radius,
    winnerNormResidual: winner.normResidual,
    runnerUpLabel: runnerUp?.label, runnerUpNormResidual: runnerUp?.normResidual ?? Infinity,
    separation,
    insideRadius, cleanMargin,
    unknownGate: !passes,
  };
}

let correct = 0, tested = 0, confWrong = 0, unknowns = 0;
const missDetails = [];
for (const entry of cache) {
  const v = classifyVideo(entry);
  tested++;
  if (!v) { unknowns++; continue; }
  if (v.unknownGate) { unknowns++; continue; }
  if (v.winner === entry.label) correct++;
  else {
    confWrong++;
    missDetails.push({
      truth: entry.label,
      pred: v.winner,
      residual: v.winnerResidual,
      radius: v.winnerRadius,
      separation: v.separation,
    });
  }
}
const pct = tested ? Math.round(correct / tested * 100) : 0;
const confPool = correct + confWrong;
const confPct = confPool ? Math.round(correct / confPool * 100) : 0;
console.log("=== SUBSPACE RECALL SCORE ===");
console.log("Tested (videos): " + tested);
console.log("Correct           : " + correct);
console.log("Confident-wrong   : " + confWrong);
console.log("Unknown-gate      : " + unknowns);
console.log("");
console.log("Overall accuracy : " + correct + "/" + tested + " = " + pct + "%");
console.log("Confident-only   : " + correct + "/" + confPool + " = " + confPct + "%  (this is 'never-lies' recall — a real answer, not a hedge)");
console.log("Unknown rate     : " + unknowns + "/" + tested + " = " + Math.round(unknowns / tested * 100) + "%");
console.log("");
if (missDetails.length) {
  console.log("Top confident-wrong (residual close to radius):");
  missDetails.sort((a, b) => (a.radius - a.residual) - (b.radius - b.residual));
  for (const m of missDetails.slice(0, 10)) {
    console.log("  " + m.truth.padEnd(18) + " → " + m.pred.padEnd(18) + " res=" + m.residual.toFixed(2) + " rad=" + m.radius.toFixed(2) + " sep=" + m.separation.toFixed(2));
  }
}
