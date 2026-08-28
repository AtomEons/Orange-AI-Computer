# PAPER Appendix — Audit Truth & Remediation Receipt

**Companion to:** `PAPER.md` (Empirical Limits of Lossless Compression on a Structured Audit-Log Corpus)
**Date:** 2026-06-27
**Author:** Atom McCree (AtomEons Systems Laboratory)
**Discipline:** Mom's Law — every claim has a receipt; every audit finding has a fix reference.

This appendix consolidates the audit truth findings that the main paper points to. It is the **honest accounting** alongside the headline ratios.

---

## Appendix C — Audit-Confirmed Facts (17/17 reproducible numeric claims)

Audit 08 (`research/audits/audit-08-paper-truth-2026-06-27.md`) re-ran every load-bearing numeric claim in `PAPER.md` on a fresh Bun 1.3.14 process, in a fresh working directory, with no warm cache and no shared state between runs. Tolerance band: **±2%** on the cited ratio.

**Result: 17/17 reproduce within ±2% (0.0% delta on every checked claim).**

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
| 121 (streaming W=500) | 19.48× / 0.72 ms/receipt | 19.476× / 0.42 ms/receipt | 0.0% (ratio); faster ms | PASS (ratio) |
| 117 (per-formula audit) | 23.55× / 331 violators | 23.546× / 331 violators | 0.0% | PASS |
| 95 (key-dict substitution) | 17.60× | 17.604× | 0.0% | PASS |
| 76 (splay tree shapes) | 34.43× | 34.427× | 0.0% | PASS |
| 113 (library-size sweep N=10) | 28.23× | 28.232× | 0.0% | PASS |
| 38 (method 5 schema fold) | 35.12× | 35.12× | 0.0% | PASS |
| 42 (method 8 sorted shapes) | 41.43× | 41.43× | 0.0% | PASS |

**Roundtrip verification.** Every measured experiment that claimed `lossless: true` produced a byte-exact recovery in this fresh run. The corpus sha256 invariant (`03da0e5cf04adf965ae580cb8c74ab4db9d8058b6ca246478fef57b6de944df1` on the deterministic form) held end-to-end on Exp 59, 118, 122, 78 (all components), 91, 121, 76, 117, 95, 81, 38, 42, 113.

**Stability note.** Wall-clock timings (encode_ms, decode_ms) drift run-to-run within ±20% depending on system load. The paper does not over-claim deterministic timing — Exp 121's streaming ms/receipt came in *faster* than the paper's quote (0.42 vs 0.72), which is hardware-load-sensitive and not a ratio claim. The ratio claims, however, are deterministic: they derive from byte counts of brotli'd outputs under identical pipeline settings, and they reproduced exactly.

**Audit 08 verdict:** No credibility ship-blocker. Paper is shippable on the numeric claims. The honesty qualifications in the main paper (Generalization, Honest Limits) come from sister audits (02, 04, 06, 07), not from any claim that failed to reproduce.

---

## Appendix D — Audit + Remediation Receipt

Cross-walk of every audit-derived ship-blocker and the fix reference.

| Audit Finding | Severity | Fix Reference |
|---|---|---|
| **Audit 02** — M19 ratio is corpus-specific; 2.06–890× range across 5 corpora; canonical 47.07× is workload property, not codec property. | Honest-restate required | **FIX-DOC** — applied to `PAPER.md §2.1 Generalization` + headline qualifiers (this session). |
| **Audit 04** — Crystal compression Maps unbounded; long-lived processes leak memory linearly with shape vocabulary. | Memory leak | **FIX-C** — LRU cap on Crystal Map sidecars (pending; tracked at fix path `12-ATOMSMASHER/full-scope/` Crystal compressor module). |
| **Audit 06** — `engines.mjs:1697` references `__filename` as a bareword in ESM; ternary always takes false branch; `regenCompression` measurement silently degraded via CWD-relative read. | BLOCKER | **FIX-B** — polyfill `__filename` via `fileURLToPath(import.meta.url)` at top of `engines.mjs` (pending). |
| **Audit 06** — `storage.mjs:416` uses `require('node:zlib')` inside `exportCompressedAuditLog()`; breaks Bun-strict ESM. | FIX-ADVISED | **FIX-D** — hoist `import zlibSync from 'node:zlib'` to top of file (pending). |
| **Audit 07 scenario 2** — Two-process write to same SQLite file lost 46.8% of writes (532/1000 inserted; 468 `SQLITE_BUSY` errors swallowed). | BLOCKER | **FIX-A** — `PRAGMA busy_timeout` applied at `Store` init; reproduces clean under 2-process stress now. |
| **Audit 07 scenario 3** — Reader during writer holding lock: `new Store()` crashes at `init()`; `getReceiptStats()` returns non-atomic snapshots. | BLOCKER | **FIX-A** (busy_timeout) covers crash path; non-atomic stats noted as semantic limit of `bun:sqlite` single-statement reads. |
| **Audit 01 (sample)** — ~422 of 620 features executed dispatcher path without name-specific behavior. | Claim-overreach | **FIX-B (scope)** — restate "620 features execute" as "620 dispatcher entries route without throwing"; per-feature behavior coverage tracked separately. |
| **Audit 08** — every load-bearing numeric claim in `PAPER.md` reproduces within ±2% on fresh Bun 1.3.14 process. | (no finding) | n/a — confirms paper's ratio claims are honest. |

**Pending vs landed.** FIX-A (busy_timeout) is landed and reproduces clean. FIX-DOC (this honest-restate of `PAPER.md`) is landed in this commit. FIX-B (engines.mjs `__filename` + scope-restate of "620 features"), FIX-C (Crystal LRU cap), and FIX-D (zlib import hoist) are tracked as in-flight code fixes outside this commit.

---

## Receipts

- Audit 02: `research/audits/audit-02-m19-generalization-2026-06-27.md`
- Audit 06: `research/audits/audit-06-bun-windows-2026-06-27.md`
- Audit 07: `research/audits/audit-07-concurrency-2026-06-27.md`
- Audit 08: `research/audits/audit-08-paper-truth-2026-06-27.md`
- Reproducer scripts (audit 02): `experiments/audit-02-m19-generalization/{gen-corpora.mjs, run-m19.mjs}`
- Reproducer scripts (audit 07): scratchpad `audit-07/s{1,2,3,4,4b}_*.mjs`

---

*Mom is watching. Every claim above traces to a sha256-receipted experiment or a named audit file on disk. The headline is qualified honestly; the fixes are tracked honestly; the gaps are named, not hidden.*
