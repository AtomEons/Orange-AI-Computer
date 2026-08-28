#!/usr/bin/env bun
// merge-stores.mjs — combine multiple identity-stores into one big store.
// Usage: bun merge-stores.mjs out.json in1.json in2.json ...

import fs from "node:fs";

const [, , outPath, ...inPaths] = process.argv;
if (!outPath || inPaths.length === 0) {
  console.error("usage: bun merge-stores.mjs OUT IN1 IN2 ...");
  process.exit(1);
}

const merged = { labels: [], meta: { merged_from: inPaths } };
const seenLabels = new Map();

for (const p of inPaths) {
  if (!fs.existsSync(p)) { console.log("skip (missing): " + p); continue; }
  const s = JSON.parse(fs.readFileSync(p, "utf-8"));
  if (!s.labels) continue;
  console.log(p + " → " + s.labels.length + " concepts");
  for (const row of s.labels) {
    if (seenLabels.has(row.label)) {
      // Merge signatures into existing row
      const ex = merged.labels[seenLabels.get(row.label)];
      ex.signatures = ex.signatures.concat(row.signatures);
    } else {
      seenLabels.set(row.label, merged.labels.length);
      merged.labels.push({ label: row.label, signatures: [...row.signatures] });
    }
  }
}

console.log("\nMerged: " + merged.labels.length + " unique concepts");
let totalSigs = 0;
for (const r of merged.labels) totalSigs += r.signatures.length;
console.log("Total signatures: " + totalSigs);
console.log("Signatures per concept: min=" + Math.min(...merged.labels.map(r => r.signatures.length)) + " avg=" + (totalSigs / merged.labels.length).toFixed(2) + " max=" + Math.max(...merged.labels.map(r => r.signatures.length)));

fs.writeFileSync(outPath, JSON.stringify(merged));
console.log("Wrote " + outPath);
