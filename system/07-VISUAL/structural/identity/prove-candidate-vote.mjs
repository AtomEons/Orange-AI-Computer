#!/usr/bin/env bun
// prove-candidate-vote.mjs — per-frame candidate-level PLURALITY vote.
// Instead of taking min-over-candidates, each candidate casts its own KNN
// vote and we take the plurality within the frame.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion, BIOLOGICAL_CONCEPTS } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const STORE = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

console.log("=== CANDIDATE-VOTE PER-FRAME ===\n");
attachFisherRatioToStore(STORE);
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
  // Each candidate casts its own KNN vote — vote is candidate's nearest concept
  const candidateVotes = new Map();
  for (const c of candidates) {
    const qvec = standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats);
    let best = Infinity, bestLabel = null, bestKind = c;
    for (const inst of instances) {
      const d = fisherWeightedDistance(qvec, inst.vec, fw);
      if (d < best) { best = d; bestLabel = inst.label; }
    }
    // Apply ceiling
    const ceiling = conceptCeilings.get(bestLabel) ?? 10.0;
    if (best > ceiling) continue;
    // Bio gate
    if (BIOLOGICAL_CONCEPTS.has(bestLabel) && bestKind?._subsurface) {
      const sub = bestKind._subsurface;
      const t = sub.translucencyScore ?? 0, es = sub.edgeSoftness ?? 0, sg = sub.shadowGlowRatio ?? 0;
      if (0.6 * t + 0.3 * es + 0.1 * sg <= 0.3) continue;
    }
    candidateVotes.set(bestLabel, (candidateVotes.get(bestLabel) || 0) + 1);
  }
  const ranked = [...candidateVotes.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length) return { winner: null };
  const [winner, count] = ranked[0];
  const total = ranked.reduce((a, [, v]) => a + v, 0);
  // Require majority (>50% of candidate votes)
  if (count / total < 0.5) return { winner: null };
  return { winner };
}

let correct = 0, tested = 0, confWrong = 0;
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); } catch (e) { continue; }
  const videoVotes = new Map();
  for (const f of frames) {
    const r = recognizeFrame(f);
    if (r.winner) videoVotes.set(r.winner, (videoVotes.get(r.winner) || 0) + 1);
  }
  const ranked = [...videoVotes.entries()].sort((a, b) => b[1] - a[1]);
  const [videoWinner, videoCount] = ranked[0] || [null, 0];
  const verdict = videoCount > 2 ? videoWinner : null;
  const ok = verdict === row.label;
  const wr = verdict !== null && verdict !== row.label;
  if (ok) correct++;
  if (wr) confWrong++;
  tested++;
  const mark = ok ? "✓" : (wr ? "✗" : "~");
  console.log("  " + mark + " " + row.label.padEnd(18) + " verdict=" + (verdict || "needs_review").padEnd(18) + " votes=" + JSON.stringify(ranked.slice(0, 3)));
}
const pct = tested > 0 ? Math.round(correct / tested * 100) : 0;
console.log("\n=== CANDIDATE-VOTE SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%");
console.log("Confident-wrong: " + confWrong);
