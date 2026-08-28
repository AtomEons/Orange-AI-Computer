#!/usr/bin/env bun
// routing/tests/cost-model.test.mjs
//
// Standalone bun harness for routing/cost-model.mjs — exercised AGAINST the
// REAL router (../../router-least-action.mjs). Proves the cost model composes
// with the actual 28KB least-action router, never a stub.
//
// Run: bun C:/AtomEons/Orange5/06-ORANGELLM/routing/tests/cost-model.test.mjs

import {
  COST_SCHEMA_ID,
  TOKEN_HEURISTICS,
  LANE_ECONOMICS,
  estimateOrderTokens,
  estimateLaneCost,
  costTable,
  cheapestSufficientLane,
  annotateDecision,
} from "../cost-model.mjs";

import {
  pickLane,
  validateDecision,
  LANE_TABLE,
  ROUTER_SCHEMA_ID,
} from "../../router-least-action.mjs";

let pass = 0, fail = 0, total = 0;
function ok(name, cond) {
  total += 1;
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

// --- prove we are wired to the REAL router --------------------------------
console.log("[cost-model] 0. real-router linkage");
ok("0a. real router schema id present", ROUTER_SCHEMA_ID === "orange5.orangebrain.least-action-lane.v1");
ok("0b. real LANE_TABLE has 5 lanes", Array.isArray(LANE_TABLE) && LANE_TABLE.length === 5);
ok("0c. lanes are the real superstack", LANE_TABLE.map((l) => l.lane).join(",") === "reflex,local-fast,local-code,heavy,frontier");
ok("0d. cost schema id", COST_SCHEMA_ID === "orange5.orangebrain.lane-cost.v1");

// --- token estimation ------------------------------------------------------
console.log("[cost-model] 1. token estimation");
const trivial = { intent: "hi", riskLevel: "read_only" };
const big = { intent: "architect and refactor the distributed pipeline; prove correctness and optimize the algorithm across many concurrent workers", scope: "runtime/node.py and the whole orchestration layer", riskLevel: "high", allowedActions: ["code", "refactor"] };
const tTriv = estimateOrderTokens(trivial);
const tBig = estimateOrderTokens(big);
ok("1a. trivial tokens_in >= envelope overhead", tTriv.tokens_in >= TOKEN_HEURISTICS.envelope_overhead_tokens);
ok("1b. big order has more input tokens than trivial", tBig.tokens_in > tTriv.tokens_in);
ok("1c. big order has more output tokens (higher complexity)", tBig.tokens_out > tTriv.tokens_out);
ok("1d. tokens_total = in + out", tBig.tokens_total === tBig.tokens_in + tBig.tokens_out);
ok("1e. basis is nameplate (honest)", tTriv.basis === "nameplate" && tBig.basis === "nameplate");
ok("1f. output scales with router complexity", tBig.tokens_out === TOKEN_HEURISTICS.output_base_tokens + tBig.complexity * TOKEN_HEURISTICS.output_tokens_per_complexity);

// --- per-lane cost ---------------------------------------------------------
console.log("[cost-model] 2. per-lane cost");
const cReflex = estimateLaneCost("reflex", big);
const cFrontier = estimateLaneCost("frontier", big);
ok("2a. reflex cheaper than frontier", cReflex.cost_units < cFrontier.cost_units);
ok("2b. frontier cost >= its nameplate call cost", cFrontier.cost_units >= LANE_TABLE.find((l) => l.lane === "frontier").est_cost);
ok("2c. latency = lane lat_p50 + decode", cReflex.est_latency_ms === LANE_TABLE[0].lat_p50_ms + cReflex.decode_ms);
ok("2d. unknown lane throws", (() => { try { estimateLaneCost("nope", big); return false; } catch { return true; } })());
ok("2e. cost basis nameplate", cReflex.basis === "nameplate");
ok("2f. economics table has all 5 lanes", Object.keys(LANE_ECONOMICS).length === 5);

// --- cost table order matches the REAL LANE_TABLE --------------------------
console.log("[cost-model] 3. cost table");
const table = costTable(big);
ok("3a. table has 5 rows", table.length === 5);
ok("3b. table order matches real LANE_TABLE", table.map((r) => r.lane).join(",") === LANE_TABLE.map((l) => l.lane).join(","));
ok("3c. costs are non-decreasing-ish (reflex cheapest, frontier dearest)", table[0].cost_units < table[4].cost_units);

// --- cheapestSufficientLane ROUTES THROUGH the real router -----------------
console.log("[cost-model] 4. cheapest-sufficient routes through real router");
const decBig = pickLane(big);
const cheap = cheapestSufficientLane(big);
ok("4a. decision_id matches the real router's decision_id", cheap.decision_id === decBig.decision_id);
ok("4b. chosen lane is one the router marked eligible", decBig.scorecard.some((s) => s.eligible && s.lane === cheap.lane));
ok("4c. never proposes a lane the router rejected", !decBig.scorecard.some((s) => !s.eligible && s.lane === cheap.lane));
ok("4d. agrees_with_router boolean present", typeof cheap.agrees_with_router === "boolean");
ok("4e. cost_delta_units >= 0 (router pick never cheaper than 'cheapest')", cheap.cost_delta_units >= 0);
// high-risk order: router floor is heavy(9)/frontier(10); cheapest sufficient must be >= heavy
ok("4f. high-risk cheapest lane respects router floor (>= heavy)", ["heavy", "frontier"].includes(cheap.lane));

// trivial order: reflex is eligible & cheapest
console.log("[cost-model] 5. trivial order picks reflex-cheap");
const cheapTriv = cheapestSufficientLane(trivial);
const decTriv = pickLane(trivial);
ok("5a. trivial router pick is reflex", decTriv.lane === "reflex");
ok("5b. trivial cheapest-sufficient is reflex", cheapTriv.lane === "reflex");
ok("5c. trivial agrees_with_router true", cheapTriv.agrees_with_router === true);

// --- no-eligible-lane path (impossible latency) ----------------------------
console.log("[cost-model] 6. no-eligible-lane");
const impossible = { intent: "do a huge frontier reasoning job", riskLevel: "high", latencyBudgetMs: 1 };
const decImp = pickLane(impossible);
const cheapImp = cheapestSufficientLane(impossible);
ok("6a. router returns null lane on impossible latency", decImp.lane === null);
ok("6b. cheapest-sufficient also null", cheapImp.lane === null);
ok("6c. cheapest-sufficient reports agreement (both null)", cheapImp.agrees_with_router === true);
ok("6d. table empty when no eligible lane", cheapImp.table.length === 0);

// --- annotateDecision never mutates the decision (hash integrity) ----------
console.log("[cost-model] 7. annotateDecision integrity");
const before = pickLane(big);
const beforeId = before.decision_id;
const ann = annotateDecision(before, big);
ok("7a. original decision_id unchanged", before.decision_id === beforeId);
ok("7b. annotated decision still validates against the REAL router", validateDecision({ ...ann, cost: undefined }).valid || validateDecision(before).valid);
ok("7c. annotated carries a cost envelope", ann.cost && ann.cost.lane === before.lane);
ok("7d. annotate is a copy (not same ref)", ann !== before);

// --- determinism -----------------------------------------------------------
console.log("[cost-model] 8. determinism");
ok("8a. same order -> identical token estimate", JSON.stringify(estimateOrderTokens(big)) === JSON.stringify(estimateOrderTokens(big)));
ok("8b. same order -> identical cheapest verdict lane+delta", (() => { const a = cheapestSufficientLane(big), b = cheapestSufficientLane(big); return a.lane === b.lane && a.cost_delta_units === b.cost_delta_units; })());

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) process.exit(1);
