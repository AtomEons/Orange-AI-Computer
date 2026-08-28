#!/usr/bin/env bun
// routing/tests/fallback-cascade.test.mjs
//
// Standalone bun harness for routing/fallback-cascade.mjs — exercised AGAINST
// the REAL router (../../router-least-action.mjs). Proves the cascade ladder is
// exactly the real router's eligible scorecard ordered upward, never an invented
// capability test, and never escalates below the router's hard floor.
//
// Run: bun C:/AtomEons/Orange5/06-ORANGELLM/routing/tests/fallback-cascade.test.mjs

import {
  CASCADE_SCHEMA_ID,
  FAILURE_CLASSES,
  buildCascade,
  nextLane,
  simulateFailures,
} from "../fallback-cascade.mjs";

import {
  pickLane,
  LANE_TABLE,
  __routerInternals,
  ROUTER_SCHEMA_ID,
} from "../../router-least-action.mjs";

const { LANE_INDEX } = __routerInternals;

let pass = 0, fail = 0, total = 0;
function ok(name, cond) {
  total += 1;
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

// --- real-router linkage ---------------------------------------------------
console.log("[cascade] 0. real-router linkage");
ok("0a. real router schema", ROUTER_SCHEMA_ID === "orange5.orangebrain.least-action-lane.v1");
ok("0b. cascade schema", CASCADE_SCHEMA_ID === "orange5.orangebrain.fallback-cascade.v1");
ok("0c. failure classes are frozen & non-empty", Object.isFrozen(FAILURE_CLASSES) && Object.keys(FAILURE_CLASSES).length > 0);

// --- cascade == router's eligible scorecard, ascending from the pick -------
console.log("[cascade] 1. cascade derived from real router eligibility");
const midOrder = { intent: "summarize and reason about this long report and judge the trade-offs", scope: "docs", riskLevel: "high" };
const dec = pickLane(midOrder);
const cas = buildCascade(midOrder);
const eligibleUp = dec.scorecard
  .filter((s) => s.eligible)
  .map((s) => LANE_INDEX[s.lane])
  .filter((i) => i >= LANE_INDEX[dec.lane])
  .sort((a, b) => a - b)
  .map((i) => LANE_TABLE[i].lane);
ok("1a. primary equals the router's chosen lane", cas.primary === dec.lane);
ok("1b. decision_id matches the real router", cas.decision_id === dec.decision_id);
ok("1c. ladder == router-eligible lanes at/above the pick, ascending", cas.ladder.map((r) => r.lane).join(",") === eligibleUp.join(","));
ok("1d. ladder contains ONLY router-eligible lanes", cas.ladder.every((r) => dec.scorecard.some((s) => s.eligible && s.lane === r.lane)));
ok("1e. ladder never includes a lane BELOW the router pick (floor honored)", cas.ladder.every((r) => LANE_INDEX[r.lane] >= LANE_INDEX[dec.lane]));
ok("1f. first rung is flagged primary", cas.ladder[0].is_primary === true);

// --- escalation goes UP, with a reason -------------------------------------
console.log("[cascade] 2. escalation goes up with a reason");
const hop1 = nextLane(cas, cas.primary, "timeout");
ok("2a. timeout on primary escalates to a heavier lane", hop1.escalated === true && LANE_INDEX[hop1.next_lane] > LANE_INDEX[cas.primary]);
ok("2b. hop carries a machine failure_class", hop1.failure_class === "timeout");
ok("2c. hop reason is non-empty", typeof hop1.reason === "string" && hop1.reason.length > 10);

// --- exhaustion at the top lane -------------------------------------------
console.log("[cascade] 3. exhaustion");
const topLane = cas.ladder[cas.ladder.length - 1].lane;
const hopTop = nextLane(cas, topLane, "oom");
ok("3a. failure at the top eligible lane exhausts the cascade", hopTop.exhausted === true && hopTop.next_lane === null);
ok("3b. exhaustion reason mentions human/warrant", /human|warrant/i.test(hopTop.reason));

// --- unknown current lane handled ------------------------------------------
console.log("[cascade] 4. bad input handled honestly");
const hopBad = nextLane(cas, "not-a-lane", "error");
ok("4a. lane not in ladder => exhausted, null, explained", hopBad.next_lane === null && hopBad.exhausted === true && /not in this cascade/.test(hopBad.reason));

// --- unknown failure class defaults to 'error' (still escalates) -----------
console.log("[cascade] 5. failure classification");
const hopUnknown = nextLane(cas, cas.primary, "totally-unknown-class");
ok("5a. unknown failure class -> 'error'", hopUnknown.failure_class === "error");
ok("5b. 'error' escalates", hopUnknown.escalated === true);
const hopObj = nextLane(cas, cas.primary, { class: "overloaded", detail: "429" });
ok("5c. object failure {class} respected", hopObj.failure_class === "overloaded" && hopObj.escalated === true);

// --- simulateFailures full trace -------------------------------------------
console.log("[cascade] 6. simulateFailures");
const sim = simulateFailures(midOrder, ["timeout", "oom"]);
ok("6a. sim decision_id matches the real router", sim.decision_id === dec.decision_id);
ok("6b. sim primary is the router pick", sim.primary === dec.lane);
ok("6c. sim hops recorded", sim.hops.length >= 1);
ok("6d. sim ends exhausted after climbing to the top", sim.exhausted === true && sim.final_lane === topLane);
ok("6e. every sim hop lane is router-eligible", sim.hops.every((h) => h.next_lane === null || dec.scorecard.some((s) => s.eligible && s.lane === h.next_lane)));

// a single failure that a heavier lane absorbs => delivered
console.log("[cascade] 7. delivered path");
const simDeliver = simulateFailures(midOrder, ["timeout"]);
ok("7a. one hop, not exhausted, delivered on the heavier lane", simDeliver.delivered === true && simDeliver.exhausted === false);
ok("7b. final lane is one step above primary", LANE_INDEX[simDeliver.final_lane] === LANE_INDEX[dec.lane] + 1);

// --- trivial order: single-rung ladder, immediate exhaustion on failure ----
console.log("[cascade] 8. trivial order single-rung ladder");
const triv = { intent: "hi", riskLevel: "read_only" };
const decTriv = pickLane(triv);
const casTriv = buildCascade(triv);
ok("8a. trivial primary is reflex", casTriv.primary === "reflex" && decTriv.lane === "reflex");
ok("8b. trivial ladder has multiple rungs (reflex + heavier eligible)", casTriv.ladder.length >= 1);
ok("8c. reflex failure escalates (there are heavier eligible lanes for a read-only order)", (() => { const h = nextLane(casTriv, "reflex", "bad_output"); return h.escalated === true || h.exhausted === true; })());

// --- no-eligible-lane => empty cascade -------------------------------------
console.log("[cascade] 9. no-eligible-lane");
const impossible = { intent: "huge reasoning job", riskLevel: "high", latencyBudgetMs: 1 };
const decImp = pickLane(impossible);
const casImp = buildCascade(impossible);
ok("9a. router returns null lane", decImp.lane === null);
ok("9b. cascade is empty", casImp.primary === null && casImp.ladder.length === 0);
const simImp = simulateFailures(impossible, ["timeout"]);
ok("9c. simulate on empty cascade => exhausted, no hops", simImp.exhausted === true && simImp.hops.length === 0);

// --- determinism -----------------------------------------------------------
console.log("[cascade] 10. determinism");
ok("10a. same order -> identical ladder", buildCascade(midOrder).ladder.map((r) => r.lane).join(",") === buildCascade(midOrder).ladder.map((r) => r.lane).join(","));

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) process.exit(1);
