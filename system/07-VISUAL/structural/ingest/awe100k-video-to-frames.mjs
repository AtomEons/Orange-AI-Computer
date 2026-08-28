#!/usr/bin/env bun
// awe100k-video-to-frames.mjs — extract frames from all captured videos.
//
// Reads C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-100k/{object}/*.mp4
// Extracts ~1000 frames per video via ffmpeg at ~30fps into the same dir as
// jpg (compact, sufficient fidelity, fast to re-decode).
// Idempotent: skips objects whose frame count already matches target.

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = "C:/AtomEons/Orange5/07-VISUAL/fixtures/capture-100k";
const FRAMES_PER_VIDEO = 1000;
const FRAME_SIZE = 384;

async function ffmpegExtract(videoPath, outDir, count, size) {
  return new Promise((resolve, reject) => {
    const args = [
      "-y", "-nostats", "-loglevel", "error",
      "-i", videoPath,
      "-vf", `scale='if(gt(iw,ih),${size},-1)':'if(gt(iw,ih),-1,${size})',fps=${count}/60`,
      "-vframes", String(count),
      path.join(outDir, "frame_%05d.jpg"),
    ];
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", d => err += d.toString());
    p.on("close", code => code === 0 ? resolve() : reject(new Error("ffmpeg exit " + code + ": " + err)));
    p.on("error", reject);
  });
}

if (!fs.existsSync(ROOT)) {
  console.log("no capture-100k dir yet — nothing to extract");
  console.log("expected: " + ROOT);
  process.exit(0);
}

const objects = fs.readdirSync(ROOT, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
console.log("objects on disk: " + objects.length);

let totalFrames = 0, totalSkipped = 0, totalErrors = 0;
for (const obj of objects) {
  const dir = path.join(ROOT, obj);
  const videos = fs.readdirSync(dir).filter(f => /\.(mp4|mkv|webm|mov)$/i.test(f)).sort();
  const framesDir = path.join(dir, "frames");
  fs.mkdirSync(framesDir, { recursive: true });
  const existingFrames = fs.readdirSync(framesDir).filter(f => /^frame_\d+\.jpg$/.test(f)).length;
  if (existingFrames >= FRAMES_PER_VIDEO * videos.length) {
    console.log("  [skip] " + obj + " — " + existingFrames + " frames already present");
    totalSkipped++;
    continue;
  }
  for (const v of videos) {
    try {
      await ffmpegExtract(path.join(dir, v), framesDir, FRAMES_PER_VIDEO, FRAME_SIZE);
      const now = fs.readdirSync(framesDir).filter(f => /^frame_\d+\.jpg$/.test(f)).length;
      console.log("  [ok]   " + obj + "/" + v + " → " + (now - existingFrames) + " frames");
      totalFrames += (now - existingFrames);
    } catch (e) {
      console.log("  [err]  " + obj + "/" + v + " — " + e.message.split("\n")[0]);
      totalErrors++;
    }
  }
}
console.log("\nTOTAL extracted: " + totalFrames + " new frames · skipped: " + totalSkipped + " objects · errors: " + totalErrors);
