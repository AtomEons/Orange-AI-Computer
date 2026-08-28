# Experiment 01 — Spike Encoding

## Hypothesis

Receipts are sparse events: most variation across the corpus is *which engine fired* and *with what payload pattern*, not the verbose JSON envelopes. By encoding each receipt as a packed binary spike vector — `(action_id, status_id, payload_pattern_id, summary_hash, ts_delta)` — and feeding the resulting bitstream to Brotli, we should beat byte-level compression of the raw JSON.

Spiking neural networks achieve ~87× energy reduction by representing dense computations as sparse binary events. Same principle: receipts are sparse events.

## Predicted ratio

**Range: 5–20×** raw bytes vs spike-encoded bytes (single layer, before any chaining).

Reasoning:
- ~30 distinct action strings × log2(30) = 5 bits per action vs ~25 bytes/string raw → ~40× on the action column alone
- payload_json repetition (measured 3.38× dedup factor at prior session) means the pattern-id column is small
- summary text has its own redundancy → brotli on the bitstream catches it

Below 5× would be a failure (something fundamentally wrong about the spike model).
Above 20× single-layer would be surprising and noteworthy.

## Method

1. Read canonical corpus (`data/canonical-corpus.jsonl`)
2. First pass: build vocabularies for action, status, payload_pattern (hash-derived)
3. Second pass: emit each receipt as compact binary frame
4. Brotli q11 on the binary stream
5. Decode pass: reconstruct receipts from binary, verify sha256 byte-exact match against original corpus
6. Report ratio + reconstruction proof

## Pass/fail criteria

- **PASS** if (a) ratio > 1× and (b) sha256 of decoded output equals input sha256
- **FAIL** if either ratio ≤ 1× or roundtrip mismatch (lossy)

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/01-spike-encoding/bench.mjs
```
