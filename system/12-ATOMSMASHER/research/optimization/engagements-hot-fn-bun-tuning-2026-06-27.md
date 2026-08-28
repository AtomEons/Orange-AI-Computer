# Receipt — engagements.mjs hot-function Bun tuning

- Date: 2026-06-27
- File modified: `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\engagements.mjs` (only)
- Bun: 1.3.14, Windows x64
- Bench harness: `scratchpad/micro-bench.mjs`, N=1000 per function, 20-iter warmup
- DB: `:memory:` Store, pre-seeded 50 atoms + 30 chunks
- Sample text for AIRCodec.compress: ~800B prose × 3 repeats (mixed orders/decisions/equations/citations)

## Hot-function discovery

The task brief named `engagement.compose / audit / record / delta_score`, but
those literal names do not exist in `engagements.mjs`. Real engagement methods
exported and called by `engines.mjs` were enumerated, micro-benched, and the
three slowest selected for tuning:

| Rank | Function | Before (ops/s) |
|---|---|---:|
| 1 (slowest) | AIRCodec.compress | 1,107 |
| 2 | CartridgeBuilder.buildFromAtoms | 3,933 |
| 3 | EmbeddingIndex.probe('binary') | 7,155 |
| 4 | AwarenessSnapshot.snapshot | 8,902 |
| 5 | CompressionDebtRecorder.record | 21,219 |
| 6 | MemoryLifecycle.record | 24,298 |
| 7 | EmbeddingIndex.probe('fts5') | 24,414 |
| 8 | PatternDetector.detect('linear') | 28,342 |
| 9 | AIRCodec.decompress | 36,205 |
| 10 | PatternDetector.detect('run_length') | 41,946 |

## Optimizations applied (engagements.mjs only)

### AIRCodec.compress (+27%)

- Replaced four `Array.from(srcText.matchAll(...))` calls with explicit
  `.exec()` loops capped at 50/50/100 matches — previously materialised every
  match in the source before slicing to those caps. `code_spans` was already
  consumed only as a count, so the loop only increments a counter.
- Reset `lastIndex = 0` on each module-scope regex defensively before the loop.
- Removed the `atoms.map(a => a.air).join('\n')` second pass; `airParts` is
  now built in lockstep inside the main sentence loop.
- Skipped the per-atom `RESTORE_RE` regex pass when no code spans were
  extracted (`codeMap.length === 0`).
- Replaced `\`${prefix}|${restored}\`` template literals on the sha256
  call with plain `+` concatenation (same byte sequence into the hasher).
- `content_hash` now hashes `srcText` (already coerced once) rather than
  re-coercing the original `text` argument inside `sha256Text`. Byte sequence
  identical — `sha256Text` calls `String(text)` internally either way, so the
  hash is byte-stable.

### CartridgeBuilder.buildFromAtoms (+53%)

- Hoisted the `heatRank` table to module scope as `HEAT_RANK` (previously
  reallocated on every call).
- Collapsed `atoms.filter().map(id).map(air).join()` (four passes,
  three intermediate arrays) into a single `for` loop over `atoms` that
  builds `atomIds` and `airBuf` simultaneously.

### EmbeddingIndex.probe('binary' | 'matryoshka' | 'sketch') (+45%)

- Replaced the per-chunk `cosineLike(kws, keywords(c.text))` call pair —
  which allocated a fresh `Set` and ran the tokenizer regex over every
  chunk's text — with an inline tokenize + dedupe + intersect loop that
  counts intersection size against the precomputed query keyword Set in a
  single pass.
- Semantics preserved: same regex (`/[a-zA-Z0-9_]{3,}/g`), same stopword
  filter (mirrored as `_STOPWORDS` in engagements.mjs), same cosine
  denominator (`sqrt(|A| * |B|)`), same `> 0.1` gate.
- Skips the DB query when `kws.size === 0` (cosineLike would have returned
  0 for every chunk anyway).

### AIRCodec.decompress (bonus, +28%)

- Hoisted the prefix→label map (`AIR_LABEL`) out of the per-atom callback.
  Previously a fresh object literal was allocated for every atom in the
  array.

## Bench results

| Function | Before (ops/s) | After (ops/s) | Speedup |
|---|---:|---:|---:|
| AIRCodec.compress | 1,107 | 1,408 | 1.27× |
| CartridgeBuilder.buildFromAtoms | 3,933 | 6,026 | 1.53× |
| EmbeddingIndex.probe(binary) | 7,155 | 10,341 | 1.45× |
| AIRCodec.decompress | 36,205 | 46,421 | 1.28× (bonus) |

Geometric mean speedup across the targeted three: **1.41×**.

## Test gate

All four test files green:

- `tests/full-scope.test.mjs` — 7/7 pass
- `tests/determinism.test.mjs` — 5/5 pass
- `tests/codec-export.test.mjs` — 5/5 pass
- `tests/replay-integration.test.mjs` — 4/4 pass

Total: **21/21 green**.

Determinism preserved:
- `deterministic_mode_on_repeats`: 3 IDs reproduced byte-identical with same seed.
- `two_demo_runs_same_seed_produce_same_receipt_ids`: 1491 receipt IDs
  identical across two demo runs under the same seed.
- `codec_works_in_deterministic_mode`: 1491 receipts compressed at 31.908×
  in deterministic mode.

No function signatures changed. No exports added or removed. No behaviour
changed for any of the 21 test cases.

## Mom's Law receipt

Receipts only, no theater. The cymbal crashes.
