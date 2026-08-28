#!/usr/bin/env bun
// prove-prototype.mjs — concept-prototype classifier.
// Instead of KNN over raw instances (which can be dominated by ONE outlier
// training sig), classify against the mean-vector centroid per concept
// (standardized Fisher space). Prototype = np.mean(instances_of_concept).
// Distance to prototype averages out training noise.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, signatureForRegion, BIOLOGICAL_CONCEPTS } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const STORE = JSON.parse(fs.readFileSync(process.argv[2], "utf-8"));

console.log("=== PROTOTYPE CLASSIFIER · N=" + STORE.labels.length + " ===\n");
attachFisherRatioToStore(STORE);
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
const D = fw.fisher.length;

// Build prototype per concept: mean-vec across standardized sigs, with NaN-safe averaging.
const prototypes = new Map();
const conceptRadii = new Map();
for (const row of STORE.labels) {
  const vecs = row.signatures.map(s => standardizeSignatureVector(flattenSignature(s.sig), STORE.fisher_stats));
  if (!vecs.length) continue;
  const proto = new Float32Array(D);
  const counts = new Uint32Array(D);
  for (const v of vecs) for (let i = 0; i < D; i++) if (Number.isFinite(v[i])) { proto[i] += v[i]; counts[i]++; }
  for (let i = 0; i < D; i++) proto[i] = counts[i] ? proto[i] / counts[i] : NaN;
  prototypes.set(row.label, proto);
  // Radius = max training distance to prototype, ×1.5
  let maxD = 0;
  for (const v of vecs) { const d = fisherWeightedDistance(v, proto, fw); if (d > maxD) maxD = d; }
  conceptRadii.set(row.label, Math.max(maxD * 1.5, 1.0));
}
console.log("Built " + prototypes.size + " prototypes\n");

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s)), nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

function recognizeFrame(frame) {
  const candidates = [];
  for (const hg of ["warm_loose", "any"]) {
    const warm = extractWarmEntities(frame, { hue_gate: hg });
    if (!warm.length) continue;
    const u = signatureForUnion(frame, warm); if (u) candidates.push(u);
    for (const w of warm.slice(0, 5)) for (const r of multiScaleRegions(w.region)) {
      const s = signatureForRegion(frame, r); if (s) candidates.push(s);
    }
  }
  if (!candidates.length) return { winner: null };
  const qvecs = candidates.map(c => standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats));
  // Min-over-candidates × distance-to-prototype
  let best = Infinity, bestLabel = null;
  for (const q of qvecs) for (const [label, proto] of prototypes.entries()) {
    const d = fisherWeightedDistance(q, proto, fw);
    if (d < best) { best = d; bestLabel = label; }
  }
  if (best > (conceptRadii.get(bestLabel) ?? Infinity)) return { winner: null };
  return { winner: bestLabel };
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
  for (const f of frames) { const r = recognizeFrame(f); if (r.winner) votes.set(r.winner, (votes.get(r.winner) || 0) + 1); }
  const ranked = [...votes.entries()].sort((a, b) => b[1] - a[1]);
  const [winner, count] = ranked[0] || [null, 0];
  const verdict = count > 2 ? winner : null;
  const ok = verdict === row.label;
  const wr = verdict !== null && verdict !== row.label;
  if (ok) correct++;
  if (wr) confWrong++;
  if (!ok) misses.push({ label: row.label, verdict, votes: ranked.slice(0, 3) });
  tested++;
  const mark = ok ? "✓" : (wr ? "✗" : "~");
  console.log("  " + mark + " " + row.label.padEnd(18) + " → " + String(verdict || "needs_review").padEnd(20) + " " + JSON.stringify(ranked.slice(0, 3)));
}
const pct = tested ? Math.round(correct / tested * 100) : 0;
console.log("\n=== PROTOTYPE SCORE ===");
console.log("Total: " + correct + "/" + tested + " = " + pct + "%   confWrong=" + confWrong);
if (misses.length) console.log("\nMisses (" + misses.length + "):");
for (const m of misses.slice(0, 15)) console.log("  " + m.label + " → " + (m.verdict || "?") + "  " + JSON.stringify(m.votes));
