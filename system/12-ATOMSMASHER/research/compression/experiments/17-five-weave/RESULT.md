# Experiment 17 — The 5-Weave (4-weave + predictive Markov coding) — RESULT

**Status:** ⚠️ measured (see analysis)
**Generated:** 2026-06-26T11:08:03.815Z

## Per-field range coding (1st-order Markov + Laplace smoothing)

| Field | V | Seq | RC bytes | bits/sym | Model bytes | Total |
|---|---|---|---|---|---|---|
| id | 6,224 | 6,224 | 9,029 | 11.604 | 174,016 | 183,048 |
| action | 66 | 6,224 | 1,968 | 2.529 | 2,226 | 4,196 |
| status | 2 | 6,224 | 2 | 0.003 | 24 | 27 |
| summary | 2,598 | 6,224 | 7,571 | 9.731 | 104,923 | 112,497 |
| payload_json | 1,855 | 6,224 | 7,200 | 9.254 | 428,700 | 435,903 |
| created_at | 35 | 6,224 | 3,602 | 4.629 | 3,450 | 7,055 |

## 5-Weave totals

| Metric | Value |
|---|---|
| Raw corpus | 2,075,585 B |
| Combined per-field range-coded + models (pre-brotli) | 742,803 B (2.79×) |
| **5-Weave (+ Brotli q11)** | **152,788 B** |
| **5-Weave ratio** | **13.58×** |
| Lossless roundtrip | ✓ sha256 match |

## Versus baselines

| Method | Ratio |
|---|---|
| Plait/Braid (Exp 07, full corpus) | 18.05× |
| 4-weave compound (organism Stage 11g) | 291.61× |
| **5-Weave (this experiment)** | **13.58×** |
| ✗ Below plait baseline | |

## Analysis

5-weave at 13.58× is below plait baseline. Per-field models + range-coded streams + brotli isn't enough on its own. The byte-level brotli still saturates around the same point because the range-coded streams have similar byte-level entropy to vocab-encoded streams.

## Per-field findings

The fields with highest distinct cardinality (id, summary, payload_json) carry the most bytes. Their Markov models are large (lots of distinct values means lots of conditional probability mass to encode). The MODEL OVERHEAD dominates for these high-cardinality fields.

For high-leverage fields (action, status, created_at — low cardinality), the Markov coding works well — small models, good prediction.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/17-five-weave/bench.mjs
```
