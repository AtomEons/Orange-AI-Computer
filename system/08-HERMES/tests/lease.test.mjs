#!/usr/bin/env node
import { grantLease, checkAction } from "../src/lease.mjs";
import { runLoom, LOOM_GATES } from "../src/loom-gates.mjs";

let pass = 0, fail = 0;
const assert = (c, m) => c ? (pass++, console.log(`  PASS ${m}`)) : (fail++, console.log(`  FAIL ${m}`));

// lease basics
const lease = grantLease({
  actor: "orangellm-light",
  allowed: ["read_file", "grep", "list_dir"],
  forbidden: ["delete_file"],
  targetProject: "orange5",
  riskLevel: "low",
});
assert(lease.id?.startsWith("lease_"), "lease id minted");
assert(lease.forbidden.includes("destructive_write"), "default forbidden auto-merged");
assert(lease.forbidden.includes("delete_file"), "custom forbidden preserved");

assert(checkAction(lease, "read_file").allowed === true, "read_file allowed");
assert(checkAction(lease, "delete_file").allowed === false, "delete_file forbidden");
assert(checkAction(lease, "destructive_write").allowed === false, "default forbidden enforced");
assert(checkAction(lease, "write_file").allowed === false, "non-listed action denied");

// high risk → approval required
const high = grantLease({ actor: "orangellm-heavy", allowed: ["push_branch"], targetProject: "orange5", riskLevel: "high" });
assert(high.requires_approval === true, "high risk auto-flags requires_approval");
assert(checkAction(high, "push_branch").allowed === false, "no operator approval → denied");
assert(checkAction(high, "push_branch", { operator_approved: true }).allowed === true, "operator approval → allowed");

// conflict detection
let threw = false;
try { grantLease({ actor: "x", allowed: ["destructive_write"], targetProject: "orange5" }); } catch { threw = true; }
assert(threw, "allowed/forbidden conflict throws");

// LOOM happy path
assert(LOOM_GATES.length === 8, "8 LOOM gates declared");
const loomOk = runLoom({
  order: { schema: "orange.order.v1" },
  report: { schema: "orange.report.v1" },
  receipt_path: "10-RECEIPTS/x.md",
  lease,
  has_human_approval: true,
  status: "ORANGE5_OK",
});
assert(loomOk.pass === true, "LOOM passes when all gates satisfied");

const loomFake = runLoom({
  order: { schema: "orange.order.v1" },
  report: { schema: "orange.report.v1" },
  receipt_path: "x",
  lease,
  status: "looks_ok",
});
assert(loomFake.pass === false, "LOOM blocks fake-green");
assert(loomFake.gates.find(g => g.gate === "false_green_guard")?.pass === false, "false_green_guard fires");

const loomMissing = runLoom({ status: "OK" });
assert(loomMissing.pass === false, "LOOM blocks when nothing supplied");

console.log(`\n[hermes-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
