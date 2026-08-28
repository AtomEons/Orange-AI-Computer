// routing/fallback-cascade.mjs
//
// OrangeBrain routing improvement 3/6 — FALLBACK CASCADE (Pillar 2).
//
// pickLane (../router-least-action.mjs) returns the single smallest sufficient
// lane for an order under the current field. But dispatch can FAIL: the chosen
// lane times out, OOMs, refuses, or returns garbage. OrangeBrain then needs a
// DETERMINISTIC answer to "what do we try next?" — not an ad-hoc retry, not a
// silent drop. This module computes that escalation ladder ONCE, up front, from
// the router's own eligibility verdict, so every failure has a pre-declared,
// reasoned next step.
//
// Doctrine:
//   - The router defines "capable". We do NOT invent our own capability test.
//     The cascade is exactly the router's own eligible scorecard, ordered from
//     the router's chosen lane UPWARD (heavier = more capable). A lane the
//     router marked ineligible (fails risk floor / capability / latency) NEVER
//     enters the cascade — escalating into an illegal lane would break the same
//     hard safety line the router enforces.
//   - Escalation only goes UP. On failure we move to a heavier eligible lane
//     (more headroom), never sideways or down — a lane that already cleared the
//     floor and failed for capacity reasons won't be helped by an equal/smaller
//     lane. When no heavier eligible lane exists, the cascade is EXHAUSTED and
//     says so honestly (the order needs a human or a warrant upgrade).
//   - Every hop carries a machine reason (why we left the prior lane) and the
//     router's decision_id, so the escalation is auditable end to end.
//   - Pure + deterministic. No I/O, no clocks beyond the router's own opts.ts.
//
// Exports:
//   CASCADE_SCHEMA_ID
//   FAILURE_CLASSES                       -> frozen set of recognized reasons
//   buildCascade(order, systemState?, opts?) -> full pre-planned ladder
//   nextLane(cascade, currentLane, failure)  -> the next hop (or exhausted)
//   simulateFailures(order, failures, systemState?, opts?) -> replay a run
//   __cascadeInternals

import {
  pickLane,
  LANE_TABLE,
  __routerInternals,
} from "../router-least-action.mjs";

export const CASCADE_SCHEMA_ID = "orange5.orangebrain.fallback-cascade.v1";

const { LANE_INDEX } = __routerInternals;

// Recognized dispatch-failure classes. Each maps to whether escalation is the
// right response. A capability/capacity failure (timeout, oom, overloaded,
// bad_output) escalates UP. A hard refusal that a bigger model can't fix
// (policy_refusal) still escalates once — a more capable lane may handle the
// framing — but a caller can also choose to stop. content_ok is not a failure.
export const FAILURE_CLASSES = Object.freeze({
  timeout: { escalate: true, note: "lane exceeded its latency envelope" },
  oom: { escalate: true, note: "lane ran out of memory / context" },
  overloaded: { escalate: true, note: "lane/backpressure rejected the call" },
  bad_output: { escalate: true, note: "lane returned unusable / low-quality output" },
  error: { escalate: true, note: "lane raised an unclassified error" },
  policy_refusal: { escalate: true, note: "lane refused; a more capable lane may reframe" },
  unavailable: { escalate: true, note: "lane host is down / unreachable" },
});

function classifyFailure(failure) {
  if (failure && typeof failure === "object" && typeof failure.class === "string") {
    return FAILURE_CLASSES[failure.class] ? failure.class : "error";
  }
  if (typeof failure === "string") {
    return FAILURE_CLASSES[failure] ? failure : "error";
  }
  return "error";
}

// ---------------------------------------------------------------------------
// buildCascade — plan the whole escalation ladder up front from the router.
//
// The ladder is: [routerPick, ...heavier eligible lanes in ascending order].
// Every entry is a lane the ROUTER certified eligible for this exact order +
// field. We attach each lane's table row (model/where/ceiling) for the receipt.
// ---------------------------------------------------------------------------

/**
 * @param {object} order        an orange.order.v1 (or compatible partial)
 * @param {object} [systemState] Flowstate snapshot (passed to pickLane)
 * @param {object} [opts]        pickLane opts ({cap, ts})
 * @returns {{
 *   schema:string, decision_id:string,
 *   primary:string|null, ladder:object[], exhausted_after:string|null,
 *   eligible_count:number, reason:string
 * }}
 */
export function buildCascade(order, systemState = {}, opts = {}) {
  const decision = pickLane(order, systemState, opts);
  const eligible = decision.scorecard.filter((s) => s.eligible);

  if (decision.lane === null || eligible.length === 0) {
    return {
      schema: CASCADE_SCHEMA_ID,
      decision_id: decision.decision_id,
      primary: null,
      ladder: [],
      exhausted_after: null,
      eligible_count: 0,
      reason: `no eligible lane — cascade empty (${decision.rationale})`,
    };
  }

  const primaryIdx = LANE_INDEX[decision.lane];
  // Eligible lanes at-or-above the router's pick, ascending (the pick first,
  // then progressively heavier headroom). Lanes BELOW the pick are excluded:
  // the router already rejected them as too small for the demand/floor, so
  // "falling back" to them would violate the floor.
  const rungs = eligible
    .map((s) => LANE_INDEX[s.lane])
    .filter((i) => i >= primaryIdx)
    .sort((a, b) => a - b)
    .map((i) => {
      const row = LANE_TABLE[i];
      return {
        lane: row.lane,
        model: row.model,
        where: row.where,
        ceiling: row.ceiling,
        est_cost: row.est_cost,
        is_primary: i === primaryIdx,
      };
    });

  return {
    schema: CASCADE_SCHEMA_ID,
    decision_id: decision.decision_id,
    primary: decision.lane,
    ladder: rungs,
    exhausted_after: rungs[rungs.length - 1].lane,
    eligible_count: eligible.length,
    reason:
      rungs.length > 1
        ? `primary=${decision.lane}; ${rungs.length - 1} heavier eligible lane(s) available as fallback`
        : `primary=${decision.lane} is the top eligible lane — no heavier fallback exists (exhaustion = human/warrant)`,
  };
}

// ---------------------------------------------------------------------------
// nextLane — given the pre-planned cascade, the current lane, and a failure,
// return the next hop. Deterministic and total: always returns a verdict.
// ---------------------------------------------------------------------------

/**
 * @param {object} cascade a buildCascade result
 * @param {string} currentLane the lane that just failed
 * @param {string|object} failure a FAILURE_CLASSES key, or { class, detail }
 * @returns {{
 *   next_lane:string|null, escalated:boolean, exhausted:boolean,
 *   from:string, failure_class:string, reason:string
 * }}
 */
export function nextLane(cascade, currentLane, failure) {
  const cls = classifyFailure(failure);
  const meta = FAILURE_CLASSES[cls];
  const rungIdx = cascade.ladder.findIndex((r) => r.lane === currentLane);

  // Current lane not in the ladder (bad caller input) — report honestly.
  if (rungIdx === -1) {
    return {
      next_lane: null,
      escalated: false,
      exhausted: true,
      from: currentLane,
      failure_class: cls,
      reason: `lane '${currentLane}' is not in this cascade ladder [${cascade.ladder.map((r) => r.lane).join(" -> ")}]`,
    };
  }

  // A non-escalating class stops the cascade deliberately.
  if (!meta.escalate) {
    return {
      next_lane: null,
      escalated: false,
      exhausted: false,
      from: currentLane,
      failure_class: cls,
      reason: `failure '${cls}' (${meta.note}) — cascade does not escalate this class`,
    };
  }

  const next = cascade.ladder[rungIdx + 1];
  if (!next) {
    return {
      next_lane: null,
      escalated: false,
      exhausted: true,
      from: currentLane,
      failure_class: cls,
      reason: `'${currentLane}' failed with '${cls}' (${meta.note}) and is the top eligible lane — cascade EXHAUSTED; escalate to human / request warrant upgrade`,
    };
  }

  return {
    next_lane: next.lane,
    escalated: true,
    exhausted: false,
    from: currentLane,
    failure_class: cls,
    reason: `'${currentLane}' failed with '${cls}' (${meta.note}) — escalating to heavier eligible lane '${next.lane}' (${next.model} on ${next.where}, ceiling ${next.ceiling})`,
  };
}

// ---------------------------------------------------------------------------
// simulateFailures — replay a sequence of failures through the cascade and
// return the full hop trace. Useful for tests + for a dry-run receipt of how
// far an order could escalate before it needs a human.
// ---------------------------------------------------------------------------

/**
 * @param {object} order
 * @param {(string|object)[]} failures ordered failure classes, one per hop
 * @param {object} [systemState]
 * @param {object} [opts]
 * @returns {{
 *   schema:string, decision_id:string, primary:string|null,
 *   hops:object[], final_lane:string|null, exhausted:boolean, delivered:boolean
 * }}
 */
export function simulateFailures(order, failures = [], systemState = {}, opts = {}) {
  const cascade = buildCascade(order, systemState, opts);
  const hops = [];
  let current = cascade.primary;
  let exhausted = current === null;
  let delivered = false;

  if (current === null) {
    return {
      schema: CASCADE_SCHEMA_ID,
      decision_id: cascade.decision_id,
      primary: null,
      hops: [],
      final_lane: null,
      exhausted: true,
      delivered: false,
    };
  }

  for (const f of failures) {
    const hop = nextLane(cascade, current, f);
    hops.push({ from: current, ...hop });
    if (hop.exhausted || !hop.escalated) {
      exhausted = hop.exhausted;
      current = hop.next_lane ?? current;
      break;
    }
    current = hop.next_lane;
  }

  // If we consumed all provided failures without exhausting, the last standing
  // lane is treated as the one that ultimately delivered.
  if (hops.length === failures.length && !exhausted) {
    delivered = true;
  }

  return {
    schema: CASCADE_SCHEMA_ID,
    decision_id: cascade.decision_id,
    primary: cascade.primary,
    hops,
    final_lane: current,
    exhausted,
    delivered,
  };
}

export const __cascadeInternals = Object.freeze({
  classifyFailure,
  LANE_INDEX,
});
