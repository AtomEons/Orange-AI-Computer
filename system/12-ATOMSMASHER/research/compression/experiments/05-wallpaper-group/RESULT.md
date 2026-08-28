# Experiment 05 — Wallpaper Group / GCD(p,q) Plait Theorem — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T09:37:39.529Z

## Method

Reshape the action sequence into a p×q grid. Test all (p,q) pairs with p·q ≈ N (within p). Compute translational symmetry scores. Pick (p,q) maximizing combined vertical+horizontal match rate.

By Fisher's theorem (Celtic knot mathematics), a p×q plait has **gcd(p,q)** independent strand components.

## Best (p,q) found

| Metric | Value |
|---|---|
| Best p | 50 |
| Best q | 124 |
| **gcd(p, q)** | **2** (Fisher strand-component count) |
| Vertical symmetry | 32.94% |
| Horizontal symmetry | 32.26% |
| Combined score | 0.326 |

## Compression measurement (action column only)

| Metric | Value |
|---|---|
| Raw action stream | 85,273 B |
| Wallpaper encoded (pre-brotli) | 9,555 B |
| Wallpaper + Brotli q11 | 4,439 B |
| **Compression ratio** | **19.21×** |
| Lossless roundtrip | ✓ |

## Analysis

Wallpaper-style encoding with best (p,q)=(50, 124) achieves 19.21× on the action stream. Fisher's theorem identifies 2 independent strand components — meaning the conceptual "knotwork" of the receipts is a 2-strand braid.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/05-wallpaper-group/bench.mjs
```
