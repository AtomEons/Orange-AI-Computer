// routing/route-trace.mjs
//
// OrangeBrain routing improvement 5/6 — ROUTE TRACE (Pillar 2).
//
// pickLane (../router-least-action.mjs) returns a dense decision envelope:
// signals, the full field digest, a per-lane scorecard with eligibility
// reasons + action components, and the escalation record. It also carries a
// one-line `rationale`. That envelope has everything needed to EXPLAIN the
// decision — but as raw JSON it is not something an operator reads at a glance.
//
// This module turns the router's OWN decision envelope into a human-readable,
// ordered rationale trace: what the order demanded, which lanes were legal and
// why the rest were rejected, how the least-action pick was made, and what
// escalation/backpressure forces moved (or held) it. Zero new judgement — it
// is a faithful renderer of the router's recorded reasoning.
//
// Doctrine:
//   - Renderer, not decider. Every line is sourced from fields the router
//     already computed. We never re-run the selection or second-guess a lane.
//     We DO re-run pickLane in `traceOrder` purely to obtain the envelope to
//     render (a convenience wrapper); `traceDecision` renders an envelope you
//     already have without touching the router.
//   - Faithful to the receipt. The trace echoes decision_id so a reader can
//     tie the prose back to the exact hashed decision. If the envelope fails
//     validateDecision, we say so at the top rather than pretty-printing a
//     tampered/foreign decision as if it were sound (Mom's Law).
//   - Pure text out. No I/O, no color codes; returns strings + a structured
//     step list so callers can render however they like.
//
// Exports:
//   TRACE_SCHEMA_ID
//   traceDecision(decision) -> { schema, valid, decision_id, steps, text }
//   traceOrder(order, systemState?, opts?) -> traceDecision(pickLane(...))
//   formatTrace(traceObj)   -> plain multi-line string
//   __traceInternals

import {
  pickLane,
  validateDecision,
  LANE_TABLE,
  __routerInternals,
} from "../router-least-action.mjs";

export const TRACE_SCHEMA_ID = "orange5.orangebrain.route-trace.v1";

const { LANE_INDEX } = __routerInternals;

function laneRow(laneId) {
  const idx = LANE_INDEX[laneId];
  return idx === undefined ? null : LANE_TABLE[idx];
}

// ---------------------------------------------------------------------------
// traceDecision — render a pickLane envelope into ordered steps + text.
// ---------------------------------------------------------------------------

/**
 * @param {object} decision a pickLane decision envelope
 * @returns {{
 *   schema:string, valid:boolean, validation_errors:string[],
 *   decision_id:string|null, lane:string|null, model:string|null,
 *   steps:{n:number,title:string,detail:string}[], text:string
 * }}
 */
export function traceDecision(decision) {
  const v = validateDecision(decision);
  const steps = [];
  let n = 0;
  const push = (title, detail) => steps.push({ n: ++n, title, detail });

  if (!v.valid) {
    push("INVALID DECISION", `this envelope did not pass validateDecision: ${v.errors.join("; ")}`);
    const text = formatTrace({ decision_id: decision?.decision_id ?? null, steps });
    return {
      schema: TRACE_SCHEMA_ID,
      valid: false,
      validation_errors: v.errors,
      decision_id: decision?.decision_id ?? null,
      lane: decision?.lane ?? null,
      model: decision?.model ?? null,
      steps,
      text,
    };
  }

  const sig = decision.signals;
  const field = decision.field;
  const esc = decision.escalation;

  // 1) What the order demanded.
  push(
    "ORDER DEMAND",
    `complexity=${sig.complexity}, risk=${sig.risk} (risk floor requires ceiling >= ${sig.risk_min_ceiling}); ` +
      `needs=[${(sig.needs || []).join(", ") || "none"}]; latency budget=${sig.latency_budget_ms}ms`,
  );

  // 2) Field conditions.
  const warmthStr = Object.entries(field.warmth || {})
    .map(([l, w]) => `${l}:${w}`)
    .join(" ");
  push(
    "FIELD",
    `governor backpressure=${round2(field.governor.backpressure)} ` +
      `(in_progress=${field.governor.in_progress}/${field.governor.cap}` +
      `${field.governor.throttled_recently ? ", recent throttle" : ""}); ` +
      `ambient=${round2(field.ambient)}; warmth[${warmthStr}]`,
  );

  // 3) Eligibility ledger — which lanes were legal, why the rest were not.
  const legal = [];
  const rejected = [];
  for (const s of decision.scorecard || []) {
    if (s.eligible) legal.push(`${s.lane}(action=${s.action})`);
    else rejected.push(`${s.lane} [${(s.reasons || []).join("; ")}]`);
  }
  push(
    "ELIGIBILITY",
    `legal: ${legal.join(", ") || "none"}` +
      (rejected.length ? ` || rejected: ${rejected.join("  |  ")}` : ""),
  );

  // 4) The least-action selection + any field forces.
  const chosenRow = decision.lane ? laneRow(decision.lane) : null;
  if (decision.lane === null) {
    push("SELECTION", `NO ELIGIBLE LANE — ${decision.rationale}`);
  } else {
    const forces = [];
    if (esc.floor_lane) forces.push(`floor=${esc.floor_lane}`);
    if (esc.unconstrained_optimum) forces.push(`least-action optimum=${esc.unconstrained_optimum}`);
    if (esc.ambient_escalated) forces.push("ambient pressure escalated +1 step");
    if (esc.backpressure_held) forces.push("governor backpressure held/suppressed escalation");
    push(
      "SELECTION",
      `chose '${decision.lane}' -> model ${decision.model}` +
        (chosenRow ? ` on ${chosenRow.where} (ceiling ${chosenRow.ceiling}, est_cost ${chosenRow.est_cost})` : "") +
        (forces.length ? `; forces: ${forces.join(", ")}` : ""),
    );
  }

  // 5) The router's own one-liner + the receipt id.
  push("ROUTER RATIONALE", decision.rationale);
  push("RECEIPT", `decision_id=${decision.decision_id}; schema=${decision.schema}; at=${decision.created_at}`);

  const text = formatTrace({ decision_id: decision.decision_id, steps });
  return {
    schema: TRACE_SCHEMA_ID,
    valid: true,
    validation_errors: [],
    decision_id: decision.decision_id,
    lane: decision.lane,
    model: decision.model,
    steps,
    text,
  };
}

// ---------------------------------------------------------------------------
// traceOrder — convenience: pick + trace in one call.
// ---------------------------------------------------------------------------

export function traceOrder(order, systemState = {}, opts = {}) {
  const decision = pickLane(order, systemState, opts);
  return traceDecision(decision);
}

// ---------------------------------------------------------------------------
// formatTrace — steps -> a plain, readable, monospace-friendly block.
// ---------------------------------------------------------------------------

export function formatTrace({ decision_id, steps }) {
  const header = `ROUTE TRACE${decision_id ? ` [${String(decision_id).slice(0, 12)}…]` : ""}`;
  const lines = [header, "-".repeat(header.length)];
  for (const s of steps) {
    lines.push(`${s.n}. ${s.title}: ${s.detail}`);
  }
  return lines.join("\n");
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

export const __traceInternals = Object.freeze({
  laneRow,
  round2,
});
