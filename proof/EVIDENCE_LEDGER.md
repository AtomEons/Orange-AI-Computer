# Public Evidence Ledger

This ledger maps public claims to inspectable evidence. A green result applies
only to the named workload, machine state, and acceptance contract.

## Current Bounded Results

| Organ | Result | Evidence | Boundary |
|---|---|---|---|
| Blue Bench | 10/10 exact-path lanes accepted | [`2026-08-28T03-40-44-768Z-blue-bench.json`](2026-08-28T03-40-44-768Z-blue-bench.json) | Named two-computer run, not universal readiness |
| Integrated operations | Cross-organ proof artifact | [`2026-08-28T03-42-45-242Z-integrated-operational-proof.json`](2026-08-28T03-42-45-242Z-integrated-operational-proof.json) | Exact recorded run |
| Context Crystal | 5/5 held-out cases; minimum 1,422.901x operational-context ratio on 7,056,795 source bytes | Blue Bench and integrated proof | Operational context ratio, not lossless byte compression |
| AE Memory | 23/23 held-out retrieval cases; MRR 0.9058; hybrid beat lexical-only and dense-only ablations | Integrated proof | Named 23-case benchmark |
| Bun runtime | 6/6 endpoints; 3,726.816 queue ops/s; semantic recall p50 353.85 ms, p95 640.175 ms | [`2026-08-27T15-38-57-186Z-bun-runtime-benchmark.json`](2026-08-27T15-38-57-186Z-bun-runtime-benchmark.json) | Hardware- and workload-specific |
| AE Eyes | Resident XPU path and queue path completed; focused tests 5/5 | [`2026-08-27T15-33-08-076Z-ae-eyes-live-xpu-audit.json`](2026-08-27T15-33-08-076Z-ae-eyes-live-xpu-audit.json) | Text-query embedding remains an approximate stand-in |
| Brain MCP and Hermes | Parent mediation, authorized child action, synthesis receipt, and lease revocation completed | [`2026-08-28T04-13-22-203Z-brain-mcp-delegation-live-proof.json`](2026-08-28T04-13-22-203Z-brain-mcp-delegation-live-proof.json) | Harmless bounded delegation, not arbitrary autonomy |
| Fixer | Controlled service fault reproduced, isolated, authorized, repaired, regression-checked, lifecycle-closed, and hash-chain-verified | [`2026-08-28T06-21-26-671Z-fixer-live-recovery-proof.json`](2026-08-28T06-21-26-671Z-fixer-live-recovery-proof.json) | Named Orange-owned service and controlled fault |
| Link Sentinel | Controlled tunnel failure recovered without restarting neighboring Orange services | [`2026-08-28T06-18-49-312Z-link-sentinel-live-proof.json`](2026-08-28T06-18-49-312Z-link-sentinel-live-proof.json) | Named local failure injection |
| Current awareness | Six-source artifact, governed child action, deterministic synthesis, and lease revocation completed | [`2026-08-28T06-43-35-562Z-current-awareness-delegation-live.json`](2026-08-28T06-43-35-562Z-current-awareness-delegation-live.json) | One bounded research order; no automatic candidate promotion |
| AE Link custody alpha | Crash matrix preserved one effect and one terminal event | [`2026-08-28T06-32-47-434Z-ae-link-custody-alpha.json`](2026-08-28T06-32-47-434Z-ae-link-custody-alpha.json) | Isolated alpha, not production AE Link promotion |
| Calibrated router alpha | Held-out MAE improved 95.6%; safety route errors remained zero | [`2026-08-28T06-40-42-351Z-calibrated-cost-router-alpha.json`](2026-08-28T06-40-42-351Z-calibrated-cost-router-alpha.json) | Frozen synthetic telemetry; production router unchanged |

## Current Whole-Repository Verifier Truth

The latest broad local pass discovered **228 test files: 227 green and 1 red**.
The remaining red is the operational audit aggregate (`6/9`). This repository
does not translate that result into whole-system green. The individual public
claims above are tied to their own accepted receipts.

## Reading Rules

- A receipt proves the exact observation it records.
- A passing test proves its stated contract, not the entire product.
- Alpha evidence is not production promotion.
- Compression ratios must name whether they measure bytes, tokens, injected
  context, or avoided work.
- External model superiority is not claimed by these results.

**Daybreak Blue × Atom Eons**
