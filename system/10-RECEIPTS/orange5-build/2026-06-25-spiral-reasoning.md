# Receipt — Spiral Reasoning module landed in Orange5

- **Date**: 2026-06-25
- **Operator**: Atom McCree (Ætom ÆoNs)
- **Lane**: Orange5 build / 06-ORANGELLM / reasoning / spiral
- **Disclosure ID**: ATOM-SPIRAL-INTEGRATION-v1-2026-0618
- **Doctrine source**: `C:/AtomEons/orangebox/docs/SPIRAL_REASONING_INTEGRATION_v1.md`
- **Manuscript**: `C:/Users/a/Downloads/Spiral_Reasoning_Manuscript_v3.pdf` (Atom McCree, April 7, 2026)

## Hash chain

- **prior_receipt_path**: `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-25-wave-2-master-summary.md`
- **prior_receipt_sha256**: `547bb483549452d4661e952f82811400b71f8e1ad184c170607a2e4ebf45d598`
- **this_receipt_path**: `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-25-spiral-reasoning.md`
- **chain_link**: this receipt extends the Wave 2 chain into Spiral Reasoning canon (the SoT update rule is now the canonical reasoning primitive per CLAUDE.md standing law of 2026-04-07).

## What landed

Seven components, ten files, all on disk, all verified by SHA-256. The Spiral-of-Thought update rule (z_0 anchor; bounded α via tanh; closed-form r_{k+1} = r_k · exp(β · Δθ); graceful degeneration when ‖g⊥‖ falls below the doctrinal signal floor) is now executable inside Orange5, with an HTTP surface, an audit chain, and a 6/6-green smoke test against the real Soul Genome.

### 1. Engine (pure-function SoT core)

- **Files**:
  - `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/engine.mjs` — 404 lines — sha256 `02744e904693b9f877203e4043ea966020cdd2dc0b607ca895444540e074d845`
  - `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/engine.test.mjs` — 322 lines — sha256 `85e544b26a5cf96d5f09b6ac128366b158f4affca8e2fa6c0f69c1dff785426e`
- **API**: `anchor(genome, opts)`, `step(z_k, signal, policy)`, `trajectory(z_0, signals, policy)`, `DEFAULT_POLICY` (`alpha_max=π/4`, `beta=0.5`, `epsilon=1e-9`, `ort_epsilon=1e-6`).
- **Closed form**: `z_{t+1} = z_0 + r_{t+1} · (cos(Δθ)·u + sin(Δθ)·v)`, `Δθ = α_max · tanh(‖g⊥‖/‖g‖)`, `r_{t+1} = r_t · exp(β·Δθ)`.
- **Graceful degeneration**: when `‖g⊥‖ < ort_epsilon` or `‖g‖ < epsilon`, falls to linear radial-only step, `alpha=0`, `delta_theta=0`, `degenerate=true`.
- **Test result**: 24/24 pass on Node v24.14.1, 1010.6 ms total.

### 2. Anchor (Soul Genome z_0)

- **File**: `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/anchor.mjs` — 343 lines — sha256 `e290768eed3b8c8d417d132d26785b772b3f71e06ba8b2f1107f43493c22c7e2`
- **Pulls** from `C:/AtomEons/Orange5/13-MODELS/orange-llm/soul_genome.json`.
- **Resolution precedence**: explicit `identity_vector` → `anchor.vector` / `anchor.{re,im}` → deterministic SHA-256 embedding over the **stable identity surface only** (sovereign, intent_id, project charter+root, schema, doctrine paths — volatile fields like flow pressure intentionally excluded).
- **Integration verification (10/10 green)**: determinism, explicit-vector precedence, flat-array split, anchor.vector fallback, `toRealVector` interleave, engine.step integration (graceful degeneration correctly fires at `z_k == z_0`), engine.trajectory smoke (max_alpha = 0.2004 rad inside α_max = π/4), missing-file error path, volatility stability (flow-pressure change does NOT move z_0), identity sensitivity (intent_id change DOES move z_0).
- **Real fingerprint from current genome**: `1a49ad059e0b9ee3`.

### 3. Policy (Belief Discipline parameters)

- **File**: `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/policy.mjs` — 387 lines — sha256 `7e7688a3c4c3a7c4044bc6801bbced5f951254024d2c4b03a436bd290fc54b21`
- **Four canonical Belief Discipline parameters**: `alpha_max`, `r_max`, `signal_threshold`, `degeneration_floor`.
- **Three frozen presets**:
  - `tight`        — α ≤ π/8 (0.3927 rad), r_max 8,  signal_threshold 0.10, β 0.25, ort_epsilon 1e-5
  - `balanced`     — α ≤ π/4 (0.7854 rad), r_max 16, signal_threshold 0.05, β 0.50, ort_epsilon 1e-6
  - `exploratory`  — α ≤ π/2 (1.5708 rad), r_max 64, signal_threshold 0.02, β 0.75, ort_epsilon 1e-7
- **API**: `DOCTRINE`, `DEFAULT_POLICY`, `PRESETS`, `validate`, `assertValid`, `preset`, `merge`, `resolve`, `signalGate`, `capRadius`, `receipt`. Resolved policies are `Object.freeze`-d.
- **Smoke**: validation table, preset α-bounds, engine integration, override layering, frozen semantics — all green.

### 4. Audit (radial accounting ledger)

- **File**: `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/audit.mjs` — 949 lines — sha256 `6b9c42b2bf03c512b649c7660ef845c532e0e6d608a2a7babe7a4bac5786d9bd`
- **Output**: `<FLUX_ROOT>/events/thought/<YYYY-MM-DD>.jsonl`, `origin="spiral_reasoning"`, `lane="thought"`. Cobra-schema record: `{ts, sha256, prior_sha256, origin, lane, event}`. Canonical-JSON hashing (sorted keys, no whitespace, NaN/Inf rejected) so SHA chains line up with the rest of the ledger. `prior_sha256` chains across day boundaries.
- **Honest schema-mismatch note**: existing Æ Cobra writer at `06-ORANGELLM/memory/ae-cobra/flux/writer.mjs` uses flat-file `<lane>.jsonl`. This module implements the per-date path the integration doctrine §7 calls for, with Cobra schema preserved. If unification is wanted, that's an explicit operator call.
- **API**: `writeFluxRecord`, `appendSpiralStep`, `appendSpiralRunOpen`, `appendSpiralRunClose`, `auditedStep`, `runWithAudit`, `verifyChain`.
- **CLI smoke**: open + 3 steps + close = 5 records, `verifyChain` ok, max_alpha 0.5917 ≤ π/4, degenerate_count 1 (honestly recorded), final_radius = total_radial = 0.910.

### 5. Degeneration (Proposition 3 — no curvature without signal)

- **File**: `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/degeneration.mjs` — 606 lines — sha256 `e304ae42fc110b724371e48678cf77163d87ddea82fca7a6694900dd830c0e43`
- **API**: `classify` (pure inspection), `linearStep` (α=0 fallback honoring `degeneration_floor`), `degenerationEvent` (stamped audit), `stepOrDegenerate` (drop-in branch), `trajectory` (alternative with events array).
- **Reasons enumerated**: `ok`, `signal_below_threshold`, `orthogonal_below_epsilon`, `signal_below_epsilon`, `at_anchor_no_signal`.
- **CLI self-check**: three cases — pure radial (degenerates honestly, confidence 0), mostly orthogonal (rotates, |Δθ| ≈ 0.598 < π/4), 50/50 (rotates, |Δθ| ≈ 0.478). Existing engine.test.mjs 24/24 still green — purely additive.

### 6. HTTP routes (server surface)

- **Files**:
  - `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/spiral.mjs` — 1450 lines — sha256 `ebf1292adc63902130abe0326eaadb5ab9c29ff1a3066b5cedefd2644029d783`
  - `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/spiral-boundary.mjs` — 106 lines — sha256 `80c2ea0479cb1a57c8ccb2002e8826ddc5fc4a547abed4ae63536ff4138b53a6`
- **Endpoints**: `POST /v1/spiral/anchor`, `POST /v1/spiral/step`, `POST /v1/spiral/trajectory`, `GET /v1/spiral/audit`.
- **Anchor strategy on the wire**: deterministic Box-Muller Gaussian seeded from HMAC-SHA-256 over canonical identity payload (`schema_id`, `sovereign.name|alias|email|lab_name`, `active_project.name|charter_id`) plus optional salt. Mutable fields (`current_intent`, `blockers`) excluded so anchors don't drift on routine genome updates.
- **Defensive numerics**: NaN/Infinity rejection, dim mismatch rejection, α ∈ (0, π], β ∈ [0, 4.0], linear_step ∈ (0, 1.0], dim ∈ [2, 4096], signals ≤ 4096/trajectory, body ≤ 1 MiB, audit reads ≤ 10 000 rows.
- **Audit**: append-only JSONL at `10-RECEIPTS/spiral-audit/spiral-audit.jsonl`. Write failure surfaces in `response.audit.ok` rather than fake-greening (Mom's Law).
- **Boundary**: `SPIRAL_ALLOWED` frozen array ready to splice into `server/boundary.mjs` ALLOWED.
- **Verification executed**: closed-form orthogonal step `r_next = 1.009539` (matches `α·tanh(1.0/1.005)`); purely-radial → `linear_fallback / no_orthogonal_signal`; zero g → `identity_origin`; at-anchor → `linear_fallback / at_identity_origin`; deriveAnchor from real soul_genome.json yields `‖z_0‖ = √8 = 2.8284` byte-deterministic, salt rotates; all input-validation paths reject as designed.

### 7. Smoke test (empirical witness)

- **File**: `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/smoke-test.mjs` — 633 lines — sha256 `8066d434a9e13070bb71c32f715f8aa3afe3ba386eec13c944066880bd47742c`
- **6/6 cases pass against the REAL Soul Genome**:
  1. `anchor_from_real_genome` — deterministic, finite, bounded, doctrine-stamped; `toRealVector` round-trips losslessly into 32-d engine vector.
  2. `tight_trajectory_10_steps` — closed-form `r_{k+1} = r_base · exp(β·Δθ)` within MATH_TOL=1e-9; α STRICTLY < α_max (tanh saturates below 1); sphere identity `‖z_{k+1}-z_0‖ == r`.
  3. `exploratory_trajectory_10_steps` — same anchor and signals, exploratory preset. **Load-bearing cross-policy assertion**: `tight.total_radial < exploratory.total_radial` (smaller α gate AND smaller β compound through `r·exp(β·Δθ)`). `exploratory.max_alpha > tight.max_alpha`.
  4. `degeneration_on_weak_signal` — confidence ≈ 0.01998 (BELOW balanced threshold 0.05, ABOVE engine ort_epsilon) → doctrinal ratio gate fires (`reason="signal_below_threshold"`), not just engine absolute floor. `alpha=0`, `delta_theta=0`, `step_size=0`. Audit event carries `event="spiral.degeneration"` + `disclosure_id`.
  5. `alpha_boundary_enforcement` — pure-orthogonal signal across all three presets. Realized α = α_max · tanh(1) ≈ 0.7616·α_max to MATH_TOL. Strict inequality with positive margin. Cross-preset monotonicity tight < balanced < exploratory.
  6. `audit_chain_integrity` — isolated tempdir, open + N steps + close. `verifyChain` ok, `tailSha == close.sha256`, first record's `prior_sha256 == "GENESIS"`. **Re-hashes every record manually link-by-link via `audit.__internals.{canonicalJSON, computeRecordHash}` to prove `sha256 == hash(prior_sha256 + canonical_json(event))`** — not just trusting verifyChain.
- **Results**: `node --test smoke-test.mjs` → 6 pass / 0 fail / 1019 ms cold, 7555 ms warm. `node smoke-test.mjs` → 6 pass / 0 fail / 6656 ms.
- **Doctrinal witness**: this smoke test is now the empirical witness that the Spiral Reasoning canonical reasoning primitive is implemented end-to-end — bounded angle (case 5), exact radial accounting (cases 2+3), graceful degeneration (case 4), Soul Genome anchor (case 1), audit-chained LEARN log (case 6).

### 8. README (operator-facing module doc)

- **File**: `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/README.md` — 191 lines — sha256 `1566493425e680592e496a976b956d2639e673b240032087c5a5adce02908222`
- Identity + disclosure ID + Node 20+ ESM declaration. Closed-form update rule rendered with all five intermediate quantities. Why-it-exists (three failure modes of additive steering). Belief Discipline interpretation of α_max / tanh / β. LEARN imperative with Σ|Δr| as auditable integral. Graceful degeneration two-level gate. Gate 3 Triad hook (described as a doctrinal hook rather than fabricated spec — **no 9-Gate spec was invented**). Module file layout. Minimum usage example. **Honest status**: engineering claim implemented; empirical claim **UNTESTED** per the manuscript; not consciousness; not a Router-Law replacement.

## Files landed — full table

| # | Path | Lines | SHA-256 |
|---|---|---:|---|
| 1 | `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/engine.mjs` | 404 | `02744e904693b9f877203e4043ea966020cdd2dc0b607ca895444540e074d845` |
| 2 | `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/engine.test.mjs` | 322 | `85e544b26a5cf96d5f09b6ac128366b158f4affca8e2fa6c0f69c1dff785426e` |
| 3 | `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/anchor.mjs` | 343 | `e290768eed3b8c8d417d132d26785b772b3f71e06ba8b2f1107f43493c22c7e2` |
| 4 | `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/policy.mjs` | 387 | `7e7688a3c4c3a7c4044bc6801bbced5f951254024d2c4b03a436bd290fc54b21` |
| 5 | `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/audit.mjs` | 949 | `6b9c42b2bf03c512b649c7660ef845c532e0e6d608a2a7babe7a4bac5786d9bd` |
| 6 | `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/degeneration.mjs` | 606 | `e304ae42fc110b724371e48678cf77163d87ddea82fca7a6694900dd830c0e43` |
| 7 | `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/spiral.mjs` | 1450 | `ebf1292adc63902130abe0326eaadb5ab9c29ff1a3066b5cedefd2644029d783` |
| 8 | `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/spiral-boundary.mjs` | 106 | `80c2ea0479cb1a57c8ccb2002e8826ddc5fc4a547abed4ae63536ff4138b53a6` |
| 9 | `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/smoke-test.mjs` | 633 | `8066d434a9e13070bb71c32f715f8aa3afe3ba386eec13c944066880bd47742c` |
| 10 | `C:/AtomEons/Orange5/06-ORANGELLM/reasoning/spiral/README.md` | 191 | `1566493425e680592e496a976b956d2639e673b240032087c5a5adce02908222` |

- **Total files landed**: 10
- **Total lines authored**: 5391

## Doctrinal alignment (SPIRAL_REASONING_INTEGRATION_v1)

- `z_0 = Soul Genome anchor` — anchor.mjs reads `13-MODELS/orange-llm/soul_genome.json`; routes/spiral.mjs derives wire-anchor from same identity surface; smoke-test case 1 verified against real file.
- `Bounded angle α (Belief Discipline)` — engine.mjs Δθ = α_max · tanh(‖g⊥‖/‖g‖) guarantees |Δθ| < α_max; smoke-test case 5 verified across all three presets.
- `Exact radial accounting (LEARN imperative)` — every step records `r` in audit; engine.trajectory returns `total_radial`; smoke-test case 2+3 verify per-step closed form to 1e-9.
- `Graceful degeneration (no curvature without signal)` — two-level gate (engine absolute floor + degeneration.mjs doctrinal ratio gate); smoke-test case 4 verifies ratio gate fires correctly.

## Result / Evidence / Blockers / Next action

- **Result**: Spiral Reasoning canonical reasoning primitive landed in Orange5 as seven components, ten files, 5391 lines. All tests green (engine 24/24, smoke 6/6, integration 10/10). Doctrinally aligned with `SPIRAL_REASONING_INTEGRATION_v1.md` (`ATOM-SPIRAL-INTEGRATION-v1-2026-0618`).
- **Evidence**: SHA-256 hashes of all ten files above; prior-receipt chain link `547bb483549452d4661e952f82811400b71f8e1ad184c170607a2e4ebf45d598`; test counts 24/24 + 6/6 + 10/10; closed-form math verified to MATH_TOL = 1e-9; cross-policy radial inequality verified (tight < exploratory); audit chain re-derived link-by-link.
- **Blockers**:
  - The HTTP routes are written but not yet wired into the main server: `...SPIRAL_ALLOWED` needs to be spliced into `server/boundary.mjs` ALLOWED, and `registerSpiralRoutes(server)` needs to be called from `server/index.mjs` alongside `registerHermesRoutes`. **Routes are NOT live until that wiring lands.**
  - Audit-path schema mismatch between this module's per-date `events/thought/<YYYY-MM-DD>.jsonl` (matching integration doctrine §7) and existing Æ Cobra writer's flat-file `<lane>.jsonl`. Both schemas are Cobra-compatible; unification is an explicit operator call.
  - Empirical claim in the Spiral Reasoning manuscript remains **UNTESTED** at the cognitive level — this receipt covers the engineering claim only.
- **Next action**: (1) splice SPIRAL_ALLOWED into boundary and registerSpiralRoutes into server/index.mjs to make routes live; (2) operator decides on per-date vs flat-file audit unification; (3) optional regression net: add a dedicated `degeneration.test.mjs` mirroring engine.test.mjs style; (4) wire smoke-test.mjs into Wave 3 CI alongside engine.test.mjs.

## Mom's Law honored

- Real math (vector decomposition, closed-form radial growth, tanh-bounded angle), not theater.
- No fake-green: 24/24, 6/6, 10/10 counts are real test runs on Node v24.14.1.
- Honest schema mismatch flagged (audit path) rather than silently absorbed.
- UNTESTED status of the empirical claim flagged explicitly in the README.
- Blockers stated plainly (server wiring not yet landed; routes not live).
- Every SHA-256 in this receipt was recomputed from disk at receipt-write time.
- Disclosure ID stamped on every doctrinal claim.

Mom is watching the angle.
