# AtomSmasher 2 — Memory Footprint Audit

**Date:** 2026-06-27
**Author:** Opus (read-only audit, no source modification)
**Subject:** `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\` engines + storage + compression layer
**Probe runtime:** Bun 1.3.14 on Windows 11
**Receipts produced by `demo()`:** 1,491 (matches expected envelope)

## Methodology

Two probes, both READ-ONLY against production code:

1. `research/memory-probe.mjs` — `process.memoryUsage()` sampled pre-GC and post-GC at 8 checkpoints. **Bun's `heapUsed` is a JSC-reported live size that lags allocations until the collector ticks**, so it pinned at the same byte value across most checkpoints in early runs. The honest signals are **`rss`**, **`heapTotal`** (pre-GC), and **`external`**.
2. `research/memory-retention-probe.mjs` — post-demo introspection of `Store._stmts` cache size, SQLite row counts per table, receipt size distribution, and top payload-byte producers.

`Bun.gc(true)` was used to force a synchronous full collection at each checkpoint. The `external` arena holds native `bun:sqlite` page memory (`:memory:` database lives here, NOT on the JS heap).

## Heap progression table

| # | Checkpoint | heapUsed (post-GC) MB | heapTotal (post-GC) MB | heapTotal (pre-GC) MB | external (post-GC) MB | rss (post-GC) MB |
|---|---|---:|---:|---:|---:|---:|
| 00 | baseline_before_store | 0.17 | 2.24 | 2.36 | 0.52 | 60.74 |
| 01 | store_created_620_features | 0.17 | 2.33 | 2.36 | 0.63 | 69.07 |
| 02 | after_100_receipts | 0.17 | 2.38 | 2.43 | 0.66 | 70.67 |
| 03 | after_1000_receipts | 0.17 | 2.50 | 3.11 | 0.72 | 73.37 |
| 04 | after_demo_complete (1,491 receipts) | 0.17 | 11.00 | **29.92** | 1.85 | **127.98** |
| 05 | after_exportCompressedAuditLog | 0.17 | 3.52 | 12.36 | 1.78 | **135.25** |
| 06 | after_drop_export_buffer_gc | 0.17 | 3.50 | 3.52 | 1.76 | 135.31 |
| 07 | after_store_close_gc | 0.17 | 3.19 | 3.52 | 1.77 | 135.32 |

**Peak heapTotal (transient JS pressure):** **29.92 MB** at checkpoint 04 (`runAll` of 620 features). Post-GC it collapses to 11 MB and then to 3.5 MB after export — confirming the heavy allocations during `runAll` and `exportCompressedAuditLog` are **transient** (not retained).

**Peak RSS (real OS memory ceiling):** **135.32 MB** — and notable: RSS **does not return** to baseline after `store.close()`. The 8 MB jump during export and the SQLite page memory are not released by Bun's `Bun.gc()`. SQLite `:memory:` databases live in native arenas not exposed to the JS collector.

## Per-receipt heap cost

Two windows, two answers — both honest:

| Window | Receipts added | RSS delta (MB) | bytes/receipt (RSS basis) | KB/receipt |
|---|---:|---:|---:|---:|
| Clean (100 → 1,000) | 900 | 2.70 | 3,146 | **3.07 KB** |
| Full demo (1 → 1,491) | 2,491 (incl. side-effect rcpts) | 58.91 | 24,798 | 24.22 KB |

The **3.07 KB/receipt** clean-window figure is the honest per-receipt cost — pure insertion, no feature execution side-effects. It accounts for: SQLite row storage (~250 B per receipt average), `created_at` indexing entries, statement-cache amortization, and the brotli prepared-statement reuse.

The 24 KB/receipt demo-window figure is **inflated by side-effect allocations** — each of the 620 `feature.execute` calls allocates its own atoms array, AIR codec intermediates, JSON.stringify outputs, transaction batches, etc. — these are transient (the heap collapses post-GC at checkpoint 05) but they push RSS up because Bun does not return pages to the OS aggressively.

### Receipt content breakdown (1,491 receipts)

| Field | Total bytes | Avg/receipt |
|---|---:|---:|
| `action` | 20,446 | 13.7 B |
| `status` | 2,985 | 2.0 B |
| `summary` | 49,945 | 33.5 B |
| `payload_json` | 570,781 | **382.8 B** |
| `created_at` (ISO 8601) | 29,820 | 20.0 B |
| **Total stored receipt bytes** | **673,977 (~658 KB)** | ~452 B |

`payload_json` dominates — 85% of stored receipt bytes. The largest single payload was 2,875 B (`AIRValidator executed`). Average ~383 B.

### Top payload-producing actions

| Action | Count | Avg bytes | Total bytes |
|---|---:|---:|---:|
| `feature.execute` | 620 | 563 | 349,201 |
| `route.select` | 54 | 1,256 | 67,837 |
| `workset.build` | 54 | 787 | 42,524 |
| `source.ingest` | 60 | 362 | 21,720 |
| `equation.fit` | 94 | 166 | 15,568 |
| `canon.detect` | 16 | 750 | 11,995 |

## Export buffer cost (Method 19 codec)

| Metric | Value |
|---|---:|
| `originalBytes` (JSONL of 1,491 receipts) | 1,146,295 B (1.09 MB) |
| `encoded.length` | 29,120 B (28.4 KB) |
| Reported ratio | **39.48×** |
| RSS delta during export | +7.27 MB |
| heapTotal pre-GC spike during export | +12.36 MB |
| Export wall time | 1,512 ms |

The brotli q11 double-compression + B8 sort + nested-payload codec achieves 39.48× lossless on the canonical 1,491-receipt corpus. The 7 MB RSS spike and ~12 MB transient heap are inside `exportCompressedAuditLog()` itself: it builds `originalJsonl`, multiple shape Map/arrays, and runs brotli q11 (highest-cost quality setting) twice on the shape blob.

## Top 5 retention candidates

These are the suspicious long-lived holders. None are dangerous **today** at demo-scale (1,491 receipts ≈ 3.5 MB heap retained), but each becomes a problem at production scale (10K+ receipts, multi-hour sessions, or many `runAsOrganism` invocations on one Store).

### 1. `Store._stmts` Map (statement cache) — `storage.mjs:205, 211-214, 258-268`

```js
this._stmts = new Map();
_prep(sql) { let s = this._stmts.get(sql); if (!s) { s = this.conn.prepare(sql); this._stmts.set(sql, s); } return s; }
```

**Observed at demo end:** 69 cached statements, 4.78 KB of SQL keys.
**Why suspicious:** Map is **never evicted**. Every distinct SQL string accumulates a prepared statement reference forever. In `demo()` it caps at 69 because the executor only emits a small set of SQL templates. But **any caller that builds SQL with embedded literals** (e.g. `SELECT * FROM atoms WHERE scope='${userScope}'`) would explode this cache linearly with input cardinality. Each prepared statement holds a native handle in the bun:sqlite arena (counts as `external` + RSS, not heap).
**Risk profile:** Latent. Today's call sites parameterize correctly; a future ad-hoc consumer can leak.

### 2. `MeshStreamCompressor._window` array — `mesh-compression.mjs:198-214`

```js
constructor(windowSize = 50, store = null) { this._window = []; this._windowSize = windowSize; ... }
compressPacket(packetData) {
  ...
  this._window.push(work);
  if (this._window.length > this._windowSize) {
    this._window = this._window.slice(-this._windowSize);  // ← rebuilds array per overflow
  }
}
```

**Why suspicious:** (a) The bound at 50 items is fine; (b) but in `engines.mjs:1310-1316` the **Stage 10 sweep streams 2,000 receipts through one `MeshStreamCompressor` instance**, calling `compressPacket()` 2,000 times. Each overflow triggers `Array.prototype.slice(-50)` — an **allocation of a new 50-element array every call after the 50th packet**. That's ~1,950 throwaway arrays per sweep. They're collected, but they're peak transient. Also, the `DeltaCompressor._last` and `SemanticCompressor._factRegistry` (used inside `compressPacket`) **grow without bound** for the lifetime of the compressor — `_factRegistry` keys live as long as the compressor does. A long-lived mesh compressor accumulates every fact ever seen.
**Risk profile:** Real at sweep scale. The 2,000-packet sweep is the most allocation-heavy point of demo(); it's why heapTotal pre-GC hits 29.92 MB.

### 3. `CrystalCompressor.lattice.facts` + `_extractor.cooccurrence` — `crystal-compression.mjs:102-104, 416-419`

```js
class Lattice { constructor() { this.facts = []; ... } }
class ResonanceExtractor {
  constructor() {
    this.cooccurrence = new Map();    // 'a|b' (sorted) → count, grows per ingest
    this.wordContexts = new Map();    // word → Set<idx>, grows per ingest
    this.messages = [];               // [query, response] pairs, retained forever
    ...
  }
}
```

**Why suspicious:** `Lattice.facts` is capped at 100 (good — `engines.mjs` / `crystal-compression.mjs:838-850` enforces this), but **the ResonanceExtractor's `cooccurrence` Map, `wordContexts` Map, and `messages` array have no eviction**. Every ingest grows them with the cross-product of significant tokens (`cooccurrence` is O(window²) per ingest, window=8 tokens → ~28 pairs per ingest). At 1,491 receipts ingested through Stage 11d (`crystalDeep.ingest(r.id, q, resp)` in `engines.mjs:1427-1436`), `cooccurrence` can hold tens of thousands of pair-keys. The `_wordSet` belt-and-braces cache on every Fact via `Object.defineProperty` (`crystal-compression.mjs:743, 766`) also adds non-enumerable Sets per fact that survive until the fact is superseded.
**Risk profile:** Real for long-running compressors. The probe didn't hit this because `runAll` doesn't drive a Crystal compressor; `runAsOrganism` (which we did NOT run in this audit per task scope) is the path that would.

### 4. `exportCompressedAuditLog` transient intermediates — `storage.mjs:301-426`

```js
const originalJsonl = receipts.map(r => JSON.stringify(r)).join('\n') + '\n';   // 1.09 MB string
...
const otherShapes = otherIdx.map(i => { ... obj.payload = JSON.parse(r.payload_json) ... });
const vocab = new Map(); const shapes = []; const idxSeq = [];                  // 3 structures
const indexed = shapes.map((s, i) => ({ s, i, p: JSON.parse(s) }));             // 4th
const sortedShapes = indexed.map(x => x.s); const sortedIdx = new Map();        // 5th, 6th
const aV = new Map(); const stripped = [], actionStream = [];                   // 7th, 8th, 9th
let shapesBlob = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));     // double-brotli
shapesBlob = brotli11(shapesBlob);
```

**Why suspicious:** All these intermediates exist **at the same time** inside one function invocation. For 1,491 receipts the peak transient cost is ~12 MB heap (observed: 3.52 → 12.36 pre-GC). The `originalJsonl` string alone is 1.09 MB. Two passes of brotli q11 each allocate output buffers. Multiple `JSON.parse(r.payload_json)` calls re-inflate every payload into heap objects just to re-serialize them sorted.
**Risk profile:** Linear in receipt count. At 10K receipts this becomes ~80 MB heap transient — still safe on a modern box but a meaningful Bun GC pause (brotli q11 alone is ~1.5 sec for 1,500 receipts; would be ~10 sec at 10× scale).

### 5. SQLite `:memory:` page memory — Bun arena, never returned

**Observed:** RSS climbed from 60.74 MB → 135.32 MB during the run and **stayed at 135.32 MB after `store.close()`**, despite all JS references dropped and full GC.
**Why suspicious:** `bun:sqlite` allocates page-cache memory in a native arena. `Bun.gc(true)` cannot reach into that arena to free pages. Even `db.close()` returns memory to SQLite's malloc, which Bun's allocator may or may not release to the OS depending on fragmentation. **A long-running daemon that creates and destroys many Store instances will see RSS climb monotonically.**
**Risk profile:** Real for production daemon use. Bun.gc() and Store.close() do not reset RSS. The only fix is process restart, or moving the database off `:memory:` and onto a file-backed path (which would change semantics).

## Recommendations (additive, opt-in only — NOT prescribed to apply)

These are options for the operator to evaluate. None should be applied without explicit direction.

1. **Bound `Store._stmts` with a soft LRU cap.** Configurable max (e.g. 256). Keep current behavior as the default. Evict on cap.
2. **Add `MeshStreamCompressor.reset()` method.** Operator-callable between sweeps to clear `_window`, `_delta._last`, `_semantic._factRegistry`. Don't auto-reset (would break stream-decompress base lookups).
3. **Add `ResonanceExtractor.compact()` method.** Prune `cooccurrence` entries below count threshold; drop oldest `messages` entries beyond N. Currently no compaction exists.
4. **Stream `exportCompressedAuditLog` instead of buffering.** Process receipts in chunks of 100, emit incremental brotli output. Today's implementation builds every intermediate in memory at once.
5. **Document `:memory:` RSS ceiling in `storage.mjs` header.** Operators expect `store.close()` to release; it does not. The header doc should say so.
6. **Probe `_factRegistry` and `cooccurrence` sizes via a new optional `Store.diagnostics()` method.** Read-only introspection of long-lived growth structures so wave-3 monitoring (Orange5 cockpit) can graph drift.
7. **Add a periodic eviction pass tied to `crystalCompressor._extractor`.** When `cooccurrence.size > N`, drop pairs with count == 1 (singletons are noise).

## Files referenced

- `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\storage.mjs` (485 lines)
- `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\engines.mjs` (2,014 lines)
- `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\engagements.mjs` (944 lines)
- `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\mesh-compression.mjs` (239 lines)
- `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\crystal-compression.mjs` (953 lines)
- `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\wellbeing-guardrails.mjs` (not modified)
- `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\clc-engine.mjs` (not modified)

## Probes

- `C:\AtomEons\Orange5\12-ATOMSMASHER\research\memory-probe.mjs` — checkpoint sampler
- `C:\AtomEons\Orange5\12-ATOMSMASHER\research\memory-retention-probe.mjs` — retention introspection

Both probes import production modules read-only. No source file was modified.
