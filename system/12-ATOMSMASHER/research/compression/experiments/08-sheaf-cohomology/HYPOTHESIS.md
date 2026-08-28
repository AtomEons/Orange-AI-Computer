# Experiment 08 — Čech-Closure Sheaf Cohomology Approximation

## Hypothesis
Following Rieser (arXiv:2109.13867v2), build a Čech closure space on the receipts. Edges are payload_pattern equivalence (interior cover). Connected components = H^0(G; constant sheaf) = the global sections / "what is invariantly shared." Encode as (component representatives, per-receipt component_id, per-receipt non-shared residual). Brotli final.

## Predicted ratio
Higher than payload-dedup ratio (2.03× standalone) because we group ALL receipt fields by component, not just payload bytes.

## Pass criterion
PASS if total compound (with brotli) beats Experiment 07 plait/braid baseline (18.05× full corpus).
