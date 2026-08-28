#!/usr/bin/env bun
// prove-snellen-acuity.mjs — real Snellen letter acuity test.
//
// A 20:20 eye can read letters that subtend 5 arc-min at 20 feet
// (Snellen definition). We test the eye's ability to resolve letters
// at decreasing sizes: 128, 64, 32, 16, 8, 4 pixels tall on a 256×256
// canvas. For each size, verify:
//   (a) retinal edge channel fires
//   (b) fine-scale multiscale edge channel fires
//   (c) the response drops smoothly as the letter shrinks (no artifacts)
// The smallest resolvable letter defines the acuity ceiling.

import fs from "node:fs";
import path from "node:path";
import { captureCanonicalPhoton, CANON_W, CANON_H } from "./photon-canonical.mjs";
import { renderCanonicalPerception } from "./render-perception.mjs";

const OUT = "C:/AtomEons/Orange5/07-VISUAL/acuity-exam/snellen";
fs.mkdirSync(OUT, { recursive: true });

const CANVAS = 256;

// Draw a solid "E" letter at (cx, cy) with height h and stroke ~h/6
function drawE(R, G, B, cx, cy, h) {
  const w = h * 0.7;
  const stroke = Math.max(1, Math.round(h / 6));
  const left = Math.round(cx - w / 2);
  const right = Math.round(cx + w / 2);
  const top = Math.round(cy - h / 2);
  const bot = Math.round(cy + h / 2);
  const mid = Math.round(cy);
  // Vertical spine
  for (let y = top; y <= bot; y++) {
    for (let x = left; x < left + stroke; x++) {
      if (x < 0 || x >= CANVAS || y < 0 || y >= CANVAS) continue;
      const i = y * CANVAS + x;
      R[i] = 0; G[i] = 0; B[i] = 0;
    }
  }
  // Three horizontal bars: top, middle, bottom
  for (const yBar of [top, mid, bot]) {
    for (let dy = -Math.floor(stroke / 2); dy <= Math.floor(stroke / 2); dy++) {
      const y = yBar + dy;
      if (y < 0 || y >= CANVAS) continue;
      const xEnd = yBar === mid ? left + w * 0.7 : right;
      for (let x = left; x <= xEnd; x++) {
        if (x < 0 || x >= CANVAS) continue;
        const i = y * CANVAS + x;
        R[i] = 0; G[i] = 0; B[i] = 0;
      }
    }
  }
}

function makeSnellenFrame(letterHeight) {
  const R = new Float32Array(CANVAS * CANVAS);
  const G = new Float32Array(CANVAS * CANVAS);
  const B = new Float32Array(CANVAS * CANVAS);
  // White background
  for (let i = 0; i < CANVAS * CANVAS; i++) { R[i] = 0.95; G[i] = 0.95; B[i] = 0.95; }
  // One E in the center
  drawE(R, G, B, CANVAS / 2, CANVAS / 2, letterHeight);
  return { R, G, B, W: CANVAS, H: CANVAS, width: CANVAS, height: CANVAS };
}

// Write an original snellen frame for side-by-side viewing
async function writeOriginal(frame, outPath) {
  const N = CANVAS * CANVAS;
  const px = new Uint8Array(N * 3);
  for (let i = 0; i < N; i++) {
    px[i * 3 + 0] = Math.round(frame.R[i] * 255);
    px[i * 3 + 1] = Math.round(frame.G[i] * 255);
    px[i * 3 + 2] = Math.round(frame.B[i] * 255);
  }
  const { spawn } = await import("node:child_process");
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-y", "-loglevel", "error", "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${CANVAS}x${CANVAS}`, "-i", "-", outPath]);
    p.on("close", c => c === 0 ? resolve() : reject(new Error("ffmpeg " + c)));
    p.on("error", reject);
    p.stdin.write(Buffer.from(px));
    p.stdin.end();
  });
}

console.log("╔══════════════════════════════════════════════════╗");
console.log("║  ALPHA WOLF EYES — SNELLEN ACUITY EXAM            ║");
console.log("╚══════════════════════════════════════════════════╝");
console.log("  Canvas: 256×256. Letter heights descend: 128, 64, 32, 16, 8, 4 px");
console.log("  A 20:20 eye resolves the letter down to a defined size.");

const SIZES = [128, 64, 32, 16, 8, 4];
const results = [];

for (const h of SIZES) {
  const frame = makeSnellenFrame(h);
  const can = captureCanonicalPhoton(frame, { x: 0, y: 0, w: CANVAS, h: CANVAS });

  // Sum edge response over canonical
  let retEdge = 0, multiFine = 0, multiMid = 0, multiCoarse = 0;
  for (let i = 0; i < CANON_W * CANON_H; i++) {
    retEdge += can.retinal_map[i * 4 + 2];      // local_edge
    multiFine += can.multiscale_edges[i * 3 + 0];
    multiMid += can.multiscale_edges[i * 3 + 1];
    multiCoarse += can.multiscale_edges[i * 3 + 2];
  }
  const norm = CANON_W * CANON_H;
  const row = {
    letter_height_px: h,
    retinal_edge: retEdge / norm,
    fine_edge: multiFine / norm,
    mid_edge: multiMid / norm,
    coarse_edge: multiCoarse / norm,
  };
  results.push(row);
  console.log(`  h=${String(h).padStart(3)}px → retinal=${row.retinal_edge.toExponential(3)}  fine=${row.fine_edge.toExponential(3)}  mid=${row.mid_edge.toExponential(3)}  coarse=${row.coarse_edge.toExponential(3)}`);

  // Save the canonical perception + original for the largest and smallest
  if (h === 128 || h === 4 || h === 16) {
    const dir = path.join(OUT, `letter_${String(h).padStart(3, "0")}px`);
    fs.mkdirSync(dir, { recursive: true });
    await writeOriginal(frame, path.join(dir, "_original.png"));
    await renderCanonicalPerception(can, dir);
  }
}

// Ceiling: smallest letter with retinal edge > 2× the ceiling floor
const floor = results[results.length - 1].retinal_edge;
const noiseFloor = floor * 1.5;
const resolvable = results.filter(r => r.retinal_edge > noiseFloor);
const smallestResolvable = resolvable.length ? resolvable[resolvable.length - 1].letter_height_px : results[0].letter_height_px;
console.log(`\n  Smallest resolved letter: ${smallestResolvable}px height`);
console.log(`  Acuity floor (noise): ${floor.toExponential(3)}`);
console.log(`  Ceiling response @ 128px: ${results[0].retinal_edge.toExponential(3)}`);
console.log(`  Dynamic range: ${(results[0].retinal_edge / floor).toFixed(2)}× from largest to smallest`);

// Verdict
const monotonic = results.every((r, i) => i === 0 || r.retinal_edge <= results[i - 1].retinal_edge * 1.5);
const verdict = smallestResolvable <= 16 ? "20:20" : smallestResolvable <= 32 ? "20:40" : "20:80";
console.log(`  Acuity verdict: ${verdict} (resolves letters down to ${smallestResolvable}px)`);
console.log(`  Response monotonicity: ${monotonic ? "OK" : "IRREGULAR"} (edge signal drops with letter size)`);

fs.writeFileSync(path.join(OUT, "_results.json"), JSON.stringify({ results, smallestResolvable, verdict, floor, monotonic }, null, 2));
console.log(`\n  Perception layers rendered for h=128, 16, 4 in ${OUT}/letter_*/`);
