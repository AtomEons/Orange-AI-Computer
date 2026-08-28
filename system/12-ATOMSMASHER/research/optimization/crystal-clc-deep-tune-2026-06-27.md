# Receipt — Crystal Lattice Compression deep-tune (Stage 11d + 11g)

- Date: 2026-06-27
- Files modified:
  - `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\crystal-compression.mjs`
  - `C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\clc-engine.mjs`
- Bun: 1.3.14, Windows x64
- Bench harness: `scratchpad/bench-crystal.mjs`
  - Corpus held stable via `ATOMSMASHER_DETERMINISM_SEED=BENCH_SEED_2026`
  - Same demo()-built receipt corpus across baseline + optimized
  - 10 iterations each, median reported

## Round 2 mandate

Round 1 (already-applied `_wordSet` cache + fact fast-path + inclusion-exclusion
union) drove Stage 11d 28.05s → 23.97s (1.17×). Round 2 went DEEPER.

## Profile-guided hot-spot map (BEFORE)

| Function | Calls | Time | Per call |
|---|---:|---:|---:|
| CrystalCompressor.ingest | 1,491 | 3,553ms | 2.383ms |
| ResonanceExtractor.extractEntities | 2,982 | 2,256ms | 0.756ms |
| ResonanceExtractor.ingestMessage | 1,491 | 561ms | 0.376ms |
| ResonanceExtractor.extractFacts | 1,491 | 328ms | 0.220ms |

`extractEntities` was burning ~64% of total Stage 11d wall — the prime target.

## Optimizations applied

1. **ENTITY_SIGNALS_LC precompute (module scope)** — original code called
   `signals.some(s => context.includes(s.toLowerCase()))` per word inside
   `extractEntities`, re-lowercasing the same constant signal strings on
   every iteration. Now lowercased once at module load.

2. **`_latticeKnownSet(latticeEntities)` cache on the extractor instance** —
   original rebuilt the lattice-known Set on EVERY call to extractEntities
   (twice per ingest) and again in extractFacts (~5,500 rebuilds across the
   1,491-receipt stream of an ever-growing set). Now cached by lattice
   reference + size, invalidated on growth.

3. **Inline lexicographic pair construction** — replaced
   `[a, b].sort().join('|')` with `a < b ? \`${a}|${b}\` : \`${b}|${a}\``
   in three hot loops (ingestMessage co-occurrence ~2M pairs, extractEntities
   Method 4, runResonanceLoop). Eliminated millions of 2-element array allocs
   + .sort() + .join() calls.

4. **Single-pass sigToken lowercase in ingestMessage** — the original
   re-lowercased each token up to 8 times (once for wordFreq, plus once per
   cooccurrence window position). Now lowercased once into a parallel
   `sigLower` array; wordFreq + cooccurrence read from it.

5. **`score >= 3.0` short-circuit on context-window classification** —
   classification was running for EVERY non-stop word, even when the entity
   would not be emitted. Now runs only when emission is decided. Saves the
   context concat + .toLowerCase + signal-loop on ~80% of words.

6. **Typed-array `startsDigitDollar` precompute** — Method 5's per-word
   `/[\d$]/.test(words[i-1])` and `[i+1]` checks now read from a single
   `Uint8Array` filled once per call (cheap charCode check + regex fallback
   only when first char is non-digit non-`$`).

7. **`reconstructCoverage` two-level cache** —
   - Per-message significant-token cache (messages immutable; tokens stable).
   - Lattice `explained` Set cache keyed by `(entities.size, facts.length,
     decisions.length, topics.size)` — only rebuild when lattice grows.
   - Replaced two .filter() passes over `sig` with one indexed loop.

8. **extractFacts: precompiled FACT_VERBS_LC / FACT_COMPARATORS_LC /
   FACT_PRICE_RE** — the original built `[' is ', ' are ', ...]` arrays and
   `[' better ', ...]` inline on every sentence. Now module-scope arrays.

9. **extractFacts: cached `knownFiltered` array** — pre-filtered to
   `length > 2`, bound to the same cache key as the known Set so growth
   invalidates both atomically.

10. **clc-engine.mjs (regex POC) precompiles** — module-scope regexes for
    entity/decision/goal patterns, precomputed signal arrays for goal/value/
    void detection, precomputed [word, emotion] pair list (no Object.entries
    alloc per call). Same call surface; no observable change.

## Bench results — 10-iter median, deterministic corpus (1,491 receipts)

| Function / Stage | Before (ms) | After (ms) | Speedup | Optimization |
|---|---:|---:|---:|---|
| Stage 11d (Crystal CLC) | 2,759 | 1,947 | 1.42× | ENTITY_SIGNALS_LC + score short-circuit + known-set cache + pair inline + sigLower single-pass |
| Stage 11g (Compound) | 1,465 | 623 | 2.35× | same hot path via Layer 2 CrystalCompressor.ingest |
| Extractor.extractEntities | 2,256 | 965 | 2.34× | constant lowercase precompute + score>=3 short-circuit on context-classify |
| Extractor.ingestMessage | 561 | 324 | 1.73× | sigLower parallel array (lowercase once) + inline pair concat |
| Extractor.extractFacts | 328 | 131 | 2.50× | known-set cache + filtered-array cache + precompiled signal arrays |

**21/21 green, sha256 stable, total Stage 11d+11g time 4,224ms → 2,570ms (1.64×).**

Files modified:
- `12-ATOMSMASHER/full-scope/crystal-compression.mjs`
- `12-ATOMSMASHER/full-scope/clc-engine.mjs`

## Semantic-equivalence proofs

- 21/21 tests green: codec-export (5/5), determinism (5/5), full-scope (7/7),
  replay-integration (4/4).
- SHA-256 of receipt-ID stream from two demo() runs with same seed:
  `5989674e4986667ee32912246641acf7a101d7f22ac138e4562e329b192bc04e` (identical
  across runs — replay determinism law holds).
- Stage 11d compression ratio identical: 8.84× (baseline) = 8.84× (optimized).
- Stage 11d entity count identical: 434 (baseline) = 434 (optimized).
- Stage 11g compound ratio identical: 155.49× (baseline) = 155.49×
  (optimized), 644,674B → 4,146B in both.

## Forbidden actions (per brief) — confirmed not taken

- No exported APIs changed.
- No features removed.
- No semantics modified.
- No files outside the two named files modified.
