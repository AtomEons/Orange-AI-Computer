# Experiment 03 — Knot Signature Segment Collapse

## Hypothesis

In Celtic knotwork and braid groups, two diagrams that produce identical knot polynomials (Jones, Alexander, HOMFLY) are topologically equivalent and can be reduced to one canonical form via Reidemeister moves.

Applied to receipt streams: **contiguous N-receipt windows that produce identical structural signatures are topologically equivalent and can be collapsed.** Stronger than byte-identical dedup (which only catches exact-match payloads) because it catches *semantically equivalent sequences regardless of internal byte differences*.

The signature for an N-window:
- ordered tuple of action_ids
- ordered tuple of status_ids
- ordered tuple of payload_pattern hashes
- canonical structural fingerprint = sha256 of the above

If two windows have identical fingerprints → store once, reference N-1 times.

## Predicted ratio

**Range: 1.5–10× on top of spike encoding.**

Reasoning:
- The payload dedup factor measured earlier was 3.38× (every payload appears ~3.4× across the run)
- But payloads come in temporal *clusters* (e.g. mesh.compress burst), so sliding windows of size 3-10 should match the cluster repetition
- Higher than byte-dedup because windows of e.g. 5 mesh.compress receipts produce the same structural signature even when individual payloads differ slightly in numerics

## Method

1. Read canonical corpus
2. For each window size W ∈ {2, 3, 5, 8, 13}, compute fingerprints for sliding windows
3. Count distinct fingerprints per W
4. Best W = max savings (lowest distinct/total ratio)
5. Encode: distinct windows stored once + per-position index varint
6. Brotli q11 on the result
7. Roundtrip verify

## Pass criteria

PASS if knot-signature dedup beats spike-encoding alone (16.56×) on the same corpus.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/03-knot-signature/bench.mjs
```
