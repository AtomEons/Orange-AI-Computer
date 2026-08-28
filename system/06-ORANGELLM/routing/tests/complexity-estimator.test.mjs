#!/usr/bin/env bun
// routing/tests/complexity-estimator.test.mjs
//
// Standalone bun harness for routing/complexity-estimator.mjs — exercised
// AGAINST the REAL router (../../router-least-action.mjs). The key proofs:
//   - our decomposition RECONCILES exactly to the router's own complexity
//     (compileOrderSignals) across a corpus — no competing complexity number.
//   - the advisory band's floor lane NEVER exceeds the router's actual pick.
//
// Run: bun C:/AtomEons/Orange5/06-ORANGELLM/routing/tests/complexity-estimator.test.mjs

import {
  COMPLEXITY_SCHEMA_ID,
  COMPLEXITY_BANDS,
  decomposeComplexity,
  mapComplexityToBand,
  estimate,
} from "../complexity-estimator.mjs";

import {
  pickLane,
  compileOrderSignals,
  LANE_TABLE,
  __routerInternals,
  ROUTER_SCHEMA_ID,
} from "../../router-least-action.mjs";

const { LANE_INDEX, demandOf } = __routerInternals;

let pass = 0, fail = 0, total = 0;
function ok(name, cond) {
  total += 1;
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

// --- real-router linkage ---------------------------------------------------
console.log("[complexity] 0. real-router linkage");
ok("0a. real router schema", ROUTER_SCHEMA_ID === "orange5.orangebrain.least-action-lane.v1");
ok("0b. complexity schema", COMPLEXITY_SCHEMA_ID === "orange5.orangebrain.complexity.v1");
ok("0c. bands frozen", Object.isFrozen(COMPLEXITY_BANDS) && COMPLEXITY_BANDS.length === 5);

// --- corpus of orders (varied complexity + risk) ---------------------------
const corpus = [
  { intent: "hi", riskLevel: "read_only" },
  { intent: "say hello and greet the user in one word", riskLevel: "read_only" },
  { intent: "summarize this short note", riskLevel: "low" },
  { intent: "classify this ticket and reason about the category", riskLevel: "low" },
  { intent: "refactor the module and write unit tests", riskLevel: "medium", allowedActions: ["code", "refactor"] },
  { intent: "debug the concurrency bug in the pipeline and prove the fix", riskLevel: "high", allowedActions: ["code"] },
  { intent: "architect and migrate the distributed system; optimize the algorithm; analyze trade-offs and synthesize a strategy across many concurrent services with security review", riskLevel: "destructive", allowedActions: ["code", "refactor", "deploy", "review"] },
  { intent: "deploy to production and run the migration", riskLevel: "production", allowedActions: ["deploy", "execute"] },
];

// --- THE KEY PROOF: decomposition reconciles to the router's complexity -----
console.log("[complexity] 1. decomposition RECONCILES to real router complexity");
let allReconcile = true;
let allMatch = true;
for (const o of corpus) {
  const dec = decomposeComplexity(o);
  const sig = compileOrderSignals(o);
  if (!dec.reconciles) allReconcile = false;
  if (dec.complexity !== sig.complexity) allMatch = false;
  if (dec.demand !== demandOf(sig)) allMatch = false;
}
ok("1a. every order's re-derived clamp reconciles to router complexity", allReconcile);
ok("1b. reported complexity == router compileOrderSignals complexity (all)", allMatch);

// spot-check contributions sum toward the router value
console.log("[complexity] 2. contribution breakdown");
const big = corpus[6];
const decBig = decomposeComplexity(big);
ok("2a. contributions object has all 4 named terms", ["length_term", "hint_term", "breadth_term", "trivial_penalty"].every((k) => k in decBig.contributions));
ok("2b. big order hit multiple complex hints", decBig.features.complex_hits >= 3);
ok("2c. trivial order carries a trivial penalty", decomposeComplexity(corpus[1]).contributions.trivial_penalty < 0);
ok("2d. raw_sum present and numeric", typeof decBig.raw_sum === "number");

// --- band mapping uses REAL LANE_TABLE ceilings via demandOf ---------------
console.log("[complexity] 3. band mapping via real LANE_TABLE + demandOf");
const b0 = mapComplexityToBand(0, 0);
const b10 = mapComplexityToBand(10, 8);
ok("3a. complexity 0 => trivial band, reflex-capable floor", b0.band === "trivial" && b0.min_lane === "reflex");
ok("3b. complexity 10 => top band, min lane clears demand via real ceilings", b10.demand >= 9 && ["heavy", "frontier"].includes(b10.min_lane));
ok("3c. band demand equals router demandOf blend", b10.demand === demandOf({ complexity: 10, risk: 8 }));
ok("3d. min_lane ceiling actually >= demand (real table)", LANE_TABLE.find((l) => l.lane === b10.min_lane).ceiling >= b10.demand);
ok("3e. band flagged advisory (not authority)", b0.advisory === true && b10.advisory === true);

// --- THE INVARIANT: advisory floor NEVER exceeds the router's actual pick ---
console.log("[complexity] 4. advisory band within the real router's pick (all corpus)");
let allWithin = true;
const rows = [];
for (const o of corpus) {
  const est = estimate(o);
  const decision = pickLane(o);
  if (!est.band_within_router) allWithin = false;
  if (decision.lane !== null) {
    const advIdx = LANE_INDEX[est.advisory_min_lane];
    const chosenIdx = LANE_INDEX[decision.lane];
    if (advIdx > chosenIdx) allWithin = false;
  }
  rows.push(`${est.complexity}:${est.advisory_min_lane}<=${decision.lane}`);
}
ok("4a. advisory floor <= router pick for EVERY corpus order", allWithin);
ok("4b. estimate.decision_id matches the real router (spot)", estimate(big).decision_id === pickLane(big).decision_id);
console.log("       corpus map: " + rows.join("  "));

// --- monotonicity: more complexity => not a smaller lane band --------------
console.log("[complexity] 5. monotonic band");
const easy = mapComplexityToBand(1, 0);
const mid = mapComplexityToBand(5, 0);
const hard = mapComplexityToBand(9, 0);
ok("5a. band min-lane index non-decreasing with complexity", LANE_INDEX[easy.min_lane] <= LANE_INDEX[mid.min_lane] && LANE_INDEX[mid.min_lane] <= LANE_INDEX[hard.min_lane]);

// --- determinism -----------------------------------------------------------
console.log("[complexity] 6. determinism");
ok("6a. same order -> identical decomposition", JSON.stringify(decomposeComplexity(big)) === JSON.stringify(decomposeComplexity(big)));
ok("6b. same order -> identical estimate lane fields", (() => { const a = estimate(big), b = estimate(big); return a.advisory_min_lane === b.advisory_min_lane && a.router_lane === b.router_lane; })());

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) process.exit(1);
