#!/usr/bin/env bun
// learn-weights-apply.mjs — Learn per-concept channel weights from confusion
// data, apply to store, save.
//
// AE7 mentions per-concept ceilings and adaptive weights. `second-pass-alpha`
// already ships `learnChannelWeightsFromData(store)` — this driver runs it,
// applies the learned weights to each row, saves back.
//
// Usage:
//   bun learn-weights-apply.mjs store-in.json store-out.json

import fs from "node:fs";
import { learnChannelWeightsFromData, applyLearnedWeights } from "./second-pass-alpha.mjs";

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: bun learn-weights-apply.mjs store-in.json store-out.json");
  process.exit(2);
}

const [inPath, outPath] = argv;
const STORE = JSON.parse(fs.readFileSync(inPath, "utf-8"));

console.log("Learning per-concept weights from " + STORE.labels.length + " concepts...");
const learned = learnChannelWeightsFromData(STORE, {
  channels: ["color", "edge", "texture", "specular", "spatial"],
});

console.log("\nLearned weights (per-concept, discriminative channels highlighted):");
for (const [label, w] of learned.entries()) {
  const parts = Object.entries(w).map(([k, v]) => k + "=" + v.toFixed(2));
  console.log("  " + label.padEnd(20) + " " + parts.join("  "));
}

applyLearnedWeights(STORE, learned);
fs.writeFileSync(outPath, JSON.stringify(STORE, null, 2));
console.log("\nStore written: " + outPath);
