# Experiment 06 — Annular Key (frequency-ring Huffman) — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T09:37:44.026Z

## Frequency rings (top 5)

| Ring | Action | Count | % |
|---|---|---|---|
| 1 | air.compress | 3,126 | 50.2% |
| 2 | mesh.compress | 1,565 | 25.1% |
| 3 | feature.execute | 620 | 10.0% |
| 4 | equation.fit | 93 | 1.5% |
| 5 | cache.hit | 85 | 1.4% |

## Information theory

| Metric | Value |
|---|---|
| Distinct actions | 66 |
| Shannon entropy | 2.401 bits/symbol |
| Avg Huffman code | 2.414 bits/symbol |
| Entropy efficiency | 99.47% |

## Compression measurement (action column)

| Metric | Value |
|---|---|
| Raw action stream | 85,273 B |
| Baseline brotli q11 | 4,323 B (19.73×) |
| Huffman packed (no brotli) | 1,878 B |
| Annular + Brotli q11 | 2,618 B |
| **Compression ratio** | **32.57×** |
| Lossless roundtrip | ✓ |

## Analysis

Annular Huffman code achieves 32.57× on the action stream, beating per-byte brotli (19.73×). Average code length (2.41 bits) is within 0.53% of the Shannon entropy floor (2.40 bits) — near-optimal symbol coding.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/06-annular-key/bench.mjs
```
