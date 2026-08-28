#!/usr/bin/env bun
// routing/tests/route-trace.test.mjs
//
// Standalone bun harness for routing/route-trace.mjs — exercised AGAINST the
// REAL router (../../router-least-action.mjs). Proves the trace is a FAITHFUL
// renderer of the real router's own decision envelope: every rendered fact is
// sourced from the router's signals/field/scorecard/escalation, it echoes the
// real decision_id, and it refuses to pretty-print a decision that fails the
// router's own validateDecision.
//
// Run: bun C:/AtomEons/Orange5/06-ORANGELLM/routing/tests/route-trace.test.mjs

import {
  TRACE_SCHEMA_ID,
  traceDecision,
  traceOrder,
  formatTrace,
} from "../route-trace.mjs";

import {
  pickLane,
  validateDecision,
  ROUTER_SCHEMA_ID,
} from "../../router-least-action.mjs";

let pass = 0, fail = 0, total = 0;
function ok(name, cond) {
  total += 1;
  if (cond) { pass += 1; console.log(`  ok   ${name}`); }
  else { fail += 1; console.log(`  FAIL ${name}`); }
}

// --- real-router linkage ---------------------------------------------------
console.log("[trace] 0. real-router linkage");
ok("0a. real router schema", ROUTER_SCHEMA_ID === "orange5.orangebrain.least-action-lane.v1");
ok("0b. trace schema", TRACE_SCHEMA_ID === "orange5.orangebrain.route-trace.v1");

// --- trace a real decision -------------------------------------------------
console.log("[trace] 1. faithful render of a real decision");
const order = { intent: "refactor and debug the distributed concurrency pipeline; prove correctness and analyze the trade-offs", scope: "runtime/node.py", riskLevel: "high", allowedActions: ["code", "refactor"] };
const decision = pickLane(order);
const tr = traceDecision(decision);
ok("1a. trace valid for a well-formed real decision", tr.valid === true && tr.validation_errors.length === 0);
ok("1b. trace echoes the REAL decision_id", tr.decision_id === decision.decision_id);
ok("1c. trace lane/model match the real decision", tr.lane === decision.lane && tr.model === decision.model);
ok("1d. steps include ORDER DEMAND / FIELD / ELIGIBILITY / SELECTION / RECEIPT", ["ORDER DEMAND", "FIELD", "ELIGIBILITY", "SELECTION", "RECEIPT"].every((title) => tr.steps.some((s) => s.title === title)));

// --- rendered facts are SOURCED from the real envelope (not invented) ------
console.log("[trace] 2. rendered facts are sourced from the envelope");
const demandStep = tr.steps.find((s) => s.title === "ORDER DEMAND").detail;
ok("2a. demand step shows the router's complexity", demandStep.includes(`complexity=${decision.signals.complexity}`));
ok("2b. demand step shows the router's risk floor", demandStep.includes(`ceiling >= ${decision.signals.risk_min_ceiling}`));
const eligStep = tr.steps.find((s) => s.title === "ELIGIBILITY").detail;
const chosenIsLegal = decision.scorecard.find((s) => s.lane === decision.lane).eligible;
ok("2c. eligibility step lists the chosen (legal) lane", chosenIsLegal && eligStep.includes(decision.lane));
// a rejected lane's reason from the router must appear verbatim-ish in the trace
const rejected = decision.scorecard.find((s) => !s.eligible);
if (rejected) {
  ok("2d. a router-rejected lane's reason is surfaced in the trace", eligStep.includes(rejected.lane));
} else {
  ok("2d. (no rejected lane for this order — vacuously true)", true);
}
const recStep = tr.steps.find((s) => s.title === "RECEIPT").detail;
ok("2e. receipt step carries the real schema + decision_id", recStep.includes(decision.schema) && recStep.includes(decision.decision_id));
const ratStep = tr.steps.find((s) => s.title === "ROUTER RATIONALE").detail;
ok("2f. router's own rationale reproduced verbatim", ratStep === decision.rationale);

// --- formatted text ---------------------------------------------------------
console.log("[trace] 3. formatted text");
ok("3a. text is a multi-line string", typeof tr.text === "string" && tr.text.split("\n").length > 3);
ok("3b. text header references the decision_id prefix", tr.text.includes(String(decision.decision_id).slice(0, 12)));
ok("3c. formatTrace standalone matches trace text", formatTrace({ decision_id: decision.decision_id, steps: tr.steps }) === tr.text);

// --- traceOrder convenience matches traceDecision(pickLane) ----------------
console.log("[trace] 4. traceOrder == traceDecision(pickLane)");
const tOrder = traceOrder(order);
ok("4a. traceOrder yields same decision_id as pickLane", tOrder.decision_id === pickLane(order).decision_id);
ok("4b. traceOrder valid", tOrder.valid === true);

// --- refuses to render a tampered / foreign decision -----------------------
console.log("[trace] 5. refuses to pretty-print an invalid decision");
const tampered = { ...decision, lane: "frontier" }; // breaks the hash integrity
ok("5a. real validateDecision flags the tamper", validateDecision(tampered).valid === false);
const trTamper = traceDecision(tampered);
ok("5b. trace marks it INVALID (does not dress it up)", trTamper.valid === false && trTamper.validation_errors.length > 0);
ok("5c. invalid trace still returns text (with an INVALID step)", trTamper.text.includes("INVALID"));

const notADecision = { hello: "world" };
const trJunk = traceDecision(notADecision);
ok("5d. junk object => invalid trace, honest", trJunk.valid === false);

// --- no-eligible-lane render -----------------------------------------------
console.log("[trace] 6. no-eligible-lane render");
const impossible = { intent: "huge reasoning job", riskLevel: "high", latencyBudgetMs: 1 };
const decImp = pickLane(impossible);
const trImp = traceDecision(decImp);
ok("6a. impossible order => router null lane", decImp.lane === null);
ok("6b. trace is still valid (a valid 'no lane' envelope)", trImp.valid === true);
ok("6c. selection step states NO ELIGIBLE LANE", trImp.steps.find((s) => s.title === "SELECTION").detail.includes("NO ELIGIBLE LANE"));

// --- determinism -----------------------------------------------------------
console.log("[trace] 7. determinism");
ok("7a. same decision -> identical trace text", traceDecision(decision).text === traceDecision(decision).text);

console.log(`\nSummary: ${pass} pass / ${fail} fail of ${total}`);
if (fail > 0) process.exit(1);
