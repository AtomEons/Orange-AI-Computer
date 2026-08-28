# Experiment 08 — Čech-Closure Sheaf Cohomology Approximation — RESULT

**Status:** ⚠️ LOSSLESS but below baseline
**Generated:** 2026-06-26T10:10:44.305Z

## Method

Build the receipt corpus as a Čech closure space (Rieser 2025). Edges by payload_pattern equivalence; connected components = H^0(G; constant sheaf) = the "shared substrate."

Encode each H^0 component once + per-receipt (component_id, residual field indices). Brotli q11 final.

## Topology of the closure space

| Metric | Value |
|---|---|
| Vertices (receipts) | 6,224 |
| H^0 components | 1,855 |
| **H^0 collapse ratio** | **3.36×** equivalence-class reduction |
| Largest component | C2: 805 receipts |
| 2nd largest | C17: 679 receipts |

## Compression

| Metric | Value |
|---|---|
| Raw corpus | 2,075,585 B |
| Sheaf stream pre-brotli | 679,584 B |
| Sheaf + Brotli q11 | 127,496 B |
| **Ratio** | **16.28×** |
| Lossless | ✓ |

## Analysis

Sheaf encoding at 16.28× is lossless but does not beat Experiment 07 plait (18.05×). H^0 collapse (3.36×) does extract real equivalence structure, but the per-receipt residual overhead (5 vocab indices × 6,224 receipts) exceeds the savings from payload-pattern sharing.

## Reference
Rieser, A. (2025). "Grothendieck Topologies and Sheaf Theory for Data and Graphs: An Approach Through Čech Closure Spaces." arXiv:2109.13867v2.

## Reproduction

```
bun 12-ATOMSMASHER/research/compression/experiments/08-sheaf-cohomology/bench.mjs
```
