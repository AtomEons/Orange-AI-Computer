#!/usr/bin/env bun
// capture-matrix-ingest.mjs — FABLE MOVE 5 ingest.
//
// Reads C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-matrix/{object}/*.jpg
// following the protocol filename convention:
//   {object}_{light}_{angle}_{background}_{camera}_{seq}.jpg
// (see 00-CHARTER/CAPTURE_MATRIX_PROTOCOL_v1.md)
//
// Produces store-capture-matrix.json where every signature carries its full
// CONDITION LABELS — the raw material for the invariance ledger. Uses the
// SAME candidatesForFrame generator as recognition (candidate parity law).

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "../prism.mjs";
import { candidatesForFrame } from "../identity/recognize-human-grade.mjs";
import { calibrationForFrame } from "../self-calibration.mjs";

const CORPUS = "C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-matrix";
const OUT = process.argv[2] || path.join(CORPUS, "store-capture-matrix.json");

if (!fs.existsSync(CORPUS)) {
  console.error("Capture corpus not found: " + CORPUS);
  console.error("Run the capture day per 00-CHARTER/CAPTURE_MATRIX_PROTOCOL_v1.md first.");
  process.exit(2);
}

const FILE_RE = /^([a-z0-9-]+)_([a-z0-9-]+)_([a-z0-9-]+)_([a-z0-9-]+)_([a-z0-9-]+)_(\d+)\.(jpg|jpeg|png)$/i;

const objects = fs.readdirSync(CORPUS, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name);
console.log("Objects found: " + objects.length + " → " + objects.join(", "));

const STORE = { labels: [], meta: { protocol: "capture-matrix-v1", created: null } };
let totalSamples = 0, skipped = 0;

for (const obj of objects) {
  const dir = path.join(CORPUS, obj);
  const files = fs.readdirSync(dir).filter(f => FILE_RE.test(f)).sort();
  if (!files.length) { console.log("  " + obj + ": no protocol-named images, skip"); continue; }
  const signatures = [];
  for (const file of files) {
    const m = FILE_RE.exec(file);
    const [, fObj, light, angle, background, camera, seq] = m;
    try {
      const frame = await extractImageRGB(path.join(dir, file), { maxSize: 384 });
      const cal = calibrationForFrame(frame);
      const cands = candidatesForFrame(frame);
      if (!cands.length) { skipped++; console.log("  " + obj + "/" + file + ": no candidates, skip"); continue; }
      for (const sig of cands) {
        signatures.push({
          sig,
          conditions: { light, angle, background, camera, seq: parseInt(seq, 10) },
          calibration: {
            illuminant: cal.illuminant,
            illumConfidence: cal.illumConfidence,
            exposureProxy: cal.exposureProxy,
            gammaProxy: cal.gammaProxy,
            blurScore: cal.blurScore,
            noiseScore: cal.noiseScore,
          },
          file,
        });
      }
      totalSamples++;
    } catch (e) {
      skipped++;
      console.log("  " + obj + "/" + file + ": DECODE FAIL " + e.message);
    }
  }
  if (signatures.length) {
    STORE.labels.push({ label: obj, signatures });
    console.log("  " + obj + ": " + totalSamples + " images → " + signatures.length + " sigs (conditions labeled)");
  }
}
fs.writeFileSync(OUT, JSON.stringify(STORE));
console.log("\nWrote " + OUT);
console.log("Objects: " + STORE.labels.length + " · images: " + totalSamples + " · skipped: " + skipped);
console.log("Next: bun 07-VISUAL/structural/identity/prove-capture-matrix.mjs " + OUT);
