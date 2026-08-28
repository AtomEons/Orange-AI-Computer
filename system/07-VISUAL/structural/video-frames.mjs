// 07-VISUAL/structural/video-frames.mjs
//
// Extract N frames from a video into RGB Float32Array channels.
//
// Uses ffmpeg to sample frames at a target fps or count, writes them to a
// temp dir, then reads each via extractImageRGB (the same path used for
// stills). Deterministic. No RNG. No paid deps.

import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { extractImageRGB } from "./prism.mjs";

/**
 * Extract N frames evenly spaced from a video file.
 *
 * @param {string} videoPath  path to input video
 * @param {object} [opts]
 *   opts.frames  number of frames to sample (default 15)
 *   opts.size    max side length after resize (default 384)
 *   opts.tmpDir  scratch directory (default OS temp)
 * @returns {Promise<Array<{R,G,B,width,height,index,frame_path}>>}
 */
export async function extractVideoFrames(videoPath, opts = {}) {
  const N = opts.frames ?? 15;
  const size = opts.size ?? 384;
  const tmpBase = opts.tmpDir ?? path.join(os.tmpdir(), "aeyes-frames");
  const stamp = path.basename(videoPath, path.extname(videoPath)) + "-" + Date.now();
  const tmpDir = path.join(tmpBase, stamp);
  fs.mkdirSync(tmpDir, { recursive: true });

  // Query duration
  const probe = Bun.spawnSync({
    cmd: [
      "ffprobe", "-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=duration,r_frame_rate,nb_frames",
      "-of", "csv=p=0", videoPath,
    ],
  });
  const probeOut = new TextDecoder().decode(probe.stdout).trim();
  // ffprobe -show_entries output order is fixed by internal enum, not by request:
  // r_frame_rate,duration,nb_frames
  const [, durStr /* fpsStr, , framesStr */] = probeOut.split(",");
  const duration = parseFloat(durStr);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error(`could not probe duration for ${videoPath}: '${probeOut}'`);
  }

  // Evenly spaced timestamps
  const timestamps = [];
  for (let i = 0; i < N; i++) {
    const t = (duration * (i + 0.5)) / N;
    timestamps.push(t);
  }

  // Extract each frame with -ss + -vframes 1
  const framePaths = [];
  for (let i = 0; i < N; i++) {
    const outPath = path.join(tmpDir, `frame_${String(i).padStart(4, "0")}.png`);
    const proc = Bun.spawnSync({
      cmd: [
        "ffmpeg", "-y", "-loglevel", "error",
        "-ss", timestamps[i].toFixed(4),
        "-i", videoPath,
        "-frames:v", "1",
        "-update", "1",
        "-vf", `scale='min(${size},iw)':'min(${size},ih)':force_original_aspect_ratio=decrease`,
        outPath,
      ],
      stdout: "pipe", stderr: "pipe",
    });
    const stderrTxt = proc.stderr ? new TextDecoder().decode(proc.stderr) : "";
    const exists = fs.existsSync(outPath);
    if (proc.exitCode !== 0 || !exists) {
      throw new Error(`frame ${i} (t=${timestamps[i].toFixed(3)}) failed — exit=${proc.exitCode} file_exists=${exists} stderr='${stderrTxt.slice(0, 500)}'`);
    }
    framePaths.push(outPath);
  }

  // Load each frame as RGB
  const frames = [];
  for (let i = 0; i < N; i++) {
    const rgb = await extractImageRGB(framePaths[i], { maxSize: size });
    frames.push({ ...rgb, index: i, frame_path: framePaths[i], t: timestamps[i] });
  }
  return frames;
}

/**
 * Cleanup a temp frame dir. Optional — the OS temp dir gets cleaned anyway.
 */
export function cleanupFrames(tmpDir) {
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
}
