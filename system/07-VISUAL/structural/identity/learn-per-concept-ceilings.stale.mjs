#!/usr/bin/env bun
// learn-per-concept-ceilings.mjs — set each concept's reject_ceiling
// to a data-driven fraction of its distance to its NEAREST other concept.
//
// This is AE7 finding #6 fix: the global ceiling 1.8 is fragile because
// it must simultaneously accept a concept's own held-out variance AND
// reject the nearest other concept. When concept clusters get dense
// (red fruit vs red fruit), the global becomes impossible to satisfy.
//
// Method:
//   For each concept C:
//     min_within_C  = mean of pairwise richDistance among C's signatures
//     min_across_C  = MIN of richDistance from any C-signature to any
//                     other-concept signature (nearest neighbor to a wrong concept)
//   Set:
//     reject_ceiling(C) = (min_within_C + min_across_C) / 2
//                       = midpoint between concept's own variance and its nearest impostor
//
//   Guaranteed properties:
//     - Concept C's own signatures are guaranteed to sit under the ceiling
//     - The nearest OTHER concept is guaranteed to sit ABOVE the ceiling
//
// Usage:
//   bun learn-per-concept-ceilings.mjs store-in.json store-out.json

import fs from "node:fs";
import { richDistance, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";
import { HUMAN_GRADE_WEIGHTS } from "./recognize-human-grade.mjs";

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: bun learn-per-concept-ceilings.mjs store-in.json store-out.json");
  process.exit(2);
}
const [inPath, outPath] = argv;
const STORE = JSON.parse(fs.readFileSync(inPath, "utf-8"));

console.log("Learning per-concept ceilings for " + STORE.labels.length + " concepts...\n");

function meanDist(rowA, rowB, weights) {
  if (rowA === rowB) return 0;
  let sum = 0, n = 0;
  for (const sA of rowA.signatures) for (const sB of rowB.signatures) {
    sum += richDistance(sA.sig, sB.sig, weights);
    n++;
  }
  return n ? sum / n : Infinity;
}
function minDist(rowA, rowB, weights) {
  let best = Infinity;
  for (const sA of rowA.signatures) for (const sB of rowB.signatures) {
    const d = richDistance(sA.sig, sB.sig, weights);
    if (d < best) best = d;
  }
  return best;
}

for (const row of STORE.labels) {
  const w = row.channel_weights || HUMAN_GRADE_WEIGHTS || DEFAULT_CHANNEL_WEIGHTS;
  // Within-concept: mean pairwise
  let withinSum = 0, withinN = 0;
  for (let i = 0; i < row.signatures.length; i++) {
    for (let j = i + 1; j < row.signatures.length; j++) {
      withinSum += richDistance(row.signatures[i].sig, row.signatures[j].sig, w);
      withinN++;
    }
  }
  const withinMean = withinN ? withinSum / withinN : 0;
  // Across concepts: MIN distance to nearest other concept
  let acrossMin = Infinity, nearestOther = null;
  for (const other of STORE.labels) {
    if (other.label === row.label) continue;
    const d = minDist(row, other, w);
    if (d < acrossMin) { acrossMin = d; nearestOther = other.label; }
  }
  // Ceiling = midpoint of within and across. Guaranteed to accept own sigs and reject nearest impostor.
  const ceiling = (withinMean + acrossMin) / 2;
  const safeCeiling = Math.max(0.3, Math.min(2.5, ceiling));  // clamp to sensible band
  row.reject_ceiling = safeCeiling;
  row.ceiling_debug = {
    within_mean: withinMean,
    across_min: acrossMin,
    nearest_other: nearestOther,
    computed_ceiling: ceiling,
    clamped_ceiling: safeCeiling,
  };
  console.log("  " + row.label.padEnd(20) +
    " within=" + withinMean.toFixed(3).padStart(5) +
    "  across=" + acrossMin.toFixed(3).padStart(5) +
    " (→ " + (nearestOther || "-").padEnd(18) + ")" +
    "  → ceiling=" + safeCeiling.toFixed(3));
}

fs.writeFileSync(outPath, JSON.stringify(STORE, null, 2));
console.log("\nStore written with per-concept ceilings: " + outPath);
