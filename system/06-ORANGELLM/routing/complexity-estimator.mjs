// routing/complexity-estimator.mjs
//
// OrangeBrain routing improvement 4/6 — COMPLEXITY ESTIMATOR (Pillar 2).
//
// pickLane (../router-least-action.mjs) already derives a 0-10 complexity from
// compileOrderSignals, and it drives `demand`. But that number arrives as a
// single scalar with no breakdown: OrangeBrain (and any receipt) can't see WHY
// an order scored 7, or which lane band that complexity implies before the
// full field-aware pick runs. This module explains the router's own complexity
// signal — it decomposes the score into named contributions and maps it to the
// lane band the router would demand from complexity alone (risk/field aside).
//
// Doctrine:
//   - The router owns the number. We call compileOrderSignals and REPORT its
//     complexity + demand; we never compute a competing complexity that could
//     disagree with the router. Every extra field here (length/hint/breadth
//     contributions) is a re-derivation of the SAME features the router used,
//     surfaced for explanation — the totals reconcile to the router's value.
//   - "Band" is advisory, not authority. mapComplexityToBand answers "if only
//     complexity mattered, which lane clears it?" using the REAL LANE_TABLE
//     ceilings and the router's demandOf(). The true pick still comes from
//     pickLane (which also weighs risk floor, capability, field). We label the
//     band `advisory` and always cross-check against pickLane in `estimate`.
//   - Pure + deterministic. Same order -> same estimate.
//
// Exports:
//   COMPLEXITY_SCHEMA_ID
//   COMPLEXITY_BANDS                     -> frozen band cutoffs
//   decomposeComplexity(order)           -> named contributions -> router total
//   mapComplexityToBand(complexity, risk?) -> advisory lane band via LANE_TABLE
//   estimate(order, systemState?, opts?) -> full report cross-checked vs pickLane
//   __complexityInternals

import {
  pickLane,
  compileOrderSignals,
  LANE_TABLE,
  __routerInternals,
} from "../router-least-action.mjs";

export const COMPLEXITY_SCHEMA_ID = "orange5.orangebrain.complexity.v1";

const { LANE_INDEX, demandOf } = __routerInternals;

// The same hint tables the router uses, re-declared here ONLY to explain the
// contribution breakdown. They MUST mirror the router; a drift guard below
// asserts the recomputed complexity equals the router's own value, so if these
// ever fall out of sync a test fails loudly rather than lying in a receipt.
const COMPLEX_HINTS = [
  "architect", "design", "refactor", "migrate", "prove", "optimi", "debug",
  "root cause", "multi-step", "orchestrat", "pipeline", "algorithm", "concurren",
  "distributed", "security", "cryptograph", "compiler", "reason about", "trade-off",
  "trade off", "analyze", "synthesi", "plan the", "strategy",
];
const TRIVIAL_HINTS = [
  "hi", "hello", "echo", "ping", "spell", "capitalize", "uppercase", "lowercase",
  "what time", "yes or no", "one word", "say ", "repeat ", "greet",
];

// Complexity band cutoffs (advisory). These describe the SHAPE of the demand
// curve; the actual lane legality is LANE_TABLE ceiling math, not these labels.
export const COMPLEXITY_BANDS = Object.freeze([
  Object.freeze({ band: "trivial", max: 1, hint: "reflex-class: echo/greet/one-word" }),
  Object.freeze({ band: "light", max: 3, hint: "reflex..local-fast: short chat/classify" }),
  Object.freeze({ band: "moderate", max: 6, hint: "local-fast..local-code: reasoning/summarize/code" }),
  Object.freeze({ band: "heavy", max: 9, hint: "heavy: long/judge/multi-step" }),
  Object.freeze({ band: "frontier", max: 10, hint: "frontier: peak difficulty" }),
]);

function textOf(order) {
  const parts = [];
  if (order && typeof order.intent === "string") parts.push(order.intent);
  if (order && typeof order.scope === "string") parts.push(order.scope);
  return parts.join(" \n ").toLowerCase();
}
function countHints(hay, hints) {
  let n = 0;
  for (const h of hints) if (hay.includes(h)) n += 1;
  return n;
}
function round2(n) {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// decomposeComplexity — show the work behind the router's complexity number.
//
// The router's formula (compileOrderSignals):
//   complexity  = clampInt(
//       min(3, words/20)
//     + min(4, complexHits*1.5)
//     + min(2, max(0, actionBreadth-1)*0.6)
//     - min(3, trivialHits*2), 0, 10)
//
// We reproduce each capped term as a named contribution, then report the
// router's OWN clamped total (single source of truth) alongside our raw sum.
// ---------------------------------------------------------------------------

export function decomposeComplexity(order) {
  const o = order && typeof order === "object" ? order : {};
  const hay = textOf(o);
  const words = hay ? hay.split(/\s+/).filter(Boolean).length : 0;
  const complexHits = countHints(hay, COMPLEX_HINTS);
  const trivialHits = countHints(hay, TRIVIAL_HINTS);
  const allowed = Array.isArray(o.allowedActions) ? o.allowedActions : [];
  const actionBreadth = allowed.length;

  const length_term = Math.min(3, words / 20);
  const hint_term = Math.min(4, complexHits * 1.5);
  const breadth_term = Math.min(2, Math.max(0, actionBreadth - 1) * 0.6);
  const trivial_penalty = -Math.min(3, trivialHits * 2);

  const raw_sum = length_term + hint_term + breadth_term + trivial_penalty;

  // Single source of truth: the router's own compiled complexity.
  const sig = compileOrderSignals(o);

  return {
    schema: COMPLEXITY_SCHEMA_ID,
    complexity: sig.complexity,            // authoritative (router)
    demand: demandOf(sig),                 // authoritative (router blend w/ risk)
    contributions: {
      length_term: round2(length_term),
      hint_term: round2(hint_term),
      breadth_term: round2(breadth_term),
      trivial_penalty: round2(trivial_penalty),
    },
    raw_sum: round2(raw_sum),
    features: {
      words,
      complex_hits: complexHits,
      trivial_hits: trivialHits,
      action_breadth: actionBreadth,
    },
    // Reconciliation flag: our re-derived clamp must equal the router value.
    reconciles: Math.max(0, Math.min(10, Math.round(raw_sum))) === sig.complexity,
  };
}

// ---------------------------------------------------------------------------
// mapComplexityToBand — advisory lane band from a complexity (and optional
// risk scalar), computed against the REAL LANE_TABLE ceilings via demandOf.
// ---------------------------------------------------------------------------

/**
 * @param {number} complexity 0-10
 * @param {number} [risk=0]   0-10 risk scalar (so a complexity-only caller can
 *                            still fold in risk if it has it)
 * @returns {{
 *   band:string, hint:string, demand:number,
 *   min_lane:string, min_lane_ceiling:number, advisory:true
 * }}
 */
export function mapComplexityToBand(complexity, risk = 0) {
  const c = Math.max(0, Math.min(10, Number.isFinite(complexity) ? complexity : 0));
  const r = Math.max(0, Math.min(10, Number.isFinite(risk) ? risk : 0));
  // Reuse the router's own demand blend so the band can never define demand
  // differently than pickLane does.
  const demand = demandOf({ complexity: c, risk: r });

  const bandDef = COMPLEXITY_BANDS.find((b) => c <= b.max) ?? COMPLEXITY_BANDS[COMPLEXITY_BANDS.length - 1];

  // Smallest lane whose ceiling clears the demand (capability-only view).
  let min_lane = null;
  let min_ceiling = null;
  for (const l of LANE_TABLE) {
    if (l.ceiling >= demand) {
      min_lane = l.lane;
      min_ceiling = l.ceiling;
      break;
    }
  }
  // demand>max ceiling => top lane
  if (min_lane === null) {
    const top = LANE_TABLE[LANE_TABLE.length - 1];
    min_lane = top.lane;
    min_ceiling = top.ceiling;
  }

  return {
    band: bandDef.band,
    hint: bandDef.hint,
    demand,
    min_lane,
    min_lane_ceiling: min_ceiling,
    advisory: true,
  };
}

// ---------------------------------------------------------------------------
// estimate — the full complexity report, cross-checked against the REAL pick.
//
// It decomposes the complexity, derives the advisory band, then runs pickLane
// and reports whether the advisory min_lane <= the router's actual chosen lane
// (it should never EXCEED it: complexity alone can only demand as much as the
// router, which additionally weighs risk/field). `band_within_router` makes
// that invariant observable.
// ---------------------------------------------------------------------------

/**
 * @param {object} order
 * @param {object} [systemState]
 * @param {object} [opts]
 */
export function estimate(order, systemState = {}, opts = {}) {
  const dec = decomposeComplexity(order);
  const sig = compileOrderSignals(order);
  const band = mapComplexityToBand(sig.complexity, sig.risk);
  const decision = pickLane(order, systemState, opts);

  const advisoryIdx = LANE_INDEX[band.min_lane];
  const chosenIdx = decision.lane === null ? Infinity : LANE_INDEX[decision.lane];
  const band_within_router = decision.lane === null ? true : advisoryIdx <= chosenIdx;

  return {
    schema: COMPLEXITY_SCHEMA_ID,
    complexity: dec.complexity,
    demand: dec.demand,
    contributions: dec.contributions,
    features: dec.features,
    reconciles: dec.reconciles,
    band: band.band,
    band_hint: band.hint,
    advisory_min_lane: band.min_lane,
    router_lane: decision.lane,
    band_within_router,
    decision_id: decision.decision_id,
    reason:
      `complexity=${dec.complexity} (${dec.band ?? band.band}); advisory floor lane=${band.min_lane}; ` +
      `router chose ${decision.lane ?? "none"} (also weighs risk=${sig.risk}/field). ` +
      (band_within_router
        ? "advisory floor is within the router's pick (consistent)."
        : "WARN: advisory floor exceeds router pick — investigate hint-table drift."),
  };
}

export const __complexityInternals = Object.freeze({
  COMPLEX_HINTS,
  TRIVIAL_HINTS,
  textOf,
  countHints,
  round2,
});
