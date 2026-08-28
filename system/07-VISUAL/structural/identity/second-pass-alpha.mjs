// 07-VISUAL/structural/identity/second-pass-alpha.mjs
//
// Second-pass alpha strikes. Four items missed on first-pass review that
// ship as small callable primitives:
//
//   1. exposeUncertainty()          — Hopfield mass ratio as uncertainty signal
//   2. naturalVsSynthetic()          — subsurface translucency binary classifier
//   3. composeRecognitionWithLGN()   — join LGN gate output with recognizeV2
//   4. learnChannelWeightsFromData() — empirical Hebbian per-concept weights
//                                       from the confusion matrix

import { recognizeV2, richDistance, DEFAULT_CHANNEL_WEIGHTS, updateChannelWeights } from "./identity-store-v2.mjs";
import { hopfieldRetrieve } from "./hopfield-retrieval.mjs";
import { applyGate12, channels12Distance } from "../perception/lgn-gate-12.mjs";

// ==================================================================
// #6 · UNCERTAINTY FROM HOPFIELD MASS SPLIT
// ==================================================================

/**
 * Emit-a-set recognition — return top-K concepts with individual masses
 * instead of collapsing to one winner. For multi-object scenes (fruits.jpg
 * with orange+banana+lime+lemon), single-top-1 discards ambiguity that IS
 * the correct answer. This returns the whole distribution.
 *
 * @param {object} sig       rich signature
 * @param {object} store     identity-store-v2
 * @param {object} [opts]
 *   opts.beta, opts.iters, opts.perConceptBeta
 *   opts.minMass          — only include concepts above this mass (default 0.05)
 *   opts.topK             — return at most K (default all above minMass)
 * @returns {{concepts: Array<{label, mass, sharpness}>, verdict: string}}
 */
export function recognizeSet(sig, store, opts = {}) {
  const minMass = opts.minMass ?? 0.05;
  const topK = opts.topK ?? store.labels?.length ?? 5;
  const ret = hopfieldRetrieve(sig, store, opts);
  if (!ret) return { concepts: [], verdict: "no_signal" };
  const above = ret.ranking.filter((r) => r.mass >= minMass).slice(0, topK);
  const verdict = above.length >= 2 && above[0].mass / above[1].mass < 2 ? "multi_object_candidates" :
                  above.length === 1 && above[0].mass > 0.9 ? "single_decisive" :
                  above.length === 1 ? "single_close" :
                  above.length === 0 ? "all_below_min" : "multi_object_candidates";
  return { concepts: above, verdict, sharpness: ret.sharpness };
}

/**
 * Recognize with honest verdict — wraps Hopfield retrieval + uncertainty
 * and returns a `needs_review` flag when the verdict is split. Doctrine
 * at the emit boundary: split verdicts should never surface as claims.
 * Callers who see `needs_review: true` should emit `needs_review` orders,
 * not `recognized_as` orders. Kills the confident-wrong receipt class.
 */
export function recognizeWithHonestVerdict(sig, store, opts = {}) {
  const beta = opts.beta ?? 10;
  const iters = opts.iters ?? 3;
  const ret = hopfieldRetrieve(sig, store, { beta, iters });
  const unc = exposeUncertainty(ret);
  const needs_review = unc.verdict === "split" || unc.verdict === "no_signal";
  return {
    winner: ret?.winner ?? null,
    mass: ret?.winnerMass ?? 0,
    ranking: ret?.ranking ?? [],
    sharpness: ret?.sharpness ?? 0,
    verdict: unc.verdict,
    uncertainty: unc.uncertainty,
    confidence: unc.confidence,
    needs_review,
    emit_action: needs_review ? "needs_review" : "recognized_as",
  };
}

/**
 * Compute uncertainty from a Hopfield retrieval result. Uses the ratio
 * between top-1 mass and top-2 mass. High ratio = confident. Low ratio =
 * confused.
 *
 * @param {ReturnType<typeof hopfieldRetrieve>} retrieval
 * @returns {{
 *   uncertainty: number,   // 0 = crisp winner, 1 = fully split
 *   confidence: number,    // 1 - uncertainty
 *   winner_mass: number,
 *   runner_up_mass: number,
 *   mass_ratio: number,
 *   verdict: "decisive" | "close" | "split"
 * }}
 */
export function exposeUncertainty(retrieval) {
  if (!retrieval || !retrieval.ranking || retrieval.ranking.length === 0) {
    return { uncertainty: 1, confidence: 0, verdict: "no_signal" };
  }
  const top = retrieval.ranking[0];
  const runner = retrieval.ranking[1] ?? { mass: 0 };
  const winner_mass = top.mass;
  const runner_up_mass = runner.mass;
  const mass_ratio = runner_up_mass > 0 ? winner_mass / runner_up_mass : Infinity;
  // uncertainty in [0, 1]: 1 - (winner - runner)/(winner + runner)
  const uncertainty = winner_mass + runner_up_mass > 0
    ? 1 - (winner_mass - runner_up_mass) / (winner_mass + runner_up_mass)
    : 1;
  const confidence = 1 - uncertainty;
  let verdict;
  if (winner_mass > 0.9) verdict = "decisive";
  else if (winner_mass > 0.6 && uncertainty < 0.5) verdict = "close";
  else verdict = "split";
  return { uncertainty, confidence, winner_mass, runner_up_mass, mass_ratio, verdict };
}

// ==================================================================
// #5 · NATURAL VS SYNTHETIC FROM SUBSURFACE ALONE
// ==================================================================

/**
 * Binary classifier: is this a real biological/organic material or an
 * artificial/emissive/synthetic surface (LCD, plastic, print)?
 *
 * The emitter-vs-reflector experiment (seq 41 companion, rcpt
 * rcpt_f8e40d1d917a9270) established: subsurface translucency < 0.3
 * corresponds to no-photons-enter-the-material (screens, opaque
 * plastic). > 0.3 corresponds to real biological/organic scattering.
 *
 * @param {object} subsurfaceSummary  from subsurfaceSummaryForRegion()
 * @returns {{
 *   natural: boolean,
 *   translucency: number,
 *   confidence: number,
 *   reasoning: string
 * }}
 */
export function naturalVsSynthetic(subsurfaceSummary) {
  const t = subsurfaceSummary?.translucencyScore ?? 0;
  const edgeSoft = subsurfaceSummary?.edgeSoftness ?? 0;
  const shadowGlow = subsurfaceSummary?.shadowGlowRatio ?? 0;
  // Combined score with edge softness as tie-breaker
  const combined = 0.6 * t + 0.3 * edgeSoft + 0.1 * shadowGlow;
  const natural = combined > 0.3;
  const confidence = Math.abs(combined - 0.3) / 0.3;   // distance from threshold, normalized
  const reasoning = natural
    ? `translucency=${t.toFixed(2)} + edgeSoft=${edgeSoft.toFixed(2)} > threshold — photons enter and scatter`
    : `combined=${combined.toFixed(2)} < threshold — no subsurface signature, likely emissive or opaque synthetic`;
  return { natural, translucency: t, confidence: Math.min(1, confidence), reasoning };
}

// ==================================================================
// #3 · WIRE LGN GATE INTO RECOGNITION
// ==================================================================

/**
 * Compose LGN gate output with identity-store recognition.
 *
 * The gate modulates channel weights based on active graph concepts.
 * recognizeV2 accepts per-concept weights but currently uses the
 * defaults. This composer takes the gate's 12-vector for retinal
 * channels and applies a mapping to the rich-signature channel weights
 * (color / edge / texture / specular / spatial).
 *
 * Mapping — retinal channel index → rich-signature channel weight:
 *   localEdge (ch9) → edge weight
 *   uniformity (ch11) → inverse of texture weight (uniform = low texture importance)
 *   objectMotion (ch10) → spatial weight
 *   sustained ON/OFF (ch1, ch2) → color weight
 *   transient (ch3, ch4) → specular weight (specular is temporally transient)
 */
export function composeGateWithRichWeights(gate12, base = DEFAULT_CHANNEL_WEIGHTS) {
  // gate12 is [onSustained, offSustained, onTransient, offTransient,
  //             up, down, right, left,
  //             localEdge, objectMotion, uniformity, sustainedDS]
  const [onSus, offSus, onTr, offTr, , , , , edge, objMot, unif] = gate12;
  return {
    color:    base.color    * ((onSus + offSus) / 2),
    edge:     base.edge     * edge,
    texture:  base.texture  * (1 / Math.max(0.1, unif)),   // uniform boost = texture suppressed
    specular: base.specular * ((onTr + offTr) / 2),
    spatial:  base.spatial  * objMot,
  };
}

/**
 * Full recognition with LGN gating: takes a rich signature, a store, and
 * a gate vector. The gate modulates the recognition weights.
 */
export function recognizeWithLGN(sig, store, gate12, opts = {}) {
  const gatedWeights = composeGateWithRichWeights(gate12);
  // Temporarily override per-concept weights for this call
  const original = new Map();
  for (const row of store.labels) {
    original.set(row.label, { ...row.channel_weights });
    row.channel_weights = gatedWeights;
  }
  try {
    return recognizeV2(sig, store, opts);
  } finally {
    // Restore
    for (const row of store.labels) {
      const orig = original.get(row.label);
      if (orig) row.channel_weights = orig;
    }
  }
}

// ==================================================================
// #2 · EMPIRICAL CONCEPT-CHANNEL-WEIGHT LEARNING
// ==================================================================

/**
 * Learn per-concept channel weights from an empirical confusion matrix.
 * For each concept, identify which channels DISCRIMINATE it from its
 * confusion candidates. Channels that separate get up-weighted; channels
 * that don't get down-weighted. Hebbian, no gradient.
 *
 * Method:
 *   For concept C with signatures S_C and confusion set (other-concept
 *   signatures) X:
 *     for each channel k:
 *       within_C_mean_dist[k] = mean richDistance_k(s1, s2) for s1, s2 in S_C
 *       across_C_mean_dist[k] = mean richDistance_k(s in S_C, x in X)
 *       discrimination[k] = across / (within + ε)
 *   Normalize discrimination to sum-to-fixed and store as C's weights.
 *
 * @param {object} store        identity-store-v2 shape
 * @param {object} [opts]
 *   opts.channels — which rich channels to learn weights for
 *     default ["color","edge","texture","specular","spatial"]
 * @returns {Map<string, object>}  per-concept learned weights
 */
export function learnChannelWeightsFromData(store, opts = {}) {
  const channels = opts.channels ?? ["color", "edge", "texture", "specular", "spatial"];
  const learned = new Map();
  if (!store.labels || store.labels.length < 2) return learned;

  for (const conceptRow of store.labels) {
    const others = store.labels.filter((r) => r.label !== conceptRow.label);
    if (!others.length) continue;

    const perChannel = {};
    for (const ch of channels) {
      // Isolated single-channel weight
      const isoWeights = Object.fromEntries(channels.map((c) => [c, c === ch ? 1.0 : 0.0]));

      // Within-concept mean pairwise distance in this channel alone
      const S = conceptRow.signatures.map((s) => s.sig);
      let withinSum = 0, withinN = 0;
      for (let i = 0; i < S.length; i++) for (let j = i + 1; j < S.length; j++) {
        withinSum += richDistance(S[i], S[j], isoWeights);
        withinN++;
      }
      const withinMean = withinN ? withinSum / withinN : 0;

      // Across-concept mean distance
      let acrossSum = 0, acrossN = 0;
      for (const otherRow of others) {
        for (const s of S) for (const t of otherRow.signatures) {
          acrossSum += richDistance(s, t.sig, isoWeights);
          acrossN++;
        }
      }
      const acrossMean = acrossN ? acrossSum / acrossN : 0;

      // Discrimination ratio — how well this channel separates
      perChannel[ch] = acrossMean / (withinMean + 1e-6);
    }

    // Normalize so weights sum to base sum (preserve overall distance scale)
    const baseSum = Object.values(DEFAULT_CHANNEL_WEIGHTS).reduce((a, b) => a + b, 0);
    const rawSum = Object.values(perChannel).reduce((a, b) => a + b, 0) || 1;
    const normalized = {};
    for (const ch of channels) normalized[ch] = (perChannel[ch] / rawSum) * baseSum;
    learned.set(conceptRow.label, normalized);
  }

  return learned;
}

/**
 * Apply learned weights to the store in place.
 */
export function applyLearnedWeights(store, learned) {
  for (const [label, weights] of learned.entries()) {
    // MUST pass 'learned'. These weights were fitted from confusion data and are
    // read back at recognition time (identity-store-v2 recognizeV2, and
    // recognize-human-grade). Letting them stamp as the default 'manual' would
    // mislabel a fitted parameter as a hand choice — worse than no stamp at all,
    // because it would look like an answered question.
    updateChannelWeights(store, label, weights, 'learned', 'learnChannelWeightsFromData');
  }
  return store;
}
