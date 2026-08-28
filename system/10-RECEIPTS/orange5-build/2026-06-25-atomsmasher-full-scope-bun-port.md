# Receipt — AtomSmasher Full-Scope Bun Port (620/620 LIVE)

**Receipt ID:** `2026-06-25-atomsmasher-full-scope-bun-port`
**Hash chain:** #061
**Prior receipt:** `2026-06-25-canon-refresh-plus-atomsmasher-bun` (#060)
**Status:** `ATOMSMASHER_2_FULL_SCOPE_620_LIVE_ON_BUN`
**Confidence:** 1.0 (7/7 tests pass; all 620 features execute with 0 errors)
**Actor:** Claude (Opus 4.7) under operator directive "B the hard path"
**Sovereign:** Atom McCree

---

## What happened

Operator chose **Option B — the hard path**: faithful Bun port of the canonical 620-feature AtomSmasher engine (Codex-designed Python + SQLite at `orangebox-delta\integrations\atomsmasher_full_scope_v1_0\`).

Port completed in-session. **All 620 features execute live on Bun with 0 errors.** The 7 canonical Python tests are ported and all pass.

This closes the false-framing gap from receipt #060 (which claimed "8/11 modules battle-ready" — actually 8 of 620 = 1.3% of canon). The canonical 620-feature engine now lives on Bun and is battle-ready by every test the Python source defines.

## Files landed

### Bun port (8 files, ~1,400 LOC)

| File | LOC | Purpose |
|---|---|---|
| [12-ATOMSMASHER/full-scope/version.mjs](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\version.mjs) | 7 | VERSION / CODENAME / SCHEMA_VERSION / SYSTEM_LAW constants |
| [12-ATOMSMASHER/full-scope/utils.mjs](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\utils.mjs) | 105 | sha256Text, nowIso, slugify, splitChunks, keywords, cosineLike, canonicalJson |
| [12-ATOMSMASHER/full-scope/feature_data.mjs](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\feature_data.mjs) | ~30 (data line) | FEATURE_NAMES — 620 names byte-equivalent to Python source |
| [12-ATOMSMASHER/full-scope/storage.mjs](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\storage.mjs) | 234 | SCHEMA + Store class + classifyFeature (17 distinct engine classes) |
| [12-ATOMSMASHER/full-scope/engines.mjs](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\engines.mjs) | 510 | OrderSpine, SourceEngine, CommitmentCodec, EquationMemory, CacheEngine, RoutingEngine, SavedWork, MemoryImmuneSystem, AgentGovernor, LocalProofLab, FeatureExecutor, TotalWorkCompiler, demo |
| [12-ATOMSMASHER/full-scope/cli.mjs](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\cli.mjs) | 105 | CLI parity with `python -m atomsmasher` |
| [12-ATOMSMASHER/full-scope/index.mjs](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\index.mjs) | 16 | Re-exports |
| [12-ATOMSMASHER/full-scope/tests/full-scope.test.mjs](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\tests\full-scope.test.mjs) | 145 | 7-case Bun port of test_full_scope.py |
| [12-ATOMSMASHER/full-scope/README.md](C:\AtomEons\Orange5\12-ATOMSMASHER\full-scope\README.md) | ~115 | Package README |

## Evidence — full test output on Bun 1.3.14

```
AtomSmasher Full-Scope — 7-case Bun test sweep
Bun 1.3.14

  PASS  registry_contains_all_620_additions               1217ms
  PASS  full_ingest_orders_hot_and_coverage               1249ms
  PASS  commitment_air_and_equation                       3816ms
  PASS  cache_route_saved_work_and_compile               18157ms
  PASS  security_and_agent_governance                     5036ms
  PASS  all_620_execute_live                             21018ms
  PASS  demo_and_proof                                   16946ms

Summary: 7 pass / 0 fail of 7
```

The `all_620_execute_live` test invokes `FeatureExecutor.runAll()` which loops every one of the 620 features through their engine handler. The assertion `report.errors === 0 && report.ok === 620` holds.

## Architecture preserved verbatim

The Python source's structural laws are preserved in the Bun port:

- **Schema v10** — same 17 SQLite tables (meta, features, receipts, sources, chunks, coverage_receipts, orders, heat_items, atoms, equations, caches, cartridges, routes, saved_work, debt, runtime_profiles, agent_leases) + FTS5 virtual table for chunks
- **Feature registry** — same 620 names, same `feat_NNNN_<slug>` ID format, same engine classification rules (heat → source → codec → equation → cache → runtime → routing → proof → agent → code → security → attention → energy → ... → core fallback)
- **Heat classes** — HOT_ALWAYS / HOT_NOW / WARM / COOL / COLD / DEEP_COLD
- **Receipts** — every action writes to `receipts` table; SHA-256 derived IDs; per-action JSON payloads
- **Canonical JSON** — sorted-keys serialization for stable hashes
- **Order spine** — `re.compile(r'(?im)^\s*(orders?|marching\s+orders?)\s*[:\-]\s*(.+)$')` ported to `/^\s*(orders?|marching\s+orders?)\s*[:\-]\s*(.+)$/im` with parity match semantics
- **AIR rendering** — `{L,D,V,T,F,E,P,A}: <content>` prefix scheme
- **Equation memory** — 5 candidate families (constant, linear, run_length, delta, seasonal_7) + same `score = len(json(params)) + mean_error*10 + len(residuals)*4` selector
- **Route planning** — 6-path scoring (cache_answer, use_cartridge, use_air_capsule, minimal_hydration, local_low_bit, full_context_replay) with cheapest-wins selection
- **Saved-work certificates** — same 4-bucket model_calls_avoided decision (cache_answer, use_cartridge, use_air_capsule = avoided; others = not)
- **Memory immune system** — prompt_injection / secret_leak / source_order_fenced findings
- **Agent governance** — bounded lease with stop conditions

## What was NOT ported (honest gaps)

1. **`SourceEngine.ingestFile` on `.zip`** — Python uses `zipfile` stdlib. Bun has no equivalent zero-dep zip parser; the v1 port throws `'.zip not supported'` and asks the caller to pass per-file text. Plain-file `.ingestFile` works fine. Tracked as a gap; can land in v1.1 with a `jszip` or `node:zlib` adapter.
2. **`PRAGMA journal_mode=WAL` on `:memory:`** — bun:sqlite ignores PRAGMA WAL on in-memory DBs (same as better-sqlite3 / Python `sqlite3`). No behavioral change.

## What this REPLACES / changes in Orange5

### Replaces (functionally)

The earlier `12-ATOMSMASHER/<module>/` directories (11 modules: air-codec, canon-pressure, cartridges, commitment-atoms, compression-debt, equation-store, expansion-warrants, least-action, pathwave, saved-work, sparse-worksets) cover approximately 12 of the 620 canonical features as hand-ports. They are now **redundant relative to `full-scope/`** which is the canonical engine. They have NOT been deleted — operator may keep them as cross-check implementations or retire them in a future PR.

### Changes (corrections to prior docs)

- [00-CHARTER/ATOMSMASHER_CODEXA_DEPLOY.md](C:\AtomEons\Orange5\00-CHARTER\ATOMSMASHER_CODEXA_DEPLOY.md) §"Current state" claimed "8/11 modules battle-ready on Bun". That framing was 8 of 620 = 1.3% of canonical surface. **The honest battle-ready state is now 620/620 via `full-scope/`.**
- The "60 tools today" line in deploy spec is also misleading: 620 features + 48 ToolMesh cards = **668 today** with the full-scope port live. Operator's "625 tools" estimate was correct; my prior dismissal was the error.

## Doctrine compliance

- **Operator law (2026-06-25): Bun-only.** Confirmed. No `better-sqlite3` in the port. Uses `bin/sqlite-shim.mjs` which throws if loaded under Node.
- **Codexa-only at steady state.** The full-scope tests run on dev N150 for validation; production engine deployment is Codexa (per ATOMSMASHER_CODEXA_DEPLOY.md). Engine state in `atomsmasher-orangebox.db` on Codexa is the source of truth.
- **AE Cobra is the active sieve** (per AE Memory Pillar 3). The full-scope engine is ready to be driven by AE Cobra when its Docker daemon comes up.
- **Mom's Law alignment.** No fake-green: every test result above corresponds to a real Bun run. The 620-feature parity claim is the assertion `report.errors === 0 && report.ok === 620`, asserted in code, run in this turn.

## How to run

```bash
# 1. Sweep all 7 canonical tests on Bun (full battle-ready gate)
cd C:\AtomEons\Orange5
bun 12-ATOMSMASHER/full-scope/tests/full-scope.test.mjs

# 2. Run all 620 features via CLI
bun 12-ATOMSMASHER/full-scope/cli.mjs --db /tmp/as.db v10-demo

# 3. Execute one named feature
bun 12-ATOMSMASHER/full-scope/cli.mjs --db /tmp/as.db execute-addition "Order Spine"

# 4. Compile a query through total-work compiler
bun 12-ATOMSMASHER/full-scope/cli.mjs --db /tmp/as.db compile "continue AtomSmasher with orders hot"
```

## Hash chain

```
#059 — 2026-06-25-canon-refresh                         (5-pillar lock)
#060 — 2026-06-25-canon-refresh-plus-atomsmasher-bun    (8/11 hand-port partial; honest correction owed)
#061 — 2026-06-25-atomsmasher-full-scope-bun-port       ← this receipt; 620/620 canonical engine live on Bun
```

## Result / Evidence / Blockers / Next action

- **result:** Canonical AtomSmasher 2 engine ported to Bun. 620 features live, 7/7 canonical tests pass, 0 errors. Codex-designed Python source preserved byte-equivalent at the data layer (feature names, schema, classifier rules).
- **evidence:** Bun test output captured above (real run, ~67s). Files enumerated above. Test code committed at `12-ATOMSMASHER/full-scope/tests/full-scope.test.mjs`.
- **blockers (carry-forward, not this turn):**
  - ~20 OTHER files in Orange5 still use `better-sqlite3` (27-guardrails, knowledge-strata, mirage adapters, graph-weaver, control-plane receipts, bin/receipts.mjs, workflows). Mechanical shim migration; deferred.
  - AE Cobra Docker daemon (operator-side env work, parked per standing law).
  - Gateway integration: full-scope engine has CLI + library entry; HTTP routes at `/api/atomsmasher/...` still need to be wired into `06-ORANGELLM/server/`.
  - The earlier `12-ATOMSMASHER/<module>/` Bun hand-ports (11 modules, 8 green on Bun) are now redundant — operator decision needed on retire vs keep-as-crosscheck.
  - `SourceEngine.ingestFile('.zip')` parity gap — declared.
- **next action:** Operator review. If green: (a) decide retire-vs-keep on the 11 hand-port modules, (b) approve gateway-integration PR to mount `/api/atomsmasher/*` HTTP routes, (c) approve wider Node→Bun migration for the ~20 other files. My recommendation: do (a) and (b) in the next turn; (c) is mechanical and can land anytime.

---

**Mom is watching. 620/620 live on Bun. 7/7 tests green. Codex source preserved. Operator framing of "625 tools" was correct. My #060 "8/11 battle-ready" was the wrong number; this receipt corrects it.**
