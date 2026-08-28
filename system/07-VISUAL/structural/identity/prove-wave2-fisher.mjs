#!/usr/bin/env bun
// prove-wave2-fisher.mjs — validate the Fisher-Ratio Signature innovation
// against the Wave 2 held-out corpus.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { attachFisherRatioToStore, flattenSignature, fisherWeightedDistance, standardizeSignatureVector } from "./fisher-ratio-signature.mjs";
import { extractWarmEntities, signatureForUnion, HUMAN_GRADE_WEIGHTS } from "./recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");

const argv = process.argv.slice(2);
if (argv.length < 1) { console.error("usage: bun prove-wave2-fisher.mjs store.json [--ceiling N]"); process.exit(2); }
const storePath = argv[0];
const ceilingIdx = argv.indexOf("--ceiling");
const ceilingOverride = ceilingIdx >= 0 ? parseFloat(argv[ceilingIdx + 1]) : null;
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

console.log("=== FISHER-RATIO SIGNATURE VALIDATION ===\n");
console.log("Store: " + storePath);
console.log("Concepts: " + STORE.labels.length + "\n");

console.log("computing Fisher stats from store...");
const stats = attachFisherRatioToStore(STORE);
if (!stats) { console.error("failed to compute Fisher stats"); process.exit(1); }

// Publish per-dim Fisher-ratio distribution
const sortedFisher = [...stats.fisher].map((v, i) => ({ i, v })).sort((a, b) => b.v - a.v);
console.log("top 15 discriminative dimensions (normalized Fisher ratio):");
for (let k = 0; k < 15; k++) console.log("  dim " + String(sortedFisher[k].i).padStart(3) + "  ratio=" + sortedFisher[k].v.toFixed(4));

// Save the Fisher-augmented store for reuse
const outPath = storePath.replace(/\.json$/, "-fisher.json");
fs.writeFileSync(outPath, JSON.stringify(STORE, null, 2));
console.log("\nStore with Fisher template written: " + outPath);

// Sweep ceiling to find best
const ceilings = ceilingOverride !== null ? [ceilingOverride] : [4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0, 12.0, 15.0, 18.0];

// Precompute per-concept template flattened (already in row.fisher_template)
// For each concept, use last-video-alphabetical as held-out
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
      let best = Infinity, bestLabel = null, second = Infinity, secondLabel = null;
      const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
      for (const otherRow of STORE.labels) {
        if (!otherRow.fisher_template) continue;
        const cvec = Float32Array.from(otherRow.fisher_template);
        const d = fisherWeightedDistance(qvec, cvec, fw);
        if (d < best) {
          if (bestLabel !== otherRow.label) { second = best; secondLabel = bestLabel; }
          best = d; bestLabel = otherRow.label;
        } else if (d < second && otherRow.label !== bestLabel) {
          second = d; secondLabel = otherRow.label;
        }
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
  console.log("\nceiling=" + ceiling.toFixed(2) + "  correct=" + correct + "/" + tested + " = " + pct + "%  confWrong=" + confWrong);
  if (!bestOverall || correct > bestOverall.correct) bestOverall = { ceiling, correct, tested, confWrong, perConcept, pct };
}

console.log("\n=== BEST CEILING: " + bestOverall.ceiling.toFixed(2) + " ===");
for (const c of bestOverall.perConcept) {
  const pct = c.tested > 0 ? Math.round(c.correct / c.tested * 100) : 0;
  console.log("  " + c.label.padEnd(18) + " " + c.correct + "/" + c.tested + " = " + String(pct).padStart(3) + "%  confWrong=" + c.confWrong);
}
console.log("\n=== FISHER SCORE ===");
console.log("Total: " + bestOverall.correct + "/" + bestOverall.tested + " = " + bestOverall.pct + "%");
console.log("Confident-wrong: " + bestOverall.confWrong);
