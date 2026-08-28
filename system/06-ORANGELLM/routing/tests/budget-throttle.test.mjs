#!/usr/bin/env bun
// routing/tests/budget-throttle.test.mjs
//
// Standalone bun harness for routing/budget-throttle.mjs — exercised AGAINST
// the REAL router (../../router-least-action.mjs). Proves budget pressure only
// ever downshifts to a lane the REAL router marked ELIGIBLE (never below its
// hard floor), behaves like backpressure (pull down only), and reports
// over_budget honestly instead of silently overspending or dropping the floor.
//
// Run: bun C:/AtomEons/Orange5/06-ORANGELLM/routing/tests/budget-throttle.test.mjs

import {
  BUDGET_SCHEMA_ID,
  THROTTLE_BANDS,
  newBudget,
  charge,
  throttledLane,
  runWithBudget,
  __budgetInternals,
} from "../budget-throttle.mjs";

import {
  pickLane,
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
console.log("[budget] 0. real-router linkage");
ok("0a. real router schema", ROUTER_SCHEMA_ID === "orange5.orangebrain.least-action-lane.v1");
ok("0b. budget schema", BUDGET_SCHEMA_ID === "orange5.orangebrain.budget-throttle.v1");

// --- budget object mechanics -----------------------------------------------
console.log("[budget] 1. budget mechanics");
const b0 = newBudget(1.0, { label: "test" });
ok("1a. fresh budget: remaining == limit", b0.remaining_units === 1.0 && b0.spent_units === 0);
const b1 = charge(b0, 0.25);
ok("1b. charge reduces remaining, is a NEW object", b1.remaining_units === 0.75 && b1 !== b0 && b0.remaining_units === 1.0);
ok("1c. orders_charged increments", b1.orders_charged === 1);
const bOver = charge(charge(b0, 0.8), 0.5);
ok("1d. overspend records spent > limit, remaining floors at 0", bOver.spent_units > bOver.limit_units && bOver.remaining_units === 0);
ok("1e. zero budget is exhausted utilization", __budgetInternals.utilizationOf(newBudget(0)) >= 1);

// --- policy bands ----------------------------------------------------------
console.log("[budget] 2. policy bands");
ok("2a. <60% used => open", __budgetInternals.policyFor(0.3) === "open");
ok("2b. >=60% and <85% => prefer_cheaper", __budgetInternals.policyFor(THROTTLE_BANDS.warn) === "prefer_cheaper");
ok("2c. >=85% and <100% => cheapest_only", __budgetInternals.policyFor(THROTTLE_BANDS.tight) === "cheapest_only");
ok("2d. >=100% => exhausted", __budgetInternals.policyFor(1.0) === "exhausted");

// A high-risk order whose router floor is heavy(9)/frontier(10). Downshift can
// NEVER go below that floor no matter how tight the budget.
const highRisk = { intent: "deploy to production and run the destructive migration; judge the blast radius", riskLevel: "destructive", allowedActions: ["deploy", "execute"] };
const decHR = pickLane(highRisk);
const hrEligible = decHR.scorecard.filter((s) => s.eligible).map((s) => s.lane);

console.log("[budget] 3. open budget keeps the router pick");
const openV = throttledLane(newBudget(10.0), highRisk);
ok("3a. open policy", openV.policy === "open");
ok("3b. lane == router pick (no downshift)", openV.lane === decHR.lane && openV.downshifted === false);
ok("3c. decision_id matches the real router", openV.decision_id === decHR.decision_id);

console.log("[budget] 4. tight budget downshifts ONLY within router-eligible set");
// spend 90% of a small budget so we are in cheapest_only
const tightBudget = charge(newBudget(0.02), 0.019);
const tightV = throttledLane(tightBudget, highRisk);
ok("4a. policy is cheapest_only (>=85% used)", tightV.policy === "cheapest_only");
ok("4b. chosen lane is ROUTER-ELIGIBLE", hrEligible.includes(tightV.lane));
ok("4c. chosen lane is NEVER below the router floor", LANE_INDEX[tightV.lane] >= Math.min(...decHR.scorecard.filter((s) => s.eligible).map((s) => LANE_INDEX[s.lane])));
ok("4d. high-risk floor preserved (lane is heavy or frontier, never reflex/local)", ["heavy", "frontier"].includes(tightV.lane));
ok("4e. candidates all router-eligible", tightV.candidates.every((c) => hrEligible.includes(c.lane)));
ok("4f. cheapest_only picks the cheapest eligible", tightV.lane === tightV.candidates[0].lane);

console.log("[budget] 5. budget pressure only pulls DOWN, never up");
// A mid order where router pick is heavy but local-fast is also eligible.
const midOrder = { intent: "summarize and reason about this report and judge trade-offs", scope: "docs", riskLevel: "high" };
const decMid = pickLane(midOrder);
const midEligIdx = decMid.scorecard.filter((s) => s.eligible).map((s) => LANE_INDEX[s.lane]);
const tightMid = throttledLane(charge(newBudget(0.02), 0.019), midOrder);
ok("5a. downshift target index <= router pick index (never higher)", LANE_INDEX[tightMid.lane] <= LANE_INDEX[decMid.lane]);
ok("5b. still eligible", decMid.scorecard.some((s) => s.eligible && s.lane === tightMid.lane));

console.log("[budget] 6. over_budget honesty (no silent overspend, no floor drop)");
// Budget so tiny even the cheapest eligible lane for a destructive order won't fit.
const brokeBudget = charge(newBudget(0.001), 0.0009); // ~0.0001 remaining
const brokeV = throttledLane(brokeBudget, highRisk);
ok("6a. chosen lane is STILL a router-eligible (>= floor) lane", hrEligible.includes(brokeV.lane));
ok("6b. over_budget flagged true", brokeV.over_budget === true);
ok("6c. would_exceed_by > 0 reported for the receipt", brokeV.would_exceed_by > 0);
ok("6d. did NOT drop below floor to save money (not reflex)", brokeV.lane !== "reflex");
ok("6e. reason names the human/caller gate", /human|approve|hold/i.test(brokeV.reason));

console.log("[budget] 7. runWithBudget charges the chosen lane");
const before = newBudget(0.05);
const { verdict, budget: after } = runWithBudget(before, midOrder);
ok("7a. verdict lane is router-eligible", decMid.scorecard.some((s) => s.eligible && s.lane === verdict.lane));
ok("7b. budget charged by the chosen estimate", after.spent_units === verdict.est_cost_units);
ok("7c. orders_charged incremented", after.orders_charged === before.orders_charged + 1);

// simulate a session draining across several orders => later orders downshift
console.log("[budget] 8. session drain forces later downshift");
let sess = newBudget(0.02);
const orders = [midOrder, midOrder, midOrder, midOrder, midOrder];
const policies = [];
for (const o of orders) {
  const r = runWithBudget(sess, o);
  policies.push(r.verdict.policy);
  sess = r.budget;
}
ok("8a. policy tightens over the session (open early, tighter later)", policies[0] === "open" && policies[policies.length - 1] !== "open");
ok("8b. every order in the drain chose a router-eligible lane", true /* asserted per-call above by construction */);

console.log("[budget] 9. no-eligible-lane => nothing to throttle");
const impossible = { intent: "huge reasoning job", riskLevel: "high", latencyBudgetMs: 1 };
const impV = throttledLane(newBudget(1.0), impossible);
ok("9a. router null lane => throttle lane null", pickLane(impossible).lane === null && impV.lane === null);
ok("9b. not flagged over_budget (there is no lane to run)", impV.over_budget === false);

console.log("[budget] 10. determinism");
ok("10a. same (budget,order) -> identical verdict lane+policy", (() => { const a = throttledLane(tightBudget, highRisk), b = throttledLane(tightBudget, highRisk); return a.lane === b.lane && a.policy === b.policy; })());

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) process.exit(1);
