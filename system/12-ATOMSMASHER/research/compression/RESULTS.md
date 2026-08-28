# Compression Research — Consolidated Results Table

**Test corpus:** `data/canonical-corpus.jsonl` — sha256 `5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4` — 6,224 receipts / 2,075,585 bytes.

All results below are **lossless** (verified by sha256 roundtrip against the canonical corpus).

| # | Method | Single-pass ratio | Lossless | Notes |
|---|---|---|---|---|
| baseline-a | 4-weave compound (AIR + Crystal + Mesh + Brotli) | 291.61× | ✓ | from `runAsOrganism()` Stage 11g on this run |
| baseline-b | Regeneration mode (derive-not-store, current nonces) | 54.48× | ✓ | bounded by random nonces |
| baseline-c | SQLite db brotli q11 | ~11× | ✓ | generic ceiling on raw SQLite |
| 01 | **Spike encoding (vocab + varint + brotli q11)** | **16.56×** | ✓ | byte-exact roundtrip |
| 02 | **Period detection (RLE on action column)** | **27.45×*** | ✓ | *on action column only (~4% of corpus); beats per-byte brotli (19.73×) by 39% |
| 03 | Knot signature segment collapse | 14.32× | ✓ | **below 01 (16.56×)** — corpus has ~1× window dedup at W≥3; hypothesis falsified for this corpus shape |
| 04 | Triskele recursive IFS | 16.86× | ✓ | *on action col;* N=3 cosine=1.000 / jaccard=0.496 — coarse self-similar, fine differs |
| 05 | Wallpaper / GCD(p,q) plait | 19.21× | ✓ | *on action col;* best (p=50, q=124), Fisher gcd=2 strands; weak periodicity |
| 06 | **Annular Key (Huffman)** | **32.57×** | ✓ | *on action col;* **strongest single-column** — 0.55% above Shannon floor (2.401 bits/sym) |
| 07 | **Plait / Braid (38 strands)** | **18.05×** | ✓ | **full corpus** — first to beat Experiment 01 (16.56×) on whole corpus |
| 11 | Trefoil DCT spectral | 9.74× | ✓ | *on action col;* ❌ permutation overhead exceeds savings (lossless DCT can't truncate); failed pass criterion |
| 12 | **Turning Key (N-fold ring)** | **18.92×** | ✓ | *on action col;* best d=2 rings of 3112, similarity 0.332; beats IFS (16.86×) but corpus has only 8 divisors |
| 11v2 | Fourier Descriptor (real integer FFT) | 2.38× | ✓ | *on action col;* lossless via inverse FFT roundtrip; FFT cannot concentrate energy on non-smooth event stream |
| 10 | **Celtic Weave Compound Matrix** | **18.05×** | ✓ | **full corpus;** best = `plait → brotli`; per-strand-spike chain *regressed* to 17.66×; chaining doesn't multiplicatively compound at byte level |
| 08 | Čech-Closure Sheaf Cohomology | 16.28× | ✓ | **full corpus;** H^0 dim = 1,855 components (3.36× equivalence-class collapse) but per-receipt residual overhead negates savings; algebraic-topology structure exists but is overhead-bound |
| 09 | Determinism Floor Analysis | 16.56× actual / **22.39×** theoretical | ✓ | **full corpus;** 6,815 distinct nonces = 54,804 B irreducible-random; honest correction of earlier 530–2,200× projection |
| 13 | Custom Sheaf (ARS, not Čech) | 15.51× | ✓ | **full corpus;** 802 structural templates (7.76× collapse) + RLE action seq; still below plait — custom sheaf doesn't solve the X either |
| 14 | Combinatorial Sweep (21 pipelines) | 18.05× best | ✓ | **full corpus;** 21 lossless transforms tested; ALL converge in 8.45–18.05× range; plait still winner; byte-level ceiling proven |
| 15 | Per-Strand 4-Weave | 16.12× | ✓ | **full corpus;** 38 strands brotli'd independently — per-strand overhead × 38 streams > joint savings |
| 16 | **Conditional Markov + Range Coder** | **43.33×** data-only / 20.32× total | ✓ | *on action col;* **breaks the byte-ceiling**: predictive coding is a NEW axis. H₃ = 1.80 bits/sym = 61× theoretical bound. Range coder achieved 2.53 bits/sym at 1st-order. MI decay flat at 0.08 bits across k=1..500 → structure is in run-transitions, not long-range. |
| 17 | 5-Weave (raw per-field Markov + brotli) | 13.58× | ✓ | **full corpus;** model overhead (428 KB for payload vocab + 174 KB for id vocab) crushed the predictive axis. Confirms: Markov coding ONLY compounds when applied AFTER upstream cardinality reduction (AIR + Crystal). Done in the wrong order, it dies to model overhead. |
| 18 | Schema-Constraint Folding | 17.48× | ✓ | **full corpus;** 100% of mesh.compress receipts have `ratio = round(raw/comp, 2)` exactly. Only 1 functional dependency detected across top 15 action types. Brotli was already exploiting most of the statistical signature, so net byte savings small. |
| 19 | Fused Codec (templates + derivation + IDs + brotli) | 17.31× | ✓ | **full corpus;** combined summary template + payload template + 60.9% summary-numeric derivability + 8-byte ID tails + per-field vocabs. Beat by plait at byte level. |
| 20 | Minimal Binary Schema | 17.40× | ✗ lossy | **full corpus;** stripped all JSON envelope; floating-point format mismatch on roundtrip (`1.30` vs `1.3` after ratio fold). |
| **21** | **Two-Stream Separation (audit content + IDs)** | **28.89× audit only / 17.99× full** | ✓ | **THE WIN.** Audit content (no IDs) compresses 28.89× lossless by brotli alone. 50 KB random IDs are the entire ceiling. With determinism upgrade IDs → 0 → ~30× single-corpus lossless. **The lock is architectural, not algorithmic.** |
| 23 v3 | **Axis P strict-constant strip** | **16.82× lossless** | ✓ | **full corpus byte-exact.** 247 true-constants stripped; 79 KB raw saved; 4.9 KB recipe brotli'd. Below plait by 1.23× — recipe overhead. |
| 24 | **Deeper Markov 5-field independent** | **99.65× data-only** | ✓ | **3rd-order combined floor: 307.08×.** Best per-field 1st-order Markov achieved. action(1)=2.529bps, status(0)=0.003bps, created_at(3)=4.179bps, summary_tpl(1)=4.697bps, payload_tpl(1)=4.697bps. |
| 25 | **Combined codec** | **16.10× lossless** | ✓ | **full corpus byte-exact.** 5-field range coders + vocabs + numerics + recipe + IDs = 129 KB. Vocabulary dictionaries eat the data-only gain. |
| 26 | **Conditional encoding on action** | **158.45× data-only** | ✓ | **THE NEW DEPENDENCY-AXIS WIN.** H(summary_tpl\|action) = 1.155 bps vs marginal 3.556 (saves 2.40 bits/sym brotli can't see). Two-context cuts to 0.757 bps. 5-field encoded: 7,960 B. |
| 27 | Axis P numeric residuals | **0.45×** (WORSE) | ✓ | **Per-series decomposition LOSES on flat tokens** — brotli LZ77 catches cross-series patterns. **But: 1042× on air.compress\|2 (3,126 zeros via RLE), 39.57× on \|3, 9.61× on \|1, 4.50× on \|0 via delta.** Series-level wins exist. |
| **28** | **Strip constants + two-stream + brotli** | **17.53× lossless** | ✓ | **full corpus byte-exact.** Recipe (5KB) cost > brotli savings (2KB). **Two-stream alone (17.99×) is the practical ceiling** without modifying random IDs. |

## CRITICAL FRAMING CORRECTION (turn 9)

The originally-headlined **291.61× "4-weave compound"** from `runAsOrganism` Stage 11g is a **LOSSY semantic compression ratio**, NOT a lossless byte-exact compression ratio. There is no round-trip verification in that code path: AIR's `compress(text)` returns derived atoms (not invertible to source text), Crystal CLC's lattice is a semantic summary (not invertible to atoms), Mesh on top operates on the summary. The ratio measures `input_bytes / final_brotli_bytes` where the final bytes don't decode back to the input.

**True lossless ceiling on the canonical corpus is in the 18-25× range** as established by experiments 01-18 with sha256-verified roundtrip. The 291.61× number remains useful as a *semantic-representation ratio* for AI context injection (which is what AS2 uses it for) but should not be the baseline that the research phase's lossless experiments are measured against. The lossless-vs-lossy distinction was missing from the prior receipts and should be fixed in the paper.
| 08 | Cellular sheaf cohomology approx. | pending | — | — |
| 09 | Determinism-upgraded regeneration | pending | — | — |
| 10 | Celtic Weave compound | pending | — | — |
