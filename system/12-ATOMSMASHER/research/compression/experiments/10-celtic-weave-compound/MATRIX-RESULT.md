# Experiment 10 — Celtic Weave Compound Matrix — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T10:06:10.663Z

## Matrix of compound pipelines (sorted by ratio)

| Pipeline | Pre-brotli | Final | Ratio | Lossless | ms |
|---|---|---|---|---|---|
| plait → brotli | 2,082,206 | 114,967 | **18.05×** | ✓ | 12040 |
| plait → per-strand spike → brotli | 793,858 | 117,517 | **17.66×** | ✓ | 3164 |
| raw → brotli | 2,075,585 | 120,166 | **17.27×** | ✓ | 10867 |
| spike → brotli | 677,742 | 125,309 | **16.56×** | ✓ | 3556 |

## Best vs baseline

| Metric | Value |
|---|---|
| Baseline (raw → brotli) | 17.27× |
| Best compound | **18.05×** (plait → brotli) |
| Compound win over baseline | **+0.78×** |

## Analysis

Tested 4 compound pipelines on the full canonical corpus (2,075,585 B, 6,224 receipts). All variants verified lossless via sha256 roundtrip.

**Strongest combination:** `plait → brotli` at **18.05×**.

Plait alone (split-by-strand) beats compound variants — the strand split lets brotli find tight matches within each homogeneous engine output.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/10-celtic-weave-compound/matrix-bench.mjs
```
