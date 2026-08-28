#!/usr/bin/env bun
// prove-snellen-identification.mjs — true 20:20 IDENTIFICATION test.
//
// Detection is easy: is there a letter or not? IDENTIFICATION is harder:
// which letter is it? A 20:20 eye distinguishes E from F from H from I
// down to letters subtending 5 arc-min.
//
// We render each letter at each size, compute its canonical, then verify:
//   same_letter_mse  = mean MSE between same-letter canonicals across noise
//   diff_letter_mse  = mean MSE between different-letter canonicals at same size
//   separation ratio = diff / same (higher = better discrimination)
//
// The eye passes identification at a given size if separation ≥ 3× (letters
// distinguishable from each other much more than a noisy version of the
// same letter).

import fs from "node:fs";
import path from "node:path";
import { captureCanonicalPhoton, canonicalPhotonMSE } from "./photon-canonical.mjs";

const OUT = "C:/AtomEons/Orange5/07-VISUAL/acuity-exam/snellen-id";
fs.mkdirSync(OUT, { recursive: true });

const CANVAS = 256;

function makeBlank() {
  const N = CANVAS * CANVAS;
  const R = new Float32Array(N), G = new Float32Array(N), B = new Float32Array(N);
  for (let i = 0; i < N; i++) { R[i] = 0.95; G[i] = 0.95; B[i] = 0.95; }
  return { R, G, B, W: CANVAS, H: CANVAS, width: CANVAS, height: CANVAS };
}

function fillRect(f, x0, y0, x1, y1) {
  for (let y = Math.max(0, y0); y < Math.min(CANVAS, y1); y++) {
    for (let x = Math.max(0, x0); x < Math.min(CANVAS, x1); x++) {
      const i = y * CANVAS + x;
      f.R[i] = 0; f.G[i] = 0; f.B[i] = 0;
    }
  }
}

// Draw one of E, F, H, I at center with height h. All same width for fair
// comparison; only crossbar pattern differs.
function drawLetter(f, letter, cx, cy, h) {
  const w = Math.round(h * 0.65);
  const stroke = Math.max(1, Math.round(h / 6));
  const left = Math.round(cx - w / 2);
  const right = Math.round(cx + w / 2);
  const top = Math.round(cy - h / 2);
  const bot = Math.round(cy + h / 2);
  const mid = Math.round(cy);
  const halfS = Math.floor(stroke / 2);

  if (letter === "I") {
    // Vertical spine only + top and bottom serifs
    fillRect(f, cx - halfS, top, cx - halfS + stroke, bot + 1);
    fillRect(f, left, top - halfS, right + 1, top - halfS + stroke);
    fillRect(f, left, bot - halfS + 1, right + 1, bot - halfS + 1 + stroke);
    return;
  }

  // Vertical spine (left)
  fillRect(f, left, top, left + stroke, bot + 1);

  if (letter === "H") {
    // Second vertical (right) + middle crossbar
    fillRect(f, right - stroke + 1, top, right + 1, bot + 1);
    fillRect(f, left, mid - halfS, right + 1, mid - halfS + stroke);
    return;
  }

  // E and F: top and middle horizontal bars
  fillRect(f, left, top, right + 1, top + stroke);
  fillRect(f, left, mid - halfS, left + Math.round(w * 0.75), mid - halfS + stroke);
  // E has bottom bar; F does not
  if (letter === "E") {
    fillRect(f, left, bot - stroke + 1, right + 1, bot + 1);
  }
}

function makeLetterFrame(letter, h) {
  const f = makeBlank();
  drawLetter(f, letter, CANVAS / 2, CANVAS / 2, h);
  return f;
}

// Add a tiny perturbation (Gaussian shift by 1-2 px) to simulate same-letter noise
function makePerturbedLetterFrame(letter, h, dx, dy) {
  const f = makeBlank();
  drawLetter(f, letter, CANVAS / 2 + dx, CANVAS / 2 + dy, h);
  return f;
}

console.log("╔══════════════════════════════════════════════════╗");
console.log("║  ALPHA WOLF EYES — SNELLEN 20:20 IDENTIFICATION   ║");
console.log("╚══════════════════════════════════════════════════╝");
console.log("  Test: E vs F vs H vs I. Same-letter (perturbed) vs different-letter MSE.");
console.log("  A 20:20 eye discriminates letters — separation ratio ≥ 3× required.");

const LETTERS = ["E", "F", "H", "I"];
const SIZES = [128, 96, 64, 48, 32, 24, 16, 12, 8];
const PERTURBATIONS = [{dx: 0, dy: 0}, {dx: 1, dy: 0}, {dx: 0, dy: 1}, {dx: -1, dy: 1}, {dx: 1, dy: -1}];
const results = [];

for (const h of SIZES) {
  const canonicals = {}; // letter -> array of canonicals
  for (const L of LETTERS) {
    canonicals[L] = [];
    for (const p of PERTURBATIONS) {
      const frame = makePerturbedLetterFrame(L, h, p.dx, p.dy);
      const can = captureCanonicalPhoton(frame, { x: 0, y: 0, w: CANVAS, h: CANVAS });
      canonicals[L].push(can);
    }
  }

  // Same-letter distances: within each letter's perturbation set
  let sameSum = 0, sameCount = 0;
  for (const L of LETTERS) {
    const arr = canonicals[L];
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        sameSum += canonicalPhotonMSE(arr[i], arr[j]);
        sameCount++;
      }
    }
  }
  const sameMean = sameSum / (sameCount || 1);

  // Different-letter distances: between letter classes (use first perturbation only)
  let diffSum = 0, diffCount = 0;
  for (let i = 0; i < LETTERS.length; i++) {
    for (let j = i + 1; j < LETTERS.length; j++) {
      diffSum += canonicalPhotonMSE(canonicals[LETTERS[i]][0], canonicals[LETTERS[j]][0]);
      diffCount++;
    }
  }
  const diffMean = diffSum / (diffCount || 1);
  const sep = diffMean / (sameMean || 1e-12);

  // Nearest-neighbor test: for each letter's canonical, is nearest OTHER letter always further than nearest SAME-letter perturbation?
  let nnCorrect = 0, nnTotal = 0;
  for (const trueLetter of LETTERS) {
    for (const query of canonicals[trueLetter]) {
      let bestMSE = Infinity, bestLabel = null;
      for (const cand of LETTERS) {
        for (const c of canonicals[cand]) {
          if (c === query) continue;
          const d = canonicalPhotonMSE(query, c);
          if (d < bestMSE) { bestMSE = d; bestLabel = cand; }
        }
      }
      nnTotal++;
      if (bestLabel === trueLetter) nnCorrect++;
    }
  }
  const nnAcc = nnCorrect / nnTotal;

  const verdict = sep >= 3 && nnAcc === 1.0 ? "PASS" : sep >= 2 || nnAcc >= 0.75 ? "MARGINAL" : "FAIL";
  const row = { letter_h_px: h, sameMean, diffMean, sep, nnCorrect, nnTotal, nnAcc, verdict };
  results.push(row);
  console.log(`  h=${String(h).padStart(3)}px  same=${sameMean.toExponential(2)}  diff=${diffMean.toExponential(2)}  sep=${sep.toFixed(2)}×  NN=${nnCorrect}/${nnTotal}  → ${verdict}`);
}

const passResults = results.filter(r => r.verdict === "PASS");
const smallestPass = passResults.length ? passResults[passResults.length - 1].letter_h_px : null;

console.log(`\n  Identification ceiling (smallest letter fully identified): ${smallestPass ?? "none"} px`);

// Snellen ratio: 20/20 = smallest letter subtends 5 arcmin.
// On 256px canvas, if we say the field is ~1 degree (60 arcmin), then 5 arcmin = 256/12 ≈ 21 px.
// So a 20:20 eye should identify letters at ~21px.
if (smallestPass !== null) {
  if (smallestPass <= 8) console.log("  Verdict: 20:10 territory (superhuman) — letters resolved beyond 20:20 threshold");
  else if (smallestPass <= 16) console.log("  Verdict: 20:15 (better than 20:20)");
  else if (smallestPass <= 24) console.log("  Verdict: 20:20 (Snellen standard met)");
  else if (smallestPass <= 40) console.log("  Verdict: 20:40 (needs glasses)");
  else console.log("  Verdict: 20:80+ (well short of 20:20)");
} else {
  console.log("  Verdict: no size passed — identification not achievable at any tested size");
}

fs.writeFileSync(path.join(OUT, "_results.json"), JSON.stringify({ results, smallestPass }, null, 2));
console.log(`\n  Results: ${path.join(OUT, "_results.json")}`);
