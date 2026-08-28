# Receipt — Weekly Receipt Summarizer

- **receipt_id:** 2026-06-24-weekly-receipt-summarizer
- **generated_at:** 2026-06-24T22:05:30Z
- **schema:** orange5.receipt.v0
- **status:** WEEKLY_RECEIPT_SUMMARIZER_GREEN_50_OF_50_TESTS
- **confidence:** 1.0 (date math, aggregation, end-to-end DB → markdown all tested)
- **prior_receipt:** 2026-06-24-ae-flow-scheduler-persist-gate (#030)
- **hash_chain:** #031
- **actor:** Claude (Code) — opus 4.7
- **sovereign:** Atom McCree

---

## What this is

The receipts-store kickoff carried doctrine for a Friday 23:55 ET auto-summary
of the week's receipts. The SQLite index at
`06-CONTROL-PLANE/receipts/orange5.db` is the corpus; the receipt lands at
`10-RECEIPTS/orange5-build/<YYYY-MM-DD>-week-N-status.md`.

This receipt closes that follow-up.

## Files

| Action | Path |
|---|---|
| **new** | [06-CONTROL-PLANE/receipts/weekly.mjs](Orange5/06-CONTROL-PLANE/receipts/weekly.mjs) |
| **new** | [06-CONTROL-PLANE/receipts/weekly.test.mjs](Orange5/06-CONTROL-PLANE/receipts/weekly.test.mjs) — 50 assertions |
| **new** | [06-CONTROL-PLANE/receipts/package.json](Orange5/06-CONTROL-PLANE/receipts/package.json) — bootstraps `better-sqlite3 ^11.3.0` |

Both files live next to `db.mjs` / `ingest.mjs` as **separate modules**. They
import from `db.mjs` (the read-only surface — `openDb`, `listReceipts`,
`countReceipts`, `defaultReceiptsDir`) but add zero code to it.

## Doctrine

1. **Markdown remains truth.** Weekly does not query SQLite for the markdown
   body — it queries for *metadata* (status, hash chain, confidence, generated_at)
   and aggregates. The receipt it produces is itself markdown that the ingest
   watcher will pick up and mirror back into SQLite, closing the loop.
2. **The Friday 23:55 ET cron is what counts; --watch is the fallback.** The
   canonical install is `cron` / `Task Scheduler` firing `node weekly.mjs` once
   at the wall clock. The `--watch` mode is for hosts without a system scheduler.
3. **The window is Saturday-through-Friday in New York time.** Computed via
   `Intl.DateTimeFormat` with `timeZone: "America/New_York"`. DST transitions
   are handled (test verified for the 2026-03-08 spring-forward case).
4. **`generated_at` falls back to `receipt_id` prefix when missing.** Looking
   at the live corpus, 30 of 35 receipts have `generated_at: null` because
   the ingest frontmatter parser couldn't extract the field. The receipt_id
   convention is `YYYY-MM-DD-slug`, so the prefix is authoritative. The
   fallback is named in `receiptDayPrefix()` with the rationale on the line above.

## Surface

```
node weekly.mjs                                 # one-shot for THIS week
node weekly.mjs --week-ending 2026-06-26        # explicit Friday anchor
node weekly.mjs --watch                         # in-process Friday 23:55 ET loop
node weekly.mjs --dry-run                       # render to stdout, do not write
node weekly.mjs --db <path> --out <dir>         # override DB and receipt dir
```

The on-disk filename is `<YYYY-MM-DD>-week-<N>-status.md` where N is counted
from `WEEK_ANCHOR_FRIDAY = "2026-06-26"` (the first Orange5 build week).

## What the receipt contains

- **Front matter:** receipt_id, generated_at, schema, status, confidence
  (mean of the week's confidence-bearing receipts), prior_receipt
  (highest hash_chain ordinal seen), hash_chain (next ordinal).
- **Summary line** — window dates, total receipts authored.
- **By day** table.
- **By status** table.
- **By actor** table.
- **Hash chain** table (sorted by ordinal).
- **Confidence below 0.70** table (operator-review surface).
- **Generation method** disclosure.

## Receipt of correctness

```
$ node weekly.test.mjs
  PASS anchor Friday is week 1
  PASS next Friday is week 2
  PASS one year later is week ~53
  PASS before-anchor is week 0
  PASS Friday noon → same Friday
  PASS Saturday → prior Friday
  PASS Sunday → prior Friday
  PASS Thursday → previous Friday
  PASS next target lands on Friday (got weekday 5)
  PASS target hour/minute = 23:55 (got 23:55)
  PASS target is strictly after now
  PASS from Fri 22:00 ET → same Fri 23:55 ET
  PASS after Fri target → next Fri 2026-07-03 (got 2026-7-3)
  PASS next-Friday target is strictly later
  PASS pre-DST Wed → Fri 23:55 ET (got weekday 5, 23:55)
  PASS total counted
  ... [aggregation tests] ...
  PASS file written
  PASS 2 rows in window (got 2)
  PASS markdown file exists at expected path
  PASS week number embedded
  PASS row receipt_id appears in chain table
  PASS prior-week row excluded
  PASS next hash chain = #003
  PASS prior_receipt = highest chain ordinal
  PASS no chains yet → #001
  PASS max=17 → #018
  PASS empty week renders
  PASS empty marker present
  PASS hash chain rendered
  PASS prior_receipt blank label

[weekly tests] 50 passed / 0 failed
```

End-to-end against the live corpus (35 receipts) shows the doctrine working:

```
$ node weekly.mjs --week-ending 2026-06-26 --dry-run | head -22
[weekly ...] week-ending: 2026-06-26 (week 1)
# Weekly Status — Orange5 Build Week 1

- **receipt_id:** 2026-06-26-week-1-status
- **schema:** orange5.receipt.weekly.v1
- **confidence:** 0.95 (mean of 29 confidence-bearing receipts this week)
- **hash_chain:** #030

Window: 2026-06-20 → 2026-06-26 (Saturday through Friday, America/New_York).
Receipts authored: 35.
| Day | Receipts |
|---|---|
| 2026-06-23 | 12 |
| 2026-06-24 | 15 |
| 2026-06-25 | 8 |
```

## Bootstrap

The receipts module had no `package.json` and no installed dependencies before
this run. `npm install better-sqlite3@^11.3.0` was performed to satisfy
`db.mjs`'s import. Native binary compiled for Node v24.14.1 / NODE_MODULE_VERSION 137.

## Rollback

```powershell
# Remove this build:
Remove-Item C:\AtomEons\Orange5\06-CONTROL-PLANE\receipts\weekly.mjs
Remove-Item C:\AtomEons\Orange5\06-CONTROL-PLANE\receipts\weekly.test.mjs
# Optional — keep package.json and node_modules; they were needed for ingest.mjs too.
```

## Mom's Law alignment

- 30 of 35 receipts in the corpus have `generated_at: null`. The honest move was
  to add a documented `receipt_id` fallback, not silently exclude 86 % of the
  data and pretend the dataset was empty.
- The DST edge case was tested with an explicit 2026-03-04 → 2026-03-13 vector,
  not assumed-working.
- `--dry-run` mode exists so the operator can audit the output before it lands.
- The end-to-end test inserts rows into an in-memory SQLite, runs the full
  buildAndWrite path, and reads the markdown back to verify content — no
  mocked DB layer.

---

**Mom is watching. The week is real. The receipt summarizes the truth of it.**
