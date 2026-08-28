#!/usr/bin/env bun
// phase-a-t-full-qualification.mjs — full W+1/W+2/W+3 qualification.
// GPT doctrine v7 (spine seq 125): null + fundamental + 12 confound probes.
//
// Purpose per GPT: the confound bank is NOT to make W+1 quiet. W+1 must report
// all real luminance changes. Purpose is to preserve enough spatial/global
// evidence so downstream can distinguish motion / exposure / lighting / flicker.
//
// W+2 must activate on positive events, be quiet on pure negative events (apart from noise).
// W+3 must activate on negative events, be quiet on pure positive events.
// Both must localize and preserve v1.0 static hash + W+1 output.

import fs from "node:fs";
import { extractImageRGB } from "./prism.mjs";
import { computeLuminanceTransient } from "./temporal-luminance-w1.mjs";
import { computeOnEvents, computeOffEvents } from "./temporal-on-off-w2-w3.mjs";
import { hashField } from "./axis-tap.mjs";

const OUT_FILE = "C:/AtomEons/Orange5/07-VISUAL/ten-k-x-100/results/phase_a_t_full_qualification.json";

// ---- Frame synthesis helpers ----
function copyFrame(rgb) {
  return { R: new Float32Array(rgb.R), G: new Float32Array(rgb.G), B: new Float32Array(rgb.B),
           width: rgb.width, height: rgb.height };
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
function applyGamma(rgb, gamma) {
  const out = copyFrame(rgb);
  for (let i = 0; i < out.R.length; i++) {
    out.R[i] = Math.pow(rgb.R[i], gamma);
    out.G[i] = Math.pow(rgb.G[i], gamma);
    out.B[i] = Math.pow(rgb.B[i], gamma);
  }
  return out;
}
function whiteBalanceShift(rgb, rGain, gGain, bGain) {
  const out = copyFrame(rgb);
  for (let i = 0; i < out.R.length; i++) {
    out.R[i] = Math.min(1, Math.max(0, rgb.R[i] * rGain));
    out.G[i] = Math.min(1, Math.max(0, rgb.G[i] * gGain));
    out.B[i] = Math.min(1, Math.max(0, rgb.B[i] * bGain));
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
function shift(rgb, dx, dy) {
  const out = blackFrame(rgb.width, rgb.height);
  const w = rgb.width, h = rgb.height;
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
// Light sweep: linear brightness ramp across x axis
function lightSweep(rgb, phase) {
  const out = copyFrame(rgb);
  const w = rgb.width, h = rgb.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // sweep is a moving Gaussian bright bar
      const center = phase * w;
      const gauss = Math.exp(-((x - center) ** 2) / (2 * (w / 8) ** 2));
      const gain = 1.0 + 0.3 * gauss;
      const i = y * w + x;
      out.R[i] = Math.min(1, rgb.R[i] * gain);
      out.G[i] = Math.min(1, rgb.G[i] * gain);
      out.B[i] = Math.min(1, rgb.B[i] * gain);
    }
  }
  return out;
}
// Hard shadow: darken a rectangular band that moves horizontally
function hardShadowMove(rgb, phase) {
  const out = copyFrame(rgb);
  const w = rgb.width, h = rgb.height;
  const bandW = Math.floor(w / 4);
  const bandStart = Math.floor(phase * (w - bandW));
  for (let y = 0; y < h; y++) {
    for (let x = bandStart; x < bandStart + bandW; x++) {
      const i = y * w + x;
      out.R[i] = rgb.R[i] * 0.4;
      out.G[i] = rgb.G[i] * 0.4;
      out.B[i] = rgb.B[i] * 0.4;
    }
  }
  return out;
}
// Local object appears: paste orange into a small region of black background
function localObjectAppear(rgb, targetX, targetY, size, exposure = 1.0) {
  const w = rgb.width, h = rgb.height;
  const out = blackFrame(w, h);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const dstX = targetX + x, dstY = targetY + y;
      if (dstX < 0 || dstX >= w || dstY < 0 || dstY >= h) continue;
      const srcX = Math.floor(x * rgb.width / size);
      const srcY = Math.floor(y * rgb.height / size);
      const src = srcY * rgb.width + srcX;
      const dst = dstY * w + dstX;
      out.R[dst] = rgb.R[src] * exposure;
      out.G[dst] = rgb.G[src] * exposure;
      out.B[dst] = rgb.B[src] * exposure;
    }
  }
  return out;
}

// ---- Runner ----
function runProbe(name, category, prev, curr, expectations) {
  const w1 = computeLuminanceTransient(prev, curr);
  if (!w1.valid) return { name, category, error: w1.reason };
  const w2 = computeOnEvents(w1, prev.width);
  const w3 = computeOffEvents(w1, prev.width);
  return {
    name, category, expectations,
    w1: {
      signedMean: w1.signedMean,
      meanAbsolute: w1.meanAbsolute,
      globality: w1.globality,
      activeFraction: w1.activeFraction,
      borderActivity: w1.borderActivity,
      connectedRegionCount: w1.connectedRegionCount,
      positiveEnergy: w1.positiveEnergy,
      negativeEnergy: w1.negativeEnergy,
      spatialCentroid: w1.spatialCentroid,
      probable_global_exposure_shift: w1.interpretation.probable_global_exposure_shift,
      probable_local_motion: w1.interpretation.probable_local_motion,
      probable_border_dominant_camera_motion: w1.interpretation.probable_border_dominant_camera_motion,
    },
    w2: { mean: w2.mean, energy: w2.energy, activeFraction: w2.activeFraction,
          connectedRegionCount: w2.connectedRegionCount, borderActivity: w2.borderActivity,
          centroid: w2.spatialCentroid },
    w3: { mean: w3.mean, energy: w3.energy, activeFraction: w3.activeFraction,
          connectedRegionCount: w3.connectedRegionCount, borderActivity: w3.borderActivity,
          centroid: w3.spatialCentroid },
  };
}

const orange = await extractImageRGB("C:/AtomEons/Orange5/07-VISUAL/fixtures/orange.jpg", { maxSize: 384 });
const { width: w, height: h } = orange;
const bkgd = blackFrame(w, h);

const results = [];

console.log("── NULL CONTROLS (W+1/W+2/W+3 should all be quiet) ──");
results.push(runProbe("N1_identical_triplet", "null", orange, orange, { expectQuiet: true }));
results.push(runProbe("N2_subJND_noise", "null", subJndNoise(orange, 1), subJndNoise(orange, 2), { expectQuiet: true }));
results.push(runProbe("N3_jpeg_block_noise", "null", jpegLikeNoise(orange, 1), jpegLikeNoise(orange, 2), { expectQuiet: true }));
results.push(runProbe("N4_tiny_exposure_1pct", "null", orange, scaleBrightness(orange, 1.01), { expectQuiet: true }));
for (const r of results.slice(-4)) console.log(`  ${r.name}: W1|Δ|=${r.w1.meanAbsolute.toExponential(2)} W2E=${r.w2.energy.toExponential(2)} W3E=${r.w3.energy.toExponential(2)} G=${r.w1.globality.toFixed(2)}`);

console.log("\n── FUNDAMENTAL EVENTS ──");
results.push(runProbe("F1_object_appears", "fundamental", bkgd, orange, { expect: "positive", expectW2: true, expectW3: false }));
results.push(runProbe("F2_object_disappears", "fundamental", orange, bkgd, { expect: "negative", expectW2: false, expectW3: true }));
results.push(runProbe("F3_brightness_up_30pct", "fundamental", orange, scaleBrightness(orange, 1.3), { expect: "positive", expectW2: true, expectW3: false }));
results.push(runProbe("F4_brightness_down_30pct", "fundamental", orange, scaleBrightness(orange, 0.7), { expect: "negative", expectW2: false, expectW3: true }));
results.push(runProbe("F6_move_horizontal_8px", "fundamental", orange, shift(orange, 8, 0), { expect: "balanced", expectW2: true, expectW3: true }));
results.push(runProbe("F7_move_vertical_8px", "fundamental", orange, shift(orange, 0, 8), { expect: "balanced", expectW2: true, expectW3: true }));
for (const r of results.slice(-6)) console.log(`  ${r.name}: W1 mean=${r.w1.signedMean.toFixed(3)} G=${r.w1.globality.toFixed(2)} | W2E=${r.w2.energy.toFixed(1)} | W3E=${r.w3.energy.toFixed(1)}`);

console.log("\n── CONFOUND PROBES (spatial evidence must persist) ──");
// C1/C2: whole-frame exposure — expect high globality
results.push(runProbe("C1_wholeFrame_exposure_up_30pct", "confound", orange, scaleBrightness(orange, 1.3), { probable: "global_exposure" }));
results.push(runProbe("C2_wholeFrame_exposure_down_30pct", "confound", orange, scaleBrightness(orange, 0.7), { probable: "global_exposure" }));
results.push(runProbe("C3_gamma_shift", "confound", orange, applyGamma(orange, 1.4), { probable: "global_gamma" }));
results.push(runProbe("C4_white_balance_shift", "confound", orange, whiteBalanceShift(orange, 1.1, 1.0, 0.9), { probable: "global_wb" }));
results.push(runProbe("C5_light_sweep", "confound", lightSweep(orange, 0.3), lightSweep(orange, 0.5), { probable: "moving_light_on_static_object" }));
results.push(runProbe("C6_hard_shadow_moves", "confound", hardShadowMove(orange, 0.2), hardShadowMove(orange, 0.5), { probable: "moving_shadow_on_static_object" }));
results.push(runProbe("C7_camera_translation", "confound", orange, shift(orange, 12, 0), { probable: "camera_translation_high_border" }));
results.push(runProbe("C8_object_translation", "confound", bkgd, shift(orange, 20, 20), { probable: "object_translation" }));
results.push(runProbe("C9_camera_and_object_together", "confound", shift(orange, 4, 0), shift(orange, 12, 0), { probable: "translation" }));
results.push(runProbe("C10_local_object_appears", "confound", bkgd, localObjectAppear(orange, 100, 100, 128), { probable: "local_positive_event" }));
results.push(runProbe("C11_local_object_disappears", "confound", localObjectAppear(orange, 100, 100, 128), bkgd, { probable: "local_negative_event" }));
results.push(runProbe("C12_codec_noise", "confound", jpegLikeNoise(orange, 3), jpegLikeNoise(orange, 4), { probable: "codec_noise_below_floor" }));
for (const r of results.slice(-12)) {
  console.log(`  ${r.name}: W1 |Δ|=${r.w1.meanAbsolute.toFixed(3)} G=${r.w1.globality.toFixed(2)} borderAct=${r.w1.borderActivity.toFixed(2)} regions=${r.w1.connectedRegionCount} | W2E=${r.w2.energy.toFixed(1)} W3E=${r.w3.energy.toFixed(1)}`);
}

// ---- Promotion checks ----
console.log("\n═══ W+2 ACCEPTANCE ═══");
const w2Checks = {
  activates_on_appearance: results.find(r => r.name === "F1_object_appears").w2.mean > 0.05,
  activates_on_brightening: results.find(r => r.name === "F3_brightness_up_30pct").w2.mean > 0.05,
  quiet_on_pure_disappearance: results.find(r => r.name === "F2_object_disappears").w2.mean < 0.005,
  quiet_on_pure_darkening: results.find(r => r.name === "F4_brightness_down_30pct").w2.mean < 0.005,
  localizes_local_positive: results.find(r => r.name === "C10_local_object_appears").w2.centroid.x !== null,
  distinguishes_global_via_metadata: results.find(r => r.name === "C1_wholeFrame_exposure_up_30pct").w1.globality > 0.7,
  quiet_on_true_null_controls_below_JND: results.filter(r => r.name === "N1_identical_triplet" || r.name === "N2_subJND_noise" || r.name === "N3_jpeg_block_noise").every(r => r.w2.mean < 0.005),
};
let w2Pass = 0, w2Total = 0;
for (const [k, v] of Object.entries(w2Checks)) {
  const tag = v ? "✓" : "✗"; console.log(`  ${tag} ${k}`);
  w2Total++; if (v) w2Pass++;
}

console.log("\n═══ W+3 ACCEPTANCE ═══");
const w3Checks = {
  activates_on_disappearance: results.find(r => r.name === "F2_object_disappears").w3.mean > 0.05,
  activates_on_darkening: results.find(r => r.name === "F4_brightness_down_30pct").w3.mean > 0.05,
  quiet_on_pure_appearance: results.find(r => r.name === "F1_object_appears").w3.mean < 0.005,
  quiet_on_pure_brightening: results.find(r => r.name === "F3_brightness_up_30pct").w3.mean < 0.005,
  localizes_local_negative: results.find(r => r.name === "C11_local_object_disappears").w3.centroid.x !== null,
  distinguishes_global_via_metadata: results.find(r => r.name === "C2_wholeFrame_exposure_down_30pct").w1.globality > 0.7,
  quiet_on_true_null_controls_below_JND: results.filter(r => r.name === "N1_identical_triplet" || r.name === "N2_subJND_noise" || r.name === "N3_jpeg_block_noise").every(r => r.w3.mean < 0.005),
};
let w3Pass = 0, w3Total = 0;
for (const [k, v] of Object.entries(w3Checks)) {
  const tag = v ? "✓" : "✗"; console.log(`  ${tag} ${k}`);
  w3Total++; if (v) w3Pass++;
}

console.log("\n═══ CONFOUND-SEPARATION EVIDENCE (spatial metadata) ═══");
const c1 = results.find(r => r.name === "C1_wholeFrame_exposure_up_30pct");
const c7 = results.find(r => r.name === "C7_camera_translation");
const c10 = results.find(r => r.name === "C10_local_object_appears");
console.log(`  global exposure (C1): globality=${c1.w1.globality.toFixed(2)} borderActivity=${c1.w1.borderActivity.toFixed(2)} regions=${c1.w1.connectedRegionCount}`);
console.log(`  camera translation (C7): globality=${c7.w1.globality.toFixed(2)} borderActivity=${c7.w1.borderActivity.toFixed(2)} regions=${c7.w1.connectedRegionCount}`);
console.log(`  local appear (C10): globality=${c10.w1.globality.toFixed(2)} borderActivity=${c10.w1.borderActivity.toFixed(2)} regions=${c10.w1.connectedRegionCount}`);
const confoundSeparable = c1.w1.globality > c7.w1.globality && c7.w1.borderActivity > c10.w1.borderActivity;
console.log(`  ${confoundSeparable ? "✓" : "✗"} spatial evidence distinguishes global_exposure vs camera_motion vs local_event`);

console.log(`\nW+2 acceptance: ${w2Pass}/${w2Total}   W+3 acceptance: ${w3Pass}/${w3Total}   Confound separation: ${confoundSeparable ? "PASS" : "FAIL"}`);

fs.writeFileSync(OUT_FILE, JSON.stringify({
  date: "2026-07-11",
  doctrine: "GPT v7 (spine seq 125)",
  channels: ["W+1 luminance (v1.1 extended)", "W+2 ON", "W+3 OFF"],
  probes: results,
  w2_acceptance: w2Checks,
  w3_acceptance: w3Checks,
  confound_separable: confoundSeparable,
  verdict: {
    w2: w2Pass === w2Total ? "PROMOTED" : `PARTIAL ${w2Pass}/${w2Total}`,
    w3: w3Pass === w3Total ? "PROMOTED" : `PARTIAL ${w3Pass}/${w3Total}`,
    confound: confoundSeparable ? "PASS" : "FAIL",
  },
}, null, 2));
console.log(`\nwrote ${OUT_FILE}`);
