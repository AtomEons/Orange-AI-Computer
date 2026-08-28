# Experiment 01 — Spike Encoding (v2 lossless) — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T09:17:32.617Z

## Measured numbers

| Metric | Value |
|---|---|
| Raw corpus bytes | 2,075,585 |
| Spike stream bytes (pre-brotli) | 677,742 |
| Spike + Brotli q11 bytes | 125,309 |
| **Compression ratio** | **16.56×** |
| Roundtrip lossless | ✓ YES (sha256 match) |
| Vocab — id | 6,224 distinct |
| Vocab — action | 66 distinct |
| Vocab — status | 2 distinct |
| Vocab — summary | 2,598 distinct |
| Vocab — payload_json | 1,855 distinct |
| Vocab — created_at | 35 distinct |

## Method (v2)

1. Build per-field vocabularies (id, action, status, summary, payload_json, created_at) preserving exact string bytes including null sentinels.
2. Emit binary stream: `<header: receipts_count, field_count, [(field_name, vocab_size, [strings])]>` then `<per-receipt: varint(vocab_index_per_field)>`.
3. Brotli q11 on the binary stream.
4. Decode pass: reconstruct receipts by indexing back into the vocab, sha256-compare to original corpus.

## Versus baseline

| Method | Ratio |
|---|---|
| 4-weave compound (this corpus) | 291.61× |
| Regeneration mode (lossless) | 54.48× |
| **Spike + Brotli (v2 lossless)** | **16.56×** |

Below both prior baselines — but lossless and single-pass.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/01-spike-encoding/bench.mjs
```
