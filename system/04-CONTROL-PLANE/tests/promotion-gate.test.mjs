#!/usr/bin/env node
import { evaluatePromotion } from "../src/promotion-gate.mjs";

let pass = 0, fail = 0;
const assert = (c, m) => c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.log(`  FAIL ${m}`));

// real green
let r = evaluatePromotion({
  receipt_path: "10-RECEIPTS/x.md",
  bakeoff: { result: "win", scores: [4, 5] },
  status: "ORANGE5_CHAT_LANE_GREEN",
  risk_level: "low",
});
assert(r.verdict === "promote", "real green promotes");

// missing receipt
r = evaluatePromotion({ bakeoff: { result: "win" }, status: "looks_ok" });
assert(r.verdict === "hold", "missing receipt holds");
assert(r.reasons.includes("missing receipt_path"), "reason names missing receipt");

// fake-green word in status
r = evaluatePromotion({ receipt_path: "x", bakeoff: { result: "win" }, status: "green_assumed_OK" });
assert(r.verdict === "hold", "fake-green word triggers hold");
assert(r.reasons.some(x => x.includes("fake-green guard")), "fake-green guard names itself");

// bakeoff failed
r = evaluatePromotion({ receipt_path: "x", bakeoff: { result: "fail" }, status: "OK" });
assert(r.verdict === "reject", "failed bakeoff rejects");

// destructive needs operator
r = evaluatePromotion({ receipt_path: "x", bakeoff: { result: "win" }, status: "OK", risk_level: "destructive" });
assert(r.verdict === "hold", "destructive without operator_approved holds");

r = evaluatePromotion({ receipt_path: "x", bakeoff: { result: "win" }, status: "OK", risk_level: "destructive", operator_approved: true });
assert(r.verdict === "promote", "destructive WITH operator_approved promotes");

console.log(`\n[promotion-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
