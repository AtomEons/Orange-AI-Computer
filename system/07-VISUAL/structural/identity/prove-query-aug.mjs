#!/usr/bin/env bun
// prove-query-aug.mjs — Query augmentation for AEyes1.
//
// For each held-out frame we synthesize multiple views (original + horizontal
// flip + vertical flip + 90° rotate + center-crop 90%) and compute candidate
// signatures for ALL views. The concept ID for the frame is the concept whose
// prototype gives the minimum Fisher-weighted distance to ANY augmented
// query candidate. Multi-view robustness — the classifier gets several
// chances to hit the memory.
//
// Video-level verdict: same plurality-vote rule (>2 of 5 frames) as the
// baseline prove-super-stack-video-vote.mjs.
//
// Zero-parameter: augmentations are deterministic geometric transforms of
// the RGB channels already in memory. No new training. No new store.

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
} from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error("usage: bun prove-query-aug.mjs store.json");
  process.exit(2);
}
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

console.log("=== QUERY-AUGMENTATION VIDEO-VOTE ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed"); process.exit(1); }
console.log("D = " + stats.D + " dimensions");

// ---------------------------------------------------------------
// Build instance vectors once
// ---------------------------------------------------------------
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

// Per-concept ceilings (same as baseline)
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++) {
    for (let j = i + 1; j < insts.length; j++) {
      dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
    }
  }
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
}

// Per-concept natural-score mean
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

console.log("Instances: " + instances.length);
console.log("");

// ---------------------------------------------------------------
// Frame augmentation — deterministic, in-memory
// ---------------------------------------------------------------

// Horizontal flip: mirror columns
function flipHorizontal(frame) {
  const { R, G, B, width, height } = frame;
  const R2 = new Float32Array(R.length);
  const G2 = new Float32Array(G.length);
  const B2 = new Float32Array(B.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * width + x;
      const dst = y * width + (width - 1 - x);
      R2[dst] = R[src]; G2[dst] = G[src]; B2[dst] = B[src];
    }
  }
  return { R: R2, G: G2, B: B2, width, height };
}

// Vertical flip: mirror rows
function flipVertical(frame) {
  const { R, G, B, width, height } = frame;
  const R2 = new Float32Array(R.length);
  const G2 = new Float32Array(G.length);
  const B2 = new Float32Array(B.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * width + x;
      const dst = (height - 1 - y) * width + x;
      R2[dst] = R[src]; G2[dst] = G[src]; B2[dst] = B[src];
    }
  }
  return { R: R2, G: G2, B: B2, width, height };
}

// 90° clockwise rotation: new[x_new = height-1-y][y_new = x] with dims swapped
function rotate90(frame) {
  const { R, G, B, width, height } = frame;
  const w2 = height, h2 = width;
  const R2 = new Float32Array(R.length);
  const G2 = new Float32Array(G.length);
  const B2 = new Float32Array(B.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = y * width + x;
      const xn = height - 1 - y;
      const yn = x;
      const dst = yn * w2 + xn;
      R2[dst] = R[src]; G2[dst] = G[src]; B2[dst] = B[src];
    }
  }
  return { R: R2, G: G2, B: B2, width: w2, height: h2 };
}

// Center crop 90%, then rescale by nearest neighbor to original dims (keeps
// bounding box geometry consistent with instances). Simulates zoom-in.
function centerCropRescale(frame, scale = 0.9) {
  const { R, G, B, width, height } = frame;
  const cw = Math.max(4, Math.round(width * scale));
  const ch = Math.max(4, Math.round(height * scale));
  const x0 = Math.floor((width - cw) / 2);
  const y0 = Math.floor((height - ch) / 2);
  const R2 = new Float32Array(width * height);
  const G2 = new Float32Array(width * height);
  const B2 = new Float32Array(width * height);
  for (let y = 0; y < height; y++) {
    const sy = y0 + Math.floor(y * ch / height);
    for (let x = 0; x < width; x++) {
      const sx = x0 + Math.floor(x * cw / width);
      const src = sy * width + sx;
      const dst = y * width + x;
      R2[dst] = R[src]; G2[dst] = G[src]; B2[dst] = B[src];
    }
  }
  return { R: R2, G: G2, B: B2, width, height };
}

function augmentFrame(frame) {
  // Return array of {frame, tag} views
  return [
    { frame,                          tag: "orig"  },
    { frame: flipHorizontal(frame),   tag: "hflip" },
    { frame: flipVertical(frame),     tag: "vflip" },
    { frame: rotate90(frame),         tag: "rot90" },
    { frame: centerCropRescale(frame, 0.9), tag: "zoom" },
  ];
}

// ---------------------------------------------------------------
// Per-view candidate extraction (same as baseline recognizeFrame)
// ---------------------------------------------------------------
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

function collectCandidates(frame) {
  const out = [];
  for (const hg of ["warm_loose", "any"]) {
    const warm = extractWarmEntities(frame, { hue_gate: hg });
    if (!warm.length) continue;
    const u = signatureForUnion(frame, warm);
    if (u) out.push(u);
    for (const w of warm.slice(0, 5)) {
      for (const region of multiScaleRegions(w.region)) {
        const s = signatureForRegion(frame, region);
        if (s) out.push(s);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------
// Query-augmented frame recognition
// ---------------------------------------------------------------
function recognizeFrameAugmented(frame) {
  const views = augmentFrame(frame);
  const allCandidates = [];
  for (const v of views) {
    const cands = collectCandidates(v.frame);
    for (const c of cands) allCandidates.push(c);
  }
  if (!allCandidates.length) return { winner: null };

  const qvecs = allCandidates.map(c => ({
    sig: c,
    vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats),
  }));

  let best = Infinity, bestLabel = null, bestKind = null;
  for (const q of qvecs) {
    for (const inst of instances) {
      const d = fisherWeightedDistance(q.vec, inst.vec, fw);
      if (d < best) {
        best = d; bestLabel = inst.label; bestKind = q.sig;
      }
    }
  }
  if (bestLabel === null) return { winner: null };

  const ceiling = conceptCeilings.get(bestLabel) ?? 10.0;
  if (best > ceiling) return { winner: null };

  // Subsurface consistency gate (same as baseline)
  if (bestKind?._subsurface) {
    const sub = bestKind._subsurface;
    const t = sub.translucencyScore ?? 0;
    const es = sub.edgeSoftness ?? 0;
    const sg = sub.shadowGlowRatio ?? 0;
    const queryNat = 0.6 * t + 0.3 * es + 0.1 * sg;
    const winnerNat = conceptNaturalMean.get(bestLabel);
    if (winnerNat !== undefined && Math.abs(queryNat - winnerNat) > 0.15) {
      return { winner: null };
    }
  }
  return { winner: bestLabel };
}

// ---------------------------------------------------------------
// Held-out video loop — vote plurality > 2/5
// ---------------------------------------------------------------
let correctVideos = 0, testedVideos = 0, confWrongVideos = 0;
const detail = [];
const misses = [];

for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try {
    frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 });
  } catch (e) {
    continue;
  }
  const votes = new Map();
  for (const f of frames) {
    const r = recognizeFrameAugmented(f);
    if (r.winner) votes.set(r.winner, (votes.get(r.winner) || 0) + 1);
  }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [videoWinner, videoWinnerCount] = ranked[0] || [null, 0];
  const videoVerdict = videoWinnerCount > 2 ? videoWinner : null;
  const ok = videoVerdict === row.label;
  const wr = videoVerdict !== null && videoVerdict !== row.label;
  if (ok) correctVideos++;
  if (wr) { confWrongVideos++; misses.push({ label: row.label, predicted: videoVerdict, votes: ranked.slice(0, 3) }); }
  else if (!ok) { misses.push({ label: row.label, predicted: "needs_review", votes: ranked.slice(0, 3) }); }
  testedVideos++;
  detail.push({ label: row.label, videoVerdict, votes: ranked, ok, wr });
  const marker = ok ? "OK" : (wr ? "WR" : "NR");
  console.log("  " + marker + " " + row.label.padEnd(20) + " verdict=" + (videoVerdict || "needs_review").padEnd(22) + " votes=" + JSON.stringify(ranked.slice(0, 3)));
}

console.log("\n=== QUERY-AUGMENTED VIDEO-VOTE SCORE ===");
const pct = testedVideos > 0 ? Math.round(correctVideos / testedVideos * 100) : 0;
console.log("Total: " + correctVideos + "/" + testedVideos + " = " + pct + "%");
console.log("Confident-wrong videos: " + confWrongVideos);
console.log("");
console.log("Misses:");
for (const m of misses) {
  console.log("  " + m.label + " -> " + m.predicted + " (top votes: " + JSON.stringify(m.votes) + ")");
}
