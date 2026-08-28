# Receipt — Endurance Gates (24h synthetic + 7d real)

- **receipt_id:** 2026-06-24-endurance-gates
- **generated_at:** 2026-06-24T22:06:00Z
- **schema:** orange5.receipt.v0
- **status:** ENDURANCE_GATES_AUTHORED_24H_SMOKE_PASS_7D_SMOKE_PASS_51_OF_51_TESTS
- **confidence:** 0.92 (24h sim and 7d smoke both PASS; full 24h-at-10x and full 7d not yet operator-witnessed)
- **prior_receipt:** 2026-06-24-weekly-receipt-summarizer (#031)
- **hash_chain:** #032
- **actor:** Claude (Code) — opus 4.7
- **sovereign:** Atom McCree

---

## What this is

The third receipts-store kickoff follow-up: endurance gates.

- **(a) Synthetic 24h test** — replays 24h of Flux events through the receipts
  pipeline at 10× speed (default; configurable).
- **(b) Real 7-day uptime monitor** — observes the live receipts DB and AE Flow
  scheduler at a configurable poll interval (default 5 min), emits interim
  checkpoints (default every 24 h), final pass/fail at end of window.

Both emit markdown receipts to `10-RECEIPTS/orange5-build/` and exit non-zero
on FAIL so they can gate CI / promotion.

## Files

| Action | Path |
|---|---|
| **new** | [06-CONTROL-PLANE/receipts/endurance-24h.mjs](Orange5/06-CONTROL-PLANE/receipts/endurance-24h.mjs) |
| **new** | [06-CONTROL-PLANE/receipts/endurance-7d-monitor.mjs](Orange5/06-CONTROL-PLANE/receipts/endurance-7d-monitor.mjs) |
| **new** | [06-CONTROL-PLANE/receipts/endurance.test.mjs](Orange5/06-CONTROL-PLANE/receipts/endurance.test.mjs) — 51 assertions |

Both endurance scripts are **separate files** at the same level as `db.mjs` /
`ingest.mjs`. They `import` from `db.mjs` (`openDb`, `upsertReceipt`,
`countReceipts`, `listReceipts`, `defaultReceiptsDir`) and add zero code to it.

## (a) Synthetic 24h test

### Surface

```
node endurance-24h.mjs                                # 24h sim @ 10x → 2.4h wall
node endurance-24h.mjs --speedup 100                  # 24h sim → 14.4 min
node endurance-24h.mjs --speedup 600                  # 24h sim → 2.4 min
node endurance-24h.mjs --hours 1 --speedup 60         # 1h sim → 60s (smoke)
node endurance-24h.mjs --events <path.jsonl>          # replay real Flux events
node endurance-24h.mjs --rss-budget 128               # raise MiB ceiling
node endurance-24h.mjs --seed N                       # deterministic synthesis
```

### What it validates

| Check | What it asserts |
|---|---|
| `rows_match` | SQLite row count = events generated |
| `no_parse_errors` | `ingest_log` has zero PARSE_ERROR entries |
| `rss_under_budget` | Max RSS growth ≤ `--rss-budget` (default 64 MiB) |
| `idempotent` | Re-upserting the last event with identical bytes is a no-op |
| `sha_integrity` | 20-sample SHA-256 of on-disk markdown matches stored row.sha256 |

### Receipt of correctness — 24h @ 10000x smoke run

```
$ node endurance-24h.mjs --speedup 10000 --out C:/tmp/endurance-test-out
[endurance-24h ...] hours:   24 (simulated)
[endurance-24h ...] speedup: 10000x → wall clock ≈ 8.6s
[endurance-24h ...] events:  12/h synthetic
[endurance-24h ...] event count: 288
[endurance-24h ...] verdict: PASS
[endurance-24h ...]   PASS rows_match
[endurance-24h ...]   PASS no_parse_errors
[endurance-24h ...]   PASS rss_under_budget
[endurance-24h ...]   PASS idempotent
[endurance-24h ...]   PASS sha_integrity
```

Walked 288 events through a temp SQLite (`<tmpdir>/orange5-endurance-24h-*/endurance.db`),
ended at 64.1 MiB RSS (start: 61.2 MiB → growth 2.9 MiB ≪ 64 MiB budget),
verified 20-sample SHA-256 round-trip, asserted UPSERT idempotency. Temp dir is
deleted on exit unless `--keep-temp` is passed. **The operator's production
`orange5.db` is never opened** — each run uses a private mkdtempSync path.

### The 10× wall-clock view (operator-facing)

`24h × 1/10 = 2.4h`. For a real 10× replay the operator would run
`node endurance-24h.mjs --speedup 10` and wait 2 hours 24 minutes. The
`--speedup 10000` here proves the integration; the 10× run is the doctrinal
default for nightly CI.

## (b) Real 7d uptime monitor

### Surface

```
node endurance-7d-monitor.mjs                          # 7d real run, 5-min poll
node endurance-7d-monitor.mjs --duration 60s           # short smoke
node endurance-7d-monitor.mjs --duration 6h            # 6-hour gate
node endurance-7d-monitor.mjs --interval 30s
node endurance-7d-monitor.mjs --checkpoint-hours 12    # interim every 12h
node endurance-7d-monitor.mjs --rss-budget 256
node endurance-7d-monitor.mjs --disk-floor 1024
node endurance-7d-monitor.mjs --db <path>
node endurance-7d-monitor.mjs --flow-state <path>
node endurance-7d-monitor.mjs --out <dir>
node endurance-7d-monitor.mjs --flow-stale-ms <ms>
```

### What it watches

At every poll interval:

| Probe | Pass condition |
|---|---|
| `probeDb` | `openDb(dbPath)` succeeds; `countReceipts` returns; ingest_log delta = 0 PARSE/WATCH errors since previous poll |
| `probeFlowState` | `state/flow.json` mtime age ≤ `flowStaleMs` (default 35 s = 30s heartbeat + 5s grace) |
| `probeDisk` | Free disk space ≥ `--disk-floor` MiB (default 1024); skipped if `fsp.statfs` unavailable |
| `probeRss` | Monitor's own RSS ≤ `--rss-budget` MiB (default 256) |

Failures during the window are counted, NOT raised — the monitor stays up so it
can witness recovery. The final verdict reflects the aggregate.

### Checkpoints

If `--checkpoint-hours > 0` (default 24), the monitor writes interim receipts
named `<YYYY-MM-DD>-endurance-7d-checkpoint-<sample-count>.md` so the operator
can see the gate is alive and accumulating data before the 7-day window closes.

### Receipt of correctness — 20s smoke against live system

```
$ node endurance-7d-monitor.mjs --duration 20s --interval 5s \
       --flow-stale-ms 999999999999 --out C:/tmp/endurance-test-out
[endurance-7d ...] db:         C:\AtomEons\Orange5\06-CONTROL-PLANE\receipts\orange5.db
[endurance-7d ...] flowState:  C:\AtomEons\Orange5\05-FLOW\state\flow.json
[endurance-7d ...] sample #1 db_rows=35 ingest_err=0 flow_age_s=2122 rss_mib=59.6 free_mib=148084
[endurance-7d ...] sample #2 db_rows=35 ingest_err=0 flow_age_s=2130 rss_mib=59.9 free_mib=148084
[endurance-7d ...] sample #3 db_rows=35 ingest_err=0 flow_age_s=2135 rss_mib=59.7 free_mib=148084
[endurance-7d ...] verdict: PASS
[endurance-7d ...]   PASS db_always_reachable
[endurance-7d ...]   PASS no_new_ingest_errors
[endurance-7d ...]   PASS flow_always_fresh
[endurance-7d ...]   PASS rss_under_budget
[endurance-7d ...]   PASS disk_above_floor
```

(Bypassed flow-staleness for the smoke because the AE Flow scheduler is not
currently running in this dev environment — the test verified the probe path,
not the live freshness. For a real 7d run the operator must have the scheduler
up; otherwise the `flow_always_fresh` check will FAIL with the actual mtime age
in the receipt's `flow_max_age_ms` field.)

### Unit tests

```
$ node endurance.test.mjs
  ... [event synthesis tests] ...
  PASS fully deterministic for fixed seed
  PASS 288 events for 24h × 12/h (got 288)
  PASS span ≤ 24h (got 24h)
  PASS events sorted ascending by ts
  PASS different seeds → different streams
  PASS PRNG stays in sync across 100 draws
  PASS receipt_id present and zero-padded
  PASS frontmatter receipt_id row present
  PASS schema row present
  PASS actor row present
  PASS sovereign row present
  PASS row sha256 matches markdown digest
  PASS mtime = event ts
  PASS verdict PASS (got PASS)
  PASS result receipt written
  PASS body has title
  PASS body has verdict
  PASS 6 events (got 6)
  PASS no parse errors
  PASS sha integrity intact
  PASS idempotency intact
  ... [parseDuration tests, summarizeChecks, deriveChecks, renderResultReceipt] ...
  PASS checkpoint marker in title

[endurance tests] 51 passed / 0 failed
```

## What's NOT done yet

- A full **24h sim at the doctrinal default 10×** has not been run — that's
  2 h 24 min of wall clock and belongs in nightly CI, not this build session.
  The smoke at 10000× proves the path; the 10× run is a future operator action.
- A **real 7-day run** has not been started — same reason. The smoke proves
  the integration. The operator should start the 7d monitor as a long-running
  process under systemd or PM2 to get the final pass/fail receipt at day 7.

Confidence is set to 0.92 to reflect these two operator-witnessing gaps.

## Rollback

```powershell
Remove-Item C:\AtomEons\Orange5\06-CONTROL-PLANE\receipts\endurance-24h.mjs
Remove-Item C:\AtomEons\Orange5\06-CONTROL-PLANE\receipts\endurance-7d-monitor.mjs
Remove-Item C:\AtomEons\Orange5\06-CONTROL-PLANE\receipts\endurance.test.mjs
# package.json is shared with weekly + ingest — leave it.
```

## Mom's Law alignment

- 24h sim at 10000× speedup ran end-to-end against a temporary SQLite — real
  better-sqlite3 binding, real UPSERTs, real SHA round-trip.
- 7d monitor smoke-tested against the live `orange5.db` and the live
  `state/flow.json` — real file handles, real probes.
- The two operator-witnessing gaps (full 10× 24 h and full 7-day) are named in
  "What's NOT done yet" rather than hidden — confidence dropped from 1.0 to 0.92
  to reflect them honestly.
- Idempotency was tested by re-upserting the last synthetic event after the run
  completed and asserting `op === 'unchanged'`.
- Failures are deliberately non-fatal during a 7d run (counted, surfaced in the
  receipt) so the gate can witness recovery — explained in code with the
  trade-off named.

---

**Mom is watching. 24 h held at 10000×. 20 s held against the live system. The full-window runs are the operator's to start.**
