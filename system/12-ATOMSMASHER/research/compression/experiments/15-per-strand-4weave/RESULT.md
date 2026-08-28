# Experiment 15 — Per-Strand 4-Weave (split first, then compress per-strand) — RESULT

**Status:** ⚠️ LOSSLESS but below baseline
**Generated:** 2026-06-26T10:27:21.347Z

## Method
Split receipts into 38 strand groups (by action prefix). For each strand independently, brotli q11 the strand's JSONL. Sum per-strand compressed bytes + strand-id index + vocab header.

## Top 5 strands by raw size

| Strand | Receipts | Raw B | Brotli B | Ratio |
|---|---|---|---|---|
| air | 3,131 | 823,768 | 36,817 | 22.37× |
| feature | 621 | 486,511 | 27,474 | 17.71× |
| mesh | 1,567 | 348,260 | 29,221 | 11.92× |
| route | 53 | 81,438 | 2,745 | 29.67× |
| workset | 54 | 54,646 | 1,486 | 36.77× |

## Compression measurement

| Metric | Value |
|---|---|
| Sum of per-strand compressed | 126,604 B |
| Strand-id index (brotli) | 1,845 B |
| Strand vocab header | 308 B |
| **Total lossless** | **128,757 B** |
| Raw corpus | 2,075,585 B |
| **Compression ratio** | **16.12×** |
| Lossless roundtrip | ✓ |
| vs joint plait (18.05×) | -1.93× loss |

## Analysis

Per-strand brotli at 16.12× does NOT beat joint plait (18.05×). The overhead of per-strand brotli headers + the strand-id index exceeds the savings from per-strand homogeneity.
