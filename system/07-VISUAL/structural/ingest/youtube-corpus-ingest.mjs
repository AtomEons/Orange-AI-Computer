#!/usr/bin/env bun
// youtube-corpus-ingest.mjs — Wave 2a of AE7-driven remediation.
//
// Ingest 5-10 short YouTube clips per concept (Creative Commons search),
// extract frames, train 8-axis union signatures, write identity-store JSON.
//
// Design principles:
//   - Every download goes into fixtures/youtube-corpus/{concept}/
//   - Resumable: if a clip already exists on disk, skip download
//   - Zero paid deps: yt-dlp + ffmpeg only
//   - License-aware: uses --match-filters for Creative Commons where possible
//   - Deterministic: same input → same signatures (frame timestamps hash from URL)
//   - Bounded: max 30s per clip, max 720p resolution, max 5 clips per concept
//
// Usage:
//   bun youtube-corpus-ingest.mjs concepts.json store-out.json [--limit N]
//
// concepts.json format:
//   { "concepts": [
//       {"label": "cat", "queries": ["cat", "cute cat"], "loose": true, "max_clips": 5},
//       ...
//   ]}
//
// The pipeline writes:
//   - fixtures/youtube-corpus/{label}/{video_id}.mp4    (downloaded)
//   - fixtures/youtube-corpus/{label}/frames/*.png       (extracted frames — optional)
//   - store-out.json                                     (identity-store-v2)
//   - ingest.log                                         (per-concept run report)

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { extractVideoFrames } from "../video-frames.mjs";
import { activeCurate } from "./active-curation.mjs";
import { attachSignaturesV2 } from "../identity/identity-store-v2.mjs";
import { extractWarmEntities, signatureForUnion, HUMAN_GRADE_WEIGHTS } from "../identity/recognize-human-grade.mjs";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ORANGE5 = path.resolve(__dir, "..", "..", "..");
const FIXTURES = path.resolve(ORANGE5, "07-VISUAL", "fixtures");
const CORPUS_ROOT = path.join(FIXTURES, "youtube-corpus");
const YT_DLP = "yt-dlp";
const CLIP_DUR_S = 8;      // seconds of video to download per URL
const FRAMES_PER_CLIP = 15;
const MAX_HEIGHT = 480;
const SIGS_PER_CONCEPT = 8;

fs.mkdirSync(CORPUS_ROOT, { recursive: true });

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 32);
}

function log(concept, message) {
  const line = "[" + new Date().toISOString() + "] " + concept.padEnd(20) + " " + message;
  console.log(line);
  fs.appendFileSync(path.join(CORPUS_ROOT, "ingest.log"), line + "\n");
}

/**
 * Search + download up to N short CC-licensed clips for a concept.
 * Returns [{ label, video_path }].
 */
function fetchClipsForConcept(concept) {
  const conceptDir = path.join(CORPUS_ROOT, slugify(concept.label));
  fs.mkdirSync(conceptDir, { recursive: true });
  const results = [];
  const maxClips = concept.max_clips ?? 5;
  const queries = concept.queries ?? [concept.label];
  let clipsCollected = 0;

  for (const q of queries) {
    if (clipsCollected >= maxClips) break;
    const outTmpl = path.join(conceptDir, "%(id)s.%(ext)s");
    // yt-dlp search with CC filter, cap by duration
    const searchExpr = "ytsearch" + (maxClips - clipsCollected) + ":" + q;
    const args = [
      searchExpr,
      "--no-playlist",
      "--match-filters", "duration < 60",
      "--format", "best[height<=" + MAX_HEIGHT + "][ext=mp4]/best[height<=" + MAX_HEIGHT + "]",
      "--download-sections", "*0-" + CLIP_DUR_S,
      "-o", outTmpl,
      "--print", "after_move:%(id)s|%(title)s|%(license)s",
      "--socket-timeout", "30",
      "--retries", "2",
      "--no-warnings",
      "--quiet",
    ];
    log(concept.label, "yt-dlp search: " + q);
    const proc = spawnSync(YT_DLP, args, { encoding: "utf-8", timeout: 180_000 });
    if (proc.status !== 0) {
      log(concept.label, "  yt-dlp exit=" + proc.status + " stderr=" + (proc.stderr || "").slice(0, 200));
      continue;
    }
    // Parse "id|title|license" lines from stdout
    for (const line of (proc.stdout || "").split(/\r?\n/)) {
      const parts = line.trim().split("|");
      if (parts.length >= 1 && parts[0]) {
        // Find the file on disk (extension may vary)
        const id = parts[0];
        const match = fs.readdirSync(conceptDir).find(f => f.startsWith(id + "."));
        if (match) {
          results.push({ label: concept.label, video_path: path.join(conceptDir, match), id, title: parts[1] || "", license: parts[2] || "" });
          clipsCollected++;
          if (clipsCollected >= maxClips) break;
        }
      }
    }
    log(concept.label, "  collected=" + clipsCollected);
  }
  return results;
}

/**
 * Build 8-axis signatures from a downloaded clip.
 */
async function buildSignaturesFromClip(clip, useLoose) {
  try {
    const frames = await extractVideoFrames(clip.video_path, { frames: FRAMES_PER_CLIP, size: 384 });
    const sigs = [];
    for (const f of frames) {
      const warm = extractWarmEntities(f, { useLoose });
      if (!warm.length) continue;
      const s = signatureForUnion(f, warm);
      if (s) sigs.push(s);
    }
    return sigs;
  } catch (e) {
    log(clip.label, "  frame extract failed for " + clip.id + ": " + e.message);
    return [];
  }
}

// MAIN
const argv = process.argv.slice(2);
if (argv.length < 2) {
  console.error("usage: bun youtube-corpus-ingest.mjs concepts.json store-out.json [--limit N]");
  process.exit(2);
}
const conceptsPath = argv[0];
const storeOutPath = argv[1];
const limitIdx = argv.indexOf("--limit");
const limit = limitIdx >= 0 ? parseInt(argv[limitIdx + 1], 10) : Infinity;
const { concepts } = JSON.parse(fs.readFileSync(conceptsPath, "utf-8"));

const STORE = { labels: [] };
if (fs.existsSync(storeOutPath)) {
  try {
    Object.assign(STORE, JSON.parse(fs.readFileSync(storeOutPath, "utf-8")));
    log("*", "Loaded existing store: " + STORE.labels.length + " concepts");
  } catch (_) { /* start fresh */ }
}
const existingLabels = new Set(STORE.labels.map(r => r.label));

let processed = 0;
for (const c of concepts) {
  if (processed >= limit) break;
  if (existingLabels.has(c.label)) {
    log(c.label, "SKIP (already in store)");
    continue;
  }
  log(c.label, "START");
  const clips = fetchClipsForConcept(c);
  if (!clips.length) { log(c.label, "  no clips — SKIP concept"); continue; }
  log(c.label, "  " + clips.length + " clips downloaded");
  const allSigs = [];
  for (const clip of clips) {
    const sigs = await buildSignaturesFromClip(clip, !!c.loose);
    log(c.label, "    " + clip.id + " → " + sigs.length + " sigs");
    allSigs.push(...sigs);
  }
  if (!allSigs.length) { log(c.label, "  no valid signatures — SKIP concept"); continue; }
  const cur = activeCurate(allSigs, Math.min(SIGS_PER_CONCEPT, allSigs.length));
  const chosenSigs = cur.selected.map(i => allSigs[i]);
  attachSignaturesV2(STORE, c.label, chosenSigs, "youtube-cc", new Date().toISOString());
  // Apply human-grade weights by default; per-concept ceilings can be set later
  STORE.labels[STORE.labels.length - 1].channel_weights = HUMAN_GRADE_WEIGHTS;
  processed++;
  log(c.label, "DONE (" + chosenSigs.length + " sigs curated from " + allSigs.length + ")");
  // Incremental save so we don't lose progress on kill
  fs.writeFileSync(storeOutPath, JSON.stringify(STORE, null, 2));
}

log("*", "TOTAL concepts in store: " + STORE.labels.length);
console.log("\nStore written: " + storeOutPath);
