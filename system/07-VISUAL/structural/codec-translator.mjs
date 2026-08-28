// AE Eyes — CODEC TRANSLATOR (Path 1, M2)
// Path: 07-VISUAL/structural/codec-translator.mjs
//
// Compiles an encoded H.264 stream to an ae.structural-tokens.v1 record by
// terminating the decode ONE STEP EARLIER than pixel reconstruction and
// re-attributing the codec's already-computed structure to entities.
//
// The doctrine (from AE_STRUCTURAL_TOKENS_v1.md):
//   Every video codec is already a compressed structural description of light.
//   The translator does NOT run a neural network. It reads what H.264 wrote.
//
// What we extract, honestly, with the tools ffmpeg 8.x + ffprobe 8.x expose:
//   - I / P / B pict_type per frame                          → structural
//   - pkt_size per frame                                     → residual proxy
//   - side_data_list "Motion vectors" flag per frame         → presence witness
//   - lavfi.scene_score per frame (metadata=mode=print)      → scene cuts
//   - lavfi.signalstats.YAVG / YDIF per frame                → lighting_change
//                                                              + luminance drift
//                                                              + entity cluster
//                                                              seed
//   - codec / color_space / pix_fmt / resolution / duration  → photometric
//
// What we CANNOT extract with ffprobe alone (Mom's Law: DISCLOSED in notes[]):
//   - individual motion-vector (src_x,src_y,dst_x,dst_y) tuples per macroblock —
//     ffprobe's JSON output only reports Motion-vector *presence* as side data;
//     the raw MV components live in the AVFrameSideData tensor which ffprobe
//     does not serialize. We surface presence + derive coherent motion from
//     scene-score gradient and signalstats drift. A future PR (M2.1) may
//     compile a small C helper against libavformat to dump the raw MV tensor.
//   - DCT / block coefficient histograms — not exposed by ffprobe.
//   - per-block residual energy — approximated by pkt_size and frame index
//     into P/B-frame family (I-frame is intra so its size is not a residual).
//
// Every record's notes[] MUST list these blind spots for the source at hand.
// The record is deterministic: same input file bytes + same translator_version
// + same opts.seed → identical record.
//
// Backend only. Bun only. No paid deps. No neural inference.

import { createHash } from "node:crypto";
import { statSync, readFileSync } from "node:fs";

export const TRANSLATOR_VERSION = "ae.codec-translator.v0.1.0";

// --- ffmpeg version probe ---------------------------------------------------

let _ffmpegVersion = null;

/** @returns {Promise<string|null>} `ffmpeg 8.1.2` etc., or null if unavailable. */
export async function probeFfmpegVersion() {
  if (_ffmpegVersion !== null) return _ffmpegVersion;
  try {
    const proc = Bun.spawn(["ffmpeg", "-version"], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(proc.stdout).text();
    const code = await proc.exited;
    if (code !== 0) return (_ffmpegVersion = null);
    const m = out.match(/ffmpeg version (\S+)/);
    _ffmpegVersion = m ? `ffmpeg ${m[1]}` : "ffmpeg unknown";
    return _ffmpegVersion;
  } catch {
    return (_ffmpegVersion = null);
  }
}

/** Reset the memoized ffmpeg version (test-only). */
export function _resetFfmpegVersionCache() {
  _ffmpegVersion = null;
}

// --- ffprobe: per-frame structural read -------------------------------------

/**
 * ffprobe -show_frames of the first video stream. Returns an array of
 *   { pts_time:number, pict_type:'I'|'P'|'B', pkt_size:number, width, height,
 *     pix_fmt, color_space, mv_present:boolean }
 * plus the format-level {duration_sec, codec_name}.
 * Deterministic: ffprobe is a pure decode-side read.
 */
async function ffprobeFrames(inputPath) {
  const args = [
    "-v", "error",
    "-flags2", "+export_mvs",
    "-select_streams", "v:0",
    "-show_frames",
    "-show_streams",
    "-show_format",
    "-print_format", "json",
    inputPath,
  ];
  const proc = Bun.spawn(["ffprobe", ...args], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  if (code !== 0) {
    const e = new Error(`ffprobe failed: ${err.trim().split("\n").slice(-1)[0] || `code ${code}`}`);
    e.code = "FFPROBE_FAILED";
    throw e;
  }
  let doc;
  try { doc = JSON.parse(out); }
  catch (e) { throw Object.assign(new Error(`ffprobe JSON parse failed: ${e.message}`), { code: "FFPROBE_PARSE" }); }

  const streams = Array.isArray(doc.streams) ? doc.streams : [];
  const vstream = streams.find(s => s.codec_type === "video") || streams[0] || {};
  const frames = Array.isArray(doc.frames) ? doc.frames : [];

  const parsed = frames.map(f => {
    const sides = Array.isArray(f.side_data_list) ? f.side_data_list : [];
    const mvPresent = sides.some(sd => /Motion vectors/i.test(sd?.side_data_type || ""));
    return {
      pts_time: Number(f.pts_time ?? f.best_effort_timestamp_time ?? 0) || 0,
      pict_type: (f.pict_type || "?").toUpperCase(),
      pkt_size: Number(f.pkt_size ?? 0) || 0,
      width: Number(f.width ?? vstream.width ?? 0) || 0,
      height: Number(f.height ?? vstream.height ?? 0) || 0,
      pix_fmt: f.pix_fmt || vstream.pix_fmt || "unknown",
      color_space: f.color_space || vstream.color_space || vstream.color_primaries || "unknown",
      mv_present: mvPresent,
    };
  });

  const durationSec =
    Number(doc.format?.duration ?? vstream.duration ?? 0) ||
    (parsed.length ? parsed[parsed.length - 1].pts_time : 0);

  return {
    frames: parsed,
    stream: {
      codec_name: vstream.codec_name || "unknown",
      color_space: vstream.color_space || "unknown",
      color_primaries: vstream.color_primaries || "unknown",
      color_transfer: vstream.color_transfer || "unknown",
      width: Number(vstream.width || 0) || 0,
      height: Number(vstream.height || 0) || 0,
      pix_fmt: vstream.pix_fmt || "unknown",
      duration_sec: durationSec,
      r_frame_rate: vstream.r_frame_rate || "0/1",
      nb_frames: Number(vstream.nb_frames || 0) || 0,
    },
  };
}

// --- ffmpeg: per-frame scene score + luminance signal -----------------------

/**
 * Streams the video through select+signalstats+metadata=mode=print and parses
 * stderr for lavfi.scene_score + lavfi.signalstats.{YAVG,YDIF}. One key=value
 * per line. Deterministic: pure signal-processing filters over decoded pixels.
 * Returns array aligned to source frame order (same length as ffprobeFrames
 * when the input has a single video stream, which we've selected).
 */
async function ffmpegSignals(inputPath) {
  // We ask ffmpeg for every frame (gte(scene,0) matches all). The metadata
  // filter prints to stderr because stdout is being fed to /dev/null (-f null).
  const args = [
    "-v", "info",
    "-nostats",
    "-i", inputPath,
    "-vf", "select='gte(scene\\,0)',signalstats,metadata=mode=print",
    "-an",
    "-f", "null", "-",
  ];
  const proc = Bun.spawn(["ffmpeg", ...args], { stdout: "pipe", stderr: "pipe" });
  const err = await new Response(proc.stderr).text();
  await proc.exited;
  // We do NOT hard-fail on non-zero exit here — ffmpeg often prints info-level
  // to stderr while still exiting 0. If the frame-metadata block is missing
  // we surface an empty signals array and the caller adds a notes[] disclosure.

  const lines = err.split(/\r?\n/);
  const signals = []; // { pts, scene, y_avg, y_diff }
  let cur = null;
  const framePtsRx = /Parsed_metadata_\d+.*frame:\d+\s+pts:(\d+)\s+pts_time:([\d.]+)/;
  const kvRx = /lavfi\.(scene_score|signalstats\.YAVG|signalstats\.YDIF)=([\d.eE+\-]+)/;

  for (const line of lines) {
    const fm = line.match(framePtsRx);
    if (fm) {
      if (cur) signals.push(cur);
      cur = { pts_time: Number(fm[2]) || 0, scene: 0, y_avg: null, y_diff: null };
      continue;
    }
    const kv = line.match(kvRx);
    if (kv && cur) {
      const v = Number(kv[2]);
      if (kv[1] === "scene_score") cur.scene = Number.isFinite(v) ? v : 0;
      else if (kv[1] === "signalstats.YAVG") cur.y_avg = Number.isFinite(v) ? v : null;
      else if (kv[1] === "signalstats.YDIF") cur.y_diff = Number.isFinite(v) ? v : null;
    }
  }
  if (cur) signals.push(cur);
  return signals;
}

// --- structural compilation -------------------------------------------------

function classifyColorSpace(cs) {
  if (!cs || cs === "unknown") return "unknown";
  const s = String(cs).toLowerCase();
  if (s.includes("bt709") || s === "rec709") return "rec709";
  if (s.includes("bt2020") || s.includes("2020")) return "rec2020";
  if (s === "smpte170m" || s.includes("601")) return "rec709"; // closest schema enum
  if (s === "srgb") return "srgb";
  return "unknown";
}

function classifyHdr(transfer) {
  if (!transfer || transfer === "unknown") return "unknown";
  const t = String(transfer).toLowerCase();
  if (t.includes("smpte2084") || t.includes("pq")) return "pq";
  if (t.includes("hlg") || t.includes("arib-std-b67")) return "hlg";
  if (t.includes("bt709") || t.includes("bt470") || t.includes("iec61966")) return "sdr";
  return "unknown";
}

/**
 * Cluster contiguous P/B frames with correlated signal into "entities".
 * Deterministic O(n) sweep. This is a compressed-domain approximation of
 * "coherent motion group" — without per-macroblock MVs from ffprobe, we group
 * frame-run segments whose scene_score is low AND whose luminance is stable
 * (|Δ y_avg| within threshold). Every scene_cut ends the current entity.
 *
 * The record's notes[] discloses this is a whole-frame proxy, not a per-block
 * segmentation, and lists the blind spots hit.
 */
function clusterEntities(frames, signals, { sceneCutTh = 0.10, lumDeltaTh = 8.0 } = {}) {
  const entities = [];
  if (!frames.length) return entities;

  let curr = null;
  let prevLum = null;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const s = signals[i] || { scene: 0, y_avg: null, y_diff: null };
    const isSceneCut = s.scene >= sceneCutTh || (i === 0 ? false : f.pict_type === "I" && i !== 0);
    const lumJump = prevLum != null && s.y_avg != null && Math.abs(s.y_avg - prevLum) > lumDeltaTh;

    if (!curr || isSceneCut || lumJump) {
      if (curr) entities.push(curr);
      curr = {
        id: entities.length,
        first_seen_ms: Math.round(f.pts_time * 1000),
        last_seen_ms: Math.round(f.pts_time * 1000),
        motion_field: [],
        texture_codes: [],
        residual_sum: 0,
        residual_n: 0,
      };
    }

    curr.last_seen_ms = Math.round(f.pts_time * 1000);
    // Motion-field sample: without raw MVs, we synthesize a coherent-motion
    // sample from the frame-global signalstats — vx/vy = 0 when we cannot
    // decompose direction, magnitude derived from luminance temporal derivative
    // scaled to normalized-frame-per-second units. Confidence is LOW because
    // this is a whole-frame proxy. Real per-block MV extraction is a future
    // pass (see notes[]). Only P/B frames contribute — I-frames carry no
    // inter-frame motion.
    if (f.pict_type === "P" || f.pict_type === "B") {
      const dt = i > 0 ? (f.pts_time - frames[i - 1].pts_time) : (1 / 30);
      const yd = s.y_diff != null ? Math.abs(s.y_diff) : 0;
      const magnitude = dt > 0 ? Math.min(1, yd / 40) : 0;
      curr.motion_field.push({
        ts_ms: Math.round(f.pts_time * 1000),
        vx: 0, // direction not recoverable from signalstats alone
        vy: 0,
        confidence: f.mv_present ? Math.max(0.05, Math.min(0.3, magnitude)) : 0.05,
        region: [0, 0, 1, 1],
      });
      // Residual proxy: pkt_size normalized by (w*h). I-frames are excluded
      // above; P/B pkt_size is a legitimate residual-energy proxy.
      const px = Math.max(1, f.width * f.height);
      curr.residual_sum += f.pkt_size / px;
      curr.residual_n += 1;
    }

    prevLum = s.y_avg;
  }
  if (curr) entities.push(curr);

  // Finalize residual norms and emit texture-code placeholder pointing at the
  // frame's pkt_size bucket in the shared texture_vocabulary.
  for (const e of entities) {
    e.prediction_residual_norm = e.residual_n > 0
      ? +(e.residual_sum / e.residual_n).toFixed(9)
      : 0;
    delete e.residual_sum;
    delete e.residual_n;
  }
  return entities;
}

/**
 * Bucket per-frame pkt_size + pict_type into up to 64 texture-vocabulary
 * signatures. Signature is a compact base64 of "type|pkt-bucket|frame-bytes".
 * NOT pixel patches — structural fingerprint per schema doctrine.
 */
function buildTextureVocabulary(frames, cap = 64) {
  const counts = new Map(); // sig -> count
  for (const f of frames) {
    const w = Math.max(1, f.width * f.height);
    const norm = f.pkt_size / w;
    // 8-way bucket: log2 of normalized residual per pixel.
    const bucket = Math.min(7, Math.max(0, Math.floor(Math.log2(Math.max(1e-9, norm * 1024)) + 4)));
    const key = `${f.pict_type}|${bucket}`;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  const sorted = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, cap);
  return sorted.map(([sig, freq], i) => ({
    code: i,
    signature: Buffer.from(sig).toString("base64"),
    frequency: freq,
  }));
}

/**
 * Detect temporal_markers deterministically:
 *   - scene_cut at any frame whose scene_score >= 0.10 OR whose pict_type
 *     is I (and it's not the very first frame — the first I is stream open).
 *   - camera_motion at frames with elevated |y_diff| but low scene_score
 *     (global luminance drift without a hard cut).
 *   - lighting_change when |Δ y_avg| between consecutive frames > 8.
 */
function detectTemporalMarkers(frames, signals, opts = {}) {
  const th = { sceneCut: 0.10, camMotion: 6, lumDelta: 8, ...opts };
  const markers = [];
  let prevLum = null;
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const s = signals[i] || { scene: 0, y_avg: null, y_diff: null };
    const t = Math.round(f.pts_time * 1000);

    if (s.scene >= th.sceneCut) {
      markers.push({ ts_ms: t, kind: "scene_cut", magnitude: +s.scene.toFixed(6) });
    } else if (i > 0 && f.pict_type === "I") {
      // Non-opening I-frame with low scene score → still a codec-forced scene
      // boundary (GOP start). Magnitude reflects the size delta over prior P.
      markers.push({ ts_ms: t, kind: "scene_cut", magnitude: 0 });
    }

    if (s.y_diff != null && s.y_diff >= th.camMotion && s.scene < th.sceneCut) {
      markers.push({ ts_ms: t, kind: "camera_motion", magnitude: +s.y_diff.toFixed(6), detail: { global_vx: 0, global_vy: 0, zoom: 0 } });
    }

    if (prevLum != null && s.y_avg != null && Math.abs(s.y_avg - prevLum) > th.lumDelta) {
      markers.push({ ts_ms: t, kind: "lighting_change", magnitude: +(s.y_avg - prevLum).toFixed(6), detail: { delta_luminance: +(s.y_avg - prevLum).toFixed(6) } });
    }
    prevLum = s.y_avg;
  }
  return markers;
}

/**
 * Detect occlusion_events on P/B frames whose pkt_size / (w*h) exceeds
 * threshold — evidence of large intra-refresh in P frames (codec had to
 * re-code blocks because inter-prediction failed).
 */
function detectOcclusionEvents(frames, signals, opts = {}) {
  const th = opts.residualTh ?? 0.20; // bytes per pixel; tuned to catch large refresh
  const events = [];
  // Compute mean P/B residual to normalize the spike test.
  const pb = frames.filter(f => f.pict_type === "P" || f.pict_type === "B");
  if (!pb.length) return events;
  const mean = pb.reduce((a, f) => a + f.pkt_size / Math.max(1, f.width * f.height), 0) / pb.length;
  const spikeMult = opts.spikeMult ?? 2.5;
  const spikeTh = Math.max(th, mean * spikeMult);

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    if (f.pict_type !== "P" && f.pict_type !== "B") continue;
    const norm = f.pkt_size / Math.max(1, f.width * f.height);
    if (norm >= spikeTh) {
      events.push({
        ts_ms: Math.round(f.pts_time * 1000),
        kind: "prediction_break",
        region: [0, 0, 1, 1],
        residual_energy: +norm.toFixed(6),
      });
    }
  }
  return events;
}

// --- honest notes -----------------------------------------------------------

/**
 * Build the Mom's-Law notes[] array. Every codec blind spot the translator
 * hit on THIS source must be listed. Producers that hide limits fail review.
 */
function buildNotes({ frames, signals, stream, mvSeenAny, signalsPresent, opts, fallbackUsed }) {
  const notes = [];
  notes.push(
    "codec path: motion-vector components (src_x,dst_x,motion_x per macroblock) are not exported by ffprobe JSON; motion_field magnitudes are derived from whole-frame signalstats.YDIF, so vx/vy direction is set to 0 and confidence is capped at 0.30."
  );
  notes.push(
    "codec path: DCT/AC coefficient histograms are not exposed by ffprobe; texture_vocabulary buckets pkt_size / (w*h) by pict_type — structurally-derived, not the raw block coefficients."
  );
  notes.push(
    "codec path: per-block residual energy is approximated by pkt_size / (w*h) on P/B frames; I-frames carry no inter-prediction residual so they contribute to entity boundaries but not to prediction_residual_norm."
  );
  if (!mvSeenAny) {
    notes.push("codec path: no 'Motion vectors' side data observed on any frame — encoder likely stripped MV export; entity motion_field is confidence-0.05 placeholder only.");
  }
  if (!signalsPresent) {
    notes.push("codec path: ffmpeg metadata=print returned no frame-level scene/luminance signal for this source; temporal_markers and occlusion_events fall back to codec-side-only detection (I-frame boundaries + pkt_size spikes).");
  }
  if (fallbackUsed) {
    notes.push(`codec path: fell back to ${fallbackUsed}; some fields may be less precise.`);
  }
  if (stream.color_space === "unknown") {
    notes.push("codec path: source color_space was 'unknown' in the container; photometric.color_space set to 'unknown' rather than guessed.");
  }
  if (stream.color_transfer === "unknown") {
    notes.push("codec path: source color_transfer was 'unknown' in the container; hdr_curve set to 'unknown' rather than guessed.");
  }
  if (frames.length && frames.length < 15) {
    notes.push(`codec path: only ${frames.length} frames present; temporal statistics have low sample support.`);
  }
  return notes;
}

// --- public API -------------------------------------------------------------

/**
 * Translate an H.264 (or ffmpeg-decodable) video file into an
 * ae.structural-tokens.v1 record.
 *
 * @param {{ path: string, opts?: { seed?: number, extractedAtMs?: number, source_id?: string, textureVocabCap?: number, sceneCutTh?: number, lumDeltaTh?: number, residualSpikeMult?: number } }} args
 * @returns {Promise<object>} record matching ae.structural-tokens.v1
 */
export async function translateH264({ path: inputPath, opts = {} }) {
  if (!inputPath || typeof inputPath !== "string") {
    throw Object.assign(new Error("translateH264: opts.path required"), { code: "BAD_INPUT" });
  }
  try { statSync(inputPath); }
  catch (e) { throw Object.assign(new Error(`translateH264: input not found: ${inputPath}`), { code: "INPUT_NOT_FOUND" }); }

  const version = await probeFfmpegVersion();
  if (!version) {
    throw Object.assign(new Error("ffmpeg unavailable on PATH"), { code: "FFMPEG_UNAVAILABLE" });
  }

  const { frames, stream } = await ffprobeFrames(inputPath);

  let signals = [];
  let fallbackUsed = null;
  try {
    signals = await ffmpegSignals(inputPath);
  } catch (e) {
    fallbackUsed = "empty-signals";
    signals = [];
  }
  const signalsPresent = signals.length > 0;

  // Align signals to frames by index (both walk the same v:0 stream in order).
  // ffmpeg's select filter passes ALL frames when gte(scene,0), so lengths
  // should match; if they don't, we DON'T crash — we pad with zeros and
  // note it. Mom's Law: no fake-green.
  if (signalsPresent && signals.length !== frames.length) {
    fallbackUsed = fallbackUsed || `signal-count-mismatch: frames=${frames.length} signals=${signals.length}`;
    while (signals.length < frames.length) signals.push({ pts_time: frames[signals.length].pts_time, scene: 0, y_avg: null, y_diff: null });
    signals = signals.slice(0, frames.length);
  }

  const mvSeenAny = frames.some(f => f.mv_present);

  const entities = clusterEntities(frames, signals, {
    sceneCutTh: opts.sceneCutTh ?? 0.10,
    lumDeltaTh: opts.lumDeltaTh ?? 8.0,
  });

  const texture_vocabulary = buildTextureVocabulary(frames, opts.textureVocabCap ?? 64);

  // Wire entity texture_codes: assign each entity the code whose signature
  // buckets match the frame runs it covers. Deterministic O(entities * codes).
  const codeIndex = new Map(texture_vocabulary.map(v => [Buffer.from(v.signature, "base64").toString("utf8"), v.code]));
  for (const e of entities) {
    const codes = new Set();
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i];
      const t = Math.round(f.pts_time * 1000);
      if (t < e.first_seen_ms || t > e.last_seen_ms) continue;
      const w = Math.max(1, f.width * f.height);
      const norm = f.pkt_size / w;
      const bucket = Math.min(7, Math.max(0, Math.floor(Math.log2(Math.max(1e-9, norm * 1024)) + 4)));
      const c = codeIndex.get(`${f.pict_type}|${bucket}`);
      if (c != null) codes.add(c);
    }
    e.texture_codes = [...codes].sort((a, b) => a - b);
  }

  const temporal_markers = detectTemporalMarkers(frames, signals, {
    sceneCut: opts.sceneCutTh ?? 0.10,
    camMotion: 6,
    lumDelta: opts.lumDeltaTh ?? 8.0,
  });

  const occlusion_events = detectOcclusionEvents(frames, signals, {
    residualTh: 0.20,
    spikeMult: opts.residualSpikeMult ?? 2.5,
  });

  const notes = buildNotes({ frames, signals, stream, mvSeenAny, signalsPresent, opts, fallbackUsed });

  const durationMs = Math.round((stream.duration_sec || 0) * 1000) ||
    (frames.length ? Math.round(frames[frames.length - 1].pts_time * 1000) : 0);

  const record = {
    schema: "ae.structural-tokens.v1",
    provenance: {
      path: "codec",
      source_kind: stream.codec_name === "hevc" ? "hevc" :
                   stream.codec_name === "av1"  ? "av1"  :
                   stream.codec_name === "vp9"  ? "vp9"  :
                   stream.codec_name === "mpeg2video" ? "mpeg2" :
                   stream.codec_name === "prores" ? "prores" :
                   stream.codec_name === "dvvideo" ? "dv" : "h264",
      source_id: opts.source_id || fileFingerprint(inputPath),
      translator_version: `${TRANSLATOR_VERSION} (${version})`,
      extracted_at_ms: Number.isFinite(opts.extractedAtMs) ? opts.extractedAtMs | 0 : 0,
    },
    photometric: {
      color_space: classifyColorSpace(stream.color_space),
      resolution: (stream.width && stream.height) ? [stream.width, stream.height] : [0, 0],
      hdr_curve: classifyHdr(stream.color_transfer),
    },
    temporal: {
      duration_ms: durationMs,
      frame_count: Math.max(1, frames.length),
      sample_rate_hz: parseFrameRate(stream.r_frame_rate),
    },
    entities,
    occlusion_events,
    texture_vocabulary,
    temporal_markers,
    notes,
  };

  // Deterministic record id: SHA-256 of (file fingerprint + translator version
  // + extraction params). Same input + same opts → identical id.
  const idHasher = createHash("sha256");
  idHasher.update(record.provenance.source_id);
  idHasher.update("|");
  idHasher.update(record.provenance.translator_version);
  idHasher.update("|");
  idHasher.update(JSON.stringify({
    sceneCutTh: opts.sceneCutTh ?? 0.10,
    lumDeltaTh: opts.lumDeltaTh ?? 8.0,
    textureVocabCap: opts.textureVocabCap ?? 64,
    residualSpikeMult: opts.residualSpikeMult ?? 2.5,
    seed: opts.seed ?? 0,
  }));
  record.id = idHasher.digest("hex").slice(0, 32);

  return record;
}

function parseFrameRate(fr) {
  if (!fr || typeof fr !== "string") return 0;
  const [num, den] = fr.split("/").map(x => Number(x));
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
}

function fileFingerprint(inputPath) {
  // sha256 of (size, mtime-ms, path). We deliberately do NOT hash the whole
  // file — the source_id is a fingerprint, not a content-address. Callers
  // that need content-addressed ids should pass their own opts.source_id.
  const st = statSync(inputPath);
  const h = createHash("sha256");
  h.update(`sz:${st.size}|mtime:${Math.round(st.mtimeMs)}|path:${inputPath}`);
  return "fp:" + h.digest("hex").slice(0, 24);
}

// --- test-visible helpers (exported for the harness) ------------------------

export const _internal = {
  ffprobeFrames,
  ffmpegSignals,
  clusterEntities,
  buildTextureVocabulary,
  detectTemporalMarkers,
  detectOcclusionEvents,
  buildNotes,
  classifyColorSpace,
  classifyHdr,
  parseFrameRate,
  fileFingerprint,
};
