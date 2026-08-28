#!/usr/bin/env bun
// awe100k-frames-to-canonical.mjs — run every extracted frame through the
// Alpha Wolf Eyes canonical pipeline and serialize to disk.
//
// Reads: C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-100k/{object}/frames/*.jpg
// Writes: C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-100k/{object}/canonicals/{frameId}.json
//   plus manifest at capture-100k/_manifest.json
// Idempotent per-file: skips frames whose canonical exists.
//
// Concurrency: processes frames sequentially per object; parallelize by
// spawning multiple bun processes if the wall-clock matters.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "../prism.mjs";
import { captureCanonicalPhoton } from "../photon-canonical.mjs";

const ROOT = "C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-100k";
const MANIFEST_PATH = path.join(ROOT, "_manifest.json");

function serializeCanonical(can) {
  const b64 = (arr) => Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength).toString("base64");
  return {
    reflectance_map_b64: b64(can.reflectance_map),
    opponent_map_b64: b64(can.opponent_map),
    retinal_map_b64: b64(can.retinal_map),
    depth_map_b64: b64(can.depth_map),
    multiscale_edges_b64: b64(can.multiscale_edges),
    saliency_map_b64: b64(can.saliency_map),
    shape_moments: Array.from(can.shape_moments),
    spectral_moments: Array.from(can.spectral_moments),
    meta: can.meta,
  };
}

if (!fs.existsSync(ROOT)) {
  console.log("no capture-100k dir yet — nothing to canonicalize");
  console.log("expected: " + ROOT);
  process.exit(0);
}

const objects = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
console.log("objects: " + objects.length);
const manifest = { total_canonicals: 0, by_object: {}, started: new Date().toISOString(), entries: [] };

let totalDone = 0, totalSkipped = 0, totalErrors = 0;
for (const obj of objects) {
  const framesDir = path.join(ROOT, obj, "frames");
  const canonDir = path.join(ROOT, obj, "canonicals");
  if (!fs.existsSync(framesDir)) continue;
  fs.mkdirSync(canonDir, { recursive: true });
  const frames = fs.readdirSync(framesDir).filter(f => /^frame_\d+\.jpg$/.test(f)).sort();
  let objDone = 0, objSkipped = 0, objErrors = 0;
  for (const f of frames) {
    const frameId = f.replace(/\.jpg$/, "");
    const outPath = path.join(canonDir, frameId + ".json");
    if (fs.existsSync(outPath)) {
      objSkipped++;
      continue;
    }
    try {
      const rgb = await extractImageRGB(path.join(framesDir, f), { maxSize: 384 });
      const can = captureCanonicalPhoton(rgb, { x: 0, y: 0, w: rgb.width, h: rgb.height });
      const ser = serializeCanonical(can);
      fs.writeFileSync(outPath, JSON.stringify(ser));
      manifest.entries.push({ object: obj, frame: frameId, path: outPath });
      objDone++;
      totalDone++;
    } catch (e) {
      objErrors++;
      totalErrors++;
    }
  }
  manifest.by_object[obj] = { done: objDone, skipped: objSkipped, errors: objErrors, total: objDone + objSkipped };
  totalSkipped += objSkipped;
  console.log("  " + obj.padEnd(20) + " done=" + String(objDone).padStart(5) + " skipped=" + String(objSkipped).padStart(5) + " errors=" + objErrors);
  // save manifest after each object so crash-in-middle preserves progress
  manifest.total_canonicals = totalDone + totalSkipped;
  manifest.updated = new Date().toISOString();
  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest));
}
console.log("\nTOTAL: " + totalDone + " new canonicals · " + totalSkipped + " skipped · " + totalErrors + " errors");
console.log("Manifest: " + MANIFEST_PATH + " (" + manifest.total_canonicals + " total canonicals across corpus)");
