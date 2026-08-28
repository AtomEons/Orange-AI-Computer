// C:/AtomEons/Orange5/07-VISUAL/structural/build-canonical-corpus.mjs
//
// Alpha Wolf Eyes — Canonical Photon Corpus Builder
// Sails the whole YouTube corpus through captureCanonicalPhoton and
// serializes per-clip canonicals to disk with a manifest.
//
// Zero learned parameters. Bun-native. ffmpeg via extractVideoFrames.
// Resilient: per-clip and per-frame errors are logged and skipped, never crash.

import fs from "node:fs";
import path from "node:path";
import { extractVideoFrames } from "./video-frames.mjs";
import { captureCanonicalPhoton } from "./photon-canonical.mjs";

const CORPUS_ROOT = "C:/AtomEons/Orange5/07-VISUAL/fixtures/youtube-corpus";
const OUT_ROOT    = "C:/AtomEons/Orange5/07-VISUAL/fixtures/canonical-corpus";
const CLIPS_PER_CONCEPT = 3;
const FRAMES_PER_CLIP   = 4;
const FRAME_SIZE        = 384;

const FIELDS = [
  "reflectance_map",
  "opponent_map",
  "retinal_map",
  "depth_map",
  "multiscale_edges",
  "saliency_map",
  "shape_moments",
  "spectral_moments",
];

function log(...a) { console.log(new Date().toISOString(), ...a); }

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function toB64Float32(field) {
  if (!field) return null;
  // Field is Float32Array; coerce defensively.
  const f32 = field instanceof Float32Array ? field : Float32Array.from(field);
  const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
  return { dtype: "float32", length: f32.length, base64: buf.toString("base64") };
}

function serializeCanonical(canon, meta) {
  const out = { meta: { ...(canon.meta ?? {}), ...meta } };
  for (const k of FIELDS) out[k] = toB64Float32(canon[k]);
  return out;
}

async function main() {
  const t0 = Date.now();
  ensureDir(OUT_ROOT);

  const concepts = fs.readdirSync(CORPUS_ROOT, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();

  log("concepts discovered:", concepts.length);

  const manifest = {
    version: "AWE-CORPUS-1.0",
    built_at: new Date().toISOString(),
    corpus_root: CORPUS_ROOT,
    out_root: OUT_ROOT,
    clips_per_concept: CLIPS_PER_CONCEPT,
    frames_per_clip: FRAMES_PER_CLIP,
    frame_size: FRAME_SIZE,
    entries: [],
    errors: [],
    stats: {},
  };

  let conceptsWithClips = 0;
  let conceptsProcessed = 0;
  let clipsTouched = 0;
  let clipsWritten = 0;
  let canonicalsProduced = 0;
  let framesFailed = 0;
  let totalBytes = 0;

  for (const concept of concepts) {
    const conceptDir = path.join(CORPUS_ROOT, concept);
    let clips = [];
    try {
      clips = fs.readdirSync(conceptDir)
        .filter((f) => /\.mp4$/i.test(f))
        .sort()
        .slice(0, CLIPS_PER_CONCEPT);
    } catch (e) {
      manifest.errors.push({ where: "readdir", concept, msg: String(e?.message ?? e) });
      continue;
    }
    if (clips.length === 0) continue;
    conceptsWithClips++;

    const conceptOutDir = path.join(OUT_ROOT, concept);
    ensureDir(conceptOutDir);

    let clipOkThisConcept = 0;

    for (const clipFile of clips) {
      clipsTouched++;
      const clipPath = path.join(conceptDir, clipFile);
      const clipBase = path.basename(clipFile, path.extname(clipFile));
      const outPath = path.join(conceptOutDir, `${clipBase}.json`);

      let frames = [];
      try {
        frames = await extractVideoFrames(clipPath, {
          frames: FRAMES_PER_CLIP,
          size: FRAME_SIZE,
        });
      } catch (e) {
        manifest.errors.push({
          where: "extract",
          concept,
          clip: clipFile,
          msg: String(e?.message ?? e).slice(0, 300),
        });
        continue;
      }

      const canonicals = [];
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        try {
          const canon = captureCanonicalPhoton(frame, {
            x: 0, y: 0,
            w: frame.width ?? frame.W,
            h: frame.height ?? frame.H,
          });
          canonicals.push(serializeCanonical(canon, {
            concept,
            clip: clipFile,
            frame_index: i,
          }));
          canonicalsProduced++;
        } catch (e) {
          framesFailed++;
          manifest.errors.push({
            where: "capture",
            concept,
            clip: clipFile,
            frame_index: i,
            msg: String(e?.message ?? e).slice(0, 300),
          });
        }
      }

      if (canonicals.length === 0) continue;

      const payload = {
        version: "AWE-CORPUS-1.0",
        concept,
        clip: clipFile,
        n_frames: canonicals.length,
        canonicals,
      };
      try {
        const json = JSON.stringify(payload);
        fs.writeFileSync(outPath, json);
        const bytes = Buffer.byteLength(json);
        totalBytes += bytes;
        clipsWritten++;
        clipOkThisConcept++;
        manifest.entries.push({
          concept,
          clip: clipFile,
          path: outPath,
          n_canonicals: canonicals.length,
          bytes,
        });
      } catch (e) {
        manifest.errors.push({
          where: "write",
          concept,
          clip: clipFile,
          msg: String(e?.message ?? e).slice(0, 300),
        });
      }
    }

    if (clipOkThisConcept > 0) conceptsProcessed++;
    if (conceptsProcessed % 10 === 0 && clipOkThisConcept > 0) {
      log(`progress: concepts=${conceptsProcessed} clips=${clipsWritten} canonicals=${canonicalsProduced} bytes=${totalBytes}`);
    }
  }

  const t1 = Date.now();
  manifest.stats = {
    concepts_total: concepts.length,
    concepts_with_clips: conceptsWithClips,
    concepts_processed: conceptsProcessed,
    clips_touched: clipsTouched,
    clips_written: clipsWritten,
    canonicals_produced: canonicalsProduced,
    frames_failed: framesFailed,
    errors: manifest.errors.length,
    total_bytes: totalBytes,
    elapsed_ms: t1 - t0,
  };

  const manifestPath = path.join(OUT_ROOT, "_manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  log("DONE");
  log("stats:", JSON.stringify(manifest.stats));
  log("manifest:", manifestPath);
  console.log("__RESULT__ " + JSON.stringify({
    manifest_path: manifestPath,
    ...manifest.stats,
  }));
}

main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
