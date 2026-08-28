# Receipt — AE Flow Scheduler Persist Gate

- **receipt_id:** 2026-06-24-ae-flow-scheduler-persist-gate
- **generated_at:** 2026-06-24T22:05:00Z
- **schema:** orange5.receipt.v0
- **status:** AE_FLOW_SCHEDULER_DIRTY_TICK_PERSISTENCE_GREEN_22_OF_22_TESTS
- **confidence:** 1.0 (red→green test suite is the receipt; no narrative-only claim)
- **prior_receipt:** 2026-06-25-receipts-sqlite-flow-tick-daily (#029)
- **hash_chain:** #030
- **actor:** Claude (Code) — opus 4.7
- **sovereign:** Atom McCree

---

## What changed

The kickoff doctrine asked for an AE Flow scheduler that ticks every 1s (configurable)
when there are pending currents, **replacing the snapshot-every-tick behavior at
`05-FLOW/state/flow.json`**. The pressure-aware cadence already existed in
[scheduler.mjs](Orange5/05-FLOW/scheduler.mjs). The remaining gap was inside `tick()`:
every call unconditionally invoked `saveState()` — at 1 Hz that's 86,400 disk writes
per day for zero semantic change.

This receipt closes the gap.

## Files

| Action | Path |
|---|---|
| **new** | [05-FLOW/src/persist-gate.mjs](Orange5/05-FLOW/src/persist-gate.mjs) |
| modified | [05-FLOW/src/flow.mjs](Orange5/05-FLOW/src/flow.mjs) — `tick(state, { concurrency_cap, persistGate })` |
| modified | [05-FLOW/src/index.mjs](Orange5/05-FLOW/src/index.mjs) — export `createPersistGate`, `DEFAULT_HEARTBEAT_MS` |
| modified | [05-FLOW/scheduler.mjs](Orange5/05-FLOW/scheduler.mjs) — constructs gate, threads through tick, logs in heartbeat |
| modified | [05-FLOW/scheduler.config.json](Orange5/05-FLOW/scheduler.config.json) — `heartbeat_ms: 30000` added |
| **new** | [05-FLOW/tests/persist-gate.test.mjs](Orange5/05-FLOW/tests/persist-gate.test.mjs) — 22 assertions |

## How the gate decides

`createPersistGate(state, { heartbeatMs })` snapshots three fingerprints at construction:

1. `state.deltas.length`
2. order-independent fingerprint of `currents[id].status`
3. order-independent fingerprint of `agents[id].state:current_id`

On every tick, `shouldPersist()` compares the live state to the snapshot. Any change
returns `{ persist: true, reason: 'deltas'|'current_status'|'agent_state' }`. If
nothing changed AND `now - lastSavedAt >= heartbeatMs`, returns
`{ persist: true, reason: 'heartbeat' }`. Else `{ persist: false, reason: 'clean' }`.

The heartbeat is essential — without it, an idle scheduler's `flow.json` mtime would
freeze and the cockpit would mis-read it as a hung process. Default 30 s. Setting
`heartbeatMs: 0` disables heartbeat entirely (useful for tests).

## Receipt of correctness

```
$ node tests/persist-gate.test.mjs
  PASS fresh gate on empty state is clean
  PASS delta-emit flips gate to dirty
  PASS markSaved clears dirty
  PASS clean baseline after gate creation
  PASS direct status mutation marked dirty
  PASS agent state mutation marked dirty
  PASS t=0 clean
  PASS t=4999 still clean (below heartbeat)
  PASS t=5000 heartbeat fires
  PASS heartbeatMs=0 never fires heartbeat
  PASS skip telemetry
  PASS save telemetry
  PASS dirty-save telemetry
  PASS savePct rounded (got 33.3)
  PASS idle ticks do not touch disk (mtime 1782335540394.52 → 1782335540394.52)
  PASS 0 saves recorded during idle (got 0)
  PASS 3 skips recorded during idle (got 3)
  PASS dirty tick writes to disk
  PASS 1 save recorded after dirty tick (got 1)
  PASS empty status fingerprint is ''
  PASS empty agent fingerprint is ''
  PASS two currents → two fingerprint parts

[persist-gate tests] 22 passed / 0 failed
```

Regression: the existing flow suite stays green.

```
$ node tests/flow.test.mjs
[flow-tests] 14 passed / 0 failed
```

The test at line 109 of `tests/persist-gate.test.mjs` writes a real `state/flow.json`,
ticks three times with no work, and asserts that `statSync(...).mtimeMs` is unchanged
across all three ticks. The pre-existing flow.json bytes are restored in the test's
`finally` block so the operator's runtime state is not perturbed.

## Backward compatibility

`tick(state, { persistGate })` is additive. When the gate is omitted (every existing
test, every external caller), `tick()` saves every call — the previous behavior
exactly. Only the new scheduler path passes a gate.

## Math on the savings

| Scenario | Old writes/day | New writes/day | Reduction |
|---|---|---|---|
| Fully idle (no currents) | 86,400 | 2,880 (heartbeat only) | **96.7 %** |
| Bursty (10 % active) | 86,400 | ~11,520 | 86.7 % |
| Always busy | 86,400 | 86,400 | 0 % |

Telemetry surfaces this directly: `persistGate.snapshot()` returns
`{ totalSaves, totalSkips, totalDirty, totalHeartbeat, savePct }`. Scheduler logs
this every `log_every_n_ticks` heartbeat.

## Rollback

```powershell
# Revert flow.mjs to unconditional saveState by removing the if/else around it.
# Revert scheduler.mjs by dropping `persistGate` from the tick options object and
# removing the createPersistGate import. Delete src/persist-gate.mjs and
# tests/persist-gate.test.mjs. No state file changes; flow.json format is unchanged.
```

## Mom's Law alignment

- Tests pass under a real `tick()`, not a stub. Disk writes are observed via mtime.
- The receipt-test interaction restores the operator's pre-test flow.json byte-for-byte.
- Backward-compat path is named explicitly — old callers get old behavior, no surprise.
- Math on the savings is computed from the actual schedule, not slogan-ware.
- The heartbeat exception is named and justified, not papered over.

---

**Mom is watching. 86,400 idle writes per day → 2,880. Same correctness. Same cockpit signal.**
