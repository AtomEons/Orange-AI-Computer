// 07-VISUAL/structural/identity/identity-store-v2.mjs
//
// Multi-signature identity store.
//
// v1 collapsed N frames into 1 aggregated descriptor per concept. That was
// the wrong compression. Kurzweil: the brain has HUNDREDS of recognizers per
// concept; redundancy IS the robustness. This store keeps every frame as
// its own signature and matches by nearest-of-N.
//
// Also: per-concept channel weights. Fruit dominated by spectral. Wood by
// texture. Weights are per-concept, not global.

import { descriptorDistance } from "./descriptor.mjs";

/**
 * Build a rich descriptor combining the color descriptor with core visual
 * channels. Original 5 required. NEW: subsurface, colorRatio, spatialFreq
 * accepted as trailing OPTIONAL args — old callers unaffected, new callers
 * get 8-channel signatures. Backwards compatible.
 *
 * @param {object} colorDesc  color descriptor (from descriptor.mjs)
 * @param {object} edgeSum    from edge-axis.mjs
 * @param {object} texSum     from texture-axis.mjs
 * @param {object} specSum    from specular-axis.mjs
 * @param {object} spatSum    from spatial-color-axis.mjs
 * @param {object} [subSum]   from subsurface-axis.mjs (optional)
 * @param {object} [ratioSum] from color-ratio-axis.mjs (optional)
 * @param {object} [freqSum]  from spatial-frequency-axis.mjs (optional)
 */
export function buildRichSignature(colorDesc, edgeSum, texSum, specSum, spatSum, subSum, ratioSum, freqSum, channels12Sum) {
  const sig = {
    color: colorDesc,
    edge: {
      meanEnergy: edgeSum?.meanEnergy ?? 0,
      orientationHistogram: edgeSum?.orientationHistogram ?? new Array(8).fill(0),
      orientationEntropy: edgeSum?.orientationEntropy ?? 0,
    },
    texture: {
      meanVariance: texSum?.textureMeanVariance ?? 0,
      lbpEntropy: texSum?.lbpEntropy ?? 0,
      lbpTopCodes: texSum?.lbpTopCodes ?? [],
    },
    specular: {
      cov: specSum?.cov ?? 0,
      brightFraction: specSum?.brightFraction ?? 0,
      glossinessScore: specSum?.glossinessScore ?? 0,
    },
    spatial: {
      cells: spatSum?.cells ?? new Array(27).fill(0),
    },
  };
  // New optional axes — only attached if provided
  if (subSum) {
    sig.subsurface = {
      edgeSoftness: subSum.edgeSoftness ?? 0,
      shadowGlowRatio: subSum.shadowGlowRatio ?? 0,
      boundaryWarmShift: subSum.boundaryWarmShift ?? 0,
      translucencyScore: subSum.translucencyScore ?? 0,
    };
  }
  if (ratioSum) {
    sig.colorRatio = {
      log_R_over_G: ratioSum.log_R_over_G ?? 0,
      log_G_over_B: ratioSum.log_G_over_B ?? 0,
      log_R_over_B: ratioSum.log_R_over_B ?? 0,
      normalized_chromaticity_r: ratioSum.normalized_chromaticity_r ?? 0,
      normalized_chromaticity_g: ratioSum.normalized_chromaticity_g ?? 0,
      normalized_chromaticity_b: ratioSum.normalized_chromaticity_b ?? 0,
    };
  }
  if (freqSum) {
    sig.spatialFreq = {
      grid_score: freqSum.grid_score ?? 0,
      spectrum_flatness: freqSum.spectrum_flatness ?? 1,
      band_energy_low: freqSum.band_energy?.low ?? 0,
      band_energy_mid: freqSum.band_energy?.mid ?? 0,
      band_energy_high: freqSum.band_energy?.high ?? 0,
      dominant_freq_mag: freqSum.dominant_freq_mag ?? 0,
    };
  }
  // Retinal-12 — the biological Werblin channels. 12 scalar summaries per
  // region. Carries shape/motion/uniformity signal that pure color/texture
  // channels can't reach (per human-grade-big-think finding).
  if (channels12Sum) {
    sig.retinal12 = {
      onSustained:   channels12Sum.onSustained ?? 0,
      offSustained:  channels12Sum.offSustained ?? 0,
      onTransient:   channels12Sum.onTransient ?? 0,
      offTransient:  channels12Sum.offTransient ?? 0,
      up:            channels12Sum.up ?? 0,
      down:          channels12Sum.down ?? 0,
      right:         channels12Sum.right ?? 0,
      left:          channels12Sum.left ?? 0,
      localEdge:     channels12Sum.localEdge ?? 0,
      objectMotion:  channels12Sum.objectMotion ?? 0,
      uniformity:    channels12Sum.uniformity ?? 0,
      sustainedDS:   channels12Sum.sustainedDS ?? 0,
    };
  }
  return sig;
}

/**
 * Distance between two rich signatures. Uses per-channel sub-distances
 * combined by weights (which can be per-concept via the caller).
 *
 * Default weights are balanced; the LGN gate / concept nodes can override.
 */
export const DEFAULT_CHANNEL_WEIGHTS = {
  color:       1.0,
  edge:        0.6,
  texture:     0.5,
  specular:    0.3,
  spatial:     0.5,
  // NEW — subsurface, colorRatio, spatialFreq. Default 0.4 each; concept
  // weights can boost. Old signatures without these fields get zero
  // contribution (they simply don't compute the sub-distance).
  subsurface:  0.4,
  colorRatio:  0.4,
  spatialFreq: 0.4,
  // Retinal-12 — carries shape/motion/uniformity. Default 0.5.
  retinal12:   0.5,
};

export function richDistance(a, b, weights = DEFAULT_CHANNEL_WEIGHTS) {
  if (!a || !b) return Infinity;
  const w = { ...DEFAULT_CHANNEL_WEIGHTS, ...weights };
  const colorD = descriptorDistance(a.color, b.color);
  const edgeD = Math.sqrt(
    (a.edge.meanEnergy - b.edge.meanEnergy) ** 2 +
    (a.edge.orientationEntropy - b.edge.orientationEntropy) ** 2 +
    orientationDistance(a.edge.orientationHistogram, b.edge.orientationHistogram),
  );
  const texD = Math.sqrt(
    (Math.log(a.texture.meanVariance + 1e-6) - Math.log(b.texture.meanVariance + 1e-6)) ** 2 +
    (a.texture.lbpEntropy - b.texture.lbpEntropy) ** 2 +
    lbpCodeOverlapDistance(a.texture.lbpTopCodes, b.texture.lbpTopCodes),
  );
  const specD = Math.sqrt(
    (a.specular.cov - b.specular.cov) ** 2 +
    (a.specular.brightFraction - b.specular.brightFraction) ** 2 +
    (a.specular.glossinessScore - b.specular.glossinessScore) ** 2,
  );
  const spatD = spatialL2(a.spatial.cells, b.spatial.cells);
  let sumSq =
    (w.color * colorD) ** 2 +
    (w.edge * edgeD) ** 2 +
    (w.texture * texD) ** 2 +
    (w.specular * specD) ** 2 +
    (w.spatial * spatD) ** 2;
  // NEW optional channels — only accumulate if BOTH signatures have them
  if (a.subsurface && b.subsurface) {
    const dS = Math.sqrt(
      (a.subsurface.edgeSoftness - b.subsurface.edgeSoftness) ** 2 +
      (a.subsurface.shadowGlowRatio - b.subsurface.shadowGlowRatio) ** 2 +
      (a.subsurface.translucencyScore - b.subsurface.translucencyScore) ** 2 +
      0.5 * (a.subsurface.boundaryWarmShift - b.subsurface.boundaryWarmShift) ** 2,
    );
    sumSq += (w.subsurface * dS) ** 2;
  }
  if (a.colorRatio && b.colorRatio) {
    const dCR = Math.sqrt(
      (a.colorRatio.log_R_over_G - b.colorRatio.log_R_over_G) ** 2 +
      (a.colorRatio.log_G_over_B - b.colorRatio.log_G_over_B) ** 2 +
      (a.colorRatio.log_R_over_B - b.colorRatio.log_R_over_B) ** 2 +
      3 * ((a.colorRatio.normalized_chromaticity_r - b.colorRatio.normalized_chromaticity_r) ** 2 +
           (a.colorRatio.normalized_chromaticity_g - b.colorRatio.normalized_chromaticity_g) ** 2 +
           (a.colorRatio.normalized_chromaticity_b - b.colorRatio.normalized_chromaticity_b) ** 2),
    );
    sumSq += (w.colorRatio * dCR) ** 2;
  }
  if (a.spatialFreq && b.spatialFreq) {
    const dSF = Math.sqrt(
      2 * (a.spatialFreq.grid_score - b.spatialFreq.grid_score) ** 2 +
      2 * (a.spatialFreq.spectrum_flatness - b.spatialFreq.spectrum_flatness) ** 2 +
      (a.spatialFreq.band_energy_low - b.spatialFreq.band_energy_low) ** 2 +
      (a.spatialFreq.band_energy_mid - b.spatialFreq.band_energy_mid) ** 2 +
      (a.spatialFreq.band_energy_high - b.spatialFreq.band_energy_high) ** 2 +
      0.5 * (a.spatialFreq.dominant_freq_mag - b.spatialFreq.dominant_freq_mag) ** 2,
    );
    sumSq += (w.spatialFreq * dSF) ** 2;
  }
  if (a.retinal12 && b.retinal12) {
    // 12-channel L2 with tuned per-channel weights. localEdge, objectMotion,
    // uniformity carry the strongest shape/structure signal; direction-
    // selective channels are motion-specific and often near-zero on stills.
    const ch = [
      ["onSustained", 1.0], ["offSustained", 1.0],
      ["onTransient", 0.6], ["offTransient", 0.6],
      ["up", 0.4], ["down", 0.4], ["right", 0.4], ["left", 0.4],
      ["localEdge", 1.5], ["objectMotion", 1.2],
      ["uniformity", 1.3], ["sustainedDS", 0.5],
    ];
    let d12sq = 0;
    for (const [k, wk] of ch) d12sq += wk * ((a.retinal12[k] ?? 0) - (b.retinal12[k] ?? 0)) ** 2;
    const d12 = Math.sqrt(d12sq);
    sumSq += (w.retinal12 * d12) ** 2;
  }
  return Math.sqrt(sumSq);
}

function orientationDistance(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += (a[i] - b[i]) ** 2;
  return s;
}
function lbpCodeOverlapDistance(a, b) {
  const setA = new Set(a), setB = new Set(b);
  let overlap = 0;
  for (const c of setA) if (setB.has(c)) overlap++;
  const total = Math.max(1, setA.size + setB.size - overlap);
  return 1 - overlap / total;
}
function spatialL2(a, b) {
  let s = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) s += (a[i] - b[i]) ** 2;
  return Math.sqrt(s);
}

/**
 * Add ALL frame signatures for a concept — no aggregation. Multi-signature.
 * The store's concept row becomes { label, signatures: [rich, rich, ...],
 * channel_weights: {...} }.
 */
export function attachSignaturesV2(store, label, richSignatures, source, timestamp = null) {
  let row = store.labels?.find((r) => r.label === label);
  if (!row) {
    row = { label, signatures: [], channel_weights: { ...DEFAULT_CHANNEL_WEIGHTS }, provenance: [] };
    store.labels = store.labels ?? [];
    store.labels.push(row);
  }
  const stamp = timestamp ?? new Date().toISOString();
  for (const sig of richSignatures) row.signatures.push({ sig, source, learned_at: stamp });
  row.provenance.push({ source, count: richSignatures.length, at: stamp });
  return row;
}

/**
 * Nearest-of-N recognition. For each concept, find the closest of its N
 * stored signatures to the query. Rank concepts by their best-match
 * distance. Optionally use top-K vote instead of single best.
 */
export function recognizeV2(query, store, opts = {}) {
  const maxDist = opts.max_distance ?? 1.0;
  const topK = opts.top_k ?? 1;
  if (!store.labels?.length) return null;
  const per = store.labels.map((row) => {
    const dists = row.signatures.map((s) => richDistance(query, s.sig, row.channel_weights)).sort((a, b) => a - b);
    const best = dists[0];
    const kBest = dists.slice(0, topK);
    const kMean = kBest.reduce((a, b) => a + b, 0) / kBest.length;
    return { label: row.label, best, kMean, n_signatures: row.signatures.length };
  });
  per.sort((a, b) => a.kMean - b.kMean);
  const winner = per[0];
  if (!winner) return null;
  if (winner.kMean > maxDist) {
    return { winner: winner.label, distance: winner.kMean, best: winner.best, confidence: 0, rejected: true, all: per };
  }
  const confidence = Math.max(0, 1 - winner.kMean / maxDist);
  return { winner: winner.label, distance: winner.kMean, best: winner.best, confidence, rejected: false, all: per };
}

/**
 * Set per-concept channel weights, RECORDING WHERE THEY CAME FROM.
 *
 * Why the provenance stamp exists (added after an audit found the hole):
 * `learn-weights-apply.mjs` fits per-concept weights from confusion data and
 * writes them into the store via this function. `recognizeV2` (line ~248) and
 * `recognize-human-grade.mjs` (354, 455) then READ `row.channel_weights` at
 * recognition time. That is a fitted parameter used at eval.
 *
 * That may be perfectly fine for the product lane — but before this stamp a
 * learned store and a never-trained store were byte-indistinguishable in shape,
 * so NO consumer could tell which one it was holding, and no claim about a run
 * ("zero learned parameters", "these thresholds were not fit on test data")
 * could be checked against the artifact it ran on.
 *
 * The weights are unchanged. Only the record of their origin is new.
 *
 * @param source 'learned' | 'manual' | 'default' — how these values were chosen.
 *               Callers that fit from data MUST pass 'learned'.
 */
export function updateChannelWeights(store, label, weights, source = 'manual', note = null) {
  const row = store.labels?.find((r) => r.label === label);
  if (!row) return null;
  const before = { ...row.channel_weights };
  row.channel_weights = { ...row.channel_weights, ...weights };
  // Append-only mutation log. Never rewritten, so the history of how a concept's
  // weights got where they are survives in the artifact itself.
  row.weight_provenance = Array.isArray(row.weight_provenance) ? row.weight_provenance : [];
  row.weight_provenance.push({
    source,
    at: new Date().toISOString(),
    changed: Object.keys(weights).filter((k) => before[k] !== weights[k]),
    ...(note ? { note } : {}),
  });
  return row.channel_weights;
}

/**
 * What is this store, honestly? Pure read — answers the question a claim about
 * a run depends on: were any weights fitted from data?
 *
 * A store predating the provenance stamp reports `UNKNOWN_PRE_PROVENANCE`
 * rather than `DEFAULT_ONLY` — absence of a record is not evidence of absence.
 * Silently defaulting old stores to "clean" is exactly the fake-green this
 * function exists to prevent.
 */
export function weightsAttestation(store) {
  const rows = Array.isArray(store?.labels) ? store.labels : [];
  const learned = [], manual = [], unknown = [], defaulted = [];
  for (const row of rows) {
    const prov = Array.isArray(row.weight_provenance) ? row.weight_provenance : null;
    const differsFromDefault = Object.entries(row.channel_weights ?? {})
      .some(([k, v]) => DEFAULT_CHANNEL_WEIGHTS[k] !== undefined && DEFAULT_CHANNEL_WEIGHTS[k] !== v);
    if (prov?.some((p) => p.source === 'learned')) learned.push(row.label);
    else if (prov?.some((p) => p.source === 'manual')) manual.push(row.label);
    else if (differsFromDefault) unknown.push(row.label);   // altered, origin unrecorded
    else defaulted.push(row.label);
  }
  const status = learned.length ? 'CONTAINS_FITTED_WEIGHTS'
    : unknown.length ? 'UNKNOWN_PRE_PROVENANCE'
    : manual.length ? 'MANUALLY_TUNED'
    : 'DEFAULT_ONLY';
  return {
    schema: 'aeyes.store.weights-attestation.v1',
    status,
    concepts: rows.length,
    learned, manual, unknown, defaulted: defaulted.length,
    // The single line any external claim must quote.
    claim: status === 'DEFAULT_ONLY'
      ? 'No per-concept weight in this store departs from DEFAULT_CHANNEL_WEIGHTS. Recognition on this store uses no fitted per-concept parameter.'
      : status === 'UNKNOWN_PRE_PROVENANCE'
        ? `${unknown.length} concept(s) carry non-default weights with no recorded origin (store predates provenance stamping). Their source CANNOT be established from this artifact — do not claim zero fitted parameters on this store.`
        : `${learned.length + manual.length} concept(s) carry non-default weights (${learned.length} fitted from data). Recognition on this store USES fitted per-concept parameters at eval time.`,
  };
}
