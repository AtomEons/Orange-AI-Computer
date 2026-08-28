# Experiment 18 — Schema-Derived Field Constraints — RESULT

**Status:** ⚠️ measured
**Generated:** 2026-06-26T11:13:48.240Z

## Functional dependency detection

### mesh.compress ratio = round(raw_bytes/compressed_bytes, 2)?

| Metric | Value |
|---|---|
| mesh.compress receipts | 1,565 |
| Where ratio matches exactly | 1,565 (100.0%) |

### All functional dependencies found

- **mesh.compress** (1565 receipts): `ratio = round(raw_bytes/compressed_bytes, 2)`

## Compression measurement

| Metric | Value |
|---|---|
| Raw corpus | 2,075,585 B |
| Folded JSONL (derived fields stripped) | 2,052,266 B |
| Folded + Brotli q11 | 118,657 B |
| Dep recipe overhead | 59 B |
| **Total lossless** | **118,716 B** |
| **Compression ratio** | **17.48×** |
| Roundtrip lossless | ✓ sha256 match |

## Analysis

Found 1 action types with 1 total functional dependencies. Notable: mesh.compress has `ratio = round(raw_bytes/compressed_bytes, 2)` across all 1565 receipts of that type.



## Honest finding

Schema-constraint folding at 17.48× is below plait baseline. The detected functional dependencies were present but limited in byte-impact.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/18-schema-constraint-folding/bench.mjs
```
