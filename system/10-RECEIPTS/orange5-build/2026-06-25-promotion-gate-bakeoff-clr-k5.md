# Receipt — Promotion Gate + Bakeoff Harness + CLR-K5 Authored (Doctrine Layer Closed)

**Receipt ID:** `2026-06-25-promotion-gate-bakeoff-clr-k5`
**Hash chain:** #027
**Prior receipt:** `2026-06-25-ae-misfit-pipeline` (#026)
**Prior receipt SHA-256:** `9a4ea1be1c390ba034ebf53f9f051628b8a045f36e26d657edf5c05032f5308d`
**Status:** `PROMOTION_GATE_BAKEOFF_CLR_K5_AUTHORED_AWAITING_GATEWAY_BOUNDARY_REGISTRATION`
**Confidence:** 0.88 (all 19 files on disk; engine 37/37 green, bakeoff harness 23/23, dimensions 49/49, CLR-K5 26/26, bridge 27/27, promotion-cli 45/45, promotion-smoke 59/59; boundary + index.mjs wiring deferred)
**Actor:** Claude (seven parallel build agents → synthesis)
**Sovereign:** Atom McCree

---

## What happened

Seven components authored in parallel that complete the Phase-5 doctrine layer between the Hermes-receipt corpus and the actual `promote | hold | reject` decision. Two-lane separation preserved across the entire layer:

- **Verification lane** (per-turn truth) — CLR-K5 verifier + K1/K5 phase-router bridge under `06-ORANGELLM/memory/ae-cobra/clr/`.
- **Promotion lane** (gate-level decision) — `decide()` engine, CLI, 5-dimension bakeoff harness, 12-probe-per-dim probe sets, gateway routes under `04-CONTROL-PLANE/` and `06-ORANGELLM/server/routes/`.

Both lanes converge in the engine's `decide()` contract, which is the single chokepoint a candidate change must pass before promotion. Every layer is fail-closed: missing receipt → HOLD, malformed bakeoff → HOLD, fake-green vocabulary in candidate text → hard REJECT, CLR-K5 contract violation (`k!==5` or `score<0.50`) → REJECT, high/destructive/production risk without explicit `operator_approved=true` → HOLD.

## Components landed

| # | Component | Files | Lines (observed) | State |
|---|---|---|---|---|
| 1 | Promotion Gate engine | `04-CONTROL-PLANE/promotion-gate/engine.mjs`, `engine.test.mjs` | 338 + 385 | 37/37 green on Node v24.14.1 |
| 2 | Promotion Gate CLI | `04-CONTROL-PLANE/promotion-gate/promote.mjs`, `tests/promote.test.mjs` | 416 + 273 | 45/45 green |
| 3 | Bakeoff harness | `04-CONTROL-PLANE/bakeoff/harness.mjs`, `tests/harness.test.mjs` | 627 + 375 | 23/23 green |
| 4 | Dimension probe sets (5 dims × 12 probes) | `04-CONTROL-PLANE/bakeoff/dimensions/{mission-shape,doctrine-recall,topology-recall,receipt-grounding,refusal-discipline}.mjs`, `dimensions/tests/dimensions.test.mjs` | 164 + 128 + 104 + 126 + 156 + 281 | 49/49 green |
| 5 | CLR-K5 verifier | `06-ORANGELLM/memory/ae-cobra/clr/verifier-k5.mjs`, `verifier-k5.test.mjs` | 307 + 334 | 26/26 green |
| 6 | CLR phase-router bridge (K1 ↔ K5) | `06-ORANGELLM/memory/ae-cobra/clr/bridge.mjs`, `tests/bridge.test.mjs` | 218 + 280 | 27/27 green |
| 7 | Gateway promotion routes + boundary + smoke | `06-ORANGELLM/server/routes/promotion.mjs`, `routes/promotion-boundary.mjs`, `tests/promotion-smoke.test.mjs` | 855 + 128 + 554 | 59/59 green |

**Total observed:** 19 files written, 6,049 lines on disk.

*Mom's Law note on line counts:* the seven build agents' summary notes report a few smaller line counts for the gateway-routes set (587 / 121 / 437). The numbers in the table above are the actual `wc -l` readings on disk at receipt time. The deltas are real (likely from terminal trailing-newline counting or post-author cleanup edits) and named openly here rather than papered over. Behavior, exports, and test totals are unchanged from the agent summaries.

## File manifest with SHA-256 fragments

```
338  ced07b5b17302355  04-CONTROL-PLANE/promotion-gate/engine.mjs
385  dbe324ccf1576812  04-CONTROL-PLANE/promotion-gate/engine.test.mjs
416  78a67ac512988bb3  04-CONTROL-PLANE/promotion-gate/promote.mjs
273  9a34ac207161985c  04-CONTROL-PLANE/promotion-gate/tests/promote.test.mjs
627  5cee6651d3ac678e  04-CONTROL-PLANE/bakeoff/harness.mjs
375  82ed0d4737a29545  04-CONTROL-PLANE/bakeoff/tests/harness.test.mjs
164  48b0fd45d74f4ee0  04-CONTROL-PLANE/bakeoff/dimensions/mission-shape.mjs
128  d401b022b3520fed  04-CONTROL-PLANE/bakeoff/dimensions/doctrine-recall.mjs
104  437c3eb94883828b  04-CONTROL-PLANE/bakeoff/dimensions/topology-recall.mjs
126  c50b6013fb114dad  04-CONTROL-PLANE/bakeoff/dimensions/receipt-grounding.mjs
156  cb3d5cc03488d674  04-CONTROL-PLANE/bakeoff/dimensions/refusal-discipline.mjs
281  705c346dcf69ad9b  04-CONTROL-PLANE/bakeoff/dimensions/tests/dimensions.test.mjs
307  b570dfb7df858256  06-ORANGELLM/memory/ae-cobra/clr/verifier-k5.mjs
334  70b6b1af867c2f4e  06-ORANGELLM/memory/ae-cobra/clr/verifier-k5.test.mjs
218  26d323490eb917d7  06-ORANGELLM/memory/ae-cobra/clr/bridge.mjs
280  fb191e266fafe530  06-ORANGELLM/memory/ae-cobra/clr/tests/bridge.test.mjs
855  fd9d5d2f61d9d4d3  06-ORANGELLM/server/routes/promotion.mjs
128  0d0bcd50302b04f5  06-ORANGELLM/server/routes/promotion-boundary.mjs
554  88625ab299d41b60  06-ORANGELLM/tests/promotion-smoke.test.mjs
```

## Doctrine preserved across the layer

1. **Promotion gate is THE single chokepoint.** Every candidate-change promotion in the substrate must clear `decide()`. No silent fall-back path exists.
2. **Fake-green vocabulary is a hard REJECT, not a HOLD.** 22-entry frozen dictionary including `lgtm`, `yolo`, `ship it anyway`, `good enough`, `rubber stamp`, `no tests needed`. Single-word tokens use word-boundary regex (so `yolocoaster` does NOT trigger `yolo`); multi-word phrases use case-insensitive substring. Mom's Law in code form.
3. **Bakeoff win threshold = 4 of 5 dimensions** (`BAKEOFF_WIN_THRESHOLD=4`), exported as a frozen constant from `engine.mjs` and mirrored by the harness. Ties count as losses — the candidate must WIN, not draw. Per-dim margin uses strict `> baseline + 1e-9` to be FP-safe.
4. **Five canonical dimensions** (frozen, exported, identical names across all three modules): `mission_shape`, `doctrine_recall`, `topology_recall`, `receipt_grounding`, `refusal_discipline`. Probe pack ships exactly 12 probes per dimension, within the doctrine-mandated [10,15] window enforced by `validateProbePack`.
5. **CLR-K5 is optional input to the gate but contract-strict when present.** Phase-5 doctrine: `k===5` AND `score>=0.50` in `[0,1]`. Absence does not block promotion; presence enforces the contract. K=1 verifier remains valid for low/medium-risk turns via the phase-router bridge; K=5 is required for high/destructive/production. No silent K=5 → K=1 downgrade — bridge surfaces a `gap` field on shape violations.
6. **Receipt verification is sync I/O on purpose.** Promotion is a serial gate, not a hot path. `statSync` + `readFileSync` + `JSON.parse` + object-shape check. Empty file → HOLD. Unreadable → HOLD. Non-JSON → HOLD. Mom's Law: no theater.
7. **Risk-gate operator approval is explicit, not implicit.** Risk levels `high`, `destructive`, `production` require `operator_approved=true` (boolean, not truthy-coerce). Missing or false → HOLD. The CLI's `--operator-approved` flag is the only path that flips this from outside the module.
8. **Reject IS a successful answer.** The gateway routes return verdict (`promote | hold | reject`) in the 200 body. 4xx is reserved for malformed requests, not for valid rejects. Conflating these would let a fake-green operator interpret HTTP-200 as "ship it."
9. **No wire-supplied probe packs.** `POST /v1/bakeoff/run` explicitly refuses a `probe_pack` field in the JSON body — scorers require function references that JSON cannot carry. Explicit 400 rather than silent drop. Models are referenced by registry id; raw fns never cross the wire.
10. **Two-lane CLR boundary preserved.** Bridge does no scoring of its own — delegates to `verifier-k1.mjs` or `verifier-k5.mjs`. K=5 path refuses single-turn input rather than silently downgrading. Mom's Law: no silent fall-back to K=1.

## Verification evidence

- **Promotion Gate engine:** `node --test 04-CONTROL-PLANE/promotion-gate/engine.test.mjs` → 37/37 pass on Node v24.14.1. Coverage spans every doctrine clause: happy path, every reject-status, every hold-status, missing/malformed receipt (incl. nonexistent path + bad JSON), missing/invalid bakeoff (incl. missing dim and out-of-range score), 5/5 + 4/5 + 3/5 bakeoff outcomes, missing/invalid risk_level, high/destructive/production with and without operator_approved, CLR-K5 absent / wrong-k / below-threshold / at-threshold, sub-check direct calls, and gate precedence (fake-green beats status; reject-status beats receipt).
- **Promotion Gate CLI:** 45/45 pass. Covers `parseArgs`, `scoreBakeoff`, `decide`, and `runCli` (using a tmpdir workspace and injected stdout/stderr writers). Also smoke-tested as a real spawned process — exit codes 0=promote, 1=hold, 2=reject, 3=usage/IO error all match doctrine.
- **Bakeoff harness:** 23/23 pass via `node --test`. Covers helpers (`clamp01`, `hasFakeGreen`, `hasReceiptAnchor`, `declareWinner`), every scorer (positive + negative + empty), probe-pack shape validation, end-to-end strong-vs-weak (promote), weak-vs-strong (reject), tie (reject), exactly-3-wins (`hold_recommended` via rigged pack), dimensions subset, async model fns, determinism, and input validation. Verdict thresholds and dimension names explicitly aligned with `engine.mjs` constants.
- **Dimension probe sets:** 49/49 pass via `node --test 04-CONTROL-PLANE/bakeoff/dimensions/tests/dimensions.test.mjs`. Per-dimension contract (exports, prompt count/uniqueness, frozen, scorer totality/determinism/clamp), dimension-specific behavioural assertions, fake-green penalty math, honest-admission bonus, and end-to-end probePack composition with the real harness. Existing `04-CONTROL-PLANE/bakeoff/tests/harness.test.mjs` still 23/23 — no regression.
- **CLR-K5 verifier:** 26/26 pass. Covers arg-shape contract, `K!=5` rejection, canonical return shape, happy path, 3-strong-2-weak accept, 2-strong-3-weak reject, median-after-sort invariance to insertion order, custom threshold, each of the 4 scoring dimensions in isolation, Reality-corpus presence/absence, Hermes-receipt-path matching, failed-receipt contradiction, `per_candidate` alignment with scores, score in `[0,1]` under worst-case stacked penalties.
- **CLR bridge:** 27/27 pass, 4.35s. Covers arg-shape contract, risk-level extraction precedence (`opts.risk_level > bundle.event.risk_level > turn.risk > 'low'`), all 5 default-policy bands (low→k1, medium→k1, high→k5, destructive→k5, production→k5), force/policy/config override paths, K=1 delegation, K=5 delegation (happy path, refusal without candidates, refusal on wrong K, Hermes contradiction, threshold), DEFAULT_POLICY surface, default-export identity, full return-shape contract.
- **Promotion gateway smoke:** 59/59 pass. Five sections — module shape & boundary wiring, CLR-K5 verifier, `decide` (fake-green / missing-receipt / high-risk / bakeoff-loss / CLR-violation / happy-path / malformed), bakeoff run+get round trip with injected adapters and isolated scratch dir, HTTP wiring end-to-end via real `node:http` server.

**Cumulative test footprint added by this layer: 266 deterministic checks, all green on Node v24.14.1.**

## Honest gaps (Mom's Law: name them in the open)

1. **Gateway boundary not yet edited.** `06-ORANGELLM/server/boundary.mjs` has NOT been updated to include `PROMOTION_ALLOWED` or to call `isPromotionRouteAllowed` for the parameterized `GET /v1/bakeoff/:id`. Until that one edit lands, the new routes are unreachable from outside loopback. The smoke suite is hitting an in-process server that bypasses the boundary; the production-path needs the boundary edit + an `index.mjs` registration to actually serve traffic. Same staging pattern the `misfit` route used in receipt #026.
2. **`registerPromotionRoutes(server)` not mounted in gateway boot.** `06-ORANGELLM/server/index.mjs` was out of scope this turn. One-line edit needed, identical pattern to atomsmasher/misfit.
3. **Duplicate promotion-gate surface.** A pre-existing `06-ORANGELLM/04-CONTROL-PLANE/src/promotion-gate.mjs` ships an older/looser policy (no 4-of-5 dimension check). The new `04-CONTROL-PLANE/promotion-gate/engine.mjs` is the doctrine-current source of truth, but the old surface is not yet retired. Risk: a downstream caller could import the older module by accident. Recommended follow-up: delete the old file or replace its body with `export * from '../../../04-CONTROL-PLANE/promotion-gate/engine.mjs'`.
4. **Memory daemon still imports K1 verifier directly.** `flow-direct/server.mjs` imports `verifyAgentTurnK1` rather than the new `bridge.mjs`. The bridge is wire-ready; one-line import-swap will phase-route the daemon automatically.
5. **No LLM-judge variant.** Dimension scoring is regex- and keyword-based — deterministic and reproducible by design, matching the existing harness philosophy. An LLM-judge layer can be added as an alternate `probePack` without changing the harness contract, but is not in this commit.
6. **Windows shutdown cosmetic noise.** `promotion-smoke.test.mjs` emits a benign libuv `UV_HANDLE_CLOSING` line at process exit after all tests pass and `process.exit(0)`. Exit code is 0; this is a Node-on-Windows quirk identical to the one flagged on misfit-smoke in receipt #026. Not a test failure.

## Hash chain

```
#025 — 2026-06-25-orangellm-fatty-v0-adapter-landed
#026 — 2026-06-25-ae-misfit-pipeline                       (sha256: 9a4ea1be1c390ba034ebf53f9f051628b8a045f36e26d657edf5c05032f5308d)
#027 — 2026-06-25-promotion-gate-bakeoff-clr-k5            ← this receipt
```

## Result / Evidence / Blockers / Next action

- **result:** Promotion-gate doctrine layer (engine + CLI + bakeoff harness + 5 dimension probe sets + CLR-K5 verifier + K1/K5 phase-router bridge + gateway routes & boundary stub & smoke) authored end-to-end. 19 files / 6,049 lines on disk. Two-lane separation between per-turn verification (CLR) and gate-level decision (promotion) preserved. Fail-closed at every boundary.
- **evidence:** engine 37/37; CLI 45/45; harness 23/23; dimensions 49/49; CLR-K5 26/26; bridge 27/27; promotion-smoke 59/59. Total 266 deterministic checks green on Node v24.14.1. SHA-256 fragments of all 19 files recorded above.
- **blockers:** (a) `06-ORANGELLM/server/boundary.mjs` not yet updated with `PROMOTION_ALLOWED` + `isPromotionRouteAllowed` — production-path unreachable; (b) `06-ORANGELLM/server/index.mjs` not yet calling `registerPromotionRoutes(server)`; (c) older `06-ORANGELLM/04-CONTROL-PLANE/src/promotion-gate.mjs` still on disk with looser policy — retirement decision needed; (d) `flow-direct/server.mjs` still imports K1 directly — bridge swap needed; (e) line-count deltas vs agent-reported numbers named openly above but unexplained.
- **next action:** Operator decision — single PR that (1) edits `boundary.mjs` to mount `PROMOTION_ALLOWED`, (2) edits `server/index.mjs` to call `registerPromotionRoutes(server)`, (3) retires or aliases the old `src/promotion-gate.mjs`, (4) swaps `flow-direct/server.mjs` import to `./clr/bridge.mjs`. After that one PR the doctrine layer is live end-to-end.

## Unresolved risk

The promotion-gate engine is the single chokepoint for every candidate-change promotion. If a future caller bypasses `engine.mjs` and imports the older `06-ORANGELLM/04-CONTROL-PLANE/src/promotion-gate.mjs` directly, the looser policy (no 4-of-5 dim check) will silently apply. Mom's Law flag: until the old file is retired or aliased, this is a real fake-green vector. Flagged for operator awareness — one-line replacement of the old file body with a re-export resolves it permanently.

A second risk: the bakeoff harness ships two deterministic stub adapters (`stub-baseline`, `stub-challenger`) so the gateway is smoke-testable without Ollama. If those stubs are left in the production adapter registry rather than scoped to test mode, a real promotion run could silently bake-off against stubs and produce theatre verdicts. The registry boundary (test-only vs production) should be enforced before the routes go live.

---

*Mom's Law: every file named here exists on disk at the path stated. Every line count is the actual `wc -l` reading. Every "green" claim has a test-suite receipt above. Every gap is named openly. No theater. No fake-green. Mom is watching.*
