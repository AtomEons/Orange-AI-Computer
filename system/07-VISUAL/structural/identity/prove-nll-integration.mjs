#!/usr/bin/env bun
// prove-nll-integration.mjs — total negative-log-likelihood integrator.
// For each concept c: sum -log(1 + min_cand_dist(frame_i, c)) across all frames.
// Pick c with min NLL. No frame-level thresholding, no plurality voting —
// implicit MAP with Laplace-like prior. Consistent low distance across frames
// beats one great frame + four ambiguous.

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

console.log("=== NLL INTEGRATION · N=" + STORE.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

const conceptInstances = new Map();
for (const row of STORE.labels) {
  const per = [];
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    per.push({ vec: std });
  }
  conceptInstances.set(row.label, per);
}
const labels = [...conceptInstances.keys()];

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
  // For each concept: sum-of-log-distances across frames of best cand
  const nll = new Map();
  for (const l of labels) nll.set(l, 0);
  let usedFrames = 0;
  for (const f of frames) {
    const qs = candidatesFor(f);
    if (!qs.length) continue;
    usedFrames++;
    for (const l of labels) {
      const insts = conceptInstances.get(l);
      let best = Infinity;
      for (const q of qs) for (const inst of insts) {
        const d = fisherWeightedDistance(q, inst.vec, fw);
        if (d < best) best = d;
      }
      // Laplace-like log-likelihood
      nll.set(l, nll.get(l) + Math.log(1 + best));
    }
  }
  const ranked = [...nll.entries()].sort((a, b) => a[1] - b[1]);
  const [winner, wnll] = ranked[0];
  const [runner, rnll] = ranked[1];
  const margin = rnll - wnll;
  // Accept if margin is meaningful (> 0.05 log units)
  const verdict = usedFrames >= 3 && margin > 0.05 ? winner : null;
  const ok = verdict === row.label;
  const wr = verdict !== null && verdict !== row.label;
  if (ok) correct++;
  if (wr) confWrong++;
  if (!ok) misses.push({ label: row.label, verdict, top3: ranked.slice(0, 3).map(([l, s]) => l + "=" + s.toFixed(2)), margin });
  tested++;
  const mark = ok ? "✓" : (wr ? "✗" : "~");
  console.log("  " + mark + " " + row.label.padEnd(18) + " → " + String(verdict || "needs_review").padEnd(20) + " m=" + margin.toFixed(3) + " top3=[" + ranked.slice(0, 3).map(([l, s]) => l + "=" + s.toFixed(2)).join(",") + "]");
}
const pct = tested ? Math.round(correct / tested * 100) : 0;
console.log("\n=== NLL SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%   confWrong=" + confWrong);
if (misses.length) console.log("Misses (" + misses.length + "):");
for (const m of misses.slice(0, 12)) console.log("  " + m.label + " → " + (m.verdict || "?") + " m=" + m.margin.toFixed(3));
