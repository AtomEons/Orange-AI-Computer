// render-perception.mjs — take any input frame, render what the eye SEES.
//
// Alpha Wolf Eyes IS the eye. Every canonical layer is a visual percept:
//   reflectance_map    → color perception
//   opponent_map       → chromatic opponency (LGN input)
//   retinal_map        → 4 sustained retinal channels (ON/OFF/edge/uniformity)
//   depth_map          → surface tilt (shape-from-shading)
//   multiscale_edges   → parasol/midget/fine receptive-field responses
//   saliency_map       → where the eye would fixate
//
// This module renders each of these as a PNG the operator can LOOK AT.
// No training. No templates. Perfect eyes — 20:20 acuity means the eye
// carries the perceptual signal with fidelity. You verify it by SEEING
// what the eye sees.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { CANON_W, CANON_H } from "./photon-canonical.mjs";

function normalize(field) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < field.length; i++) {
    const v = field[i];
    if (!Number.isFinite(v)) continue;
    if (v < mn) mn = v;
    if (v > mx) mx = v;
  }
  const range = mx - mn || 1;
  const out = new Uint8Array(field.length);
  for (let i = 0; i < field.length; i++) {
    const v = Number.isFinite(field[i]) ? field[i] : mn;
    out[i] = Math.max(0, Math.min(255, Math.round((v - mn) / range * 255)));
  }
  return out;
}

// Write a raw RGB Uint8 buffer as PNG via ffmpeg
async function writePNG(pixels, w, h, outPath) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-y", "-loglevel", "error",
      "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", `${w}x${h}`,
      "-i", "-",
      outPath,
    ]);
    p.on("close", code => code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code)));
    p.on("error", reject);
    p.stdin.write(Buffer.from(pixels));
    p.stdin.end();
  });
}

// Convert a single-channel field (W*H grayscale) to an RGB byte buffer
function grayToRGB(field) {
  const N = field.length;
  const out = new Uint8Array(N * 3);
  for (let i = 0; i < N; i++) {
    out[i * 3 + 0] = field[i];
    out[i * 3 + 1] = field[i];
    out[i * 3 + 2] = field[i];
  }
  return out;
}

// Convert a 3-channel packed field (W*H*3) to RGB byte buffer with per-channel normalize
function rgb3ToRGB(field, count) {
  const R = new Float32Array(count), G = new Float32Array(count), B = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    R[i] = field[i * 3 + 0];
    G[i] = field[i * 3 + 1];
    B[i] = field[i * 3 + 2];
  }
  const rN = normalize(R), gN = normalize(G), bN = normalize(B);
  const out = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3 + 0] = rN[i]; out[i * 3 + 1] = gN[i]; out[i * 3 + 2] = bN[i];
  }
  return out;
}

// Convert a 4-channel packed field (rgba/or ch1-ch4) to RGB by picking first 3
function rgb4ToRGB(field, count) {
  const R = new Float32Array(count), G = new Float32Array(count), B = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    R[i] = field[i * 4 + 0]; G[i] = field[i * 4 + 1]; B[i] = field[i * 4 + 2];
  }
  const rN = normalize(R), gN = normalize(G), bN = normalize(B);
  const out = new Uint8Array(count * 3);
  for (let i = 0; i < count; i++) {
    out[i * 3 + 0] = rN[i]; out[i * 3 + 1] = gN[i]; out[i * 3 + 2] = bN[i];
  }
  return out;
}

/**
 * renderCanonicalPerception(canonical, outDir)
 * Writes one PNG per perception layer into outDir.
 * Files written:
 *   00_reflectance.png — perceived body color (illumination-corrected)
 *   01_opponent_Y.png  — luminance channel (L+M+S)
 *   02_opponent_RG.png — red-green opponent channel
 *   03_opponent_BY.png — blue-yellow opponent channel
 *   04_retinal_ON_sustained.png
 *   05_retinal_OFF_sustained.png
 *   06_retinal_local_edge.png
 *   07_retinal_uniformity.png
 *   08_depth_normal_x.png — surface tilt X
 *   09_depth_normal_y.png — surface tilt Y
 *   10_depth_normal_z.png — surface facing (toward camera)
 *   11_edges_fine.png     — parasol-fine receptive field
 *   12_edges_mid.png      — midget receptive field
 *   13_edges_coarse.png   — coarse receptive field
 *   14_saliency.png       — attention (where the eye would fixate)
 */
export async function renderCanonicalPerception(canonical, outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  const W = CANON_W, H = CANON_H;
  const N = W * H;
  const jobs = [];

  // Reflectance — first 3 channels of RGBA
  jobs.push(writePNG(rgb4ToRGB(canonical.reflectance_map, N), W, H, path.join(outDir, "00_reflectance.png")));

  // Opponent Y, RG, BY (single-channel each, gray-mapped)
  const oppY = new Float32Array(N), oppRG = new Float32Array(N), oppBY = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    oppY[i] = canonical.opponent_map[i * 3 + 0];
    oppRG[i] = canonical.opponent_map[i * 3 + 1];
    oppBY[i] = canonical.opponent_map[i * 3 + 2];
  }
  jobs.push(writePNG(grayToRGB(normalize(oppY)), W, H, path.join(outDir, "01_opponent_Y.png")));
  jobs.push(writePNG(grayToRGB(normalize(oppRG)), W, H, path.join(outDir, "02_opponent_RG.png")));
  jobs.push(writePNG(grayToRGB(normalize(oppBY)), W, H, path.join(outDir, "03_opponent_BY.png")));

  // Retinal 4 channels
  const retChans = ["ON_sustained", "OFF_sustained", "local_edge", "uniformity"];
  for (let c = 0; c < 4; c++) {
    const ch = new Float32Array(N);
    for (let i = 0; i < N; i++) ch[i] = canonical.retinal_map[i * 4 + c];
    jobs.push(writePNG(grayToRGB(normalize(ch)), W, H, path.join(outDir, `${String(4+c).padStart(2, '0')}_retinal_${retChans[c]}.png`)));
  }

  // Depth normals (3 channels)
  const depthChans = ["normal_x", "normal_y", "normal_z"];
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(N);
    for (let i = 0; i < N; i++) ch[i] = canonical.depth_map[i * 3 + c];
    jobs.push(writePNG(grayToRGB(normalize(ch)), W, H, path.join(outDir, `${String(8+c).padStart(2, '0')}_depth_${depthChans[c]}.png`)));
  }

  // Multi-scale edges (3 scales)
  const scaleChans = ["fine", "mid", "coarse"];
  for (let c = 0; c < 3; c++) {
    const ch = new Float32Array(N);
    for (let i = 0; i < N; i++) ch[i] = canonical.multiscale_edges[i * 3 + c];
    jobs.push(writePNG(grayToRGB(normalize(ch)), W, H, path.join(outDir, `${String(11+c).padStart(2, '0')}_edges_${scaleChans[c]}.png`)));
  }

  // Saliency (single channel already in [0,1])
  const sal = new Uint8Array(N);
  for (let i = 0; i < N; i++) sal[i] = Math.round(canonical.saliency_map[i] * 255);
  jobs.push(writePNG(grayToRGB(sal), W, H, path.join(outDir, "14_saliency.png")));

  await Promise.all(jobs);
  return jobs.length;
}
