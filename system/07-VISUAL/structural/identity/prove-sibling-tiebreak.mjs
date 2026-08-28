#!/usr/bin/env bun
// prove-sibling-tiebreak.mjs — SIBLING DISAMBIGUATION at video-vote level.
//
// Hypothesis:
//   Global Fisher-weighted distance folds all 172 dims equally into one score.
//   When top-1 vs top-2 are near-tie (d2/d1 < R), the winning axis is often
//   NOT the one that discriminates *these two specific concepts*. Fisher is
//   averaged across the WHOLE store — pairwise discrimination is masked.
//
// Approach:
//   Split flattened D=172 vector into named AXIS GROUPS (color, edge,
//   texture, specular, spatial, subsurface, colorRatio, spatialFreq,
//   retinal12, hu_moments, photon_hist, photon_corr, radial_profile).
//
//   For each frame:
//     1. Global Fisher-weighted rank → top-1, top-2 (per-frame KNN).
//     2. If top-2 / top-1 <= R (near-tie), compute per-axis L2 diff between
//        top-1 median prototype and top-2 median prototype. Pick the axis
//        with MAX prototype separation. Re-rank query on THAT axis only
//        (still Fisher-weighted, but restricted to those dims). Use the
//        re-ranked winner as the frame vote.
//     3. If not a near-tie, keep the global winner.
//
//   Aggregate 5 frames → video vote (plurality > 2 wins). This preserves
//   the "no frame-level plurality gates as knobs" constraint — we do NOT
//   change consensus/margin/ceiling. The tiebreaker changes signature
//   representation used at the frame level for near-tie cases only.
//
// Usage:
//   bun 07-VISUAL/structural/identity/prove-sibling-tiebreak.mjs \
//       07-VISUAL/fixtures/youtube-corpus/store-wave2-photonic.json [R=1.2]

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
  console.error("usage: bun prove-sibling-tiebreak.mjs store.json [R=1.2]");
  process.exit(2);
}
const storePath = path.resolve(argv[0]);
const R_TIE = argv[1] ? parseFloat(argv[1]) : 1.2;
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }

console.log("=== SIBLING TIEBREAK · VIDEO-VOTE ===");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);
console.log("Near-tie ratio R: " + R_TIE + " (top2/top1 <= R triggers tiebreaker)\n");

const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("fisher attach failed"); process.exit(1); }
console.log("D = " + stats.D + " dimensions");

// ---------- AXIS-GROUP OFFSETS (must match flattenSignature layout) ----------
// color:8  edge:10  texture:10  specular:3  spatial:27  subsurface:4
// colorRatio:6  spatialFreq:6  retinal12:4  hu_moments:9  photon_hist:46
// photon_corr:6  radial_profile:33  TOTAL: 172
const AXIS_GROUPS = [
  { name: "color",         start: 0,   len: 8  },
  { name: "edge",          start: 8,   len: 10 },
  { name: "texture",       start: 18,  len: 10 },
  { name: "specular",      start: 28,  len: 3  },
  { name: "spatial",       start: 31,  len: 27 },
  { name: "subsurface",    start: 58,  len: 4  },
  { name: "colorRatio",    start: 62,  len: 6  },
  { name: "spatialFreq",   start: 68,  len: 6  },
  { name: "retinal12",     start: 74,  len: 4  },
  { name: "hu_moments",    start: 78,  len: 9  },
  { name: "photon_hist",   start: 87,  len: 46 },
  { name: "photon_corr",   start: 133, len: 6  },
  { name: "radial_profile",start: 139, len: 33 },
];
const TOTAL = AXIS_GROUPS.reduce((a, g) => a + g.len, 0);
if (TOTAL !== stats.D) {
  console.error("AXIS LAYOUT MISMATCH: sum=" + TOTAL + " vs D=" + stats.D);
  process.exit(3);
}
console.log("Axis groups: " + AXIS_GROUPS.length + " · sum=" + TOTAL);

// ---------- BUILD STANDARDIZED INSTANCES + PER-CONCEPT MEDIAN PROTOTYPES ----------
const instances = [];             // per-clip standardized vectors
const conceptInstances = new Map();
for (const row of STORE.labels) {
  const perConcept = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const inst = { label: row.label, vec: std };
    instances.push(inst);
    perConcept.push(inst);
  }
  conceptInstances.set(row.label, perConcept);
}
// Per-concept median prototype (already computed as row.fisher_template — Float array)
const protoByLabel = new Map();
for (const row of STORE.labels) {
  if (row.fisher_template) protoByLabel.set(row.label, Float32Array.from(row.fisher_template));
}

const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

// ---------- PER-CONCEPT CEILINGS (from 88% config: max intra-concept d × 1.8) ----------
const conceptCeilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { conceptCeilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++)
    for (let j = i + 1; j < insts.length; j++)
      dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
  dists.sort((a, b) => a - b);
  conceptCeilings.set(label, dists[dists.length - 1] * 1.8);
}

// ---------- PER-CONCEPT MEAN SUBSURFACE NATURALNESS (winner-consistency gate) ----------
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
  if (scores.length) conceptNaturalMean.set(row.label, scores.reduce((a, b) => a + b, 0) / scores.length);
}

// ---------- MULTISCALE REGIONS ----------
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

// ---------- SIBLING-RESTRICTED DISTANCE ----------
// Fisher-weighted distance restricted to [start, start+len) sub-slice.
function subFisherDist(qvec, cvec, group) {
  let s = 0;
  const w = fw.fisher;
  const end = group.start + group.len;
  for (let f = group.start; f < end; f++) {
    const d = qvec[f] - cvec[f];
    s += w[f] * d * d;
  }
  return Math.sqrt(s);
}

// L2 prototype separation on a group slice.
function protoSepOnGroup(pA, pB, group) {
  let s = 0;
  const end = group.start + group.len;
  for (let f = group.start; f < end; f++) {
    const d = pA[f] - pB[f];
    s += d * d;
  }
  return Math.sqrt(s);
}

// ---------- FRAME RECOGNITION WITH SIBLING TIEBREAKER ----------
let tiebreakerFires = 0;
let tiebreakerFlips = 0;
const groupUseCount = new Map();

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
  const qvecs = candidates.map(c => ({
    sig: c,
    vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats),
  }));

  // Global KNN — best & second-best across ALL instances × ALL candidates
  let bestD = Infinity, bestLbl = null, bestKind = null, bestQvec = null;
  let secondD = Infinity, secondLbl = null;
  for (const q of qvecs) {
    for (const inst of instances) {
      const d = fisherWeightedDistance(q.vec, inst.vec, fw);
      if (d < bestD) {
        if (bestLbl && bestLbl !== inst.label) { secondD = bestD; secondLbl = bestLbl; }
        bestD = d; bestLbl = inst.label; bestKind = q.sig; bestQvec = q.vec;
      } else if (d < secondD && inst.label !== bestLbl) {
        secondD = d; secondLbl = inst.label;
      }
    }
  }
  if (bestLbl === null) return { winner: null };

  // Per-concept ceiling (88% config)
  const ceil = conceptCeilings.get(bestLbl) ?? 10.0;
  if (bestD > ceil) return { winner: null };

  // Subsurface winner-consistency gate (88% config)
  if (bestKind?._subsurface) {
    const sub = bestKind._subsurface;
    const t = sub.translucencyScore ?? 0;
    const es = sub.edgeSoftness ?? 0;
    const sg = sub.shadowGlowRatio ?? 0;
    const qN = 0.6 * t + 0.3 * es + 0.1 * sg;
    const wN = conceptNaturalMean.get(bestLbl);
    if (wN !== undefined && Math.abs(qN - wN) > 0.15) return { winner: null };
  }

  // ---------- SIBLING TIEBREAKER ----------
  // Fire only when top-2 is a near-tie (secondD / bestD <= R) AND we have both prototypes.
  const ratio = bestD > 0 ? secondD / bestD : Infinity;
  if (secondLbl && ratio <= R_TIE) {
    const pA = protoByLabel.get(bestLbl);
    const pB = protoByLabel.get(secondLbl);
    if (pA && pB) {
      tiebreakerFires++;
      // Find AXIS GROUP with max prototype separation between top-1 and top-2 protos.
      let bestGroup = null, bestSep = -1;
      for (const g of AXIS_GROUPS) {
        const sep = protoSepOnGroup(pA, pB, g);
        if (sep > bestSep) { bestSep = sep; bestGroup = g; }
      }
      // Re-rank query against BOTH candidates on that group ONLY (using best query vec).
      const dA = subFisherDist(bestQvec, pA, bestGroup);
      const dB = subFisherDist(bestQvec, pB, bestGroup);
      const flippedLbl = dB < dA ? secondLbl : bestLbl;
      groupUseCount.set(bestGroup.name, (groupUseCount.get(bestGroup.name) || 0) + 1);
      if (flippedLbl !== bestLbl) tiebreakerFlips++;
      return { winner: flippedLbl, tiebreak: bestGroup.name };
    }
  }
  return { winner: bestLbl };
}

// ---------- VIDEO-VOTE LOOP ----------
let correctVideos = 0, testedVideos = 0, confWrongVideos = 0;
const misses = [];

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
  const [winner, count] = ranked[0] || [null, 0];
  const verdict = count > 2 ? winner : null;
  const ok = verdict === row.label;
  const wr = verdict !== null && verdict !== row.label;
  if (ok) correctVideos++;
  if (wr) { confWrongVideos++; misses.push({ label: row.label, verdict, votes: ranked.slice(0, 3) }); }
  else if (verdict === null) misses.push({ label: row.label, verdict: "needs_review", votes: ranked.slice(0, 3) });
  testedVideos++;
  const mark = ok ? "OK" : (wr ? "WR" : "NR");
  console.log("  " + mark + " " + row.label.padEnd(18) + " verdict=" + (verdict || "needs_review").padEnd(20) + " votes=" + JSON.stringify(ranked.slice(0, 3)));
}

const pct = testedVideos > 0 ? (correctVideos / testedVideos * 100) : 0;
console.log("\n=== SIBLING-TIEBREAK SCORE ===");
console.log("Total: " + correctVideos + "/" + testedVideos + " = " + pct.toFixed(1) + "%");
console.log("Confident-wrong: " + confWrongVideos);
console.log("Tiebreaker fires: " + tiebreakerFires + " frames · flips: " + tiebreakerFlips);
if (groupUseCount.size) {
  console.log("Axis groups chosen when tiebreaker fired:");
  for (const [name, n] of [...groupUseCount.entries()].sort((a, b) => b[1] - a[1])) {
    console.log("  " + name.padEnd(16) + " " + n);
  }
}
if (misses.length) {
  console.log("\nMisses:");
  for (const m of misses) console.log("  " + m.label.padEnd(18) + " → " + m.verdict + "  " + JSON.stringify(m.votes));
}
