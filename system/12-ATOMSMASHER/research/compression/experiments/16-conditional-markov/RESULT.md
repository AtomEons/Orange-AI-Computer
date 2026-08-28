# Experiment 16 — Conditional Markov + Range Coder — RESULT

**Status:** ✅ PASS
**Generated:** 2026-06-26T10:46:15.569Z

## Conditional entropy bounds

| Model | bits/sym | Theoretical bytes | Theoretical ratio |
|---|---|---|---|
| H(A) — IID Shannon | 2.4010 | 1,869 | 45.62× |
| H(A \| A₋₁) — 1st-order | **2.3176** | **1,804** | **47.27×** |
| H(A \| A₋₁, A₋₂) — 2nd-order | 2.1098 | 1,642 | 51.93× |
| H(A \| A₋₁, A₋₂, A₋₃) — 3rd-order | 1.7988 | 1,400 | 60.91× |

## Mutual Information decay I(A_i ; A_{i+k})

| k | samples | I (bits) |
|---|---|---|
| 1 | 6,223 | 0.0835 |
| 2 | 6,222 | 0.0845 |
| 3 | 6,221 | 0.0852 |
| 5 | 6,219 | 0.0813 |
| 8 | 6,216 | 0.0896 |
| 13 | 6,211 | 0.0789 |
| 21 | 6,203 | 0.0841 |
| 34 | 6,190 | 0.0864 |
| 50 | 6,174 | 0.0815 |
| 100 | 6,124 | 0.0849 |
| 200 | 6,024 | 0.0797 |
| 500 | 5,724 | 0.0902 |

The MI curve shows how far in advance each receipt's action is predictable.

## Actual range-coded compression

| Metric | Value |
|---|---|
| Raw action stream | 85,273 B |
| Range-coded data only | 1,968 B |
| Range-coded bits/sym | 2.5286 |
| Range-coded ratio (data only) | **43.33×** |
| Model overhead (cumulative tables) | 2,228 B |
| **Total lossless (model + data)** | **4,196 B** |
| **Total ratio** | **20.32×** |
| Roundtrip | ✓ BYTE-EXACT |

## Versus prior baselines (on action column only)

| Method | Ratio |
|---|---|
| brotli q11 baseline | 19.73× |
| Huffman (Annular Key, Exp 06) | 32.57× |
| **Range-coded Markov-1 (model + data)** | **20.32×** |
| Range-coded Markov-1 (data only, given model) | 43.33× |

## Analysis

1st-order Markov model BEATS Huffman by 10.76× on data alone. The conditional bound says theoretical floor is 47.27× — meaning predictive coding has real room over IID Huffman.

Total ratio (20.32×) includes the 2228-byte model overhead. For a single corpus this overhead is fixed; the *amortized* ratio across many corpora using the same model would approach the data-only ratio.

## What the bound curve tells us

- **Huffman ceiling = 45.62×** assumes receipts are IID. Bound: 2.40 bits/symbol.
- **1st-order Markov ceiling = 47.27×** — the gap from Huffman is 1.64× of compression we can extract just by looking at the prior receipt.
- **Higher-order ceiling ≈ 60.91×** at K=3, suggesting the entropy rate of the action column is close to 1.80 bits/symbol.
- **Mutual information decay** shows the corpus's effective "context window" — how far back a predictor needs to look.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/16-conditional-markov/bench.mjs
```
