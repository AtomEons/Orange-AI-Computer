#!/usr/bin/env bun
// prove-subset.mjs — filter a store to a specific label list, then prove-all.
// Isolates whether the RECOGNIZER or SCALING is the collapse cause.

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

const STORE_PATH = process.argv[2];
const LABELS_STR = process.argv[3]; // comma-separated
if (!STORE_PATH || !LABELS_STR) {
  console.error("usage: prove-subset.mjs STORE labels_csv");
  process.exit(1);
}
const keepSet = new Set(LABELS_STR.split(",").map(s => s.trim()));
const RAW = JSON.parse(fs.readFileSync(STORE_PATH, "utf-8"));
const STORE = { labels: RAW.labels.filter(r => keepSet.has(r.label)) };

console.log("=== SUBSET · from " + path.basename(STORE_PATH) + " · N=" + STORE.labels.length + "/" + RAW.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

const instances = [];
const conceptInstances = new Map();
for (const row of STORE.labels) {
  const per = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    const inst = { label: row.label, vec: std };
    instances.push(inst); per.push(inst);
  }
  conceptInstances.set(row.label, per);
}
const labels = [...conceptInstances.keys()];

const ceilings = new Map();
for (const [label, insts] of conceptInstances.entries()) {
  if (insts.length < 2) { ceilings.set(label, 10.0); continue; }
  const dists = [];
  for (let i = 0; i < insts.length; i++) for (let j = i + 1; j < insts.length; j++) dists.push(fisherWeightedDistance(insts[i].vec, insts[j].vec, fw));
  dists.sort((a, b) => a - b);
  ceilings.set(label, dists[dists.length - 1] * 1.8);
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

async function classifyOneRow(row) {
  const dirA = path.join(CORPUS_ROOT, slugify(row.label === "orange_fruit" ? "orange" : row.label === "apple_fruit" ? "apple" : row.label));
  const dir = fs.existsSync(dirA) ? dirA : path.join(CORPUS_ROOT, slugify(row.label));
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) return null;
  const heldOut = path.join(dir, files.at(-1));
  let frames;
  try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); } catch (e) { return null; }
  const votes = new Map();
  const nll = new Map(); for (const l of labels) nll.set(l, 0);
  let used = 0;
  for (const f of frames) {
    const cs = [];
    for (const hg of ["warm_loose", "any"]) {
      const warm = extractWarmEntities(f, { hue_gate: hg });
      if (!warm.length) continue;
      const u = signatureForUnion(f, warm); if (u) cs.push(u);
      for (const w of warm.slice(0, 5)) for (const r of multiScaleRegions(w.region)) {
        const s = signatureForRegion(f, r); if (s) cs.push(s);
      }
    }
    if (!cs.length) continue;
    used++;
    const qvecs = cs.map(c => standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats));
    // baseline min-KNN
    let best = Infinity, bestLabel = null;
    for (const q of qvecs) for (const inst of instances) {
      const d = fisherWeightedDistance(q, inst.vec, fw);
      if (d < best) { best = d; bestLabel = inst.label; }
    }
    if (best <= (ceilings.get(bestLabel) ?? Infinity)) votes.set(bestLabel, (votes.get(bestLabel) || 0) + 1);
    // NLL accumulator
    for (const l of labels) {
      const insts = conceptInstances.get(l);
      let bb = Infinity;
      for (const q of qvecs) for (const inst of insts) {
        const d = fisherWeightedDistance(q, inst.vec, fw);
        if (d < bb) bb = d;
      }
      nll.set(l, nll.get(l) + Math.log(1 + bb));
    }
  }
  const brank = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [bw, bc] = brank[0] || [null, 0];
  const bV = bc > 2 ? bw : null;
  const nRank = [...nll.entries()].sort((a, b) => a[1] - b[1]);
  const nV = used >= 3 && nRank.length > 1 && (nRank[1][1] - nRank[0][1] > 0.05) ? nRank[0][0] : null;
  return { baseline: bV, nll: nV };
}

let bC = 0, bT = 0, bW = 0, nC = 0, nT = 0, nW = 0;
for (const row of STORE.labels) {
  const r = await classifyOneRow(row);
  if (!r) continue;
  bT++; nT++;
  if (r.baseline === row.label) bC++;
  else if (r.baseline !== null) bW++;
  if (r.nll === row.label) nC++;
  else if (r.nll !== null) nW++;
}
console.log("baseline: " + bC + "/" + bT + " = " + Math.round(bC / bT * 100) + "%  confWrong=" + bW);
console.log("NLL:      " + nC + "/" + nT + " = " + Math.round(nC / nT * 100) + "%  confWrong=" + nW);
