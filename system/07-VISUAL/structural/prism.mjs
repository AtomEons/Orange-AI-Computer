// 07-VISUAL/structural/prism.mjs
//
// The prism decomposition — the operator we've been missing. Takes RGB input
// (three wavelength-band samples: R ≈ long, G ≈ medium, B ≈ short) and emits
// three physically-motivated axes:
//
//   Achromatic  L  = 0.30*R + 0.59*G + 0.11*B     (Rec.601 photopic luminance)
//   Red-Green   RG = R - G                         (long-vs-medium opponent)
//   Blue-Yellow BY = B - 0.5*(R + G)               (short-vs-long+medium opponent)
//
// These correspond to what V1 receives from the LGN in biological vision. They
// are what the retinal cones + horizontal-cell subtraction produce. Not chased
// from any external doctrine — this is the physically-honest decomposition of
// an RGB signal into the axes biology uses.
//
// Output: three Float32Array channels, each normalized to [-1, 1] for the
// opponent channels and [0, 1] for the achromatic. The four-field pipeline
// (photoreceptor + Sobel + log + motion-corr) can be run on any of them.
//
// Deterministic. Pure JS. Bun. Backend only.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { checkFfmpeg, FFMPEG_BIN, FFPROBE_BIN } from "./luminance-ffmpeg.mjs";

/**
 * Decode an image into three Float32Array channels: R, G, B in [0, 1].
 * Uses ffmpeg to output raw rgb24; parses interleaved bytes into planar channels.
 *
 * @param {string} imgPath
 * @param {object} [opts]
 *   opts.maxSize? number         Cap on width/height (default 512).
 * @returns {Promise<{R:Float32Array, G:Float32Array, B:Float32Array, width:number, height:number}>}
 */
export async function extractImageRGB(imgPath, opts = {}) {
  const maxSize = opts.maxSize | 0 || 512;
  const check = await checkFfmpeg();
  if (!check.available) throw new Error(`ffmpeg unavailable: ${check.reason}`);

  // Probe original size.
  const probe = spawnSync(FFPROBE_BIN, [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height",
    "-of", "csv=p=0",
    imgPath,
  ], { encoding: "utf8" });
  if (probe.status !== 0) throw new Error(`ffprobe failed: ${probe.stderr}`);
  const [origW, origH] = probe.stdout.trim().split(",").map((s) => Number(s));
  let w = origW, h = origH;
  if (Math.max(w, h) > maxSize) {
    const s = maxSize / Math.max(w, h);
    w = Math.max(2, Math.round(w * s));
    h = Math.max(2, Math.round(h * s));
  }

  // Decode to raw rgb24.
  const tmpOut = path.join(os.tmpdir(), `prism-${process.pid}-${Date.now()}.raw`);
  try {
    const proc = spawnSync(FFMPEG_BIN, [
      "-y", "-loglevel", "error",
      "-i", imgPath,
      "-vf", `scale=${w}:${h}`,
      "-frames:v", "1",
      "-pix_fmt", "rgb24",
      "-f", "rawvideo",
      tmpOut,
    ]);
    if (proc.status !== 0) throw new Error(`ffmpeg failed: exit ${proc.status}`);
    const raw = fs.readFileSync(tmpOut);
    if (raw.length !== w * h * 3) {
      throw new Error(`ffmpeg raw length ${raw.length} != ${w}*${h}*3 = ${w * h * 3}`);
    }
    const N = w * h;
    const R = new Float32Array(N);
    const G = new Float32Array(N);
    const B = new Float32Array(N);
    for (let i = 0, j = 0; i < N; i++, j += 3) {
      R[i] = raw[j] / 255;
      G[i] = raw[j + 1] / 255;
      B[i] = raw[j + 2] / 255;
    }
    return { R, G, B, width: w, height: h };
  } finally {
    try { fs.unlinkSync(tmpOut); } catch {}
  }
}

/**
 * The prism decomposition. Takes RGB channels (each 0..1) and emits three
 * physically-motivated axes:
 *   achromatic  A  ∈ [0, 1]       photopic luminance
 *   red-green   RG ∈ [-1, 1]      L - M cone opponent
 *   blue-yellow BY ∈ [-1, 1]      S vs (L+M) opponent
 *
 * @param {Float32Array} R
 * @param {Float32Array} G
 * @param {Float32Array} B
 * @returns {{A:Float32Array, RG:Float32Array, BY:Float32Array, notes:string[]}}
 */
export function prismDecompose(R, G, B) {
  if (R.length !== G.length || G.length !== B.length) {
    throw new Error("prismDecompose: RGB channel lengths must match");
  }
  const N = R.length;
  const A = new Float32Array(N);
  const RG = new Float32Array(N);
  const BY = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    A[i]  = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
    RG[i] = R[i] - G[i];
    BY[i] = B[i] - 0.5 * (R[i] + G[i]);
  }
  return {
    A, RG, BY,
    notes: [
      "prism: achromatic A = 0.30R + 0.59G + 0.11B (Rec.601 luminance)",
      "prism: red-green RG = R - G (long-vs-medium cone opponent)",
      "prism: blue-yellow BY = B - 0.5(R+G) (short-vs-long+medium cone opponent)",
    ],
  };
}

/**
 * Rescale an opponent channel (which can be negative) to unit range [0, 1]
 * for downstream photoreceptor/four-field processing. Preserves relative
 * structure — the shift is data-driven, not a fixed +0.5.
 *
 * @param {Float32Array} X
 * @returns {Float32Array}
 */
export function opponentToUnit(X) {
  let mn = Infinity, mx = -Infinity;
  for (let i = 0; i < X.length; i++) {
    if (X[i] < mn) mn = X[i];
    if (X[i] > mx) mx = X[i];
  }
  const range = mx - mn || 1;
  const out = new Float32Array(X.length);
  for (let i = 0; i < X.length; i++) out[i] = (X[i] - mn) / range;
  return out;
}
