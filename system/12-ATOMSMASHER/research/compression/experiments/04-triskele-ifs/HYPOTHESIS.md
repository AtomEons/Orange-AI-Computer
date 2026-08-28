# Experiment 04 — Triskele / IFS Recursive Self-Similarity

## Hypothesis
N-fold partition (2, 3, 4) of the receipt action sequence may exhibit self-similarity: each part has the same coarse shape, differing only in residual detail. If parts overlap structurally, encode as (fundamental_part_template, residual_diffs_per_part).

The triskele (3-fold) is the canonical Celtic spiral. If receipts come in 3-phase bursts (e.g. organism stages × repeated work × cooldown), 3-fold IFS may collapse the corpus by ~3×.

## Predicted ratio
2–8× compound with Experiment 01's spike baseline (16.56×). Standalone test measures the self-similarity, not the full corpus encoding.

## Pass criterion
PASS if any N-fold split yields per-part action-distribution similarity ≥ 0.8 (Jaccard) AND the IFS-encoded action stream + brotli ≥ 5× vs raw action stream.
