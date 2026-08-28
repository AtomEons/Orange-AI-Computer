# PR-15 `atomsmasher-toolmesh` Spec — AtomSmasher side

AtomSmasher v0.7 backend integration + 12 advanced modules (per Master Plan §9).

## Modules (12)

| # | Module | Role |
|---|---|---|
| 1 | Commitment Atoms | Irreducible promise units |
| 2 | AIR Codec | Atomic Information Representation |
| 3 | EquationStore | Canonical math/logic facts |
| 4 | Cartridges | Pre-compressed knowledge packs |
| 5 | Sparse Worksets | Only the lines that matter |
| 6 | Least-action Router | Picks shortest path |
| 7 | Expansion Warrants | Explicit scope-growth permission |
| 8 | Compression Debt Ledger | Tracks what got dropped |
| 9 | Saved Work Certificates | Proof recomputation isn't needed |
| 10 | Canon Pressure Detector | Flags doctrine drift |
| 11 | Pathwave Compressor | Compresses execution traces |
| 12 | Anti-fluff Gate | Refuses verbose output |

PR-15 ships **stub interfaces**. Real implementations land per-module in dedicated future PRs as the operator unlocks them.

## Files

- `modules/index.mjs` — module registry stubs
- `modules/anti-fluff.mjs` — only fully-implemented module in PR-15 (smallest, most useful)
