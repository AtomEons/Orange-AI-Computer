#!/usr/bin/env bun
// routing/tests/warmth.test.mjs
//
// Standalone bun harness for routing/warmth.mjs — exercised AGAINST the REAL
// router (../../router-least-action.mjs). The load-bearing proof: warmth the
// tracker projects must ACTUALLY move the real router's field.warmth (via the
// synthetic riding-agent channel that flow-pressure.laneWarmth reads), not a
// number the router ignores.
//
// Run: bun C:/AtomEons/Orange5/06-ORANGELLM/routing/tests/warmth.test.mjs

import {
  WARMTH_SCHEMA_ID,
  WARMTH_PARAMS,
  newWarmthTracker,
  observeDispatch,
  decayTracker,
  warmthOf,
  projectSystemState,
  warmestEligibleLane,
  __warmthInternals,
} from "../warmth.mjs";

import {
  pickLane,
  LANE_TABLE,
  ROUTER_SCHEMA_ID,
} from "../../router-least-action.mjs";

let pass = 0, fail = 0, total = 0;
function ok(name, cond) {
  total += 1;
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}
function approx(a, b, eps = 1e-3) { return Math.abs(a - b) <= eps; }

// --- real-router linkage ---------------------------------------------------
console.log("[warmth] 0. real-router linkage");
ok("0a. real router schema", ROUTER_SCHEMA_ID === "orange5.orangebrain.least-action-lane.v1");
ok("0b. lane ids sourced from real LANE_TABLE", __warmthInternals.LANE_IDS.join(",") === LANE_TABLE.map((l) => l.lane).join(","));
ok("0c. warmth schema", WARMTH_SCHEMA_ID === "orange5.orangebrain.lane-warmth.v1");
ok("0d. reflex marked always_warm from real table", __warmthInternals.ALWAYS_WARM.reflex === true);

// --- fresh tracker ---------------------------------------------------------
console.log("[warmth] 1. fresh tracker");
const t0 = newWarmthTracker({ now: 1000 });
ok("1a. reflex starts at always-warm floor", warmthOf(t0, "reflex", 1000) === WARMTH_PARAMS.always_warm_floor);
ok("1b. heavy starts cold (0)", warmthOf(t0, "heavy", 1000) === 0);
ok("1c. frontier starts cold (0)", warmthOf(t0, "frontier", 1000) === 0);

// --- dispatch heats a lane -------------------------------------------------
console.log("[warmth] 2. dispatch heats");
let t1 = observeDispatch(t0, "heavy", 1000);
ok("2a. heavy warms by heat_per_dispatch after 1 dispatch", approx(warmthOf(t1, "heavy", 1000), WARMTH_PARAMS.heat_per_dispatch));
t1 = observeDispatch(t1, "heavy", 1000);
ok("2b. second dispatch adds more heat (saturating <=1)", warmthOf(t1, "heavy", 1000) > WARMTH_PARAMS.heat_per_dispatch && warmthOf(t1, "heavy", 1000) <= 1);
ok("2c. observeDispatch returns a NEW tracker (no mutation)", t1 !== t0 && warmthOf(t0, "heavy", 1000) === 0);
ok("2d. unknown lane dispatch throws", (() => { try { observeDispatch(t0, "nope", 1000); return false; } catch { return true; } })());

// --- decay math ------------------------------------------------------------
console.log("[warmth] 3. decay");
const tHot = observeDispatch(newWarmthTracker({ now: 0 }), "heavy", 0); // warmth 0.6 @ t=0
ok("3a. one half-life halves warmth", approx(warmthOf(tHot, "heavy", WARMTH_PARAMS.half_life_ms), 0.3, 5e-3));
ok("3b. two half-lives quarter warmth", approx(warmthOf(tHot, "heavy", 2 * WARMTH_PARAMS.half_life_ms), 0.15, 5e-3));
ok("3c. reflex never decays below floor", warmthOf(tHot, "reflex", 10 * WARMTH_PARAMS.half_life_ms) === WARMTH_PARAMS.always_warm_floor);
ok("3d. decayTracker is a new object", decayTracker(tHot, WARMTH_PARAMS.half_life_ms) !== tHot);

// --- THE LOAD-BEARING TEST: warmth moves the REAL router's field -----------
console.log("[warmth] 4. warmth ACTUALLY moves the real router field.warmth");
const order = { intent: "summarize and reason about this long design document with careful judgment", scope: "docs", riskLevel: "high" };
const cold = pickLane(order, {});
let tWarm = newWarmthTracker({ now: 5000 });
tWarm = observeDispatch(tWarm, "heavy", 5000);
const projected = projectSystemState(tWarm, 5000, {});
const warm = pickLane(order, projected);
ok("4a. cold heavy warmth is the baseline (0.25)", cold.field.warmth.heavy === 0.25);
ok("4b. projected state injects a synthetic riding agent on heavy", Object.keys(projected.agents).includes("__warmth_ledger_heavy"));
ok("4c. warm heavy warmth is HIGHER via the real laneWarmth channel", warm.field.warmth.heavy > cold.field.warmth.heavy);
ok("4d. warm heavy warmth reflects +0.5 riding bonus (0.75)", warm.field.warmth.heavy === 0.75);
ok("4e. projecting does NOT inject for always-warm reflex", !Object.keys(projected.agents).includes("__warmth_ledger_reflex"));
ok("4f. cold, un-warmed lane (frontier) stays at baseline (0.0)", warm.field.warmth.frontier === 0.0);
ok("4g. warmth_ledger surfaced for receipts", projected.warmth_ledger && approx(projected.warmth_ledger.heavy, 0.6));

// projected agents preserve caller-supplied agents
console.log("[warmth] 5. preserves caller agents");
const proj2 = projectSystemState(tWarm, 5000, { agents: { real1: { state: "riding", capability: { lane: "local-fast" } } } });
ok("5a. real caller agent preserved", proj2.agents.real1 && proj2.agents.real1.capability.lane === "local-fast");
ok("5b. synthetic agent added alongside", Object.keys(proj2.agents).includes("__warmth_ledger_heavy"));

// --- warmestEligibleLane routes through real router ------------------------
console.log("[warmth] 6. warmestEligibleLane routes through the real router");
const v = warmestEligibleLane(order, tWarm, {}, { now: 5000 });
const dv = pickLane(order, projectSystemState(tWarm, 5000, {}));
ok("6a. decision_id matches a real router decision on the projected state", v.decision_id === dv.decision_id);
ok("6b. warmest lane is a router-eligible lane", dv.scorecard.some((s) => s.eligible && s.lane === v.warmest_lane));
ok("6c. never returns a lane the router rejected", !dv.scorecard.some((s) => !s.eligible && s.lane === v.warmest_lane));
ok("6d. router_chose_warmest boolean present", typeof v.router_chose_warmest === "boolean");
ok("6e. ladder sorted warmest-first", v.ladder.length <= 1 || v.ladder[0].warmth >= v.ladder[v.ladder.length - 1].warmth);

// --- determinism -----------------------------------------------------------
console.log("[warmth] 7. determinism");
ok("7a. same dispatch sequence -> identical warmth", warmthOf(observeDispatch(newWarmthTracker({ now: 0 }), "local-code", 0), "local-code", 0) === warmthOf(observeDispatch(newWarmthTracker({ now: 0 }), "local-code", 0), "local-code", 0));
ok("7b. same projection -> identical verdict lane", warmestEligibleLane(order, tWarm, {}, { now: 5000 }).warmest_lane === warmestEligibleLane(order, tWarm, {}, { now: 5000 }).warmest_lane);

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) process.exit(1);
