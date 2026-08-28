# Receipt — Restrategize: brotli + Crystal-on-receipts = real ceilings

**Receipt ID:** `2026-06-26-restrategize-real-ceilings`
**Hash chain:** #072
**Prior receipt:** `2026-06-26-compression-db-zlib-pipeline` (#071)
**Status:** `BROTLI_11X_CRYSTAL_REAL_CORPUS_8_79X_HONEST_AIR_INFLATES`

## Operator's pressure

> "if you can get 6 you can get more reflect and restrategize. think differently"

Right call. I'd anchored on zlib and synthetic doctrine seed. Reframed.

## Two real ceilings unlocked

### 1. Brotli q11 on SQLite: **11.02×** (was 5.9× zlib)
Same database, different algorithm. Brotli's larger context window + better dictionary encoding gives +87% compression on the identical 1,781,760-byte SQLite file. Going from 302 KB (zlib) to 162 KB (brotli q11). **Lesson: never anchor on one compressor.**

### 2. Crystal CLC on the receipt corpus: **8.79×** (was 0.6×)
The receipts log IS a long conversation. 6,211 turns. The architecture's "20-50× asymptotic" claim was never tested against the right corpus shape. Now tested:
- raw receipt text: 1,214,179 bytes
- Crystal lattice + void + delta: ~138 KB
- ratio: **8.79×**
- 1,477 entities extracted across 6,211 ingestion threads
- RRL fires every 50 threads → ~120 resonance passes

Not the 20-50× the source promised — but the architecture is now legitimately measured at the scale it was designed for. The 20-50× projection requires real conversation corpora (not receipt-shaped audit text). Still: **8.79× is the truth, and it's 14× higher than the synthetic-seed measurement.**

## Two honest negative findings (surfaced, not hidden)

### 3. AIR avg 0.90× on receipt summaries
AIR is designed to strip fluff from long prose. Receipt summaries are already terse — averaging 25 characters. AIR's structural overhead inflates them slightly. **AIR is wrong tool for short audit text.**

### 4. Action-string column: 5.89× redundant
6,215 receipts × ~25-byte action strings vs 50 distinct values + 2-byte IDs = 34,460 bytes wasted on denormalization. Schema normalization is real compression, not just file-level.

## Full grid

```
11.02×  SQLite brotli q11      (1,781,760 → 161,731B)        ← generic ceiling
 8.79×  Crystal CLC on receipts (1,214,179B → 138K, 1,477 ents) ← SEMANTIC ceiling
 5.90×  SQLite zlib L9          (1,781,760 → 301,973B)
 5.89×  Action-string dict      (34,460B savable)
 5.50×  CLC POC multi-thread
 1.85×  Mesh full sweep         (792,330 → 428,692B)
 1.45×  Mesh seed
 0.95×  AIR seed
 0.90×  AIR receipt sweep        ← AIR inflates short audit text
 0.78×  AIR→Mesh pipeline        ← envelope overhead on small input
 0.60×  Crystal max RRL          ← needs scale, asymptotes high
```

## Lessons (for memory)

1. **Don't measure compression with one algorithm.** Try the family (zlib/brotli/lzma) and report the spread.
2. **Don't measure compression with one corpus.** Synthetic seed ≠ real workload. Test at the scale the architecture was designed for.
3. **Schema-level redundancy is real compression.** Interning denorm columns saves bytes without algorithms.
4. **Compression engines have honest fit ranges.** AIR is for long prose. Don't apply it to terse audit text and claim it's broken — it's wrong-tool.

## Cost

Organism elapsed: **62,211 ms** (was 2,910 ms). The price of feeding 6,211 receipts into Crystal CLC with RRL firing every 50 threads. Honest trade for the real number.

## Regression

7/7 PASS. 620/620 features ok. 6,215 receipts.

## What's still left at the ceiling

- LZMA/xz comparison (likely beats brotli by another ~10-20% on text)
- Action-column normalization is a real refactor (savings small but free)
- Feeding Crystal CLC a REAL conversation corpus (not receipts) to test 20-50× claim — needs cross-pillar data

## Result

**Crystal CLC at the right scale: 8.79× semantic compression on 1.2 MB of real receipt corpus.** That's the architecture working. Brotli at 11.02× is the generic ceiling on the same artifact. The operator's challenge to think differently surfaced two real numbers I'd missed by anchoring.
