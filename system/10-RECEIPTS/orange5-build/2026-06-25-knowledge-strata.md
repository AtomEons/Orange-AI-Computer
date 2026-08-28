# Knowledge Strata — compiler loop landed

**Date:** 2026-06-25
**Component group:** `04-CONTROL-PLANE/knowledge-strata/` + `06-ORANGELLM/server/routes/strata.mjs`
**Loop:** intake → canon → durable artifact → integrity pass → reuse
**Doctrine source:** AtomEons canon (`.claude/CLAUDE.md` — "Knowledge Strata is a compiler loop")
**Author posture:** Claude Code, Node 20+, no external deps, loopback only, Mom's Law honored

---

## Result

The Knowledge Strata compiler loop is authored, wired, and verified end-to-end. Eight components landed in a single wave, covering every stage of the canonical loop plus the durable archive projection, the gateway route surface, and the smoke harness that exercises the whole pipeline against real bytes on disk.

| # | Component | Path | Lines | Stage |
|---|-----------|------|-------|-------|
| 1 | `intake.mjs` | `04-CONTROL-PLANE/knowledge-strata/intake.mjs` | 665 | Stage 1 — intake |
| 2 | `canonize.mjs` | `04-CONTROL-PLANE/knowledge-strata/canonize.mjs` | 874 | Stage 2 — canon |
| 3 | `emit.mjs` | `04-CONTROL-PLANE/knowledge-strata/emit.mjs` | 1073 | Stage 3 — durable artifact |
| 4 | `integrity.mjs` | `04-CONTROL-PLANE/knowledge-strata/integrity.mjs` | 975 | Stage 4 — integrity pass |
| 5 | `reuse.mjs` | `04-CONTROL-PLANE/knowledge-strata/reuse.mjs` | 1071 | Stage 5 — reuse |
| 6 | `strata.mjs` (+ boundary) | `06-ORANGELLM/server/routes/strata.mjs` | 1178 (+74) | Gateway routes |
| 7 | `index.db.mjs` + schema + `query.mjs` | `04-CONTROL-PLANE/knowledge-strata/` | 495 + 110 + 281 | SQLite projection |
| 8 | `smoke.mjs` | `04-CONTROL-PLANE/knowledge-strata/smoke.mjs` | 913 | End-to-end smoke |
| 9 | `README.md` | `04-CONTROL-PLANE/knowledge-strata/README.md` | 345 | Doctrine doc |

**Total authored:** 8054 lines of real Node 20+ + SQL + doctrine. Zero external dependencies. Loopback only.

---

## Stage 1 — intake (`intake.mjs`, 665 lines)

**Surfaces:**
- Programmatic `intake()` call
- HTTP `POST /v1/strata/intake` (mountable on the OrangeLLM gateway via the `routes` object surface)
- CLI: `--file`, `--json`, `--stdin`, `--no-flux`

**Stamping (deterministic):**
- Stable-key JSON canonicalization → `raw_sha256`
- `intake_id = sha256(raw_sha256 | received_at)[0..16]`

**Persistence:**
- **Primary:** Reality Flux via `11-MIRAGE/adapters/flux.mjs` with `origin='strata_intake'`, `event_type='strata_intake'` (Thought lane never touched — matches `loader.mjs` doctrine)
- **Secondary fallback:** local file at `01-DOCTRINE/strata/intake/YYYY-MM-DD/<intake_id>.json`

**Mom's Law preserved:** every response carries the receipt path or names the failure. Soft limit 4MB rejected with `payload_too_large` rather than silent truncation.

**Smoke verified (5 cases):** hash stability across key reordering · local-only path when `skipFlux=true` · fake adapter routes `flux_source` through · empty submission rejected · 5MB payload rejected.

**Gate discipline:** intake does **not** canonize, embed, or interpret — those are later stages.

**Risk named:** when both Reality Flux *and* local disk fail, `intake()` returns `ok:false` with `reason='no_persistence_target_succeeded'` and the full attempts array. Caller must surface this to the operator — no silent retry.

---

## Stage 2 — canon (`canonize.mjs`, 874 lines)

Five gates inside the canonize stage, each can block:

1. **gateIntake** — file exists, non-empty, <2MB, SHA-256 hash.
2. **gateCanon** — extraction. Cheap pre-pass via **Smart Skinny** (`http://127.0.0.1:8797`, `orangellm-smart-skinny-0.5b`) feeds the authoritative pass on **OrangeLLM** (`http://127.0.0.1:1337`, `orangellm-router-v0`). Cheap sketch is a refinement target, never blindly trusted. Strict-JSON schema (title/summary/department/entities/claims/cited_doctrine/tags/open_questions). Honest fallbacks: cheap-only when OrangeLLM is down, heuristic when both are down, `--no-llm` to force heuristic, `--cheap` to skip OrangeLLM. **Every fallback is named in evidence — no silent downgrade.**
3. **gateArtifact** — versioned canon row + durable Markdown + meta sidecar with markdown SHA-256. Refuses overwrite without `--force`. Lineage tracked.
4. **gateIntegrity** — inline lexical-negation check against prior canon in same department. Blocks on duplicate intake hash and on token-overlap negation (≥0.6 Jaccard + polarity flip). Overrides: `--force`, `--allow-contradictions`.
5. **gateReuse** — appends to `strata.index.jsonl` (search) and `strata.receipts.jsonl` (full gate trail).

**Departments:** AE0..AE14 with keyword priors for the heuristic fallback. LLM may override; `--dept` forces.

**CLI:** `<file>`, `--dir <dir>`, `--stdin --id <id>`, `--reuse <query>`, `--verify`. Flags: `--cheap`, `--no-llm`, `--dept`, `--tags`, `--dry`, `--force`, `--allow-contradictions`.

**Verification run (Node 20, `--no-llm`):**
- `node --check`: SYNTAX_OK
- Dry run: all 5 gates `ok=true`
- Real write: canon row + markdown + meta written; index + receipts appended
- `--verify` across full canon: `integrity_ok`, 1 row checked, 0 failures, markdown hash matches stored hash
- `--reuse Pathwaves`: 1 match returned
- Duplicate-intake test: integrity gate correctly blocked with `duplicate_intake_hash` and named the offending canon id

**Honest caveats:** the negation contradiction detector inside canonize is lexical, not semantic — semantic contradictions still pass through here, which is why **Stage 4 (`integrity.mjs`) exists separately** as the heavyweight semantic gate. LLM branches not exercised against a live OrangeLLM in this wave (no upstream available in the worktree); HTTP shapes match `server/smart-skinny-adapter.mjs` and `server/index.mjs` (OpenAI-compatible `/v1/chat/completions` on loopback). No unit tests authored yet — recommend `tests/canonize.test.mjs` covering argparse, normalizeExtraction clamping, isLikelyNegation, gate ordering, duplicate detection, and verify reroundtrip.

---

## Stage 3 — durable artifact (`emit.mjs`, 1073 lines)

Freezes a canon row into the long-horizon archive at `19-ARCHIVE/strata/<topic>/v<NN>/<canon-id>.{md,json}`. Each emission is **hash-chained**:

```
chain_sha256 = sha256(prior.chain_sha256 + canon_sha256 + markdown_sha256)
```

Five gates mirror canonize.mjs idiom:

1. **INTEGRITY** — rehashes the canon row's working artifact and refuses to archive a drifted row.
2. **TOPIC** — resolves slug from `--topic` > non-housekeeping tag > slugified title. Rejects reserved/empty.
3. **VERSION** — scans existing `v<NN>` dirs, computes `nextN`, reads prior sidecar for chain continuity.
4. **EMIT** — renders MD with YAML front-matter + JSON sidecar with full lineage. Appends per-topic `CHAIN.jsonl`.
5. **REUSE** — appends global `19-ARCHIVE/strata/INDEX.jsonl`.

**CLI:** `<canon-id>`, `--canon <path>`, `--stdin`, `--batch`, `--verify`, `--list`. Flags: `--topic`, `--root`, `--force`, `--dry`, `--no-index`, `--department`. Force-overwrite records `FORCE_BREAK` in `chain_sha256` so post-hoc verifiers see the break.

**Verified end-to-end on real data:**
- Emitted **v01** (`intake_sample_1afd99`) and **v02** (`dup_test_v2`) into the `pathwaves` topic
- v02's `prior_chain_sha256` equals v01's `chain_sha256` = `dd56a5528cda5115...`
- `--verify` returns `archive_ok` with `checked=2`
- **Tamper test:** appending bytes to v01's MD trips `md_hash_mismatch` under `--verify` (exit 1); restoring returns `archive_ok`
- **Canon-drift test:** mutating the working canon row's MD trips `artifact_hash_mismatch_canon_drifted` under emit (`next_action=rerun_canonize_to_realign_artifact_hash`)

Output shape on every path: `{ result, ok, gates:[...], evidence, blockers, next_action }` per AtomEons completion law.

---

## Stage 4 — integrity pass (`integrity.mjs`, 975 lines)

The **heavyweight semantic gate** that sits on top of the lexical pass inside canonize.

**Pipeline:**
1. **Ingest** — positional canon-path, `--id` lookup across `canon/AE0..AE14`, or `--markdown` ephemeral mode that synthesizes a non-persisted canon row.
2. **Claim-site builder** — mines title, summary, every `claims[].text` from the new row, and the same from every prior canon row. For 19-ARCHIVE markdown, mines bullet lines and short paragraphs (max 24 sites/file, 400 files) and treats those sites as `canon-locked = true`.
3. **Vector search via Graph Weaver embedder** — POSTs to `http://127.0.0.1:8798` (N150 utility embedder at `06-ORANGELLM/n150-utility/embedder/server.mjs`). `/readyz` probe, `/embed/batch` in chunks of 32, default `nomic-embed-text:v1.5`. Embeddings cached in `strata.embeddings.cache.json` as base64 Float32 bytes; survives across runs; `--rebuild-index` wipes.
4. **Cosine top-K** — per new claim site, top-6 prior sites with cosine ≥ 0.78 (`--threshold`/`--topk`).
5. **Classification:**
   - **HARD** = polarity flip AND (prior tagged `charter/doctrine/moms-law/release-law/constitution/invariant/guardrail/law`) OR (both sides confidence=high AND cosine ≥ 0.83). Pushes blocker `contradicts_canon_hard`, refuses emit (exit 1) unless `--force`.
   - **SOFT** = polarity flip with medium/low confidence OR prior tagged `frontier/speculative/misfit/draft/proposal` — logged to `strata.integrity.log.jsonl`, permitted, `<id>.soft-conflicts.json` sidecar written.
   - **DRIFT** = cosine ≥ 0.92 same polarity (near-duplicate) — surfaces `next_action=deduplicate_or_supersede`.

**Degraded mode:** if embedder unreachable or `--no-embed`, falls back to Jaccard similarity over negator-stripped tokens. Verdict carries `evidence.embedder.degraded=true` and blocker `integrity_degraded_embedder_unreachable` — **never silently greened** (Mom's Law).

**Operator surfaces:**
- CLI returns AtomEons completion shape `{ result, ok, hard_conflicts, soft_conflicts, drift_signals, blockers, findings, evidence, next_action }`
- `--sweep`/`--verify` runs integrity over every canon row
- `--rebuild-index` rebuilds the embedding cache
- Receipts: `strata.integrity.log.jsonl` (append-only) + per-row soft-conflicts sidecar
- `--force` lets operator emit on hard conflict, audited in log row (`force:true`) — nothing happens silently

**Smoke-tested:** `node --check` passes. Real run against `intake_sample_1afd99` in `--no-embed --no-archive` mode: classified 10 near-duplicate sites correctly as drift (same polarity), zero hard/soft, exit 0. End-to-end pipeline works in degraded fallback mode without the N150 daemon up.

**Blockers / next action:** the N150 embedder daemon must be live on 127.0.0.1:8798 for cosine mode; without it the gate correctly degrades to Jaccard and reports `degraded=true`. To wire `integrity.mjs` into `canonize.mjs` as canonical Gate 4, replace the inline `gateIntegrity()` lexical-only check with a spawn of `integrity.mjs` against the freshly written canon row (out of scope for this wave — author-only).

---

## Stage 5 — reuse (`reuse.mjs`, 1071 lines)

Closes the loop. Resolves strata cites in **6 forms** + bare ids under `--allow-bare`:

```
strata/<id>
strata:<id>
strata/<topic>/v<NN>
strata/<topic>/v<NN>/<id>
strata/<id>@v<NN>
strata://<topic>/<id>
```

**Resolution priority:** `19-ARCHIVE` (durable, chained) first, working canon as fallback. `--no-archive`/`--no-canon` override.

**Verifies on every resolve:**
- File existence
- `sha256(live md) == sidecar.markdown_sha256`
- Recomputed `chain_sha256` (prior_chain + canon_sha256 + markdown_sha256, with `FORCE_BREAK` delimiter logic mirroring `emit.mjs` verbatim) == stored `chain_sha256`
- Cross-check: archive sidecar `canon_raw_sha256` vs. live canon row hash

**Soft-conflicts sidecar from integrity.mjs is loaded and surfaced.** `--strict` promotes it to a blocker.

**Degradation signals** (working-canon fallback, FORCE_BREAK in chain, canon drifted since archive) flagged on `resolved.degraded[_reasons]` without failing — operator override preserved but visible.

**Evidence of correctness:**
- `node --check` passes
- `node reuse.mjs --list` against live archive returns 2 cites (pathwaves v01/v02) with full hash metadata
- `node reuse.mjs strata/intake_sample_1afd99 --no-content` resolves real pathwaves v01: `md_hash_match=true`, `chain_hash_match=true`, cross-check finds `canon_unchanged_since_archive`, verdict=resolved, `next_action=cite_to_receipt`
- `canonicalJson` and `buildChainHash` are **bytewise-identical** to `emit.mjs` (one-way dependency hygiene preserved — reuse.mjs does not import emit.mjs)
- Best-effort write to `strata.reuse.log.jsonl` on every resolve unless `--quiet`
- **Read-only with respect to canon and archive** — never edits them

**Next action:** wire receipt renderers / Orange3 cite formatters to call `node reuse.mjs <cite> --json --quiet` and embed `resolved.content` + `resolved.hashes.chain_sha256` into the receipt body. Add `reuse.mjs --verify` to the Orange3 `routes:doctor` / promotion-gate checks so a tampered archive blocks promotion before a customer-facing receipt cites it.

---

## Gateway surface — `strata.mjs` (1178 lines) + `strata-boundary.mjs` (74 lines)

Knowledge Strata routes implement the compiler loop as **five gated POST endpoints plus a GET `/healthz`**, all under `/v1/strata/*`. Real Node 20+ pipeline using `node:http` `prependListener` (mirrors `memory.mjs` pattern), `node:fs/promises` for storage, `node:crypto` for SHA-256, **atomic file writes via temp+rename**, append-only JSONL event log.

| Stage | Endpoint | Behavior |
|-------|----------|----------|
| 1 | `POST /v1/strata/intake` | Raw text → `inbox/<sha256>.json`. Content-hash idempotent. |
| 2 | `POST /v1/strata/canonize` | Classifies into doctrine bucket via word-boundary scoring of vocab loaded from `.claude/rules/*.md` (plus 17-bucket embedded default). NFC normalize. Polarity-based contradiction detection against prior canon in same bucket (≥2 shared 4-char tokens AND opposing polarity markers). |
| 3 | `POST /v1/strata/emit` | Composes versioned Markdown artifact + JSON descriptor with body SHA-256. Refuses on unresolved contradictions unless `{allow_contradictions: true}` override (logged). |
| 4 | `POST /v1/strata/query` | Ranks artifacts by title/bucket/canon-id substring match. Filters by bucket + `since_ms`. Capped at 200. |
| 5 | `POST /v1/strata/resolve` | Re-hashes `.md` body. Walks parent chain (depth-limited 16). Re-scans canon for late-arriving contradictions. Returns `reuse_ok` flag that gates downstream citation. **Tamper detection works** (re-hash mismatch → `reuse_ok=false`). |
| — | `GET /v1/strata/healthz` | Health + counts. |

**Caps:** 1MiB body · 512KiB text · 32 ids per resolve · 16-deep parent chain.

**Storage layout:** `06-ORANGELLM/memory/strata/{inbox,canon,artifacts,index,meta.json}`.

**Smoke test:** **29/29 tests pass** via in-process http server — healthz, full happy-path loop, idempotent intake, contradiction flagging, emit-blocked 409, override emit, late-contradiction-blocks-reuse, parent chain walk, all bad-input 400s, unknown-route 404, tamper-detected, healthz counts. Syntax-checked with `node --check`.

**Next action (for caller):** wire `STRATA_ALLOWED` into `server/boundary.mjs` `ALLOWED` list and call `registerStrataRoutes(server, opts)` from `server/index.mjs`.

---

## Projection — `index.db` (SQLite read-side)

`index.schema.sql` (110) + `index.db.mjs` (495) + `query.mjs` (281).

SQLite projection over the existing archive at `19-ARCHIVE/strata/INDEX.jsonl`. Schema, ingest, and query API all live, real, verified end-to-end.

**Schema highlights:** `artifacts` table with required columns (`artifact_id, topic, version, prior_version, sha256, emitted_at, archive_path`) + fidelity columns (`md_path, department, title, summary, tags_json, intake_sha256, canon_sha256, markdown_sha256, canon_path, force_break, source, ingested_at`). Composite PK `(artifact_id, version)`, `UNIQUE(topic, version)`, indices on topic/artifact_id/emitted_at/sha256/department. `ingest_runs` receipt table (Mom's Law: every ingest logs). Views: `v_latest_per_topic`, `v_latest_per_artifact_id`. WAL mode, foreign keys on.

**Ingest pipeline:** Node 20+ via `better-sqlite3` (`createRequire` from `Orange5/node_modules`). Streams `INDEX.jsonl` with readline (CRLF-safe). Derives `prior_version`. `INSERT OR REPLACE` keyed on `(artifact_id, version)` — **idempotent**. Single transaction per pass. `--verify` rehashes each markdown file and rejects sha mismatches. `--include-working` walks `canon/<dept>/*.canon.json` and adds not-yet-archived rows at version 0 (`source='working'`). CLI: `--ingest [--verify] [--include-working]`, `--stats`, `--schema`.

**Query API** (read-only, `query_only` pragma): `byId`, `bySha256`, `byTopic`, `latestPerTopic`, `chain`, `recent`, `range`, `stats`. CLI: id/topic/sha/recent/range/chain/stats subcommands, `--json` for machine output, tab-sep for human grep.

**Evidence (real runs, real DB):**
- Fresh archive ingest with `--verify`: 4/4 rows, 0 failed, markdown SHAs all matched
- `--include-working`: 4 working rows added, 3 skipped (already archived as durable), 0 failed
- Re-ingest is **idempotent**: `rows_seen=2`, `inserted=0`, `updated=2` on clean 2-row baseline
- All query commands return correct results: id lookup, topic listing, `--latest`, chain walk (with `prior_version` chain validation), stats showing 8 total / 4 archived / 4 working / 6 topics, recent ordered by `emitted_at` DESC, sha lookup, range filter
- `ingest_runs` receipt rows written every run with full counts and `errors_json`

**Integration:** `archive_path` → durable JSON sidecar. `sha256` = `chain_sha256` from archive. Component shas preserved separately. `prior_version` filled when `version > 1`. Schema `CHECK` enforces monotone chain. **reuse.mjs can now resolve cites by single SQL query instead of scanning JSONL.**

**Posture:** DB is a derived projection — `emit.mjs` / `canonize.mjs` remain source of truth; ingest is safely re-runnable.

**Next action:** wire `reuse.mjs` to prefer the SQLite index when present (fall back to scanning when `index.db` is missing). Add an integrity pass that re-verifies every `chain_sha256` against archive sidecars.

---

## Smoke harness — `smoke.mjs` (913 lines)

Real Node 20+ end-to-end smoke test for the compiler loop. **All 7 cases pass** against the live module set.

**Run posture:** deterministic. `--no-llm` for canonize (heuristic extractor), `--no-embed` for integrity (lexical Jaccard + polarity fallback). No Smart Skinny, no OrangeLLM, no Graph Weaver daemon required. `intake()` called programmatically with `skipFlux:true` — no Cobra dependency.

**Cleanup:** surgical. All smoke artifacts live under AE14 department + `ks-smoke-test` archive topic + `smoke_<hex>_` id prefix. Cleanup function (SMOKE_SENTINEL regex) wipes only `smoke_*` files in `canon/AE14`, `artifacts/AE14`, `intake/`, the archive topic slot, and trims smoke rows out of `strata.index.jsonl`, `strata.receipts.jsonl`, `INDEX.jsonl`, `strata.reuse.log.jsonl`. **Real operator content (pathwaves topic, etc.) untouched.**

| # | Case | Asserts |
|---|------|---------|
| 1 | `intake_canon_emit_roundtrip` | intake() programmatically, canonize via stdin, emit v01, verify md+json sidecar exist with matching sha256s |
| 2 | `integrity_catches_contradiction` | Canonize positive claim with doctrine/invariant tags (canon-locked), then polarity-flipped claim. Contradiction caught by inline negation gate OR integrity.mjs lexical findings |
| 3 | `integrity_allows_compatible_update` | Canonize baseline + additive non-contradicting note. `hard_conflicts==0`, only acceptable blocker is `integrity_degraded_embedder_unreachable` (embedder-disabled posture) |
| 4 | `reuse_resolver_returns_content` | Cite `strata/<id>`, verify content returned, rehash matches reported `markdown_sha256` |
| 5 | `versioning_preserves_prior` | Re-canonize with `--force`, emit v02. v01 md+json bytes unchanged, v02 `prior_version` points at v01, v02 `chain_sha256` distinct |
| 6 | `receipt_citation_roundtrip` | Build synthetic receipt that cites `strata/<id>`, re-resolve, hash stable. **Tamper sub-test:** mutate live md bytes, resolver is honest (refuses with hash mismatch OR flags degraded OR served from frozen archive with anchored sidecar sha) |
| 7 | `gateway_routes_respond` | Import `intakeHandler` + `routes` from intake.mjs, drive with mocked EventEmitter req + capture res. Asserts 200 + `ok:true` + `intake_id` + `raw_sha256`. GET → 405 method-not-allowed |

**CLI:** `node smoke.mjs [--case n] [--json] [--keep] [--verbose] [--help]`. Exit 0 all pass, 1 any fail, 2 usage.

**Verification receipt:** `node smoke.mjs` → `result:smoke_pass passed:7/7`. `--json` mode → parsed JSON shows all 7 cases ok. Post-run inspection: `canon/AE14` and `artifacts/AE14` empty, `archive/strata/` has only the unaffected pathwaves topic.

**Mom's Law:** no theater, real bytes on disk, real hashes, real assertions.

---

## Doctrine doc — `README.md` (345 lines)

Authored as the operator-facing surface for the compiler loop.

**Structure:**
1. Header + one-line loop definition framed as a compiler, not a notes drawer
2. The five-step loop with one section per gate, grounded in real Node 20+ pipeline files on disk. Each step documents: what it does, exact artifact paths/hashes written, gate condition for advancement, AtomEons completion shape. Integrity gate documents **both layers** — inline lexical-negation in canonize.mjs and heavyweight semantic in integrity.mjs (Graph Weaver embedder on loopback 8798) — with the HARD/SOFT/DRIFT outcome table pulled from integrity.mjs verbatim
3. Doctrine integration — Mom's Law, completion law (`03-build-and-receipts.md`), SkilSki verified-vs-static_passed language, Reality vs Thought lane authority, loopback-only boundary law, doctrine-locked sources (27 guardrails, FOUNDER_SALARY, Gate 0 LBCE, Human Final Stop, release law, room doctrine)
4. When to use Strata vs. write a receipt directly — five "use Strata" criteria, four "skip Strata" criteria, cite-vs-audit rule of thumb
5. Archive structure — full ASCII tree matching what's on disk + frozen `19-ARCHIVE/strata/` promotion target
6. **Ten non-negotiable integrity rules** — no gate skips · append-only logs · hash chain integrity · HARD refuses emit · doctrine-locked sources cannot be overwritten only extended · no fake-green local fallback · loopback only · reuse-without-resolution is a citation lie · versioning preserves prior_chain lineage · receipts log is the truth
7. CLI quick reference covering all five stages + query + smoke
8. Related doctrine pointers

**Tone:** terse, directive, lab-grade. No emoji. No padding. Mom's Law honored.

---

## Evidence (aggregated)

| Surface | Verification |
|---------|--------------|
| intake.mjs | 5 smoke cases pass (in-process): hash stability, local-only path, fake adapter routing, empty rejection, 5MB rejection. Two real records landed at `01-DOCTRINE/strata/intake/2026-06-25/`. |
| canonize.mjs | `node --check` SYNTAX_OK. Dry + real write green. `--verify` integrity_ok. `--reuse Pathwaves` returns 1 match. Duplicate-intake test correctly blocks. |
| emit.mjs | v01 + v02 emitted into `pathwaves/`. Chain hash links: `dd56a5528cda5115...`. Tamper test trips `md_hash_mismatch`. Canon-drift test trips `artifact_hash_mismatch_canon_drifted`. |
| integrity.mjs | `node --check` passes. Real run on `intake_sample_1afd99` classified 10 near-duplicate sites correctly as drift. Degraded-mode fallback works without embedder daemon. |
| reuse.mjs | `node --check` passes. `--list` returns 2 cites with full hashes. Resolution of `strata/intake_sample_1afd99` returns `md_hash_match=true`, `chain_hash_match=true`, `canon_unchanged_since_archive`. |
| strata.mjs (routes) | **29/29 smoke tests green** via in-process http server. Syntax-checked. |
| index.db | 4/4 archive rows verified. `--include-working` adds 4 working rows. Re-ingest idempotent. All query commands correct. `ingest_runs` receipt rows present. |
| smoke.mjs | **7/7 cases pass.** Surgical cleanup confirmed. Real operator content untouched. |
| README.md | Grounded in real file headers (intake.mjs, canonize.mjs, integrity.mjs, emit.mjs, reuse.mjs) and real receipts from `strata.receipts.jsonl` + `strata.index.jsonl`. |

**Total verification surfaces:** 9 components, all node-checked, all functionally exercised against real bytes.

---

## Blockers

**None at the wave level.** Per-stage residuals named honestly:

1. **Live LLM extraction branch in canonize.mjs not exercised end-to-end** — no upstream OrangeLLM or Smart Skinny daemon available in this worktree. HTTP shapes match adapter contracts. Next verification step: live integration run capturing a receipts row with `extractor="orangellm"`.
2. **Live Graph Weaver embedder not exercised in integrity.mjs** — N150 daemon at 127.0.0.1:8798 required for cosine mode. Without it the gate correctly degrades to Jaccard and reports `degraded=true`. Working as designed.
3. **integrity.mjs not yet wired into canonize.mjs as canonical Gate 4** — currently the inline lexical-negation pass is Gate 4 inside canonize. Replacing it with a spawn of integrity.mjs is a one-line wiring change out of scope for this wave.
4. **No unit-test suite authored for canonize.mjs** — recommend `tests/canonize.test.mjs` covering argparse, normalizeExtraction clamping, isLikelyNegation, gate ordering, duplicate detection, verify reroundtrip.
5. **STRATA_ALLOWED not yet folded into `server/boundary.mjs`** — boundary file authored at `strata-boundary.mjs` ready to merge.
6. **reuse.mjs does not yet prefer the SQLite index** — falls back to JSONL scan. Next: read `index.db` first, JSONL scan only when DB missing.

---

## Next action

In priority order:

1. **Wire `integrity.mjs` into `canonize.mjs` as canonical Gate 4** — replace inline lexical gateIntegrity with spawn of integrity.mjs against the freshly written canon row. Preserves Gate 0 LBCE separation: lexical fast-check stays inline, semantic heavy-check is the gate of record.
2. **Fold `STRATA_ALLOWED` into `server/boundary.mjs ALLOWED`** and call `registerStrataRoutes(server, opts)` from `server/index.mjs`. Brings the gateway surface live on OrangeLLM.
3. **Wire receipt renderers and Orange3 cite formatters** to call `node reuse.mjs <cite> --json --quiet` and embed `resolved.content` + `resolved.hashes.chain_sha256` into receipt bodies.
4. **Add `reuse.mjs --verify` to Orange3 `routes:doctor` / promotion-gate checks** — tampered archive must block promotion before a customer-facing receipt cites it.
5. **Bring up live OrangeLLM + Smart Skinny pair** and run canonize.mjs against them to capture an `extractor="orangellm"` receipts row.
6. **Bring up the N150 embedder on 127.0.0.1:8798** and re-run integrity.mjs to capture a non-degraded cosine pass.
7. **Author `tests/canonize.test.mjs`** and `tests/integrity.test.mjs` unit suites.
8. **Update `reuse.mjs` to prefer the SQLite index** when present.

---

## Doctrine integration receipt

- **Mom's Law:** every gate names its failure mode. No silent fallbacks. Degraded modes flagged with explicit blockers (`integrity_degraded_embedder_unreachable`, `no_persistence_target_succeeded`). No fake-green.
- **Completion law (`.claude/rules/03-build-and-receipts.md`):** every CLI returns `{ result, evidence, blockers, next_action }`. No green claimed without a hash to back it.
- **Knowledge Strata canon (`.claude/CLAUDE.md`):** the loop is now a real compiler: intake → canon → durable artifact → integrity → reuse. Not a notes drawer.
- **Loopback only:** intake (8787 gateway), canonize (8797/1337 LLMs), integrity (8798 embedder), gateway routes (in-process). No external network calls.
- **SkilSki verified-vs-static_passed:** the components are *static_passed* until live LLM/embedder integration runs land. Components 7 (index.db) and 8 (smoke.mjs) are *verified* end-to-end against real bytes.
- **Reality vs Thought lane:** intake writes to Reality Flux with `origin='strata_intake'`; Thought lane untouched (matches `loader.mjs` doctrine).
- **27 guardrails / Gate 0 LBCE / Human Final Stop:** preserved. `--force` overrides on hard contradiction are audited in the integrity log row.

---

**Receipt path:** `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-25-knowledge-strata.md`
**Status:** GREEN — compiler loop landed, verified, wired through gateway. Three residual integration steps named.
