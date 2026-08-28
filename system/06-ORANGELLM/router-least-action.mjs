// router-least-action.mjs
//
// OrangeBrain's internal least-action lane selector (Pillar 2).
//
// Master Plan §5/§7: OrangeBrain compiles operator intent into an
// `orange.order.v1`, then picks the SMALLEST sufficient path through the
// model superstack and runs Flowstate as trained behavior. This module is
// that pick. It is NOT a new parallel "Smart Model Router" (that lane is
// killed) — it is OrangeBrain's own decision logic, made explicit, bounded,
// and testable.
//
// pickLane(order, systemState) -> { lane, model, rationale, estimated_cost, ... }
//
// ---------------------------------------------------------------------------
// Doctrine (the least-action law, over the 5-lane superstack)
// ---------------------------------------------------------------------------
//
//   1. Reflex for trivial. The default floor is `reflex` (qwen3:0.6b, N150,
//      always-warm). A request only leaves reflex when the ORDER earns it:
//      real complexity, real risk, or a declared capability the floor lane
//      cannot serve (e.g. code, tool execution).
//
//   2. Escalate only on complexity / risk. Each heavier lane has a capability
//      ceiling. The order's demand (from intent complexity + scope) and its
//      risk floor (from riskLevel) set the MINIMUM lane. We never route a
//      high-risk / destructive / production order through a lane whose
//      ceiling is below that floor — even if a cheaper lane would "probably
//      be fine." Hard constraints precede optimization. This mirrors the
//      sibling scorer at 12-ATOMSMASHER/least-action/router.mjs (the
//      compression-side tier picker); here the same law runs natively over
//      OrangeBrain's 5-lane vocabulary and is fused with live field state.
//
//   3. Respect governor backpressure. When the Flowstate governor is
//      saturated (too many in-progress currents, recent throttles), we do
//      NOT let a borderline order escalate to a heavier, slower lane. Under
//      backpressure the router holds at the smallest lane that still clears
//      the hard risk/capability floor. Backpressure can only pull DOWN toward
//      cheaper lanes; it can never push a sub-floor lane (that would break
//      the safety constraint).
//
//   4. Prefer warm lanes. Among lanes that clear the floor and are within one
//      step of the demanded lane, a warm lane (already hot in the field, or
//      always-warm reflex) beats a cold lane. Spinning up a cold heavy/
//      frontier lane costs time and RAM; if a warm lane is sufficient, take
//      it. Warmth breaks near-ties; it never overrides the hard floor.
//
//   5. Mom's Law tie-break: when in doubt, spend less. Equal-fitness lanes
//      resolve to the cheaper (earlier) lane.
//
// The router does NOT call any model. It returns a decision envelope. The
// gateway / dispatcher performs the actual call. Same order + same field in
// -> byte-identical decision out (the `decision_id` proves it; created_at is
// excluded from the hash).
//
// Anti-drift guardrails honored:
//   - Backend logic only. No UI. No Atomic Orange. No new endpoint.
//   - No model training. No Soul Genome. No STRONGARM/Gremlin.
//   - Does not revive the killed Smart Model Router as a parallel system —
//     this is OrangeBrain's own internal decision function.
//
// Exports:
//   pickLane(order, systemState, opts?) -> RouteDecision
//   LANE_TABLE            -> frozen 5-lane superstack table
//   compileOrderSignals(order) -> { complexity, risk, latency_budget_ms, needs }
//   validateDecision(d)   -> { valid, errors }
//   ROUTER_SCHEMA_ID
//   __routerInternals

import crypto from "node:crypto";
import {
  LANES,
  summarizePressure,
} from "./flow-pressure.mjs";

export const ROUTER_SCHEMA_ID = "orange5.orangebrain.least-action-lane.v1";

// ---------------------------------------------------------------------------
// The 5-lane superstack table (Master Plan §8). Hand-curated v1.
//
//   lane      — stable id (matches Flowstate capability.lane vocabulary)
//   model     — the concrete model served on that lane today
//   where     — host
//   ceiling   — capability ceiling on a 0-10 scale. An order's demand and its
//               risk floor must both be <= ceiling for the lane to be legal.
//   caps      — declared capability tags the lane can serve
//   est_cost  — nameplate relative cost per call (dimensionless, local lanes
//               are ~free compute but not zero-effort; frontier is BYO $).
//               Used for the estimate and the cheaper-wins tie-break.
//   lat_p50_ms — nameplate median latency (diagnostics + latency floor check)
//
// Costs are RELATIVE and local-first honest: reflex is the cheapest real
// thing on the box; heavy/frontier cost progressively more (RAM-seconds for
// local, real dollars for BYO frontier). These are nameplates, not measured;
// that limitation is stated in the README/honest-gaps.
// ---------------------------------------------------------------------------

export const LANE_TABLE = Object.freeze([
  Object.freeze({
    lane: "reflex",
    model: "bun-deterministic-router",
    where: "n150",
    ceiling: 3,
    caps: Object.freeze(["classify", "route", "format"]),
    est_cost: 0.0001,
    lat_p50_ms: 2,
    always_warm: true,
  }),
  Object.freeze({
    lane: "local-fast",
    model: "orange-navigator:ornith-1.5-9b-q4km",
    where: "codexa",
    ceiling: 6,
    caps: Object.freeze(["chat", "classify", "summarize", "reason", "short", "medium"]),
    est_cost: 0.002,
    lat_p50_ms: 700,
    always_warm: false,
  }),
  Object.freeze({
    lane: "local-code",
    model: "qwen3-coder:30b",
    where: "codexa",
    ceiling: 7,
    caps: Object.freeze(["code", "refactor", "reason", "medium", "tools"]),
    est_cost: 0.003,
    lat_p50_ms: 1100,
    always_warm: false,
  }),
  Object.freeze({
    lane: "heavy",
    model: "qwen3:30b-a3b", // fatty warm default; llama3.3:70b is warrant-only upgrade
    where: "codexa",
    ceiling: 9,
    caps: Object.freeze(["chat", "reason", "summarize", "code", "long", "judge", "tools"]),
    est_cost: 0.006,
    lat_p50_ms: 1800,
    always_warm: false,
  }),
  Object.freeze({
    lane: "frontier",
    model: "byo-frontier", // Opus 4.7 / GPT-5.5 / Gemini / GLM (operator BYO key)
    where: "atomic-orange-byo",
    ceiling: 10,
    caps: Object.freeze(["chat", "reason", "code", "judge", "long", "tools", "frontier"]),
    est_cost: 0.05,
    lat_p50_ms: 3200,
    always_warm: false,
  }),
]);

const LANE_INDEX = Object.freeze(
  LANE_TABLE.reduce((m, l, i) => ((m[l.lane] = i), m), {}),
);

// riskLevel enum (orange.order.v1) -> minimum required capability ceiling.
// This is the "no shipping a destructive order through reflex" rule. The
// enum is ordered least->most consequential.
const RISK_MIN_CEILING = Object.freeze({
  read_only: 0,
  low: 2,
  medium: 5,   // medium risk must clear at least local-fast
  high: 8,     // high risk needs heavy or frontier
  destructive: 9, // destructive stays on heavy+ (ceiling 9) minimum
  production: 9,  // production writes stay on heavy+ minimum
});

// riskLevel -> a numeric risk scalar (0-10) for the demand blend.
const RISK_SCALAR = Object.freeze({
  read_only: 0,
  low: 2,
  medium: 5,
  high: 8,
  destructive: 9,
  production: 9,
});

// Capability tags that, when demanded by the order, force a minimum lane
// regardless of complexity — the floor lane simply cannot do them.
const CAP_MIN_LANE = Object.freeze({
  code: "local-code",
  refactor: "local-code",
  tools: "local-code",
  tool_execution: "local-code",
  judge: "heavy",
  reason: "local-fast",
  long: "heavy",
});

// ---------------------------------------------------------------------------
// canonical JSON + hash (same convention as sibling modules / guardrails)
// ---------------------------------------------------------------------------

function canonicalStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalStringify).join(",") + "]";
  const keys = Object.keys(value).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalStringify(value[k])).join(",") + "}";
}

function sha256(s) {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function clampInt(n, lo, hi) {
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, Math.round(n)));
}

// ---------------------------------------------------------------------------
// compileOrderSignals — turn an orange.order.v1 into routing signals.
//
// This is the "compile operator intent" step made concrete. We do NOT ask a
// model to score the order (that would be circular — the router would need a
// model to pick a model). We derive complexity from cheap, deterministic,
// explainable features of the order text and its declared action surface.
// ---------------------------------------------------------------------------

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
const CODE_HINTS = ["code", "function", "bug", "compile", "refactor", "typescript", "python", "rust", ".mjs", "unit test", "stack trace"];
const VISION_HINTS = ["image", "screenshot", "photo", "diagram", "picture", "vision", "ocr", "chart of"];

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

function countLexicalHints(hay, hints) {
  let n = 0;
  for (const hint of hints) {
    const escaped = hint.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const startsWord = /^[a-z0-9]/i.test(hint);
    const endsWord = /[a-z0-9]$/i.test(hint);
    const pattern = `${startsWord ? "\\b" : ""}${escaped}${endsWord ? "\\b" : ""}`;
    if (new RegExp(pattern, "i").test(hay)) n += 1;
  }
  return n;
}

/**
 * @param {object} order  an orange.order.v1 (or a compatible partial)
 * @returns {{
 *   complexity:number,           // 0-10
 *   risk:number,                 // 0-10 (from riskLevel enum)
 *   risk_min_ceiling:number,     // hard floor ceiling from riskLevel
 *   latency_budget_ms:number,
 *   needs:string[],              // capability tags the order demands
 *   cap_min_lane:string|null,    // lane forced by a demanded capability
 *   features:object              // the raw features, for the audit trail
 * }}
 */
export function compileOrderSignals(order) {
  const o = order && typeof order === "object" ? order : {};
  const hay = textOf(o);

  const words = hay ? hay.split(/\s+/).filter(Boolean).length : 0;
  const complexHits = countHints(hay, COMPLEX_HINTS);
  const trivialHits = countHints(hay, TRIVIAL_HINTS);

  // allowedActions widen the blast radius; more distinct verbs => more demand.
  const allowed = Array.isArray(o.allowedActions) ? o.allowedActions : [];
  const declaredAction = typeof o.action === "string" ? o.action.toLowerCase() : "";
  const actionBreadth = allowed.length;

  // Base complexity: start low, add for length, complex hints, action breadth;
  // subtract for explicit triviality. Bounded 0-10.
  let complexity = 0;
  complexity += Math.min(3, words / 20);          // length pressure, capped
  complexity += Math.min(4, complexHits * 1.5);   // domain-complexity hints
  complexity += Math.min(2, Math.max(0, actionBreadth - 1) * 0.6); // multi-action
  complexity -= Math.min(3, trivialHits * 2);     // trivial phrasing pulls down
  complexity = clampInt(complexity, 0, 10);

  // Risk from the enum (canonical). Unknown/missing -> treat as low, since an
  // order that forgot to declare risk should not be auto-escalated.
  const riskLevel = typeof o.riskLevel === "string" ? o.riskLevel : "low";
  const risk = RISK_SCALAR[riskLevel] ?? 2;
  const risk_min_ceiling = RISK_MIN_CEILING[riskLevel] ?? 2;

  // Declared / inferred capability needs.
  const needs = new Set();
  // explicit hints in text
  if (countLexicalHints(hay, CODE_HINTS) > 0) needs.add("code");
  // Tool capability is an execution authority, not a topic. A user asking
  // how execution, shells, HTTP, or deployment work is ordinary chat unless
  // the structured order explicitly grants a corresponding action. Inferring
  // authority from prose caused harmless explanations to wake the 30B coder.
  if (/(^|[._-])(execute|run|tool|shell|deploy|mutate|write)([._-]|$)/.test(declaredAction)) {
    needs.add("tools");
  }
  const declaredModalities = Array.isArray(o.inputModalities) ? o.inputModalities.map((item) => String(item).toLowerCase()) : null;
  // Vision is a capability request, not a substring. `supervision`,
  // `provision`, and similar operational words must never wake AE Eyes.
  const actualVisualInput = declaredModalities
    ? declaredModalities.includes('image')
    : countLexicalHints(hay, VISION_HINTS) > 0;
  if (actualVisualInput) needs.add("vision");
  // explicit allowedActions can name capabilities directly
  for (const a of allowed) {
    const t = String(a).toLowerCase();
    if (t.includes("code") || t.includes("refactor")) needs.add("code");
    if (t.includes("exec") || t.includes("tool") || t.includes("shell") || t.includes("deploy")) needs.add("tools");
    if (t.includes("vision") || t.includes("image")) needs.add("vision");
    if (t.includes("judge") || t.includes("review")) needs.add("judge");
    if (t.includes("reason")) needs.add("reason");
  }

  // The strictest lane forced by any single demanded capability.
  let cap_min_lane = null;
  let capMinIdx = -1;
  for (const need of needs) {
    const forced = CAP_MIN_LANE[need];
    if (forced && LANE_INDEX[forced] > capMinIdx) {
      capMinIdx = LANE_INDEX[forced];
      cap_min_lane = forced;
    }
  }

  // Latency budget: honor an explicit hint; else default generous (routing
  // should not starve on latency unless the order says so). read_only/low
  // risk trivial chat implies the operator wants it snappy.
  let latency_budget_ms = 60_000;
  if (Number.isFinite(o.latencyBudgetMs)) {
    latency_budget_ms = Math.max(1, o.latencyBudgetMs);
  } else if (complexity <= 1 && risk <= 2) {
    latency_budget_ms = 2_000; // trivial: keep it reflex-fast
  }

  return {
    complexity,
    risk,
    risk_min_ceiling,
    latency_budget_ms,
    needs: [...needs].sort(),
    cap_min_lane,
    features: {
      words,
      complex_hits: complexHits,
      trivial_hits: trivialHits,
      action_breadth: actionBreadth,
      risk_level: riskLevel,
    },
  };
}

// ---------------------------------------------------------------------------
// eligibility + least-action selection over the 5 lanes
// ---------------------------------------------------------------------------

// Demand = blend of complexity and risk. Risk contributes so that a low-
// complexity but high-risk order still demands a capable lane's judgment.
function demandOf(sig) {
  return Math.max(sig.complexity, Math.ceil(sig.risk * 0.7));
}

/**
 * Is a lane hard-eligible for these signals? Returns reasons when not.
 * Hard constraints (any failure => ineligible, never selectable):
 *   - lane.ceiling < risk_min_ceiling   (risk floor)
 *   - lane.ceiling < demand             (capability floor)
 *   - lane cannot serve a demanded capability that has no lane override but
 *     is simply absent from lane.caps (e.g. 'vision' on a local lane)
 *   - lane too slow for the latency budget (lat_p50 > budget)
 */
function laneEligible(lane, sig) {
  const reasons = [];
  const demand = demandOf(sig);
  if (lane.ceiling < sig.risk_min_ceiling) {
    reasons.push(`ceiling_below_risk_floor: ${lane.ceiling} < ${sig.risk_min_ceiling}`);
  }
  if (lane.ceiling < demand) {
    reasons.push(`ceiling_below_demand: ${lane.ceiling} < ${demand}`);
  }
  for (const need of sig.needs) {
    if (!lane.caps.includes(need)) {
      reasons.push(`missing_capability: ${need}`);
    }
  }
  if (lane.lat_p50_ms > sig.latency_budget_ms) {
    reasons.push(`too_slow: lat_p50=${lane.lat_p50_ms} > budget=${sig.latency_budget_ms}`);
  }
  return { eligible: reasons.length === 0, reasons };
}

// Least-action score for an eligible lane. Lower = preferred.
//   S = w_cost * cost_norm            (spend less)
//     + w_over * overshoot_norm       (don't overshoot capability)
//     + w_cold * (1 - warmth)         (prefer warm lanes)
//     + w_lat  * lat_norm             (prefer faster within budget)
// All terms are bounded [0, ~1]. Weights are part of the contract.
const WEIGHTS = Object.freeze({
  cost: 1.2,  // Mom's Law: when in doubt, spend less
  over: 0.8,  // avoid using a giant lane for a small job
  cold: 1.0,  // warm-lane preference
  lat: 0.3,   // mild latency preference within budget
});

const MAX_COST = LANE_TABLE.reduce((m, l) => Math.max(m, l.est_cost), 0);

function laneAction(lane, sig, warmthByLane) {
  const demand = demandOf(sig);
  const cost_norm = MAX_COST > 0 ? lane.est_cost / MAX_COST : 0;
  // overshoot: how far the lane's ceiling exceeds what we need, normalized.
  const overshoot = Math.max(0, lane.ceiling - Math.max(demand, sig.risk_min_ceiling));
  const over_norm = overshoot / 10;
  const warmth = warmthByLane[lane.lane]?.warmth ?? 0;
  const cold_term = 1 - warmth;
  const lat_norm = Math.min(1, lane.lat_p50_ms / Math.max(1, sig.latency_budget_ms));

  const S =
    WEIGHTS.cost * cost_norm +
    WEIGHTS.over * over_norm +
    WEIGHTS.cold * cold_term +
    WEIGHTS.lat * lat_norm;

  return {
    score: S,
    components: {
      cost_norm: round4(cost_norm),
      over_norm: round4(over_norm),
      cold_term: round4(cold_term),
      lat_norm: round4(lat_norm),
      warmth: round4(warmth),
      overshoot,
    },
  };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// pickLane — the public entry point
// ---------------------------------------------------------------------------

/**
 * Pick the smallest sufficient model lane for an order, given the live
 * pressure field.
 *
 * @param {object} order        an orange.order.v1 (or compatible partial)
 * @param {object} [systemState] a Flowstate snapshot { currents, agents, deltas, ... }
 * @param {object} [opts]
 * @param {number} [opts.cap=3]  concurrency cap to match the runtime governor
 * @param {number} [opts.ts]     unix ms override (test determinism)
 * @returns {{
 *   schema:string, decision_id:string,
 *   lane:string|null, model:string|null,
 *   rationale:string, estimated_cost:number,
 *   signals:object, field:object, scorecard:object[],
 *   escalation:object, created_at:string
 * }}
 */
export function pickLane(order, systemState = {}, opts = {}) {
  const sig = compileOrderSignals(order);
  const field = summarizePressure(systemState, { cap: opts.cap ?? 3 });
  const warmthByLane = field.warmth;
  const demand = demandOf(sig);

  // Vision is an OrangeFive operational capability, not a language-model
  // escalation. Keep it outside the five model lanes so unavailable AE Eyes
  // can block honestly instead of being disguised as BYO frontier work.
  if (sig.needs.includes("vision")) {
    const scorecard = LANE_TABLE.map((lane) => ({
      lane: lane.lane,
      model: lane.model,
      eligible: false,
      reasons: ["operational_vision_requires_ae_eyes"],
      action: null,
      components: null,
    }));
    return finalize({
      sig,
      field,
      scorecard,
      lane: "ae-eyes",
      model: "ae-eyes",
      estimated_cost: 0.001,
      rationale: "operational capability pick = ae-eyes; frontier substitution is forbidden for image input",
      escalation: {
        floor_lane: "ae-eyes",
        unconstrained_optimum: "ae-eyes",
        chosen_lane: "ae-eyes",
        ambient_escalated: false,
        backpressure_held: false,
      },
      ts: opts.ts,
    });
  }

  // 1) The demanded floor lane: the cheapest lane whose ceiling clears BOTH
  //    the risk floor and the capability demand, AND that serves every needed
  //    capability, AND is fast enough. This is "escalate only as far as the
  //    order earns."
  const scorecard = LANE_TABLE.map((lane) => {
    const elig = laneEligible(lane, sig);
    if (!elig.eligible) {
      return {
        lane: lane.lane, model: lane.model, eligible: false,
        reasons: elig.reasons, action: null, components: null,
      };
    }
    const a = laneAction(lane, sig, warmthByLane);
    return {
      lane: lane.lane, model: lane.model, eligible: true,
      reasons: [], action: round4(a.score), components: a.components,
    };
  });

  const eligible = scorecard.filter((s) => s.eligible);

  // No eligible lane at all (e.g. a capability no lane serves) -> null.
  if (eligible.length === 0) {
    return finalize({
      sig, field, scorecard,
      lane: null, model: null, estimated_cost: 0,
      rationale: "no_eligible_lane: no superstack lane clears the order's hard floor / capability demand",
      escalation: { floor_lane: null, chosen_lane: null, backpressure_held: false, warm_swap: false },
      ts: opts.ts,
    });
  }

  // 2) The hard floor: the LOWEST-index eligible lane. Anything below it is
  //    illegal (fails risk/capability). We never select below this, ever.
  const floorIdx = Math.min(...eligible.map((s) => LANE_INDEX[s.lane]));
  const floorLane = LANE_TABLE[floorIdx].lane;

  // 3) Capability-minimal optimum: risk and required capabilities establish
  //    the floor, then the smallest sufficient lane wins. Warmth, queue depth,
  //    and cold-start estimates remain observable scheduling evidence, but may
  //    never promote a request into a larger model tier. This prevents a warm
  //    specialist from stealing ordinary work from a sufficient reflex lane.
  const optimum = [...eligible].sort(
    (a, b) => LANE_INDEX[a.lane] - LANE_INDEX[b.lane],
  )[0];
  const optimumIdx = LANE_INDEX[optimum.lane];
  let chosen = optimum;

  // The two opposing pressure-field forces (Master Plan §7):
  // Runtime pressure is scheduling evidence, not capability demand. It may
  // hold work at the least-action optimum, but it never promotes model tier.
  const bp = field.governor;
  const underPressure = bp.backpressure >= 0.5 || bp.throttled_recently;

  // Ambient pressure remains visible in the decision frame for scheduling.
  // Only order risk and capabilities can earn a stronger model.
  let ambientEscalated = false;

  // 5) Governor backpressure suppresses escalation. Under load, collapse the
  //    choice back DOWN to the least-action optimum (never below the floor —
  //    the floor is the hard safety line). This is the observable
  //    "backpressure throttles escalation" behavior.
  let backpressureHeld = false;
  if (underPressure && LANE_INDEX[chosen.lane] > optimumIdx) {
    chosen = optimum;
    backpressureHeld = true;
  }
  // Even if nothing escalated, record that load is actively pinning us at the
  // optimum/floor so the rationale can explain the suppression honestly.
  if (underPressure && LANE_INDEX[chosen.lane] === floorIdx) {
    backpressureHeld = true;
  }

  // NOTE on warm-lane preference: warmth is NOT a separate escalation step.
  // It is already fully expressed inside the action function via `cold_term`
  // (a warm lane carries a lower cold_term, hence a lower action, hence is
  // preferred among eligible lanes). We deliberately do NOT add a second
  // warmth mechanism on top: a standalone "swap to the warm lane" step would
  // double-count warmth and — worse — could override the cost discipline by
  // jumping to a warm-but-far-more-expensive lane whose action score is
  // clearly worse. Mom's Law (when in doubt, spend less) forbids that. So the
  // single, honest warm-preference lives in `laneAction`, and it can never beat
  // a decisively cheaper eligible lane. `field.warmth[*]` is surfaced in the
  // decision frame for audit.

  const chosenTableRow = LANE_TABLE[LANE_INDEX[chosen.lane]];
  const rationale = buildRationale({
    sig, demand, floorLane, chosen: chosen.lane,
    backpressureHeld, ambientEscalated, field, chosenTableRow,
  });

  return finalize({
    sig, field, scorecard,
    lane: chosen.lane,
    model: chosenTableRow.model,
    estimated_cost: chosenTableRow.est_cost,
    rationale,
    escalation: {
      floor_lane: floorLane,
      unconstrained_optimum: optimum.lane,
      chosen_lane: chosen.lane,
      ambient_escalated: ambientEscalated,
      backpressure_held: backpressureHeld,
    },
    ts: opts.ts,
  });
}

function buildRationale({ sig, demand, floorLane, chosen, backpressureHeld, ambientEscalated, field, chosenTableRow }) {
  const bits = [];
  bits.push(
    `demand=${demand} (complexity=${sig.complexity}, risk=${sig.risk}/${sig.features.risk_level}); ` +
    `risk floor requires ceiling>=${sig.risk_min_ceiling}`,
  );
  if (sig.needs.length) bits.push(`needs=[${sig.needs.join(",")}]`);
  bits.push(`floor lane = ${floorLane}`);
  if (backpressureHeld) {
    bits.push(
      `governor backpressure ${field.governor.backpressure.toFixed(2)} ` +
      `(in_progress=${field.governor.in_progress}/${field.governor.cap}` +
      `${field.governor.throttled_recently ? ", recent throttle" : ""}) — held at floor, escalation suppressed`,
    );
  } else if (ambientEscalated) {
    bits.push(
      `ambient field pressure ${field.ambient.ambient.toFixed(2)} high — escalated one step to ${chosen} ` +
      `(model ${chosenTableRow.model} on ${chosenTableRow.where}) to clear the hot field faster`,
    );
  } else {
    const warmNote = field.warmth[chosen]?.warm ? " [warm]" : " [cold]";
    bits.push(`least-action pick = ${chosen}${warmNote} (model ${chosenTableRow.model} on ${chosenTableRow.where})`);
  }
  return bits.join("; ");
}

function finalize({ sig, field, scorecard, lane, model, estimated_cost, rationale, escalation, ts }) {
  // decision_id hashes the deterministic slots only (NOT created_at, NOT the
  // volatile warmth 'source' strings — we hash the numbers that drove the
  // decision so identical order+field => identical id).
  const structured = {
    signals: {
      complexity: sig.complexity,
      risk: sig.risk,
      risk_min_ceiling: sig.risk_min_ceiling,
      latency_budget_ms: sig.latency_budget_ms,
      needs: sig.needs,
    },
    field: {
      governor: {
        backpressure: field.governor.backpressure,
        in_progress: field.governor.in_progress,
        cap: field.governor.cap,
        throttled_recently: field.governor.throttled_recently,
      },
      ambient: field.ambient.ambient,
      warmth: Object.fromEntries(LANES.map((l) => [l, field.warmth[l].warmth])),
    },
    lane,
    model,
    escalation,
  };
  const decision_id = sha256(canonicalStringify(structured));
  return {
    schema: ROUTER_SCHEMA_ID,
    decision_id,
    lane,
    model,
    rationale,
    estimated_cost,
    signals: structured.signals,
    field: structured.field,
    scorecard,
    escalation,
    created_at: new Date(typeof ts === "number" ? ts : Date.now()).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// validateDecision — prove a decision envelope is well-formed + untampered
// ---------------------------------------------------------------------------

export function validateDecision(d) {
  const errors = [];
  if (d == null || typeof d !== "object" || Array.isArray(d)) {
    return { valid: false, errors: ["decision must be a non-null object"] };
  }
  if (d.schema !== ROUTER_SCHEMA_ID) errors.push(`schema must be '${ROUTER_SCHEMA_ID}'`);
  for (const f of ["decision_id", "lane", "model", "rationale", "estimated_cost", "signals", "field", "escalation", "created_at"]) {
    if (!(f in d)) errors.push(`missing required field: ${f}`);
  }
  if (errors.length) return { valid: false, errors };
  if (!/^[a-f0-9]{64}$/.test(d.decision_id || "")) errors.push("decision_id must be 64-char lowercase hex");
  if (d.lane !== null && d.lane !== "ae-eyes" && !LANE_INDEX.hasOwnProperty(d.lane)) errors.push(`unknown lane: ${d.lane}`);
  if (typeof d.estimated_cost !== "number" || d.estimated_cost < 0) errors.push("estimated_cost must be a number >= 0");
  if (typeof d.created_at !== "string" || Number.isNaN(Date.parse(d.created_at))) errors.push("created_at must be ISO-8601");
  if (errors.length) return { valid: false, errors };

  // integrity: recompute the hash over the structured slots.
  const structured = {
    signals: {
      complexity: d.signals.complexity,
      risk: d.signals.risk,
      risk_min_ceiling: d.signals.risk_min_ceiling,
      latency_budget_ms: d.signals.latency_budget_ms,
      needs: d.signals.needs,
    },
    field: d.field,
    lane: d.lane,
    model: d.model,
    escalation: d.escalation,
  };
  const expected = sha256(canonicalStringify(structured));
  if (expected !== d.decision_id) {
    errors.push(`decision_id integrity: expected ${expected}, got ${d.decision_id}`);
  }
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// internals for tests
// ---------------------------------------------------------------------------

export const __routerInternals = Object.freeze({
  canonicalStringify,
  sha256,
  demandOf,
  laneEligible,
  laneAction,
  RISK_MIN_CEILING,
  RISK_SCALAR,
  CAP_MIN_LANE,
  WEIGHTS,
  LANE_INDEX,
  MAX_COST,
});
