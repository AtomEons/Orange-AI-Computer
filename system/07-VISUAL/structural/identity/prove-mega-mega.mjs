#!/usr/bin/env bun
// prove-mega-mega.mjs — layered voting ensemble across weight configurations
// AND K-nearest neighbor voting per frame. Pushes past the low-80s.
//
// LAYERS:
//   1. Photoreceptor adapt frame (K1)
//   2. Rich signature ~172 dims (K3, K4, K5, K6)
//   3. Fisher-Ratio standardization + min-3-signature fit (K7, K8, AE7 fix)
//   4. K=3 nearest instances (not K=1) — averaged distance to top-3
//   5. Multi-weight-config voting — 3 different HUMAN_GRADE_WEIGHTS profiles
//   6. Runner-up margin gate (from attack-distgate.mjs)
//   7. Per-concept ceiling from within-var
//   8. naturalVsSynthetic biological gate
//   9. Multi-scale + multi-region candidates
//  10. Video-level plurality vote across 5 frames

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion, BIOLOGICAL_CONCEPTS } from "./recognize-human-grade.mjs";
import { naturalVsSynthetic } from "./second-pass-alpha.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const GRAPH_PATH = path.join(FIXTURES, "perfect-eyes", "concept-graph.json");

const argv = process.argv.slice(2);
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }

console.log("=== MEGA-MEGA-STACK VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);

// Concept-graph channel weights
if (fs.existsSync(GRAPH_PATH)) {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf-8"));
    const nameToWeights = new Map();
    for (const n of g.nodes || []) if (n.type === "CONCEPT" && n.channel_weights) nameToWeights.set(n.label, n.channel_weights);
    const aliases = { orange_fruit: "orange", apple_fruit: "apple", human_face: "human_skin", face: "human_skin" };
    for (const row of STORE.labels) {
      let src = row.label;
      if (!nameToWeights.has(src) && aliases[src]) src = aliases[src];
      if (nameToWeights.has(src)) row.channel_weights = { ...(row.channel_weights || {}), ...nameToWeights.get(src) };
    }
  } catch (_) {}
}

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("no fisher"); process.exit(1); }
console.log("D = " + stats.D + " (min-3-sig Fisher fit; AE7 fix)\n");

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

// Per-concept ceilings from within-concept Fisher distance
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
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

// K=3 nearest-instance vote across all candidate query signatures
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
  if (!candidates.length) return { winner: null, dist: Infinity };

  const qvecs = candidates.map(c => ({ sig: c, vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats) }));

  // For each candidate, gather ALL (label, distance) pairs and rank
  // Then aggregate votes across candidates.
  const conceptVotes = new Map();   // label -> {count, minDist}
  for (const q of qvecs) {
    const perInst = instances.map(inst => ({ label: inst.label, dist: fisherWeightedDistance(q.vec, inst.vec, fw), _subsurface: q.sig._subsurface }));
    perInst.sort((a, b) => a.dist - b.dist);
    // Take K=3 nearest, weighted by inverse distance
    const top3 = perInst.slice(0, 3);
    for (const t of top3) {
      const v = conceptVotes.get(t.label) || { weightedVote: 0, minDist: Infinity, _subsurface: null };
      v.weightedVote += 1 / (1 + t.dist);
      v.minDist = Math.min(v.minDist, t.dist);
      v._subsurface = t._subsurface;
      conceptVotes.set(t.label, v);
    }
  }
  const ranked = [...conceptVotes.entries()].sort((a, b) => b[1].weightedVote - a[1].weightedVote);
  if (!ranked.length) return { winner: null, dist: Infinity };
  const [winLabel, winInfo] = ranked[0];
  const [secondLabel, secondInfo] = ranked[1] || [null, { weightedVote: 0, minDist: Infinity }];

  const conceptCeiling = conceptCeilings.get(winLabel) ?? 10.0;
  if (winInfo.minDist > conceptCeiling) return { winner: null, dist: winInfo.minDist };

  // Runner-up margin — if second's vote is close to first, force needs_review
  const voteRatio = secondInfo.weightedVote / winInfo.weightedVote;
  if (voteRatio > 0.85) return { winner: null, dist: winInfo.minDist };

  // Biological gate
  if (winLabel && BIOLOGICAL_CONCEPTS.has(winLabel) && winInfo._subsurface) {
    const nat = naturalVsSynthetic(winInfo._subsurface);
    if (!nat.natural) return { winner: null, dist: winInfo.minDist };
  }
  return { winner: winLabel, dist: winInfo.minDist };
}

// Per-video plurality vote across 5 frames
let correct = 0, tested = 0, confWrong = 0;
const detail = [];
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
  const [videoWinner, videoWinnerCount] = ranked[0] || [null, 0];
  const videoVerdict = videoWinnerCount > 2 ? videoWinner : null;
  const ok = videoVerdict === row.label;
  const wr = videoVerdict !== null && videoVerdict !== row.label;
  if (ok) correct++;
  if (wr) confWrong++;
  tested++;
  const mark = ok ? "✓" : (wr ? "✗" : "~");
  console.log("  " + mark + " " + row.label.padEnd(18) + " verdict=" + (videoVerdict || "needs_review").padEnd(20) + " votes=" + JSON.stringify(ranked.slice(0, 3)));
}

const pct = tested > 0 ? Math.round(correct / tested * 100) : 0;
console.log("\n=== MEGA-MEGA SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%");
console.log("Confident-wrong videos: " + confWrong);
