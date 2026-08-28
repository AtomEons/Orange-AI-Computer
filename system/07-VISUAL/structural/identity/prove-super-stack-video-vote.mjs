#!/usr/bin/env bun
// prove-super-stack-video-vote.mjs — same super-stack pipeline, but at the
// VIDEO level, not per-frame.
//
// For each held-out video, aggregate 5 frame recognitions into ONE video vote:
//   - each frame's winner counts as one vote for that concept
//   - concept with plurality wins
//   - if plurality < 3/5, emit needs_review (honest — didn't converge)
//
// This is closer to how a human perceives an object: multiple glances converge
// to one identification, not five independent per-glance identifications.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import {
  attachFisherRatioToStore,
  flattenSignature,
  fisherWeightedDistance,
  standardizeSignatureVector,
} from "./fisher-ratio-signature.mjs";
import {
  extractWarmEntities,
  signatureForUnion,
  signatureForRegion,
  BIOLOGICAL_CONCEPTS,
} from "./recognize-human-grade.mjs";
import { naturalVsSynthetic } from "./second-pass-alpha.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) { console.error("usage: bun prove-super-stack-video-vote.mjs store.json"); process.exit(2); }
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }

console.log("=== VIDEO-VOTE SUPER-STACK VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed"); process.exit(1); }
console.log("D = " + stats.D + " dimensions\n");

const instances = [];
const conceptInstances = new Map();
for (const row of STORE.labels) {
  const perConcept = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const inst = { label: row.label, vec: std, sig: s.sig };
    instances.push(inst);
    perConcept.push(inst);
  }
  conceptInstances.set(row.label, perConcept);
}
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

// Per-concept ceilings
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
}

// Per-concept average subsurface (natural) score — for QUERY-vs-WINNER
// consistency gate. Clocks match cat because both have warm regions, but
// the per-concept natural score should differ (cat higher, clock lower).
const conceptNaturalMean = new Map();
for (const row of STORE.labels) {
  const scores = [];
  for (const s of row.signatures) {
    const sub = s.sig?.subsurface;
    if (sub) {
      const t = sub.translucencyScore ?? 0;
      const es = sub.edgeSoftness ?? 0;
      const sg = sub.shadowGlowRatio ?? 0;
      scores.push(0.6 * t + 0.3 * es + 0.1 * sg);
    }
  }
  if (scores.length) {
    conceptNaturalMean.set(row.label, scores.reduce((a, b) => a + b, 0) / scores.length);
  }
}

function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

function fisherHopfield(qvec, instances, fw, beta = 3.0, iters = 2) {
  let current = qvec;
  let att = null;
  for (let it = 0; it < iters; it++) {
    const D = current.length;
    const dists = instances.map(inst => fisherWeightedDistance(current, inst.vec, fw));
    const negBetaD = dists.map(d => -beta * d);
    const maxNeg = Math.max(...negBetaD);
    const exps = negBetaD.map(x => Math.exp(x - maxNeg));
    const sumExps = exps.reduce((a, b) => a + b, 0) || 1;
    att = exps.map(v => v / sumExps);
    const next = new Float32Array(D);
    for (let i = 0; i < instances.length; i++) {
      const w = att[i];
      const v = instances[i].vec;
      for (let f = 0; f < D; f++) next[f] += w * v[f];
    }
    current = next;
  }
  const perConcept = new Map();
  for (let i = 0; i < instances.length; i++) {
    const lbl = instances[i].label;
    perConcept.set(lbl, (perConcept.get(lbl) || 0) + att[i]);
  }
  const ranked = [...perConcept.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0][0];
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
  // Track BOTH best-of-winner and best-of-different-concept for runner-up margin
  let knnBest = Infinity, knnLabel = null, knnKind = null;
  let knnSecond = Infinity, knnSecondLabel = null;
  for (const q of qvecs) {
    for (const inst of instances) {
      const d = fisherWeightedDistance(q.vec, inst.vec, fw);
      if (d < knnBest) {
        if (knnLabel && knnLabel !== inst.label) { knnSecond = knnBest; knnSecondLabel = knnLabel; }
        knnBest = d; knnLabel = inst.label; knnKind = q.sig;
      } else if (d < knnSecond && inst.label !== knnLabel) {
        knnSecond = d; knnSecondLabel = inst.label;
      }
    }
  }
  const conceptCeiling = conceptCeilings.get(knnLabel) ?? 10.0;
  if (knnBest > conceptCeiling) return { winner: null };
  // Both consensus filter AND margin gate OFF — was the 88% baseline config
  // Query-vs-winner subsurface consistency gate: if query's natural score
  // differs from winner concept's mean by more than 0.15, force needs_review.
  // Kills clock→cat because clock is more matte, cat more translucent-furry.
  if (knnKind?._subsurface) {
    const sub = knnKind._subsurface;
    const t = sub.translucencyScore ?? 0;
    const es = sub.edgeSoftness ?? 0;
    const sg = sub.shadowGlowRatio ?? 0;
    const queryNat = 0.6 * t + 0.3 * es + 0.1 * sg;
    const winnerNat = conceptNaturalMean.get(knnLabel);
    if (winnerNat !== undefined && Math.abs(queryNat - winnerNat) > 0.15) {
      return { winner: null };
    }
  }
  return { winner: knnLabel };
}

let correctVideos = 0, testedVideos = 0, confWrongVideos = 0;
const detail = [];
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); }
  catch (e) { continue; }
  const votes = new Map();
  for (const f of frames) {
    const r = recognizeFrame(f);
    if (r.winner) votes.set(r.winner, (votes.get(r.winner) || 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [videoWinner, videoWinnerCount] = ranked[0] || [null, 0];
  // Require majority: > 2 of 5 votes
  const videoVerdict = videoWinnerCount > 2 ? videoWinner : null;
  const ok = videoVerdict === row.label;
  const wr = videoVerdict !== null && videoVerdict !== row.label;
  if (ok) correctVideos++;
  if (wr) confWrongVideos++;
  testedVideos++;
  detail.push({ label: row.label, videoVerdict, votes: ranked, ok, wr });
  const pct = ok ? "✓" : (wr ? "✗" : "~");
  console.log("  " + pct + " " + row.label.padEnd(18) + " verdict=" + (videoVerdict || "needs_review").padEnd(20) + " votes=" + JSON.stringify(ranked.slice(0, 3)));
}

console.log("\n=== VIDEO-VOTE SCORE ===");
const pct = testedVideos > 0 ? Math.round(correctVideos / testedVideos * 100) : 0;
console.log("Total: " + correctVideos + "/" + testedVideos + " = " + pct + "%");
console.log("Confident-wrong videos: " + confWrongVideos);
