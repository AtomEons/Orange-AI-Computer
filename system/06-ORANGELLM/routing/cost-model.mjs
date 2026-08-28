// routing/cost-model.mjs
//
// OrangeBrain routing improvement 1/6 — per-lane COST MODEL (Pillar 2).
//
// The least-action router (../router-least-action.mjs) carries one nameplate
// number per lane (`est_cost`, dimensionless per-call). That is enough for a
// tie-break but too coarse for economics: a 40-word chat order and a 2,000-
// word design order cost very different amounts on the SAME lane. This module
// refines the estimate into tokens + latency + cost-units per lane, so
// OrangeBrain can see WHAT the cheapest sufficient lane actually costs before
// it dispatches.
//
// Doctrine:
//   - The router stays the DECISION AUTHORITY. This module never overrides
//     pickLane; `cheapestSufficientLane` consumes the router's own scorecard
//     (its eligibility verdicts) and only ranks the lanes the router already
//     declared legal. It reports agreement/disagreement with the router's
//     pick honestly (`agrees_with_router`, `cost_delta_units`) instead of
//     silently substituting its own opinion. Not a parallel router.
//   - Estimates are NAMEPLATES, not measurements. Token counts come from the
//     chars/4 heuristic; throughput and latency come from the hand-curated
//     table below. Every returned envelope says `basis: "nameplate"` so a
//     receipt can never dress a guess up as a measurement (Mom's Law).
//   - Pure + deterministic. No Date.now(), no I/O, no mutation of inputs.
//     Same order in -> byte-identical estimate out.
//
// Exports:
//   COST_SCHEMA_ID
//   TOKEN_HEURISTICS               -> frozen token-estimate constants
//   LANE_ECONOMICS                 -> frozen per-lane throughput nameplates
//   estimateOrderTokens(order)     -> { tokens_in, tokens_out, basis, ... }
//   estimateLaneCost(laneId, order)-> per-lane { tokens, latency, cost_units }
//   costTable(order)               -> all 5 lanes, LANE_TABLE order
//   cheapestSufficientLane(order, systemState?, opts?) -> ranked verdict
//   annotateDecision(decision, order) -> decision copy + .cost envelope
//   __costInternals

import {
  pickLane,
  compileOrderSignals,
  LANE_TABLE,
  __routerInternals,
} from "../router-least-action.mjs";

export const COST_SCHEMA_ID = "orange5.orangebrain.lane-cost.v1";

const { LANE_INDEX } = __routerInternals;

// ---------------------------------------------------------------------------
// Token heuristics (nameplate, stated as such)
//
//   chars/4         — the standard rough BPE tokens-per-char ratio for English
//                     / code. Good to ~±20%; we never claim better.
//   envelope        — fixed prompt scaffolding around the order (system line,
//                     order envelope, receipts contract).
//   output          — output need grows with order complexity: a complexity-0
//                     echo is ~32 tokens; a complexity-10 design answer is
//                     ~992. Linear in the router's own complexity signal so
//                     the two models can never disagree about what "complex"
//                     means.
// ---------------------------------------------------------------------------

export const TOKEN_HEURISTICS = Object.freeze({
  chars_per_token: 4,
  envelope_overhead_tokens: 96,
  output_base_tokens: 32,
  output_tokens_per_complexity: 96,
});

// Per-lane serving economics (nameplate v1, hand-curated to match the
// LANE_TABLE nameplates in the router — reflex is a 0.6b on the N150, the
// Codexa lanes are local Ollama-class serving, frontier is a fast remote API).
//   tokens_per_sec      — decode throughput used for the latency estimate
//   cost_per_1k_tokens  — marginal cost-units per 1k total tokens, expressed
//                         in the SAME dimensionless units as LANE_TABLE
//                         est_cost so the two compose (est_cost covers the
//                         first 1k; beyond that we scale linearly).
// ---------------------------------------------------------------------------

export const LANE_ECONOMICS = Object.freeze({
  reflex: Object.freeze({ tokens_per_sec: 30, cost_per_1k_tokens: 0.0001 }),
  "local-fast": Object.freeze({ tokens_per_sec: 45, cost_per_1k_tokens: 0.002 }),
  "local-code": Object.freeze({ tokens_per_sec: 40, cost_per_1k_tokens: 0.003 }),
  heavy: Object.freeze({ tokens_per_sec: 35, cost_per_1k_tokens: 0.006 }),
  frontier: Object.freeze({ tokens_per_sec: 60, cost_per_1k_tokens: 0.05 }),
});

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function laneRow(laneId) {
  const idx = LANE_INDEX[laneId];
  if (idx === undefined) {
    throw new RangeError(`unknown lane: ${String(laneId)} (expected one of ${LANE_TABLE.map((l) => l.lane).join(", ")})`);
  }
  return LANE_TABLE[idx];
}

// ---------------------------------------------------------------------------
// estimateOrderTokens — how many tokens will this order move?
// ---------------------------------------------------------------------------

/**
 * @param {object} order an orange.order.v1 (or compatible partial)
 * @returns {{
 *   tokens_in:number, tokens_out:number, tokens_total:number,
 *   complexity:number, basis:'nameplate'
 * }}
 */
export function estimateOrderTokens(order) {
  const o = order && typeof order === "object" ? order : {};
  const intent = typeof o.intent === "string" ? o.intent : "";
  const scope = typeof o.scope === "string" ? o.scope : "";
  const chars = intent.length + scope.length;

  const sig = compileOrderSignals(o);
  const h = TOKEN_HEURISTICS;

  const tokens_in = h.envelope_overhead_tokens + Math.ceil(chars / h.chars_per_token);
  const tokens_out = h.output_base_tokens + sig.complexity * h.output_tokens_per_complexity;

  return {
    tokens_in,
    tokens_out,
    tokens_total: tokens_in + tokens_out,
    complexity: sig.complexity,
    basis: "nameplate",
  };
}

// ---------------------------------------------------------------------------
// estimateLaneCost — one lane, one order
// ---------------------------------------------------------------------------

/**
 * Estimate the tokens / latency / cost-units of running `order` on `laneId`.
 *
 * cost model: LANE_TABLE.est_cost is the per-call nameplate covering up to 1k
 * total tokens; beyond 1k the marginal cost_per_1k_tokens scales linearly:
 *
 *   cost_units = est_cost + max(0, tokens_total - 1000)/1000 * cost_per_1k
 *
 * latency model: lane lat_p50_ms (queue + prefill nameplate) plus decode time
 * for the estimated output tokens at the lane's nameplate throughput.
 *
 * @param {string} laneId one of the 5 superstack lanes
 * @param {object} order  an orange.order.v1 (or compatible partial)
 */
export function estimateLaneCost(laneId, order) {
  const lane = laneRow(laneId);
  const econ = LANE_ECONOMICS[laneId];
  const t = estimateOrderTokens(order);

  const overflowTokens = Math.max(0, t.tokens_total - 1000);
  const cost_units = round6(lane.est_cost + (overflowTokens / 1000) * econ.cost_per_1k_tokens);
  const decode_ms = Math.round((t.tokens_out / econ.tokens_per_sec) * 1000);
  const est_latency_ms = lane.lat_p50_ms + decode_ms;

  return {
    schema: COST_SCHEMA_ID,
    lane: lane.lane,
    model: lane.model,
    tokens_in: t.tokens_in,
    tokens_out: t.tokens_out,
    tokens_total: t.tokens_total,
    est_latency_ms,
    decode_ms,
    cost_units,
    nameplate_call_cost: lane.est_cost,
    basis: "nameplate",
  };
}

// ---------------------------------------------------------------------------
// costTable — the full 5-lane economics view for one order
// ---------------------------------------------------------------------------

/**
 * @param {object} order
 * @returns {object[]} one estimate per lane, in LANE_TABLE order
 */
export function costTable(order) {
  return LANE_TABLE.map((l) => estimateLaneCost(l.lane, order));
}

// ---------------------------------------------------------------------------
// cheapestSufficientLane — the economics verdict, routed THROUGH the router
//
// "Sufficient" is not this module's call to make: eligibility (risk floor,
// capability floor, latency budget) belongs to pickLane. We take the router's
// scorecard, keep only the lanes IT declared eligible, and rank those by
// estimated cost_units (tie -> cheaper/earlier lane). The result is the
// cheapest lane that the router itself already certified as sufficient.
// ---------------------------------------------------------------------------

/**
 * @param {object} order
 * @param {object} [systemState] Flowstate snapshot (passed straight to pickLane)
 * @param {object} [opts]        pickLane opts ({cap, ts})
 * @returns {{
 *   schema:string, lane:string|null, model:string|null, cost:object|null,
 *   router_lane:string|null, agrees_with_router:boolean,
 *   cost_delta_units:number, decision_id:string, table:object[], reason:string
 * }}
 */
export function cheapestSufficientLane(order, systemState = {}, opts = {}) {
  const decision = pickLane(order, systemState, opts);
  const eligible = decision.scorecard.filter((s) => s.eligible);

  if (decision.lane === null || eligible.length === 0) {
    return {
      schema: COST_SCHEMA_ID,
      lane: null,
      model: null,
      cost: null,
      router_lane: null,
      agrees_with_router: true, // both say "no lane" — agreement, honestly
      cost_delta_units: 0,
      decision_id: decision.decision_id,
      table: [],
      reason: decision.rationale,
    };
  }

  const table = eligible
    .map((s) => estimateLaneCost(s.lane, order))
    .sort((a, b) => {
      if (a.cost_units !== b.cost_units) return a.cost_units - b.cost_units;
      return LANE_INDEX[a.lane] - LANE_INDEX[b.lane];
    });

  const cheapest = table[0];
  const routerCost = table.find((e) => e.lane === decision.lane)
    ?? estimateLaneCost(decision.lane, order);
  const delta = round6(routerCost.cost_units - cheapest.cost_units);
  const agrees = cheapest.lane === decision.lane;

  return {
    schema: COST_SCHEMA_ID,
    lane: cheapest.lane,
    model: cheapest.model,
    cost: cheapest,
    router_lane: decision.lane,
    agrees_with_router: agrees,
    cost_delta_units: delta,
    decision_id: decision.decision_id,
    table,
    reason: agrees
      ? `router pick ${decision.lane} is already the cheapest sufficient lane (${cheapest.cost_units} units)`
      : `router picked ${decision.lane} (+${delta} units over ${cheapest.lane}) — router pick stands (warmth/field trade-off); delta reported for the receipt`,
  };
}

// ---------------------------------------------------------------------------
// annotateDecision — attach the economics to a decision envelope (copy)
// ---------------------------------------------------------------------------

/**
 * Returns a SHALLOW COPY of the decision with a `.cost` envelope attached.
 * Never mutates the input (the decision_id hash must stay intact).
 *
 * @param {object} decision a pickLane decision envelope
 * @param {object} order    the order the decision was made for
 */
export function annotateDecision(decision, order) {
  if (decision == null || typeof decision !== "object") {
    throw new TypeError("annotateDecision: decision must be an object");
  }
  const cost = decision.lane === null ? null : estimateLaneCost(decision.lane, order);
  return { ...decision, cost };
}

export const __costInternals = Object.freeze({
  round6,
  laneRow,
});
