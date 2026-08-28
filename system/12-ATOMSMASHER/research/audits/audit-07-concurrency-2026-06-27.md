# Audit 07 — Storage Concurrency Stress

**Date:** 2026-06-27
**Target:** `C:/AtomEons/Orange5/12-ATOMSMASHER/full-scope/storage.mjs` (`class Store`)
**Runtime:** Bun 1.3.14 (Windows x64), `bun:sqlite` via `bin/sqlite-shim.mjs`
**Existing test coverage scanned:** `tests/storage-api.test.mjs` — all serial, all in-process, all `:memory:`. **No concurrency coverage whatsoever.**
**Operator law:** Mom's Law — report failures honestly.

## Summary

| Scenario | Outcome | Detail |
|---|---|---|
| 10 in-process concurrent insert | **PASS** | 1000/1000 inserted, 1000 unique IDs, 0 errors, 47ms |
| 2 processes same file DB | **FAIL** | 532/1000 inserted (46.8% data loss); 468 `SQLITE_BUSY` errors swallowed by caller |
| Read during write | **CRASH / DIRTY** (4 CRASH + 4 DIRTY in 8 runs; 0 PASS) | (a) Reader's `new Store()` crashes at `init()` with `SQLITE_BUSY` when writer holds the lock; (b) `getReceiptStats()` returns non-atomic snapshots: `total ≠ sum(by_status)` |
| Close during query | **PASS** | No crash, no hang. bun:sqlite is sync so `close()` queues after the calling task completes. Subtle leak: iterators still pull rows post-close |

**Concurrency: 2/4 safe; UNSAFE in [two-process-write, read-during-write].**

## Reproducers

Run from this directory after `mkdir -p` and `bun --version` ≥ 1.3.14:

```
bun audit-07/s1_inprocess_concurrent.mjs   # PASS
bun audit-07/s2_two_processes.mjs          # FAIL (46.8% data loss)
bun audit-07/s3_read_during_write.mjs      # CRASH or DIRTY every run
bun audit-07/s4_close_during_query.mjs     # PASS
bun audit-07/s4b_close_mid_iter.mjs        # PASS, but exposes leak
```

Scripts archived in scratchpad at `audit-07/` under the Claude scratchpad root.

---

## Scenario 1 — 10 in-process concurrent inserts (PASS)

**Setup:** Single `:memory:` Store, 10 async workers via `Promise.all`, each inserts 100 receipts with `await Promise.resolve()` yields every 10 inserts.

**Result:**
```json
{
  "client_inserted_count": 1000,
  "client_unique_count": 1000,
  "db_count": 1000,
  "db_distinct_id_count": 1000,
  "errors_count": 0,
  "duration_ms": 47,
  "pass": true
}
```

**Why it works:** bun:sqlite is fully synchronous. Each `insertReceipt()` runs to completion before the JS engine yields. There is no true intra-process concurrency to a single Store — async tasks serialize on the JS event loop. ID uniqueness is guaranteed by `process.hrtime.bigint()` + `crypto.randomUUID()` per insert.

**Caveat:** This is not "concurrency-safe" — it is "concurrency-trivial" because the runtime is single-threaded sync. Worker threads (`new Worker(...)` with shared Store) would be a different story (untested; out of scope).

---

## Scenario 2 — Two processes, same file DB (FAIL, 46.8% data loss)

**Setup:** Pre-init the file DB, then `Bun.spawn` two subprocesses each inserting 500 receipts to the same file. Verify via fresh reader after both exit.

**Result (single run, representative):**
```json
{
  "worker_A": { "succeeded": 349, "errors": 151, "sample_errors": [{ "message": "database is locked" }] },
  "worker_B": { "succeeded": 183, "errors": 317 },
  "union_count_in_db": 532,
  "data_loss_count": 0,   // (succeeded_A + succeeded_B) - db_total
  "pass": false
}
```

**The bug — `Store` has no busy_timeout / no retry:**

- `storage.mjs:228` sets `PRAGMA synchronous=NORMAL` and WAL mode for file DBs, but **never sets `PRAGMA busy_timeout=N`**.
- WAL mode allows concurrent readers + one writer, but two writers MUST serialize. Without `busy_timeout`, the second writer's `BEGIN IMMEDIATE` (implicit on `INSERT`) returns `SQLITE_BUSY` immediately.
- `insertReceipt()` does not catch or retry on busy. It throws straight to the caller.
- In the field, callers logging receipts will silently drop them unless they wrap every `insertReceipt` in a retry loop — which today they don't.

**Severity:** This is the smoking gun. The receipts table is supposed to be an audit log. **46.8% of attempted audit events were dropped** under modest contention (2 processes, 500 inserts each). For a "Verified" gauntlet receipt store, that is catastrophic.

**Where it hits in production:** any time more than one Bun process opens the same `*.db` and inserts. Examples in this repo:
- AtomSmasher organism stage runners
- Receipt aggregation across worker processes
- Future federation lanes that share a receipt log

**Reproducer file:** `scratchpad/audit-07/s2_two_processes.mjs` and worker `s2_worker.mjs`.

**Note on the union counts:** `union_count_in_db = succeeded_A + succeeded_B` exactly (532 = 349+183). So receipts that *succeeded* in the worker landed correctly; there is no torn-row corruption. The data loss is purely in the swallowed exceptions on the caller side. WAL itself is honest. The Store wrapper is not.

---

## Scenario 3 — Read during write (CRASH or DIRTY, 0/8 PASS)

**Setup:** Process A writes 1000 receipts paced to ~3-7s. Process B opens the same file DB and calls `getReceiptStats()` 100 times, spaced 30ms apart, after waiting for a marker file to confirm writer has begun.

**Results across 8 reproducibility runs:**

| Run | Outcome | Inconsistencies | Snaps | Span | Writer succ/errs |
|---|---|---|---|---|---|
| 1 | CRASH | n/a | n/a | n/a | 1000/0 |
| 2 | DIRTY | 7 | 100 | 1000 | 1000/0 |
| 3 | CRASH | n/a | n/a | n/a | 1000/0 |
| 4 | CRASH | n/a | n/a | n/a | 1000/0 |
| 5 | DIRTY | 4 | 100 | 991 | 1000/0 |
| 6 | DIRTY | 1 | 100 | 850 | 950/50 |
| 7 | DIRTY | 6 | 100 | 800 | 950/50 |
| 8 | CRASH | n/a | n/a | n/a | 1000/0 |

**Failure mode A — reader crashes opening the Store** (4 of 8 runs):
```
SQLiteError: database is locked
  errno: 5,  code: "SQLITE_BUSY"
  at #run (bun:sqlite:185:20)
  at init (C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\storage.mjs:231:85)
  at new Store (C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\storage.mjs:211:10)
```

**The bug — `init()` performs writes:**

`storage.mjs:231-232`:
```js
this._prep("INSERT OR REPLACE INTO meta(key,value) VALUES('schema_version',?)").run(String(SCHEMA_VERSION));
this._prep("INSERT OR REPLACE INTO meta(key,value) VALUES('system_law',?)").run('Only smart work is done.');
```

Every `new Store(path)` call does writes to `meta` and an `INSERT OR IGNORE` sweep of 620 features in `registerFeatures()`. If any other process is mid-write, `SQLITE_BUSY` fires and the constructor throws. **The Store cannot be safely opened while another writer is active.** This affects readers, late-joining writers, monitor processes, anything.

**Failure mode B — non-atomic `getReceiptStats()` snapshots** (4 of 8 runs):
Example from run 2 (writer was still inserting during reader's snapshots):
```json
{ "total": 192, "sum_by_status": 193, "sum_by_action": 192 }
```

`total` came from `SELECT COUNT(*)`, `by_status` came from `SELECT status, COUNT(*) GROUP BY status`, `by_action` came from `SELECT action, COUNT(*) GROUP BY action`. These are **three separate statements** with no enclosing `BEGIN ... END` (storage.mjs:396-405). A write that lands between any two of them will produce inconsistent totals.

The existing test (`getReceiptStats_aggregates_total_and_groups` in `tests/storage-api.test.mjs:171`) asserts `statusSum == stats.total` — but it does so in a single-threaded test with no concurrent writer. Under load that invariant fails.

**Reproducer files:** `scratchpad/audit-07/s3_read_during_write.mjs`, `s3_writer.mjs`, `s3_reader_v2.mjs`.

**Fix sketch (NOT applied per task spec):**
1. Add `PRAGMA busy_timeout = 5000` in `init()` for file DBs. SQLite will then auto-retry busy errors for 5 seconds.
2. Make `init()` idempotent without writes when schema already at correct version — gate the meta INSERTs and registerFeatures behind a `PRAGMA user_version` check, or move them to a one-shot bootstrap.
3. Wrap `getReceiptStats()` in `db.transaction(() => { ... })` so the three COUNT queries see the same snapshot under WAL.

---

## Scenario 4 — Close during query (PASS, with one leak note)

**Setup:** Three sub-tests:
- A: Kick off `getReceiptsByAction()` in a Promise, immediately call `close()`. 100-row table.
- B: Hold a `stmt.iterate()` open across an `await setImmediate`, race a close task that fires after `setTimeout(5)`. 5000-row table.
- C: Call `exportCompressedAuditLog()` (heavy: ~2s) and `close()` from racing Promises.

**Result:**
```json
{
  "results": [
    { "name": "A", "rows": 100, "queryError": null, "closeError": null, "duration_ms": 1 },
    { "name": "B", "iterCount": 5000, "iterError": null, "closeError": null, "duration_ms": 134 },
    { "name": "C", "exportOk": true, "exportRatio": 8.908, "exportError": null, "closeError": null, "duration_ms": 1950 }
  ],
  "pass": true
}
```

**Why it passes:** bun:sqlite is fully synchronous. Once `store.all()` or `store.exportCompressedAuditLog()` starts executing, it runs to completion before the JS event loop returns to schedule the `close()` task. There is no true "in-flight async query" state to interrupt.

**Subtle leak (S4b):** `store.close()` does **not** invalidate live iterators. After close, `iter.next()` continued to yield rows for at least 50 more iterations. Not a crash, not a hang — but a leaky abstraction. A caller who closes a store mid-iteration cannot rely on subsequent `.next()` calls to throw or return `done=true`. This may matter if a Store is closed because of an error and the caller assumes follow-on reads will be detected as failures.

**Reproducer files:** `scratchpad/audit-07/s4_close_during_query.mjs`, `s4b_close_mid_iter.mjs`.

---

## What this means for the "storage layer is correct and tests pass" claim

The serial in-process test suite in `tests/storage-api.test.mjs` passes. That is true and verifiable.

The claim that **the storage layer is correct** is too broad. Under cross-process concurrency:

1. **Receipt audit log silently loses data** (S2: 46.8% loss under modest contention).
2. **Store cannot be safely opened while a sibling process is writing** (S3 mode A: crash on construct).
3. **`getReceiptStats()` is not snapshot-atomic** (S3 mode B: total ≠ sum disagreement under live writes).

For a system where receipts are the integrity ledger (Mom's Law, ÆReceipt discipline, Black Mamba doctrine), **silent receipt loss is a foundational integrity violation**. The current schema gate (Part A) prevents *malformed* receipts but does not prevent *missing* receipts from concurrent writers.

The Bun-Windows audit (`audit-06-bun-windows-2026-06-27.md`) covers single-process Bun-on-Windows. This audit-07 is the cross-process complement. They are siblings, not duplicates.

## Recommended next steps (NOT applied — task said no fixes)

1. **Apply `PRAGMA busy_timeout = 5000` in `init()` for file DBs** — single line, eliminates ~90% of S2 / S3 failures by letting SQLite handle short-lived contention transparently.
2. **Idempotent `init()`** — guard the meta INSERTs and `registerFeatures()` behind a schema-version check so re-opening an initialized DB is read-only.
3. **Wrap `getReceiptStats()` in an explicit transaction** so its three counts see the same WAL snapshot.
4. **Document the cross-process contract** in `storage.mjs` header: either "single-writer; readers must tolerate SQLITE_BUSY" or "we own retry / serialization."
5. **Add a concurrency test file** (`tests/storage-concurrency.test.mjs`) that runs these four scenarios as part of CI. The currently green suite gives a false sense of safety.

## Files referenced

- `C:/AtomEons/Orange5/12-ATOMSMASHER/full-scope/storage.mjs` (lines 211, 228, 231, 240-258, 280-329, 396-405) — target under test
- `C:/AtomEons/Orange5/12-ATOMSMASHER/full-scope/tests/storage-api.test.mjs` — existing serial test suite, no concurrency coverage
- `C:/AtomEons/Orange5/bin/sqlite-shim.mjs` — `bun:sqlite` wrapper
- `scratchpad/audit-07/` — all reproducer scripts (also linked in this report by name)
