#!/usr/bin/env bun
// First YouTube ingest — proves the pipeline end-to-end on a CC-BY video
// with real translational camera motion, so depth-from-flow gets exercised
// as depth (not just rotation like our synthesized fixtures).
//
// The operator's directive:
//   "youtube to train"
//
// This ingest is small: 3 short segments from vetted CC/public-domain
// sources chosen for depth-rich translational content. Each segment goes
// through the depth pipeline (block-matching OF + monocular fusion) and
// its per-pair summary lands in the manifest. Future turns grow the
// corpus with more videos.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ingestUrl } from "./video-ingest.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dir, "..", "..", "fixtures", "training-corpus");
fs.mkdirSync(CORPUS, { recursive: true });

// Vetted candidates: known CC-BY / public-domain YouTube URLs.
// Big Buck Bunny is the canonical CC-BY test video (Blender Foundation).
// NASA content is public-domain by default.
const CANDIDATES = [
  {
    url: "https://www.youtube.com/watch?v=YE7VzlLtp-4",
    title: "Big Buck Bunny (Blender Foundation, CC-BY 3.0)",
    author: "Blender Foundation",
    license: "CC-BY 3.0",
    start: 90,     // skip title, start at a scene with translational camera work
    duration: 15,  // 15-second clip
  },
];

console.log("=== FIRST YOUTUBE INGEST — depth pipeline on real cinema ===\n");
console.log(`corpus root: ${CORPUS}\n`);

for (const c of CANDIDATES) {
  console.log(`▸ ingesting: ${c.title}`);
  console.log(`  url: ${c.url}`);
  console.log(`  license: ${c.license}`);
  console.log(`  clip: ${c.start}s + ${c.duration}s\n`);
  try {
    const row = await ingestUrl(c.url, c, CORPUS, {
      start: c.start,
      duration: c.duration,
      pairs: 6,
      size: 384,
      timestamp: "2026-07-06T00:00:00Z",
    });
    console.log(`  ✓ downloaded ${row.cached ? "(cached)" : ""} to ${row.video_path}`);
    console.log(`  ${row.pairs_extracted} adjacent-frame pairs analyzed`);
    console.log(`  mean flow: ${row.clip_summary.mean_flow_magnitude_px.toFixed(2)}px`);
    console.log(`  max flow:  ${row.clip_summary.max_flow_magnitude_px.toFixed(1)}px`);
    console.log(`  translationality: ${(row.clip_summary.translationality_frac * 100).toFixed(1)}%   (higher = camera translating, lower = rotating)`);
    console.log(`  div-energy avg: ${row.clip_summary.mean_div_energy.toFixed(3)}`);
    console.log(`  curl-energy avg: ${row.clip_summary.mean_curl_energy.toFixed(3)}`);
    console.log("");
  } catch (e) {
    console.log(`  ✗ ingest failed: ${e.message}\n`);
  }
}

// Corpus summary
const manifestPath = path.join(CORPUS, "manifest.jsonl");
if (fs.existsSync(manifestPath)) {
  const lines = fs.readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
  console.log(`=== CORPUS SUMMARY ===`);
  console.log(`total ingested clips: ${lines.length}`);
  let totalPairs = 0;
  for (const l of lines) {
    try { totalPairs += JSON.parse(l).pairs_extracted; } catch {}
  }
  console.log(`total depth-annotated pairs: ${totalPairs}`);
  console.log(`manifest: ${manifestPath}`);
}
