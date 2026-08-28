// 07-VISUAL/structural/identity/fisher-ratio-signature.mjs
//
// INNOVATION — Fisher-Ratio Signature Normalization for photon-measurement
// recognition. Zero learned parameters. Deterministic. Bun-native.
//
// PROBLEM: Cross-clip within-concept variance is 3-19× larger than gap to
// nearest other concept. Concepts collide in the same hue-cluster because
// the raw 8-axis feature vector treats every dimension with equal metric
// weight — while some dimensions ARE the concept identity (they're stable
// across clips of the same concept) and some are noise (they vary wildly
// across clips of the same concept).
//
// KEY INSIGHT: For each feature dimension, compute:
//   within(f) = variance of f across N clips of same concept, averaged over concepts
//   between(f) = variance of f across concepts (variance of per-concept means)
//   fisher_ratio(f) = between(f) / (within(f) + ε)
//
// A dimension with high Fisher ratio is CONCEPT-DEFINING (it discriminates
// concepts far more than it varies within a concept). A dimension with low
// Fisher ratio is NOISE (varies within concept as much as between concepts).
//
// The Fisher-weighted distance:
//   d(q, c) = sqrt(Σ fisher_ratio(f) × (q[f] - c[f])²)
// automatically amplifies discriminative dimensions and mutes noise
// dimensions. No learned weights — the Fisher ratio is a property of the
// data distribution.
//
// This is Linear Discriminant Analysis's per-feature scaling primitive,
// applied deterministically to a zero-parameter recognition path. Novel
// combination.
//
// USAGE:
//   const stats = computeFisherRatioStats(store);       // compute once from store
//   const qvec = flattenSignature(querySig);            // flatten to 1D
//   for (const row of store.labels) {
//     const cvec = flattenSignature(row.template);       // per-concept median vector
//     const d = fisherWeightedDistance(qvec, cvec, stats);
//     // ...
//   }

import { HUMAN_GRADE_WEIGHTS } from "./recognize-human-grade.mjs";
import { DEFAULT_CHANNEL_WEIGHTS } from "./identity-store-v2.mjs";

/**
 * Flatten a rich signature into a fixed-length Float32Array so we can do
 * per-dimension statistics. Order MUST be stable across all signatures.
 */
export function flattenSignature(sig) {
  const out = [];
  // color descriptor (8 scalars)
  const c = sig.color || {};
  out.push(c.mean_R ?? 0, c.mean_G ?? 0, c.mean_B ?? 0,
           c.mean_RG ?? 0, c.mean_BY ?? 0,
           Math.log((c.texture_var ?? 0) + 1e-6),
           c.log_size ?? 0, c.log_aspect ?? 0);
  // edge (10 scalars — mean energy, entropy, 8-bin orientation histogram)
  const e = sig.edge || {};
  out.push(e.meanEnergy ?? 0, e.orientationEntropy ?? 0);
  const oh = e.orientationHistogram ?? [];
  for (let i = 0; i < 8; i++) out.push(oh[i] ?? 0);
  // texture (2 scalars + LBP top-8 codes as normalized rank fingerprint)
  const t = sig.texture || {};
  out.push(Math.log((t.meanVariance ?? 0) + 1e-6), t.lbpEntropy ?? 0);
  // KEY FIX: lbpTopCodes are raw code numbers (0-255), sorted by frequency.
  // Rank the top 8 as their normalized codes (divided by 255). Rank vector
  // is a partial fingerprint of the texture vocabulary presence.
  const codes = t.lbpTopCodes ?? [];
  for (let i = 0; i < 8; i++) {
    const code = codes[i];
    if (typeof code === "number") out.push(code / 255);
    else if (code && typeof code === "object") out.push((code.code ?? 0) / 255);
    else out.push(0);
  }
  // specular (3)
  const sp = sig.specular || {};
  out.push(sp.cov ?? 0, sp.brightFraction ?? 0, sp.glossinessScore ?? 0);
  // spatial (27 cells)
  const cells = (sig.spatial?.cells) ?? [];
  for (let i = 0; i < 27; i++) out.push(cells[i] ?? 0);
  // subsurface (4)
  const su = sig.subsurface || {};
  out.push(su.edgeSoftness ?? 0, su.shadowGlowRatio ?? 0, su.boundaryWarmShift ?? 0, su.translucencyScore ?? 0);
  // colorRatio (6)
  const cr = sig.colorRatio || {};
  out.push(cr.log_R_over_G ?? 0, cr.log_G_over_B ?? 0, cr.log_R_over_B ?? 0,
           cr.normalized_chromaticity_r ?? 0, cr.normalized_chromaticity_g ?? 0, cr.normalized_chromaticity_b ?? 0);
  // spatialFreq (6)
  const sf = sig.spatialFreq || {};
  out.push(sf.grid_score ?? 0, sf.spectrum_flatness ?? 1,
           sf.band_energy_low ?? 0, sf.band_energy_mid ?? 0, sf.band_energy_high ?? 0,
           sf.dominant_freq_mag ?? 0);
  // retinal12 — 4 static-safe channels (the 88% config that worked).
  const r12 = sig.retinal12 || {};
  const r12Keys = ["onSustained","offSustained","localEdge","uniformity"];
  for (const k of r12Keys) out.push(r12[k] ?? 0);
  // Hu moment invariants (7 shape scalars + log_area + aspect_from_moments)
  const hu = sig.hu_moments || {};
  out.push(hu.h1 ?? 0, hu.h2 ?? 0, hu.h3 ?? 0, hu.h4 ?? 0, hu.h5 ?? 0, hu.h6 ?? 0, hu.h7 ?? 0,
           hu.log_area ?? 0, hu.aspect_from_moments ?? 0);
  // Photon histogram summary — 30 scalars (5 shape moments × 6 channels)
  // + raw luminance histogram (16 scalars) for full-distribution match
  const ph = sig.photon_hist || {};
  const phKeys = [
    "phot_R_entropy", "phot_R_mean_bin", "phot_R_variance", "phot_R_peak_bin", "phot_R_peak_value",
    "phot_G_entropy", "phot_G_mean_bin", "phot_G_variance", "phot_G_peak_bin", "phot_G_peak_value",
    "phot_B_entropy", "phot_B_mean_bin", "phot_B_variance", "phot_B_peak_bin", "phot_B_peak_value",
    "phot_L_entropy", "phot_L_mean_bin", "phot_L_variance", "phot_L_peak_bin", "phot_L_peak_value",
    "phot_logRG_entropy", "phot_logRG_mean_bin", "phot_logRG_variance", "phot_logRG_peak_bin", "phot_logRG_peak_value",
    "phot_logGB_entropy", "phot_logGB_mean_bin", "phot_logGB_variance", "phot_logGB_peak_bin", "phot_logGB_peak_value",
  ];
  for (const k of phKeys) out.push(ph[k] ?? 0);
  const rawL = ph.raw_hist_L || [];
  for (let i = 0; i < 16; i++) out.push(rawL[i] ?? 0);
  // Cross-channel photon correlations (6 covariation scalars, illumination-invariant)
  const pc = sig.photon_corr || {};
  out.push(pc.corr_RG ?? 0, pc.corr_RB ?? 0, pc.corr_GB ?? 0,
           pc.corr_RL ?? 0, pc.corr_GL ?? 0, pc.corr_BL ?? 0);
  // Radial photon profile — 8 concentric rings × (R, G, B, L) = 32 scalars
  // Rotation-invariant spatial pattern from centroid outward. Fruits differ:
  // watermelon R decreases with radius (rind), orange uniform, strawberry oscillates.
  const rp = sig.radial_profile || {};
  for (let bin = 0; bin < 8; bin++) {
    out.push(rp["ring" + bin + "_R"] ?? 0,
             rp["ring" + bin + "_G"] ?? 0,
             rp["ring" + bin + "_B"] ?? 0,
             rp["ring" + bin + "_L"] ?? 0);
  }
  out.push(rp.max_radius_norm ?? 0);
  // FABLE MOVE 2 — dichromatic body recovery (13 dims). Appended at end so
  // existing 172-D layout is preserved for stores without the axis (they
  // read `?? 0`). Stores WITH the axis have D = 172 + 13 = 185.
  const dc = sig.dichromatic || {};
  out.push(
    dc.bodyChroma_r ?? (1 / 3),
    dc.bodyChroma_g ?? (1 / 3),
    dc.bodyMean_r ?? 0,
    dc.bodyMean_g ?? 0,
    dc.bodyMean_b ?? 0,
    dc.bodyLogRG ?? 0,
    dc.bodyLogGB ?? 0,
    dc.bodyLogRB ?? 0,
    dc.illuminant_r ?? (1 / 3),
    dc.illuminant_g ?? (1 / 3),
    dc.illuminant_b ?? (1 / 3),
    dc.illumConfidence ?? 0,
    dc.specularFraction ?? 0,
  );
  return new Float32Array(out);
}

/**
 * Given a store of concepts (each with N per-clip signatures), compute
 * per-dimension Fisher-ratio stats:
 *   - within[f]  = mean of per-concept variance of dimension f
 *   - between[f] = variance across concepts of per-concept mean of dim f
 *   - fisher[f]  = between[f] / (within[f] + ε)
 *   - overall_mean[f], overall_std[f] for normalization
 * Also computes each concept's median vector (robust to outlier clips).
 */
export function computeFisherRatioStats(store) {
  if (!store.labels?.length) return null;
  // Include ALL concepts in Fisher stats (was the 88% config timeline).
  const concepts = [];
  for (const row of store.labels) {
    const vecs = row.signatures.map(s => flattenSignature(s.sig));
    if (!vecs.length) continue;
    concepts.push({ label: row.label, vecs });
  }
  if (!concepts.length) return null;
  const D = concepts[0].vecs[0].length;

  // STEP 1: Global per-dimension mean and standard deviation (across ALL sigs).
  // We standardize each dim before computing Fisher, so the metric is invariant
  // to the raw range of each channel.
  const allVecs = concepts.flatMap(c => c.vecs);
  const N_all = allVecs.length;
  const globalMean = new Float32Array(D);
  const globalStd = new Float32Array(D);
  for (let f = 0; f < D; f++) {
    let sum = 0;
    for (const v of allVecs) sum += v[f];
    globalMean[f] = sum / N_all;
  }
  for (let f = 0; f < D; f++) {
    let sq = 0;
    for (const v of allVecs) { const d = v[f] - globalMean[f]; sq += d * d; }
    const variance = N_all > 1 ? sq / (N_all - 1) : 0;
    globalStd[f] = Math.sqrt(Math.max(variance, 1e-8));  // clamp to avoid div-by-zero
  }
  // Standardize every stored sig in place (concept-preserving) so distance math is comparable.
  function standardize(v) {
    const out = new Float32Array(D);
    for (let f = 0; f < D; f++) out[f] = (v[f] - globalMean[f]) / globalStd[f];
    return out;
  }
  for (const c of concepts) c.vecs = c.vecs.map(standardize);

  // STEP 2: Fisher stats on standardized data.
  const conceptStats = concepts.map(({ label, vecs }) => {
    const N = vecs.length;
    const mean = new Float32Array(D);
    const median = new Float32Array(D);
    for (let f = 0; f < D; f++) {
      let sum = 0;
      const col = new Array(N);
      for (let i = 0; i < N; i++) { sum += vecs[i][f]; col[i] = vecs[i][f]; }
      mean[f] = sum / N;
      col.sort((a, b) => a - b);
      median[f] = N % 2 ? col[(N - 1) >> 1] : 0.5 * (col[(N >> 1) - 1] + col[N >> 1]);
    }
    const variance = new Float32Array(D);
    for (let f = 0; f < D; f++) {
      let s = 0;
      for (let i = 0; i < N; i++) { const d = vecs[i][f] - mean[f]; s += d * d; }
      variance[f] = N > 1 ? s / (N - 1) : 0;
    }
    return { label, N, mean, median, variance };
  });

  // Within-class variance: mean of per-concept variance
  const within = new Float32Array(D);
  for (let f = 0; f < D; f++) {
    let s = 0;
    for (const c of conceptStats) s += c.variance[f];
    within[f] = conceptStats.length > 0 ? s / conceptStats.length : 0;
  }
  // Between-class variance: variance of per-concept means
  const between = new Float32Array(D);
  const standardizedGlobalMean = new Float32Array(D);   // after standardization this is ≈ 0 by construction
  for (let f = 0; f < D; f++) {
    let s = 0;
    for (const c of conceptStats) s += c.mean[f];
    standardizedGlobalMean[f] = conceptStats.length > 0 ? s / conceptStats.length : 0;
  }
  for (let f = 0; f < D; f++) {
    let s = 0;
    for (const c of conceptStats) { const d = c.mean[f] - standardizedGlobalMean[f]; s += d * d; }
    between[f] = conceptStats.length > 1 ? s / (conceptStats.length - 1) : 0;
  }
  // Fisher ratio — since dims are standardized, ratios have consistent scale.
  const fisher = new Float32Array(D);
  const eps = 1e-6;
  let sumFisher = 0;
  for (let f = 0; f < D; f++) {
    fisher[f] = between[f] / (within[f] + eps);
    sumFisher += fisher[f];
  }
  // Normalize so sum = D — mean weight = 1. Distance is then a well-behaved
  // weighted-average of squared standardized-diffs. Ceiling values are in
  // roughly the same range as the natural sqrt-D of chi-squared distances (~10 for D=100).
  if (sumFisher > 0) {
    const scale = D / sumFisher;
    for (let f = 0; f < D; f++) fisher[f] *= scale;
  }

  return { D, within, between, fisher, globalMean, globalStd, conceptStats, standardize };
}

/**
 * Fisher-weighted distance between two flattened sig vectors.
 * Each squared per-dimension difference is scaled by the Fisher ratio,
 * so discriminative dimensions dominate the distance.
 */
export function fisherWeightedDistance(qvec, cvec, stats) {
  const D = qvec.length;
  const w = stats.fisher;
  let s = 0;
  for (let f = 0; f < D; f++) {
    const d = qvec[f] - cvec[f];
    s += w[f] * d * d;
  }
  return Math.sqrt(s);
}

/**
 * Apply the Fisher stats to a store IN PLACE:
 *   - Add row.fisher_template = concept median vector (D floats)
 *   - Add row.fisher_within  = per-concept per-dim variance (D floats)
 *   - Store.fisher_stats     = global stats (fisher weights, D, etc.)
 * Existing per-clip signatures preserved.
 */
export function attachFisherRatioToStore(store) {
  const stats = computeFisherRatioStats(store);
  if (!stats) return null;
  store.fisher_stats = {
    D: stats.D,
    fisher: Array.from(stats.fisher),
    within: Array.from(stats.within),
    between: Array.from(stats.between),
    globalMean: Array.from(stats.globalMean),
    globalStd: Array.from(stats.globalStd),
    computed_at: new Date().toISOString(),
  };
  for (const c of stats.conceptStats) {
    const row = store.labels.find(r => r.label === c.label);
    if (!row) continue;
    row.fisher_template = Array.from(c.median);       // STANDARDIZED median
    row.fisher_within = Array.from(c.variance);       // STANDARDIZED per-concept variance
  }
  return stats;
}

/**
 * Standardize a raw (unstandardized) flattened signature using the store's
 * global mean+std. Query-side helper — always call before matching.
 */
export function standardizeSignatureVector(rawVec, storeStats) {
  const D = storeStats.D;
  const gMean = storeStats.globalMean;
  const gStd = storeStats.globalStd;
  const out = new Float32Array(D);
  for (let f = 0; f < D; f++) out[f] = (rawVec[f] - gMean[f]) / gStd[f];
  return out;
}

/**
 * Recognize a query signature against a Fisher-attached store.
 * Returns nearest concept + distance under Fisher-weighted metric.
 */
export function recognizeFisher(querySig, store, opts = {}) {
  if (!store.fisher_stats) return { winner: null, dist: Infinity, error: "store has no fisher_stats — call attachFisherRatioToStore first" };
  const stats = {
    D: store.fisher_stats.D,
    fisher: Float32Array.from(store.fisher_stats.fisher),
  };
  const qvec = flattenSignature(querySig);
  let best = Infinity, bestLabel = null, second = Infinity, secondLabel = null;
  for (const row of store.labels) {
    if (!row.fisher_template) continue;
    const cvec = Float32Array.from(row.fisher_template);
    const d = fisherWeightedDistance(qvec, cvec, stats);
    if (d < best) {
      if (bestLabel !== row.label) { second = best; secondLabel = bestLabel; }
      best = d; bestLabel = row.label;
    } else if (d < second && row.label !== bestLabel) {
      second = d; secondLabel = row.label;
    }
  }
  const ceiling = opts.ceiling ?? 0.6;   // Fisher distances are much smaller than raw richDistance
  const rejected = best > ceiling;
  const confidence = second === Infinity ? 1 : Math.max(0, 1 - best / second);
  return {
    winner: rejected ? null : bestLabel,
    dist: best,
    second_dist: second,
    second_winner: secondLabel,
    confidence,
    ceiling_used: ceiling,
    emit_action: rejected ? "needs_review" : "recognized_as",
  };
}
