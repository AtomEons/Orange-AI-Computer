// 07-VISUAL/structural/identity/hopfield-retrieval.mjs
//
// Modern Hopfield / dense associative memory.
//
// Krotov & Hopfield (2016, 2021): given N stored patterns and a query, the
// retrieved pattern is the softmax-weighted sum of stored patterns, where
// weights are exp(-β · distance). Converges to the nearest attractor basin.
// Capacity scales exponentially with pattern dimension.
//
// Also relevant — Ramsauer et al 2020 "Hopfield Networks is All You Need"
// (arXiv:2008.02217) proves the transformer attention mechanism IS the
// update rule of a modern Hopfield network with continuous states. Our
// softmax-attention iteration is exactly this update rule; the three
// energy minima types Ramsauer names (global averaging / metastable /
// single-pattern fixed point) match the three verdict classes we observe:
// split (global) / close (metastable) / decisive (single-pattern).
//
// For Æyes: query is a rich signature; stored patterns are the concept's
// signature bank (multi-signature per concept from identity-store-v2).
// Retrieval yields a soft assignment across concepts + a converged
// pattern that can be compared to the query.
//
// Zero parameters. Deterministic. Bun-native.

import { richDistance } from "./identity-store-v2.mjs";

/**
 * Softmax over negative distances with inverse-temperature β.
 * Higher β → sharper attention → more attractor-like.
 */
function softmaxAttention(distances, beta) {
  const maxNeg = Math.max(...distances.map((d) => -beta * d));
  const exps = distances.map((d) => Math.exp(-beta * d - maxNeg));
  const s = exps.reduce((a, b) => a + b, 0) || 1;
  return exps.map((v) => v / s);
}

/**
 * One Hopfield update step. Given a query, compute attention over all stored
 * (concept, signature) pairs, and produce the softmax-weighted concept
 * activations + the retrieved (soft-averaged) pattern.
 */
export function hopfieldRetrieve(query, store, opts = {}) {
  const beta = opts.beta ?? 5.0;
  const iters = opts.iters ?? 3;
  const perConceptBeta = opts.perConceptBeta ?? null; // Map<label, number> or null
  if (!store.labels?.length) return null;

  // Flatten all signatures with concept-index tags + per-concept β if provided
  const flat = [];
  for (let ci = 0; ci < store.labels.length; ci++) {
    const label = store.labels[ci].label;
    // Per-concept β: fall back to store row's beta_override, then global
    const conceptBeta = perConceptBeta?.get?.(label)
      ?? store.labels[ci].beta_override
      ?? beta;
    for (const s of store.labels[ci].signatures) flat.push({ concept: ci, sig: s.sig, weights: store.labels[ci].channel_weights, beta: conceptBeta });
  }

  // Iterate: attention → convex combination → distances → attention
  // Per-signature β allows per-concept temperature. When all concepts use
  // the same β this collapses to the standard softmax.
  let current = query;
  let attention = null;
  for (let it = 0; it < iters; it++) {
    const dists = flat.map((f) => richDistance(current, f.sig, f.weights));
    const betas = flat.map((f) => f.beta);
    // Per-signature softmax: exp(-β_i · d_i) / Σ exp(-β_j · d_j)
    const shiftedNegs = dists.map((d, i) => -betas[i] * d);
    const maxNeg = Math.max(...shiftedNegs);
    const exps = shiftedNegs.map((x) => Math.exp(x - maxNeg));
    const s = exps.reduce((a, b) => a + b, 0) || 1;
    attention = exps.map((v) => v / s);
    current = softAveragePattern(flat, attention);
  }

  // Aggregate final attention per concept
  const perConcept = new Array(store.labels.length).fill(0);
  for (let i = 0; i < flat.length; i++) perConcept[flat[i].concept] += attention[i];
  const conceptRanking = perConcept
    .map((v, i) => ({ label: store.labels[i].label, mass: v, n: store.labels[i].signatures.length }))
    .sort((a, b) => b.mass - a.mass);

  // Confidence: how peaked is the softmax?
  const peakMass = conceptRanking[0].mass;
  const entropy = perConcept.reduce((a, p) => a + (p > 0 ? -p * Math.log(p) : 0), 0);
  const maxEntropy = Math.log(store.labels.length);
  const sharpness = maxEntropy > 0 ? 1 - entropy / maxEntropy : 1;

  // Best-match distance from the retrieved pattern to the winner's nearest signature
  const winnerIdx = perConcept.indexOf(Math.max(...perConcept));
  const winnerSigs = store.labels[winnerIdx].signatures;
  const winnerWeights = store.labels[winnerIdx].channel_weights;
  const winnerBestDist = Math.min(...winnerSigs.map((s) => richDistance(query, s.sig, winnerWeights)));

  return {
    winner: conceptRanking[0].label,
    winnerMass: peakMass,
    sharpness,
    winnerBestDistance: winnerBestDist,
    ranking: conceptRanking,
    retrievedPattern: current,
  };
}

/**
 * Soft-average across stored patterns with attention weights. Averages each
 * scalar field of the rich signature; discrete fields (like LBP top codes)
 * are attention-max-selected.
 */
function softAveragePattern(flat, attention) {
  const out = {
    color: null, edge: null, texture: null, specular: null, spatial: null,
  };

  // Color: 8 scalars
  const colorKeys = ["mean_R","mean_G","mean_B","mean_RG","mean_BY","texture_var","log_size","log_aspect"];
  out.color = Object.fromEntries(colorKeys.map((k) => [k, 0]));
  for (const k of colorKeys) {
    for (let i = 0; i < flat.length; i++) out.color[k] += attention[i] * (flat[i].sig.color?.[k] ?? 0);
  }

  // Edge: scalars + histogram
  out.edge = { meanEnergy: 0, orientationEntropy: 0, orientationHistogram: new Array(8).fill(0) };
  for (let i = 0; i < flat.length; i++) {
    const e = flat[i].sig.edge;
    out.edge.meanEnergy += attention[i] * (e?.meanEnergy ?? 0);
    out.edge.orientationEntropy += attention[i] * (e?.orientationEntropy ?? 0);
    for (let j = 0; j < 8; j++) out.edge.orientationHistogram[j] += attention[i] * (e?.orientationHistogram?.[j] ?? 0);
  }

  // Texture: scalars + argmax of LBP top codes (discrete)
  out.texture = { meanVariance: 0, lbpEntropy: 0, lbpTopCodes: [] };
  let bestAtt = -Infinity, bestI = 0;
  for (let i = 0; i < flat.length; i++) {
    const t = flat[i].sig.texture;
    out.texture.meanVariance += attention[i] * (t?.meanVariance ?? 0);
    out.texture.lbpEntropy += attention[i] * (t?.lbpEntropy ?? 0);
    if (attention[i] > bestAtt) { bestAtt = attention[i]; bestI = i; }
  }
  out.texture.lbpTopCodes = flat[bestI].sig.texture?.lbpTopCodes ?? [];

  // Specular
  out.specular = { cov: 0, brightFraction: 0, glossinessScore: 0 };
  for (let i = 0; i < flat.length; i++) {
    const s = flat[i].sig.specular;
    out.specular.cov += attention[i] * (s?.cov ?? 0);
    out.specular.brightFraction += attention[i] * (s?.brightFraction ?? 0);
    out.specular.glossinessScore += attention[i] * (s?.glossinessScore ?? 0);
  }

  // Spatial cells (27-D)
  out.spatial = { cells: new Array(27).fill(0) };
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i].sig.spatial?.cells;
    if (c) for (let j = 0; j < 27; j++) out.spatial.cells[j] += attention[i] * c[j];
  }

  // Preserve optional identity channels across every Hopfield iteration.
  // Dropping them here silently reduced an 8/12-axis query to the legacy
  // five-axis state after its first update.
  out.subsurface = weightedOptional(flat, attention, "subsurface", [
    "edgeSoftness", "shadowGlowRatio", "translucencyScore", "boundaryWarmShift",
  ]);
  out.colorRatio = weightedOptional(flat, attention, "colorRatio", [
    "log_R_over_G", "log_G_over_B", "log_R_over_B",
    "normalized_chromaticity_r", "normalized_chromaticity_g", "normalized_chromaticity_b",
  ]);
  out.spatialFreq = weightedOptional(flat, attention, "spatialFreq", [
    "grid_score", "spectrum_flatness", "band_energy_low", "band_energy_mid",
    "band_energy_high", "dominant_freq_mag",
  ]);
  out.retinal12 = weightedOptional(flat, attention, "retinal12", [
    "onSustained", "offSustained", "onTransient", "offTransient",
    "up", "down", "right", "left", "localEdge", "objectMotion",
    "uniformity", "sustainedDS",
  ]);

  return out;
}

function weightedOptional(flat, attention, key, fields) {
  const value = Object.fromEntries(fields.map((field) => [field, 0]));
  let total = 0;
  for (let i = 0; i < flat.length; i++) {
    const source = flat[i].sig[key];
    if (!source) continue;
    total += attention[i];
    for (const field of fields) value[field] += attention[i] * (source[field] ?? 0);
  }
  if (total === 0) return null;
  for (const field of fields) value[field] /= total;
  return value;
}
