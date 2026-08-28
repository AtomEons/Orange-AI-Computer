// 07-VISUAL/structural/ingest/video-ingest.mjs
//
// YouTube → training corpus pipeline.
//
// Doctrine:
//   - Only CC-licensed, public-domain, or explicitly-permitted content.
//   - No paid deps. yt-dlp is free/open. ffmpeg is free/open.
//   - Every ingest emits a receipt row: source URL, license note, ffprobe stats,
//     frame count, per-pair OF stats, per-frame monocular-depth stats.
//   - Deterministic: same URL + same clip window → same frame set + same
//     depth pairs. yt-dlp downloads the same asset given the same ID.
//
// This module gives the caller:
//   downloadVideo(url, outDir, opts) — pulls a video (or clip window) via yt-dlp
//   extractPairs(videoPath, N, opts) — extract N adjacent-frame pairs
//   depthAnnotatePair(f1, f2) — compute OF + mono depth + summary for one pair
//   ingestUrl(url, meta, corpusRoot, opts) — end-to-end ingest with receipt

import path from "node:path";
import fs from "node:fs";
import crypto from "node:crypto";
import { extractImageRGB } from "../prism.mjs";
import { blockMatchFlow, depthFromFlow, upsampleField } from "../optical-flow.mjs";
import { sharpnessMap, aerialPerspectiveMap, fuseDepthCues, depthSummary } from "../mono-depth.mjs";
import { flowDivergenceAndCurl } from "../flow-geometry.mjs";
import { extractVideoFrames } from "../video-frames.mjs";

/**
 * Download a video via yt-dlp. Optional clip window (start_s + duration_s).
 * Returns the path to the downloaded mp4.
 */
export async function downloadVideo(url, outDir, opts = {}) {
  fs.mkdirSync(outDir, { recursive: true });
  // Deterministic filename: hash of URL + clip window
  const key = JSON.stringify({ url, start: opts.start ?? 0, duration: opts.duration ?? null });
  const hash = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
  const outPath = path.join(outDir, `ingest-${hash}.mp4`);
  if (fs.existsSync(outPath)) {
    return { path: outPath, cached: true, sha: hash };
  }

  const args = [
    // Restrict to a format that's small and portable
    "-f", "mp4[height<=480]/best[height<=480]/best",
    "--no-playlist",
    "--no-warnings",
    "-o", outPath,
  ];
  if (opts.start !== undefined || opts.duration !== undefined) {
    // Clip window via yt-dlp download sections
    const start = opts.start ?? 0;
    const end = start + (opts.duration ?? 30);
    args.push("--download-sections", `*${start}-${end}`);
    args.push("--force-keyframes-at-cuts");
  }
  args.push(url);

  const proc = Bun.spawnSync({
    cmd: ["yt-dlp", ...args],
    stdout: "pipe", stderr: "pipe",
  });
  if (proc.exitCode !== 0 || !fs.existsSync(outPath)) {
    const errTxt = new TextDecoder().decode(proc.stderr).slice(0, 500);
    throw new Error(`yt-dlp failed (exit=${proc.exitCode}): ${errTxt}`);
  }
  return { path: outPath, cached: false, sha: hash };
}

/**
 * Extract N adjacent-frame pairs uniformly spaced across the clip.
 */
export async function extractPairs(videoPath, N, opts = {}) {
  const framesNeeded = N * 2;
  const frames = await extractVideoFrames(videoPath, { frames: framesNeeded, size: opts.size ?? 384 });
  const pairs = [];
  for (let i = 0; i + 1 < frames.length; i += 2) {
    pairs.push({ f1: frames[i], f2: frames[i + 1] });
  }
  return pairs;
}

/**
 * Compute OF + monocular depth for one adjacent-frame pair. Returns per-pair
 * summary + pair-level depth statistics.
 */
export function depthAnnotatePair(f1, f2, opts = {}) {
  const B = opts.blockSize ?? 16;
  const R = opts.searchRadius ?? 8;
  const w = f1.width, h = f1.height;
  const L1 = new Float32Array(w * h), L2 = new Float32Array(w * h);
  for (let i = 0; i < L1.length; i++) {
    L1[i] = 0.30 * f1.R[i] + 0.59 * f1.G[i] + 0.11 * f1.B[i];
    L2[i] = 0.30 * f2.R[i] + 0.59 * f2.G[i] + 0.11 * f2.B[i];
  }
  const flow = blockMatchFlow(L1, L2, w, h, { blockSize: B, searchRadius: R });
  const geom = flowDivergenceAndCurl(flow.vx, flow.vy, flow.cols, flow.rows);
  const ofDepthBlock = depthFromFlow(flow.vx, flow.vy, flow.confidence);
  const ofDepth = upsampleField(ofDepthBlock, flow.cols, flow.rows, w, h, B);
  const sharpness = sharpnessMap(L1, w, h, 5);
  const aerial = aerialPerspectiveMap(f1.R, f1.G, f1.B);
  const fused = fuseDepthCues([
    { map: ofDepth, weight: 0.5 },
    { map: sharpness, weight: 0.3 },
    { map: aerial, weight: 0.2 },
  ]);
  return {
    meanMagPx: flow.meanMagnitude,
    maxMagPx: flow.maxMagnitude,
    divEnergy: geom.divergenceEnergyMean,
    curlEnergy: geom.curlEnergyMean,
    translationality: geom.divergenceEnergyMean / Math.max(1e-6, geom.divergenceEnergyMean + geom.curlEnergyMean),
    depthSummary: depthSummary(fused),
    ofDepthSummary: depthSummary(ofDepth),
    sharpnessSummary: depthSummary(sharpness),
    aerialSummary: depthSummary(aerial),
  };
}

/**
 * End-to-end ingest of a URL into the training corpus. Returns a manifest row.
 */
export async function ingestUrl(url, meta, corpusRoot, opts = {}) {
  const videosDir = path.join(corpusRoot, "videos");
  const manifestPath = path.join(corpusRoot, "manifest.jsonl");
  fs.mkdirSync(corpusRoot, { recursive: true });
  fs.mkdirSync(videosDir, { recursive: true });

  // 1. Download
  const dl = await downloadVideo(url, videosDir, opts);

  // 2. Extract pairs
  const N = opts.pairs ?? 10;
  const pairs = await extractPairs(dl.path, N, { size: opts.size ?? 384 });

  // 3. Depth-annotate each pair
  const perPair = pairs.map((p) => depthAnnotatePair(p.f1, p.f2, opts));

  // 4. Corpus-wide statistics for this clip
  let sumMag = 0, maxMag = 0, sumDivEnergy = 0, sumCurlEnergy = 0;
  for (const p of perPair) {
    sumMag += p.meanMagPx;
    if (p.maxMagPx > maxMag) maxMag = p.maxMagPx;
    sumDivEnergy += p.divEnergy;
    sumCurlEnergy += p.curlEnergy;
  }
  const nP = Math.max(1, perPair.length);
  const clipMeanMag = sumMag / nP;
  const clipDivEnergy = sumDivEnergy / nP;
  const clipCurlEnergy = sumCurlEnergy / nP;
  const translationality = clipDivEnergy / Math.max(1e-6, clipDivEnergy + clipCurlEnergy);

  const row = {
    url,
    license: meta.license ?? "UNKNOWN",
    title: meta.title ?? null,
    author: meta.author ?? null,
    clip_start_s: opts.start ?? 0,
    clip_duration_s: opts.duration ?? null,
    sha: dl.sha,
    cached: dl.cached,
    video_path: path.relative(corpusRoot, dl.path),
    pairs_extracted: perPair.length,
    clip_summary: {
      mean_flow_magnitude_px: clipMeanMag,
      max_flow_magnitude_px: maxMag,
      mean_div_energy: clipDivEnergy,
      mean_curl_energy: clipCurlEnergy,
      translationality_frac: translationality,
    },
    per_pair: perPair,
    ingested_at: opts.timestamp ?? new Date().toISOString(),
  };

  fs.appendFileSync(manifestPath, JSON.stringify(row) + "\n");
  return row;
}
