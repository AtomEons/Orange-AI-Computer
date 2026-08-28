# Experiment 11 — Trefoil DCT — RESULT

**Status:** ❌ FAIL
**Generated:** 2026-06-26T09:59:03.683Z

## Method
Trefoil-inspired sinusoidal basis decomposition. Compute DCT-II per 256-element block of the action-id sequence; rank positions by |coefficient| magnitude; encode each block as (permutation, values-in-permuted-order). Brotli compresses the permutation + value stream.

This is lossless: the permutation is invertible.

## Measured

| Metric | Value |
|---|---|
| Raw action stream | 85,273 B |
| DCT stream pre-brotli | 16,723 B |
| DCT + Brotli q11 | 8,759 B |
| **Compression ratio** | **9.74×** |
| Roundtrip lossless | ✓ |

## Analysis

DCT-ordered encoding at 9.74× does NOT beat Experiment 06's Huffman (32.57×). The permutation overhead per block (storing 256 indices) exceeds savings; OR the action sequence is too close to white noise for DCT to concentrate energy meaningfully.

## Honest caveat

For LOSSLESS reconstruction we cannot truncate coefficients. The compression must come from value redundancy in the permuted order — and the permutation index itself costs bytes. This is fundamentally different from JPEG/MP3-style lossy DCT compression.

## Reproduction
```
bun 12-ATOMSMASHER/research/compression/experiments/11-trefoil-dct/bench.mjs
```
