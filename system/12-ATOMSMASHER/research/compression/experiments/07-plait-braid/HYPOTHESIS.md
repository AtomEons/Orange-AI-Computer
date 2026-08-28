# Experiment 07 — Plait / Braid Encoding (multi-strand interleave)

## Hypothesis
Receipts come from multiple "engines" (action prefix is the strand identifier: mesh.*, air.*, crystal.*, equation.*, etc.). Each engine produces an independent sub-stream that is highly compressible on its own. Reassembling the full corpus requires the per-position strand-identifier sequence + each per-strand stream. Splitting + compressing separately may beat joint compression.

This is plait / braid encoding: each strand is its own thread; the receipts log is the interleave.

## Predicted ratio
3–15× compared to joint encoding. Per-strand streams have very high internal redundancy (mesh.* all look like {raw_bytes, compressed_bytes, ratio}, air.* all look like {ratio, atom_count, ...}).

## Pass criterion
PASS if plait encoding (strand-id seq + per-strand streams, all brotli'd) + lossless roundtrip beats Experiment 01's full-corpus 16.56×.
