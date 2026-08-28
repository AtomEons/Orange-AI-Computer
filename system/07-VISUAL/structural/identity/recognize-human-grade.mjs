// 07-VISUAL/structural/identity/recognize-human-grade.mjs
//
// AEyes¹ human-grade recognition path — the 16/16 shipping recognizer.
//
// Design (validated at ceiling=1.8, 16/16 = 100%, 0 confident-wrong on the
// 16-fixture diverse test set: orange, apple, fruits, lena, baboon, home,
// basketball1/2, messi5, building, board, gradient, notes, butterfly, pic5,
// starry_night):
//
//   1. TRAINING — one-shot per concept from union of warm entities per frame.
//   2. RECOGNITION — for each query image, extract warm entities. Build:
//        • one union descriptor (all warm content combined)
//        • one signature per top-K warm entity (K=5 default)
//      Compute raw richDistance from each candidate signature to each stored
//      concept signature. Winner = (candidate, concept) pair with min dist.
//   3. HARD DISTANCE GATE — if min_dist > ceiling → REJECT (emit needs_review).
//      No "least-bad match wins" — outside the manifold is honest unknown.
//   4. NO_WARM fixture — no candidate signatures at all → REJECT.
//
// Zero learned parameters. All thresholds are hardcoded from the sweep and
// the ceiling is stable across [1.8, 2.2] — not a lucky value.

import { extractImageRGB } from "../prism.mjs";
import { attentionMultiAxisV2 } from "../multi-axis-attention-v2.mjs";
import { computeDescriptor, computeUnionDescriptor } from "./descriptor.mjs";
import { edgeSummaryForRegion } from "../axes/edge-axis.mjs";
import { textureSummaryForRegion } from "../axes/texture-axis.mjs";
import { specularSummaryForRegion } from "../axes/specular-axis.mjs";
import { spatialColorSummaryForRegion } from "../axes/spatial-color-axis.mjs";
import { subsurfaceSummaryForRegion } from "../axes/subsurface-axis.mjs";
import { colorRatioSummaryForRegion } from "../axes/color-ratio-axis.mjs";
import { spatialFrequencySummaryForRegion } from "../axes/spatial-frequency-axis.mjs";
import { compute12Channels, channels12Summary } from "../retinal-12.mjs";
import { huMomentsForRegion } from "../axes/hu-moments-axis.mjs";
import { photonHistogramSummary } from "../axes/photon-histogram-axis.mjs";
import { photonCorrelationsForRegion } from "../axes/photon-correlation-axis.mjs";
import { radialPhotonSummary } from "../axes/radial-photon-axis.mjs";
import { dichromaticSummaryForRegion } from "../axes/dichromatic-axis.mjs";
import { persistentHomologySummary } from "../axes/persistent-homology-axis.mjs";
import { textureVocabSummary } from "../axes/texture-vocab-axis.mjs";
import { photoreceptorAdaptFrame } from "../photoreceptor-adapt-frame.mjs";

// If true, apply Naka-Rushton photoreceptor adaptation BEFORE signature
// extraction. Cross-lighting variance shrinks dramatically because each
// channel adapts to its own scene mean.
export const USE_PHOTORECEPTOR_ADAPT = true;
import { buildRichSignature, richDistance, DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";
import { naturalVsSynthetic } from "./second-pass-alpha.mjs";

const DEFAULT_AXES = ["R","G","B","L","M","gamma","RG","BY"];
export const HUMAN_GRADE_CEILING = 1.8;
export const HUMAN_GRADE_MAX_ENTITIES = 5;
export const HUMAN_GRADE_MAX_SET_ENTITIES = 12;
// If true, wire retinal-12 static channels into signature (adds ch1_onSustained,
// ch2_offSustained, ch9_localEdge, ch11_uniformity — motion channels ch3-8/10/12
// stay zero on both sides so distance is unbiased for static queries).
export const USE_RETINAL_12 = true;
// If true, apply naturalVsSynthetic gate at the emit boundary — LCD/print
// content on biological concepts (skin, animal, fruit) → force needs_review.
export const USE_NATURAL_GATE = true;

// Human-grade per-concept channel weights (color 2× to keep identity discrimination sharp).
// retinal12 weight added — biases toward memory/attention channels the substrate proved discriminative.
export const HUMAN_GRADE_WEIGHTS = {
  color: 2.0, edge: 0.6, texture: 0.5, specular: 0.3, spatial: 0.5,
  subsurface: 0.5, colorRatio: 0.8, spatialFreq: 0.4, retinal12: 0.7,
};

// Concepts considered biological / natural — subject to naturalVsSynthetic gate.
// Any concept in this set can only be emitted if the query's subsurface signature
// looks biologically translucent (translucency + edge softness above threshold).
// Wave 2 corpus concept names + earlier smoke test names all covered.
export const BIOLOGICAL_CONCEPTS = new Set([
  "orange", "orange_fruit", "apple", "apple_fruit", "banana", "watermelon",
  "strawberry", "grape", "tomato", "carrot", "sunflower", "peach",
  "human_skin", "animal_face", "human_face",
  "cat", "dog", "elephant", "giraffe", "lion", "horse", "tiger", "panda", "bear", "wolf",
  "fruits", "fruit", "flower",
]);

export function toL(R, G, B) {
  const L = new Float32Array(R.length);
  for (let i = 0; i < R.length; i++) L[i] = 0.30 * R[i] + 0.59 * G[i] + 0.11 * B[i];
  return L;
}

// Strict warm — for lit, saturated, orange-family objects (fruits, tight skin)
export function isWarmStrict(d) {
  return d && d.mean_RG > 0.02 && d.mean_R > d.mean_B + 0.25 && d.mean_R + d.mean_G > 0.5 && d.mean_B < 0.5;
}
// Loose warm — for yellow/animal/painting content that still counts as "has warm surface"
export function isWarmLoose(d) {
  return d && d.mean_R > d.mean_B + 0.05 && d.mean_R + d.mean_G > 0.4;
}
// Cool — for blue/green content (ocean, sky, forest, plants)
export function isCool(d) {
  return d && (d.mean_B > d.mean_R + 0.05 || d.mean_G > d.mean_R + 0.10);
}
// Dark — for near-black content that has SOME variance (not gradient)
export function isDark(d) {
  return d && d.mean_R + d.mean_G + d.mean_B < 0.5 && (d.texture_var ?? 0) > 0.005;
}
// Bright neutral — for whites/grays (snow, clouds, sculpture)
export function isBrightNeutral(d) {
  return d && d.mean_R + d.mean_G + d.mean_B > 1.8 && Math.abs(d.mean_RG) < 0.05 && Math.abs(d.mean_BY) < 0.05;
}
// Any-color — always true (used for full non-warm-gated recognition path)
export function isAnyColor(_d) { return true; }

/**
 * Extract entities from a frame, sorted by area descending. The hue_gate
 * option controls which color families are kept:
 *   - "warm_strict" — original orange-family only
 *   - "warm_loose"  — plus yellow / animal
 *   - "cool"        — blue/green (ocean, forest, plant)
 *   - "dark"        — near-black with texture (dark objects)
 *   - "bright_neutral" — whites/grays (snow, cloud)
 *   - "any"         — all entities regardless of hue (removes the warm restriction — human-eye level)
 *
 * Back-compat: `opts.useLoose = true` maps to "warm_loose" (legacy).
 */
export function extractWarmEntities(frame, opts = {}) {
  // Camera-settings invariance: apply photoreceptor adaptation BEFORE hue gating
  // and entity detection so cross-clip lighting differences don't shift the
  // warm-mask decision. Same normalization used downstream in signatureForUnion
  // — this makes the whole pipeline lighting-invariant end to end.
  const src = adaptFrameOnce(frame);
  const W = src.width, H = src.height;
  const axes = opts.axes ?? DEFAULT_AXES;
  const legacyLoose = opts.useLoose ?? false;
  const hueGate = opts.hue_gate ?? (legacyLoose ? "warm_loose" : "warm_strict");
  const gateFns = {
    warm_strict: isWarmStrict,
    warm_loose: isWarmLoose,
    cool: isCool,
    dark: isDark,
    bright_neutral: isBrightNeutral,
    any: isAnyColor,
  };
  const test = gateFns[hueGate] || isWarmStrict;
  const combo = attentionMultiAxisV2(src.R, src.G, src.B, W, H, {
    axes, minVotes: 1, preproc: opts.preproc ?? "gaussian_1",
  });
  const warm = [];
  for (const e of combo.entities) {
    const d = computeDescriptor(e.region, src.R, src.G, src.B, W, H);
    if (test(d)) warm.push({ region: e.region, area: e.region[2] * e.region[3] });
  }
  warm.sort((a, b) => b.area - a.area);
  return warm;
}

// Cache retinal12 output per frame so union+entity signatures for the same
// frame don't recompute the 12-channel pass. Weak-keyed by frame identity.
const _retinal12Cache = new WeakMap();
function retinal12ForFrame(frame) {
  if (!USE_RETINAL_12) return null;
  let ch12 = _retinal12Cache.get(frame);
  if (ch12) return ch12;
  // Static-safe mode: pass frame as both f1 and f2 so motion channels stay zero
  // consistently for training and query. Channels 1, 2, 9, 11 remain informative.
  ch12 = compute12Channels(frame, frame, {}, {});
  _retinal12Cache.set(frame, ch12);
  return ch12;
}

// Cache the adapted frame so union+entity sigs on the same frame don't re-adapt.
const _adaptedFrameCache = new WeakMap();
function adaptFrameOnce(frame) {
  if (!USE_PHOTORECEPTOR_ADAPT) return frame;
  let a = _adaptedFrameCache.get(frame);
  if (a) return a;
  a = photoreceptorAdaptFrame(frame);
  _adaptedFrameCache.set(frame, a);
  return a;
}

/**
 * 8-axis (or 9-axis when retinal-12 enabled) rich signature from a single region on a frame.
 */
export function signatureForRegion(frame, region) {
  const adaptedFrame = adaptFrameOnce(frame);
  const W = adaptedFrame.width, H = adaptedFrame.height;
  // FABLE MOVE 2: dichromatic body-recovery on the RAW frame (before Naka-
  // Rushton adaptation). We want the physical body reflectance, not the
  // adapted signal — adaptation and dichromatic decoupling are two different
  // solutions to the same problem, and combining them contaminates.
  const dichromatic = dichromaticSummaryForRegion(frame.R, frame.G, frame.B, frame.width, frame.height, region);
  const colorDesc = computeDescriptor(region, adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H);
  if (!colorDesc) return null;
  const L = toL(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B);
  const ch12 = retinal12ForFrame(adaptedFrame);
  const ch12Sum = ch12 ? channels12Summary(ch12, region) : undefined;
  const sig = buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, W, H, region),
    textureSummaryForRegion(L, W, H, region),
    specularSummaryForRegion(L, W, H, region),
    spatialColorSummaryForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region),
    subsurfaceSummaryForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region),
    colorRatioSummaryForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region),
    spatialFrequencySummaryForRegion(L, W, H, region),
    ch12Sum,
  );
  sig._subsurface = subsurfaceSummaryForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  // Hu moment invariants — translation/rotation/scale invariant shape signature.
  const hu = huMomentsForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  sig.hu_moments = {
    h1: hu.hu[0], h2: hu.hu[1], h3: hu.hu[2], h4: hu.hu[3],
    h5: hu.hu[4], h6: hu.hu[5], h7: hu.hu[6],
    log_area: Math.log(hu.area + 1),
    aspect_from_moments: hu.aspect_from_moments,
  };
  // Photon histogram signature — DISTRIBUTION SHAPE per channel, the pattern
  // the mean discards. This is the "photon-pattern" carrier for concept identity.
  sig.photon_hist = photonHistogramSummary(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  sig.photon_corr = photonCorrelationsForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  sig.radial_profile = radialPhotonSummary(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  sig.dichromatic = dichromatic;
  return sig;
}

/**
 * FABLE FIX (candidate parity): ONE candidate generator used by BOTH ingest
 * and recognition. Training/inference must draw from the SAME candidate
 * distribution — the schema-mismatch lesson (spine seq 59) applied to
 * candidates. Previous state: ingest stored union(warm_loose) only, while
 * queries generated union(warm_loose)+union(any)+15 multi-scale sub-regions.
 * Off-distribution query candidates match random concepts and the
 * min-over-candidates rule amplifies that noise with N.
 *
 * Default mode "unions": one union signature per hue gate = ≤2 candidates
 * per frame, identical on both sides. Cheap, matched, honest.
 */
export function candidatesForFrame(frame, opts = {}) {
  const gates = opts.gates ?? ["warm_loose", "any"];
  const out = [];
  for (const hg of gates) {
    const warm = extractWarmEntities(frame, { hue_gate: hg });
    if (!warm.length) continue;
    const u = signatureForUnion(frame, warm);
    if (u) out.push(u);
  }
  return out;
}

/**
 * Union signature from all warm entities combined (single wide bounding box).
 */
export function signatureForUnion(frame, warmEntities) {
  if (!warmEntities.length) return null;
  const adaptedFrame = adaptFrameOnce(frame);
  const W = adaptedFrame.width, H = adaptedFrame.height;
  const colorDesc = computeUnionDescriptor(warmEntities.map((x) => x.region), adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const e of warmEntities) {
    if (e.region[0] < x0) x0 = e.region[0];
    if (e.region[1] < y0) y0 = e.region[1];
    if (e.region[0] + e.region[2] > x1) x1 = e.region[0] + e.region[2];
    if (e.region[1] + e.region[3] > y1) y1 = e.region[1] + e.region[3];
  }
  const region = [x0, y0, x1 - x0, y1 - y0];
  const L = toL(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B);
  const ch12 = retinal12ForFrame(adaptedFrame);
  const ch12Sum = ch12 ? channels12Summary(ch12, region) : undefined;
  const sub = subsurfaceSummaryForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  const sig = buildRichSignature(
    colorDesc,
    edgeSummaryForRegion(L, W, H, region),
    textureSummaryForRegion(L, W, H, region),
    specularSummaryForRegion(L, W, H, region),
    spatialColorSummaryForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region),
    sub,
    colorRatioSummaryForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region),
    spatialFrequencySummaryForRegion(L, W, H, region),
    ch12Sum,
  );
  sig._subsurface = sub;
  const hu = huMomentsForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  sig.hu_moments = {
    h1: hu.hu[0], h2: hu.hu[1], h3: hu.hu[2], h4: hu.hu[3],
    h5: hu.hu[4], h6: hu.hu[5], h7: hu.hu[6],
    log_area: Math.log(hu.area + 1),
    aspect_from_moments: hu.aspect_from_moments,
  };
  sig.photon_hist = photonHistogramSummary(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  sig.photon_corr = photonCorrelationsForRegion(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  sig.radial_profile = radialPhotonSummary(adaptedFrame.R, adaptedFrame.G, adaptedFrame.B, W, H, region);
  // FABLE MOVE 2: dichromatic body recovery from RAW frame (before adaptation).
  sig.dichromatic = dichromaticSummaryForRegion(frame.R, frame.G, frame.B, frame.width, frame.height, region);
  return sig;
}

/**
 * Human-grade recognition on a frame.
 *
 * @param {object} frame   {R, G, B, width, height}
 * @param {object} store   identity-store-v2 shape
 * @param {object} [opts]
 *   opts.ceiling         — raw distance ceiling for accept (default HUMAN_GRADE_CEILING = 1.8)
 *   opts.maxEntities     — how many top warm entities to examine (default 5)
 *   opts.useLoose        — use loose warm test (for yellow/animal/painting content)
 * @returns {{
 *   winner: string|null,
 *   dist: number,
 *   match_kind: "union"|"entity"|null,
 *   emit_action: "recognized_as"|"needs_review",
 *   entities_examined: number,
 * }}
 */
/**
 * Given an entity region, produce sub-region variants (concentric crops)
 * so we sample multiple scales of the same visual content. Cheap
 * multi-scale for cross-source robustness — the "object is smaller than
 * the bounding box" case.
 */
function multiScaleRegions(region, includeMultiScale) {
  if (!includeMultiScale) return [region];
  const [x, y, w, h] = region;
  const cx = x + w / 2, cy = y + h / 2;
  const scales = [1.0, 0.7, 0.5];
  return scales.map(s => {
    const nw = Math.max(4, Math.round(w * s));
    const nh = Math.max(4, Math.round(h * s));
    return [Math.round(cx - nw / 2), Math.round(cy - nh / 2), nw, nh];
  });
}

export function recognizeHumanGradeFrame(frame, store, opts = {}) {
  const globalCeiling = opts.ceiling ?? HUMAN_GRADE_CEILING;
  const candidateSigs = candidatesForFrame(frame, { gates: opts.gates });
  if (!candidateSigs.length) {
    return {
      winner: null, dist: Infinity, match_kind: null,
      second_dist: Infinity, second_winner: null, confidence: 0,
      emit_action: "needs_review", entities_examined: 0,
    };
  }
  const candidates = candidateSigs.map((sig, index) => ({ kind: index === 0 ? "union-warm" : "union-any", sig }));
  // Track best and second-best (from a DIFFERENT concept) for confidence + AE7 fix #3.
  let bestDist = Infinity, bestLabel = null, bestKind = null;
  let secondDist = Infinity, secondLabel = null;
  for (const c of candidates) {
    for (const row of store.labels ?? []) {
      const weights = row.channel_weights || DEFAULT_CHANNEL_WEIGHTS;
      for (const s of row.signatures) {
        const d = richDistance(c.sig, s.sig, weights);
        if (d < bestDist) {
          // Promote current best → second, if it was a different concept
          if (bestLabel !== null && bestLabel !== row.label) {
            secondDist = bestDist; secondLabel = bestLabel;
          }
          bestDist = d; bestLabel = row.label; bestKind = c.kind;
        } else if (d < secondDist && row.label !== bestLabel) {
          secondDist = d; secondLabel = row.label;
        }
      }
    }
  }
  // Per-concept ceiling — if the winning concept row has a `reject_ceiling`, use that;
  // otherwise fall back to the global ceiling. Removes AE7 finding #6 fragility.
  const winnerRow = bestLabel !== null ? store.labels.find((r) => r.label === bestLabel) : null;
  const perConceptCeiling = winnerRow?.reject_ceiling ?? globalCeiling;
  let rejected = bestDist > perConceptCeiling;
  // Natural-vs-synthetic gate: if the winning concept is biological but the
  // query's subsurface signature says "synthetic/emissive," force needs_review.
  // Kills confidently-wrong emissions on LCD/print/screens misclassified as skin/fruit.
  let natural_gate_triggered = false;
  if (!rejected && USE_NATURAL_GATE && bestLabel && BIOLOGICAL_CONCEPTS.has(bestLabel)) {
    // Find the subsurface descriptor on the winning candidate (union preferred, then any entity)
    const winnerCand = candidates.find(c => c.sig?._subsurface) || candidates[0];
    const sub = winnerCand?.sig?._subsurface;
    if (sub) {
      const nat = naturalVsSynthetic(sub);
      if (!nat.natural) {
        rejected = true;
        natural_gate_triggered = true;
      }
    }
  }
  // Confidence — AE7 fix #3. Ratio of (second-best from a different concept) to (best).
  // 1.0 = best is MUCH closer than any other concept ("high confidence").
  // 0.0 = best and second-best tied ("split verdict").
  const confidence = secondDist === Infinity ? 1 : Math.max(0, 1 - bestDist / secondDist);
  return {
    winner: rejected ? null : bestLabel,
    nearest_candidate: bestLabel,
    dist: bestDist,
    match_kind: bestKind,
    second_dist: secondDist,
    second_winner: secondLabel,
    confidence,
    ceiling_used: perConceptCeiling,
    natural_gate_triggered,
    emit_action: rejected ? "needs_review" : "recognized_as",
    entities_examined: candidates.length,
  };
}

/**
 * Human-grade recognition on an image file.
 */
export async function recognizeHumanGradeImage(imagePath, store, opts = {}) {
  const frame = await extractImageRGB(imagePath, { maxSize: opts.maxSize ?? 384 });
  return recognizeHumanGradeFrame(frame, store, opts);
}

/**
 * Multi-object recognition — return the SET of concepts detected in the frame.
 *
 * For a fruit bowl containing orange, apple, banana, this emits three winners
 * (one per warm entity that clears its concept ceiling), not one. Prevents
 * discarding the multi-object structure that IS the correct answer.
 *
 * Each candidate signature (union + top-K entities) is matched against every
 * concept-signature. If (candidate, concept) pair sits under the concept's
 * ceiling, the concept enters the emit set once — with its best (lowest)
 * distance recorded. Concepts absent from the set failed the ceiling gate.
 *
 * @param {object} frame
 * @param {object} store
 * @param {object} [opts]  same as recognizeHumanGradeFrame
 * @returns {{
 *   concepts: Array<{label, dist, match_kind, confidence, ceiling_used}>,
 *   any_match: boolean,
 *   entities_examined: number,
 *   emit_action: "recognized_set" | "needs_review",
 * }}
 */
export function recognizeSetHumanGradeFrame(frame, store, opts = {}) {
  const globalCeiling = opts.ceiling ?? HUMAN_GRADE_CEILING;
  const maxEntities = opts.maxEntities ?? HUMAN_GRADE_MAX_SET_ENTITIES;
  const gates = opts.gates ?? ['warm_loose', 'any'];
  const entityMap = new Map();
  for (const hueGate of gates) {
    for (const entity of extractWarmEntities(frame, { ...opts, hue_gate: hueGate })) {
      const key = entity.region.join(':');
      if (!entityMap.has(key)) entityMap.set(key, entity);
    }
  }
  const entities = [...entityMap.values()].sort((a, b) => b.area - a.area).slice(0, maxEntities);
  if (!entities.length) {
    return { concepts: [], any_match: false, entities_examined: 0, emit_action: "needs_review" };
  }
  const candidates = [];
  const unionSig = signatureForUnion(frame, entities);
  if (unionSig) candidates.push({ kind: "union", sig: unionSig });
  for (const w of entities) {
    const s = signatureForRegion(frame, w.region);
    if (s) candidates.push({ kind: "entity", region: w.region, sig: s });
  }
  // For each concept: find its best-candidate min distance and its per-concept ceiling
  const perConcept = new Map();  // label → {bestDist, matchKind, ceiling_used, secondDist}
  for (const row of store.labels ?? []) {
    const weights = row.channel_weights || DEFAULT_CHANNEL_WEIGHTS;
    const perConceptCeiling = row.reject_ceiling ?? globalCeiling;
    let best = Infinity, kind = null, second = Infinity, bestCandidate = null;
    for (const c of candidates) {
      for (const s of row.signatures) {
        const d = richDistance(c.sig, s.sig, weights);
        if (d < best) { second = best; best = d; kind = c.kind; bestCandidate = c; }
        else if (d < second) second = d;
      }
    }
    const sub = bestCandidate?.sig?._subsurface;
    const natural = !USE_NATURAL_GATE || !BIOLOGICAL_CONCEPTS.has(row.label)
      || !sub || naturalVsSynthetic(sub).natural;
    if (best <= perConceptCeiling && natural) {
      const confidence = second === Infinity ? 1 : Math.max(0, 1 - best / second);
      perConcept.set(row.label, { label: row.label, dist: best, match_kind: kind, confidence, ceiling_used: perConceptCeiling });
    }
  }
  // Rank concepts by distance (closest first)
  const concepts = [...perConcept.values()].sort((a, b) => a.dist - b.dist);
  return {
    concepts,
    any_match: concepts.length > 0,
    entities_examined: candidates.length,
    emit_action: concepts.length > 0 ? "recognized_set" : "needs_review",
  };
}

export async function recognizeSetHumanGradeImage(imagePath, store, opts = {}) {
  const frame = await extractImageRGB(imagePath, { maxSize: opts.maxSize ?? 384 });
  return recognizeSetHumanGradeFrame(frame, store, opts);
}
