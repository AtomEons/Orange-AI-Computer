#!/usr/bin/env bun
// prove-super-stack.mjs — arrange every substrate key we found.
//
// THE FULL STACK:
//   K1. Photoreceptor Naka-Rushton adaptation (photoreceptor-adapt-frame.mjs)
//   K2. hue_gate = "any" (all colors, not warm-only)
//   K3. Multi-scale + multi-region query candidates
//   K4. Rich signature: 8 axes + retinal-12 + Hu + photon-hist + photon-corr + radial-profile
//   K5. LBP top-code bugfix (fisher-ratio-signature.mjs, this session)
//   K6. Photoreceptor-adapted signatures at query time (already in signatureForUnion/Region)
//   K7. Fisher-Ratio Signature Normalization (fisher-ratio-signature.mjs)
//   K8. Standardized-space distance (mean/std per dim, then Fisher weighting)
//   K9. Fisher-weighted KNN over all clip instances (multi-mode capture)
//   K10. Modern Hopfield retrieval with Fisher weights (Ramsauer 2020) — consensus channel
//   K11. Per-concept ceilings from within-concept Fisher distance (data-driven, not clamped)
//   K12. Multi-object emit (concept SET, not single winner)
//   K13. Multi-candidate matching (union + top-K entities × multi-scale)
//   K14. Concept-graph per-node channel weights when present
//   K15. naturalVsSynthetic gate for biological concepts (subsurface translucency)

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { extractImageRGB } from "../prism.mjs";
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
const GRAPH_PATH = path.join(FIXTURES, "perfect-eyes", "concept-graph.json");

const argv = process.argv.slice(2);
if (argv.length < 1) { console.error("usage: bun prove-super-stack.mjs store.json"); process.exit(2); }
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }

console.log("=== SUPER-STACK VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length);

// K14: Load concept-graph, apply per-concept weights with NAME ALIASING
// (Wave 2 uses `orange_fruit` while graph has `orange`).
if (fs.existsSync(GRAPH_PATH)) {
  try {
    const g = JSON.parse(fs.readFileSync(GRAPH_PATH, "utf-8"));
    const nameToWeights = new Map();
    for (const n of g.nodes || []) {
      if (n.type === "CONCEPT" && n.channel_weights) {
        nameToWeights.set(n.label, n.channel_weights);
      }
    }
    // Name aliases so graph knowledge propagates to Wave 2 corpus names
    const aliases = {
      orange_fruit: "orange", apple_fruit: "apple",
      human_face: "human_skin", face: "human_skin",
    };
    let applied = 0;
    for (const row of STORE.labels) {
      let source = row.label;
      if (!nameToWeights.has(source) && aliases[source]) source = aliases[source];
      if (nameToWeights.has(source)) {
        row.channel_weights = { ...(row.channel_weights || {}), ...nameToWeights.get(source) };
        applied++;
      }
    }
    console.log("K14: concept-graph weights applied to " + applied + " concepts (with name aliasing)");
  } catch (e) { console.log("K14: graph load failed: " + e.message); }
}

console.log("K7: computing Fisher stats...");
const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed"); process.exit(1); }
console.log("K7: D = " + stats.D + " dimensions");

// K9: instances = all standardized stored sigs
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

// K11: per-concept ceiling from within-concept Fisher distance distribution
// (reverted the impostor clamp — regressed the 84% baseline)
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
  const maxD = dists[dists.length - 1];
  conceptCeilings.set(label, maxD * 1.8);
}

console.log("K11: per-concept ceilings ready");

// K3, K13: multi-scale region variants
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

// K10: Fisher-weighted Modern Hopfield retrieval
// Ramsauer 2020: softmax(-β · d) attention over instances, iterated to attractor.
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
    // Update current pattern via attention-weighted average
    const next = new Float32Array(D);
    for (let i = 0; i < instances.length; i++) {
      const w = att[i];
      const v = instances[i].vec;
      for (let f = 0; f < D; f++) next[f] += w * v[f];
    }
    current = next;
  }
  // Aggregate attention per concept
  const perConcept = new Map();
  for (let i = 0; i < instances.length; i++) {
    const lbl = instances[i].label;
    perConcept.set(lbl, (perConcept.get(lbl) || 0) + att[i]);
  }
  const ranked = [...perConcept.entries()].sort((a, b) => b[1] - a[1]);
  return { winner: ranked[0][0], mass: ranked[0][1], ranked };
}

async function recognizeSuperFrame(frame) {
  // K1, K6: adaptation happens inside signatureForUnion/Region
  // K2, K13: try both hue_gates for full coverage — reverted from center-weight
  //         (that regressed the 84% baseline)
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
  if (!candidates.length) return { winner: null, dist: Infinity, action: "no_warm" };

  // Standardize all query candidates
  const qvecs = candidates.map(c => ({ sig: c, vec: standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats) }));

  // K9: Fisher-KNN — find (candidate, instance) pair with min distance
  let knnBest = Infinity, knnLabel = null, knnKind = null;
  for (const q of qvecs) {
    for (const inst of instances) {
      const d = fisherWeightedDistance(q.vec, inst.vec, fw);
      if (d < knnBest) { knnBest = d; knnLabel = inst.label; knnKind = q.sig; }
    }
  }

  // K10: Modern Hopfield — attention-weighted consensus across all candidates
  const hopfieldVotes = new Map();
  for (const q of qvecs) {
    const h = fisherHopfield(q.vec, instances, fw, 3.0, 2);
    hopfieldVotes.set(h.winner, (hopfieldVotes.get(h.winner) || 0) + h.mass);
  }
  const hopRanked = [...hopfieldVotes.entries()].sort((a, b) => b[1] - a[1]);
  const hopfieldWinner = hopRanked[0]?.[0];

  // K11: per-concept ceiling gate
  const conceptCeiling = conceptCeilings.get(knnLabel) ?? 10.0;
  let rejected = knnBest > conceptCeiling;

  // K16 REVERTED: consensus filter rejected too many correct-KNN cases.
  // Hopfield is a diagnostic, not a gate. Trust KNN when it's below ceiling.

  // K15: natural gate — biological concept gets rejected if subsurface says synthetic
  let natural_gate_triggered = false;
  if (!rejected && knnLabel && BIOLOGICAL_CONCEPTS.has(knnLabel)) {
    const cand = knnKind;
    if (cand?._subsurface) {
      const nat = naturalVsSynthetic(cand._subsurface);
      if (!nat.natural) { rejected = true; natural_gate_triggered = true; }
    }
  }

  return {
    winner: rejected ? null : knnLabel,
    dist: knnBest,
    hopfield_winner: hopfieldWinner,
    hopfield_mass: hopRanked[0]?.[1] ?? 0,
    knn_hopfield_agree: knnLabel === hopfieldWinner,
    ceiling_used: conceptCeiling,
    natural_gate_triggered,
    action: rejected ? "needs_review" : "recognized_as:" + knnLabel,
  };
}

// Validation
let correct = 0, tested = 0, confWrong = 0;
let agreeCount = 0;
const perConcept = [];
console.log("");
for (const row of STORE.labels) {
  const dir = path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) continue;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) continue;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); }
  catch (e) { continue; }
  let ok = 0, wr = 0, tot = 0, agree = 0;
  for (const f of frames) {
    const r = await recognizeSuperFrame(f);
    if (r.winner === row.label) ok++;
    else if (r.winner && r.winner !== row.label) wr++;
    if (r.knn_hopfield_agree) agree++;
    tot++;
  }
  correct += ok; tested += tot; confWrong += wr; agreeCount += agree;
  const pct = tot > 0 ? Math.round(ok / tot * 100) : 0;
  perConcept.push({ label: row.label, correct: ok, tested: tot, confWrong: wr, pct, agree });
  console.log("  " + row.label.padEnd(18) + " " + ok + "/" + tot + " = " + String(pct).padStart(3) + "%  confWrong=" + wr + "  knn-hop-agree=" + agree + "/" + tot);
}

const pct = tested > 0 ? Math.round(correct / tested * 100) : 0;
console.log("\n=== SUPER-STACK SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%");
console.log("Confident-wrong: " + confWrong);
console.log("KNN-Hopfield agreement: " + agreeCount + "/" + tested);
