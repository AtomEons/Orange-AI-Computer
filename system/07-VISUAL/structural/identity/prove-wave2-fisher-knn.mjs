#!/usr/bin/env bun
// prove-wave2-fisher-knn.mjs — Fisher-weighted KNN over all clip signatures.
//
// INNOVATION #2: instead of one median template per concept, use ALL the
// per-clip signatures as instances. A query is classified by the concept
// containing its nearest instance, under the Fisher-weighted metric.
//
// Rationale: a concept has natural modes (e.g., orange from different angles
// / lightings). The median collapses those modes into one point. KNN keeps
// them alive as bag-of-instances, so a query matching ONE specific mode
// wins.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) { console.error("usage: bun prove-wave2-fisher-knn.mjs store.json"); process.exit(2); }
const storePath = argv[0];
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

console.log("=== FISHER-WEIGHTED KNN VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length + "\n");

console.log("computing Fisher stats from store...");
const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed to compute Fisher stats"); process.exit(1); }

// Precompute standardized vectors for each concept's stored sigs
const instances = [];
for (const row of STORE.labels) {
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    instances.push({ label: row.label, vec: std });
  }
}
console.log("Total instances (all clip sigs across all concepts): " + instances.length);

const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };

// Sweep ceiling — Fisher distances on standardized data are roughly sqrt(D) scale (~10 for D=100)
const ceilings = [3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 12.0, 15.0];
let bestOverall = null;

for (const ceiling of ceilings) {
  let correct = 0, tested = 0, confWrong = 0;
  const perConcept = [];
  for (const row of STORE.labels) {
    const dir = path.join(CORPUS_ROOT, slugify(row.label));
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
    if (files.length < 2) continue;
    const heldOut = path.join(dir, files.at(-1));
    let frames;
    try { frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 }); }
    catch (e) { continue; }
    let ok = 0, wr = 0, tot = 0;
    for (const f of frames) {
      const useLoose = /animal|cat|dog|elephant|lion|giraffe|horse|building|house|castle|book|chair|clock|mountain|forest|ocean|snow|bicycle|airplane|boat|banana|watermelon|grape|carrot|sunflower/.test(row.label);
      const warm = extractWarmEntities(f, { useLoose });
      if (!warm.length) { tot++; continue; }
      const qsig = signatureForUnion(f, warm);
      if (!qsig) { tot++; continue; }
      const qvecRaw = flattenSignature(qsig);
      const qvec = standardizeSignatureVector(qvecRaw, STORE.fisher_stats);
      // Find nearest instance across all stored sigs
      let best = Infinity, bestLabel = null;
      for (const inst of instances) {
        const d = fisherWeightedDistance(qvec, inst.vec, fw);
        if (d < best) { best = d; bestLabel = inst.label; }
      }
      const rejected = best > ceiling;
      const winner = rejected ? null : bestLabel;
      if (winner === row.label) ok++;
      else if (!rejected) wr++;
      tot++;
    }
    correct += ok; tested += tot; confWrong += wr;
    perConcept.push({ label: row.label, correct: ok, tested: tot, confWrong: wr });
  }
  const pct = tested > 0 ? Math.round(correct / tested * 100) : 0;
  console.log("ceiling=" + ceiling.toFixed(2) + "  correct=" + correct + "/" + tested + " = " + pct + "%  confWrong=" + confWrong);
  if (!bestOverall || correct > bestOverall.correct) bestOverall = { ceiling, correct, tested, confWrong, perConcept, pct };
}

console.log("\n=== BEST CEILING: " + bestOverall.ceiling.toFixed(2) + " ===");
for (const c of bestOverall.perConcept) {
  const pct = c.tested > 0 ? Math.round(c.correct / c.tested * 100) : 0;
  console.log("  " + c.label.padEnd(18) + " " + c.correct + "/" + c.tested + " = " + String(pct).padStart(3) + "%  confWrong=" + c.confWrong);
}
console.log("\n=== FISHER-KNN SCORE ===");
console.log("Total: " + bestOverall.correct + "/" + bestOverall.tested + " = " + bestOverall.pct + "%");
console.log("Confident-wrong: " + bestOverall.confWrong);
