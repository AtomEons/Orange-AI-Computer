// 07-VISUAL/structural/luminance-ffmpeg.mjs
//
// ffmpeg-backed luminance extraction for the retinal transform.
// Takes an encoded input (path or bytes) and emits a raw grayscale plane
// (Uint8Array) plus {width, height, frames}. Deterministic. No paid deps.
//
// Anti-drift:
//   - We do NOT depend on sharp/jimp/etc. The retinal transform's contract
//     is that its input is a pre-decoded luminance plane. This module is
//     ONLY the encoded-input helper used by the gateway route.
//   - If ffmpeg is missing, we return an explicit sentinel — callers decide
//     whether to error or degrade.
//   - Single-frame decode via `-frames:v 1`; sequences via `-vf fps=<hz>`.
//   - Output pixel format is `gray` (Y-plane only) so the caller gets one
//     byte per pixel with no channel unpacking.

import { spawn } from "node:child_process";
import { writeFile, unlink, mkdtemp, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

export const FFMPEG_BIN = process.env.ORANGE5_FFMPEG_BIN || "ffmpeg";
export const FFPROBE_BIN = process.env.ORANGE5_FFPROBE_BIN || "ffprobe";

/**
 * Returns { available: boolean, ffmpeg: string, ffprobe: string, reason?: string }.
 * Runs `ffmpeg -version` with a hard timeout so a missing binary can't hang.
 */
export async function checkFfmpeg() {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    try {
      const p = spawn(FFMPEG_BIN, ["-version"], { stdio: ["ignore", "ignore", "ignore"] });
      p.on("error", (e) => finish({
        available: false, ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN,
        reason: `spawn: ${e.message}`,
      }));
      p.on("exit", (code) => finish({
        available: code === 0, ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN,
        reason: code === 0 ? undefined : `exit code ${code}`,
      }));
      setTimeout(() => {
        try { p.kill(); } catch {}
        finish({ available: false, ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN, reason: "timeout" });
      }, 4000);
    } catch (e) {
      finish({ available: false, ffmpeg: FFMPEG_BIN, ffprobe: FFPROBE_BIN, reason: e.message });
    }
  });
}

/**
 * Decode a single image or video first-frame to a grayscale luminance plane.
 * @param {Buffer|string} input   Buffer of encoded bytes, or a path.
 * @param {object} [opts]
 *   opts.maxSize? number         Cap on width/height (default 512).
 * @returns {Promise<{data:Uint8Array,width:number,height:number}>}
 */
export async function extractImageLuminance(input, opts = {}) {
  const maxSize = opts.maxSize | 0 || 512;
  const check = await checkFfmpeg();
  if (!check.available) throw new Error(`ffmpeg unavailable: ${check.reason}`);
  const { path, cleanup } = await materialize(input);
  try {
    // Two-stage: probe to get dims, then decode gray raw. We do the probe
    // implicitly via ffmpeg's -f rawvideo output + a scale filter.
    // 1. Probe original size.
    const size = await probeSize(path);
    let w = size.w, h = size.h;
    if (Math.max(w, h) > maxSize) {
      const s = maxSize / Math.max(w, h);
      w = Math.max(2, Math.round(w * s));
      h = Math.max(2, Math.round(h * s));
    }
    // 2. Decode.
    const raw = await runFfmpegRawGray(path, w, h, { singleFrame: true });
    if (raw.length !== w * h) {
      throw new Error(`ffmpeg raw output length ${raw.length} != ${w}*${h}=${w*h}`);
    }
    return { data: new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength), width: w, height: h };
  } finally {
    await cleanup();
  }
}

/**
 * Decode a short video to a sequence of grayscale frames.
 * @param {Buffer|string} input
 * @param {object} [opts]
 *   opts.fps?      number       Target frame rate (default 5)
 *   opts.maxSize?  number       Cap on width/height (default 256 — sequences are heavier)
 *   opts.maxFrames? number      Hard cap (default 30)
 * @returns {Promise<{frames: Array<{data:Uint8Array, ts_ms:number}>, width:number, height:number, sample_rate_hz:number}>}
 */
export async function extractSequenceLuminance(input, opts = {}) {
  const fps = Number.isFinite(opts.fps) && opts.fps > 0 ? opts.fps : 5;
  const maxSize = opts.maxSize | 0 || 256;
  const maxFrames = opts.maxFrames | 0 || 30;
  const check = await checkFfmpeg();
  if (!check.available) throw new Error(`ffmpeg unavailable: ${check.reason}`);
  const { path, cleanup } = await materialize(input);
  try {
    const size = await probeSize(path);
    let w = size.w, h = size.h;
    if (Math.max(w, h) > maxSize) {
      const s = maxSize / Math.max(w, h);
      w = Math.max(2, Math.round(w * s));
      h = Math.max(2, Math.round(h * s));
    }
    const raw = await runFfmpegRawGray(path, w, h, { fps, maxFrames });
    const frameBytes = w * h;
    const N = Math.floor(raw.length / frameBytes);
    if (N < 1) throw new Error("ffmpeg produced no frames");
    const frames = new Array(N);
    for (let i = 0; i < N; i++) {
      frames[i] = {
        data: new Uint8Array(raw.buffer, raw.byteOffset + i * frameBytes, frameBytes),
        ts_ms: Math.round((i / fps) * 1000),
      };
    }
    return { frames, width: w, height: h, sample_rate_hz: fps };
  } finally {
    await cleanup();
  }
}

// ---- Internals ------------------------------------------------------------

async function materialize(input) {
  if (typeof input === "string") {
    if (!existsSync(input)) throw new Error(`input path does not exist: ${input}`);
    return { path: input, cleanup: async () => {} };
  }
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new Error("input must be a Buffer/Uint8Array or a filesystem path");
  }
  const dir = await mkdtemp(join(tmpdir(), "ae-retinal-"));
  const path = join(dir, "input.bin");
  await writeFile(path, Buffer.isBuffer(input) ? input : Buffer.from(input));
  return {
    path,
    cleanup: async () => { try { await unlink(path); } catch {} },
  };
}

async function probeSize(path) {
  return new Promise((resolve, reject) => {
    const args = [
      "-v", "error",
      "-select_streams", "v:0",
      "-show_entries", "stream=width,height",
      "-of", "csv=p=0",
      path,
    ];
    let out = "";
    let err = "";
    const p = spawn(FFPROBE_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => { out += d.toString(); });
    p.stderr.on("data", (d) => { err += d.toString(); });
    p.on("error", (e) => reject(new Error(`ffprobe spawn: ${e.message}`)));
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exit ${code}: ${err.trim()}`));
      const m = out.trim().split(/[\s,]+/).map((v) => parseInt(v, 10));
      if (m.length < 2 || !m[0] || !m[1]) return reject(new Error(`ffprobe: cannot parse size from "${out.trim()}"`));
      resolve({ w: m[0], h: m[1] });
    });
  });
}

async function runFfmpegRawGray(inputPath, w, h, opts) {
  const args = [
    "-hide_banner", "-loglevel", "error",
    "-i", inputPath,
    "-vf", `scale=${w}:${h}${opts.fps ? `,fps=${opts.fps}` : ""}`,
    "-pix_fmt", "gray",
    "-f", "rawvideo",
  ];
  if (opts.singleFrame) args.push("-frames:v", "1");
  else if (opts.maxFrames) args.push("-frames:v", String(opts.maxFrames));
  args.push("pipe:1");

  return new Promise((resolve, reject) => {
    const chunks = [];
    let stderr = "";
    const p = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "pipe", "pipe"] });
    p.stdout.on("data", (d) => chunks.push(d));
    p.stderr.on("data", (d) => { stderr += d.toString(); });
    p.on("error", (e) => reject(new Error(`ffmpeg spawn: ${e.message}`)));
    p.on("exit", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}: ${stderr.trim()}`));
      resolve(Buffer.concat(chunks));
    });
  });
}
