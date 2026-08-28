# Experiment 20 — Minimal Binary Schema Codec — RESULT

**Status:** ❌ lossy

## Compression

| Metric | Value |
|---|---|
| Raw corpus | 2,075,585 B |
| Pre-brotli (binary schema) | 691,360 B |
| + Brotli q11 | 119,294 B |
| **Ratio** | **17.40×** |
| Lossless | ✗ |

## Folds applied
- Summary numerics derivable from payload: 12,965 / 21,290 = 60.9%
- mesh.compress ratio folded out: 1565 receipts
- ID stored as 8-byte tail
- All field strings extracted to vocabs (stored once)
