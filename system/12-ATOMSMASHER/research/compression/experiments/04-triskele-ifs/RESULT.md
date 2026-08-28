# Experiment 04 — Triskele / IFS Recursive Self-Similarity — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T09:37:36.151Z

## Self-similarity analysis (cosine similarity between consecutive parts)

| N | partSize | cosine | jaccard |
|---|---|---|---|
| 2 | 3112 | 1.000 | 0.470 |
| 3 | 2074 | 1.000 | 0.496 |
| 4 | 1556 | 0.999 | 0.575 |
| 6 | 1037 | 0.998 | 0.586 |

**Best:** N=3 with cosine similarity 1.000, jaccard 0.496.

## IFS encoding measurement (on action column only)

| Metric | Value |
|---|---|
| Raw action stream | 85,273 B |
| IFS encoded (pre-brotli) | 11,358 B |
| IFS + Brotli q11 | 5,058 B |
| **Compression ratio** | **16.86×** |
| Lossless roundtrip | ✓ |

## Analysis

N=3-fold partition gives cosine similarity 1.000. IFS encoding (fundamental + residual diffs) plus brotli achieves 16.86× on the action stream.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/04-triskele-ifs/bench.mjs
```
