#!/usr/bin/env bun
// rebalance-weights.mjs — apply illumination-invariant weight profile
// to every concept in a store.
//
// The default HUMAN_GRADE_WEIGHTS weights raw color 2.0× — great for
// SEPARATING orange from apple, terrible for SEPARATING orange from
// tomato from strawberry because they're all in the same red hue band
// and vary MORE with lighting than with concept identity.
//
// The illumination-invariant profile promotes:
//   colorRatio (log R/G, G/B, R/B) — invariant to global lighting scale
//   texture (LBP) — surface pattern, invariant to color
//   spatialFreq (FFT band energies) — surface pattern in freq domain
//   edge — shape signature
// And demotes:
//   color (mean_R/G/B) — varies with exposure
//   specular — varies with lighting angle
//
// Usage:
//   bun rebalance-weights.mjs store-in.json store-out.json

import fs from "node:fs";

const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: bun rebalance-weights.mjs store-in.json store-out.json");
  process.exit(2);
}
const [inPath, outPath] = argv;
const STORE = JSON.parse(fs.readFileSync(inPath, "utf-8"));

const INV_WEIGHTS = {
  color:       0.8,   // demoted from 2.0
  edge:        1.0,   // promoted from 0.6
  texture:     1.5,   // promoted from 0.5
  specular:    0.2,   // demoted from 0.3
  spatial:     0.6,   // slight promotion
  subsurface:  0.6,   // slight promotion
  colorRatio:  2.0,   // promoted from 0.8 — illumination-invariant chromaticity
  spatialFreq: 1.2,   // promoted from 0.4 — surface pattern signature
  retinal12:   0.7,   // unchanged
};

for (const row of STORE.labels) {
  row.channel_weights = { ...INV_WEIGHTS };
}

fs.writeFileSync(outPath, JSON.stringify(STORE, null, 2));
console.log("Applied illumination-invariant weights to " + STORE.labels.length + " concepts");
console.log("New profile:", JSON.stringify(INV_WEIGHTS));
console.log("Written: " + outPath);
