# Experiment 12 — Turning Key (N-fold ring closure) — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T09:59:05.696Z

## Method
Find all divisors d of N=6224. For each d, partition the action sequence into d rings of length N/d. Compute per-ring similarity to the first ring (positional-match rate). Pick the d maximizing similarity = the Turning Key. Encode as (d, ring_size, fundamental_ring, per-ring diffs, tail). Brotli.

## Top 5 candidate Turning Keys

| d | ring size | positional similarity |
|---|---|---|
| 2 | 3112 | 0.332 |
| 16 | 389 | 0.325 |
| 4 | 1556 | 0.323 |
| 8 | 778 | 0.319 |

## Best key

| Metric | Value |
|---|---|
| Best d | 2 |
| Ring size | 3112 |
| Positional similarity | 0.332 |

## Compression measurement (action column)

| Metric | Value |
|---|---|
| Raw action stream | 85,273 B |
| Turning Key pre-brotli | 10,427 B |
| Turning Key + Brotli q11 | 4,506 B |
| **Compression ratio** | **18.92×** |
| Lossless roundtrip | ✓ |

## Analysis

Turning Key d=2 beats Experiment 04's 16.86× IFS baseline. The corpus has a natural ring structure at this divisor.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/12-turning-key/bench.mjs
```
