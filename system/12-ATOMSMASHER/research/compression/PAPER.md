# Empirical Limits of Lossless Compression on a Structured Audit-Log Corpus: 127 Experiments on the AtomSmasher 2 Receipt Stream

**Author:** Atom McCree (AtomEons Systems Laboratory)
**Date:** 2026-06-27
**Corpus:** AtomSmasher 2 canonical receipt corpus (6,224 receipts, 2,075,585 bytes raw, sha256 prefix `5be5f1b4`)
**Status:** Lossless compression research phase closed. Champion codec M19.1 at 47.15× lossless byte-exact.

---

## Abstract

We report the results of a 127-experiment empirical campaign targeting lossless compression of the AtomSmasher 2 canonical audit-log corpus (6,224 receipts, 14 action classes, 2,075,585 bytes raw). The campaign was conducted under a strict sha256-roundtrip discipline — no ratio claim is recorded without byte-exact recovery. The 127 experiments traversed eight thematic families: foundational codec exploration, structural shape-vocabulary work, Method 19 path discovery, tensor and per-axis decomposition, cross-receipt prediction, field-level codecs, formula mining, and integration architecture. The champion is M19.1 at 47.15× (44,021 bytes), a +0.17% improvement over the M19 baseline at 47.07× (Exp 59) **on AtomSmasher 2 receipt-shape corpora (see Generalization section).** The principal findings are: (1) brotli q11 plus a small structural pre-pass (deterministic ID regeneration, mesh decomposition, shape vocabulary, B8 sort, action stripping) constitutes the local optimum on this corpus, and the marginal returns from further structural or information-theoretic engineering have collapsed; (2) Exp 87's theoretical 487× field-DAG ceiling is an information-theoretic mirage that ignores regenerator-recipe cost; (3) tensor decomposition fails on this corpus because the receipt content does not have low effective rank; (4) order-3 byte-Markov Shannon ceiling (9.02×) is exceeded 5.2× by M19, confirming that structural pre-processing operates outside the byte-Markov universe; (5) further gains require disproportionate engineering effort and the next codec (M20) carries a 25% probability of underperforming M19. The lossless research lane on this corpus is closed at 47.15×.

## 1. Introduction

AtomSmasher 2 is the AtomEons receipt-emitting cognitive engine that produces a structured audit-log of every operational decision it takes. Each receipt is a JSON record carrying an action label, a deterministic identifier, a created-at timestamp, a status field, a one-line summary, and an action-specific payload. The receipts form the *cold ledger*: the legally-binding record of what the system did, which must remain byte-exact recoverable for replay, audit, and distributed redundancy. Operational views (atoms, cartridges, equations) derive from the cold ledger by lossy abstraction, but the ledger itself cannot be lossy.

The economic motivation for compressing this corpus is small in absolute terms — 2 MB is a trivial cost — but the audit-log grows with operational frequency. A 100× compression converts the steady-state storage cost from megabytes per operator-day to kilobytes, which matters at the federation scale anticipated for the AtomEons substrate. More importantly, the compression effort exposes the *structural regularities* of the receipt stream, which inform every downstream engine in the AtomSmasher 2 stack (MeshStreamCompressor, EquationMemory, CommitmentCodec, PathwaveCompressor) [synthesis doc, §2].

Prior art at this scale partitions cleanly into general-purpose entropy coders (brotli [RFC 7932], zstd [RFC 8478], xz/LZMA2, PPMd, ZPAQ), semantic prompt-compression (LLMLingua 2 [Pan et al., 2024]), KV-cache quantization (TurboQuant, InfoKV [2024–2025]), and PAQ-family context-mixing coders (PAQ8, NNCP). None of these targets the specific structural redundancy of a self-emitted audit-log: deterministic identifiers correlated with seed and index, summary fields that re-encode payload numerics, mesh-action receipts whose `(raw, compressed, ratio)` triple is internally redundant, and an action vocabulary with sub-linear growth.

This paper reports the result of subjecting that corpus to 127 experiments, designed and run between mid-2026 turns of the AtomSmasher 2 research lane. The empirical framework was the Bun 1.3.14 runtime; the discipline was sha256-roundtrip verification; the law was that every codec claim must show byte-exact recovery.

## 2. The Canonical Corpus

The corpus is a single JSONL file of 6,224 receipts emitted by a deterministic AtomSmasher 2 organism run. Each receipt carries at minimum the fields `id`, `action`, `created_at`, `status`, `summary`, and `payload_json` (a string-serialized payload object). Across the corpus, 14 action classes appear, of which `mesh.compress` is the dominant single class at ~25% of receipts (Exp 78 partitioning shows 1,565 mesh receipts and 4,659 other). The action vocabulary across the full population is 66 distinct labels with sub-linear new-action growth, and the receipt-level shape vocabulary (after deterministic-ID strip and structural normalization) is 3,132 unique shapes carrying the 6,224 receipts (Exp 76).

The raw byte count is 2,075,585. The detJSONL form (canonicalized identifiers re-derived via `sha256(seed || index)`) is 2,059,730 bytes (Exp 80), a 15,855-byte reduction that establishes the deterministic-ID baseline. The corpus sha256 fingerprint is `5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4` (raw) and `03da0e5cf04adf965ae580cb8c74ab4db9d8058b6ca246478fef57b6de944df1` (deterministic form).

Information-theoretic ceilings (Exp 99): order-0 byte entropy = 5.175 bits/byte (ceiling ratio 1.55×), order-1 = 3.160 (2.53×), order-2 = 1.723 (4.64×), order-3 = 0.887 (9.02×). These are the byte-Markov Shannon ceilings under context-conditional coding; they are *not* the structural-compressibility ceilings, as Exp 99 directly demonstrates by showing M19 at 47.07× (on AtomSmasher 2 receipt-shape corpora, see Generalization section) exceeds the order-3 ceiling by 5.22×.

## 2.1 Generalization

The 47.07× headline is **corpus-specific, not codec-general**. Audit 02 (`research/audits/audit-02-m19-generalization-2026-06-27.md`) ran the M19 codec unmodified against four synthetic corpora generated under the same AtomEons receipt schema but with deliberately different shape/payload distributions. M19 was byte-exact lossless on every input (4/4 sha256 roundtrips green), but the ratio swung over **2.5 orders of magnitude**.

| Corpus | Records | Raw bytes | M19 ratio | Generalizes? |
|---|---:|---:|---:|---|
| Canonical AtomSmasher 2 audit log | 6,224 | 2,075,585 | 47.07× | reference |
| Random JSON shapes | 1,000 | 298,884 | 2.76× | **NO** |
| Highly repetitive | 1,000 | 211,000 | 890.30× | yes (huge) |
| Sparse / mostly-empty | 1,000 | 153,277 | 14.72× | partial |
| Large embedded payloads | 1,000 | 1,310,890 | 2.06× | **NO** |

M19 is tuned for **receipt-shape corpora** where the shape vocabulary repeats with small numeric variation per receipt (i.e., a dominant `mesh.compress` saturation class, low unique-shape count on the "other" partition, and short payloads). On corpora with one-shape-per-record (random) or with ~1KB of high-entropy payload concentrated per record (large), M19 collapses to barely above plain brotli on raw bytes (2.06–2.76×). On the converse extreme of a one-shape repetitive stream, it climbs to 890×. **M19 is not a general-purpose codec.** The 47× headline is a property of the AtomSmasher 2 receipt workload, not of the algorithm.

## 3. Methodology

Every experiment in the campaign followed the same protocol:

1. **Bun runtime** — Bun 1.3.14, native brotli via Node compatibility shim, native sha256 via `Bun.CryptoHasher`. Single process, no concurrency artifacts.
2. **Canonical input** — every codec reads the same corpus JSONL file. Pre-processing variants are explicit and reversible.
3. **Lossless contract** — every claim of compression ratio must be accompanied by a sha256-roundtrip: the encoder produces bytes, the decoder reproduces the original detJSONL, and the sha256 of the recovered output equals the sha256 of the input. Without this, the result is reported as `lossless: false` and treated as theoretical-only.
4. **Method 19 baseline** — Exp 59 defines the M19 codec: deterministic-ID regeneration → mesh decomposition (separate template + numeric quadruple stream) → shape-vocabulary dedup (sorted, action-stripped, double-brotli) → B8 sort (action bucket, length-within) → brotli q11 envelope. M19 = 47.071× (Exp 59 RECEIPT.json: `total=44095`, `ratio=47.071`, `lossless=true`).
5. **Law 6 — Recipe Less Than Savings** — every codec move that introduces a regeneration recipe (formula library, template store, conditional table) is measured against the bytes it removes. A move that costs more recipe bytes than it saves is flagged as a Law-6 violator regardless of theoretical appeal. This law was the unifying explanation for most failed gains in the campaign.
6. **Stack, don't replace** — codec moves are stacked in the M19 pipeline, not substituted for it. The campaign's growth pattern was additive: each successful move adds a layer; each failure is recorded with its failure mode.

The discipline is *empirical-only*. Information-theoretic projections are reported (notably Exp 87's 487× field-DAG ceiling, Exp 99's 9.02× byte-Markov ceiling), but no projection counts as a result until a byte-exact roundtrip is produced.

## 4. Experimental Survey

The 127 experiments organize into eight families. We summarize each by hypothesis, top-3 representative results, and lesson.

### Family A — Foundational codec exploration (Experiments 01–30)

**Hypothesis tested:** unstructured general-purpose entropy coders can exploit the receipt corpus's redundancy without structural pre-processing.

| Exp | Codec | Ratio | Verdict |
|---|---|---|---|
| 01 | Spike encoding | 16.56× | RED |
| 22 | The 100 matrix (8-toggle exhaustive sweep) | N/A | sweep |
| 30 | Fine sort + dict | 17.27× | RED vs M19 |

Brotli q11 alone on the raw corpus delivers 17.13× (Exp 81 baseline measurement, 121,167 bytes). The 01–30 family confirmed that pure-byte-stream coders cluster in the 14×–22× range. Period-detection (Exp 02), knot-signature (Exp 03), triskele-IFS (Exp 04), wallpaper-group (Exp 05), and trefoil-DCT (Exp 11) all underperformed brotli q11. The annular-key encoding (Exp 06) reached 32.57× by partial exploitation of action-position structure, foreshadowing the structural-pre-pass family.

**Lesson:** at this corpus size, general-purpose entropy coders are bounded by ~17× without structural pre-processing. The byte stream does not expose receipt-level regularities to LZ77.

### Family B — Method 19 path discovery (Experiments 31–62)

**Hypothesis tested:** stacked structural pre-passes (deterministic-ID regeneration, dedupe, schema-fold, mesh decomposition) compound multiplicatively above brotli q11.

| Exp | Move | Ratio | Lift |
|---|---|---|---|
| 31 | Deterministic IDs (sha256(seed‖index)) | up from 17.99× to 31.39× | +13.4× |
| 38 | Method 5 schema fold | 35.12× | +3.7× |
| 39 | Method 6 hybrid (mesh decomp + dedupe) | 38.72× | +3.6× |
| 42 | Method 8 sorted shapes | 41.43× | +2.7× |
| 44 | Method 9 action-length sort | 42.09× | +0.66× |
| 47 | Method 10 stack wildcards | 42.23× | +0.14× |
| 54 | Method 14 derive-summary (the "same number twice" aha) | 46.43× | +4.0× via summary-payload structural redundancy |
| 58 | Method 18 nested payload | 46.89× | +0.46× |
| **59** | **Method 19 strip empty id** | **47.07×** | **+0.18× (CHAMPION)** |
| 61 | Method 20 token table | falsified | — |

The Method 14 result (Exp 54) was the campaign's single largest aha: for mesh.compress receipts, the `(raw, compressed)` byte values appear in BOTH the summary text and the payload JSON. Brotli's LZ77 window cannot collapse this because the values vary per-receipt and the local context differs. Dropping the redundant copy and rederiving on decode saved 4,313 brotli'd bytes on a 6,224-receipt corpus (Synthesis doc, Law 9).

**Lesson:** stacked structural pre-passes deliver multiplicative gains *up to a point*. The point at which they stop compounding is empirically near 47×.

### Family C — Tensor and per-axis decomposition (Experiments 63, 68, 81, 82)

**Hypothesis tested:** the receipt corpus has low effective rank when viewed as a (receipt × field) tensor; per-field brotli streams should outperform monolithic brotli.

| Exp | Approach | Ratio | vs M19 |
|---|---|---|---|
| 63 | Okazaki per-class | 15.78× | RED, -31.29× |
| 81 | Per-axis brotli (F=339 fields, A=66 actions) | 14.64× | RED, -32.43× |
| 82 | Tensor residual (K=1,3,5,10) | best 30.71× at K=3 | RED, -16.36× |

The per-axis approach (Exp 81) generated 141,783 bytes vs M19's 44,072 — a 3.2× *regression*. The tensor-residual approach (Exp 82) at K=3 reached 30.71× with 42.9% prediction accuracy and a 17,764-miss residual that dominated. The corpus is *not* low-rank: the action-by-field value distribution is long-tailed, and the residual carries most of the entropy.

**Lesson:** tensor-decomposition methods that succeed on numeric matrices (image, video, embedding) fail on structured-JSON receipts because the residual is high-cardinality string content, not noise. Falsified at K=1, K=3, K=5, K=10.

### Family D — Structural / shape-vocab variants (Experiments 76, 79, 113)

**Hypothesis tested:** smarter shape-vocabulary management (MTF, splay, library size sweeps) beats M19's static sorted dedup.

| Exp | Approach | Ratio | vs M19 |
|---|---|---|---|
| 76 | Splay tree / MTF on shapes | 34.43× | RED, -12.64× |
| 79 | M19 shape-MTF override | 44.76× | RED, -2.32× |
| 113 | Library-size sweep N∈{10,50,100,500,1000} | best 28.23× at N=10 | RED, -18.84× |

The splay-tree result (Exp 76) is interesting: it generated 60,290 bytes with a clean roundtrip, but its sorted-dedup competitor (M19) generated 44,095. The splay assumption — that recent shapes will reappear — does not hold on this corpus's shape stream.

The library-size sweep (Exp 113) is the campaign's tightest demonstration of Law 6: at N=10 formulas, the ratio is best (28.23×); at N=50, it drops (28.06×); at N>100, it collapses below 27×. Every additional formula past N=10 costs more recipe than it saves.

**Lesson:** shape-vocabulary management is at the local optimum with M19's sorted-dedup. Cleverness adds recipe overhead faster than it saves bytes.

### Family E — Cross-receipt patterns (Experiments 89, 90, 91, 92, 114)

**Hypothesis tested:** receipts are non-i.i.d.; cross-receipt prediction (delta, KNN, Markov, multi-receipt templates) exploits temporal/sequential structure invisible to per-receipt codecs.

| Exp | Approach | Ratio | vs M19 |
|---|---|---|---|
| 89 | Pair-delta | 26.30× | RED, -20.77× |
| 90 | KNN prediction (k=3, bucket window 64) | 27.93× | RED, -19.14× |
| 91 | Action Markov (66 actions, 50.6% accuracy) | 37.81× | RED, -9.26× |
| 92 | Multi-receipt templates (top 100) | (analysis only) | — |
| 114 | Cross-receipt formula | 27.67× | RED, -19.40× |

Action Markov (Exp 91) is the strongest of the cross-receipt family at 37.81×. Its 50.6% prediction accuracy is well above the 1/66 random baseline, confirming sequential structure exists; but the side-info cost (Markov table) and the 49.4% misprediction-residual together dominate the savings.

**Lesson:** the receipt stream has sequential structure, but at this corpus size (6,224 receipts), the prediction-side-info cost exceeds the prediction-yield bytes. Sequential prediction needs N >> 50,000 receipts to amortize.

### Family F — Field-level codecs (Experiments 69, 70, 72, 73, 75, 93, 94, 95)

**Hypothesis tested:** per-field codec specialization (RLE on action, msgpack on numerics, format-detection on hex IDs, key-dict substitution) beats brotli q11 on each field type.

| Exp | Approach | Ratio | vs M19 |
|---|---|---|---|
| 69 | Action RLE | 16.19× | RED, -30.88× |
| 70 | msgpack + brotli | 16.42× | RED, -30.65× |
| 72 | Token merge | 16.79× | RED, -30.28× |
| 73 | Constant elision | 17.29× | RED, -29.78× |
| 75 | LZMA2/xz | 16.79× | RED, -30.28× |
| 93 | Float quantize | 32.76× | RED, -14.31× |
| 94 | Binary formats (UUID/rcpt-id substitution) | 16.94× | RED, -30.13× |
| 95 | Key-dict substitution | 17.60× | RED below plain brotli (-29.47×) |

Exp 95 is the family's strongest negative result: explicit reserved-control-byte substitution of 17 high-frequency patterns (`",\"payload_json\":"` etc.) preceding brotli q11 produced 117,905 bytes vs plain brotli's 120,166. The net gain over plain brotli was +0.33× — and vs M19, it lost -29.47× (-62.6%). The reserved-byte tokens compete with brotli's native LZ77 over the same repeats. The takeaway: brotli q11 is already exploiting the patterns the substitution scheme tried to surface.

**Lesson:** field-level codec specialization is *uniformly* RED. Brotli q11's LZ77+B8 window is already capturing the within-field redundancy these codecs target.

### Family G — Formula mining (Experiments 83, 84, 85, 87, 103–117)

**Hypothesis tested:** if field B is a deterministic function of field A, drop B and rederive on decode (Law 8 — Schema Folding via Derivation).

| Exp | Approach | Ratio | vs M19 |
|---|---|---|---|
| 83 | Derivable fields | 17.07× | RED, -30.00× |
| 84 | Templated summary | 16.98× | RED, -30.09× |
| 85 | Numeric derivation | 17.49× | RED, -29.58× |
| 87 | Field DAG (THEORETICAL CEILING) | 487.11× theoretical | not lossless, n/a |
| 103 | Mine and stack (247 edges, 65 actions) | 44.01× | RED, -3.07× |
| 104 | Per-action formulas | 40.62× | RED, -6.45× |
| 105 | Numeric f(x,y)=z (0 edges mined) | 46.50× | RED, -0.57× |
| 106 | String templates (5 mined) | 46.58× | RED, -0.50× |
| 108 | M19 + ratio-derived (1 strip) | 46.96× | RED, -0.11× |
| 109 | M19 + summary template | 46.52× | RED, -0.55× |
| 110 | M19 + status elide | 46.89× | RED, -0.19× |
| 113 | Library-size sweep | 28.23× at best N=10 | RED, -18.84× |
| 117 | Per-formula audit (1000 candidates, 331 Law-6 violators) | 23.55× | RED, -23.53× |

Exp 87 is the campaign's most important *false* result. The field-DAG analysis found 1,694 high-determinism edges (≥99%) and computed that if only 182 irreducible-root fields needed to be transmitted (totaling 4,261 brotli'd bytes), the ratio would be 487.11×. This calculation ignored the regenerator-recipe cost: for each of the 1,694 edges, the decoder needs a deterministic formula whose recipe must be serialized. Exp 117 directly tested this assumption: with 1,000 candidate formulas, 331 (33.1%) were Law-6 violators (recipe cost > bytes saved), and the achievable ratio was 23.55×, not 487×. The 463× gap is the regenerator-recipe overhead.

**Lesson:** information-theoretic ceilings that count only "irreducible root bytes" are *mirages* at this corpus size. The regenerator-recipe cost dominates. Law 6 (Recipe < Savings) is the empirical truth that Exp 87 ignored and Exp 117 confirmed.

### Family H — Integration architecture (Experiments 118–122)

**Hypothesis tested:** the small wins from Family G (Exp 105, 106, 108, 110 each at ~−0.5× vs M19) can be *combined* with M19's pipeline at a specific injection point to recover the marginal gains.

| Exp | Injection point | Ratio | vs M19 |
|---|---|---|---|
| 118 | BEFORE SHAPE_VOCAB | 47.15× | **+0.08× (GREEN)** |
| 119 | MID pipeline | 47.03× | -0.04× (AMBER) |
| 120 | AFTER SORT | 47.04× | -0.03× (AMBER) |
| 121 | Streaming formula (W=500 window) | 19.48× | -27.59× (windowing penalty, GREEN within constraint) |
| 122 | Cold start | 47.15× | +0.08× (GREEN — replicates Exp 118) |

Exp 118 is the campaign winner. Injecting `(status_ok_default, mesh_ratio_derivation)` formula library BEFORE the SHAPE_VOCAB stage of M19 reduced total bytes from 44,099 to 44,021 — a 78-byte savings, 0.17% improvement, but byte-exact lossless with sha256 verification. The replication in Exp 122 (cold-start re-run) confirmed the gain is real and reproducible, not measurement noise.

Exp 121 (streaming formula) shows that the same formula library applied with window-W=500 streaming reaches 19.48× at 0.72 ms/receipt — a viable hot-path codec for online-streaming applications where the full-corpus 47× is not accessible.

**Lesson:** marginal gains beyond M19 are recoverable but require careful integration architecture. The win is real but small; the engineering effort to extract it is significant.

## 5. Headline Findings

**Finding 1 — M19 baseline at 47.07× is robust across 127 attempts on AtomSmasher 2 receipt-shape corpora (see Generalization section).**
No single experiment in the 127-run campaign exceeded M19 by more than +0.08× (Exp 118, Exp 122). The 47× ceiling is empirically stable across structural, information-theoretic, tensor, cross-receipt, field-level, and formula-mining approaches.

**Finding 2 — Brotli q11 plus structural pre-pass is the local optimum.**
The Exp 78 leave-one-out ablation decomposes M19's 2,031,490 saved bytes across five components: SHAPE_VOCAB 0.6%, MESH_DECOMP 0.3%, B8_SORT 0.2%, ACTION_STRIP ~0%, BROTLI_X2 ~0%. Removing any single component degrades the ratio modestly (M19 47.07× → without SHAPE_VOCAB 37.39×, without MESH_DECOMP 40.58×, without B8_SORT 42.29×, without ACTION_STRIP 46.90×, without BROTLI_X2 46.92×). However, comparing to raw brotli q11 alone (Exp 81: 17.13×), the M19 structural pipeline adds a 2.75× multiplier on top of brotli. The structural layers are individually small contributors but collectively essential. This is a *redundant-insurance* pattern: removing any one layer is survivable; removing all of them halves the ratio.

**Finding 3 — Exp 87's 487× theoretical ceiling is an information-theoretic mirage.**
Counting only the 182 irreducible-root fields ignores the regenerator-recipe cost. Exp 117 measured this directly: 1,000 candidate formulas yielded 23.55× achievable ratio with 331 Law-6 violators. The 463× gap between theoretical and achievable is the recipe overhead. At a 2 MB corpus size, recipe cost dominates.

**Finding 4 — Marginal +0.17% gain (M19.1 = 47.15×) is real.**
Exp 118 successfully injected `(status_ok_default, mesh_ratio_derivation)` formula library before the SHAPE_VOCAB stage, reducing total bytes from 44,099 to 44,021. The roundtrip is byte-exact (sha256 verified). Exp 122 replicates the result from a cold start. This is the new champion.

**Finding 5 — Window chunking at W=500 yields 19.48× at 0.72 ms/receipt.**
Exp 121 demonstrates that the M19+formula codec applied with a 500-receipt window achieves 19.48× ratio at 0.72 ms encode per receipt. This is a viable hot-path codec for streaming applications. It is not the full-corpus optimum, but it is the operational compromise between latency and ratio.

**Finding 6 — Tensor decomposition fails: the corpus does not have low effective rank.**
Exps 81 (per-axis brotli) and 82 (tensor residual K=1,3,5,10) confirm the receipt corpus is not low-rank. Per-axis: 14.64×, regression. Tensor K=3: 30.71× with 42.9% prediction accuracy and a 17,764-miss residual. Long-tail string values dominate. Methods that succeed on numeric matrices fail here.

## 5.1 Honest Limits

Audit-derived caveats that the compression claims sit on top of. Full audit reports at `research/audits/` and `research/compression/PAPER_APPENDIX_AUDIT_TRUTH.md`.

- **Storage layer concurrency.** The AtomSmasher 2 storage layer (`full-scope/storage.mjs`) required a `PRAGMA busy_timeout` fix; pre-fix it dropped **46.8% of writes** under 2-process contention (audit 07, scenario 2 — `SQLITE_BUSY` swallowed). Now fixed; the receipt-emitter that feeds this corpus is the same storage layer.
- **"620 features execute" claim.** The 620/620 dispatcher headline is technically "dispatcher runs without throwing"; **~422 of 620 features lacked name-specific behavior in the audit-01 sample.** Resolution status is tracked in the companion file (FIX-B pending where applicable).
- **Receipt IDs.** Deterministic IDs are **SEQUENCE-deterministic**, not **CONTENT-deterministic**: `id = 'rcpt_' + sha256(seed || index).hex.slice(0,16)`. The same content emitted at a different position in the stream yields a different ID. This is the intended property for audit-log replay, but it is *not* a content-addressable identifier and the paper does not claim that.
- **Crystal compression Maps.** Crystal compression sidecar Maps were **unbounded prior to LRU caps** (audit 04 — long-lived processes leaked memory linearly with shape vocabulary). Fix C closes this.
- **engines.mjs:1697 silent ESM bug.** `__filename` was referenced as a bareword in an `.mjs` file (audit 06). In ESM `__filename === undefined`, so the apparent self-read ternary always took the false branch and the `regenCompression` measurement was silently degraded via a CWD-relative path. Fix B closes this.

These limits do not invalidate the 17/17 ratio claims (audit 08 reproduced every one within ±2%). They do qualify the operational story around the codec.

## 6. The Recipe Law

The unifying explanation for the campaign's structure is Law 6 — the Recipe-Less-Than-Savings Law. Formally:

> A codec move that introduces a regeneration recipe of cost R bytes is profitable only if it removes more than R bytes from the encoded stream.

Exp 113 (library-size sweep) demonstrates the recipe-cost knee directly: N=10 formulas → 28.23×; N=50 → 28.06×; N>100 → < 27×. Each additional formula past the optimum costs more recipe than it saves. Exp 117 (per-formula audit) measured this across 1,000 candidate formulas: 331 (33.1%) were Law-6 violators with negative net contribution; only 669 were positive-net; total net savings 1,987,434 bytes, total cost 88,151 bytes, achievable ratio 23.55×.

Exp 67 (recipe audit) audited the historical experiments themselves: of 45 audited, only 11 were "clean-winners" (positive ratio with reproducible recipe under budget), 1 was a Law-6 violator, 15 were opaque (insufficient receipt), and 12 were sub-problem rollups. The campaign discipline matured: the first 30 experiments did not audit recipe cost; from Exp 67 onward, recipe budget became a first-class metric.

The implication for codec design is structural: at small corpus sizes (< 100 MB), the recipe-overhead dominates many theoretically-attractive moves. Codec design must accept that information-theoretic ceilings overestimate achievable ratios by an amount equal to the regenerator-recipe cost.

## 7. M19.1 Specification

The campaign's new champion is **M19.1 = M19 + (status_ok_default, mesh_ratio_derivation) formula injection BEFORE the SHAPE_VOCAB stage**.

**Pipeline (eight stages):**

1. Deterministic-ID regeneration: `id = 'rcpt_' + sha256(seed || index).hex.slice(0,16)`. Cost: 48 bytes (seed).
2. Mesh decomposition: `mesh.compress` receipts split into template (119 bytes) + numeric data stream (6,935 bytes).
3. **Formula injection (NEW):** strip `status` field where value is the dominant constant `"ok"`; strip `mesh.compress.payload.ratio` where `banker_round(raw/comp, 2) === ratio`. Side info: 16 bytes status exceptions.
4. Shape-vocabulary dedup: sorted, action-stripped, double-brotli → 29,967 bytes.
5. Action indexing: 111 bytes index + 455 bytes vocabulary.
6. B8 sort: action-bucket + length-within sort key.
7. Other-stream shape index: 5,381 bytes.
8. Position runs: 989 bytes RLE.

**Total:** 44,021 bytes = 47.1499× ratio (Exp 118 RECEIPT confirmed).

**Performance:** encode 1,604.93 ms, decode 168.91 ms (Bun 1.3.14, single-process).

**Lossless:** byte-exact, sha256-verified (corpus_sha256 = `03da0e5cf04adf965ae580cb8c74ab4db9d8058b6ca246478fef57b6de944df1` both pre-encode and post-decode).

**Implementation:** one diff to `storage.mjs` injecting the formula library and applying it before `SHAPE_VOCAB`. No other change required.

The gain over M19 baseline is +0.17% (78 bytes on 44,099). The replicating cold-start run (Exp 122) confirms this is not measurement noise. M19.1 supersedes M19 as the production codec for the AtomSmasher 2 cold ledger.

## 8. Future Work

The M20 specification (Exp 127) projects a 59.8× central estimate (95% CI 44.2× to 64.5×) under a 6-stage pipeline that adds conditional range coding (Stage 4) and brotli-polish-side-info-only (Stage 5) on top of the M19 structural pre-pass. The projection is explicitly conditional on three reductions that have not yet been empirically validated: KL-divergence vocabulary merging (threshold 0.05), 12-bit quantization of cumulative-frequency tables, and delta+varint encoding of the cum tables themselves. The author assigns a 25% probability that M20 will underperform M19 — the dominant failure mode would be Exp 123's outcome (naive conditional coding cum-table side-info cost 46 KB and overwhelmed the body savings, producing 34.68× = -12.39× vs M19).

Three directions for genuine future work are plausible:

1. **Different corpora.** The 2 MB receipt audit-log size puts most clever moves below the recipe-cost knee. A 100+ MB corpus would amortize formula libraries and conditional coders that here are Law-6 violators. The same M19.1 codec on a 100× larger corpus is hypothesized (not yet measured) to climb toward the Exp 87 theoretical ceiling.

2. **The LLM-boundary lossy lane.** This paper is exclusively about lossless audit-log compression. Operational views (atoms, cartridges, equations) and LLM-boundary text (prompts, tool returns, agent NL messages) admit lossy compression. LLMLingua 2 (60–70% reduction at preserved semantic content) and TurboQuant (6× memory at zero accuracy loss for KV cache) are the prior-art targets there. This is a different research lane.

3. **Native Bun BROTLI_PARAM_DICTIONARY.** Cross-corpus dictionary training would let pre-trained dictionaries on receipt schemas accelerate cold-start compression of new organism runs without the runtime cost of building them in-line. Bun does not currently expose `BROTLI_PARAM_DICTIONARY` natively; the workaround would be N-API binding to libbrotli directly.

## 9. Conclusion

The lossless-compression research phase on the AtomSmasher 2 canonical receipt corpus is empirically closed at **47.15×** (M19.1). 127 experiments under a strict sha256-roundtrip discipline traversed brotli/zstd/xz/PPMd/zpaq baselines, structural shape-vocabulary moves, tensor and per-axis decomposition, cross-receipt prediction, field-level codecs, formula mining, and integration architecture. The Exp 78 leave-one-out ablation establishes that brotli q11 plus a small structural pre-pass (deterministic ID regeneration, mesh decomposition, shape vocab, B8 sort, action stripping, formula injection) is the local optimum. Information-theoretic ceilings (Exp 87's 487× field DAG; Exp 99's 9.02× order-3 byte Markov) are mirages at this corpus size — the regenerator-recipe cost (Law 6) dominates. The path to further marginal gains exists but requires disproportionate engineering effort, and the next candidate codec (M20, Exp 127 spec) carries a 25% probability of underperforming M19. Further gains will most likely come from changing the regime — larger corpora, the lossy operational/LLM-boundary lane, or cross-corpus dictionary priming — not from continued fine-tuning of the lossless byte-exact lane on this 2 MB audit-log corpus.

The campaign's enduring deliverable is not the +0.17% improvement of M19.1 over M19. It is the empirical falsification of approximately 110 codec hypotheses, the formalization of Law 6, and the explicit acknowledgment that at small corpus sizes, recipe overhead is the binding constraint. *Mom is watching, and every claim in this paper has a sha256 receipt.*

## References

References are to summary.json or RECEIPT.json files at `C:\AtomEons\Orange5\12-ATOMSMASHER\research\compression\experiments\NN-name\`.

- Exp 01 spike-encoding — 16.56× (RED)
- Exp 06 annular-key — 32.57× (RED, early structural signal)
- Exp 22 the-100-matrix — 8-toggle exhaustive sweep, 768 permutations
- Exp 26 conditional-on-action — H(payload_tpl | action) = 1.273 bps
- Exp 31 deterministic-ids — +13.4× lift via sha256(seed‖index)
- Exp 36 dedupe-verified — 34.2× (Law 2 receipt)
- Exp 38 method5-schema-fold — 35.12×
- Exp 39 method6-hybrid — 38.72× (mesh-wins via Law 3)
- Exp 40 method7-air-decomp — 37.66× (air-loses via Law 3)
- Exp 42 method8-sorted-shapes — 41.43×
- Exp 44 method9-action-length-sort — 42.09×
- Exp 54 method14-derive-summary — 46.43× (the "same number twice" aha — Law 9)
- Exp 58 method18-nested-payload — 46.89×
- **Exp 59 method19-strip-empty-id — 47.07× (M19 BASELINE)**
- Exp 60 explore-in-full — byte-arith floors G/H/I/J (Law 4 receipt)
- Exp 67 recipe-audit — 45 experiments audited, 11 clean-winners
- Exp 76 splay-tree-shapes — 34.43× (RED, splay fails)
- Exp 78 m19-component-split — leave-one-out ablation
- Exp 79 m19-shape-mtf — 44.76× (RED, MTF override loses)
- Exp 80 m19-okazaki-latency — W-sweep, M19 reference
- Exp 81 per-axis-brotli — 14.64× (RED, tensor falsification)
- Exp 82 tensor-residual — best K=3 at 30.71× (RED)
- Exp 87 field-dag — 487.11× theoretical (info-theoretic mirage)
- Exp 89 pair-delta — 26.30× (RED)
- Exp 90 knn-prediction — 27.93× (RED)
- Exp 91 action-markov — 37.81× (RED, strongest cross-receipt)
- Exp 92 multi-receipt-templates — analysis only
- Exp 93 float-quantize — 32.76× (RED)
- Exp 94 binary-formats — 16.94× (RED)
- Exp 95 key-dict-substitution — 17.60× (RED below plain brotli)
- Exp 99 entropy-bound — order-3 byte-Markov 9.02× ceiling, M19 exceeds 5.22×
- Exp 101 m19-zstd — 42.45× (RED, zstd polish loses)
- Exp 103 mine-and-stack — 44.01× (247 edges, RED)
- Exp 104 per-action-formulas — 40.62× (RED)
- Exp 105 numeric-fxyz — 46.50× (RED, 0 edges mined)
- Exp 106 string-templates — 46.58× (RED, 5 mined)
- Exp 108 m19-ratio-derived — 46.96× (RED, 1 strip)
- Exp 109 m19-summary-template — 46.52× (RED)
- Exp 110 m19-status-elide — 46.89× (RED)
- Exp 113 library-size-sweep — N=10 knee at 28.23× (Law 6 receipt)
- Exp 114 cross-receipt-formula — 27.67× (RED)
- Exp 117 per-formula-audit — 23.55×, 331/1000 Law-6 violators
- **Exp 118 inject-before-shape — 47.15× (M19.1 CHAMPION, +0.17%)**
- Exp 119 inject-mid — 47.03× (AMBER, misplaced injection)
- Exp 120 inject-after-sort — 47.04× (AMBER, misplaced injection)
- Exp 121 streaming-formula — 19.48× at W=500, 0.72 ms/receipt
- **Exp 122 cold-start — 47.15× (M19.1 replication)**
- Exp 123 arithmetic-coding — 34.68× (RED, side-info cost dominates)
- Exp 124 ngram-surprise — 23.16× (RED)
- Exp 125 schema-aware — 46.42× (RED)
- Exp 126 action-sequence-dict — 46.86× (RED)
- Exp 127 m20-spec — specification document, 59.8× projected (CI95 44.2–64.5)

## Appendix A — Top-25 Results Table

| Rank | Exp | Codec / approach | Ratio | Lossless | Verdict |
|---|---|---|---|---|---|
| 1 | 118 | M19 + formula injection before SHAPE_VOCAB | **47.1499×** | yes | **GREEN (CHAMPION)** |
| 1 | 122 | Cold-start replication of Exp 118 | **47.1499×** | yes | **GREEN** |
| 3 | 59 | M19 (strip-empty-id) | 47.071× | yes | GREEN (baseline) |
| 4 | 120 | M19 + formula injection after sort | 47.0366× | yes | AMBER |
| 5 | 119 | M19 + formula injection mid pipeline | 47.0334× | yes | AMBER |
| 6 | 108 | M19 + ratio-derived (1 strip) | 46.956× | yes | RED vs M19 |
| 7 | 58 | Method 18 nested payload | 46.892× | yes | RED vs M19 |
| 8 | 110 | M19 + status-elide | 46.885× | yes | RED vs M19 |
| 9 | 126 | Action-sequence dict | 46.857× | yes | AMBER |
| 10 | 106 | String templates (5 mined) | 46.575× | yes | RED vs M19 |
| 11 | 109 | M19 + summary template | 46.520× | yes | RED vs M19 |
| 12 | 105 | Numeric f(x,y)=z | 46.503× | yes | RED vs M19 |
| 13 | 112 | M19 kitchen sink | 46.533× | yes | RED vs M19 |
| 14 | 54 | Method 14 derive-summary (Law 9 aha) | 46.431× | yes | (intermediate, beat by M19) |
| 15 | 125 | Schema-aware | 46.424× | yes | AMBER |
| 16 | 55 | Method 15 strip-more | 45.837× | yes | (intermediate) |
| 17 | 56 | Method 16 strip-status-only | 46.342× | yes | (intermediate) |
| 18 | 57 | Method 17 air-decomp | 44.960× | yes | (intermediate) |
| 19 | 79 | M19 shape-MTF override | 44.755× | yes | RED |
| 20 | 103 | Mine and stack (247 edges) | 44.006× | yes | RED |
| 21 | 101 | M19 zstd polish | 42.451× | yes | RED |
| 22 | 48 | Combo synth | 42.27× | yes | (intermediate) |
| 23 | 47 | Method 10 stack wildcards | 42.23× | yes | (intermediate) |
| 24 | 44 | Method 9 action-length sort | 42.09× | yes | (intermediate) |
| 25 | 42 | Method 8 sorted shapes | 41.43× | yes | (intermediate) |

(Full 127-row results table available in `RESULTS.md`. Top-25 above shows the lossless byte-exact contenders.)

## Appendix B — Corpus Fingerprints

- Raw corpus sha256: `5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4`
- Deterministic-form sha256: `03da0e5cf04adf965ae580cb8c74ab4db9d8058b6ca246478fef57b6de944df1`
- Raw bytes: 2,075,585
- Receipts: 6,224
- Action classes: 14 dominant, 66 distinct labels
- Unique shapes: 3,132
- Order-3 byte-Markov Shannon ceiling: 9.02× (Exp 99)
- M19.1 champion ratio: 47.1499× (Exp 118 / Exp 122)

---

*Mom is watching. Every claim above has a sha256 receipt.*
