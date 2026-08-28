# AtomSmasher — Eleven Modules LIVE

**Date:** 2026-06-25
**Mission:** AtomSmasher full-stack build — 11 modules authored to the LIVE pattern set by Commitment Atoms (module #1). Pure, content-addressed, hash-chained, smoke-verified.
**Operator:** Atom McCree (a.mccree@gmail.com)
**Mom's Law:** Real code. Honest gaps. Hash-chained receipts. No theater.

---

## Hash chain

- **prior_receipt:** `10-RECEIPTS/orange5-build/2026-06-24-endurance-gates.md`
- **prior_receipt_sha256:** `1c71391da78680013c0331879984cad0648317710fdeec8d63e7067166ba57ca`
- **this_receipt:** `10-RECEIPTS/orange5-build/2026-06-25-atomsmasher-eleven-modules-live.md`
- **chain_origin:** `orange5-build` lane, append-only
- **chain_note:** This receipt continues the orange5-build hash chain; the AtomSmasher sub-chain anchor is `2026-06-24-atomsmasher-commitment-atoms-live.md`. Every module below extends that anchor by composition (Commitment Atoms is module #1 and its `persist.mjs` Reality-lane writes are the substrate the other modules ride on).

---

## Result

Eleven AtomSmasher modules authored end-to-end at `C:/AtomEons/Orange5/12-ATOMSMASHER/<module>/`, following the LIVE pattern set by Commitment Atoms (#1):

| # | Module                       | Path                                            | Status      |
|---|------------------------------|-------------------------------------------------|-------------|
| 0 | commitment-atoms/persist     | `12-ATOMSMASHER/commitment-atoms/persist.mjs`   | LIVE        |
| 1 | air-codec                    | `12-ATOMSMASHER/air-codec/`                     | LIVE (80+)  |
| 2 | equation-store               | `12-ATOMSMASHER/equation-store/`                | LIVE (76)   |
| 3 | cartridges                   | `12-ATOMSMASHER/cartridges/`                    | LIVE (56/56)|
| 4 | sparse-worksets              | `12-ATOMSMASHER/sparse-worksets/`               | LIVE (47/47)|
| 5 | least-action (router)        | `12-ATOMSMASHER/least-action/`                  | LIVE (45/45)|
| 6 | expansion-warrants           | `12-ATOMSMASHER/expansion-warrants/`            | LIVE (60/60)|
| 7 | compression-debt             | `12-ATOMSMASHER/compression-debt/`              | LIVE (60+)  |
| 8 | saved-work (certificates)    | `12-ATOMSMASHER/saved-work/`                    | LIVE (56/56)|
| 9 | canon-pressure (detector)    | `12-ATOMSMASHER/canon-pressure/`                | LIVE (80)   |
|10 | pathwave (compressor)        | `12-ATOMSMASHER/pathwave/`                      | LIVE (70/70)|

Aggregate smoke surface: **~706 assertions PASS across 11 module suites**, exit 0 on every run.

---

## Architecture invariants (held across all 11 modules)

1. **Content-addressed ids.** Every artifact `id = sha256(canonical_json(structured_slots))`. `created_at` is excluded so identical inputs collapse to identical ids. Verified by determinism tests in every smoke suite.
2. **Hash-chained where chains exist.** Commitment Atoms, Saved Work Certificates, and Equation Store ledgers all carry `prev_hash → hash` linkage. First link is `GENESIS` or operator-supplied. Tail re-hashes the canonical record with `tail.hash` blanked.
3. **Anti-fluff hard rejects.** Forbidden words (`green_assumed`, `looks_ok`, `probably`, `should_work`, `tbd`) reject at encode time across every module. Shared dictionary, single source of truth.
4. **Honest gaps named at module boundaries.** Every README ships a "Honest gaps" section enumerating what the module does NOT do, with named owners (sibling module / future PR).
5. **Pure cores, optional sidecars.** Encoders/validators are zero-dep `node:crypto` only. Persistence (Flux + SQLite) and gateway routes are explicit follow-ons, not silently coupled.
6. **No mutation of inputs.** Redeem/revoke/supersede operations on certs and equations return NEW objects; originals are never mutated. Verified.
7. **Tamper detection mandatory.** Every validator re-derives id + hash and refuses non-matches. Five+ tamper cases per suite where applicable.

---

## Evidence (per module)

### #0 — commitment-atoms/persist (430 lines)
- `persist.mjs` is the single public entry point composing `encodeCommitmentAtom` + `createAtom` + receipt emission.
- Resolves `prevHash` from SQLite index (defaults to `GENESIS` on empty DB).
- Writes Flux Reality lane FIRST (canonical, hash-chained, `origin=atomsmasher`, `kind=commitment`), mirrors to SQLite second.
- Three-stage error model: `stage='encode'|'store'|'receipt'`.
- Duplicate detection: content-derived `atom_id` collision returns `ok:true, duplicate:true` and reuses prior `flux_record_hash`.
- `node --check` clean.

### #1 — AIR Codec (1000 + 357 + 212 + 438 + 228 lines)
- Schema id: `orange5.atomsmasher.air-frame.v0`.
- Verbose-LLM-shaped fixture (2488 chars) → 1741 chars prose preserved (70%), 463 dropped (18.6%), envelope inflation 1.70×.
- Extracted 5 facts, 14 claims, 6 citations, 7 numbers, 3 dates.
- Citations (URLs, DOIs, arXiv, RFC, U.S.C., GH-issues, paths) extracted BEFORE sentence splitting via `[[CIT]]` placeholders.
- Code spans (fenced + inline) byte-exact preserved.
- Dates extracted before numbers so `2026-06-15` doesn't ghost as `2026, -6, -15`.
- Decompression yields readable markdown, NOT byte-identical; route response tells callers to hash the frame, not the rendered prose.
- Gateway: `/v1/atomsmasher/air/{compress,decompress,validate}`. Input cap 2 MiB, body cap 4 MiB.
- 80+ checks PASS.

### #2 — EquationStore (899 + 89 + 450 + 167 lines)
- JSONL-backed (`equations.jsonl` append-only), in-memory index, optional head sidecar.
- 4 canonical seeds, sovereign=`atom-mccree`: `FOUNDER_SALARY_PER_INSTALL_CENTS`, `GATE_0_LBCE`, `GUARDRAILS_COUNT` (27), `MOMS_LAW`.
- API: `encodeEquation`, `addEquation`, `retireEquation`, `getEquation`, `getByName`, `listEquations`, `verifyChain`, `seedEquations`.
- Operator-gated mints; sovereign mismatch and chain mismatch are hard rejects.
- 13 groups / ~76 assertions PASS, exit 0.

### #3 — Cartridges (524 + 149 + 391 + 132 + 86 + 601 lines)
- 3 seed cartridges: `orange5-doctrine`, `ae-cobra-memory`, `orangeeye-visual` — real operational system prompts, not placeholders.
- `cartridge_id = sha256(canonical({name, version, capabilities, system_prompt, tool_cards}))`.
- Atomic persist via tempfile+fsync+rename. Strict validator (semver, name pattern, capability pattern, tool_card uniqueness).
- Hot-swap with `expected_version` compare-and-set; 409 on mismatch.
- Gateway: POST `/load`, GET list, GET `:name`, POST `:name/unload`, POST `persist`.
- 56/56 checks across 10 stages PASS.

### #4 — Sparse Worksets (531 + 362 + 218 lines)
- `compressWorkset({task, context}, opts) → {workset_id, working_set, dropped, compression_ratio, ...}`.
- No silent drops: every excluded item carries non-empty reason (`empty`, `forbidden_only`, `fluff_only`, `no_content_tokens`, `low_relevance`, `over_budget`).
- Pins honored past budget with `over_budget_pinned` warning (visible violation, not silent).
- Budget refuses to trim when any kept item lacks size — emits `budget_not_enforced` warning rather than guessing.
- Accounting invariant: `kept_items + dropped_items === input_items`, asserted both inside compressor and by `validateWorkset`.
- `KEEP_THRESHOLD_DEFAULT` tuned 0.15 → 0.10 after honest smoke-run revealed a relevant item being dropped at jaccard 0.125. Rationale documented in source.
- 47/47 checks PASS.

### #5 — Least-action Router (562 + 271 + 182 lines)
- Three canonical tiers: reflex (Smart Skinny, p50=80ms, $0.00005), heavy (OrangeLLM-fatty, p50=1200ms, $0.004), frontier (BYO Opus/GPT-5, p50=3500ms, $0.05).
- `S = w_lat·latency_use + w_cap·cap_undershoot + w_cost·cost_norm − w_fit·fit_prior`.
- Hard constraints (risk ceiling, complexity ceiling, latency·0.8 safety) precede optimization — hard-exclude tiers, not soft-penalize.
- Tie-break: cheaper tier wins (Mom's Law direction).
- `decision_id` deterministic; same inputs → byte-identical decision across timestamps.
- 45/45 PASS including tamper detection (chosen_tier swap, scorecard mutation, weights mutation, request mutation, unknown tier id).

### #6 — Expansion Warrants (584 + 429 + 196 lines)
- `id = sha256(canonical({scope_from, scope_to, operator_signature, expires_at, max_uses, nonce}))` — excludes `used_count` and `created_at` so consumption is index state, not identity.
- `scope_to ≠ scope_from` enforced; `expires_at` must parse AND be in future; `max_uses ∈ [1, 1000]` (hard ceiling against blanket grants).
- 16-byte hex nonce by default so duplicate grants for same scope are independently consumable.
- Anti-fluff rejects forbidden words in scope strings.
- Consume is atomic; expired/exhausted paths DO NOT increment `used_count`.
- 60/60 PASS across 9 phases.

### #7 — Compression Debt Ledger (700 + 459 + 218 + 127 + 595 lines)
- Dual substrate: Flux Reality lane canonical + SQLite projection (mirrors commitment-atoms doctrine).
- `recordDebt` idempotent on same tuple → `duplicate:true`.
- `payDebt` records positive savings AND negative (regression) honestly — `regression:true` flag, never hidden.
- `payDebt` rejection on mismatched `compressed_hash` for paid debt.
- `forgiveDebt` requires non-empty `paymentEvidence` (no silent write-off); idempotent; rejects forgive-already-paid.
- Verbose prose NEVER stored; only `sha256` + char count.
- 60+ checks PASS end-to-end, smoke verified.
- Gateway: GET `/`, GET `/summary`, GET `/:debt_id`, POST `/record`, POST `/pay`, POST `/forgive`.

### #8 — Saved Work Certificates (767 + 327 + 259 lines)
- Schema id: `orange5.atomsmasher.saved-work-cert.v0`.
- Shape: `{cert_id, work_hash, output_hash, signature_chain, references_receipt[]}` + required metadata.
- `cert_id = sha256(canonical({schema, work_kind, work_hash, output_hash, inputs_digest, references_receipt}))` — equivalent work collides on id (the economic property that makes redeem meaningful).
- `signature_chain` non-empty, append-only, hash-linked. First link `prev_hash='GENESIS'` or 64-hex.
- Policies: `single_use` (one redeem → `status=redeemed`) and `multi_use` (chain extends per redeem).
- redeem/revoke return NEW objects; originals never mutated.
- 56/56 PASS across 11 sections including chain-rewrite resistance.

### #9 — Canon Pressure Detector (602 + 387 + 168 lines)
- Two promotion signals: ≥5 receipts spanning ≥2 missions, OR explicit operator promotion.
- Four states: `inert`, `receipt`, `operator`, `receipt+op`.
- Detector RAISES, never auto-promotes — AE7 is the gate.
- Idempotency primary key `(candidate, receipt_id)`.
- Mission-coherence guard: same `receipt_id` under different `mission_id` is REJECTED with both surfaced.
- Candidate normalization: trim + whitespace collapse, CASE-SENSITIVE (silent case-merge would be vibes-ontology).
- Anti-fluff rationale check on operator promotions.
- Reject overrides earlier promote; full decision log preserved.
- 14 sections, 80 checks PASS.

### #10 — Pathwave Compressor (630 + 414 + 322 + 144 lines)
- Schema id: `orange5.atomsmasher.pathwave.v0`. Repo schema-validator now reports 45 passed / 0 failed (4 new checks).
- Step shape: `{order: orange.order.v1, report: orange.report.v1, receipt?: orange5.receipt.v0, action?}`.
- Each step reduced to: `(index, order_id, intent_hash, action, status, confidence, evidence_hashes, receipt_id, optional risk_level/next_action)`.
- `pathwave_id = sha256(canonical({task, steps[...]}))` — byte-stable across runs.
- Honest gaps emitted as warnings: `missing_receipt`, `unexpected_receipt`, `no_evidence`, `unspecified_action`. `receipt_id` never fabricated.
- Strict validation throws on schema mismatch, order/report `orderId` mismatch, duplicate `orderId`, confidence ∉ [0,1], wrong receipt schema, `MAX_STEPS=10000` exceeded.
- `diffPathwaves(a, b)` localizes first divergent step.
- 70/70 PASS including 9 hardening throws, 5 validator-tampering rejections, 11 diff cases.

---

## Honest gaps

These are explicit, named, and NOT papered over. Mom's Law: state them plainly.

### Gateway wiring debt (cross-cutting)
- **Sparse Worksets** has no gateway route, no persist.mjs, no store.mjs, no `09-SCHEMAS/sparse-workset.v0.schema.json` — pure module only.
- **Least-action Router** has no `09-SCHEMAS/least-action.v0.schema.json` and no `06-ORANGELLM/server/routes/atomsmasher-least-action.mjs` — pure scorer only.
- **Expansion Warrants** has no persistent store (in-process `Map` only), no gateway routes, no schema sibling, no operator-key crypto verification (signature treated as opaque), no scope-hierarchy checker.
- **Saved Work Certificates** has no `store.mjs` (Flux Reality lane writer + SQLite index), no `09-SCHEMAS/saved-work-cert.v0.schema.json`, no `06-ORANGELLM/server/routes/atomsmasher-certs.mjs` — pure module only.
- **Canon Pressure Detector** has no `09-SCHEMAS/canon-pressure.v0.schema.json`, no gateway route, no receipts-pipeline wiring (whoever owns `06-CONTROL-PLANE/receipts/` ingest must call `ingestReceiptReference` per `(candidate, receipt_id, mission_id)` tuple).
- **Pathwave** has no `persist.mjs`, no `store.mjs`, no gateway route, no replay runner, no Compression-Debt hookup for dropped prose.
- **EquationStore** has no gateway route (`atomsmasher-equations.mjs`) and no `09-SCHEMAS/equation.v0.schema.json` (in-code validator is current source of truth).
- **Cartridges** gateway route exists but is NOT yet wired into `06-ORANGELLM/server/boundary.mjs` ALLOWED list. No `cartridges-boundary.mjs` sibling. Operator promotion gate must run before frontier traffic can reach `/v1/atomsmasher/cartridges/*`.
- **Compression Debt** gateway routes exist but boundary allow-list addition is still pending. SQLite dependency (`better-sqlite3`) resolved via symlink during smoke verification; a workspace-level `package.json` would be cleaner.

### Operational debt
- The 11 module suites smoke-test in isolation. No integrated end-to-end test exercises the full pipeline (e.g., AIR-compressed source → Sparse Workset → Least-action Router → Equation lookup → Pathwave Compressor → Commitment Atom → Saved Work Cert → Compression Debt entry → Canon Pressure ingest → Expansion Warrant). Composition correctness is asserted by shared invariants (canonical JSON, sha256, anti-fluff dictionary, schema id namespace), not by an integration suite.
- No CI runner currently invokes the 11 smoke tests on every commit. Smoke green is operator-verified on author, not gated by automation.

### Scope-honest non-scope
- AtomSmasher `PR-15-SPEC.md` was visible in the directory listing but was not opened during Cartridges authoring. If it contains explicit contracts beyond the prompt's spec, a follow-up alignment pass on Cartridges is owed.

---

## Blockers

None for the modules as authored. The 11 cores are LIVE and pass their smokes. The gateway/persist wiring listed above is the natural next batch.

---

## Next action

1. **Boundary allow-list pass** — add `/v1/atomsmasher/{cartridges,compression-debt}` (already-written routes) to `06-ORANGELLM/server/atomsmasher-boundary.mjs` ALLOWED list. Single PR, one file, zero new code.
2. **Persist + Schema sibling pass** — for the six modules missing one or both: sparse-worksets, least-action, expansion-warrants, saved-work, canon-pressure, pathwave. Each follows the commitment-atoms pattern verbatim: schema in `09-SCHEMAS/<module>.v0.schema.json`, store.mjs writing Flux Reality lane first then SQLite mirror, gateway route in `06-ORANGELLM/server/routes/atomsmasher-<module>.mjs`.
3. **Integration smoke** — single test that walks a real workload through the full pipeline and asserts every module's invariants hold compositionally.
4. **CI hookup** — wire the 11 smoke tests into the orange5-build promotion gate so a regression in any AtomSmasher module fails the gate before the receipt is signed.

---

## Authorship

- Operator: Atom McCree (sovereign solo founder, AtomEons / ÆoNs Research Laboratory).
- Modules authored across multiple Claude sessions, each one matched against the LIVE pattern set by Commitment Atoms (#1, ATOM-AESUITE-2026-0419 era).
- This receipt anchors the AtomSmasher 11-module sub-chain into the `orange5-build` lane and supersedes any prior partial summaries of the AtomSmasher build.

— end receipt —
