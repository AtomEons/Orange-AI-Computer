#!/usr/bin/env node
// Persist-gate tests — verify the dirty-snapshot doctrine.
// Idle ticks must NOT call saveState. Dirty ticks must. Heartbeat must
// force a save even when nothing changed.

import { mkdirSync, rmSync, existsSync, statSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { emptyState } from "../src/store.mjs";
import { pushCurrent, registerAgent, tick, closeCurrent } from "../src/flow.mjs";
import { createPersistGate, DEFAULT_HEARTBEAT_MS, _internal } from "../src/persist-gate.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

let pass = 0, fail = 0;
function assert(cond, msg) {
  if (cond) { pass++; console.log(`  PASS ${msg}`); }
  else { fail++; console.log(`  FAIL ${msg}`); }
}

// We can't intercept saveState() without monkey-patching, so we test the
// gate's decision in isolation AND watch the real state/flow.json mtime
// across ticks with a controllable clock.

// Test 1: Fresh gate on empty state is clean.
{
  const s = emptyState();
  const gate = createPersistGate(s);
  const d = gate.shouldPersist();
  assert(d.persist === false && d.reason === "clean", "fresh gate on empty state is clean");
}

// Test 2: pushCurrent emits a delta → gate becomes dirty.
{
  const s = emptyState();
  const gate = createPersistGate(s);
  pushCurrent(s, { title: "x" });
  const d = gate.shouldPersist();
  assert(d.persist === true && d.reason === "deltas", "delta-emit flips gate to dirty");
}

// Test 3: markSaved clears the dirty state.
{
  const s = emptyState();
  const gate = createPersistGate(s);
  pushCurrent(s, { title: "x" });
  gate.markSaved("deltas");
  const d = gate.shouldPersist();
  assert(d.persist === false, "markSaved clears dirty");
}

// Test 4: status change without new delta still triggers dirty.
//   (Safety net — if someone mutates a current.status by hand.)
{
  const s = emptyState();
  const c = pushCurrent(s, { title: "x" });
  const gate = createPersistGate(s);
  // Baseline clean — gate snapshotted post-push.
  assert(gate.shouldPersist().persist === false, "clean baseline after gate creation");
  // Mutate status directly, NO delta. Gate should still notice.
  c.status = "blocked";
  const d = gate.shouldPersist();
  assert(d.persist === true && d.reason === "current_status", "direct status mutation marked dirty");
}

// Test 5: agent state change triggers dirty.
{
  const s = emptyState();
  registerAgent(s, { role: "orangellm-light" });
  const gate = createPersistGate(s);
  const agentId = Object.keys(s.agents)[0];
  s.agents[agentId].state = "riding";
  const d = gate.shouldPersist();
  assert(d.persist === true && d.reason === "agent_state", "agent state mutation marked dirty");
}

// Test 6: heartbeat — clean gate after heartbeatMs goes dirty for "heartbeat".
{
  const s = emptyState();
  let virtualNow = 1_000_000;
  const gate = createPersistGate(s, { heartbeatMs: 5_000, now: () => virtualNow });
  assert(gate.shouldPersist().persist === false, "t=0 clean");
  virtualNow += 4_999;
  assert(gate.shouldPersist().persist === false, "t=4999 still clean (below heartbeat)");
  virtualNow += 1;
  const d = gate.shouldPersist();
  assert(d.persist === true && d.reason === "heartbeat", "t=5000 heartbeat fires");
}

// Test 7: heartbeatMs=0 disables heartbeat entirely.
{
  const s = emptyState();
  let virtualNow = 0;
  const gate = createPersistGate(s, { heartbeatMs: 0, now: () => virtualNow });
  virtualNow = 999_999_999;
  assert(gate.shouldPersist().persist === false, "heartbeatMs=0 never fires heartbeat");
}

// Test 8: telemetry counts saves and skips.
{
  const s = emptyState();
  const gate = createPersistGate(s);
  gate.markSkipped();
  gate.markSkipped();
  gate.markSaved("deltas");
  const snap = gate.snapshot();
  assert(snap.totalSkips === 2, "skip telemetry");
  assert(snap.totalSaves === 1, "save telemetry");
  assert(snap.totalDirty === 1, "dirty-save telemetry");
  assert(snap.savePct === 33.3, `savePct rounded (got ${snap.savePct})`);
}

// Test 9: integrated — tick() with persistGate skips disk writes when idle.
//   Verifies state/flow.json mtime is stable across multiple idle ticks.
{
  const tmpFlowJson = process.env.ORANGE5_FLOW_STATE || join(__dirname, "..", "state", "flow.json");
  // Snapshot current mtime so we can restore if a tick wrote.
  const beforeBytes = existsSync(tmpFlowJson) ? readFileSync(tmpFlowJson) : null;
  const beforeMtime = existsSync(tmpFlowJson) ? statSync(tmpFlowJson).mtimeMs : 0;

  try {
    const s = emptyState();
    const gate = createPersistGate(s, { heartbeatMs: 0 }); // disable heartbeat for this test
    // Write empty state to disk so we can detect changes.
    writeFileSync(tmpFlowJson, JSON.stringify(s, null, 2));
    const t0Mtime = statSync(tmpFlowJson).mtimeMs;

    // Tick three times with no work; expect no disk writes.
    tick(s, { persistGate: gate });
    tick(s, { persistGate: gate });
    tick(s, { persistGate: gate });
    const tIdleMtime = statSync(tmpFlowJson).mtimeMs;
    assert(tIdleMtime === t0Mtime, `idle ticks do not touch disk (mtime ${t0Mtime} → ${tIdleMtime})`);
    const snap1 = gate.snapshot();
    assert(snap1.totalSaves === 0, `0 saves recorded during idle (got ${snap1.totalSaves})`);
    assert(snap1.totalSkips === 3, `3 skips recorded during idle (got ${snap1.totalSkips})`);

    // Push work and tick — expect a disk write this time.
    pushCurrent(s, { title: "work" });
    registerAgent(s, { role: "orangellm-light" });
    tick(s, { persistGate: gate });
    const dirtyBytes = readFileSync(tmpFlowJson, "utf8");
    assert(dirtyBytes === JSON.stringify(s, null, 2), "dirty tick writes current state to disk");
    const snap2 = gate.snapshot();
    assert(snap2.totalSaves === 1, `1 save recorded after dirty tick (got ${snap2.totalSaves})`);
  } finally {
    // Restore the pre-test state so we don't pollute the operator's flow.json.
    if (beforeBytes !== null) {
      writeFileSync(tmpFlowJson, beforeBytes);
    } else {
      try { rmSync(tmpFlowJson); } catch { /* idempotent */ }
    }
  }
}

// Test 10: fingerprint helpers handle empty + populated state symmetrically.
{
  const s = emptyState();
  assert(_internal.fingerprintStatuses(s) === "", "empty status fingerprint is ''");
  assert(_internal.fingerprintAgents(s) === "", "empty agent fingerprint is ''");
  pushCurrent(s, { title: "a" });
  pushCurrent(s, { title: "b" });
  const fp = _internal.fingerprintStatuses(s);
  assert(fp.split("|").length === 2, "two currents → two fingerprint parts");
}

console.log(`\n[persist-gate tests] ${pass} passed / ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
