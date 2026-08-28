// routing/budget-throttle.mjs
//
// OrangeBrain routing improvement 6/6 — BUDGET THROTTLE (Pillar 2).
//
// pickLane (../router-least-action.mjs) picks the smallest SUFFICIENT lane per
// order under the field — but it has no notion of a SESSION budget. Over many
// orders, even correct per-order picks can drain a cost ceiling (a run of
// frontier-eligible orders, say). OrangeBrain needs a governor that watches
// cumulative spend and, as the cap approaches, DOWNSHIFTS to the cheapest lane
// the router still certifies legal — never below the router's hard floor.
//
// Doctrine:
//   - The router's floor is inviolable. Downshifting can only move DOWN to a
//     lane the router already marked ELIGIBLE (i.e. one that still clears the
//     risk floor + capability + latency). We compute the eligible set from the
//     router's own scorecard and pick the cheapest of those. We NEVER route a
//     high-risk order through a sub-floor lane to save money — that mirrors the
//     router's own rule (§2: hard constraints precede optimization).
//   - Budget pressure behaves like backpressure: it PULLS toward cheaper lanes
//     and can never push UP. If even the cheapest eligible lane would exceed
//     the remaining budget, we do not silently overspend and we do not drop the
//     floor — we return `over_budget:true` and defer the ship/hold decision to
//     the caller (a human gate), reporting the shortfall honestly.
//   - Cost estimates come from routing/cost-model.mjs (module 1/6), which is
//     itself gated by the real router. Nameplate basis is carried through so a
//     receipt can't mistake an estimate for a measurement (Mom's Law).
//   - Pure functional core. A budget is a plain object; charging returns a NEW
//     budget. Determinism: same (budget, order, field) -> same verdict.
//
// Exports:
//   BUDGET_SCHEMA_ID
//   THROTTLE_BANDS                       -> frozen utilization -> policy bands
//   newBudget(limitUnits, opts?)         -> fresh session budget
//   charge(budget, units)                -> budget with units spent (new object)
//   throttledLane(budget, order, systemState?, opts?) -> router-gated verdict
//   runWithBudget(budget, order, systemState?, opts?)  -> verdict + charged budget
//   __budgetInternals

import { pickLane, __routerInternals } from "../router-least-action.mjs";
import { estimateLaneCost } from "./cost-model.mjs";

export const BUDGET_SCHEMA_ID = "orange5.orangebrain.budget-throttle.v1";

const { LANE_INDEX } = __routerInternals;

// Utilization bands -> throttle policy. As the session spends more of its
// ceiling, the policy tightens from "no throttle" to "hard downshift".
//   spent/limit in [0, warn)       -> "open": router pick stands.
//   spent/limit in [warn, tight)   -> "prefer_cheaper": among eligible lanes,
//                                     take the cheapest (drop overshoot spend).
//   spent/limit in [tight, 1)      -> "cheapest_only": force cheapest eligible.
//   spent/limit >= 1               -> "exhausted": budget already spent.
export const THROTTLE_BANDS = Object.freeze({
  warn: 0.6,
  tight: 0.85,
});

function round6(n) {
  return Math.round(n * 1e6) / 1e6;
}

function policyFor(utilization) {
  if (!(utilization < 1)) return "exhausted";
  if (utilization >= THROTTLE_BANDS.tight) return "cheapest_only";
  if (utilization >= THROTTLE_BANDS.warn) return "prefer_cheaper";
  return "open";
}

// ---------------------------------------------------------------------------
// newBudget — a fresh session budget in cost-units (same dimensionless units
// as LANE_TABLE.est_cost / cost-model cost_units).
// ---------------------------------------------------------------------------

/**
 * @param {number} limitUnits total session ceiling in cost-units (> 0)
 * @param {object} [opts]
 * @param {number} [opts.spent=0] pre-existing spend
 * @param {string} [opts.label]   human label for receipts
 */
export function newBudget(limitUnits, opts = {}) {
  const limit = Number.isFinite(limitUnits) && limitUnits > 0 ? limitUnits : 0;
  const spent = Number.isFinite(opts.spent) && opts.spent > 0 ? opts.spent : 0;
  return Object.freeze({
    schema: BUDGET_SCHEMA_ID,
    label: typeof opts.label === "string" ? opts.label : "session",
    limit_units: round6(limit),
    spent_units: round6(spent),
    remaining_units: round6(Math.max(0, limit - spent)),
    orders_charged: Number.isFinite(opts.orders_charged) ? opts.orders_charged : 0,
  });
}

// ---------------------------------------------------------------------------
// charge — spend `units` against the budget. Returns a NEW budget. Overspend
// is allowed to be RECORDED (remaining floors at 0) so the caller can see the
// overrun; the throttle logic is what prevents choosing to overspend.
// ---------------------------------------------------------------------------

export function charge(budget, units) {
  const u = Number.isFinite(units) && units > 0 ? units : 0;
  const spent = round6(budget.spent_units + u);
  return Object.freeze({
    ...budget,
    spent_units: spent,
    remaining_units: round6(Math.max(0, budget.limit_units - spent)),
    orders_charged: budget.orders_charged + 1,
  });
}

function utilizationOf(budget) {
  if (budget.limit_units <= 0) return 1; // a zero budget is always exhausted
  return budget.spent_units / budget.limit_units;
}

// ---------------------------------------------------------------------------
// throttledLane — the budget-aware lane verdict, gated by the REAL router.
//
// Steps:
//   1) pickLane(order, field) -> router's unthrottled pick + eligible set.
//   2) Estimate each eligible lane's cost via cost-model (router-gated).
//   3) Apply the utilization policy:
//        open           -> keep router pick.
//        prefer_cheaper -> cheapest eligible whose est cost <= remaining, else
//                          cheapest eligible (report if it still overflows).
//        cheapest_only  -> cheapest eligible, full stop.
//        exhausted      -> cheapest eligible + over_budget flag.
//   4) The result lane is ALWAYS an eligible (>= floor) lane. If the chosen
//      lane's estimate exceeds remaining budget, `over_budget:true` and the
//      caller decides (human gate) — we never silently overspend or drop floor.
// ---------------------------------------------------------------------------

/**
 * @param {object} budget      a newBudget/charge result
 * @param {object} order       an orange.order.v1 (or compatible partial)
 * @param {object} [systemState] Flowstate snapshot (passed to pickLane)
 * @param {object} [opts]      pickLane opts ({cap, ts})
 * @returns {{
 *   schema:string, lane:string|null, model:string|null,
 *   router_lane:string|null, downshifted:boolean, policy:string,
 *   utilization:number, est_cost_units:number, remaining_units:number,
 *   over_budget:boolean, would_exceed_by:number, decision_id:string,
 *   candidates:object[], reason:string
 * }}
 */
export function throttledLane(budget, order, systemState = {}, opts = {}) {
  const decision = pickLane(order, systemState, opts);
  const eligible = decision.scorecard.filter((s) => s.eligible);
  const utilization = utilizationOf(budget);
  const policy = policyFor(utilization);

  if (decision.lane === null || eligible.length === 0) {
    return {
      schema: BUDGET_SCHEMA_ID,
      lane: null,
      model: null,
      router_lane: null,
      downshifted: false,
      policy,
      utilization: round6(utilization),
      est_cost_units: 0,
      remaining_units: budget.remaining_units,
      over_budget: false,
      would_exceed_by: 0,
      decision_id: decision.decision_id,
      candidates: [],
      reason: `no eligible lane — nothing to throttle (${decision.rationale})`,
    };
  }

  // Cost each eligible lane (cheapest first, tie -> cheaper/earlier lane).
  const candidates = eligible
    .map((s) => {
      const c = estimateLaneCost(s.lane, order);
      return { lane: c.lane, model: c.model, est_cost_units: c.cost_units, basis: c.basis };
    })
    .sort((a, b) => {
      if (a.est_cost_units !== b.est_cost_units) return a.est_cost_units - b.est_cost_units;
      return LANE_INDEX[a.lane] - LANE_INDEX[b.lane];
    });

  const cheapest = candidates[0];
  const routerPick =
    candidates.find((c) => c.lane === decision.lane) ??
    (() => {
      const c = estimateLaneCost(decision.lane, order);
      return { lane: c.lane, model: c.model, est_cost_units: c.cost_units, basis: c.basis };
    })();

  let chosen;
  switch (policy) {
    case "open":
      chosen = routerPick;
      break;
    case "prefer_cheaper": {
      // cheapest eligible that fits the remaining budget; else the cheapest.
      const fits = candidates.find((c) => c.est_cost_units <= budget.remaining_units);
      chosen = fits ?? cheapest;
      break;
    }
    case "cheapest_only":
    case "exhausted":
    default:
      chosen = cheapest;
      break;
  }

  const overBy = round6(Math.max(0, chosen.est_cost_units - budget.remaining_units));
  const over_budget = overBy > 0;
  const downshifted = chosen.lane !== decision.lane;

  return {
    schema: BUDGET_SCHEMA_ID,
    lane: chosen.lane,
    model: chosen.model,
    router_lane: decision.lane,
    downshifted,
    policy,
    utilization: round6(utilization),
    est_cost_units: chosen.est_cost_units,
    remaining_units: budget.remaining_units,
    over_budget,
    would_exceed_by: overBy,
    decision_id: decision.decision_id,
    candidates,
    reason: buildReason({ policy, decision, chosen, downshifted, over_budget, overBy, budget }),
  };
}

function buildReason({ policy, decision, chosen, downshifted, over_budget, overBy, budget }) {
  const base =
    policy === "open"
      ? `budget healthy (${round6(budget.remaining_units)}u left) — router pick '${decision.lane}' stands`
      : policy === "prefer_cheaper"
        ? `budget ${Math.round(THROTTLE_BANDS.warn * 100)}%+ used — preferring cheapest eligible`
        : policy === "cheapest_only"
          ? `budget ${Math.round(THROTTLE_BANDS.tight * 100)}%+ used — forcing cheapest eligible lane`
          : `budget EXHAUSTED — cheapest eligible lane only`;
  const shift = downshifted
    ? `; downshifted ${decision.lane} -> ${chosen.lane} (still >= router floor)`
    : `; no downshift needed (already cheapest sufficient)`;
  const over = over_budget
    ? `; WARNING over_budget by ${overBy}u — cannot drop below the router floor to save more; caller/human must approve or hold`
    : "";
  return base + shift + over;
}

// ---------------------------------------------------------------------------
// runWithBudget — throttle + charge in one call. Returns the verdict and the
// budget AFTER charging the chosen lane's estimated cost. If the chosen lane is
// over budget, we still return the verdict but DO NOT auto-charge past the cap
// silently — we charge the estimate (so the overrun is visible in spent_units)
// and flag it; the caller decides whether the order actually ships.
// ---------------------------------------------------------------------------

/**
 * @returns {{ verdict:object, budget:object }}
 */
export function runWithBudget(budget, order, systemState = {}, opts = {}) {
  const verdict = throttledLane(budget, order, systemState, opts);
  if (verdict.lane === null) {
    return { verdict, budget };
  }
  const charged = charge(budget, verdict.est_cost_units);
  return { verdict, budget: charged };
}

export const __budgetInternals = Object.freeze({
  policyFor,
  utilizationOf,
  round6,
  LANE_INDEX,
});
