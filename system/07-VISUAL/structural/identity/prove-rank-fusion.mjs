#!/usr/bin/env bun
// prove-rank-fusion.mjs — rank fusion (Borda count) across multiple metrics.
// Each metric ranks concepts by distance. The concept that consistently
// ranks high across independent metrics wins. Cross-metric consensus.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const STORE = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

console.log("=== RANK-FUSION (Borda) · N=" + STORE.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const fisher = STORE.fisher_stats.fisher;
const D = fisher.length;

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
const labels = [...conceptInstances.keys()];

function d_fisherL2(a, b) { let d = 0; for (let i = 0; i < D; i++) { const x = a[i] - b[i]; if (Number.isFinite(x)) d += fisher[i] * x * x; } return Math.sqrt(d); }
function d_cosine(a, b) { let dot = 0, na = 0, nb = 0; for (let i = 0; i < D; i++) if (Number.isFinite(a[i]) && Number.isFinite(b[i])) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; } if (!na || !nb) return 2; return 1 - dot / Math.sqrt(na * nb); }
function d_l1(a, b) { let s = 0; for (let i = 0; i < D; i++) { const x = Math.abs(a[i] - b[i]); if (Number.isFinite(x)) s += fisher[i] * x; } return s; }

const METRICS = { fisherL2: d_fisherL2, cosine: d_cosine, l1: d_l1 };

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s)), nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}
function candidatesFor(frame) {
  const cs = [];
  for (const hg of ["warm_loose", "any"]) {
    const warm = extractWarmEntities(frame, { hue_gate: hg });
    if (!warm.length) continue;
    const u = signatureForUnion(frame, warm); if (u) cs.push(u);
    for (const w of warm.slice(0, 5)) for (const region of multiScaleRegions(w.region)) {
      const s = signatureForRegion(frame, region); if (s) cs.push(s);
    }
  }
  return cs.map(c => standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats));
}

// For each frame: per metric, take min-distance to each concept (min-cand min-inst).
// Rank concepts, take rank position.
// Borda score per concept = sum(N - rank) across metrics.
// Highest Borda wins.
function fuseFrame(qvecs) {
  const scores = new Map(); // concept -> Borda
  for (const [mname, mfn] of Object.entries(METRICS)) {
    const perConcept = new Map();
    for (const q of qvecs) for (const inst of instances) {
      const d = mfn(q, inst.vec);
      const cur = perConcept.get(inst.label);
      if (!cur || d < cur) perConcept.set(inst.label, d);
    }
    const ranked = [...perConcept.entries()].sort((a, b) => a[1] - b[1]);
    for (let i = 0; i < ranked.length; i++) {
      const c = ranked[i][0];
      scores.set(c, (scores.get(c) || 0) + (labels.length - i));
    }
  }
  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  return ranked[0]?.[0] ?? null;
}

let correct = 0, tested = 0, confWrong = 0;
const misses = [];
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
    const q = candidatesFor(f);
    if (!q.length) continue;
    const w = fuseFrame(q);
    if (w) votes.set(w, (votes.get(w) || 0) + 1);
  }
  const rank = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [w, c] = rank[0] || [null, 0];
  const verdict = c >= 3 ? w : null;
  const ok = verdict === row.label; const wr = verdict !== null && verdict !== row.label;
  if (ok) correct++; if (wr) confWrong++;
  if (!ok) misses.push({ label: row.label, verdict, votes: rank.slice(0, 3) });
  tested++;
  const mark = ok ? "✓" : (wr ? "✗" : "~");
  console.log("  " + mark + " " + row.label.padEnd(18) + " → " + String(verdict || "needs_review").padEnd(20) + " " + JSON.stringify(rank.slice(0, 3)));
}
const pct = tested ? Math.round(correct / tested * 100) : 0;
console.log("\n=== RANK-FUSION SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%   confWrong=" + confWrong);
