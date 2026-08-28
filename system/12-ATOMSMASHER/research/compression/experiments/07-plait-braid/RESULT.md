# Experiment 07 — Plait / Braid Encoding — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T09:38:15.611Z

## Strand decomposition

38 distinct strands (engines):

- `mesh` × 1,567 receipts (25.2%)
- `air` × 3,131 receipts (50.3%)
- `equation` × 93 receipts (1.5%)
- `feature` × 621 receipts (10.0%)
- `debt` × 22 receipts (0.4%)
- `cache` × 138 receipts (2.2%)
- `route` × 53 receipts (0.9%)
- `order` × 81 receipts (1.3%)
- `pipeline` × 3 receipts (0.0%)
- `prefix` × 85 receipts (1.4%)
- `source` × 113 receipts (1.8%)
- `pathwave` × 8 receipts (0.1%)
- `thermo` × 7 receipts (0.1%)
- `memory` × 27 receipts (0.4%)
- `prooflab` × 39 receipts (0.6%)
- `awareness` × 24 receipts (0.4%)
- `embedding` × 23 receipts (0.4%)
- `cartridge` × 5 receipts (0.1%)
- `workset` × 54 receipts (0.9%)
- `mode` × 28 receipts (0.4%)
- `agent` × 14 receipts (0.2%)
- `canon` × 20 receipts (0.3%)
- `crystal` × 15 receipts (0.2%)
- `clc` × 14 receipts (0.2%)
- `pattern` × 17 receipts (0.3%)
- `db` × 1 receipts (0.0%)
- `schema` × 1 receipts (0.0%)
- `primitive` × 7 receipts (0.1%)
- `dictionary` × 1 receipts (0.0%)
- `wellbeing` × 1 receipts (0.0%)
- `immune` × 4 receipts (0.1%)
- `expansion_warrant` × 1 receipts (0.0%)
- `organism` × 1 receipts (0.0%)
- `payload` × 1 receipts (0.0%)
- `action` × 1 receipts (0.0%)
- `regeneration` × 1 receipts (0.0%)
- `compression` × 1 receipts (0.0%)
- `least_action` × 1 receipts (0.0%)

## Compression measurement

| Metric | Value |
|---|---|
| Raw corpus bytes | 2,075,585 |
| Plait stream pre-brotli | 2,082,206 |
| Plait + Brotli q11 | 114,967 |
| **Compression ratio** | **18.05×** |
| Lossless roundtrip | ✓ |

## Analysis

Plait encoding beats Experiment 01's 16.56× full-corpus spike baseline. Splitting by strand (engine family) lets brotli find massive redundancy within each strand — mesh.* receipts all share the same JSON shape, air.* receipts share theirs, etc. The strand-id index sequence is itself small (varint per receipt).

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/07-plait-braid/bench.mjs
```
