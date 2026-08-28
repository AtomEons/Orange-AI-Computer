#!/usr/bin/env bun
// 07-VISUAL/fixtures/gen-fixtures.mjs
//
// Generates the synthetic H.264 fixtures used by the M2 codec-translator tests.
// Deterministic: same ffmpeg version + same source filter → identical bytes.
// Idempotent: won't overwrite if the fixture already exists at expected size.

import { statSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const FIXTURES = [
  {
    name: "testsrc-2s-320x240.mp4",
    // testsrc2 has a moving pattern → yields inter-frame motion
    args: (out) => [
      "-y", "-f", "lavfi",
      "-i", "testsrc2=size=320x240:rate=15:duration=2",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "15", "-preset", "ultrafast",
      out,
    ],
  },
  {
    name: "cutmix-2s-320x240.mp4",
    // Two color patterns concatenated → forces a scene cut ~1s in
    args: (out) => [
      "-y",
      "-f", "lavfi", "-i", "color=c=red:size=320x240:rate=15:duration=1",
      "-f", "lavfi", "-i", "color=c=blue:size=320x240:rate=15:duration=1",
      "-filter_complex", "[0:v][1:v]concat=n=2:v=1:a=0[v]",
      "-map", "[v]",
      "-c:v", "libx264", "-pix_fmt", "yuv420p", "-g", "30", "-preset", "ultrafast",
      out,
    ],
  },
];

async function main() {
  mkdirSync(HERE, { recursive: true });
  const results = [];
  for (const f of FIXTURES) {
    const out = path.join(HERE, f.name);
    try {
      const st = statSync(out);
      if (st.size > 0) { results.push({ name: f.name, action: "exists", bytes: st.size }); continue; }
    } catch { /* generate */ }

    const proc = Bun.spawn(["ffmpeg", ...f.args(out)], { stdout: "pipe", stderr: "pipe" });
    const err = await new Response(proc.stderr).text();
    const code = await proc.exited;
    if (code !== 0) {
      results.push({ name: f.name, action: "FAILED", code, err: err.trim().split("\n").slice(-1)[0] });
      continue;
    }
    const st = statSync(out);
    results.push({ name: f.name, action: "generated", bytes: st.size });
  }
  for (const r of results) {
    console.log(`  [${r.action.padEnd(9)}] ${r.name.padEnd(30)} ${r.bytes ?? ""} ${r.err || ""}`);
  }
  const failed = results.some(r => r.action === "FAILED");
  process.exit(failed ? 1 : 0);
}

await main();
