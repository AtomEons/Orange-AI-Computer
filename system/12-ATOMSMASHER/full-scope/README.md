# AtomSmasher Full-Scope — Bun Port

**Canonical AtomSmasher engine, ported to Bun-only runtime.**

Faithful port of `C:\AtomEons\orangebox-delta\integrations\atomsmasher_full_scope_v1_0\` — Codex-designed Python + SQLite implementation. This is **the** AtomSmasher 2 engine for Orange5 Pillar 5, not a partial reimplementation.

- **620 live executable features** registered in SQLite
- **14 engine families** dispatched by keyword classification
- **6 heat classes**: HOT_ALWAYS / HOT_NOW / WARM / COOL / COLD / DEEP_COLD
- **Core law**: *"Only smart work is done."*
- **Schema version**: 10
- **Runtime**: Bun (via `bin/sqlite-shim.mjs`, no Node fallback)

## Status

| Test case | Bun result |
|---|---|
| registry_contains_all_620_additions | PASS — 620 features, ≥12 engines |
| full_ingest_orders_hot_and_coverage | PASS — ingest, orders, HOT_ALWAYS, search |
| commitment_air_and_equation | PASS — AIR `L:` prefix, linear fit + reconstruct |
| cache_route_saved_work_and_compile | PASS — cache_answer route, total-work compile |
| security_and_agent_governance | PASS — prompt_injection scan, agent lease |
| **all_620_execute_live** | **PASS — 620 attempted, 0 errors, 620 ok** |
| demo_and_proof | PASS — v1.0.0 demo end-to-end |

7/7 on Bun 1.3.14. Total runtime ~67s for the full sweep (~21s for the 620-feature parity test).

## Run

```bash
# Single test sweep
bun 12-ATOMSMASHER/full-scope/tests/full-scope.test.mjs

# Run all 620 features against a fresh DB (CLI)
bun 12-ATOMSMASHER/full-scope/cli.mjs --db /tmp/as.db v10-demo

# Run one specific feature
bun 12-ATOMSMASHER/full-scope/cli.mjs --db /tmp/as.db execute-addition "Order Spine"

# Compile a query through the total-work compiler
bun 12-ATOMSMASHER/full-scope/cli.mjs --db /tmp/as.db compile "continue AtomSmasher without losing orders"
```

## Layout

```
full-scope/
├── version.mjs       — VERSION / CODENAME / SCHEMA_VERSION / SYSTEM_LAW
├── utils.mjs         — sha256Text, nowIso, slugify, splitChunks, keywords, cosineLike, ...
├── feature_data.mjs  — FEATURE_NAMES (620 entries, byte-equivalent to Python source)
├── storage.mjs       — Store class, SCHEMA, classifyFeature, register_features
├── engines.mjs       — All 14 engine classes + FeatureExecutor + TotalWorkCompiler + demo
├── cli.mjs           — CLI parity with `python -m atomsmasher`
├── index.mjs         — Package entry (re-exports)
├── tests/
│   └── full-scope.test.mjs  — 7-case Bun port of test_full_scope.py
└── README.md         — this file
```

## Engine families (14)

`heat` · `source` · `codec` · `equation` · `cache` · `runtime` · `routing` · `proof` · `agent` · `code` · `security` · `attention` · `energy` · `core` (default)

Plus `memory`, `mode`, `awareness` in the classifier — total 17 distinct engines registered. The Python test asserts `≥12`; we ship 17.

## Pipeline

```
raw input / upload / code / data / tool result
  → full ingest + coverage receipt
  → order detection + HOT_ALWAYS heat governance
  → source chunks + FTS5 index
  → commitment atoms + AIR
  → equation packets + residuals
  → exact/semantic/runtime cache lookup
  → sparse workset
  → least-action route
  → expansion warrant if needed
  → answer / build / act
  → saved-work certificate
  → compression-debt receipt
  → pathwave / proof / learning receipts
```

## What this REPLACES

The earlier `12-ATOMSMASHER/<module>/` Bun reimplementations (commitment-atoms, air-codec, equation-store, cartridges, sparse-worksets, least-action, expansion-warrants, compression-debt, saved-work, canon-pressure, pathwave) cover ~12 of the 620 canonical features. They are now **redundant relative to this engine**. They may be retired by a future PR or kept as cross-checks.

The canonical battle-ready engine is **this `full-scope/` tree**.

## Doctrine alignment

- **5-Pillar lock (2026-06-25)**: Pillar 5 / AtomSmasher 2.
- **AE Cobra drives this engine as the always-on sieve** (per AE Memory Pillar 3 doctrine — wired when AE Cobra Docker daemon stands up on Codexa).
- **Bun-only**: zero `better-sqlite3` deps; uses `bin/sqlite-shim.mjs` which throws on Node.
- **Codexa-only at steady state**: dev mini PC (N150) runs the tests; production runtime lives on Codexa.
- **Receipts every step**: every action writes to the `receipts` table; the proof report counts ≥ 620 receipts after a single `run-all-additions`.

## Source provenance

Bun port authored 2026-06-25 from:
- `C:\AtomEons\orangebox-delta\integrations\atomsmasher_full_scope_v1_0\atomsmasher\` (storage.py, engines.py, feature_data.py, cli.py, utils.py, version.py)
- `C:\AtomEons\orangebox-delta\integrations\atomsmasher_full_scope_v1_0\tests\test_full_scope.py`
- `C:\AtomEons\orangebox-delta\integrations\atomsmasher_full_scope_v1_0\docs\ADDITIONS_620.md`

Class names, method names, SQL schema, and feature names are byte-equivalent to the Python source. Only language idioms changed (Python regex → JS regex, Python `dict` → JS plain object, etc.).

Receipt: `10-RECEIPTS/orange5-build/2026-06-25-atomsmasher-full-scope-bun-port.md` (#061).
