// 07-VISUAL/structural/cache-identity.mjs
//
// Freeze gate 7 (GPT doctrine v5 checkpoint 6, post-seq 117): cache identity
// generated INSIDE the pipeline, not by callers. A dependency fingerprint
// includes every axis version so a change to any component invalidates the
// whole record. No caller can accidentally mix stale evidence.
//
// v1.0 uses whole-record invalidation for simplicity. Per-lane cache is
// intentionally deferred to v1.1+ where a real dependency DAG can be declared.

import { hashField } from "./axis-tap.mjs";

// ---- Version constants for every axis + pipeline stage ----
// These MUST be bumped when the corresponding implementation changes.
// Bumping without semantic change is fine — the point is that the LINEAGE is
// visible in the cache key, so callers can never mix outputs across versions.
export const LINEARIZE_VERSION = "linearize-1.0";
export const IRIS_VERSION = "iris-1.0";
export const CAT02_VERSION = "cat02-1.0";
export const FOVEAL_VERSION = "foveal-log-polar-1.0";
export const ROD_PATHWAY_VERSION = "rod-1.0";
export const RETINAL12_VERSION = "retinal12-1.0-static";
export const LGN_VERSION = "lgn-parvo-magno-konio-1.0-static";
export const V1_VERSION = "v1-24gabor-1.0";
export const V2_VERSION = "v2-contour-1.0";
export const V4_VERSION = "v4-shape-1.0";
export const IT80_VERSION = "it80-1.0";
export const SACCADES_VERSION = "saccades-1.0";

export const SPATIAL_COLOR_VERSION = "spatial_color-2.0.0";
export const RADIAL_PHOTON_VERSION = "radial_photon-2.0.0";   // bumped after zero-support fix
export const SUBSURFACE_VERSION = "subsurface-1.0";
export const FOURIER_MELLIN_VERSION = "fourier_mellin-1.0";
export const EDGE_VERSION = "edge-1.0";
export const SPECULAR_VERSION = "specular-1.0";
export const SPATIAL_FREQUENCY_VERSION = "spatial_frequency-1.0";
export const TEXTURE_VERSION = "texture-2.0.0";
export const PHOTON_HISTOGRAM_VERSION = "photon_histogram-1.0";
export const PHOTON_CORRELATION_VERSION = "photon_correlation-1.0";
export const COLOR_RATIO_VERSION = "color_ratio-1.0";
export const DICHROMATIC_VERSION = "dichromatic-1.0";
export const HU_MOMENTS_VERSION = "hu_moments-1.0";
export const PERSISTENT_HOMOLOGY_VERSION = "persistent_homology-1.0.1";   // bumped after binder.persistence exposure
export const TEXTURE_VOCAB_VERSION = "texture_vocab-1.0";
export const TEMPORAL_SPECTRUM_VERSION = "temporal_spectrum-1.0-static-unavailable";

export const PIPELINE_VERSION = "aeyes1-photon-capture-1.0-static";
export const RUNTIME_NUMERIC_MODE = "float32-cache-float64-inter";

// Build the complete dependency fingerprint for a capture.
export function buildCacheIdentity({
  sourceHash,
  configHash = "default",
  captureSchema = "AEYES1-PHOTON-CAPTURE-1.0-STATIC",
} = {}) {
  const dependencies = {
    linearize: LINEARIZE_VERSION,
    iris: IRIS_VERSION,
    cat02: CAT02_VERSION,
    foveal: FOVEAL_VERSION,
    rod_pathway: ROD_PATHWAY_VERSION,
    retinal12: RETINAL12_VERSION,
    lgn: LGN_VERSION,
    v1: V1_VERSION,
    v2: V2_VERSION,
    v4: V4_VERSION,
    it80: IT80_VERSION,
    saccades: SACCADES_VERSION,
    spatial_color: SPATIAL_COLOR_VERSION,
    radial_photon: RADIAL_PHOTON_VERSION,
    subsurface: SUBSURFACE_VERSION,
    fourier_mellin: FOURIER_MELLIN_VERSION,
    edge: EDGE_VERSION,
    specular: SPECULAR_VERSION,
    spatial_frequency: SPATIAL_FREQUENCY_VERSION,
    texture: TEXTURE_VERSION,
    photon_histogram: PHOTON_HISTOGRAM_VERSION,
    photon_correlation: PHOTON_CORRELATION_VERSION,
    color_ratio: COLOR_RATIO_VERSION,
    dichromatic: DICHROMATIC_VERSION,
    hu_moments: HU_MOMENTS_VERSION,
    persistent_homology: PERSISTENT_HOMOLOGY_VERSION,
    texture_vocab: TEXTURE_VOCAB_VERSION,
    temporal_spectrum: TEMPORAL_SPECTRUM_VERSION,
  };

  const identity = {
    sourceHash: sourceHash ?? "unset",
    captureSchema,
    pipelineVersion: PIPELINE_VERSION,
    configHash,
    runtimeNumericMode: RUNTIME_NUMERIC_MODE,
    dependencies,
  };

  const cacheKey = hashCacheIdentity(identity);
  return { identity, cacheKey };
}

// Canonical hash of the identity object (stable across processes / OS).
export function hashCacheIdentity(identity) {
  const canonical = canonicalJson(identity);
  return hashField(new Float32Array(canonical.split("").map(c => c.charCodeAt(0))));
}

function canonicalJson(obj) {
  if (obj === null || obj === undefined) return "null";
  if (typeof obj === "number") return Number.isFinite(obj) ? String(obj) : (Number.isNaN(obj) ? "\"NaN\"" : String(obj));
  if (typeof obj === "string") return JSON.stringify(obj);
  if (typeof obj === "boolean") return obj ? "true" : "false";
  if (Array.isArray(obj)) return "[" + obj.map(canonicalJson).join(",") + "]";
  if (typeof obj === "object") {
    const keys = Object.keys(obj).sort();
    return "{" + keys.map(k => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + "}";
  }
  return "null";
}

// ---- Cache miss/hit semantics ----
// A cache entry is valid only when identity.cacheKey matches AND all constituent
// versions match. If ANY dependency version differs → miss.
export function isCacheHit(storedIdentity, currentIdentity) {
  if (!storedIdentity || !currentIdentity) return false;
  if (storedIdentity.sourceHash !== currentIdentity.sourceHash) return false;
  if (storedIdentity.captureSchema !== currentIdentity.captureSchema) return false;
  if (storedIdentity.pipelineVersion !== currentIdentity.pipelineVersion) return false;
  if (storedIdentity.configHash !== currentIdentity.configHash) return false;
  if (storedIdentity.runtimeNumericMode !== currentIdentity.runtimeNumericMode) return false;
  const storedDeps = storedIdentity.dependencies || {};
  const currentDeps = currentIdentity.dependencies || {};
  const allKeys = new Set([...Object.keys(storedDeps), ...Object.keys(currentDeps)]);
  for (const k of allKeys) {
    if (storedDeps[k] !== currentDeps[k]) return false;
  }
  return true;
}
