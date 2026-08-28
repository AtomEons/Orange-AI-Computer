#!/usr/bin/env bun
// Batch ingest — grow the training corpus with varied clips.
//
// Operator: "all"
//
// Strategy: use canonical CC-BY sources whose licensing is unambiguous.
// Blender Foundation open movies are all CC-BY:
//   - Big Buck Bunny (2008, animated)
//   - Sintel (2010, animated)
//   - Tears of Steel (2012, LIVE ACTION + VFX — real photography!)
//   - Cosmos Laundromat (2015, animated)
//
// We pull multiple clip windows to diversify motion + depth content.
// Ingest continues past individual URL failures — each row that lands
// is a real training pair set.

import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { ingestUrl } from "./video-ingest.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const CORPUS = path.resolve(__dir, "..", "..", "fixtures", "training-corpus");
fs.mkdirSync(CORPUS, { recursive: true });

// Diverse candidates. Each entry has multiple clip windows.
const CATALOG = [
  {
    url: "https://www.youtube.com/watch?v=YE7VzlLtp-4",
    title: "Big Buck Bunny",
    author: "Blender Foundation",
    license: "CC-BY 3.0",
    kind: "animated",
    windows: [
      { start: 180, duration: 15, note: "act 2 scene" },
      { start: 300, duration: 15, note: "act 3 chase" },
      { start: 480, duration: 15, note: "climactic scene" },
    ],
  },
  {
    url: "https://www.youtube.com/watch?v=R6MlUcmOul8",
    title: "Tears of Steel",
    author: "Blender Foundation",
    license: "CC-BY 3.0",
    kind: "live-action (real photography)",
    windows: [
      { start: 60, duration: 15, note: "opening dialogue scene" },
      { start: 180, duration: 15, note: "action segment" },
    ],
  },
  {
    url: "https://www.youtube.com/watch?v=eRsGyueVLvQ",
    title: "Sintel",
    author: "Blender Foundation",
    license: "CC-BY 3.0",
    kind: "animated (Blender open movie)",
    windows: [
      { start: 90, duration: 15, note: "landscape scene" },
      { start: 240, duration: 15, note: "action scene" },
    ],
  },
];

console.log("=== BATCH INGEST — growing the training corpus ===\n");

const rows = [];
const failures = [];

for (const src of CATALOG) {
  console.log(`▸ ${src.title} (${src.kind})`);
  console.log(`  license: ${src.license} · author: ${src.author}`);
  for (const w of src.windows) {
    process.stdout.write(`  · clip ${w.start}s+${w.duration}s (${w.note})... `);
    try {
      const row = await ingestUrl(src.url, src, CORPUS, {
        start: w.start,
        duration: w.duration,
        pairs: 6,
        size: 384,
        timestamp: "2026-07-06T00:00:00Z",
      });
      console.log(`✓ meanFlow=${row.clip_summary.mean_flow_magnitude_px.toFixed(2)}px translationality=${(row.clip_summary.translationality_frac*100).toFixed(0)}%${row.cached ? " (cached)" : ""}`);
      rows.push({ src: src.title, window: w, row });
    } catch (e) {
      const msg = String(e.message).slice(0, 200);
      console.log(`✗ ${msg}`);
      failures.push({ src: src.title, window: w, error: msg });
    }
  }
  console.log("");
}

console.log("=== CORPUS SUMMARY ===");
const manifestPath = path.join(CORPUS, "manifest.jsonl");
if (fs.existsSync(manifestPath)) {
  const lines = fs.readFileSync(manifestPath, "utf8").split("\n").filter(Boolean);
  console.log(`total ingested rows: ${lines.length}`);
  let totalPairs = 0;
  const byTitle = new Map();
  for (const l of lines) {
    try {
      const r = JSON.parse(l);
      totalPairs += r.pairs_extracted || 0;
      const title = r.title || "unknown";
      byTitle.set(title, (byTitle.get(title) || 0) + 1);
    } catch {}
  }
  console.log(`total depth-annotated pairs: ${totalPairs}`);
  console.log("clips per source:");
  for (const [t, n] of byTitle.entries()) console.log(`  ${t}: ${n}`);
}
console.log(`\nnew this run: ${rows.length} rows landed, ${failures.length} failed`);
if (failures.length) {
  console.log("\nfailures:");
  for (const f of failures) console.log(`  ${f.src} ${f.window.start}s: ${f.error.slice(0, 120)}`);
}

// Aggregate depth signals across the corpus
if (rows.length) {
  console.log("\ntranslationality distribution across new rows:");
  for (const r of rows) {
    const t = r.row.clip_summary.translationality_frac * 100;
    const bar = "█".repeat(Math.round(t / 5));
    console.log(`  ${r.src.slice(0, 20).padEnd(20)} ${r.window.note.slice(0, 20).padEnd(20)} ${t.toFixed(0)}% ${bar}`);
  }
}
