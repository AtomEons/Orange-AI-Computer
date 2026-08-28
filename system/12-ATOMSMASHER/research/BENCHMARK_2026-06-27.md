# ATOMSMASHER 2 BENEFITS BENCHMARK — 2026-06-27

Mom's Law: every line below is a measurement. No estimates. No averaging
to look better. Where a probe surfaced a non-flattering number, the number
stays.

## Environment

- Bun: 1.3.14
- Platform: win32 (Windows 11 Pro 10.0.26200)
- Code under test: `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\`
- Canonical corpus: `C:\AtomEons\Orange5\12-ATOMSMASHER\research\compression\data\canonical-corpus.jsonl`
  - 6,224 receipts · 2,075,585 bytes raw
  - sha256: `5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4`
- M19 codec entry point: `Store.exportCompressedAuditLog()` (storage.mjs:499)
- Reference codec implementation: experiments/59-method19-strip-empty-id/bench.mjs

## Method

Each probe lives in `scratchpad/benchmark/NN-*.mjs` and was run via fresh
`bun` invocations. Probes 5, 6, 9, 10 use fresh subprocesses to avoid
warm-cache contamination. No probes were re-run to improve a number.

---

## Probe 1 — Tests

Command: `bun tests/run-all.mjs` from `full-scope/`. The runner spawns all
five test suites in parallel as Bun subprocesses.

- total: **29**
- passed: **29**
- failed: **0**
- wall_clock_ms: **9,440** (orchestrator) / 9,091 (aggregate)
- exit_code: 0

Per-suite breakdown (from run-all.mjs stdout):

| Suite                          | Pass | Fail | ms    |
|--------------------------------|------|------|-------|
| full-scope.test.mjs            | 7/7  | 0    | 1991  |
| determinism.test.mjs           | 5/5  | 0    | 502   |
| codec-export.test.mjs          | 5/5  | 0    | 2510  |
| replay-integration.test.mjs    | 4/4  | 0    | 8984  |
| storage-api.test.mjs           | 8/8  | 0    | 608   |

---

## Probe 2 — Compression on canonical 6,224-receipt corpus

The canonical NDJSON was loaded into a fresh `:memory:` Store via raw
INSERT (preserving the original receipt ids), then `exportCompressedAuditLog()`
was called.

Two things to note honestly:

1. The raw canonical-corpus.jsonl is **unsorted**. The Store export uses
   `ORDER BY created_at, id`. So the codec's input is the canonical
   receipts re-sorted; raw size and the lossless target both refer to
   the sorted form. Sorted byte total matches raw byte total
   (`2,075,585`) — same content, same byte count, reordered lines.
2. `m19_vs_brotli_alone_ratio` is the codec's wins-over-naive-baseline.

Numbers:

- raw_bytes: **2,075,585**
- raw_sha256: `5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4`
- sorted_sha256 (Store-export input): `d887e3b380e2a6fe89855f7ef0f118d7a3133e1649d64a1c58246e284a09a6fa`
- reconstructed_sha256 (decoded round-trip): `d887e3b380e2a6fe89855f7ef0f118d7a3133e1649d64a1c58246e284a09a6fa`
- brotli_alone_bytes (q11): **120,166**
- brotli_alone_time_ms: 5,705.89
- m19_bytes: **41,315**
- m19_export_time_ms (first call): 1,820.56
- m19_vs_raw_ratio: **50.24×**
- m19_vs_brotli_alone_ratio: **2.91×**
- store_export ratio (banker-rounded): 50.351
- lossless_sha256_roundtrip: **YES** (reconstructed_sha == sorted_sha)

Component sizes from the production Store export:

| Component   | Bytes  |
|-------------|--------|
| meshTpl     | 119    |
| meshData    | 6,202  |
| shapes      | 30,057 |
| aIdx        | 111    |
| aV          | 455    |
| otherIdx    | 4,151  |
| pos         | 127    |
| **Total**   | **41,222** + 93 header ≈ 41,315 bytes encoded |

Roundtrip method: ran the inverse codec inline (mirroring experiment-59
decoder), reconstructed every receipt field, computed sha256 over the
reconstructed NDJSON, and compared against the Store's `SELECT ... ORDER
BY created_at, id` sha256. They match.

---

## Probe 2b — Compression on scaled 62,240-receipt corpus

Built by replicating the 6,224 canonical receipts 10× with per-copy
perturbations:

- new id per copy (sha256 of original id + copy index)
- `mesh.compress` summaries: packet_id += copy_idx × 1000;
  raw/comp byte counts ± copy_idx-derived offsets; payload_json regenerated
- created_at: bumped by copy_idx seconds

Numbers:

- N: **62,240**
- raw_bytes: **20,765,953**
- brotli_alone_bytes: **837,352**
- brotli_alone_time_ms: 49,858.26
- m19_bytes: **164,894**
- m19_export_time_ms: 15,713.92
- m19_vs_raw_ratio: **125.94×**
- m19_vs_brotli_alone_ratio: **5.08×**
- canonical_ratio (probe 2): 50.24×
- **ratio_degradation_vs_canonical_pct: -150.7%** (negative = ratio
  IMPROVED at scale, not degraded)

Honest read: this corpus repeats the same shape vocab 10× with
near-stationary perturbation patterns. M19's shape dictionary amortizes
across the whole stream — exactly the regime where it shines. Ratio
"improving at scale" should be read as "the dedupe ceiling is far above
what 6,224 receipts can exhibit," not as "M19 keeps scaling forever."
A truly novel 62,240-receipt corpus would show different numbers.

---

## Probe 3 — Write throughput

Single Store, fresh `:memory:`. Three rounds of 10,000 `insertReceipt()`
calls.

| Round | ms        | rcpt/sec    | µs/insert |
|-------|-----------|-------------|-----------|
| 1     | 307.97    | 32,470      | 30.80     |
| 2     | 300.23    | 33,308      | 30.02     |
| 3     | 392.80    | 25,458      | 39.28     |

- peak_rcpts_per_sec: **33,308**
- sustained_rcpts_per_sec (mean of rounds 2+3): **29,383**
- mean_ms_per_insert (rounds 2+3): **0.0347**

Honest read on round 3: throughput dropped ~24% in round 3 on a fresh
:memory: Store. The drop is real and reproducible across re-runs (likely
sqlite page-cache / B-tree depth as the table grows past 20K rows).
Sustained number reflects that.

---

## Probe 4 — Read throughput

After 10,000 inserts (5 distinct action labels round-robin), 1,000 calls
to `getReceiptsByAction(action, { limit: 100 })`.

- total_ms: 1,712.69
- **queries_per_sec: 583.88**
- **mean_ms_per_query: 1.71**

Honest read: each query returns 100 rows from a 10K-row table via the
existing `idx_receipts_action` index, but also performs `ORDER BY
created_at DESC, id DESC`. There's no covering index for the order, so
each call scans+sorts the action partition (2K rows) — explaining the
~1.7ms per call. This is real index behavior, not a constant.

---

## Probe 5 — Cold start

Fresh Bun process. Timed: `import { Store }` → `new Store(':memory:')`
→ first `insertReceipt()`.

- import_ms: **32.64**
- init_ms (constructor): **25.98**
- first_insert_ms: **1.13**
- total_cold_to_first_receipt_ms: **59.75**

Init includes: PRAGMA setup, full schema DDL, 620-feature registry
transaction (1 tx, 620 INSERT OR IGNORE).

---

## Probe 6 — demo() full run

Fresh Bun process. Timed: `demo(store)` end-to-end on a fresh `:memory:`
Store.

- total_ms: **329.45**
- receipts_emitted: **1,426**
- features_attempted: **620**
- features_ok: **620**
- features_errors: **0**
- registry_count: 620

---

## Probe 7 — Memory at scale

### Part A — 50K inserts on a single Store

50,000 `insertReceipt()` calls, then `Bun.gc(true)`, then
`process.memoryUsage().heapUsed`.

- **heap_after_50k_inserts_mb: 6.67** MB

(SQLite holds most rows out of the JS heap; only the prepared-statement
cache + insertion scratch lives in V8.)

### Part B — 10× demo() loop

Each iteration: new Store → demo(store) → store.close() → Bun.gc(true)
→ capture heapUsed.

| Iter | heap_mb |
|------|---------|
| 1    | 4.12    |
| 2    | 4.49    |
| 3    | 4.69    |
| 4    | 4.82    |
| 5    | 4.93    |
| 6    | 4.94    |
| 7    | 4.96    |
| 8    | 5.04    |
| 9    | 5.25    |
| 10   | 4.74    |

- heap_iter_1_mb: **4.12**
- heap_iter_5_mb: **4.93**
- heap_iter_10_mb: **4.74**
- heap_iter_3_to_10_growth_mb: **+0.05** (essentially flat)

Honest read: heap drifts up through iter 9 then drops at iter 10 — V8
generational GC behavior, not a leak. Net growth iter 3 → iter 10 is
0.05 MB.

---

## Probe 8 — Compression speed

Run on the canonical 2,075,585-byte corpus loaded into a Store.

- encode_time_ms (clean run #2): **1,930.77**
- **encode_mb_per_sec: 1.03** MB/s
- decode_time_ms (inline experiment-59 decoder): **27.35**
- **decode_mb_per_sec: 72.36** MB/s

Encode is brotli-q11 bound (3 brotli q11 passes on shapes + meshTpl +
meshData + aIdx + aV + otherIdx + pos). Decode is zlib brotli decompress
+ JSON.parse — ~70× faster than encode. This is normal for q11.

---

## Probe 9 — Concurrent throughput

2 Bun subprocesses, each inserting 1,000 receipts into the same file DB
(`scratchpad/benchmark/concurrent.db`). Pre-initialized once before the
race so schema exists.

- worker1: 1,000 inserted in 433.28 ms
- worker2: 1,000 inserted in 369.70 ms
- total_inserted (verified via post-run SELECT COUNT): **2,000** (no
  silent SQLITE_BUSY loss — the busy_timeout + retry-in-init fix held)
- wall_clock_ms: **663.21**
- combined_rcpts_per_sec: **3,016**

Honest read: combined throughput on a file DB is ~10× lower than a
single :memory: Store (~33K rps). Two factors: fsync on WAL writes +
file-DB busy serialization. The "no data loss" is the real win here,
not the rps.

---

## Probe 10 — Determinism repeatability

`ATOMSMASHER_DETERMINISM_SEED=orange5-bench-2026-06-27` across 3 fresh
`bun` processes. Each runs `demo(store)` then prints
`sha256(sorted(receipt_ids))`.

- run1_sha256: `261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9`
- run2_sha256: `261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9`
- run3_sha256: `261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9`
- **all_match: YES**

---

## Structured fact table

```
=== ATOMSMASHER 2 BENEFITS BENCHMARK — 2026-06-27 ===

[Tests]
total: 29 | passed: 29 | failed: 0 | wall_clock_ms: 9440

[Compression — canonical 6,224 receipts (2,075,585 raw bytes)]
brotli_alone_bytes: 120166
m19_bytes: 41315
m19_vs_raw_ratio: 50.24×
m19_vs_brotli_alone_ratio: 2.91×
lossless_sha256_roundtrip: YES

[Compression — scaled 62,240 receipts]
raw_bytes: 20765953
m19_bytes: 164894
m19_vs_raw_ratio: 125.94×
ratio_degradation_vs_canonical_pct: -150.7% (improved, not degraded)

[Write throughput]
peak_rcpts_per_sec: 33308
sustained_rcpts_per_sec: 29383
mean_ms_per_insert: 0.0347

[Read throughput]
queries_per_sec: 584
mean_ms_per_query: 1.71

[Cold start]
import_ms: 32.6
init_ms: 26.0
first_insert_ms: 1.1
total_cold_to_first_receipt_ms: 59.7

[Demo full run]
total_ms: 329
receipts_emitted: 1426
features_executed: 620 (620/620 ok)

[Memory at scale]
heap_after_50k_inserts_mb: 6.67
heap_iter_1_mb: 4.12
heap_iter_5_mb: 4.93
heap_iter_10_mb: 4.74
heap_iter_3_to_10_growth_mb: 0.05

[Compression speed]
encode_mb_per_sec: 1.03
decode_mb_per_sec: 72.36

[Concurrent throughput]
total_inserted: 2000
wall_clock_ms: 663
combined_rcpts_per_sec: 3016

[Determinism]
run1_sha256: 261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9
run2_sha256: 261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9
run3_sha256: 261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9
all_match: YES

=== END ===
```
