#!/usr/bin/env bun
// router-least-action.test.mjs
//
// Standalone Bun harness for OrangeBrain's least-action lane selector.
// No test framework (so the Orange5 full-verifier runs it via `bun <file>`).
// Exits non-zero on any failure. Prints `Summary: N pass / M fail of T`.
//
// Path: 06-ORANGELLM/tests/router-least-action.test.mjs
// Run:  bun 06-ORANGELLM/tests/router-least-action.test.mjs
//
// Coverage (task-mandated + hardening):
//   1. trivial order              -> reflex
//   2. code order                 -> local-code (code lane)
//   3. high-risk order            -> heavy or frontier (never reflex/local-fast)
//   4. destructive/production     -> heavy+ hard floor honored
//   5. governor backpressure      -> throttles escalation (holds at floor)
//   6. warm-swap                  -> prefers a warm lane over a cold same-tier lane
//   7. determinism                -> same order+field => identical decision_id
//   8. tamper detection           -> validateDecision flips on any edit
//   9. envelope shape             -> {lane, model, rationale, estimated_cost}
//  10. flow-pressure helpers      -> warmth / backpressure / ambient pure math
//  11. no-eligible-lane           -> null lane with an honest rationale

import {
  pickLane,
  validateDecision,
  compileOrderSignals,
  LANE_TABLE,
  ROUTER_SCHEMA_ID,
  __routerInternals,
} from "../router-least-action.mjs";

import {
  laneWarmth,
  governorBackpressure,
  openCurrentsPressure,
  summarizePressure,
  LANES,
} from "../flow-pressure.mjs";

// ---------------------------------------------------------------------------
// tiny harness
// ---------------------------------------------------------------------------

let pass = 0;
let fail = 0;
const failures = [];

function check(label, cond, detail = "") {
  if (cond) {
    pass += 1;
    console.log(`  ok   ${label}`);
  } else {
    fail += 1;
    failures.push(`${label}${detail ? " — " + detail : ""}`);
    console.log(`  FAIL ${label}${detail ? " — " + detail : ""}`);
  }
}
function eq(label, actual, expected) {
  check(label, actual === expected, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

let orderSeq = 0;
function order(overrides = {}) {
  orderSeq += 1;
  return {
    schema: "orange.order.v1",
    orderId: `test-order-${orderSeq}`,
    intent: "do a thing",
    scope: "the thing",
    allowedActions: [],
    forbiddenActions: [],
    targetProject: "orange5",
    riskLevel: "low",
    requiresReceipt: true,
    ...overrides,
  };
}

// A calm field (nothing running) — everything at baseline warmth.
const calmField = { currents: {}, agents: {}, deltas: [], tick: 0, last_tick_at: 0 };

// A saturated field: 5 in-progress currents (cap 3 => over by 2) + a recent
// governor_throttled delta. High GOVERNOR backpressure — the suppression case.
function saturatedField() {
  const currents = {};
  for (let i = 0; i < 5; i++) {
    currents[`c${i}`] = {
      id: `c${i}`, title: `busy ${i}`, description: "", pressure: 0.7,
      owner_department: "AE0", status: "in_progress", assigned_agent: `a${i}`,
      acceptance: { receipt_required: true, approval_required: false, validator: null },
      created_at: 1, updated_at: 2, closed_at: null, closed_receipt: null,
    };
  }
  return {
    currents,
    agents: {},
    deltas: [{ id: "d1", ts: 1, kind: "governor_throttled", subject_id: "c0", payload: {} }],
    tick: 10, last_tick_at: 20,
  };
}

// A HOT field: 2 open high-pressure currents (<= cap 3, so NO governor
// backpressure) => high ambient pressure. This is the ESCALATION case: the
// field is screaming for attention but the governor is not saturated.
function hotField() {
  return {
    currents: {
      h0: {
        id: "h0", title: "screaming", description: "", pressure: 0.95,
        owner_department: "AE0", status: "in_progress", assigned_agent: "a0",
        acceptance: { receipt_required: true, approval_required: false, validator: null },
        created_at: 1, updated_at: 2, closed_at: null, closed_receipt: null,
      },
      h1: {
        id: "h1", title: "urgent", description: "", pressure: 0.85,
        owner_department: "AE0", status: "pending", assigned_agent: null,
        acceptance: { receipt_required: true, approval_required: false, validator: null },
        created_at: 1, updated_at: 2, closed_at: null, closed_receipt: null,
      },
    },
    agents: {},
    deltas: [],
    tick: 1, last_tick_at: 1,
  };
}

// A field where the `heavy` lane is warm (an agent is riding it) but nothing
// is saturated.
function heavyWarmField() {
  return {
    currents: {},
    agents: {
      a_heavy: { id: "a_heavy", role: "orangellm-heavy", state: "riding", current_id: "x", last_tick: 1, capability: { lane: "heavy" } },
    },
    deltas: [],
    tick: 1, last_tick_at: 1,
  };
}

// A field where the `frontier` lane is warm (an agent is riding it), nothing
// saturated, no ambient pressure. Used to prove warmth lowers action score.
function frontierWarmField() {
  return {
    currents: {},
    agents: {
      a_frontier: { id: "a_frontier", role: "orangellm-frontier", state: "riding", current_id: "x", last_tick: 1, capability: { lane: "frontier" } },
    },
    deltas: [],
    tick: 1, last_tick_at: 1,
  };
}

// ---------------------------------------------------------------------------
// 1. trivial -> reflex
// ---------------------------------------------------------------------------
console.log("[router] 1. trivial -> reflex");
{
  const d = pickLane(order({ intent: "say hi in one word", scope: "greet the user", riskLevel: "read_only" }), calmField, { ts: 1 });
  eq("1a. trivial routes to reflex", d.lane, "reflex");
  eq("1b. reflex is the Bun deterministic router", d.model, "bun-deterministic-router");
  check("1c. estimated_cost is the reflex nameplate", d.estimated_cost === LANE_TABLE[0].est_cost);
  check("1d. rationale mentions floor lane reflex", /floor lane = reflex/.test(d.rationale));
}

// ---------------------------------------------------------------------------
// 2. code -> local-code
// ---------------------------------------------------------------------------
console.log("[router] 2. code -> local-code");
{
  const d = pickLane(order({
    intent: "refactor this python function and fix the bug in the stack trace",
    scope: "module utils.py",
    allowedActions: ["write_code", "refactor"],
    riskLevel: "low",
  }), calmField, { ts: 1 });
  check("2a. code order needs 'code' capability", compileOrderSignals(order({ intent: "fix the bug in this function", allowedActions: ["write_code"] })).needs.includes("code"));
  eq("2b. code order routes to local-code", d.lane, "local-code");
  eq("2c. local-code model", d.model, "qwen3-coder:30b");
  check("2d. reflex is ineligible (missing code cap)", d.scorecard.find(s => s.lane === "reflex").eligible === false);

  const codexaStatus = pickLane(order({ intent: "Assume Codexa is unreachable and report the honest fallback", riskLevel: "low" }), calmField, { ts: 1 });
  eq("2e. Codexa machine name is not mistaken for code intent", codexaStatus.signals.needs.includes("code"), false);
  eq("2f. Codexa status request stays on smallest sufficient lane", codexaStatus.lane, "reflex");

  const executionExplanation = pickLane(order({
    action: "query.chat",
    intent: "Explain why model output is not execution. Do not execute anything.",
    allowedActions: ["report", "route", "reason"],
    riskLevel: "low",
  }), calmField, { ts: 1 });
  eq("2g. execution discussion does not imply tool authority", executionExplanation.signals.needs.includes("tools"), false);
  eq("2h. execution discussion uses the reasoning lane", executionExplanation.lane, "local-fast");

  const supervision = pickLane(order({
    action: "query.chat",
    intent: "Explain Bun process supervision and crash recovery.",
    riskLevel: "low",
  }), calmField, { ts: 1 });
  eq("2i. supervision is not mistaken for vision", supervision.signals.needs.includes("vision"), false);
  check("2j. supervision does not wake AE Eyes", supervision.lane !== "ae-eyes");

  const visual = pickLane(order({
    action: "query.visual",
    intent: "inspect the supplied image",
    inputModalities: ["text", "image"],
  }), calmField, { ts: 1 });
  eq("2k. image input selects AE Eyes", visual.lane, "ae-eyes");
  eq("2l. operational vision is not labeled as a frontier model", visual.model, "ae-eyes");
  check("2m. frontier is ineligible for AE Eyes work", visual.scorecard.find((s) => s.lane === "frontier").eligible === false);
  eq("2n. AE Eyes decision validates", validateDecision(visual).valid, true);
}

// ---------------------------------------------------------------------------
// 3. high-risk -> heavy or frontier (never a small lane)
// ---------------------------------------------------------------------------
console.log("[router] 3. high-risk -> heavy/frontier");
{
  const d = pickLane(order({
    intent: "analyze the security trade-offs and design the migration",
    scope: "production auth system",
    riskLevel: "high",
  }), calmField, { ts: 1 });
  check("3a. high-risk lane is heavy or frontier", d.lane === "heavy" || d.lane === "frontier");
  check("3b. reflex ineligible under high risk", d.scorecard.find(s => s.lane === "reflex").eligible === false);
  check("3c. local-fast ineligible under high risk", d.scorecard.find(s => s.lane === "local-fast").eligible === false);
  check("3d. floor lane clears risk ceiling>=8", __routerInternals.LANE_INDEX[d.escalation.floor_lane] >= __routerInternals.LANE_INDEX["heavy"]);
}

// ---------------------------------------------------------------------------
// 4. destructive / production -> heavy+ hard floor
// ---------------------------------------------------------------------------
console.log("[router] 4. destructive/production hard floor");
{
  const dDestroy = pickLane(order({ intent: "drop and rebuild the table", scope: "db", riskLevel: "destructive" }), calmField, { ts: 1 });
  check("4a. destructive floor is heavy or frontier", ["heavy", "frontier"].includes(dDestroy.escalation.floor_lane));
  check("4b. destructive chosen lane not below heavy", __routerInternals.LANE_INDEX[dDestroy.lane] >= __routerInternals.LANE_INDEX["heavy"]);

  const dProd = pickLane(order({ intent: "push the release to production", scope: "prod", riskLevel: "production" }), calmField, { ts: 1 });
  check("4c. production chosen lane not below heavy", __routerInternals.LANE_INDEX[dProd.lane] >= __routerInternals.LANE_INDEX["heavy"]);
  eq("4d. risk_min_ceiling for production is 9", __routerInternals.RISK_MIN_CEILING["production"], 9);
}

// ---------------------------------------------------------------------------
// 5. backpressure throttles escalation
//    The two opposing pressure-field forces on ONE order:
//      hot field (high ambient, governor NOT saturated)  -> escalate up a step
//      saturated field (governor over cap + throttle)    -> suppress, hold low
// ---------------------------------------------------------------------------
console.log("[router] 5. pressure preserves least-action / backpressure holds");
{
  // Medium risk (floor = local-fast, ceiling>=5) with an eligible step above
  // it (local-code / heavy). demand reaches the mid band so ambient escalation
  // is permitted.
  const ord = order({
    intent: "analyze the security trade-offs and design the migration plan carefully",
    scope: "production auth subsystem",
    riskLevel: "medium",
  });

  const idx = __routerInternals.LANE_INDEX;
  const hot = pickLane(ord, hotField(), { ts: 1 });
  const sat = pickLane(ord, saturatedField(), { ts: 1 });

  // Hot field: ambient pressure pushes the choice ONE step above the optimum.
  eq("5a. hot field preserves least-action optimum", hot.lane, hot.escalation.unconstrained_optimum);
  eq("5b. hot field does not invent ambient escalation", hot.escalation.ambient_escalated, false);
  check("5c. hot rationale names least-action", /least-action/i.test(hot.rationale));

  // Saturated field: governor backpressure SUPPRESSES the escalation — the
  // choice collapses back to the least-action optimum / floor.
  eq("5d. saturated field suppresses escalation (held)", sat.escalation.backpressure_held, true);
  eq("5e. saturated field did NOT ambient-escalate", sat.escalation.ambient_escalated, false);
  eq("5f. saturated chosen == least-action optimum", sat.lane, sat.escalation.unconstrained_optimum);
  check("5g. saturated lane <= hot lane (never escalates under load)", idx[sat.lane] <= idx[hot.lane]);
  check("5h. saturated rationale explains the hold", /backpressure/i.test(sat.rationale));

  // Safety invariant: neither force can pull below the hard risk floor.
  check("5i. hot lane still clears risk floor", LANE_TABLE[idx[hot.lane]].ceiling >= hot.signals.risk_min_ceiling);
  check("5j. saturated lane still clears risk floor", LANE_TABLE[idx[sat.lane]].ceiling >= sat.signals.risk_min_ceiling);
}

// ---------------------------------------------------------------------------
// 6. warm-lane scheduling evidence (never tier-selection authority)
//    Warmth remains measurable in the scorecard so a same-tier scheduler can
//    use it, but only risk and capability demand can promote model tier.
// ---------------------------------------------------------------------------
console.log("[router] 6. warm-lane preference");
{
  const ord = order({ intent: "judge and reason about this evaluation", scope: "x", riskLevel: "high" }); // eligible: heavy, frontier
  const cold = pickLane(ord, calmField, { ts: 1 });
  const frontierWarm = pickLane(ord, frontierWarmField(), { ts: 1 });

  const wf = summarizePressure(frontierWarmField(), {});
  eq("6a. frontier reads warm in warm field", wf.warmth.frontier.warm, true);

  const frontierCold = cold.scorecard.find((s) => s.lane === "frontier");
  const frontierHot = frontierWarm.scorecard.find((s) => s.lane === "frontier");
  check("6b. warmth lowers the lane's action score", frontierHot.action < frontierCold.action, `hot=${frontierHot.action} cold=${frontierCold.action}`);
  check("6c. warmth lowers cold_term specifically", frontierHot.components.cold_term < frontierCold.components.cold_term);

  // Capability-minimal discipline is absolute: a warm, larger lane cannot
  // steal work from the smallest sufficient lane.
  eq("6d. warm frontier cannot override smallest sufficient lane", frontierWarm.lane, "heavy");

  // reflex's always-warm status is exactly why trivial stays on reflex.
  eq("6e. reflex reads warm even in a calm field", summarizePressure(calmField, {}).warmth.reflex.warm, true);

  // Invariant: warmth does not change the selected model tier at all.
  eq("6f. warmth does not change tier", frontierWarm.lane, cold.lane);
}

// ---------------------------------------------------------------------------
// 7. determinism
// ---------------------------------------------------------------------------
console.log("[router] 7. determinism");
{
  const ord = order({ intent: "design and optimize the caching algorithm", scope: "hot path", riskLevel: "medium" });
  const a = pickLane(ord, calmField, { ts: 1000 });
  const b = pickLane(ord, calmField, { ts: 9999 }); // different ts, same field
  eq("7a. same order+field => same decision_id (ts excluded)", a.decision_id, b.decision_id);
  eq("7b. same lane", a.lane, b.lane);
  check("7c. decision_id is 64-hex", /^[a-f0-9]{64}$/.test(a.decision_id));
  check("7d. differing field changes the id", pickLane(ord, saturatedField(), { ts: 1000 }).decision_id !== a.decision_id);
}

// ---------------------------------------------------------------------------
// 8. tamper detection
// ---------------------------------------------------------------------------
console.log("[router] 8. tamper detection");
{
  const d = pickLane(order({ intent: "reason about this", riskLevel: "medium" }), calmField, { ts: 1 });
  eq("8a. fresh decision validates", validateDecision(d).valid, true);

  const tampLane = { ...d, lane: d.lane === "reflex" ? "frontier" : "reflex" };
  eq("8b. tampered lane fails integrity", validateDecision(tampLane).valid, false);

  const tampCost = { ...d, estimated_cost: 999 };
  // cost is not in the hash, but it IS shape-checked; 999 is a valid number so
  // this stays valid — the hash guards the DECISION, cost is a lookup. Assert
  // the honest behavior: cost edit alone does not corrupt the hash.
  eq("8c. cost is a lookup, not hashed (stays valid)", validateDecision(tampCost).valid, true);

  const tampSig = { ...d, signals: { ...d.signals, risk: (d.signals.risk + 1) % 10 } };
  eq("8d. tampered signals fail integrity", validateDecision(tampSig).valid, false);

  eq("8e. non-object rejected", validateDecision(null).valid, false);
  eq("8f. wrong schema rejected", validateDecision({ ...d, schema: "nope" }).valid, false);
}

// ---------------------------------------------------------------------------
// 9. envelope shape (the task's required return contract)
// ---------------------------------------------------------------------------
console.log("[router] 9. envelope shape");
{
  const d = pickLane(order({ intent: "hello", riskLevel: "read_only" }), calmField, { ts: 1 });
  check("9a. has lane (string)", typeof d.lane === "string");
  check("9b. has model (string)", typeof d.model === "string");
  check("9c. has rationale (non-empty string)", typeof d.rationale === "string" && d.rationale.length > 0);
  check("9d. has estimated_cost (number)", typeof d.estimated_cost === "number");
  eq("9e. schema id stamped", d.schema, ROUTER_SCHEMA_ID);
  check("9f. scorecard covers all 5 lanes", Array.isArray(d.scorecard) && d.scorecard.length === LANE_TABLE.length);
}

// ---------------------------------------------------------------------------
// 10. flow-pressure pure helpers
// ---------------------------------------------------------------------------
console.log("[router] 10. flow-pressure helpers");
{
  // warmth
  eq("10a. reflex always-warm at baseline", laneWarmth(calmField, "reflex").warm, true);
  eq("10b. frontier cold at baseline", laneWarmth(calmField, "frontier").warm, false);
  eq("10c. riding agent warms its lane", laneWarmth(heavyWarmField(), "heavy").warm, true);
  eq("10d. unknown lane is cold", laneWarmth(calmField, "does-not-exist").warmth, 0);

  // backpressure
  const bpCalm = governorBackpressure(calmField, { cap: 3 });
  eq("10e. calm backpressure is 0", bpCalm.backpressure, 0);
  const bpBusy = governorBackpressure(saturatedField(), { cap: 3 });
  check("10f. saturated backpressure >= 0.5", bpBusy.backpressure >= 0.5, `got ${bpBusy.backpressure}`);
  eq("10g. saturated over-count is 2", bpBusy.over, 2);
  eq("10h. throttle delta detected", bpBusy.throttled_recently, true);

  // ambient
  eq("10i. calm ambient is 0", openCurrentsPressure(calmField).ambient, 0);
  const amb = openCurrentsPressure(saturatedField());
  check("10j. busy ambient > 0", amb.ambient > 0, `got ${amb.ambient}`);
  eq("10k. busy open-current count is 5", amb.open, 5);

  // summarize
  const sum = summarizePressure(calmField, {});
  check("10l. summarize has all lanes", LANES.every((l) => l in sum.warmth));
  eq("10m. calm field_present false", sum.field_present, false);
  eq("10n. busy field_present true", summarizePressure(saturatedField(), {}).field_present, true);

  // purity: calling twice does not mutate input
  const snap = JSON.stringify(saturatedField());
  const f = saturatedField();
  summarizePressure(f, {});
  governorBackpressure(f, {});
  openCurrentsPressure(f);
  eq("10o. helpers do not mutate state", JSON.stringify(f), snap);
}

// ---------------------------------------------------------------------------
// 11. no-eligible-lane -> null with honest rationale
// ---------------------------------------------------------------------------
console.log("[router] 11. no-eligible-lane");
{
  // Impossible latency budget: 1ms budget is below every lane's p50, so no
  // lane is fast enough -> null.
  const d = pickLane(order({ intent: "hi", riskLevel: "read_only", latencyBudgetMs: 1 }), calmField, { ts: 1 });
  eq("11a. impossible latency => null lane", d.lane, null);
  eq("11b. null model", d.model, null);
  eq("11c. estimated_cost 0 on no-lane", d.estimated_cost, 0);
  check("11d. rationale is honest about no eligible lane", /no_eligible_lane/.test(d.rationale));
  eq("11e. no-lane envelope still validates", validateDecision(d).valid, true);
}

// ---------------------------------------------------------------------------
// summary
// ---------------------------------------------------------------------------
const total = pass + fail;
console.log("");
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) {
  console.log("Failures:");
  for (const f of failures) console.log(`  - ${f}`);
  process.exit(1);
}
process.exit(0);
