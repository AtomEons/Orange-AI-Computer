// 07-VISUAL/structural/physical-retinal-transform.mjs
//
// Composes the photoreceptor (Naka-Rushton + adaptation) stage IN FRONT of
// M3's retinal-transform. This is the version that runs the four fields on
// the biological signal R(x,y,t), not on raw luminance L(x,y,t).
//
// Non-destructive: M3's retinal-transform.mjs is imported read-only. Its
// existing 9/9 test suite is untouched.
//
// Contract: same output schema (ae.structural-tokens.v1), same input shape
// as transformImage / transformSequence, plus adaptation-state threading
// across frames and honest photoreceptor notes appended to record.notes[].

import { transformImage, transformSequence } from "./retinal-transform.mjs";
import {
  initAdaptationState,
  photoreceptorResponse,
  honestNotes as photoreceptorNotesFn,
} from "./photoreceptor.mjs";

export const WIRED_VERSION_SUFFIX = "+photoreceptor.v1";

function normalizeIntoFloat32(data) {
  if (data instanceof Float32Array) return data;
  if (data instanceof Uint8Array) {
    const out = new Float32Array(data.length);
    for (let i = 0; i < data.length; i++) out[i] = data[i] / 255;
    return out;
  }
  const out = new Float32Array(data.length);
  for (let i = 0; i < data.length; i++) out[i] = Number(data[i]) || 0;
  return out;
}

/**
 * Single-frame path: Naka-Rushton at the initial adaptation state (K=K0).
 * Adaptation cannot advance without a dt; this is honest and disclosed.
 * Returns { record, photoreceptorMeta, photoreceptorState }.
 */
export async function transformImageWithPhotoreceptor({ data, meta }, opts = {}) {
  const cfg = opts.photoreceptor || {};
  const state = initAdaptationState(cfg);
  const L = normalizeIntoFloat32(data);

  const pr = photoreceptorResponse(L, state, null);
  // Feed R (retinal signal) into M3's still-image transform.
  const record = await transformImage({
    data: pr.R,
    meta: { ...meta, _photoreceptor_wired: true },
  });

  attachPhotoreceptorProvenance(record, pr.meta, pr.state, {
    scope: "still",
    frames_wired: 1,
    peak_saturated_fraction: pr.meta.saturatedFraction,
    extra_notes: photoreceptorNotesFn(pr.meta, pr.state),
  });
  return { record, photoreceptorMeta: pr.meta, photoreceptorState: pr.state };
}

/**
 * Sequence path: adaptation STATE IS THREADED across frames. K evolves toward
 * the running mean luminance with the configured τ, exactly the way a real
 * retina adapts to a changing scene. Each frame's R is what the four-field
 * extractor sees.
 * Returns { record, photoreceptorState, photoreceptorMetaByFrame }.
 */
export async function transformSequenceWithPhotoreceptor({ frames, meta }, opts = {}) {
  if (!Array.isArray(frames) || frames.length < 1) {
    throw new Error("transformSequenceWithPhotoreceptor: frames must be a non-empty array");
  }
  const cfg = opts.photoreceptor || {};
  let state = initAdaptationState(cfg);

  const wiredFrames = new Array(frames.length);
  const metaByFrame = new Array(frames.length);
  const stageNotes = [];
  let peakSat = 0;

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i];
    const L = normalizeIntoFloat32(f.data);
    const tsMs = Number.isFinite(f.ts_ms) ? f.ts_ms : null;
    const pr = photoreceptorResponse(L, state, tsMs);
    state = pr.state;
    wiredFrames[i] = { data: pr.R, ts_ms: tsMs };
    metaByFrame[i] = pr.meta;
    if (pr.meta.saturatedFraction > peakSat) peakSat = pr.meta.saturatedFraction;
    for (const n of photoreceptorNotesFn(pr.meta, state)) {
      if (!stageNotes.includes(n)) stageNotes.push(n);
    }
  }

  const record = await transformSequence({
    frames: wiredFrames,
    meta: { ...meta, _photoreceptor_wired: true },
  });

  attachPhotoreceptorProvenance(record, metaByFrame[0], state, {
    scope: "sequence",
    frames_wired: frames.length,
    peak_saturated_fraction: peakSat,
    extra_notes: stageNotes,
  });
  return { record, photoreceptorState: state, photoreceptorMetaByFrame: metaByFrame };
}

function attachPhotoreceptorProvenance(record, firstMeta, finalState, info) {
  // Extend translator_version so downstream can tell the wired path apart from
  // the raw-L path — provenance is a first-class field in the schema.
  const prev = record.provenance?.translator_version || "unknown";
  if (record.provenance) {
    record.provenance.translator_version = prev + WIRED_VERSION_SUFFIX;
  }
  const baseNote =
    info.scope === "still"
      ? `photoreceptor: four fields computed on R (Naka-Rushton n=${firstMeta.n}, ` +
        `K=${firstMeta.K.toFixed(4)}), NOT raw L. Single frame — no adaptation advance.`
      : `photoreceptor: four fields computed on R per-frame with adaptation state ` +
        `threaded across ${info.frames_wired} frames (n=${firstMeta.n}, ` +
        `final K=${finalState.K.toFixed(4)}, peak saturation ${(info.peak_saturated_fraction * 100).toFixed(1)}%).`;
  record.notes = [
    ...(Array.isArray(record.notes) ? record.notes : []),
    baseNote,
    ...(info.extra_notes || []),
  ];
}
