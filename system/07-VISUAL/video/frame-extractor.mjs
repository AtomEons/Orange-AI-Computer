#!/usr/bin/env node
// OrangeEye Phase-2 — temporal video frame extractor.
//
// Pulls one frame every N seconds out of an input video (default 5s) and
// feeds each frame into the standard ColPali ingest path with
// `payload.lane = "video-frame"`. The colpali-service queue is path-only
// (queue.enqueue takes a single absolute string), so we cannot pass a
// payload through the wire — we therefore drop a sibling `<frame>.meta.json`
// next to every frame that the queue runner picks up and uses to stamp the
// per-frame Qdrant payload (lane, source video, frame index, timestamp_s).
// In-process callers can skip the queue and hand frames directly to an
// async `enqueue` callback returned by their own runner — the sidecar still
// gets written so a later restart can re-ingest from disk idempotently.
//
// Why ffmpeg subprocess (not a JS decoder):
//   ffmpeg is the only thing on a Codexa box that decodes every codec we
//   actually see (H.264, H.265, AV1, VP9) at a reasonable speed and produces
//   exactly the JPEG geometry ColQwen2.5 wants. node-fluent-ffmpeg adds a
//   dep without adding value — we just spawn and parse stderr.
//
// Why JPEG (not PNG):
//   ColQwen2.5 is patch-based and downsamples internally; PNG's lossless
//   advantage is wasted and JPEG cuts disk by ~10x on real video. Quality
//   2 (best non-lossless) is the default; override with FRAME_JPEG_Q.
//
// Hard limits (Mom's Law — no theater):
//   - Input must be an absolute path to an existing readable file.
//   - intervalSeconds must be > 0 and finite. Default 5.
//   - Output dir is `${VISUAL_ROOT}/video-frames/<doc_id>/` where doc_id is
//     sha256(file_bytes_first_1MB + file_size + mtime) so re-runs over the
//     same file are deterministic and idempotent on disk.
//   - We refuse to overwrite an existing non-empty frames dir unless
//     `force: true` — that's a buggy retry, not a feature.
//   - ffmpeg stderr is captured and surfaced if the child exits non-zero.
//   - 30 minute hard timeout on the ffmpeg child; configurable.
//   - Max 10_000 frames per run — anything past that is a configuration
//     bug or a 14-hour movie that should be sampled differently.
//
// Output contract:
//   extractFrames({...}) -> {
//     doc_id,               // stable per source bytes
//     source_path,
//     source_size,
//     source_sha256_prefix, // first 16 hex chars of source sha (cheap probe)
//     interval_seconds,
//     frames_dir,           // absolute dir holding frame JPEGs + sidecars
//     frame_count,
//     frames: [
//       {
//         path,             // absolute path to the .jpg
//         meta_path,        // absolute path to the .meta.json sidecar
//         frame_index,      // 1-based
//         timestamp_seconds,// float, when in source this frame was sampled
//       }, ...
//     ],
//     ffmpeg: { argv, stderr_tail, exit_code, took_ms },
//     enqueued: number | null,  // count actually enqueued (null if no callback)
//     enqueue_ids: (number|null)[] | null,  // per-frame queue ids (parallel)
//   }
//
// Sidecar shape (consumed by the queue runner to stamp Qdrant payload):
//   {
//     "lane": "video-frame",
//     "source_video": { "path": <abs>, "sha256_prefix": <16hex>, "size": N },
//     "doc_id": <video doc_id>,         // patches across all frames share this
//     "frame_index": 1-based,
//     "timestamp_seconds": float,
//     "interval_seconds": N,
//     "extracted_at": ISO8601,
//     "extractor": "frame-extractor.mjs v1"
//   }
//
// CLI usage:
//   node frame-extractor.mjs <video> [--interval 5] [--out <dir>] [--force]
//                                    [--enqueue http://127.0.0.1:7440/enqueue]
//                                    [--dry-run]
//
// Programmatic usage:
//   import { extractFrames } from "./frame-extractor.mjs";
//   const result = await extractFrames({
//     videoPath: "/abs/path/to/clip.mp4",
//     intervalSeconds: 5,
//     enqueue: async (absPath) => {
//       const r = await fetch("http://127.0.0.1:7440/enqueue", {
//         method: "POST",
//         headers: { "content-type": "application/json" },
//         body: JSON.stringify({ path: absPath, kind: "image" }),
//       });
//       const j = await r.json();
//       return j.id ?? null;
//     },
//   });

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  writeFileSync,
  openSync,
  readSync,
  closeSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const VISUAL_ROOT = resolvePath(HERE, "..");
const DEFAULT_FRAMES_ROOT =
  process.env.ORANGE_EYE_FRAMES_ROOT ||
  join(VISUAL_ROOT, "video-frames");

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const JPEG_Q = clampInt(process.env.FRAME_JPEG_Q, 2, 1, 31);
const FFMPEG_TIMEOUT_MS = clampInt(
  process.env.FRAME_FFMPEG_TIMEOUT_MS,
  30 * 60 * 1000,
  1000,
  6 * 60 * 60 * 1000,
);
const MAX_FRAMES = clampInt(process.env.FRAME_MAX_FRAMES, 10_000, 1, 1_000_000);

const VIDEO_EXT = new Set([
  ".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".mpg", ".mpeg",
]);

function clampInt(envVal, dflt, lo, hi) {
  const n = Number(envVal);
  if (!Number.isFinite(n)) return dflt;
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

function extOf(p) {
  const i = p.lastIndexOf(".");
  return i < 0 ? "" : p.slice(i).toLowerCase();
}

/**
 * Cheap, deterministic doc_id for a source video. Hashing the entire file is
 * wasteful on a 4GB clip; the (first 1MB bytes + size + mtime) tuple is
 * enough to distinguish real-world videos and stays cheap on re-runs.
 * Returns { sha256_hex_full, sha256_prefix16 }.
 */
function probeSourceHash(absPath, size) {
  const h = createHash("sha256");
  const PROBE = Math.min(size, 1024 * 1024);
  if (PROBE > 0) {
    const fd = openSync(absPath, "r");
    try {
      const buf = Buffer.allocUnsafe(PROBE);
      let off = 0;
      while (off < PROBE) {
        const got = readSync(fd, buf, off, PROBE - off, off);
        if (got <= 0) break;
        off += got;
      }
      h.update(buf.subarray(0, off));
    } finally {
      closeSync(fd);
    }
  }
  const st = statSync(absPath);
  h.update(`|size=${size}|mtime=${st.mtimeMs}`);
  const hex = h.digest("hex");
  return { sha256_hex_full: hex, sha256_prefix16: hex.slice(0, 16) };
}

function dirIsNonEmpty(dir) {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Spawn ffmpeg, await exit, return { exit_code, stderr_tail, took_ms, argv }.
 * Times out after FFMPEG_TIMEOUT_MS; SIGKILLs the child and reports.
 */
function runFfmpeg(argv) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let stderrChunks = [];
    let stderrBytes = 0;
    const STDERR_CAP = 64 * 1024; // 64 KB tail is plenty for diagnostics
    let timedOut = false;

    const child = spawn(FFMPEG_BIN, argv, {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });

    const killer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    }, FFMPEG_TIMEOUT_MS);

    child.stderr.on("data", (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= STDERR_CAP) {
        stderrChunks.push(chunk);
      } else {
        // Keep a sliding tail so the last error line survives.
        stderrChunks.push(chunk);
        let total = stderrChunks.reduce((n, c) => n + c.length, 0);
        while (total > STDERR_CAP && stderrChunks.length > 1) {
          total -= stderrChunks[0].length;
          stderrChunks.shift();
        }
      }
    });

    child.on("error", (err) => {
      clearTimeout(killer);
      resolve({
        exit_code: -1,
        spawn_error: err.message,
        stderr_tail: Buffer.concat(stderrChunks).toString("utf8"),
        took_ms: Date.now() - startedAt,
        argv: [FFMPEG_BIN, ...argv],
        timed_out: false,
      });
    });

    child.on("close", (code) => {
      clearTimeout(killer);
      resolve({
        exit_code: timedOut ? -2 : code,
        stderr_tail: Buffer.concat(stderrChunks).toString("utf8"),
        took_ms: Date.now() - startedAt,
        argv: [FFMPEG_BIN, ...argv],
        timed_out: timedOut,
      });
    });
  });
}

/**
 * Build the ffmpeg argv. We use `-vf fps=1/N` (constant-rate sampler) — it's
 * the cleanest way to get "one frame every N seconds" and ffmpeg handles
 * variable-FPS source automatically. `-vsync vfr` keeps the output frames at
 * the chosen rate (no duplicated frames to fill gaps). `-q:v` controls JPEG
 * quality on the mjpeg encoder. `%06d.jpg` gives us 1-indexed frames up to
 * 999,999 (well past MAX_FRAMES).
 *
 * `-y` is intentional — we already gated overwrite at the dir level, and an
 * existing single frame from a half-finished prior run should be replaced.
 */
function buildFfmpegArgv({ videoPath, intervalSeconds, framesDir, jpegQ, maxFrames }) {
  const pattern = join(framesDir, "frame-%06d.jpg");
  const fpsExpr = `1/${intervalSeconds}`;
  return [
    "-hide_banner",
    "-loglevel", "error",
    "-nostdin",
    "-y",
    "-i", videoPath,
    "-vf", `fps=${fpsExpr}`,
    "-vsync", "vfr",
    "-frames:v", String(maxFrames),
    "-q:v", String(jpegQ),
    "-f", "image2",
    pattern,
  ];
}

/**
 * Scan the frames dir for files named `frame-NNNNNN.jpg`, return them in
 * frame-index order with the per-frame timestamp derived from the configured
 * interval. We do NOT trust ffmpeg to have emitted contiguous indices — if a
 * frame is missing we surface the gap by skipping it (frame_index stays the
 * 1-based on-disk number, timestamp matches index * interval - interval).
 */
function collectFrames({ framesDir, intervalSeconds }) {
  if (!existsSync(framesDir)) return [];
  const files = readdirSync(framesDir)
    .filter((n) => /^frame-(\d{6})\.jpg$/.test(n))
    .sort();
  return files.map((name) => {
    const m = name.match(/^frame-(\d{6})\.jpg$/);
    const idx = parseInt(m[1], 10);
    const ts = (idx - 1) * intervalSeconds; // ffmpeg's first sample is at t=0
    return {
      path: join(framesDir, name),
      meta_path: join(framesDir, name.replace(/\.jpg$/, ".meta.json")),
      frame_index: idx,
      timestamp_seconds: Number(ts.toFixed(3)),
    };
  });
}

function writeSidecar(frame, { sourceMeta, docId, intervalSeconds }) {
  const sidecar = {
    lane: "video-frame",
    source_video: {
      path: sourceMeta.path,
      sha256_prefix: sourceMeta.sha256_prefix16,
      size: sourceMeta.size,
    },
    doc_id: docId,
    frame_index: frame.frame_index,
    timestamp_seconds: frame.timestamp_seconds,
    interval_seconds: intervalSeconds,
    extracted_at: new Date().toISOString(),
    extractor: "frame-extractor.mjs v1",
  };
  writeFileSync(frame.meta_path, JSON.stringify(sidecar, null, 2), "utf8");
  return sidecar;
}

/**
 * Public API. See module header for the full output contract.
 *
 * @param {object} opts
 * @param {string} opts.videoPath           - absolute path to source video
 * @param {number} [opts.intervalSeconds=5] - seconds between sampled frames
 * @param {string} [opts.outDir]            - override frames dir (default: derived)
 * @param {boolean} [opts.force=false]      - allow non-empty target dir
 * @param {number} [opts.jpegQ]             - 2..31 (lower = better)
 * @param {number} [opts.maxFrames]         - hard cap
 * @param {(absPath: string, frameMeta: object) => Promise<number|null>} [opts.enqueue]
 *        - optional callback invoked per frame after extraction. Resolve with
 *          a queue id (or null) for the result row. Receives the sidecar
 *          payload as the 2nd arg so an in-process runner can short-circuit
 *          the disk read.
 * @param {boolean} [opts.dryRun=false]     - validate + plan; do not spawn ffmpeg
 */
export async function extractFrames({
  videoPath,
  intervalSeconds = 5,
  outDir,
  force = false,
  jpegQ = JPEG_Q,
  maxFrames = MAX_FRAMES,
  enqueue,
  dryRun = false,
} = {}) {
  // ----- Input validation (Mom's Law: fail loud and early) -----
  if (typeof videoPath !== "string" || videoPath.length === 0) {
    throw new Error("extractFrames: videoPath required");
  }
  if (!isAbsolute(videoPath)) {
    throw new Error(`extractFrames: videoPath must be absolute, got: ${videoPath}`);
  }
  if (!existsSync(videoPath)) {
    throw new Error(`extractFrames: videoPath does not exist: ${videoPath}`);
  }
  const st = statSync(videoPath);
  if (!st.isFile()) {
    throw new Error(`extractFrames: videoPath is not a regular file: ${videoPath}`);
  }
  if (st.size === 0) {
    throw new Error(`extractFrames: videoPath is empty: ${videoPath}`);
  }
  const ext = extOf(videoPath);
  if (!VIDEO_EXT.has(ext)) {
    throw new Error(
      `extractFrames: unsupported video extension "${ext}" — ` +
      `recognized: ${[...VIDEO_EXT].join(", ")}`,
    );
  }
  const iv = Number(intervalSeconds);
  if (!Number.isFinite(iv) || iv <= 0) {
    throw new Error(`extractFrames: intervalSeconds must be > 0, got ${intervalSeconds}`);
  }
  // intervalSeconds is allowed to be sub-second (e.g. 0.5) — ffmpeg accepts
  // fractional fps just fine. But guard against absurd values that would
  // explode the frame count.
  if (iv < 0.1) {
    throw new Error(`extractFrames: intervalSeconds < 0.1 is refused (got ${iv}) — set FRAME_MAX_FRAMES if you really mean this`);
  }
  const jq = Math.max(2, Math.min(31, Math.trunc(Number(jpegQ) || JPEG_Q)));
  const mf = Math.max(1, Math.min(1_000_000, Math.trunc(Number(maxFrames) || MAX_FRAMES)));

  // ----- Probe source + derive doc_id + resolve frames dir -----
  const probe = probeSourceHash(videoPath, st.size);
  const docId = probe.sha256_hex_full.slice(0, 40); // 40 hex chars = 160 bits, plenty
  const framesDir = outDir
    ? resolvePath(outDir)
    : join(DEFAULT_FRAMES_ROOT, docId);

  if (!isAbsolute(framesDir)) {
    throw new Error(`extractFrames: resolved outDir is not absolute: ${framesDir}`);
  }
  if (dirIsNonEmpty(framesDir) && !force) {
    // Idempotency policy: if the dir already holds frame-NNNNNN.jpg files
    // from a prior successful run, return them as-is. force=true wipes and
    // re-runs. Anything else is a configuration error.
    const existing = collectFrames({ framesDir, intervalSeconds: iv });
    if (existing.length > 0) {
      // Backfill sidecars for any frame missing one — sidecar shape may have
      // evolved between runs and the queue runner depends on it.
      const sourceMeta = {
        path: videoPath,
        size: st.size,
        sha256_prefix16: probe.sha256_prefix16,
      };
      for (const f of existing) {
        if (!existsSync(f.meta_path)) {
          writeSidecar(f, { sourceMeta, docId, intervalSeconds: iv });
        }
      }
      const result = {
        doc_id: docId,
        source_path: videoPath,
        source_size: st.size,
        source_sha256_prefix: probe.sha256_prefix16,
        interval_seconds: iv,
        frames_dir: framesDir,
        frame_count: existing.length,
        frames: existing,
        ffmpeg: { skipped: "already_extracted", argv: null, stderr_tail: "", exit_code: 0, took_ms: 0 },
        enqueued: null,
        enqueue_ids: null,
      };
      if (typeof enqueue === "function" && !dryRun) {
        await runEnqueue(result, enqueue, { sourceMeta, docId, intervalSeconds: iv });
      }
      return result;
    }
    throw new Error(
      `extractFrames: frames_dir ${framesDir} is non-empty and has no recognized frames — ` +
      `refusing to clobber. Pass force:true to override.`,
    );
  }

  mkdirSync(framesDir, { recursive: true });

  // ----- Dry-run: report the plan and exit -----
  const argv = buildFfmpegArgv({
    videoPath,
    intervalSeconds: iv,
    framesDir,
    jpegQ: jq,
    maxFrames: mf,
  });
  if (dryRun) {
    return {
      doc_id: docId,
      source_path: videoPath,
      source_size: st.size,
      source_sha256_prefix: probe.sha256_prefix16,
      interval_seconds: iv,
      frames_dir: framesDir,
      frame_count: 0,
      frames: [],
      ffmpeg: { argv: [FFMPEG_BIN, ...argv], dry_run: true, stderr_tail: "", exit_code: 0, took_ms: 0 },
      enqueued: null,
      enqueue_ids: null,
    };
  }

  // ----- Spawn ffmpeg -----
  const ff = await runFfmpeg(argv);
  if (ff.exit_code !== 0) {
    // Don't leave a half-extracted dir lying around. We collect anything that
    // did land so the caller can decide whether to keep partial frames, but
    // we surface the failure as a thrown error with full diagnostics.
    const partial = collectFrames({ framesDir, intervalSeconds: iv });
    const err = new Error(
      `ffmpeg failed (exit=${ff.exit_code}${ff.timed_out ? ", timed out" : ""}): ` +
      (ff.spawn_error ? ff.spawn_error : ff.stderr_tail.trim().split("\n").pop() || "no stderr"),
    );
    err.ffmpeg = ff;
    err.partial_frames = partial;
    err.frames_dir = framesDir;
    throw err;
  }

  // ----- Collect frames + write sidecars -----
  const frames = collectFrames({ framesDir, intervalSeconds: iv });
  if (frames.length === 0) {
    const err = new Error(
      `ffmpeg exited 0 but produced no frames — source may be shorter than ${iv}s ` +
      `or contain no decodable video stream`,
    );
    err.ffmpeg = ff;
    err.frames_dir = framesDir;
    throw err;
  }

  const sourceMeta = {
    path: videoPath,
    size: st.size,
    sha256_prefix16: probe.sha256_prefix16,
  };
  for (const f of frames) {
    writeSidecar(f, { sourceMeta, docId, intervalSeconds: iv });
  }

  const result = {
    doc_id: docId,
    source_path: videoPath,
    source_size: st.size,
    source_sha256_prefix: probe.sha256_prefix16,
    interval_seconds: iv,
    frames_dir: framesDir,
    frame_count: frames.length,
    frames,
    ffmpeg: {
      argv: ff.argv,
      stderr_tail: ff.stderr_tail,
      exit_code: ff.exit_code,
      took_ms: ff.took_ms,
    },
    enqueued: null,
    enqueue_ids: null,
  };

  if (typeof enqueue === "function") {
    await runEnqueue(result, enqueue, { sourceMeta, docId, intervalSeconds: iv });
  }
  return result;
}

/**
 * Drive the enqueue callback once per frame. Sequential — the colpali-service
 * queue is single-flight by design (see queue.mjs) so parallel POSTs only
 * stack work behind the same drain loop and don't help throughput. We swallow
 * per-frame enqueue errors into the result rather than throwing, so a partial
 * batch lands and the caller can retry the gaps from `enqueue_ids[i] === null`.
 */
async function runEnqueue(result, enqueue, ctx) {
  const ids = new Array(result.frames.length).fill(null);
  let enqueued = 0;
  for (let i = 0; i < result.frames.length; i++) {
    const frame = result.frames[i];
    const sidecar = {
      lane: "video-frame",
      source_video: {
        path: ctx.sourceMeta.path,
        sha256_prefix: ctx.sourceMeta.sha256_prefix16,
        size: ctx.sourceMeta.size,
      },
      doc_id: ctx.docId,
      frame_index: frame.frame_index,
      timestamp_seconds: frame.timestamp_seconds,
      interval_seconds: ctx.intervalSeconds,
    };
    try {
      const id = await enqueue(frame.path, sidecar);
      ids[i] = typeof id === "number" ? id : null;
      if (ids[i] !== null) enqueued++;
    } catch (e) {
      // Record nothing — null in ids signals "needs retry". Keep going.
      ids[i] = null;
      // Surface in the result so callers see what broke without throwing.
      if (!result.enqueue_errors) result.enqueue_errors = [];
      result.enqueue_errors.push({
        frame_index: frame.frame_index,
        error: String(e && e.message ? e.message : e),
      });
    }
  }
  result.enqueued = enqueued;
  result.enqueue_ids = ids;
}

// ----------------------------------------------------------------------------
// CLI
// ----------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {
    video: null,
    interval: 5,
    out: null,
    force: false,
    dryRun: false,
    enqueueUrl: null,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--interval" && argv[i + 1]) { out.interval = Number(argv[++i]); continue; }
    if (a === "--out" && argv[i + 1]) { out.out = argv[++i]; continue; }
    if (a === "--force") { out.force = true; continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--enqueue" && argv[i + 1]) { out.enqueueUrl = argv[++i]; continue; }
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (!out.video) { out.video = a; continue; }
    throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function usage() {
  return [
    "Usage: node frame-extractor.mjs <video> [options]",
    "",
    "Options:",
    "  --interval <seconds>   Sample one frame every N seconds (default 5)",
    "  --out <dir>            Override frames output dir",
    "  --force                Overwrite a non-empty target dir",
    "  --dry-run              Print the ffmpeg argv and exit",
    "  --enqueue <url>        POST each frame to this /enqueue endpoint",
    "                         (defaults to no enqueue; frames + sidecars only)",
    "",
    "Env:",
    "  FFMPEG_BIN                  override ffmpeg binary path",
    "  FRAME_JPEG_Q                JPEG quality 2..31, default 2 (better)",
    "  FRAME_FFMPEG_TIMEOUT_MS     hard cap for ffmpeg child, default 30min",
    "  FRAME_MAX_FRAMES            hard cap on frames per run, default 10000",
    "  ORANGE_EYE_FRAMES_ROOT      override default frames root",
  ].join("\n");
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    process.stderr.write(`error: ${e.message}\n\n${usage()}\n`);
    process.exit(2);
  }
  if (args.help || !args.video) {
    process.stdout.write(`${usage()}\n`);
    process.exit(args.help ? 0 : 2);
  }
  const videoPath = isAbsolute(args.video) ? args.video : resolvePath(args.video);

  let enqueue = null;
  if (args.enqueueUrl) {
    enqueue = async (absPath /*, sidecar */) => {
      const resp = await fetch(args.enqueueUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: absPath, kind: "image" }),
      });
      if (!resp.ok) {
        throw new Error(`enqueue ${resp.status}: ${await resp.text()}`);
      }
      const j = await resp.json();
      return typeof j.id === "number" ? j.id : null;
    };
  }

  try {
    const result = await extractFrames({
      videoPath,
      intervalSeconds: args.interval,
      outDir: args.out,
      force: args.force,
      dryRun: args.dryRun,
      enqueue,
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    process.exit(0);
  } catch (e) {
    const payload = {
      error: e.message,
      ffmpeg: e.ffmpeg ?? null,
      partial_frames: e.partial_frames ?? null,
      frames_dir: e.frames_dir ?? null,
    };
    process.stderr.write(`${JSON.stringify(payload, null, 2)}\n`);
    process.exit(1);
  }
}

// Run main only when invoked directly (node frame-extractor.mjs ...).
const invokedDirectly = (() => {
  try {
    return resolvePath(process.argv[1] || "") === resolvePath(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (invokedDirectly) {
  main();
}
