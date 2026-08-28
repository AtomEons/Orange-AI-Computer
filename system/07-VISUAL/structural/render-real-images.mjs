#!/usr/bin/env bun
// render-real-images.mjs — the SEEING on REAL photons.
//
// Runs 6 real image fixtures through Alpha Wolf Eyes and writes all 15
// canonical perception layers per image. The operator can look at the
// output PNGs and see what the eye sees in real-world light.

import fs from "node:fs";
import path from "node:path";
import { extractImageRGB } from "./prism.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";
import { renderCanonicalPerception } from "./render-perception.mjs";

const FIX = "C:/AtomEons/Orange5/07-VISUAL/fixtures";
const OUT = "C:/AtomEons/Orange5/07-VISUAL/acuity-exam/real-images";

const IMAGES = [
  { name: "apple",      path: `${FIX}/apple.jpg` },
  { name: "baboon",     path: `${FIX}/baboon.jpg` },
  { name: "basketball", path: `${FIX}/basketball1.png` },
  { name: "board",      path: `${FIX}/board.jpg` },
  { name: "building",   path: `${FIX}/building.jpg` },
  { name: "orange",     path: `${FIX}/baby-cinema/frames-single/orange_t1.5.png` },
];

fs.mkdirSync(OUT, { recursive: true });

console.log("╔══════════════════════════════════════════════════╗");
console.log("║  ALPHA WOLF EYES — SEEING ON REAL PHOTONS         ║");
console.log("╚══════════════════════════════════════════════════╝");

for (const img of IMAGES) {
  if (!fs.existsSync(img.path)) {
    console.log(`  [skip] ${img.name} — file not found: ${img.path}`);
    continue;
  }
  try {
    const rgb = await extractImageRGB(img.path, { maxSize: 384 });
    const can = captureCanonicalPhoton(rgb, { x: 0, y: 0, w: rgb.width, h: rgb.height });
    const outDir = path.join(OUT, img.name);
    const count = await renderCanonicalPerception(can, outDir);
    // Also copy the original for side-by-side viewing
    const origCopy = path.join(outDir, "_original.png");
    if (!fs.existsSync(origCopy)) {
      try { fs.copyFileSync(img.path, origCopy); } catch (e) { /* jpg -> png ok */ }
    }
    console.log(`  [ok] ${img.name.padEnd(12)} → ${count} layers @ ${outDir}`);
  } catch (e) {
    console.log(`  [err] ${img.name}: ${e.message.split("\n")[0]}`);
  }
}

console.log("\n  operator: open the PNGs and evaluate whether the eye SEES");
console.log("  each subfolder has: _original.png + 00-14 perception layers");
console.log(`  root: ${OUT}`);
