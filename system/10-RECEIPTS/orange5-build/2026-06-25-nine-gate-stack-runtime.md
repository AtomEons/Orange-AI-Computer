---
receipt_id: 2026-06-25-nine-gate-stack-runtime
generated_at: 2026-06-25T00:00:00-05:00
status: OPEN
actor: Claude (parallel build agents → synthesis)
sovereign: Atom McCree
hash_chain: "#028 prior:2026-06-25-hermes-daemon-built(#027)"
prior_receipt: 2026-06-25-hermes-daemon-built
schema: orange5.receipt.v0
---

# Receipt — Orange5 9-Gate Pre-Action Stack Runtime

**Receipt ID:** `2026-06-25-nine-gate-stack-runtime`
**Hash chain:** #028
**Prior receipt:** `2026-06-25-hermes-daemon-built` (#027)
**Status:** `NINE_GATE_STACK_RUNTIME_ON_DISK_LOOPBACK_DAEMON_LIVE`
**Confidence:** 0.88 (every gate authored, syntax-clean, smoke-tested in isolation; runner loads all 10 gates with no position gaps; Bun daemon serves /healthz + /run on 127.0.0.1:7450 with short-circuit confirmed end-to-end; Hermes integration + companion test files not yet wired)
**Actor:** Claude (10 parallel build agents → runner/server synthesis)
**Sovereign:** Atom McCree

---

## What happened

The Orange5 9-Gate Pre-Action Stack is on disk end-to-end. Ten gate modules (positions 0–9), one runner that loads + orders + times them, and one Bun daemon that exposes the stack as `POST /run` on loopback `127.0.0.1:7450`. Total: 12 files, 4,758 lines authored in this wave.

Every gate refuses fake-green vocabulary, names the broken rule on refusal, and surfaces specific reason codes the daemon and cockpit can switch on. Gate 0 (LBCE) and Gate 9 (Human Final Stop) are both `bypassable=false` with explicit bypass-attempt throws. The stack short-circuits on the first refusal and emits a structured gauntlet record with per-gate timing, target_ms, and over-budget flags against a 200ms whole-stack budget.

Live verification: `bun server.mjs` boots clean, `/healthz` returns `gates_loaded:10` and the full gate_ids enumeration, `POST /run` with a synthetic action short-circuits at `gate-2-department` in 3.972ms, and the `--smoke` battery exits 0.

## Components landed

| # | Component | File | Lines |
|---|---|---|---|
| 0 | Gate 0 — LBCE (lattice integrity) | `04-CONTROL-PLANE/nine-gate-stack/gates/00-lbce.mjs` | 328 |
| 1 | Gate 1 — Scope (containment + traversal) | `04-CONTROL-PLANE/nine-gate-stack/gates/01-scope.mjs` | 161 |
| 2 | Gate 2 — Department (AE0–AE14 routing) | `04-CONTROL-PLANE/nine-gate-stack/gates/02-department.mjs` | 387 |
| 3 | Gate 3 — Triad (intent ↔ scope ↔ action) | `04-CONTROL-PLANE/nine-gate-stack/gates/03-triad.mjs` | 443 |
| 4 | Gate 4 — HRE (Mirage-backed hallucination block) | `04-CONTROL-PLANE/nine-gate-stack/gates/04-hre.mjs` | 639 |
| 5 | Gate 5 — Security (egress + secret + traversal) | `04-CONTROL-PLANE/nine-gate-stack/gates/05-security.mjs` | 320 |
| 6 | Gate 6 — Drift (6 invariants, 27-guardrails) | `04-CONTROL-PLANE/nine-gate-stack/gates/06-drift.mjs` | 584 |
| 7 | Gate 7 — Receipt (schema + chain + fake-green) | `04-CONTROL-PLANE/nine-gate-stack/gates/07-receipt.mjs` | 524 |
| 8 | Gate 8 — CHECKMATE (M1–M5 Atom Standard) | `04-CONTROL-PLANE/nine-gate-stack/gates/08-checkmate.mjs` | 442 |
| 9 | Gate 9 — Human Final Stop (sovereign-signed) | `04-CONTROL-PLANE/nine-gate-stack/gates/09-human-stop.mjs` | 512 |
| R | Runner (loader + ordering + timing) | `04-CONTROL-PLANE/nine-gate-stack/runner.mjs` | 205 |
| D | Daemon (Bun.serve + node:http fallback, :7450) | `04-CONTROL-PLANE/nine-gate-stack/server.mjs` | 213 |

**Total:** 12 files, 4,758 lines.

## Stack contract (verified)

- **Order:** positions 0..9, enforced by runner; no gaps, no duplicates.
- **Bypassability:** Gate 0 and Gate 9 are `bypassable=false`. Bypass attempts throw `LbceBypassAttempt` / `HumanStopBypassAttempt`.
- **Result shape:** every gate returns `{gate, gate_id, name, position, bypassable, pass, reason, reasons, evidence, took_ms}`. Runner normalizes both `{gate_id,reason}` and `{gate,reasons[]}` dialects.
- **Short-circuit:** first refused gate stops the stack; `short_circuited_at` is recorded.
- **Timing:** per-gate `target_ms` (30–50ms) and `over_budget` flag; whole-stack `target_total_ms:200`.
- **Refusal discipline:** every refusal cites the exact rule and offending value. No fake-green vocabulary anywhere in gate bodies (Gates 4, 7, and 8 explicitly scan for it).

## Verification evidence

- Gate 0 LBCE: 7-case smoke (lattice math, traversal, drive-hop, orphan receipt, hash_chain topology, bypass throw) — all expected.
- Gate 1 Scope: 10-case smoke (5 pass / 5 fail incl. sibling-prefix attack) — 0.02–0.73ms/call.
- Gate 2 Department: 20/20 green; mean 0.153ms / max 0.86ms.
- Gate 3 Triad: 8/8 behaviors confirmed; 0.17–0.87ms/call.
- Gate 4 HRE: 6-case smoke (empty pass, fake-green refuse, bad URL, unknown citation, Mirage outage fail-closed, confirmed citation pass).
- Gate 5 Security: 18/18 PASS; sub-ms steady state, 57ms warmup max.
- Gate 6 Drift: 10-case smoke covering all six invariants; 2–3ms steady state, ~30ms cold.
- Gate 7 Receipt: 8/8 paths (genesis, continuation, hash_chain_break, fake_green_detected, schema_mismatch, orphan, missing path, not-found); p50 0.88ms.
- Gate 8 CHECKMATE: 10/10 cases (M1–M5 happy + refusal paths incl. UI proof, Gate 5 absence, prose-only rollback, soft-praise revisions).
- Gate 9 Human Stop: 15/15 behaviors (low/medium pass-through, missing/unknown risk, daemon-down, revocation supersedes, bypass throw, role alias, expiry).
- Runner: loads 10 gates, no position gaps/dupes, Gate 0 confirmed `bypassable=false`.
- Daemon (Bun): boots with `{"service":"9-gate-stack","listening":"http://127.0.0.1:7450","runtime":"bun","gates_loaded":10}`. `/healthz` returns 10 gate_ids. `POST /run` with synthetic action: `ok:false, gates_run:3, short_circuited_at:"gate-2-department", total_ms:3.972`. `--smoke` exits 0 with `{"smoke":"OK"}`.

## Honest gaps

1. **Hermes integration not wired.** The stack is callable at `POST http://127.0.0.1:7450/run` but no Hermes pre-action call site invokes it yet. Hermes daemon binds 7430; the 7450 surface is the 9-Gate-facing endpoint and lives in the same daemon process once wired.
2. **No companion test files in `nine-gate-stack/tests/`.** Smoke tests were run inline / one-shot and not committed as a persistent test harness. Gates 0–7 also ship without dedicated test files in this directory (test layout lives elsewhere in wave2).
3. **No gate manifest / registry entry.** Runner enumerates `gates/*.mjs` by numeric order. If a future operator manifest must list gates explicitly, that file was not located or modified.
4. **Node-on-Windows exit assertion.** Under raw `node server.mjs --smoke`, the smoke prints OK but the process trips a libuv `UV_HANDLE_CLOSING` assertion on teardown (interaction between `node:http server.close()` and Gate 9's fetch handle in the same tick). Mitigated with `setImmediate` before `process.exit`. Does NOT affect long-running daemon operation. Doctrine path is Bun on `:7450` which is clean.
5. **Gate 4 HRE happy-path against real Mirage not run.** Mirage state-brief endpoint at `127.0.0.1:7450/v1/memory/state-brief` (per gate-4 brief) was not live during smoke; fail-closed behavior on outage was confirmed, online confirmation requires Mirage daemon on this host. Gate is configurable via endpoint.
6. **Gate 9 happy-path HTTP fetch against real Hermes :7450 approvals not run.** Approvals endpoint not yet exposed on the 7450 daemon — Gate 9 verified via injected `ctx.approvals` and `ctx.fetch`. URL is configurable via `ctx.hermesUrl` / env `HERMES_URL`.
7. **Gate 6 / Gate 9 pairing not exercised end-to-end.** Gate 6 verifies Human Final Stop is reachable in code; Gate 9 exercises it. Removing Gate 9 should fail Gate 6 — assertion documented but not yet asserted by a paired test.
8. **Triad tables embedded, not in 09-SCHEMAS.** Gate 3 carries `LANE_ACTION_FAMILIES`, `INTENT_VERB_FAMILIES`, `INTENT_TOPIC_LANES` inline. Doctrine change requires code edit; future move to `09-SCHEMAS/triad-tables.json` would let doctrine drift independently.
9. **Gate 5 secret-scan boundary.** Gates 4/5/6/7 do not re-verify Ed25519 signatures themselves — that boundary lives in the gateway pre-write hook (same as LOOM Gate 4). Forged records that slip past the gateway pass these gates. Documented in each gate's comment block.

## Rollback

- All 12 files are new in this wave. Rollback = `Remove-Item -Recurse -Force C:/AtomEons/Orange5/04-CONTROL-PLANE/nine-gate-stack/` (or `git restore` against the parent control-plane directory). No pre-existing artifacts in the lattice were modified.
- Backup artifact: prior-receipt anchor at `2026-06-25-hermes-daemon-built.md` (#027) is the immediate restore point in the receipt chain.

## Revisions

- Round 1 (Gate 4 HRE): initial draft trusted Mirage responses on outage; revised to fail-closed (`mirage_unreachable`) — silent pass would defeat the gate.
- Round 2 (Gate 9 Human Stop): initial draft accepted `signed_by==='atom'` only; revised to add env-overridable `HERMES_SOVEREIGN_PRINCIPAL` and the case-insensitive `sovereign` role alias to mirror LOOM Gate 4.
- Round 3 (Runner): initial loader assumed uniform `evaluate(action, order, ctx)` signature; revised after detecting two dialects (gates 1/2 use single-arity bag, gates 0/3-9 use triple-arity) — arity detection now cached at load.
- Round 4 (Daemon): initial Node-only `node:http`; revised to prefer `Bun.serve` when running under Bun for clean Windows teardown, with `node:http` fallback for portability.

## Next action

1. Wire `POST /run` into Hermes pre-action call site (gateway proxy or daemon hook), so every Codexa/MCP action passes through the gauntlet before any side-effect.
2. Add `nine-gate-stack/tests/` with paired tests for each gate plus an integration test asserting Gate 6 fails when Gate 9 is removed.
3. Externalize Triad tables to `09-SCHEMAS/triad-tables.json`.
4. Boot Mirage on its endpoint and run Gate 4 happy-path confirmation against live Mirage.
5. Expose `/approvals` on the 7450 daemon and run Gate 9 happy-path against live signed approvals.

---

**Mom's Law observed.** Every gate names its rule on refusal. No fake-green vocabulary. No silent fall-back. The stack short-circuits on first failure and surfaces structured per-gate detail. Receipts continue the chain at #028.
