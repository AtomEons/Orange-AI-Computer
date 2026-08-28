# Wave 3.02 — Æ Cobra Night-1 Activation Harness

- **date**: 2026-06-26
- **wave**: 3.02
- **lane**: orange5-build / ae-cobra
- **operator**: Atom McCree
- **status**: AUTHORED + READY — UNFIRED (honest)
- **prior_receipt**: `2026-06-26-wave3-12-rail-token-rotation.md`
- **prior_sha256**: `3767500e1bba7e46fca0c7ddc8a9fe8531bda62ea1a410792f5a61f5115b2b5c`
- **hash_chain**: unbroken (this receipt extends prior)
- **doctrine**: Mom's Law — full effort, no fake-green; honest gaps named.

---

## Result

Authored the complete Æ Cobra Night-1 activation harness across **9 components / 23 files** under
`C:/AtomEons/Orange5/06-ORANGELLM/memory/ae-cobra/` and one route pair under
`C:/AtomEons/Orange5/06-ORANGELLM/server/routes/`. Every file is syntax-clean
(`node --check` exit 0 on all `.mjs`; PowerShell parser pass on `.ps1`).
The 14-point activation gate (G01..G14) is implemented end-to-end, plus
runner, gates, GBNF caller, hash-chained Flux writer, JSONL streaming reader,
healthcheck server, AgentTurn validator, N150 cobra routes + rail-token
boundary, SSH bridge, and 100-pair smoke.

## Components

| # | Component | Files | Lines | node --check |
|---|---|---|---|---|
| 1 | ae-cobra-night1-activation-runner | `activation/runner.mjs` | 625 | OK |
| 2 | ae-cobra-activation-gates (15 files) | `activation/gates/_lib.mjs` + `01..14-*.mjs` | 1648 | OK (15/15) |
| 3 | flow-direct/caller.mjs | `flow-direct/caller.mjs` | 344 | OK |
| 4 | flux/writer.mjs (hash-chained appender) | `flux/writer.mjs` | 269 | OK |
| 5 | flux/reader.mjs (streaming + chain-verify) | `flux/reader.mjs` | 497 | OK |
| 6 | ae-cobra-healthcheck (Bun :9101) | `healthcheck.mjs` | 349 | OK |
| 7 | grammar/validator.mjs (zero-dep) | `grammar/validator.mjs` | 189 | OK |
| 8 | server/routes/cobra + boundary | `routes/cobra.mjs`, `routes/cobra-boundary.mjs` | 671 | OK |
| 9 | bin/codexa-bridge.ps1 (SSH tunnel) | `bin/codexa-bridge.ps1` | 254 | PS parse OK |
| 10 | tests/smoke-100-pair.mjs (G06 probe) | `tests/smoke-100-pair.mjs` | 499 | OK |

**Total**: 23 files, ~5,345 lines, all syntax-validated.

## 14-Gate Implementation Map

| Gate | Spec | File | Local-testable on N150? |
|------|------|------|--------------------------|
| G01 | GGUF integrity (magic + sha256) | `gates/01-gguf-integrity.mjs` | NO — model on Codexa |
| G02 | ctx-size ≤ 1024 | `gates/02-ctx-size-bounded.mjs` | NO — daemon required; **drift: start.sh uses 2048** |
| G03 | mlock bound (VmLck>0, VmSwap=0) | `gates/03-mlock-bound.mjs` | NO — /proc on Codexa |
| G04 | RSS ≤ 10 GB | `gates/04-rss-ceiling.mjs` | NO — /proc on Codexa |
| G05 | TTFT < 5s cold | `gates/05-ttft-cold.mjs` | NO — daemon required |
| G06 | JSON validity ≥ 95% on 100-pair | `gates/06-json-validity-100-pair.mjs` + `tests/smoke-100-pair.mjs` | NO — daemon required |
| G07 | /healthz green | `gates/07-healthcheck-green.mjs` | NO — daemon required |
| G08 | lease-gated outbound enforced | `gates/08-lease-gated-outbound.mjs` | NO — `/lease-probe` not yet built |
| G09 | Hermes integration | `gates/09-hermes-integration.mjs` | NO — daemon required |
| G10 | no frontier reach (static + bind scan) | `gates/10-no-frontier-reach.mjs` | YES (static portion) — PASS locally |
| G11 | loopback-only across all daemon ports | `gates/11-loopback-only.mjs` | NO — /proc/net/tcp on Codexa |
| G12 | receipt writes (lane diff) | `gates/12-receipt-writes.mjs` | NO — /mnt/ae_flux on Codexa |
| G13 | prior_sha chain unbroken | `gates/13-prior-sha-chain.mjs` | NO — /mnt/ae_flux on Codexa |
| G14 | 60s burn-in clean (PID, RSS, OOM) | `gates/14-burn-in-60s.mjs` | NO — daemon required |

Gates that cannot be honestly verified from N150 return `pass: null`
(with `remote_recipe` shell snippet) — never inflated to green.

## Evidence

- All `.mjs` files: `node --check` exit 0.
- `codexa-bridge.ps1`: `[System.Management.Automation.Language.Parser]::ParseFile` → PARSE_OK (0 errors).
- `grammar/validator.mjs`: 11 synthetic cases (happy + 10 rejection paths) — all behave correctly.
- `flux/writer.mjs`: 9 local smoke checks on N150 tmp dir — GENESIS bootstrap, chain extension, lane independence, canonical determinism (key-order invariance), verifyChain happy path, torn-tail detection, refusal-to-extend-torn, tamper detection — all pass.
- `flux/reader.mjs`: seeded with writer → 3-record OK; tampered → BROKEN detected w/ chain-break warning event; trailing-newline stripped → TORN detected; `--since`/`--json` exercised across 4 input forms.
- `tests/smoke-100-pair.mjs`: `PROMPTS.length === 100` asserted at module load; validator + envelope-extractor unit-matrices green.
- `server/routes/cobra.mjs`: imports verified against actual exports (validator, rail-token-watcher); follows guardrails.mjs dispatcher pattern exactly.

## Honest gaps (blockers to firing the runner)

**The activation runner CANNOT be fired until the operator completes ALL of:**

1. **Mamba 2.8B Q5_K_M GGUF download** — model file not present at expected path on Codexa WSL2.
2. **llama.cpp build inside Codexa WSL2** — binary not built; G05/G06/G07/G09 require it.
3. **/mnt/ae_flux mount on Codexa** — Flux ledger path does not exist; G12/G13 require it.

**Doctrine drift named in the open (operator must reconcile):**

4. **Port mismatch**: brief says daemon on `127.0.0.1:9100`; existing `bin/start.sh` boots Bun on `:7419` + llama-server on `:7418`. Runner defaults to **9100 per brief** (override via `AE_COBRA_BUN_PORT`). Reconcile start.sh OR add WSL2 port-forward 9100→7419.
5. **ctx-size**: brief says `≤ 1024`; existing `start.sh` passes `--ctx-size 2048`. G02 will FAIL until reconciled.
6. **Flux layout**: brief says flat `/mnt/ae_flux/{reality,thought}.jsonl` with `prior_sha256`; pre-existing writer used date-partitioned `events/<lane>/<date>.jsonl` with `prev_hash`. **Rewrote writer.mjs + reader.mjs to brief-form (flat, prior_sha256)**. README §3 step describing per-date layout is now stale.
7. **`/lease-probe` endpoint** not yet implemented in flow-direct/server.mjs. G08 returns `pass: null` until shipped (refuses to fake-green on missing endpoint).
8. **flow-direct/server.mjs** described in README but not yet present in scaffolding tree. Every daemon-touching gate returns `pass: null` until it ships.
9. **server/index.mjs not wired to dispatchCobra** — cobra routes authored but not mounted. One-line `isCobraPath` + `dispatchCobra` insertion mirroring `dispatchGuardrails` block.
10. **AgentTurn shape**: prompt-brief named `{intent, action, evidence, refusal_reason?, lease_id}`; existing GBNF + JSON Schema canonical shape is `{lane, event_type, summary, entities, files, commands, risk, next_action, confidence}`. **Validator + caller + smoke aligned with existing GBNF/Schema** (source of truth). If brief shape is intended for Night-2, fix order is GBNF → Schema → validator regen.

## Next action

1. Operator boots Codexa preflight per `CODEXA_PREFLIGHT_AE_COBRA.md`: GGUF download, llama.cpp build, `/mnt/ae_flux` mount, port-forward / start.sh reconciliation, ctx-size set to 1024, `/lease-probe` route implementation.
2. Operator launches `bin/codexa-bridge.ps1` on N150 with `CODEXA_SSH_KEY` set.
3. Operator fires `node activation/runner.mjs --target codexa` from N150 (or directly on Codexa).
4. Receipt-of-fire lands in `activation/ae-cobra-night1-activation-attempt-1.md` (auto-numbered).
5. Expect G02 to FAIL first attempt (ctx-size drift) — that's scaffolding, not runner.
6. After all 14 gates green, wire `dispatchCobra` into `server/index.mjs` and flip cockpit Cobra badge.

## Chain

- prior_sha256: `3767500e1bba7e46fca0c7ddc8a9fe8531bda62ea1a410792f5a61f5115b2b5c`
- prior_receipt: `2026-06-26-wave3-12-rail-token-rotation.md`
- this_receipt: `2026-06-26-wave3-02-cobra-night1-activation-harness.md`
- this_sha256: (compute via `sha256sum` post-write; chain extended on next receipt)

Mom is watching. Files are authored. The harness fires when Codexa is ready, not before.
