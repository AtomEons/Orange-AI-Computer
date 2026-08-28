#!/usr/bin/env bun
// Synthesize "baby watches an X" videos from still fixtures.
//
// Since we don't have a fruit-cinema library, we build synthetic clips
// from single stills using ffmpeg. The simulation adds:
//   - crop-based pan (baby's head shifting)
//   - hue/brightness drift (lighting shifts as baby's eyes adapt)
//   - rotate (baby tilts head)
//
// Each clip: 3 seconds @ 15 fps = 45 frames, 384x384.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(__dir, "..", "..", "fixtures");
const OUT = path.join(FIXTURES, "baby-cinema");
fs.mkdirSync(OUT, { recursive: true });

const CLIPS = [
  { name: "baby-watches-orange", still: "orange.jpg" },
  { name: "baby-watches-apple",  still: "apple.jpg"  },
];

const DURATION = 3;
const FPS = 15;

for (const clip of CLIPS) {
  const stillPath = path.join(FIXTURES, clip.still);
  const outPath = path.join(OUT, `${clip.name}.mp4`);

  // Filter chain — preserve original wide-shot perspective; augment only
  // with tiny rotate + tiny hue drift. NO zoom, NO crop-based close-up
  // (that was distribution-shifting training away from natural stills).
  //   1. Scale to 384x384 (matches test-side extraction)
  //   2. Tiny rotate (head tilt within a few degrees)
  //   3. Very subtle brightness drift (lighting flicker)
  const vf = [
    "scale=384:384",
    "rotate=0.02*sin(2*PI*t/4):c=none:ow=iw:oh=ih",
    "hue=b=0.02*sin(2*PI*t/2.5)",
  ].join(",");

  const proc = Bun.spawnSync({
    cmd: [
      "ffmpeg", "-y", "-loglevel", "error",
      "-loop", "1", "-t", String(DURATION), "-r", String(FPS),
      "-i", stillPath,
      "-vf", vf,
      "-c:v", "libx264", "-pix_fmt", "yuv420p",
      outPath,
    ],
  });

  if (proc.exitCode !== 0) {
    console.error(`FAILED to synthesize ${clip.name}:`, new TextDecoder().decode(proc.stderr));
    process.exit(1);
  }
  const stat = fs.statSync(outPath);
  console.log(`  ${clip.name}.mp4 — ${(stat.size / 1024).toFixed(1)} KB, ${DURATION}s @ ${FPS}fps → ${DURATION * FPS} frames`);
}

console.log(`\nSynthesized ${CLIPS.length} clips at ${OUT}`);
