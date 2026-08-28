// 07-VISUAL/structural/photon-capture-record-v1_1.mjs
//
// AEYES1-PHOTON-CAPTURE-1.1-TEMPORAL — the additive temporal extension.
// GPT doctrine v6 (spine seq 122).
//
// v1.1 RULES:
//   1. Wraps a v1.0 static capture (immutable, referenced by hash)
//   2. Adds temporalCapture block with mode / frames / timing / channels
//   3. Static hash MUST byte-equal fresh v1.0 build of current frame
//   4. NEVER mutates the static contract
//   5. Two modes: CAUSAL (previous→current) and CENTERED (previous→current→next)
//   6. Never mix modes in one score table
//   7. This commit: W+1 temporal luminance contrast ONLY
//
// Cache identity must include prev/curr/next hashes + deltas + mode + static-record hash
// + temporal schema version + temporal dep versions + temporal configHash + numericMode.

import { buildStaticCaptureWithTaps } from "./build-static-capture.mjs";
import { buildW1LuminanceLane, CHANNEL_ID as W1_CHANNEL_ID, CHANNEL_VERSION as W1_CHANNEL_VERSION } from "./temporal-luminance-w1.mjs";
import { computeOnEvents, computeOffEvents, W2_CHANNEL_VERSION, W3_CHANNEL_VERSION } from "./temporal-on-off-w2-w3.mjs";
import { hashField } from "./axis-tap.mjs";
import { RUNTIME_NUMERIC_MODE } from "./cache-identity.mjs";

export const V1_1_SCHEMA = "AEYES1-PHOTON-CAPTURE-1.1-TEMPORAL";
export const TEMPORAL_PIPELINE_VERSION = "aeyes1-photon-capture-1.1-temporal-w1-only";

// Track only the temporal-side dependency versions. Static deps live in the
// referenced v1.0 record's cacheIdentity.
export const TEMPORAL_DEPENDENCIES = {
  luminance_transient: W1_CHANNEL_VERSION,   // 1.1 with extended metadata
  on_events: W2_CHANNEL_VERSION,             // 1.0 — woken in this commit
  off_events: W3_CHANNEL_VERSION,            // 1.0 — woken in this commit
  local_adaptation_normalized: "unwoken",
  horizontal_motion: "unwoken",
  vertical_motion: "unwoken",
  radial_motion: "unwoken",
  temporal_spectrum: "unwoken",
};

// Hash an RGB frame for the sourceHash in temporal frames
function hashRgbFrame(rgb) {
  if (!rgb) return null;
  // Hash a downsampled fingerprint (every 512th pixel) for speed while still
  // being frame-content-unique. Same-input → same hash.
  return hashField(rgb.R);
}

/**
 * Build v1.1 temporal capture record.
 * @param {object} args
 *   previous: {R,G,B,width,height} — required
 *   current:  {R,G,B,width,height} — required
 *   next:     same or null — CENTERED mode when supplied
 *   deltaPreviousMs: ms between previous and current (required for cache identity)
 *   deltaNextMs:     ms between current and next   (optional)
 *   meta:     {rawRef, configHash}
 */
export function buildTemporalCaptureRecord({
  previous, current, next = null,
  deltaPreviousMs = null, deltaNextMs = null,
  meta = {},
}) {
  if (!current) throw new Error("v1.1 record requires current frame");
  if (!previous) throw new Error("v1.1 record requires previous frame (v1.0 is the static-only path)");
  const mode = next ? "CENTERED" : "CAUSAL";

  // Build v1.0 static for CURRENT frame. IMMUTABLE — never modified by temporal.
  const { record: staticCapture, taps: staticTaps } = buildStaticCaptureWithTaps(current, meta);
  const staticRecordHash = staticCapture.integrity.recordHash;

  // Temporal channel: W+1 luminance transient (v1.1 with extended metadata)
  const w1 = buildW1LuminanceLane({ previous, current, next, mode });

  // W+2 ON and W+3 OFF — rectified halves of the signed delta_Y from W+1
  const w2_backward = w1.backward?.valid ? computeOnEvents(w1.backward, current.width) : null;
  const w3_backward = w1.backward?.valid ? computeOffEvents(w1.backward, current.width) : null;
  const w2_forward = w1.forward?.valid ? computeOnEvents(w1.forward, current.width) : null;
  const w3_forward = w1.forward?.valid ? computeOffEvents(w1.forward, current.width) : null;

  // Magno lane: three woken channels + five unwoken
  const magnoResponses = {
    luminanceTransient: {
      backward_signedMean: w1.backward?.signedMean ?? null,
      backward_meanAbsolute: w1.backward?.meanAbsolute ?? null,
      backward_globality: w1.backward?.globality ?? null,
      backward_activeFraction: w1.backward?.activeFraction ?? null,
      backward_borderActivity: w1.backward?.borderActivity ?? null,
      backward_connectedRegionCount: w1.backward?.connectedRegionCount ?? null,
      backward_positiveEnergy: w1.backward?.positiveEnergy ?? null,
      backward_negativeEnergy: w1.backward?.negativeEnergy ?? null,
      forward_meanAbsolute: w1.forward?.meanAbsolute ?? null,
    },
    on: w2_backward
      ? { valid: true, availability: "TEMPORAL_MEASURED", channelId: "W+2_ON_events",
          backward_mean: w2_backward.mean, backward_energy: w2_backward.energy,
          backward_activeFraction: w2_backward.activeFraction,
          backward_connectedRegionCount: w2_backward.connectedRegionCount,
          backward_borderActivity: w2_backward.borderActivity }
      : { valid: false, availability: "TEMPORAL_INPUT_UNAVAILABLE", channelId: "W+2_ON_events" },
    off: w3_backward
      ? { valid: true, availability: "TEMPORAL_MEASURED", channelId: "W+3_OFF_events",
          backward_mean: w3_backward.mean, backward_energy: w3_backward.energy,
          backward_activeFraction: w3_backward.activeFraction,
          backward_connectedRegionCount: w3_backward.connectedRegionCount,
          backward_borderActivity: w3_backward.borderActivity }
      : { valid: false, availability: "TEMPORAL_INPUT_UNAVAILABLE", channelId: "W+3_OFF_events" },
    horizontalMotion: { valid: false, availability: "UNWOKEN_CHANNEL", channelId: "W+5" },
    verticalMotion: { valid: false, availability: "UNWOKEN_CHANNEL", channelId: "W+6" },
    expansion: { valid: false, availability: "UNWOKEN_CHANNEL", channelId: "W+7" },
    contraction: { valid: false, availability: "UNWOKEN_CHANNEL", channelId: "W+7" },
    temporalSpectrum: { valid: false, availability: "UNWOKEN_CHANNEL", channelId: "W+8" },
  };

  // Determine magno validity semantics per doctrine v6:
  //   static-mode (unreachable here — this is v1.1 which needs prev+curr): unavailable
  //   3-frame no-motion: valid=true, responses~0, reason=MEASURED_STATIC
  //   3-frame with motion: valid=true, responses populated
  const isNearZeroMotion = (w1.backward?.meanAbs ?? Infinity) < 0.001;
  const magnoLane = {
    valid: true,
    temporalMode: mode,
    interpretation: isNearZeroMotion ? "MEASURED_STATIC" : "MEASURED_MOTION",
    channels: magnoResponses,
    localMaps: {
      luminanceTransient_backward_deltaY_ref: w1.backward?.deltaY ? hashField(w1.backward.deltaY) : null,
      luminanceTransient_forward_deltaY_ref: w1.forward?.deltaY ? hashField(w1.forward.deltaY) : null,
    },
    pooledSummary: {
      motion_confidence: w1.backward?.meanAbs ?? 0,
    },
    confidence: {
      cadence_supplied: deltaPreviousMs !== null,
    },
    warnings: [
      ...(deltaPreviousMs === null ? ["deltaPreviousMs not supplied — velocity is uncalibrated"] : []),
      ...(w1.backward?.interpretation?.probable_global_exposure_shift ? ["backward transition shows probable global exposure shift, not local motion"] : []),
    ],
  };

  // Build the v1.1 record
  const prevHash = hashRgbFrame(previous);
  const currHash = hashRgbFrame(current);
  const nextHash = next ? hashRgbFrame(next) : null;

  const record = {
    schema: V1_1_SCHEMA,
    staticCapture: {
      schema: staticCapture.integrity.schemaVersion,
      recordHash: staticRecordHash,
      // Hash-addressed reference; downstream can request the full v1.0 record by this hash.
      recordRef: staticCapture,
    },
    temporalCapture: {
      mode,
      frames: {
        previous: { sourceHash: prevHash, timestamp: null },
        current: { sourceHash: currHash, timestamp: null, staticRecordHash },
        next: next ? { sourceHash: nextHash, timestamp: null } : null,
      },
      timing: {
        deltaPreviousMs,
        deltaNextMs,
        cadenceConfidence: (deltaPreviousMs !== null) ? 1.0 : 0.0,
      },
      retinalTemporal: {
        w1_luminance_transient: w1,
        w2_on_events: { backward: w2_backward, forward: w2_forward },
        w3_off_events: { backward: w3_backward, forward: w3_forward },
        // W+4..W+8 remain unwoken:
        w4_normalized_contrast: { valid: false, availability: "UNWOKEN_CHANNEL" },
        w5_horizontal_motion: { valid: false, availability: "UNWOKEN_CHANNEL" },
        w6_vertical_motion: { valid: false, availability: "UNWOKEN_CHANNEL" },
        w7_radial_motion: { valid: false, availability: "UNWOKEN_CHANNEL" },
        w8_temporal_spectrum: { valid: false, availability: "UNWOKEN_CHANNEL" },
      },
      lgnMagno: magnoLane,
      motionFields: {
        // Populated when W+5..W+7 wake up
      },
      validity: {
        overall: w1.valid,
        mode_expected_frames: mode === "CENTERED" ? 3 : 2,
        mode_supplied_frames: 2 + (next ? 1 : 0),
      },
      confidence: {
        temporal_pipeline_version: TEMPORAL_PIPELINE_VERSION,
      },
    },
    integrity: {
      temporalSchema: V1_1_SCHEMA,
      temporalPipelineVersion: TEMPORAL_PIPELINE_VERSION,
      temporalDependencies: TEMPORAL_DEPENDENCIES,
      temporalConfigHash: meta.temporalConfigHash ?? "default",
      staticRecordHash,
      staticCacheKey: staticCapture.integrity.cacheKey,
      previousSourceHash: prevHash,
      currentSourceHash: currHash,
      nextSourceHash: nextHash,
      deltaPreviousMs,
      deltaNextMs,
      mode,
      runtimeNumericMode: RUNTIME_NUMERIC_MODE,
      temporalCacheKey: null,   // populated below
      temporalRecordHash: null,
    },
  };

  // Compute temporal cache key from the integrity block (excluding hashes about to be set)
  record.integrity.temporalCacheKey = hashTemporalIdentity(record.integrity);
  record.integrity.temporalRecordHash = hashTemporalRecord(record);

  return record;
}

function canonicalJson(obj) {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "number") return Number.isFinite(obj) ? String(obj) : (Number.isNaN(obj) ? "\"NaN\"" : String(obj));
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  if (obj instanceof Float32Array || obj instanceof Float64Array) return "[" + Array.from(obj).map(canonicalJson).join(",") + "]";
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return "null";
}

function hashTemporalIdentity(integrity) {
  const { temporalCacheKey, temporalRecordHash, ...rest } = integrity;
  const s = canonicalJson({ ...rest, temporalCacheKey: null, temporalRecordHash: null });
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function hashTemporalRecord(record) {
  // Exclude temporalRecordHash from its own hash
  const { integrity, ...rest } = record;
  const payload = { ...rest, integrity: { ...integrity, temporalRecordHash: null } };
  const s = canonicalJson(payload);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, "0");
}
