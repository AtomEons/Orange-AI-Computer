# Experiment 14 — Combinatorial Sweep — RESULT

**Status:** ✅ COMPLETE (21 pipelines tested)
**Generated:** 2026-06-26T10:25:29.923Z

## Top 10 pipelines (all lossless)

| Pipeline | Ratio | Final bytes |
|---|---|---|
| plait → brotli_q11 | **18.05×** | 114,967 |
| plait_spike → brotli_q11 | **17.66×** | 117,517 |
| identity → brotli_q11 | **17.27×** | 120,166 |
| sort_action → brotli_q11 | **17.14×** | 121,067 |
| sort_plait → brotli_q11 | **17.07×** | 121,568 |
| spike → brotli_q11 | **16.56×** | 125,309 |
| payload_ca → brotli_q11 | **16.11×** | 128,809 |
| plait → brotli_q6 | **15.66×** | 132,524 |
| identity → brotli_q6 | **15.08×** | 137,635 |
| sort_action → brotli_q6 | **14.82×** | 140,025 |

## All results

| Pipeline | Ratio | Final bytes | Lossless |
|---|---|---|---|
| plait → brotli_q11 | 18.05× | 114,967 | ✓ |
| plait_spike → brotli_q11 | 17.66× | 117,517 | ✓ |
| identity → brotli_q11 | 17.27× | 120,166 | ✓ |
| sort_action → brotli_q11 | 17.14× | 121,067 | ✓ |
| sort_plait → brotli_q11 | 17.07× | 121,568 | ✓ |
| spike → brotli_q11 | 16.56× | 125,309 | ✓ |
| payload_ca → brotli_q11 | 16.11× | 128,809 | ✓ |
| plait → brotli_q6 | 15.66× | 132,524 | ✓ |
| identity → brotli_q6 | 15.08× | 137,635 | ✓ |
| sort_action → brotli_q6 | 14.82× | 140,025 | ✓ |
| sort_plait → brotli_q6 | 14.72× | 140,969 | ✓ |
| plait_spike → brotli_q6 | 14.47× | 143,446 | ✓ |
| spike → brotli_q6 | 14.07× | 147,478 | ✓ |
| payload_ca → brotli_q6 | 14.02× | 148,018 | ✓ |
| spike → zlib_9 | 12.15× | 170,805 | ✓ |
| plait_spike → zlib_9 | 11.85× | 175,139 | ✓ |
| plait → zlib_9 | 11.57× | 179,390 | ✓ |
| sort_action → zlib_9 | 11.01× | 188,578 | ✓ |
| sort_plait → zlib_9 | 10.93× | 189,818 | ✓ |
| payload_ca → zlib_9 | 10.52× | 197,321 | ✓ |
| identity → zlib_9 | 8.45× | 245,601 | ✓ |

## Headline
- **Best:** `plait → brotli_q11` at **18.05×**
- Baseline (identity → brotli_q11): 17.27×
- Compound win: **+0.78×**
