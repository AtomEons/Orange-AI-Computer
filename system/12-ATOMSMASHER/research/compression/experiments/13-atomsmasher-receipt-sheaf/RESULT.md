# Experiment 13 — AtomSmasher Receipt Sheaf (ARS) — RESULT

**Status:** ⚠️ LOSSLESS but below baseline
**Generated:** 2026-06-26T10:22:22.700Z

## ARS topology

| Metric | Value |
|---|---|
| Receipts | 6,224 |
| **Structural templates** | **802** (numerals replaced by placeholders) |
| Template-collapse ratio | 7.76× |
| Total numeric parameters | 59,439 |
| Action RLE pairs | 4203 (avg run 1.48) |

## Compression

| Metric | Value |
|---|---|
| Raw corpus | 2,075,585 B |
| ARS pre-brotli | 789,356 B |
| ARS + Brotli q11 | 133,815 B |
| **Ratio** | **15.51×** |
| Lossless | ✓ |

## Analysis

ARS at 15.51× is lossless but does not beat plait (18.05×). Template extraction gave 7.76× collapse but per-receipt parameter vectors still dominate the byte count.
