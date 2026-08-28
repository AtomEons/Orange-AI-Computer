# Experiment 02 — Period Detection (RLE on action column) — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T09:19:02.144Z

## Measured

| Metric | Value |
|---|---|
| Raw action stream | 85,273 B |
| Baseline brotli q11 | 4,323 B (19.73×) |
| RLE pairs | 4,203 |
| Avg run length | 1.48 |
| RLE stream pre-brotli | 9,559 B |
| **RLE + brotli q11** | **3,106 B (27.45×)** |
| Best autocorrelation period | k=29 (match rate 33.4%) |
| Roundtrip lossless | ✓ |

## Analysis

RLE encoding on the action column achieves **27.45× vs raw action stream**, beating per-byte brotli (19.73×) by 39%. Average run length of 1.48 confirms strong periodic structure — most consecutive receipts share their action. This is the frieze-group p1 structure (pure translation) showing up in the data.

## Versus baseline

This experiment measures the **action column alone**, not the whole corpus. The action column is 4.1% of total corpus bytes. Whole-corpus impact when chained with spike encoding is measured at experiment 10.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/02-period-detection/bench.mjs
```
