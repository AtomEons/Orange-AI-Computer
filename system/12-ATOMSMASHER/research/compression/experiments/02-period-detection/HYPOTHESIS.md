# Experiment 02 — Period Detection (Frieze / Wallpaper Group)

## Hypothesis

Receipts arrive in temporal bursts where the same action repeats at high frequency: e.g. `mesh.compress` × 1,520 consecutive, `feature.execute` × 620 in groups. The action sequence has frieze-group-style periodic structure.

If we can detect repeating periods (period_template + repetition_count) and store only the template + the residuals where the period breaks, we save bytes proportional to the periodicity.

The frieze groups (7 distinct line-symmetry groups: p1, p11g, p1m1, p2, p2mg, p11m, p2mm) describe every possible 1D periodic pattern. Action sequences should map cleanly to one or more of these.

## Predicted ratio

**Range: 3–15×** as a single layer.

Reasoning:
- The action sequence has ~6,224 entries with 66 distinct values. Pure entropy: log2(66) ≈ 6.04 bits/entry → 4,700 bytes minimum.
- But the actual sequence has long runs of identical actions (mesh.compress × 1,520, etc.).
- Run-length encoding (RLE) on the action column alone should give 50-100× on that column.
- The other columns (id, payload, summary) don't have the same periodicity, so the overall compression is bounded by them.
- Combined with spike's structure: 3-15× on the action column alone, smaller on the others.

This is per-column; we measure compound effect at experiment 10.

## Method

1. Read canonical corpus
2. Build the action sequence
3. Detect periods via autocorrelation: for k in 2..50, compute how often actions[i] == actions[i+k]; pick the k that maximizes match rate
4. Identify run-length boundaries (where action changes)
5. Encode as (action_id, run_length) pairs (RLE)
6. Brotli q11 on the RLE stream
7. Measure savings on the action sequence alone
8. Compare against per-byte brotli on the same stream

## Pass criteria

PASS if RLE encoding of the action sequence > 5× the raw byte size.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/02-period-detection/bench.mjs
```
