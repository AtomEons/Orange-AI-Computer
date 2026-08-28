# Experiment 03 — Knot Signature Segment Collapse — RESULT

**Status:** ❌ FAIL
**Generated:** 2026-06-26T09:20:21.789Z

## Measured

| Metric | Value |
|---|---|
| Raw corpus bytes | 2,075,585 |
| Knot-sig stream pre-brotli | 736,370 |
| Knot-sig + brotli q11 | 144,930 |
| **Compression ratio** | **14.32×** |
| Roundtrip lossless | ✓ |
| Distinct per-receipt sigs | 2075 (entropy 11.02 bits/receipt) |

## Sliding-window dedup analysis

| W | total windows | distinct | dedup factor |
|---|---|---|---|
| 2 | 6,223 | 4,693 | 1.33× |
| 3 | 6,222 | 5,993 | 1.04× |
| 5 | 6,220 | 6,220 | 1.00× |
| 8 | 6,217 | 6,217 | 1.00× |
| 13 | 6,212 | 6,212 | 1.00× |

## Analysis

Knot-signature dedup at 14.32× did NOT beat Experiment 01's 16.56× spike encoding. The structural signature space (2075 distinct sigs over 6224 receipts) didn't collapse enough to offset the per-receipt residual overhead. Honest finding: structural fingerprinting doesn't yield more compression than direct per-field vocab indexing when most receipts have unique payloads.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/03-knot-signature/bench.mjs
```
