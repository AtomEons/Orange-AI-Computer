#!/usr/bin/env bun
// prove-margin-ratio.mjs — instance-level distance RATIO gate.
// For each candidate: find nearest concept c1, nearest DIFFERENT concept c2.
// Vote c1 only if d(c2)/d(c1) > R (clean margin).
// Otherwise: skip vote (ambiguous).
// Frame plurality across candidates. Video plurality across frames.
//
// Rationale: sweep-5000 varied FRAME-level margin (video-vote counts) but not
// INSTANCE-level distance margin. At N=39 the KNN-min collapses because the
// wrong concept has ONE close signature — but the second-best from a different
// concept is also close. Ratio gate catches that ambiguity.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const STORE = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

console.log("=== INSTANCE-LEVEL RATIO MARGIN · N=" + STORE.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
const D = fw.fisher.length;

const instances = [];
for (const row of STORE.labels) {
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    instances.push({ label: row.label, vec: std });
  }
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

// Precompute candidates
console.log("Precomputing...");
const framesCache = [];
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); } catch (e) { continue; }
  const perFrame = [];
  for (const f of frames) {
    const cs = [];
    for (const hg of ["warm_loose", "any"]) {
      const warm = extractWarmEntities(f, { hue_gate: hg });
      if (!warm.length) continue;
      const u = signatureForUnion(f, warm); if (u) cs.push(u);
      for (const w of warm.slice(0, 5)) for (const region of multiScaleRegions(w.region)) {
        const s = signatureForRegion(f, region); if (s) cs.push(s);
      }
    }
    perFrame.push(cs.map(c => standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats)));
  }
  framesCache.push({ label: row.label, perFrame });
}
console.log("Cached " + framesCache.length + "\n");

function score(R, voteT) {
  let correct = 0, tested = 0, confWrong = 0;
  const misses = [];
  for (const { label, perFrame } of framesCache) {
    const videoVotes = new Map();
    for (const qvecs of perFrame) {
      if (!qvecs.length) continue;
      // For each candidate: find 1st + 2nd-nearest-different-concept
      const candWins = new Map();
      for (const q of qvecs) {
        let d1 = Infinity, l1 = null, d2 = Infinity;
        for (const inst of instances) {
          const d = fisherWeightedDistance(q, inst.vec, fw);
          if (d < d1) { d2 = d1; d1 = d; l1 = inst.label; }
          else if (d < d2 && inst.label !== l1) d2 = d;
        }
        if (l1 && d1 > 0 && d2 / d1 >= R) candWins.set(l1, (candWins.get(l1) || 0) + 1);
      }
      // Frame verdict = plurality (majority > 0.5) across candidate wins
      const ranked = [...candWins.entries()].sort((a, b) => b[1] - a[1]);
      if (!ranked.length) continue;
      const [fw2, fc] = ranked[0]; const total = ranked.reduce((a, [, v]) => a + v, 0);
      if (fc / total >= 0.5) videoVotes.set(fw2, (videoVotes.get(fw2) || 0) + 1);
    }
    const rank = [...videoVotes.entries()].sort((a, b) => b[1] - a[1]);
    const [w, c] = rank[0] || [null, 0];
    const verdict = c >= voteT ? w : null;
    const ok = verdict === label; const wr = verdict !== null && verdict !== label;
    if (ok) correct++; if (wr) confWrong++;
    if (!ok) misses.push({ label, verdict, votes: rank.slice(0, 3) });
    tested++;
  }
  return { R, voteT, correct, tested, confWrong, pct: tested ? Math.round(correct / tested * 100) : 0, misses };
}

const results = [];
for (const R of [1.0, 1.05, 1.1, 1.15, 1.2, 1.3, 1.5]) {
  for (const vt of [2, 3]) {
    const r = score(R, vt);
    console.log("R=" + R.toFixed(2) + " vt=" + vt + " → " + r.correct + "/" + r.tested + " (" + r.pct + "%) confWrong=" + r.confWrong);
    results.push(r);
  }
}
results.sort((a, b) => b.pct - a.pct || a.confWrong - b.confWrong);
console.log("\n=== TOP 5 ===");
for (let i = 0; i < 5 && i < results.length; i++) {
  const r = results[i];
  console.log(String(i + 1) + ". R=" + r.R + " vt=" + r.voteT + " → " + r.pct + "% (" + r.correct + "/" + r.tested + ") confWrong=" + r.confWrong);
  console.log("   misses: " + r.misses.slice(0, 8).map(m => m.label + "→" + (m.verdict || "?")).join(" | "));
}
