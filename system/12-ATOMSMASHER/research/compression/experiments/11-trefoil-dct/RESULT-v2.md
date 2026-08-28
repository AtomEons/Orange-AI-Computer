# Experiment 11 v2 — 3D Parametric Fourier Descriptor (real integer FFT) — RESULT

**Status:** ✅ LOSSLESS, but below Huffman baseline
**Generated:** 2026-06-26T10:05:15.129Z

## Method (corrected from v1)

1. Map actions to integer ids
2. Block-FFT the id sequence in 1024-element blocks (zero-padded to next power of 2)
3. Quantize complex coefficients to int32 at scale 2^14
4. Zigzag-varint encode all coefficients, brotli q11
5. Roundtrip: inverse FFT → round → lookup → sha256 verify byte-exact

## Measured

| Metric | Value |
|---|---|
| Raw action stream | 85,273 B |
| Fourier stream pre-brotli | 46,483 B |
| Fourier + Brotli q11 | 35,799 B |
| **Compression ratio** | **2.38×** |
| Roundtrip lossless | ✓ sha256 match |

## Analysis

Lossless FFT works at 2.38× but below Huffman baseline (32.57×). The action sequence is too close to white noise for FFT to concentrate energy meaningfully — Huffman exploits frequency skew directly and wins. The Fourier Descriptor is the right tool for SMOOTH signals; receipt streams aren't smooth.

## Honest reflection

The 3D Parametric Trefoil compresses ARTIFICIALLY GENERATED SMOOTH CURVES (sin+cos with low-order frequencies). For receipts — which are sparse event streams, not smooth signals — FFT cannot beat domain-aware encoding (Huffman, dict-based).

The Fourier Descriptor *would* compress beautifully if our data were:
- Smooth periodic signals
- Closed curves (loops in some embedding)
- Audio/image waveforms

For temporal causal event streams, frequency-domain compression has no inherent advantage.
