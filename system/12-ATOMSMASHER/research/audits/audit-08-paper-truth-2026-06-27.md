# Audit 08 — PAPER.md Truth Audit (2026-06-27)

**Mission:** verify that the numeric claims in `PAPER.md` reproduce on a fresh Bun 1.3.14 process today, not because they were measured under favorable conditions earlier.

**Environment**
- Bun 1.3.14 (confirmed `bun --version`)
- Corpus: `data/canonical-corpus.jsonl`
- Raw bytes: 2,075,585 (matches paper)
- Corpus sha256: `5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4` (matches paper Appendix B)
- Receipts: 6,224
- Each experiment re-run via `bun bench.mjs` in its own directory (no warm cache, no shared state between runs)
- Tolerance band: ±2% on the cited ratio. Outside band = INFLATED or DEFLATED.

## Results

| Exp | Claim | Measured | Delta | Status |
|---:|---|---|---:|---|
| 59 (M19) | 47.07× / 44,095 B | 47.071× / 44,095 B | 0.0% | PASS |
| 118 (M19.1 champion) | 47.15× / 44,021 B | 47.150× / 44,021 B | 0.0% | PASS |
| 122 (cold-start replication) | 47.15× / 44,021 B | 47.150× / 44,021 B | 0.0% | PASS |
| 78 (component split MESH_DECOMP) | 40.584× without MESH_DECOMP | 40.584× | 0.0% | PASS |
| 78 (component split SHAPE_VOCAB) | 37.386× without SHAPE_VOCAB | 37.386× | 0.0% | PASS |
| 78 (component split B8_SORT) | 42.289× without B8_SORT | 42.289× | 0.0% | PASS |
| 87 (field DAG theoretical) | 487.11× (paper labels as MIRAGE) | 487.112× theoretical | 0.0% | PASS (theoretical, honestly labeled) |
| 99 (order-3 byte-Markov ceiling) | 9.02× | 9.019× | 0.0% | PASS |
| 81 (per-axis brotli) | 14.64× | 14.64× | 0.0% | PASS |
| 91 (action markov) | 37.81× / 50.6% pred acc | 37.807× / 50.63% | 0.0% | PASS |
| 121 (streaming W=500) | 19.48× / 0.72 ms/receipt | 19.476× / 0.42 ms/receipt | 0.0% ratio; ms/rcpt FASTER than claim | PASS (ratio); ms is hardware-sensitive |
| 117 (per-formula audit) | 23.55× / 331 violators | 23.546× / 331 violators | 0.0% | PASS |
| 95 (key-dict substitution) | 17.60× | 17.604× | 0.0% | PASS |
| 76 (splay tree shapes) | 34.43× | 34.427× | 0.0% | PASS |
| 113 (library-size sweep N=10) | 28.23× | 28.232× | 0.0% | PASS |
| 38 (method 5 schema fold) | 35.12× | 35.12× | 0.0% | PASS |
| 42 (method 8 sorted shapes) | 41.43× | 41.43× | 0.0% | PASS |

**Total checked:** 17 ratio/byte claims across 15 experiments (Exp 78 contributes 3 component sub-claims).

## Summary

Paper truth: **17/17 reproduce within ±2% (0.0% delta on every checked claim).**

Every ratio cited in PAPER.md matches the fresh-run measurement to 3+ significant figures. The 478× theoretical ceiling in Exp 87 is honestly labeled as a "mirage" in the paper text itself (lines 169, 199, 212) — the paper does not claim this as an achievable result. The streaming ms/receipt in Exp 121 came in faster than claimed (0.42 vs 0.72), which is hardware-load-sensitive and not a ratio claim.

## Roundtrip verification

Every measured experiment that claimed `lossless: true` also produced byte-exact recovery in this fresh run. The corpus sha256 invariant held end-to-end on Exp 59, 118, 122, 78 (all components), 91, 121, 76, 117, 95, 81, 38, 42, 113.

## Notes on stability

Wall-clock timings drift run-to-run (encode_ms varies ±20% across runs depending on system load). All variable timing measurements are properly bracketed by mean/median across K=5 runs in the long-form claims (Exp 122). The paper does not over-claim deterministic timing.

The ratio claims, however, are deterministic — they derive from byte counts of brotli'd outputs under identical pipeline settings. The exact byte-counts reproduced exactly across this fresh-process audit, confirming no hidden state corrupted the prior measurements.

## Mom's Law verdict

**No credibility ship-blocker found.** Every load-bearing claim reproduces. The paper is honest about what is theoretical vs measured (Exp 87 is labeled mirage; M20 carries 25% p-underperform disclosure). The lossless contract is honored: every claim that asserts losslessness produced byte-exact sha256-verified roundtrip on this audit run.

Paper is shippable.
