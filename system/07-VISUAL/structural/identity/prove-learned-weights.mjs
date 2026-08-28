#!/usr/bin/env bun
// prove-learned-weights.mjs — apply learnChannelWeightsFromData
// per-concept + Fisher-KNN video-vote validation.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion, BIOLOGICAL_CONCEPTS } from "./recognize-human-grade.mjs";
import { learnChannelWeightsFromData, applyLearnedWeights } from "./second-pass-alpha.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const STORE = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

console.log("=== LEARNED-WEIGHTS + FISHER-KNN VIDEO-VOTE ===\n");
console.log("Concepts: " + STORE.labels.length);

// Learn per-concept discriminative channel weights from confusion matrix
console.log("Learning per-concept channel weights (Hebbian, from data)...");
const learned = learnChannelWeightsFromData(STORE, {
  channels: ["color", "edge", "texture", "specular", "spatial", "subsurface", "colorRatio", "spatialFreq"],
});
console.log("Learned weights for " + learned.size + " concepts\n");
for (const [label, w] of learned.entries()) {
  console.log("  " + label.padEnd(18) + " " + Object.entries(w).map(([k, v]) => k.slice(0, 4) + "=" + v.toFixed(2)).join(" "));
}
applyLearnedWeights(STORE, learned);

// Then Fisher stats & KNN
const stats = attachFisherRatioToStore(STORE);
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
const instances = [];
const conceptInstances = new Map();
for (const row of STORE.labels) {
  const per = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const inst = { label: row.label, vec: std, sig: s.sig };
    instances.push(inst); per.push(inst);
  }
  conceptInstances.set(row.label, per);
}
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
}

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s)), nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

function recognizeFrame(frame) {
  const candidates = [];
  for (const hg of ["warm_loose", "any"]) {
    const warm = extractWarmEntities(frame, { hue_gate: hg });
    if (!warm.length) continue;
    const u = signatureForUnion(frame, warm);
    if (u) candidates.push(u);
    for (const w of warm.slice(0, 5)) {
      for (const region of multiScaleRegions(w.region)) {
        const s = signatureForRegion(frame, region);
        if (s) candidates.push(s);
      }
    }
  }
  if (!candidates.length) return { winner: null };
  const qvecs = candidates.map(c => ({ sig: c, vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats) }));
  let best = Infinity, bestLabel = null, bestKind = null;
  for (const q of qvecs) for (const inst of instances) {
    const d = fisherWeightedDistance(q.vec, inst.vec, fw);
    if (d < best) { best = d; bestLabel = inst.label; bestKind = q.sig; }
  }
  const ceiling = conceptCeilings.get(bestLabel) ?? 10.0;
  if (best > ceiling) return { winner: null };
  return { winner: bestLabel };
}

let correct = 0, tested = 0, confWrong = 0;
console.log("\n=== VIDEO-VOTE ===");
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); } catch (e) { continue; }
  const votes = new Map();
  for (const f of frames) {
    const r = recognizeFrame(f);
    if (r.winner) votes.set(r.winner, (votes.get(r.winner) || 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [winner, count] = ranked[0] || [null, 0];
  const verdict = count > 2 ? winner : null;
  const ok = verdict === row.label;
  const wr = verdict !== null && verdict !== row.label;
  if (ok) correct++;
  if (wr) confWrong++;
  tested++;
  const mark = ok ? "✓" : (wr ? "✗" : "~");
  console.log("  " + mark + " " + row.label.padEnd(18) + " verdict=" + (verdict || "needs_review").padEnd(20) + " votes=" + JSON.stringify(ranked.slice(0, 3)));
}
const pct = tested > 0 ? Math.round(correct / tested * 100) : 0;
console.log("\n=== LEARNED-WEIGHTS SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%");
console.log("Confident-wrong: " + confWrong);
