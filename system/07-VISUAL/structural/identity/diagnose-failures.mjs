#!/usr/bin/env bun
// diagnose-failures.mjs — show WHAT each frame gets misclassified as.
// Reveals the confusion axes so we can build targeted discriminators.

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

const argv = process.argv.slice(2);
const storePath = argv[0];
const concepts = argv.slice(1);
const STORE = JSON.parse(fs.readFileSync(storePath, "utf-8"));

const stats = attachFisherRatioToStore(STORE);
const fw = { fisher: Float32Array.from(STORE.fisher_stats.fisher) };
const instances = [];
for (const row of STORE.labels) {
  for (const s of row.signatures) {
    const raw = flattenSignature(s.sig);
    const std = standardizeSignatureVector(raw, STORE.fisher_stats);
    instances.push({ label: row.label, vec: std });
  }
}

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32); }
function multiScaleRegions(region) {
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  return [1.0, 0.7, 0.5].map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

for (const conceptName of concepts) {
  console.log("=== " + conceptName + " ===");
  const dir = path.join(CORPUS_ROOT, slugify(conceptName));
  if (!fs.existsSync(dir)) { console.log("no dir"); continue; }
  const files = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm)$/i.test(f)).sort();
  if (files.length < 2) { console.log("only " + files.length + " clips"); continue; }
  const heldOut = path.join(dir, files.at(-1));
  const frames = await extractVideoFrames(heldOut, { frames: 5, size: 384 });
  for (let fi = 0; fi < frames.length; fi++) {
    const f = frames[fi];
    const candidates = [];
    for (const hg of ["warm_loose", "any"]) {
      const warm = extractWarmEntities(f, { hue_gate: hg });
      if (!warm.length) continue;
      const u = signatureForUnion(f, warm);
      if (u) candidates.push(u);
      for (const w of warm.slice(0, 3)) {
        for (const region of multiScaleRegions(w.region)) {
          const s = signatureForRegion(f, region);
          if (s) candidates.push(s);
        }
      }
    }
    if (!candidates.length) { console.log("  frame " + fi + ": no_warm"); continue; }
    const results = new Map();
    for (const c of candidates) {
      const qvec = standardizeSignatureVector(flattenSignature(c), STORE.fisher_stats);
      let best = Infinity, bestLbl = null;
      for (const inst of instances) {
        const d = fisherWeightedDistance(qvec, inst.vec, fw);
        if (d < best) { best = d; bestLbl = inst.label; }
      }
      results.set(bestLbl, Math.min(best, results.get(bestLbl) ?? Infinity));
    }
    const ranked = [...results.entries()].sort((a, b) => a[1] - b[1]).slice(0, 4);
    console.log("  frame " + fi + ": top matches = " + ranked.map(([l, d]) => l + "(" + d.toFixed(2) + ")").join(", "));
  }
  console.log("");
}
