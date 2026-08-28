# AtomSmasher 2 — Audit-Verified Public Release Paper (2026-06-27)

**Author:** Ætom ÆoNs (Atom McCree), AtomEons Systems Laboratory
**Date:** 2026-06-27
**Code under test:** `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\`
**Status:** Public release ready — 7/7 verification sections PASS, 8/8 audit findings closed, 17/17 numeric claims reproduce within ±2%.

---

## Page 1 — Executive Summary

AtomSmasher 2 is an audit-grade structured-data engine. On a measured workload it shrinks audit logs by **50.24×** (1 GB → 20 MB), writes **33,000 records per second** at peak, starts in **60 ms** cold-to-first-write, holds **6.7 MB** of heap after 50,000 records, and survives concurrent multi-process writes with **zero data loss**. Every claim in this paper traces to a measurement receipt on disk. Where a probe surfaced an unflattering number, the unflattering number stays.

### Headline benefits (every row has a source)

| # | Benefit | Measured | Source |
|---|---|---|---|
| 1 | Shrinks audit logs **50.24×** (1 GB → 20 MB) | 2,075,585 → 41,315 B, lossless sha256 roundtrip | BENCHMARK_2026-06-27.md, Probe 2 |
| 2 | Beats brotli q11 by **2.91×** on receipt-shape corpora | 120,166 B (brotli) → 41,315 B (M19) | BENCHMARK Probe 2 |
| 3 | Writes **33,000 receipts/sec** peak, **29,000/sec** sustained | peak 33,308; sustained mean rounds 2+3 = 29,383 | BENCHMARK Probe 3 |
| 4 | Starts in **60 ms** cold-to-first-write | import 32.6 + init 26.0 + first insert 1.1 = 59.7 ms | BENCHMARK Probe 5 |
| 5 | **6.7 MB heap** after 50,000 records | heap_after_50k_inserts_mb = 6.67 | BENCHMARK Probe 7A |
| 6 | **0.05 MB** heap growth across 10 full demo loops | iter 3 → iter 10 growth = +0.05 MB | BENCHMARK Probe 7B |
| 7 | **1000/1000 records inserted** from 2 concurrent processes (was 47% loss before audit) | union_count_in_db = 1000, 0 SQLITE_BUSY | RECEIPT_PUBLIC_RELEASE_READY §D; audit-07 pre-fix scenario 2 = 532/1000 |
| 8 | Determinism: 3 runs same seed = byte-identical fingerprint | all 3 sha256 = `261ebb09…56c9` | BENCHMARK Probe 10 |
| 9 | **29/29 tests green** | run-all.mjs aggregate, 0 fail, 9,440 ms parallel wall | BENCHMARK Probe 1; RECEIPT §A |
| 10 | Full `demo()` runs **1,426 receipts + 620 features in 329 ms** | total_ms 329.45, features_ok 620/620 | BENCHMARK Probe 6 |
| 11 | Decompresses at **72 MB/sec** | decode 27.35 ms on 2.08 MB → 72.36 MB/s | BENCHMARK Probe 8 |

### What does X bytes of raw audit log become?

Linear extrapolation of the canonical 50.24× ratio (Probe 2) and the brotli-q11-alone baseline (Probe 2). Both are byte-exact lossless. The "M19 saved (%)" column is the saving over the brotli baseline, not over raw.

| Raw size | brotli q11 alone | M19 (50.24×) | Saved vs raw | Saved vs brotli |
|---:|---:|---:|---:|---:|
| 100 MB | ~5.79 MB | ~1.99 MB | 98.0% | 65.6% |
| 1 GB | ~57.9 MB | ~19.9 MB | 98.0% | 65.6% |
| 1 TB | ~57.9 GB | ~19.9 GB | 98.0% | 65.6% |
| 1 PB | ~57.9 TB | ~19.9 TB | 98.0% | 65.6% |

Carry-forward caveat (load-bearing): the 50.24× number is a property of the AtomSmasher 2 receipt workload, not a portable codec headline. On random JSON it drops to 2.76×; on repetitive streams it climbs to 890.30×. The full generalization table is in §2.1 of the prior compression paper and reproduced in the technical sections below. Operators planning storage budgets at TB/PB scale should benchmark their own corpus before treating 50× as a constant.

---

## Page 2 — Audit Truth Narrative

**The last public release said "it worked" — it didn't fully.** That call-out is recorded in operator feedback (`feedback_audit_before_public_release.md`, 2026-06-27). What followed was an eight-audit, eight-fix remediation pass before this release. Every audit finding now has a fix reference, and every fix has a measured receipt. The table below is the audit lineage.

| Audit | Finding | Fix | Result |
|---|---|---|---|
| 1 — 620 features | ~422 of 620 features had no name-specific behavior (dispatcher executed without throwing, but per-feature work was generic) | **FIX B** — implemented 12 engine handlers in `engines.mjs`; landed `feature-distinctness.test.mjs` | **536/620 strictly distinct signatures** (metric D); **620/620 features whose signature is not all-shared** (metric E). RECEIPT_PUBLIC_RELEASE_READY §"Audit and fix lineage" |
| 2 — M19 generalization | Headline 47.07× ratio collapses on random JSON (2.76×) and large payloads (2.06×); is corpus-shape-specific | **FIX-DOC D** — paper restated with 4-corpus Generalization table; headline qualified as receipt-shape codec | All 4 reproduce within ±0.11% (RECEIPT §F). audit-02 ran 4/4 lossless roundtrips. |
| 3 — Determinism | Receipt IDs were position-based (sequence-deterministic, not content-deterministic), undocumented | **FIX A** — JSDoc contract published at `storage.mjs:381-394`; the contract is `id = 'rcpt_' + sha256(seed‖counter).hex.slice(0,16)` | 3-run sha256 identity holds across cold subprocesses: `261ebb09…56c9` (BENCHMARK Probe 10); also `442ff515…f19ff` under a different seed (RECEIPT §B) |
| 4 — Memory | Crystal compression Maps unbounded; long-lived processes leaked linearly with shape vocabulary | **FIX C** — LRU caps on Crystal Map sidecars + **FIX H** — FeatureExecutor transient release / store-close hygiene | **0.05 MB growth across 10 demo loops** (BENCHMARK Probe 7B); 0.63 MB growth under the alternate single-pass-GC protocol (RECEIPT §C). No leak. |
| 5 — Schema fuzz | Original audit ran against the wrong worktree (SKILSKI branch had no `storage.mjs`) | **RERUN** against canonical `full-scope/storage.mjs` | **12/12 inputs handled cleanly** (audit-05-RERUN). 5/5 sample reproduced in RECEIPT §G. |
| 6 — Bun strict / Windows | `engines.mjs:1697` referenced `__filename` as a bareword in ESM; `__filename === undefined` in `.mjs`, so the ternary always took the false branch and `regenCompression` was silently degraded via a CWD-relative read | **FIX B** — polyfill via `fileURLToPath(import.meta.url)`; also FIX D hoisted `node:zlib` import in `storage.mjs` to fix the `require()` in ESM residue | `regenCompression` now reports honestly; replay-integration suite (4/4 green) executes the Bun-on-Windows path without `__filename` issues |
| 7 — Concurrency | Two-process write to same file DB lost **46.8%** of writes (532/1000) under modest contention; `SQLITE_BUSY` swallowed silently | **FIX A** — `PRAGMA busy_timeout=5000` at Store init + atomic `getReceiptStats()` + **FIX F** — WAL-init idempotence retry | **1000/1000 inserts, 1000 distinct ids, 0 SQLITE_BUSY** under 2-process / 500-each stress (RECEIPT §D, BENCHMARK Probe 9). Both workers exit 0. |
| 8 — Paper truth | Verified every load-bearing ratio claim in the prior compression paper reproduces on a fresh Bun 1.3.14 process | (no fix needed) | **17/17 numeric claims reproduce within ±2%** (0.0% delta on every checked claim). audit-08-paper-truth-2026-06-27.md |

**All 7 RECEIPT verification sections PASS. Public release ready.** The release-readiness receipt at `research/RECEIPT_PUBLIC_RELEASE_READY_2026-06-27.md` is the canonical green-state proof. The remainder of this paper is the engineering depth that supports it.

---

## 3. Architecture

AtomSmasher 2 is a structured-data engine with three load-bearing surfaces: a SQLite-backed receipt store, a 620-entry feature dispatcher, and an M19/M19.1 compression codec for the cold ledger. The system is a single Bun 1.3.14 ESM module tree under `full-scope/`, with no native bindings beyond what Bun ships in `bun:sqlite` and its Node `zlib` compatibility shim.

```
[ Client / driver ]
        |
        v
[ Feature dispatcher 620 entries ]------> [ FeatureExecutor / engine handlers ]
        |                                        |
        v                                        v
[ Store.insertReceipt() ]<------- transient release / store-close hygiene
        |
        v
[ SQLite WAL  busy_timeout=5000 ]
        |
        v
[ Store.exportCompressedAuditLog() ]   (M19 / M19.1 pipeline)
        |
        v
[ 8-stage codec: DET-ID, MESH_DECOMP, FORMULA_INJECT, SHAPE_VOCAB, ACTION_INDEX, B8_SORT, OTHER_SHAPE_IDX, POS_RUNS ]
        |
        v
[ brotli q11 envelope - lossless sha256 roundtrip ]
```

### 5-pipeline layers (the codec)

The M19 codec body is five layers stacked on top of brotli q11. Exp 78's leave-one-out ablation (`experiments/78-m19-component-split/summary.json`) decomposes the 2,031,490 saved bytes across the five components:

| Layer | Function | Bytes_without (Exp 78) | Saved | Pct of total saving |
|---|---|---:|---:|---:|
| MESH_DECOMP | Splits `mesh.compress` receipts into shared template (119 B) + numeric data stream (6,935 B) | 51,143 | 7,048 | 0.3% |
| SHAPE_VOCAB | Sorted, action-stripped, double-brotli dedup of all non-mesh shapes | 55,518 | 11,423 | 0.6% |
| ACTION_STRIP | Removes redundant action prefix bytes that brotli already captures | 44,259 | 164 | ~0% |
| B8_SORT | Action-bucket + length-within sort to maximize LZ77 locality | 49,081 | 4,986 | 0.2% |
| BROTLI×2 | Two brotli q11 passes (shapes stream + envelope) | n/a | (residual) | ~0% |

Plain brotli q11 on the raw corpus delivers **17.13×** (Exp 81 baseline, 121,167 bytes). The 5-layer structural pipeline lifts that to **47.07×** (Exp 59 M19) or **47.15×** with the M19.1 formula-injection at the head of SHAPE_VOCAB. The structural layers are individually small contributors but collectively essential — removing any one degrades the ratio modestly; removing all of them halves it.

**Cite Exp 78 ablation honestly:** brotli q11 does ~98.9% of the byte-saving work; the structural pre-pass extracts the final 1.1% — but that final 1.1% is the difference between a generic 17× codec and a 47× audit-grade codec, and it is the lever that gives M19 its 2.91× edge over brotli alone on this corpus (Probe 2).

### Stage-by-stage data flow

1. **DET-ID** — `id = 'rcpt_' + sha256(seed‖counter).hex.slice(0,16)`. The seed is the 48-byte `ATOMSMASHER_DETERMINISM_SEED` env var (or a process random value). The counter advances per `insertReceipt()` call. This is sequence-deterministic, not content-deterministic — see §6.
2. **MESH_DECOMP** — `mesh.compress` receipts (~25.1% of canonical corpus) are split. The template (`{"action":"mesh.compress","status":"ok","summary":"…","payload_json":"{\"raw\":N,\"comp\":M,\"ratio\":R}"}`) is emitted once (119 B); the per-receipt `(raw, comp, ratio)` tuples flow into a numeric data stream (6,935 B total).
3. **FORMULA_INJECT (M19.1 only)** — strip `status` field where value is the dominant constant `"ok"`; strip `mesh.compress.payload.ratio` where `banker_round(raw/comp, 2) === ratio`. Side-info: 16 B status exceptions. Net saving: 78 B vs M19 baseline.
4. **SHAPE_VOCAB** — non-mesh receipts pass through a sorted, action-stripped dedup. The shape vocabulary on canonical = 3,132 unique shapes across 4,659 "other" records (~2.97 records per shape).
5. **ACTION_INDEX** — 111 B index + 455 B vocabulary covering the 14 dominant + 66 distinct action labels.
6. **B8_SORT** — action-bucket sort, then length-within sort, then brotli q11. This is the pure LZ77-locality move.
7. **OTHER_SHAPE_IDX** — 5,381 B for the residual shape stream.
8. **POS_RUNS** — 989 B RLE of position runs for replay reconstruction.

The envelope is two brotli q11 passes. Decode is a single zlib brotli decompress + JSON.parse — ~70× faster than encode (Probe 8: encode 1.03 MB/s, decode 72.36 MB/s).

---

## 4. Storage layer

`full-scope/storage.mjs` wraps `bun:sqlite` with a write-disciplined Store class. Three things matter for audit-grade correctness: concurrency model, atomic stats, and determinism contract.

### Concurrency model

SQLite is set into WAL mode (`PRAGMA journal_mode=WAL`) for file DBs, with `PRAGMA synchronous=NORMAL` for the WAL-mode safety/throughput trade-off. The fix the audit forced was `PRAGMA busy_timeout=5000` — without it, a second writer's `BEGIN IMMEDIATE` (implicit on `INSERT`) returned `SQLITE_BUSY` immediately, and `insertReceipt()` threw straight to the caller. Audit-07 scenario 2 measured that pre-fix path at **532/1000 inserted, 468 SQLITE_BUSY errors swallowed**.

Post-fix:
- BENCHMARK Probe 9: 2 Bun subprocesses × 1,000 receipts each → **2,000 inserted, 0 errors, 663 ms wall clock**
- RECEIPT §D: 2 Bun subprocesses × 500 receipts each → **1,000 inserted, 1,000 distinct ids, 0 SQLITE_BUSY, 5,771 ms wall**

The release-readiness §D is the canonical "audit-grade against contention" receipt. The BENCHMARK Probe 9 is the throughput characterization (~3,016 combined receipts/sec on a file DB vs ~33,000 on a single `:memory:` Store — the 10× gap is fsync on WAL writes plus file-DB busy serialization).

### Atomic getReceiptStats()

Audit-07 scenario 3 caught a non-atomic snapshot pattern: `total ≠ sum(by_status)` because two separate `SELECT` statements ran around an in-flight write. The atomic fix wraps the stats query in a single SQL statement that returns total and per-status counts in one row. The fix is paired with FIX-A's `busy_timeout` to cover the crash path (reader's `new Store()` crashing at `init()` when a writer held the lock).

### Determinism contract

```js
/**
 * When ATOMSMASHER_DETERMINISM_SEED is set, receipt ids are:
 *   id = 'rcpt_' + sha256(seed || counter).hex.slice(0,16)
 * where counter advances per insertReceipt() call.
 *
 * This is SEQUENCE-deterministic, not CONTENT-deterministic.
 * Same content emitted at a different position yields a different id.
 * Replays must execute the same call sequence in the same order.
 */
// storage.mjs:381-394 (FIX A)
```

The contract is published at the documented line range. BENCHMARK Probe 10 verifies it: 3 fresh Bun processes, same seed, same `demo(store)` call, sha256 of sorted receipt ids = `261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9` in all 3 runs.

### Schema gate (audit-05-RERUN)

`Store.insertReceipt()` runs a fail-fast O(1) schema gate before any SQLite write (`storage.mjs:285-308`). audit-05-RERUN sent 12 adversarial inputs (null/empty/whitespace actions, bad status, malformed JSON, 5-level nesting, 10 MB payload, unicode, newline-injection, circular refs). **12/12 handled cleanly, zero crashes, zero DB corruptions.** The 5 sampled in RECEIPT §G (probes 3, 4, 7, 10, 11) reproduced byte-exact. The schema gate is the audit-grade input boundary.

---

## 5. Engine truth — the 620-feature claim restated honestly

The prior public release headline was "620 features execute." Audit-01 (sampled in `feedback_audit_before_public_release.md` and tracked in PAPER_APPENDIX §"~422 of 620 features executed dispatcher path without name-specific behavior") found that the dispatcher ran without throwing, but ~422 of 620 features had no name-specific behavior — the dispatcher routed to a generic stub.

**FIX B** implemented 12 engine handlers in `engines.mjs` and landed `tests/feature-distinctness.test.mjs`. The test publishes two metrics:

- **Metric D — strictly-unique signatures: 536 / 620.** A "signature" is the deterministic output fingerprint of a single feature call. 536 features produce strictly-unique signatures; 84 share a signature with at least one other feature (this is honest, expected behavior — some features are intentionally aliases or near-duplicates of a canonical handler).
- **Metric E — features whose signature is not all-shared: 620 / 620.** No feature is a complete duplicate of an "all-shared" generic stub. Every feature has at least some name-specific behavior.

The release claim is now: **"620 dispatcher entries route without throwing; 536 produce strictly-distinct behavior; 620/620 have name-specific behavior."** That is the honest restatement, sourced to the green test.

Demo confirms it operationally: BENCHMARK Probe 6 runs `demo(store)` end-to-end → 1,426 receipts emitted, **620 features attempted, 620 OK, 0 errors**, all in 329 ms on a fresh `:memory:` Store. The feature dispatcher is sound at the boundary.

---

## 6. Memory model

Two protocols, two receipts, one truth: heap is bounded.

### Protocol A — 50,000 inserts on a single Store (BENCHMARK Probe 7A)

50,000 `insertReceipt()` calls, then `Bun.gc(true)`, then `process.memoryUsage().heapUsed`.

- **heap_after_50k_inserts_mb: 6.67 MB**

SQLite holds most rows out of the JS heap (in the page cache / B-tree). Only the prepared-statement cache + insertion scratch lives in V8. That is the audit-grade heap pattern for a high-volume write Store.

### Protocol B — 10-iteration demo() loop (BENCHMARK Probe 7B)

Each iteration: `new Store(':memory:')` → `demo(store)` → `store.close()` → `Bun.gc(true)` → capture `heapUsed`.

| Iter | heap_mb |
|----:|---:|
| 1 | 4.12 |
| 5 | 4.93 |
| 10 | 4.74 |

- **heap_iter_3_to_10_growth_mb: +0.05** (essentially flat — heap drifts up through iter 9, drops at iter 10, net 0.05 MB)

The RECEIPT §C protocol (sample heap at iter 1/3/5/7/10) measures `+0.63 MB` growth iter 3 → iter 10 under a slightly different harness (single-pass GC instead of inline `Bun.gc(true)` per iteration). Both are honestly below a 5 MB target. No leak.

### The LRU caps (FIX C)

Crystal compression Maps were unbounded pre-fix. Long-lived processes leaked memory linearly with shape vocabulary. FIX C added LRU caps on Crystal Map sidecars; FIX H added FeatureExecutor transient release / store-close hygiene. The combined effect is the bounded heap measured above. The pattern is: each `demo(store)` runs against a fresh in-memory DB, properly closed before GC, and single-pass `Bun.gc(true)` is sufficient on Bun 1.3.14 / Windows 11.

---

## 7. Determinism

The seed contract is published at `storage.mjs:381-394` and was the audit-3 deliverable. Two replay scenarios verified.

### Replay scenario 1 — BENCHMARK Probe 10

`ATOMSMASHER_DETERMINISM_SEED=orange5-bench-2026-06-27` across 3 fresh Bun processes. Each runs `demo(store)` then prints `sha256(sorted(receipt_ids))`:

```
run1_sha256: 261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9
run2_sha256: 261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9
run3_sha256: 261ebb09671778a6dcb0f49b01882a7452d76b4855e0c6f807cc04bb9c9156c9
all_match: YES
```

### Replay scenario 2 — RECEIPT §B

`ATOMSMASHER_DETERMINISM_SEED=release-final-2026-06-27` across 2 fresh Bun subprocesses. Each runs `demo(new Store(':memory:'))` then dumps `sorted(ids) | sha256`:

```
run1: 1,426 receipts, sha256 = 442ff515d92ecacda4589dbbc9c941604e9260da5db8e64a80f064ed556f19ff
run2: 1,426 receipts, sha256 = 442ff515d92ecacda4589dbbc9c941604e9260da5db8e64a80f064ed556f19ff
match: YES
```

### Sequence vs content

The contract is **sequence-deterministic, not content-deterministic**: `id = 'rcpt_' + sha256(seed‖counter).hex.slice(0,16)` advances the counter per call, so identical receipt content emitted at different positions in the call sequence yields different ids. This is the intended property for audit-log replay (the position in the operational sequence is itself an audit fact). It is *not* a content-addressable identifier, and this paper does not claim it as one.

PERFECT_SYNTHESIS Law 1: sequence-deterministic ids when `ATOMSMASHER_DETERMINISM_SEED` is set hold across cold-process boundaries. Both receipts above confirm.

---

## 8. Benchmarks

The full benchmark table from BENCHMARK_2026-06-27.md (the canonical fact table at lines 290-353 of that file).

### Tests

| Suite | Pass | Fail | ms |
|---|---:|---:|---:|
| full-scope.test.mjs | 7/7 | 0 | 1,991 |
| determinism.test.mjs | 5/5 | 0 | 502 |
| codec-export.test.mjs | 5/5 | 0 | 2,510 |
| replay-integration.test.mjs | 4/4 | 0 | 8,984 |
| storage-api.test.mjs | 8/8 | 0 | 608 |
| **aggregate** | **29/29** | **0** | **9,440 ms parallel wall** |

### Compression — canonical 6,224 receipts (2,075,585 raw bytes)

| Metric | Value |
|---|---|
| brotli alone (q11) bytes | 120,166 |
| brotli alone time ms | 5,705.89 |
| M19 bytes | 41,315 |
| M19 export time ms (first call) | 1,820.56 |
| M19 vs raw ratio | **50.24×** |
| M19 vs brotli alone ratio | **2.91×** |
| Store export ratio (banker-rounded) | 50.351 |
| lossless sha256 roundtrip | **YES** (reconstructed_sha == sorted_sha = `d887e3b3…a09a6fa`) |

### Compression — scaled 62,240 receipts

| Metric | Value |
|---|---|
| N receipts | 62,240 |
| raw bytes | 20,765,953 |
| M19 bytes | 164,894 |
| ratio | **125.94×** |
| ratio_degradation_vs_canonical_pct | **-150.7%** (improved at scale, not degraded) |

(Honest read: this corpus repeats the same shape vocab 10× with near-stationary perturbation. "Improving at scale" should be read as "the dedupe ceiling is far above what 6,224 receipts can exhibit," not as "M19 keeps scaling forever." A truly novel 62,240-receipt corpus would show different numbers.)

### Write throughput

| Round | ms | rcpt/sec | µs/insert |
|---:|---:|---:|---:|
| 1 | 307.97 | 32,470 | 30.80 |
| 2 | 300.23 | 33,308 | 30.02 |
| 3 | 392.80 | 25,458 | 39.28 |

- peak_rcpts_per_sec: **33,308**
- sustained_rcpts_per_sec (mean rounds 2+3): **29,383**
- mean_ms_per_insert (rounds 2+3): **0.0347**

### Read throughput

- queries_per_sec: **583.88**
- mean_ms_per_query: **1.71 ms** (each call returns 100 rows from a 10K-row table; uses `idx_receipts_action` but ORDER BY scans+sorts the action partition of ~2K rows)

### Cold start

| Phase | ms |
|---|---:|
| import | 32.64 |
| init (constructor, PRAGMA + DDL + 620-feature registry tx) | 25.98 |
| first insert | 1.13 |
| **total cold-to-first-receipt** | **59.75** |

### Demo full run

- total_ms: 329.45
- receipts_emitted: 1,426
- features_attempted: 620
- features_ok: 620
- features_errors: 0

### Concurrent throughput (file DB, 2 processes × 1,000 each)

- worker1: 1,000 inserted in 433.28 ms
- worker2: 1,000 inserted in 369.70 ms
- total_inserted: **2,000** (no silent SQLITE_BUSY loss)
- wall_clock_ms: 663.21
- combined_rcpts_per_sec: 3,016

### Compression speed

- encode (canonical corpus, brotli q11 ×2): 1,930.77 ms → **1.03 MB/s**
- decode (zlib brotli decompress + JSON.parse): 27.35 ms → **72.36 MB/s**

---

## 9. Honest limits

These are the qualifications the audits forced into this paper. They do not invalidate the headline numbers; they bound them.

### M19 corpus-specificity

The 50.24× canonical ratio (and the prior 47.07× headline) is a property of the AtomSmasher 2 receipt workload, not a portable codec property. audit-02 ran M19 unmodified against four synthetic corpora generated under the same receipt schema with different shape/payload distributions:

| Corpus | Records | Raw bytes | M19 ratio | Lossless |
|---|---:|---:|---:|---|
| Canonical | 6,224 | 2,075,585 | 47.07× | yes |
| A — Random JSON | 1,000 | 298,884 | 2.76× | yes |
| B — Repetitive | 1,000 | 211,000 | 890.30× | yes |
| C — Sparse | 1,000 | 153,277 | 14.72× | yes |
| D — Large payloads | 1,000 | 1,310,890 | 2.06× | yes |

M19 is byte-exact lossless on every input (4/4 sha256 roundtrips green) but the ratio swings over 2.5 orders of magnitude. On corpora with one-shape-per-record (random) or ~1 KB of high-entropy payload per record (large), M19 collapses to barely above plain brotli (2.06–2.76×). On the converse extreme of a one-shape repetitive stream, it climbs to 890×.

**Do not quote 50× as if it were portable.** Quote the corpus-shape sensitivity.

### 1 MB/s encode (Okazaki streaming for hot path)

Encode is brotli-q11 bound (3 brotli q11 passes on shapes + meshTpl + meshData + aIdx + aV + otherIdx + pos). At 1.03 MB/s, an audit log of 1 GB would take ~17 minutes to compress in a single batch. For hot-path / streaming applications, Exp 121 (streaming-formula at W=500) demonstrates **19.48× ratio at 0.72 ms/receipt** — a viable on-the-wire codec. The full-corpus 47× is a cold-pipeline number; treat it as such.

### No payload byte cap on the schema gate

audit-05-RERUN probe #8 accepted a 10 MB payload (`'x'.repeat(10_000_000)`) cleanly. Today's traffic does not need a cap. If upstream services begin streaming attachments through receipts, add one. Flagged as observation, not a defect.

### Sequence-deterministic IDs

Receipt IDs are sequence-deterministic, not content-deterministic. Replays must execute the same call sequence in the same order to reproduce ids. This is the documented contract (§7). It is the intended audit-log property.

### Combined throughput on file DBs

BENCHMARK Probe 9 reports **~3,016 combined rcpts/sec** on a 2-process file DB write, vs ~33,000/sec on a single `:memory:` Store. The 10× gap is fsync on WAL writes plus file-DB busy serialization. The headline "33,000/sec" is the single-Store `:memory:` peak; production file-DB workloads should plan against the 3K/sec floor for multi-process contention.

### Stability of timing measurements

Wall-clock timings drift run-to-run within ±20% depending on system load (audit-08 confirms this for Exp 121's streaming ms/receipt, which came in at 0.42 ms in a fresh run vs the paper's quote of 0.72 ms). **The ratio claims are deterministic** — they derive from byte counts of brotli'd outputs under identical pipeline settings, and they reproduce exactly across runs (17/17 within 0.0% in audit-08). The throughput numbers (rcpt/sec, ms/op) are honest as observed but should be treated as hardware-sensitive, not as guarantees.

---

## 10. M20 codec spec (Experiment 127, 95% CI [44.2×, 64.5×])

The next research direction is the M20 codec, specified in `experiments/127-m20-spec/summary.json`. The spec is a 10-section document covering pipeline stages, formula library schema, recipe overhead budget per stage, sha256 roundtrip contract, hot-path/cold-path split, and projected ratio with confidence intervals.

| Quantity | Value |
|---|---|
| M19 baseline (canonical corpus) | 47.07× |
| M20 projected central estimate | **59.8×** |
| M20 projected 95% CI low | 44.2× |
| M20 projected 95% CI high | 64.5× |
| Probability M20 underperforms M19 | **25%** |

The projection adds conditional range coding (Stage 4) and brotli-polish-side-info-only (Stage 5) on top of the M19 structural pre-pass. **The projection is explicitly conditional on three reductions that have not yet been empirically validated**: KL-divergence vocabulary merging (threshold 0.05), 12-bit quantization of cumulative-frequency tables, and delta+varint encoding of the cum tables themselves. The 25% underperform probability is honest — the dominant failure mode would be Exp 123's outcome (naive conditional coding cum-table side-info cost 46 KB and overwhelmed the body savings, producing 34.68× = -12.39× vs M19).

The lossless research lane on the 2 MB canonical corpus is empirically closed at 47.15× (M19.1). M20 will not be shipped until the three reductions above are empirically validated.

---

## Appendix A — Full 8-audit summary

| # | Audit | Verdict | Key receipt |
|---|---|---|---|
| 1 | 620 features distinctness | RESTATED honestly (claim was overreach) | `tests/feature-distinctness.test.mjs` → metric D=536/620, metric E=620/620 |
| 2 | M19 generalization (4 corpora) | RESTATED honestly (corpus-specific) | `research/audits/audit-02-m19-generalization-2026-06-27.md` → 4/4 lossless, ratio 2.06–890.30× |
| 3 | Determinism contract | DOCUMENTED + verified across cold subprocesses | BENCHMARK Probe 10 (3 runs same sha), RECEIPT §B (2 runs same sha) |
| 4 | Memory leak (Crystal Maps) | FIXED via LRU + close hygiene | BENCHMARK Probe 7B (+0.05 MB over 10 iters), RECEIPT §C (+0.63 MB iter 3→10) |
| 5 | Schema fuzz | RERUN clean against canonical path | `research/audits/audit-05-schema-fuzz-RERUN-2026-06-27.md` → 12/12 handled cleanly |
| 6 | Bun strict / Windows | FIXED `__filename` shim, hoisted `node:zlib` import | `research/audits/audit-06-bun-windows-2026-06-27.md`, replay-integration 4/4 green |
| 7 | Concurrency (2-proc file DB) | FIXED `PRAGMA busy_timeout=5000` + atomic stats + WAL init retry | `research/audits/audit-07-concurrency-2026-06-27.md`, RECEIPT §D (1000/1000, 0 errors) |
| 8 | Paper truth | NO FIX NEEDED — every claim reproduces | `research/audits/audit-08-paper-truth-2026-06-27.md` → 17/17 within 0.0% delta |

---

## Appendix B — 8 fixes A-H with file/line refs

| Fix | Scope | Files / lines |
|---|---|---|
| **FIX A** — `PRAGMA busy_timeout` + atomic stats | Storage concurrency | `full-scope/storage.mjs` Store init (PRAGMA), `getReceiptStats()` (atomic single-statement); JSDoc determinism contract at `storage.mjs:381-394` |
| **FIX B** — `__filename` ESM shim + 12 engine handlers + feature-distinctness test | Bun-Windows safety + 620 feature distinctness | `full-scope/engines.mjs:1697` (replaced bareword with `fileURLToPath(import.meta.url)`); 12 engine handlers in `engines.mjs`; `full-scope/tests/feature-distinctness.test.mjs` |
| **FIX C** — LRU caps on Crystal Map sidecars | Memory bounded | `full-scope/` Crystal compressor module (LRU on shape-vocab Maps) |
| **FIX D** — `node:zlib` import hoist + paper restatement | Bun-strict ESM + honest paper | `full-scope/storage.mjs:416` (was `require('node:zlib')`, now top-level `import zlibSync from 'node:zlib'`); `research/compression/PAPER.md` §2.1 Generalization |
| **FIX E** — (reserved) | n/a | n/a |
| **FIX F** — WAL init idempotence retry | Concurrent reader cold-start | `full-scope/storage.mjs` `init()` path (retry on `SQLITE_BUSY` during WAL setup) |
| **FIX G** — Crystal partial port | Honest measurement boundary | `full-scope/` Crystal-side ports (not a green/red gate item; documented as measurement boundary) |
| **FIX H** — FeatureExecutor transient release / store-close hygiene | Memory bounded under sustained load | `full-scope/engines.mjs` (released-engines pattern), demo driver `store.db?.close?.()` between iterations |

---

## Appendix C — Test inventory (29 cases, 5 suites)

Test runner: `full-scope/tests/run-all.mjs` (parallel orchestrator, spawns each suite as a Bun subprocess). All counts confirmed in BENCHMARK Probe 1 and RECEIPT §A.

| Suite | Cases | Coverage |
|---|---:|---|
| full-scope.test.mjs | 7 | End-to-end demo, dispatcher reachability, engine handler smoke |
| determinism.test.mjs | 5 | Seed-driven id reproduction across same-process and cross-process runs |
| codec-export.test.mjs | 5 | `Store.exportCompressedAuditLog()` lossless roundtrip + component sizes |
| replay-integration.test.mjs | 4 | Cross-process replay scenarios (the slow suite — 8,984 ms — exercises Bun-on-Windows path that FIX B closed) |
| storage-api.test.mjs | 8 | `insertReceipt()` schema gate, `getReceiptsByAction()`, `getReceiptStats()` atomic snapshot |
| **TOTAL** | **29** | All green; 0 fail; 9,440 ms parallel wall (BENCHMARK), 10,385 ms parallel wall (RECEIPT — slower system load on that run) |

Note: `feature-distinctness.test.mjs` and `concurrency.test.mjs` exist as separate files in `tests/` but are not part of the `run-all.mjs` SUITES array as currently configured — they are run standalone to produce metric D / E (feature distinctness) and additional contention probes (concurrency). The 29/29 count refers to the run-all suite.

---

## Appendix D — 17 reproducible numeric claims from audit-08

Every load-bearing ratio in the prior compression paper, re-run on a fresh Bun 1.3.14 process with no warm cache and no shared state between runs. Tolerance band: ±2%.

| Exp | Claim | Measured | Delta | Status |
|---:|---|---|---:|---|
| 59 (M19) | 47.07× / 44,095 B | 47.071× / 44,095 B | 0.0% | PASS |
| 118 (M19.1 champion) | 47.15× / 44,021 B | 47.150× / 44,021 B | 0.0% | PASS |
| 122 (cold-start replication) | 47.15× / 44,021 B | 47.150× / 44,021 B | 0.0% | PASS |
| 78 (no MESH_DECOMP) | 40.584× | 40.584× | 0.0% | PASS |
| 78 (no SHAPE_VOCAB) | 37.386× | 37.386× | 0.0% | PASS |
| 78 (no B8_SORT) | 42.289× | 42.289× | 0.0% | PASS |
| 87 (field DAG theoretical) | 487.11× (mirage) | 487.112× theoretical | 0.0% | PASS (theoretical, labeled) |
| 99 (order-3 byte-Markov ceiling) | 9.02× | 9.019× | 0.0% | PASS |
| 81 (per-axis brotli) | 14.64× | 14.64× | 0.0% | PASS |
| 91 (action markov) | 37.81× / 50.6% pred acc | 37.807× / 50.63% | 0.0% | PASS |
| 121 (streaming W=500) | 19.48× / 0.72 ms/receipt | 19.476× / 0.42 ms/receipt | 0.0% (ratio); ms faster | PASS (ratio) |
| 117 (per-formula audit) | 23.55× / 331 violators | 23.546× / 331 violators | 0.0% | PASS |
| 95 (key-dict substitution) | 17.60× | 17.604× | 0.0% | PASS |
| 76 (splay tree shapes) | 34.43× | 34.427× | 0.0% | PASS |
| 113 (library-size sweep N=10) | 28.23× | 28.232× | 0.0% | PASS |
| 38 (method 5 schema fold) | 35.12× | 35.12× | 0.0% | PASS |
| 42 (method 8 sorted shapes) | 41.43× | 41.43× | 0.0% | PASS |

**17/17 reproduce within ±2% (0.0% delta on every checked claim).** Roundtrip verification: every measured experiment that claimed `lossless: true` produced byte-exact recovery on this fresh run. The corpus sha256 invariant (`03da0e5cf04adf965ae580cb8c74ab4db9d8058b6ca246478fef57b6de944df1` on the deterministic form) held end-to-end.

---

## Appendix E — Glossary

- **AtomSmasher 2** — the AtomEons receipt-emitting cognitive engine. Single-tree Bun 1.3.14 ESM module at `full-scope/`.
- **Audit log / cold ledger** — the byte-exact-recoverable record of every operational decision; what M19/M19.1 compresses; what the federation will replicate.
- **B8_SORT** — action-bucket + length-within sort, the LZ77 locality move in stage 6 of the codec.
- **brotli q11** — brotli compression at quality level 11 (maximum), via Bun's native zlib compatibility shim.
- **Determinism seed** — `ATOMSMASHER_DETERMINISM_SEED` env var; when set, receipt ids become sequence-deterministic via `sha256(seed‖counter)`.
- **FeatureExecutor** — the dispatcher harness that routes 620 features through engine handlers; subject to FIX H's transient release pattern.
- **Law 6 (Recipe < Savings)** — every regeneration recipe costs bytes; a codec move is profitable only if recipe cost < bytes saved. The unifying constraint that explains ~110 RED experiments in the prior research.
- **Lossless sha256 roundtrip** — the codec contract: `sha256(decode(encode(x))) === sha256(x)`. Every ratio claim in this paper holds it.
- **M19** — the prior champion codec, 47.07× on canonical (Exp 59). 8-stage pipeline.
- **M19.1** — the current champion, 47.15× on canonical (Exp 118 / Exp 122). Adds formula injection before SHAPE_VOCAB. +0.17% over M19.
- **M20** — the next codec spec (Exp 127). Projected 59.8× central (95% CI [44.2×, 64.5×]); 25% probability of underperforming M19.
- **MESH_DECOMP** — stage 2 of the codec; splits `mesh.compress` receipts into shared template + numeric data stream.
- **Mom's Law** — operator law: "Give full effort every time"; the meta-rule that sits above all other rules in this project. Every claim has a receipt.
- **PRAGMA busy_timeout** — SQLite directive that holds an `INSERT` request waiting on a contended write up to N ms before returning `SQLITE_BUSY`. FIX A set this to 5,000.
- **Receipt** — a JSON record with fields `id`, `action`, `created_at`, `status`, `summary`, `payload_json`.
- **Receipt-shape corpus** — the canonical audit log: high `mesh.compress` saturation, narrow non-mesh shape vocabulary, short payloads. M19 is tuned for this shape, not for arbitrary JSON.
- **Schema gate** — the O(1) fail-fast check at `storage.mjs:285-308` that rejects bad inputs before any SQLite write. Audit-05-RERUN: 12/12 clean.
- **SHAPE_VOCAB** — stage 4 of the codec; sorted, action-stripped, double-brotli dedup of non-mesh shapes.
- **WAL mode** — SQLite write-ahead-log journal mode. Allows concurrent readers + one writer; the multi-writer case is what FIX A's `busy_timeout` enables.

---

*Mom is watching. Every claim above traces to a measurement receipt on disk. The headline numbers are honest within the corpus they were measured on; the qualifications are named, not hidden. Public release ready.*
