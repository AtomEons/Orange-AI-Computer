#!/usr/bin/env bun
// prove-lgn-temporal.mjs — video-vote classifier with LGN memory-primed
// attention across the 5 held-out frames.
//
// Baseline: prove-super-stack-video-vote.mjs → 88% on store-wave2-photonic.json.
//
// Change: instead of frame N being independent of frame N-1, we carry a
// concept-level prior (LGN Hebbian memory) across frames. Frame 1's winner
// primes frame 2's KNN metric — the winning label's distance is shrunk by
// up to `gain` proportional to that label's prior mass. Concepts with zero
// prior mass are untouched, so a strong dissenting signal can still flip
// the vote.
//
// Zero learned parameters. Deterministic. No frame-level plurality gates.
// This is a metric-structure change: the distance metric adapts per-frame
// based on temporal continuity.
//
// Usage:
//   bun prove-lgn-temporal.mjs <store.json> [--gain=0.30] [--decay=0.50]

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
import { createLGNGate } from "./lgn-gate.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) {
  console.error("usage: bun prove-lgn-temporal.mjs store.json [--gain=0.30] [--decay=0.50]");
  process.exit(2);
}
const storePath = argv[0];
let GAIN = 0.30;
let DECAY = 0.50;
for (const a of argv.slice(1)) {
  const m = a.match(/^--(gain|decay)=([\d.]+)$/);
  if (m) {
    if (m[1] === "gain") GAIN = parseFloat(m[2]);
    else DECAY = parseFloat(m[2]);
  }
}

const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

console.log("=== LGN TEMPORAL-PRIMED VIDEO-VOTE VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);
console.log("LGN gain: " + GAIN + "  decay: " + DECAY + "\n");

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

// Per-concept ceilings (from baseline).
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

// Per-concept subsurface consistency gate (from baseline).
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

// Compute per-label MIN raw distance across all candidate query vecs from
// this frame. Returns Map<label, {rawMin, kind}> where kind is the sig that
// produced the min (used later for the subsurface gate). Empty map if no
// candidate.
function perLabelKnnMinDist(frame) {
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
  if (!candidates.length) return new Map();
  const qvecs = candidates.map(c => ({
    sig: c,
    vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats),
  }));
  const perLabel = new Map();
  for (const q of qvecs) {
    for (const inst of instances) {
      const d = fisherWeightedDistance(q.vec, inst.vec, fw);
      const cur = perLabel.get(inst.label);
      if (!cur || d < cur.rawMin) {
        perLabel.set(inst.label, { rawMin: d, kind: q.sig });
      }
    }
  }
  return perLabel;
}

// Decide winner given a per-label PRIMED distance map (LGN-adjusted).
// Uses the same ceiling + subsurface gates as the baseline.
// Returns { winner, confidence } where confidence in [0,1] reflects the
// softmax margin between winner and runner-up (used for Hebbian bump).
function decideWinner(perLabelPrimed, perLabelRaw) {
  if (!perLabelPrimed.size) return { winner: null, confidence: 0 };
  const arr = [...perLabelPrimed.entries()].sort((a, b) => a[1] - b[1]);
  const [winnerLabel, winnerD] = arr[0];
  const [runnerLabel, runnerD] = arr[1] || [null, winnerD + 1e-6];

  // Ceiling gate (on RAW distance so it's stable across frames).
  const rawEntry = perLabelRaw.get(winnerLabel);
  const rawWinnerD = rawEntry?.rawMin ?? winnerD;
  const ceil = conceptCeilings.get(winnerLabel) ?? 10.0;
  if (rawWinnerD > ceil) return { winner: null, confidence: 0 };

  // Subsurface consistency gate (from baseline).
  const kind = rawEntry?.kind;
  if (kind?._subsurface) {
    const sub = kind._subsurface;
    const t = sub.translucencyScore ?? 0;
    const es = sub.edgeSoftness ?? 0;
    const sg = sub.shadowGlowRatio ?? 0;
    const queryNat = 0.6 * t + 0.3 * es + 0.1 * sg;
    const winnerNat = conceptNaturalMean.get(winnerLabel);
    if (winnerNat !== undefined && Math.abs(queryNat - winnerNat) > 0.15) {
      return { winner: null, confidence: 0 };
    }
  }

  // Confidence = softmax margin in distance space.
  const beta = 4.0;
  const wA = Math.exp(-beta * winnerD);
  const wB = Math.exp(-beta * runnerD);
  const confidence = wA / (wA + wB);
  return { winner: winnerLabel, confidence };
}

const conceptLabels = STORE.labels.map(r => r.label);

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
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); }
  catch (e) { continue; }

  // Fresh LGN gate per video (memory is intra-video only).
  const gate = createLGNGate({ conceptLabels, gain: GAIN, decay: DECAY });

  const votes = new Map();
  for (const f of frames) {
    const perLabelRaw = perLabelKnnMinDist(f);
    // Build primed distance map by pulling raw min out.
    const rawMap = new Map();
    for (const [l, v] of perLabelRaw.entries()) rawMap.set(l, v.rawMin);
    const primed = gate.applyPrior(rawMap);
    const { winner, confidence } = decideWinner(primed, perLabelRaw);
    if (winner) {
      votes.set(winner, (votes.get(winner) || 0) + 1);
      gate.observe(winner, confidence);
    }
  }

  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [videoWinner, videoWinnerCount] = ranked[0] || [null, 0];
  const videoVerdict = videoWinnerCount > 2 ? videoWinner : null;
  const ok = videoVerdict === row.label;
  const wr = videoVerdict !== null && videoVerdict !== row.label;
  if (ok) correctVideos++;
  if (wr) { confWrongVideos++; misses.push({ label: row.label, verdict: videoVerdict, votes: ranked.slice(0, 3) }); }
  else if (!ok) misses.push({ label: row.label, verdict: "needs_review", votes: ranked.slice(0, 3) });
  testedVideos++;
  detail.push({ label: row.label, videoVerdict, votes: ranked, ok, wr });
  const mark = ok ? "OK " : (wr ? "XX " : "-- ");
  console.log("  " + mark + row.label.padEnd(18) + " verdict=" + (videoVerdict || "needs_review").padEnd(20) + " votes=" + JSON.stringify(ranked.slice(0, 3)));
}

const pct = testedVideos > 0 ? Math.round(correctVideos / testedVideos * 100) : 0;
console.log("\n=== LGN-PRIMED VIDEO-VOTE SCORE ===");
console.log("Total: " + correctVideos + "/" + testedVideos + " = " + pct + "%");
console.log("Confident-wrong videos: " + confWrongVideos);
console.log("Misses: " + JSON.stringify(misses, null, 2));
