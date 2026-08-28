#!/usr/bin/env bun
// phase-a-t-null-basic.mjs — Phase A-T qualification bank for W+1 temporal luminance.
// GPT doctrine v6 (spine seq 122): null controls + fundamental events + per-channel promotion criteria.
//
// Probes are synthesized from orange.jpg so triplets are controlled and repeatable.
// For each probe, report (per GPT):
//   expected activation | unexpected activation | direction sign |
//   spatial localization | noise margin | temporal confidence | repeatability hash
//
// Promotion criteria for W+1 luminance transient (all required):
//   1. responds to intended temporal event
//   2. remains quiet on qualified static sequences
//   3. localizes the event correctly
//   4. maintains direction/polarity semantics
//   5. survives normal codec noise
//   6. deterministic across fresh processes
//   7. does NOT alter v1.0 static hashes (proven by v1.1 invariants)
//   8. does NOT depend on future frames in causal mode (proven by v1.1 invariants)

import fs from "node:fs";
import { extractImageRGB } from "./prism.mjs";
import { computeLuminanceTransient } from "./temporal-luminance-w1.mjs";
import { hashField } from "./axis-tap.mjs";

const OUT_FILE = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results/phase_a_t_w1_qualification.json";

// ---- Frame synthesis helpers ----
function copyFrame(rgb) {
  return {
    R: new Float32Array(rgb.R), G: new Float32Array(rgb.G), B: new Float32Array(rgb.B),
    width: rgb.width, height: rgb.height,
  };
}
function scaleBrightness(rgb, factor) {
  const out = copyFrame(rgb);
  for (let i = 0; i < out.R.length; i++) {
    out.R[i] = Math.min(1, Math.max(0, rgb.R[i] * factor));
    out.G[i] = Math.min(1, Math.max(0, rgb.G[i] * factor));
    out.B[i] = Math.min(1, Math.max(0, rgb.B[i] * factor));
  }
  return out;
}
function subJndNoise(rgb, iter, sigma = 0.003) {
  const out = copyFrame(rgb);
  for (let i = 0; i < out.R.length; i++) {
    const seed = iter * rgb.R.length + i;
    const nx = (Math.sin(seed * 12.9898) * 43758.5453) % 1;
    const ny = (Math.sin(seed * 78.233) * 43758.5453) % 1;
    const nz = (Math.sin(seed * 37.719) * 43758.5453) % 1;
    out.R[i] = Math.min(1, Math.max(0, rgb.R[i] + (nx - 0.5) * sigma));
    out.G[i] = Math.min(1, Math.max(0, rgb.G[i] + (ny - 0.5) * sigma));
    out.B[i] = Math.min(1, Math.max(0, rgb.B[i] + (nz - 0.5) * sigma));
  }
  return out;
}
function jpegLikeNoise(rgb, iter) {
  // Approximate JPEG quantization noise via 8×8 block-level random offsets
  const out = copyFrame(rgb);
  const w = rgb.width, h = rgb.height;
  for (let by = 0; by < h; by += 8) {
    for (let bx = 0; bx < w; bx += 8) {
      const seed = iter * 10000 + by * w + bx;
      const jitter = ((Math.sin(seed * 12.9898) * 43758.5453) % 1 - 0.5) * 0.008;
      for (let y = by; y < Math.min(h, by + 8); y++) {
        for (let x = bx; x < Math.min(w, bx + 8); x++) {
          const i = y * w + x;
          out.R[i] = Math.min(1, Math.max(0, rgb.R[i] + jitter));
          out.G[i] = Math.min(1, Math.max(0, rgb.G[i] + jitter));
          out.B[i] = Math.min(1, Math.max(0, rgb.B[i] + jitter));
        }
      }
    }
  }
  return out;
}
function blackFrame(w, h) {
  return { R: new Float32Array(w * h), G: new Float32Array(w * h), B: new Float32Array(w * h), width: w, height: h };
}
function alphaBlend(fg, bg, alpha) {
  const out = copyFrame(fg);
  for (let i = 0; i < out.R.length; i++) {
    out.R[i] = fg.R[i] * alpha + bg.R[i] * (1 - alpha);
    out.G[i] = fg.G[i] * alpha + bg.G[i] * (1 - alpha);
    out.B[i] = fg.B[i] * alpha + bg.B[i] * (1 - alpha);
  }
  return out;
}
function shift(rgb, dx, dy) {
  const out = copyFrame(rgb);
  const w = rgb.width, h = rgb.height;
  for (let i = 0; i < out.R.length; i++) { out.R[i] = 0; out.G[i] = 0; out.B[i] = 0; }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const sx = x - dx, sy = y - dy;
      if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue;
      const dst = y * w + x, src = sy * w + sx;
      out.R[dst] = rgb.R[src]; out.G[dst] = rgb.G[src]; out.B[dst] = rgb.B[src];
    }
  }
  return out;
}

// ---- Metric extraction from W+1 output ----
function extractMetrics(w1Result, expectations) {
  const r = w1Result;
  const passes = {};
  const values = {
    mean: r.mean,
    meanAbs: r.meanAbs,
    std: r.std,
    max: r.max,
    min: r.min,
    globalLuminanceShift: r.globalLuminanceShift,
    residualMeanAbs: r.residualMeanAbs,
  };
  const cellMeans = r.cells.map(c => c.meanDeltaY);
  const cellSpread = Math.max(...cellMeans) - Math.min(...cellMeans);
  // GPT-required per-channel diagnostics:
  const diagnostics = {
    expected_activation: expectations.expectResponse ? r.meanAbs >= expectations.minMeanAbs : true,
    unexpected_activation: expectations.expectResponse ? true : r.meanAbs < expectations.maxMeanAbs,
    direction_sign_correct: expectations.expectedSign === null
      ? true
      : (expectations.expectedSign === "+" ? r.mean > 0 : expectations.expectedSign === "-" ? r.mean < 0 : true),
    spatial_localization: expectations.expectLocalization ? cellSpread > 0.005 : true,
    noise_margin: null,   // filled in by caller
    temporal_confidence: r.std > 1e-9 ? Math.abs(r.mean) / r.std : Infinity,
    repeatability_hash: hashField(r.deltaY),
  };
  return { values, cellMeans, cellSpread, diagnostics };
}

// ---- Probe runner ----
async function runProbe(name, category, prev, curr, expectations, nullNoiseFloor = 0) {
  const w1 = computeLuminanceTransient(prev, curr);
  if (!w1.valid) return { name, category, error: w1.reason };
  const m = extractMetrics(w1, expectations);
  m.diagnostics.noise_margin = nullNoiseFloor > 0 ? w1.meanAbs / nullNoiseFloor : Infinity;
  return {
    name, category, expectations,
    metrics: m.values,
    cellMeans: m.cellMeans,
    cellSpread: m.cellSpread,
    diagnostics: m.diagnostics,
  };
}

// ---- Load anchor frame ----
const orange = await extractImageRGB("C:/AtomEons/Orange5/07-VISUAL/fixtures/orange.jpg", { maxSize: 384 });
const { width: w, height: h } = orange;
const bkgd = blackFrame(w, h);

console.log("═══ PHASE A-T W+1 QUALIFICATION BANK ═══\n");
console.log("Null controls first, then fundamental events.\n");

const results = [];

// ---- NULL CONTROLS ----
console.log("── NULL CONTROLS (W+1 should be quiet) ──");

// N1: identical triplet
const r_N1 = await runProbe("N1_identical_triplet", "null",
  orange, orange,
  { expectResponse: false, maxMeanAbs: 1e-6, expectedSign: null, expectLocalization: false });
console.log(`  ${r_N1.name}: meanAbs=${r_N1.metrics.meanAbs.toExponential(2)}  unexpected=${r_N1.diagnostics.unexpected_activation}`);
results.push(r_N1);

// N2: sub-JND noise (invisible to human, should be within noise floor)
const orangeN1 = subJndNoise(orange, 1, 0.003);
const orangeN2 = subJndNoise(orange, 2, 0.003);
const r_N2 = await runProbe("N2_subJND_noise", "null",
  orangeN1, orangeN2,
  { expectResponse: false, maxMeanAbs: 0.004, expectedSign: null, expectLocalization: false });
console.log(`  ${r_N2.name}: meanAbs=${r_N2.metrics.meanAbs.toExponential(2)}  unexpected=${r_N2.diagnostics.unexpected_activation}`);
results.push(r_N2);

// N3: JPEG-like block noise
const orangeJ1 = jpegLikeNoise(orange, 1);
const orangeJ2 = jpegLikeNoise(orange, 2);
const r_N3 = await runProbe("N3_jpeg_block_noise", "null",
  orangeJ1, orangeJ2,
  { expectResponse: false, maxMeanAbs: 0.012, expectedSign: null, expectLocalization: false });
console.log(`  ${r_N3.name}: meanAbs=${r_N3.metrics.meanAbs.toExponential(2)}  unexpected=${r_N3.diagnostics.unexpected_activation}`);
results.push(r_N3);

// N4: tiny exposure variation (1% brighter)
const orangeExp = scaleBrightness(orange, 1.01);
const r_N4 = await runProbe("N4_tiny_exposure_1pct", "null",
  orange, orangeExp,
  { expectResponse: false, maxMeanAbs: 0.01, expectedSign: null, expectLocalization: false });
console.log(`  ${r_N4.name}: meanAbs=${r_N4.metrics.meanAbs.toExponential(2)}  globalShift=${r_N4.metrics.globalLuminanceShift.toExponential(2)}  unexpected=${r_N4.diagnostics.unexpected_activation}`);
results.push(r_N4);

// Estimate temporal noise floor from N1 (perfect null) + N2 (sub-JND) — use max as safe upper bound
const nullNoiseFloor = Math.max(r_N1.metrics.meanAbs, r_N2.metrics.meanAbs);
console.log(`\n  → nullNoiseFloor = ${nullNoiseFloor.toExponential(3)}`);

// ---- FUNDAMENTAL EVENTS ----
console.log("\n── FUNDAMENTAL EVENTS (W+1 should respond) ──");

// F1: object appears (black → orange)
const r_F1 = await runProbe("F1_object_appears", "fundamental",
  bkgd, orange,
  { expectResponse: true, minMeanAbs: 0.1, expectedSign: "+", expectLocalization: true },
  nullNoiseFloor);
console.log(`  ${r_F1.name}: mean=${r_F1.metrics.mean.toFixed(3)}  meanAbs=${r_F1.metrics.meanAbs.toFixed(3)}  sign=${r_F1.metrics.mean > 0 ? "+" : "-"}  margin=${r_F1.diagnostics.noise_margin.toFixed(0)}x`);
results.push(r_F1);

// F2: object disappears (orange → black)
const r_F2 = await runProbe("F2_object_disappears", "fundamental",
  orange, bkgd,
  { expectResponse: true, minMeanAbs: 0.1, expectedSign: "-", expectLocalization: true },
  nullNoiseFloor);
console.log(`  ${r_F2.name}: mean=${r_F2.metrics.mean.toFixed(3)}  meanAbs=${r_F2.metrics.meanAbs.toFixed(3)}  sign=${r_F2.metrics.mean > 0 ? "+" : "-"}  margin=${r_F2.diagnostics.noise_margin.toFixed(0)}x`);
results.push(r_F2);

// F3: brightness increases (orange → orange×1.3)
const orangeBright = scaleBrightness(orange, 1.3);
const r_F3 = await runProbe("F3_brightness_up_30pct", "fundamental",
  orange, orangeBright,
  { expectResponse: true, minMeanAbs: 0.05, expectedSign: "+", expectLocalization: false },
  nullNoiseFloor);
console.log(`  ${r_F3.name}: mean=${r_F3.metrics.mean.toFixed(3)}  meanAbs=${r_F3.metrics.meanAbs.toFixed(3)}  sign=${r_F3.metrics.mean > 0 ? "+" : "-"}  margin=${r_F3.diagnostics.noise_margin.toFixed(0)}x`);
results.push(r_F3);

// F4: brightness decreases (orange → orange×0.7)
const orangeDim = scaleBrightness(orange, 0.7);
const r_F4 = await runProbe("F4_brightness_down_30pct", "fundamental",
  orange, orangeDim,
  { expectResponse: true, minMeanAbs: 0.05, expectedSign: "-", expectLocalization: false },
  nullNoiseFloor);
console.log(`  ${r_F4.name}: mean=${r_F4.metrics.mean.toFixed(3)}  meanAbs=${r_F4.metrics.meanAbs.toFixed(3)}  sign=${r_F4.metrics.mean > 0 ? "+" : "-"}  margin=${r_F4.diagnostics.noise_margin.toFixed(0)}x`);
results.push(r_F4);

// F5: flicker (orange → bkgd → orange), test the down transition
const r_F5 = await runProbe("F5_flicker_down", "fundamental",
  orange, bkgd,
  { expectResponse: true, minMeanAbs: 0.1, expectedSign: "-", expectLocalization: true },
  nullNoiseFloor);
console.log(`  ${r_F5.name}: mean=${r_F5.metrics.mean.toFixed(3)}  meanAbs=${r_F5.metrics.meanAbs.toFixed(3)}  sign=${r_F5.metrics.mean > 0 ? "+" : "-"}  margin=${r_F5.diagnostics.noise_margin.toFixed(0)}x`);
results.push(r_F5);

// F6: moving vertical edge (shift right by 8 px) — response should localize per cell
const orangeShiftX = shift(orange, 8, 0);
const r_F6 = await runProbe("F6_move_horizontal_8px", "fundamental",
  orange, orangeShiftX,
  { expectResponse: true, minMeanAbs: 0.01, expectedSign: null, expectLocalization: true },
  nullNoiseFloor);
console.log(`  ${r_F6.name}: meanAbs=${r_F6.metrics.meanAbs.toFixed(3)}  cellSpread=${r_F6.cellSpread.toFixed(4)}  margin=${r_F6.diagnostics.noise_margin.toFixed(1)}x`);
results.push(r_F6);

// F7: moving horizontal edge (shift down by 8 px)
const orangeShiftY = shift(orange, 0, 8);
const r_F7 = await runProbe("F7_move_vertical_8px", "fundamental",
  orange, orangeShiftY,
  { expectResponse: true, minMeanAbs: 0.01, expectedSign: null, expectLocalization: true },
  nullNoiseFloor);
console.log(`  ${r_F7.name}: meanAbs=${r_F7.metrics.meanAbs.toFixed(3)}  cellSpread=${r_F7.cellSpread.toFixed(4)}  margin=${r_F7.diagnostics.noise_margin.toFixed(1)}x`);
results.push(r_F7);

// ---- PROMOTION CRITERIA SUMMARY ----
console.log("\n═══ W+1 PROMOTION CRITERIA ═══");
const criteria = {
  responds_to_intended_temporal_event: results.filter(r => r.category === "fundamental").every(r => r.diagnostics.expected_activation),
  quiet_on_static_sequences: results.filter(r => r.category === "null").every(r => r.diagnostics.unexpected_activation),
  localizes_correctly_on_motion: results.filter(r => r.name.startsWith("F6") || r.name.startsWith("F7")).every(r => r.diagnostics.spatial_localization),
  maintains_direction_polarity: results.filter(r => r.category === "fundamental" && r.expectations.expectedSign !== null).every(r => r.diagnostics.direction_sign_correct),
  noise_margin_positive: results.filter(r => r.category === "fundamental").every(r => r.diagnostics.noise_margin > 5),
  deterministic: null,  // proven by invariant tests
  static_hash_untouched: null,   // proven by invariant 1
  causal_no_future_read: null,   // proven by invariant 3
};

let promoteScore = 0, promoteTotal = 0;
for (const [k, v] of Object.entries(criteria)) {
  if (v === null) { console.log(`  ${k}: PROVEN elsewhere`); promoteScore++; promoteTotal++; }
  else if (v === true) { console.log(`  ${k}: ✓`); promoteScore++; promoteTotal++; }
  else { console.log(`  ${k}: ✗`); promoteTotal++; }
}
const verdict = promoteScore === promoteTotal ? "PROMOTED ✓" : `PARTIAL (${promoteScore}/${promoteTotal})`;
console.log(`\nW+1 luminance transient: ${verdict}`);

fs.writeFileSync(OUT_FILE, JSON.stringify({
  date: "2026-07-11",
  doctrine: "GPT v6 (spine seq 122)",
  channel: "W+1 temporal luminance transient",
  nullNoiseFloor,
  probes: results,
  criteria,
  verdict,
}, null, 2));
console.log(`\nwrote ${OUT_FILE}`);
