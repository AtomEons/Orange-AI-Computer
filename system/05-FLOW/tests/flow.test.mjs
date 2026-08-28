#!/usr/bin/env node
// AE Flow tests — exercise pressure ordering, agent assignment, governor throttle, close.

import { emptyState } from "../src/store.mjs";
import { pushCurrent, registerAgent, tick, closeCurrent, blockCurrent } from "../src/flow.mjs";

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}

// Test 1: high-pressure current wins over low-pressure
{
  const s = emptyState();
  const low = pushCurrent(s, { title: "low", pressure: 0.2 });
  const high = pushCurrent(s, { title: "high", pressure: 0.9 });
  const agent = registerAgent(s, { role: "orangellm-light" });
  tick(s);
  assert(s.currents[high.id].assigned_agent === agent.id, "high pressure current wins agent");
  assert(s.currents[low.id].assigned_agent === null, "low pressure waits");
  assert(s.currents[high.id].status === "in_progress", "high goes in_progress");
}

// Test 2: closing releases the agent for next pending
{
  const s = emptyState();
  const a = pushCurrent(s, { title: "a", pressure: 0.5 });
  const b = pushCurrent(s, { title: "b", pressure: 0.3 });
  const agent = registerAgent(s, { role: "orangellm-light" });
  tick(s);
  assert(s.currents[a.id].assigned_agent === agent.id, "a gets agent first");
  closeCurrent(s, a.id, { receipt_path: "10-RECEIPTS/orange5-build/test.md" });
  assert(s.currents[a.id].status === "closed", "a closed");
  assert(s.agents[agent.id].state === "idle", "agent released to idle");
  tick(s);
  assert(s.currents[b.id].assigned_agent === agent.id, "b picks up the released agent");
}

// Test 3: receipt_required blocks close without receipt
{
  const s = emptyState();
  const c = pushCurrent(s, { title: "needs receipt", acceptance: { receipt_required: true, approval_required: false, validator: null } });
  let threw = false;
  try { closeCurrent(s, c.id, {}); } catch { threw = true; }
  assert(threw, "close without receipt throws when receipt_required");
}

// Test 4: governor throttles when over concurrency cap
{
  const s = emptyState();
  pushCurrent(s, { title: "x1", pressure: 0.5 });
  pushCurrent(s, { title: "x2", pressure: 0.5 });
  pushCurrent(s, { title: "x3", pressure: 0.5 });
  pushCurrent(s, { title: "x4", pressure: 0.4 });  // overflow at cap=3
  for (let i = 0; i < 4; i++) registerAgent(s, { role: "orangellm-light" });
  tick(s, { concurrency_cap: 3 });
  const inProg = Object.values(s.currents).filter(c => c.status === "in_progress").length;
  assert(inProg <= 3, `governor caps in_progress at 3 (got ${inProg})`);
  const throttled = s.deltas.filter(d => d.kind === "governor_throttled");
  assert(throttled.length >= 1, "at least one throttle delta emitted");
}

// Test 5: blockCurrent moves status to blocked + emits delta
{
  const s = emptyState();
  const c = pushCurrent(s, { title: "blocker" });
  blockCurrent(s, c.id, "operator hold");
  assert(s.currents[c.id].status === "blocked", "current blocked");
  assert(s.deltas.some(d => d.kind === "current_blocked" && d.subject_id === c.id), "block delta emitted");
}

// Test 6: deltas are ordered + trim caps applied implicitly via store
{
  const s = emptyState();
  const c = pushCurrent(s, { title: "t" });
  registerAgent(s, { role: "orangellm-light" });
  tick(s);
  const kinds = s.deltas.map(d => d.kind);
  assert(kinds.includes("current_pressure_change"), "push emits pressure_change");
  assert(kinds.includes("agent_assigned"), "tick emits agent_assigned");
}

console.log(`\n[flow-tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
