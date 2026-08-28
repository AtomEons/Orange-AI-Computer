# Experiment 09 — Determinism Floor Analysis — RESULT

**Status:** ⚠️ LOSSLESS but below baseline
**Generated:** 2026-06-26T10:10:51.128Z

## Per-field Shannon entropy

| field | entropy (bits/byte) | total bytes | % of corpus |
|---|---|---|---|
| id | 4.296 | 130,704 | 8.9% |
| action | 3.750 | 79,049 | 5.4% |
| status | 1.004 | 12,451 | 0.9% |
| summary | 4.796 | 276,671 | 18.9% |
| payload_json | 5.093 | 838,397 | 57.4% |
| created_at | 3.228 | 124,480 | 8.5% |

## Regeneration floor breakdown

If the system replayed deterministically from seed + code_sha, the storage floor is:

| Component | Bytes |
|---|---|
| Seed text (organism doctrine) | 517 |
| Code SHA (organism version) | 32 |
| Irreducible nonces (6815 distinct hex strings) | 54804 |
| Structural bookkeeping (~6 B/receipt × 6224) | 37,344 |
| **Total regeneration floor** | **92697** |
| **Theoretical regeneration ceiling** | **22.39×** |

## What's achievable TODAY (lossless, without modifying the canonical organism)

| Metric | Value |
|---|---|
| Lossless full-field-vocab + brotli | 125,309 B |
| Achievable ratio today | 16.56× |
| Roundtrip lossless | ✓ |

## Analysis

The corpus has **6815 distinct hex nonces** totaling 54804 bytes. These are the IRREDUCIBLE-random content: receipt IDs (rcpt_*), warrant IDs, content-derived sha256 strings.

**If the canonical organism were modified** to derive nonces deterministically via `sha256(seed || sequence_index)` instead of `crypto.randomUUID()`, those 54804 bytes drop to ZERO, and the regeneration ceiling jumps to:

```
raw_bytes / (seed + code_sha + bookkeeping) = 2075585B / 37,893B = 55×
```

But that's a hypothetical "future system" number, not a lossless compression on the corpus we have. The CURRENT corpus has those nonces written down as bytes; we can't make them disappear.

## Conclusion

This experiment measures the THEORETICAL CEILING for regeneration mode (22.39×) and confirms the corpus has ~2.6% irreducible-random content. The actual today-achievable lossless number (16.56×) is bounded by the field-vocab encoding (= Experiment 01 spike).

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/09-determinism-upgrade/bench.mjs
```
