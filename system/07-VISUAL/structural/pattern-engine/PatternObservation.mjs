// PatternObservation.mjs — the contract Pattern Engine consumes.
//
// GOVERNED BY: 00-CHARTER/AWE_3_GOVERNING_STATE_2026-07-09.md §6
//
// Every exposure enters the Pattern Engine as a structured event carrying
// FULL cortical trace + provenance. The Pattern Engine does NOT reinvent
// the cortex; it stores RELATIONSHIPS among valid cortical observations.
//
// Division of labor (charter §6):
//   IT-80          → fast candidate retrieval
//   Pattern Engine → persistent identity formation
//                    transformation mapping
//                    cross-view binding
//                    partial-pattern completion
//                    collision resolution
//                    temporal continuity
//                    novelty detection

/**
 * Build a PatternObservation from a canonical output.
 *
 * @param can    — canonical output from captureCanonicalPhoton
 * @param opts   — { identity_candidate, source_domain, timestamp, raw_evidence_ref, recognition_margin }
 * @returns      PatternObservation
 */
export function buildPatternObservation(can, opts = {}) {
  const now = opts.timestamp ?? -1;   // avoid Date.now() to keep test determinism; caller sets it
  return {
    // recognition primitive (from IT layer)
    identity_candidate: opts.identity_candidate ?? null,
    it80: Array.from(can.it_vector || []),

    // full cortical trace — Pattern Engine picks what it needs
    retinal12: can.retinal_12 ?? {},
    axis15: Object.fromEntries(
      Object.entries(can.axis_bundle || {}).map(([k, v]) => [k, sanitizeAxis(v)])
    ),
    lgn_streams: {
      parvo: can.lgn?.parvo ?? null,
      magno: can.lgn?.magno ?? null,
      konio: can.lgn?.konio ?? null,
      flat:  can.lgn?.flat ?? null,
    },
    v1_response: sanitizeSummary(can.v1_summary),
    v2_response: sanitizeSummary(can.v2_summary),
    v4_response: sanitizeSummary(can.v4_summary),

    // active sampling trace
    fixation_sequence: opts.fixation_sequence ?? [],   // Array<{x, y, saliency, region}>

    // illuminant + adaptive state (from iris + meta)
    illuminant_state: {
      chromaticity: can.meta?.illuminant?.c ?? null,
      confidence:   can.meta?.illuminant?.confidence ?? null,
      gain:         can.iris?.aperture_gain ?? null,
      dr_stops_in:  can.iris?.dr_stops_in ?? null,
      dr_stops_out: can.iris?.dr_stops_out ?? null,
    },

    // rod/cone dominance from the rod pathway module
    rod_cone_balance: can.rod?.sensitivity_gain ?? 0,

    // provenance (never lose this — Pattern Engine can walk back to raw photon print)
    source_domain:      opts.source_domain ?? "unknown",
    timestamp:          now,
    raw_evidence_ref:   opts.raw_evidence_ref ?? null,

    // decision quality — margin between top-1 and top-2, and derived uncertainty
    recognition_margin: opts.recognition_margin ?? null,
    uncertainty:        opts.recognition_margin !== null
      ? 1 - clamp01(opts.recognition_margin)
      : 1.0,
  };
}

function sanitizeAxis(axis) {
  if (!axis || axis._error) return { _error: axis?._error ?? "missing" };
  const out = {};
  for (const [k, v] of Object.entries(axis)) {
    if (k.startsWith("_")) continue;
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function sanitizeSummary(s) {
  if (!s) return null;
  const out = {};
  for (const [k, v] of Object.entries(s)) {
    if (typeof v === "number" && Number.isFinite(v)) out[k] = v;
  }
  return out;
}

function clamp01(v) { return Math.max(0, Math.min(1, v)); }

/**
 * Extract minimal-fingerprint from a PatternObservation for graph edge
 * candidacy without carrying full cortical payload.
 */
export function fingerprint(obs) {
  return {
    it80: obs.it80,
    illum: obs.illuminant_state?.chromaticity,
    domain: obs.source_domain,
    ts: obs.timestamp,
    ref: obs.raw_evidence_ref,
  };
}

/**
 * Compact PatternObservation → bytes-only view for storage-truth accounting.
 * Excludes lossless-recoverable derived values (e.g., can be re-computed from
 * raw_evidence_ref if needed).
 */
export function compactObservation(obs) {
  return {
    identity_candidate: obs.identity_candidate,
    it80: obs.it80,                                      // 320B
    illum: obs.illuminant_state?.chromaticity,            // 12B
    illumConf: obs.illuminant_state?.confidence,          // 4B
    domain: obs.source_domain,                            // ~16B
    ts: obs.timestamp,                                    // 8B
    ref: obs.raw_evidence_ref,                            // ~32B
    margin: obs.recognition_margin,                       // 4B
    // Total compact ~= 400 bytes; full cortical trace re-derivable from ref.
  };
}
