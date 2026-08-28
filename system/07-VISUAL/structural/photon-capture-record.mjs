// 07-VISUAL/structural/photon-capture-record.mjs
//
// PhotonCaptureRecord v0.1 — evidence bus for the AWE-3 eye.
// GPT doctrine v3 (spine seq 110) — architectural output that replaces
// wide-IT/IT-80 as authoritative capture. IT-80 becomes a lossy summary only.
//
// Rules (enforced):
//   1. Arrays and cells stay structured — no flatten loss
//   2. Every lane carries summary AND local map reference
//   3. No flattener may silently discard non-scalar values
//   4. Unsupported values throw — not silently drop
//   5. IT-80 explicitly marked "lossy-summary"
//
// v0.1 is the SKELETON — the schema and container. Freeze to v1 only after
// pre-pooling audit lands and each WATCH/LEAK lane is promoted or quarantined.

import { buildCacheIdentity } from "./cache-identity.mjs";

export const SCHEMA_VERSION = "AEYES1-PHOTON-CAPTURE-1.0-STATIC";

// v1.0-STATIC contract per GPT doctrine v5 (spine seq 115):
// "v1.0 represents deterministic spatial photon-derived evidence from a single
//  captured frame. Temporal retinal and magnocellular pathways are explicitly
//  unavailable unless a valid temporal window is supplied."
// The QUALIFIED STATIC EYE SUBSTRATE — not the final complete eye.
// v1.1 will add 3-frame temporal ingest as an additive W+1.

const TEMPORAL_RETINAL_CHANNELS = new Set([
  "onTransient", "offTransient", "up", "down", "right", "left", "objectMotion", "sustainedDS",
]);

// Lane decisions (GPT doctrine v3, spine seq 110)
export const PROMOTE_AXES = new Set([
  "spatial_color", "persistent_homology", "radial_photon", "subsurface",
  "fourier_mellin", "edge", "specular", "spatial_frequency",
]);
export const QUARANTINE_AXES = new Set(["texture", "hu_moments"]);
export const WATCH_AXES = new Set([
  "photon_histogram", "photon_correlation", "color_ratio", "dichromatic",
]);
export const PROMOTE_STAGES = new Set(["retinal_12", "axis_bundle"]);
export const WATCH_STAGES = new Set(["lgn", "it_80"]);
export const DEMOTE_STAGES = new Set(["it_80"]);   // lossy-summary

/**
 * Build a PhotonCaptureRecord v0.1 from a canonical output.
 * @param {object} can — output of captureCanonicalPhoton
 * @param {object} meta — optional metadata (sourceHash, pipelineHash, configHash, rawRef, captureId)
 * @returns {object} PhotonCaptureRecord v0.1
 */
export function buildPhotonCaptureRecord(can, meta = {}) {
  if (!can || typeof can !== "object") {
    throw new Error(`PhotonCaptureRecord: invalid canonical input (${typeof can})`);
  }

  const record = {
    schema: SCHEMA_VERSION,
    captureId: meta.captureId ?? null,
    sourceHash: meta.sourceHash ?? null,
    pipelineHash: meta.pipelineHash ?? null,
    configHash: meta.configHash ?? null,

    source: {
      width: can.source_width ?? meta.width ?? null,
      height: can.source_height ?? meta.height ?? null,
      channels: 3,
      range: [0, 1],
      colorSpace: "sRGB-linear-after-linearize",
      transferFunction: "linearize -> CAT02",
      rawRef: meta.rawRef ?? null,
    },

    canonical: {
      linearRef: can.linear_ref ?? null,
      irisRef: can.iris?.ref ?? null,
      cat02Ref: can.cat02?.ref ?? null,
      fovealRef: can.foveal_ref ?? null,
      rodRef: can.rod?.ref ?? null,
    },

    lanes: {
      // --- retinal-12 with per-channel availability (GPT v5) ---
      // Sustained/edge/uniformity channels are SPATIAL_AVAILABLE.
      // Transient/directional/object-motion channels are TEMPORAL_INPUT_UNAVAILABLE in static mode.
      retinal12: buildRetinal12Lane(can),

      // --- LGN with stream-level availability (GPT v5) ---
      // parvo (spatial), konio (chromatic-specialized) available.
      // magno (temporal) is UNAVAILABLE in static mode — do NOT emit zero-vectors.
      lgn: buildLgnLane(can),

      // --- axis-bundle (PROMOTED aggregate 11P/1W/0C) with per-axis promotion ---
      axisBundle: {
        promotion: "promote",
        vector: can.wide_it_vector ?? null,   // legacy flat vec, referenced not owned
        axes: buildAxisLanes(can.axis_bundle ?? {}),
      },

      // --- IT-80 (DEMOTED to lossy-summary) ---
      it80: {
        promotion: "demote",
        status: "lossy-summary",
        vector: can.it_vector ?? null,
        note: "IT-80 collapses distinctions preserved upstream — see spine seq 109 verdict 6P/4W/2C. Do NOT use as authoritative eye output. Fast candidate retrieval only.",
        confidence: null,
      },
    },

    provenance: {
      stageOrder: [
        "linearize", "CAT02", "iris", "foveal_log_polar", "rod_pathway",
        "retinal_12", "LGN(parvo,magno,konio)",
        "V1(24_gabor)", "V2(contour)", "V4(shape)", "IT_80", "saccades",
      ],
      formulas: {
        luminance: "rec709: 0.2126R + 0.7152G + 0.0722B",
        spatial_color_luminance_invariant: "log(cell_L + eps) - log(region_L + eps)",
        spatial_color_opponent: "redGreen=(R-G)/(R+G+eps), blueYellow=(0.5(R+G)-B)/(R+G+B+eps)",
      },
      constants: {
        rec709_R: 0.2126, rec709_G: 0.7152, rec709_B: 0.0722,
        eps: 1e-3,
      },
      numericPrecision: "Float32Array cache, Float64Array intermediates",
    },

    quality: {
      clipping: computeClipping(can),
      underexposure: computeUnderexposure(can),
      illuminantConfidence: can.illuminant?.confidence ?? null,
      laneValidity: computeLaneValidity(can),
      warnings: computeWarnings(can),
    },

    // GPT doctrine v5 gate 3: deterministic lineage hashes.
    // Hash the canonicalized record (excluding integrity itself) so the same
    // input+pipeline+config produces the same hash across processes.
    integrity: null,   // populated below after record is assembled
  };

  // Integrity + cache identity computed INSIDE the pipeline (freeze gate 7).
  // Callers cannot omit dependency versions — the cache-identity module owns them.
  const sourceHash = meta.sourceHash ?? hashSerialized({
    width: record.source.width,
    height: record.source.height,
    rawRef: record.source.rawRef,
  });
  const { identity: cacheIdentity, cacheKey } = buildCacheIdentity({
    sourceHash,
    configHash: meta.configHash ?? "default",
    captureSchema: SCHEMA_VERSION,
  });
  record.integrity = {
    schemaVersion: SCHEMA_VERSION,
    schemaHash: SCHEMA_HASH,
    sourceHash,
    pipelineHash: cacheKey,                     // gate 7: pipeline hash = full cache identity
    configHash: meta.configHash ?? "default",
    cacheKey,
    cacheIdentity,                              // full dependency fingerprint, embedded for lineage
    recordHash: null,                           // populated by hashRecord() when caller locks lineage
  };
  return record;
}

// ---- Integrity hash primitives ----
// FNV-1a on canonicalized JSON (stable key order) of the payload.
function hashSerialized(obj) {
  const s = canonicalJson(obj);
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
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

const SCHEMA_HASH = hashSerialized({
  schema: SCHEMA_VERSION,
  promote_axes: Array.from(PROMOTE_AXES).sort(),
  quarantine_axes: Array.from(QUARANTINE_AXES).sort(),
  watch_axes: Array.from(WATCH_AXES).sort(),
  temporal_channels: Array.from(TEMPORAL_RETINAL_CHANNELS).sort(),
});
const PIPELINE_HASH_UNSPECIFIED = "unset____";
const CONFIG_HASH_UNSPECIFIED = "unset____";

/**
 * Compute the recordHash after all lanes are populated. Callers can invoke this
 * to lock the lineage. Returns a NEW record with integrity.recordHash set;
 * does not mutate the input record's inner content.
 */
export function hashRecord(record) {
  // Exclude integrity.recordHash from its own hash input
  const { integrity, ...rest } = record;
  const payload = { ...rest, integrity: { ...integrity, recordHash: null } };
  const rh = hashSerialized(payload);
  return { ...record, integrity: { ...integrity, recordHash: rh } };
}

/**
 * Structure each axis lane with its promotion status, summary, and (pending Step 3) local map.
 * Preserves ALL structured cells and array fields — no scalar-only flattening.
 */
function buildAxisLanes(axisBundle) {
  const out = {};
  const ALL_AXES = [
    ...PROMOTE_AXES, ...QUARANTINE_AXES, ...WATCH_AXES,
  ];
  for (const axisName of ALL_AXES) {
    const axis = axisBundle[axisName];
    const promotion = PROMOTE_AXES.has(axisName) ? "promote"
                    : QUARANTINE_AXES.has(axisName) ? "quarantine"
                    : "watch";
    if (!axis || axis._error) {
      out[axisName] = { promotion, present: false, error: axis?._error ?? null };
      continue;
    }
    // Extract structured cells if present (spatial_color, persistent_homology, etc)
    const cells = axis._cells ?? null;
    // Extract summary scalars (skip _-prefixed and non-number types — but track skipped)
    const summary = {};
    const structuredFields = {};
    const flags = {};
    const skipped = [];
    for (const [k, v] of Object.entries(axis)) {
      if (k.startsWith("_")) continue;   // internal / structured payload
      if (typeof v === "number" && Number.isFinite(v)) {
        summary[k] = v;
      } else if (typeof v === "boolean") {
        // GPT doctrine v4: booleans are IMPLEMENTATION STATE, not features.
        // Never coerce to 0/1 in summary — could accidentally leak into
        // recognition signal. Preserve raw in flags only.
        flags[k] = v;
      } else if (typeof v === "string") {
        // Same: categorical metadata, not feature dimension
        flags[k] = v;
      } else if (Array.isArray(v) || v instanceof Float32Array || v instanceof Float64Array) {
        structuredFields[k] = Array.from(v);
      } else if (v && typeof v === "object") {
        structuredFields[k] = v;
      } else if (v === null || v === undefined) {
        // null/undefined explicitly noted, not silently dropped
        flags[k] = null;
      } else {
        skipped.push({ key: k, valueType: typeof v, sample: String(v).slice(0, 40) });
      }
    }
    // Rule 4: throw if anything genuinely unsupported ended up skipped
    if (skipped.length > 0) {
      throw new Error(`PhotonCaptureRecord: axis ${axisName} had unsupported field types: ${JSON.stringify(skipped)}`);
    }
    out[axisName] = {
      promotion,
      present: true,
      summary,                     // named scalars (dict, not flat) + booleans as 0/1
      flags,                       // booleans + strings + null (preserved raw)
      structuredFields,            // arrays / objects preserved
      cells,                       // structured cells if the axis emits them
      localMapRef: axis._localMapRef ?? null,  // pending step 3 (pre-pooling tap)
      barcodeRef: axis._barcodeRef ?? null,    // pending for persistent_homology
    };
  }
  return out;
}

// --- retinal-12 availability-aware lane construction (GPT v5) ---
function buildRetinal12Lane(can) {
  const r12 = can.retinal_12 ?? {};
  const spatialSummary = {};
  const temporalUnavailable = {};
  for (const [k, v] of Object.entries(r12)) {
    if (TEMPORAL_RETINAL_CHANNELS.has(k)) {
      temporalUnavailable[k] = { valid: false, availability: "TEMPORAL_INPUT_UNAVAILABLE", value: null };
    } else if (typeof v === "number" && Number.isFinite(v)) {
      spatialSummary[k] = v;
    }
  }
  return {
    promotion: "promote",
    availability: "PARTIAL",
    spatialChannels: {
      valid: true,
      availability: "SPATIAL_AVAILABLE",
      summary: spatialSummary,
    },
    temporalChannels: {
      valid: false,
      availability: "TEMPORAL_INPUT_UNAVAILABLE",
      channels: temporalUnavailable,
      note: "v1.0-STATIC does not compute temporal difference. v1.1 will emit these when a temporal window is supplied.",
    },
    localMapRef: can.retinal_12_local_map_ref ?? null,
    activeMask: can.retinal_12_active_mask ?? null,
    confidence: can.retinal_12_confidence ?? 1.0,
  };
}

// --- LGN availability-aware lane construction (GPT v5) ---
function buildLgnLane(can) {
  const lgn = can.lgn ?? {};
  return {
    promotion: "watch",
    parvo: {
      valid: true,
      availability: "SPATIAL_AVAILABLE",
      values: lgn.parvo ?? null,
      localMapRef: lgn.parvo_map_ref ?? null,
    },
    magno: {
      valid: false,
      availability: "TEMPORAL_INPUT_UNAVAILABLE",
      temporalWindow: null,
      values: null,
      activeMask: [false, false, false, false, false],
      confidence: 0,
      note: "Magno is temporal by definition. v1.0-STATIC captures no temporal window. Awaiting v1.1 3-frame ingest.",
    },
    konio: {
      valid: true,
      availability: "SPATIAL_AVAILABLE",
      specialization: "CHROMATIC_BLUE_YELLOW",
      values: lgn.konio ?? null,
      localMapRef: lgn.konio_map_ref ?? null,
      note: "Konio is specialized for blue-yellow chromatic. Preservation on non-chromatic pair distinctions is not required.",
    },
    confidence: lgn.confidence ?? null,
  };
}

function computeClipping(can) {
  // Placeholder — Step 3 will populate from actual iris/exposure taps
  return { r: null, g: null, b: null, l: null };
}

function computeUnderexposure(can) {
  return { fraction: null, note: "pending iris tap in Wave 1 Step 3" };
}

function computeLaneValidity(can) {
  const validity = {};
  if (can.retinal_12) validity.retinal_12 = Object.values(can.retinal_12).some(v => v !== 0);
  if (can.lgn) validity.lgn = !!can.lgn.parvo;
  if (can.axis_bundle) {
    for (const axis of [...PROMOTE_AXES, ...QUARANTINE_AXES, ...WATCH_AXES]) {
      const a = can.axis_bundle[axis];
      validity[`axis_${axis}`] = !!(a && !a._error);
    }
  }
  if (can.it_vector) validity.it_80 = can.it_vector.length === 80;
  return validity;
}

function computeWarnings(can) {
  const warns = [];
  if (!can.retinal_12) warns.push("retinal_12 missing");
  if (!can.axis_bundle) warns.push("axis_bundle missing");
  if (!can.it_vector) warns.push("it_vector missing");
  for (const axis of [...PROMOTE_AXES, ...QUARANTINE_AXES, ...WATCH_AXES]) {
    const a = can.axis_bundle?.[axis];
    if (!a) warns.push(`axis ${axis} missing`);
    else if (a._error) warns.push(`axis ${axis} error: ${a._error}`);
  }
  return warns;
}

/**
 * Score a PhotonCaptureRecord — quick sanity dashboard.
 * Returns lane-level presence + which axes are promoted / quarantined / watched.
 */
export function scoreRecord(record) {
  if (!record || record.schema !== SCHEMA_VERSION) {
    return { valid: false, error: `bad schema: ${record?.schema}` };
  }
  const axes = record.lanes.axisBundle.axes;
  const promoted = Object.entries(axes).filter(([_, a]) => a.promotion === "promote" && a.present).map(([n]) => n);
  const quarantined = Object.entries(axes).filter(([_, a]) => a.promotion === "quarantine" && a.present).map(([n]) => n);
  const watched = Object.entries(axes).filter(([_, a]) => a.promotion === "watch" && a.present).map(([n]) => n);
  const missing = Object.entries(axes).filter(([_, a]) => !a.present).map(([n]) => n);
  return {
    valid: true,
    schema: record.schema,
    promoted_count: promoted.length,
    quarantined_count: quarantined.length,
    watched_count: watched.length,
    missing_count: missing.length,
    it80_status: record.lanes.it80.status,
    warnings_count: record.quality.warnings.length,
  };
}
