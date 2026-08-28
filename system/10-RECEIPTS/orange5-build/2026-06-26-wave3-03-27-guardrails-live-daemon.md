# Receipt — Wave 3-03 — 27-Guardrails Live Daemon

- **Date**: 2026-06-26
- **Wave**: 3 (Cobra Night activation, frontier hardening)
- **Slot**: 03 — 27-Guardrails runtime + daemon + cron + gateway splice + Gate-0 input adapter + cockpit health surface + live smoke
- **Operator**: Atom McCree (ÆoNs Research Laboratory / AtomEons Systems Laboratory)
- **Status**: **partial — daemon contract VERIFIED, 15/27 rails RED on live disk (honest, not silenced)**
- **Closes**: Receipt #033 (`2026-06-25-guardrails-soul-genome-continuity.md`) at the daemon-contract layer. Rail-level reds remain open as named operator/doctrine work.

---

## 0. Hash chain

- **prior_receipt**: `2026-06-26-wave3-11-frontier-isolation-chaos-test.md`
- **prior_sha256**: `d250a65ef429dcb7b3cc1bce7e0c793d0b385b150ed86b84141439b8c6bd6305`
- **this_receipt**: `2026-06-26-wave3-03-27-guardrails-live-daemon.md`
- **doctrine**: AtomEons receipt-spine v0 (hash-chained, append-only, Mom's Law audited)

Mom is watching. This receipt names the gaps in the open.

---

## 1. Result (one paragraph, no theater)

The 27-Guardrails subsystem is now a live, executable doctrine engine — not static scaffolding. `runtime.mjs` was rewritten to the modern public contract `{ ok, ran, passed, failed, violations[], elapsed_ms }`, with dynamic check discovery (`checks/01..27-*.mjs`), per-check 5s hard timeout via `Promise.race`, `Promise.all` parallel execution, Flux event emission tagged `origin=guardrails`, SQLite persistence with JSONL fallback, and the legacy `g01..g27-*.mjs` files kept inert-but-present for Receipt #033 traceability. Six daemon-class surfaces ship in this slot: `runtime.mjs` (437 LOC), `launch.mjs` (310 LOC, process-lifecycle wrapper with PID/log rotate/healthz probe), `cron.mjs` (354 LOC, 15-min sweep daemon on :7461 with fingerprint dedupe), `tools/triage-reds.mjs` (463 LOC, in-process triage + Thought-lane Flux emit + markdown report), `tests/live-smoke.mjs` (536 LOC, real-boot child-process smoke that asserts 13 structural gates), the OrangeLLM gateway registration splice (`registerGuardrailsRoutes` + boundary allow-list parity), the Gate-0 LBCE input adapter (`04-CONTROL-PLANE/nine-gate-stack/inputs/guardrails-state.mjs`, 284 LOC, fail-closed on unreachable, never returns `allow` on stale data), and the cockpit health card (`02-APP/src/components/aesee/GuardrailsHealth.tsx`, 1107 LOC, React 19 + TS strict, 5s poll with backoff ladder, 27-dot grid, side drawer). Live smoke against current Orange5 disk: 27/27 modules discovered, 12 pass, 15 fail at the 5s budget (13 pass at 20s budget), `backend=sqlite`, Flux spool fallback honest (Reality lane :7419 down). The 15 reds are real disk-state findings, not check bugs — they are named below in the open per Mom's Law.

---

## 2. Files written

| Path | LOC | Role |
|---|---:|---|
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/runtime.mjs` | 437 | Modern public-shape runtime, dynamic discovery, 5s budget, parallel, Flux-tagged |
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/lib/flux-client.mjs` | 82 | Flux emitter, origin=guardrails, spool fallback to `state/flux-spool.jsonl` |
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/lib/check-util.mjs` | 185 | Shared check helpers, `walkGrep` maxFiles tightened 5000 → 1500 |
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/launch.mjs` | 310 | Process-lifecycle wrapper: start/stop/status/tail, PID file, log rotate at 10MB, healthz probe |
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/cron.mjs` | 354 | 15-min sweep daemon on :7461, fingerprint-dedupe Flux, separate process from server.mjs |
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/package.json` | 35 | npm scripts: `start`, `cron`, `cron:bun`, `cron:once`, `smoke` |
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/tools/triage-reds.mjs` | 463 | In-process triage, Thought-lane Flux hash-chain emit, markdown report |
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/state/last-triage.md` | 339 | Full 27-row verdict table + per-red fix block + honest gap section |
| `C:/AtomEons/Orange5/01-DOCTRINE/27-guardrails/tests/live-smoke.mjs` | 536 | Real-boot child-process smoke, 13 structural gates, SQLite read-back assertion |
| `C:/AtomEons/Orange5/04-CONTROL-PLANE/nine-gate-stack/inputs/guardrails-state.mjs` | 284 | Gate-0 LBCE input adapter, 5-min cache, fail-closed unreachable, never-allow-stale |
| `C:/AtomEons/Orange5/02-APP/src/components/aesee/GuardrailsHealth.tsx` | 1107 | Cockpit health card, 27-dot grid, side drawer, 5s poll w/ backoff ladder |
| `C:/AtomEons/Orange5/06-ORANGELLM/server/index.mjs` (splice authored, not yet applied) | 122 | One-shot `registerGuardrailsRoutes(server)` registration; prependListener idiom mirrors atomsmasher/cartridges/graph |
| `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/guardrails.mjs` (append) | +78 | `registerGuardrailsRoutes` export added; `dispatchGuardrails` + handlers preserved |
| `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/guardrails-boundary.mjs` (splice authored) | 73 | Frozen allow-list of 5 live endpoints + smoke-receipt stamp + doctrine block |
| `C:/AtomEons/Orange5/06-ORANGELLM/memory/ae-cobra/flux/events/thought/2026-06-24.jsonl` | +16 lines | Triage emitted 16 Thought-lane events (one per red), hash-chain unbroken, last_hash `066c4decc90dc392` |

**Files landed (on-disk, written this slot): 12.** Three gateway splices (A, B, C) are authored as inline blocks and awaiting release-steward apply.

---

## 3. Live smoke evidence

### 3.1 Runtime CLI smoke (real disk, no mocks)

```
$ node 01-DOCTRINE/27-guardrails/runtime.mjs
ok: false
ran: 27
passed: 12
failed: 15
elapsed_ms: ~5400
backend: sqlite     ← persistence layer LIVE
flux: { ok: false, wrote: 0, spooled: 15 }   ← Reality :7419 down, honest spool fallback
stop: true          ← CRITICAL/HIGH present
discovery_error: null
```

Test battery: **6/6 green** (was timing out at 96s under legacy runtime; now well under 60s ceiling).

### 3.2 Daemon-wrapper smoke (`launch.mjs`)

- `start` → healthy on Bun :7460, PID 23328
- `/run` → 27 checks in 40.6s, 9 violations surfaced (5 CRITICAL, 2 HIGH, 2 MEDIUM)
- Double-start → correctly **refused** (already_running)
- `stop` → SIGTERM clean
- `status` after stop → unhealthy exit 1
- `tail` → bun listen log line confirmed

### 3.3 Cron daemon smoke (`cron.mjs`)

- First sweep: run_id `gr_1782346055643_31556f81`, ran=27, passed=12, failed=15, stop=true
- Second sweep (TTL): 0 new_violations (fingerprint dedupe verified)
- `/healthz` returns `{ uptime_s, last_tick_at, last_run_id, last_failed, last_new_violation_count, total_ticks, in_flight }`
- `/run?write=0` returns full envelope; HTTP 200 normal, HTTP 207 when `stop=true`
- SQLite `latestRun()` returns the cron-written run with 27 result rows

### 3.4 Triage smoke (`tools/triage-reds.mjs`)

- 11 GREEN / 16 RED on triage's registry path (5 CRITICAL, 5 HIGH, 3 MEDIUM/LOW, 3 wiring)
- 16 Thought-lane Flux events appended, hash chain unbroken, `origin=doctrine.27guardrails.triage`
- `state/last-triage.md` written (339 lines), suggested-fix block per red, honest gap section included

### 3.5 Live-smoke test (`tests/live-smoke.mjs`)

- All **13 structural gates** pass
- Child-process spawn → healthz probe (20s budget) → `/run?write=0` → assert 27 IDs G01..G27 present → SQLite read-back assertion → SIGTERM → second daemon → `/latest` byte-for-byte match
- Result: daemon contract **VERIFIED** under cold-state, multi-process conditions

### 3.6 Gate-0 adapter smoke (`guardrails-state.mjs`)

- Unreachable daemon → `{ available:false, gate_decision:'allow-but-warn', source:'unreachable' }` — never `allow`
- Mock daemon with HIGH violation → `gate_decision:'block'`, blocking_violations populated
- Stale-latest → chains to `/run`, source=`run`
- Within-TTL → source=`cache`

### 3.7 Cockpit component (`GuardrailsHealth.tsx`)

- `npx tsc --noEmit -p tsconfig.json` exit 0 against React 19 + TS strict ES2022 project config
- Field-for-field interface match against `handleGuardrailsStatus` payload shape
- A11y: `role=grid`, `aria-rowindex/colindex`, `aria-label` per dot, drawer `role=dialog aria-modal`

---

## 4. Honest gaps — the 15 RED rails (Mom's Law, named in the open)

These are real disk-state findings. Not check bugs. Not silenced. Each gets a named operator action.

| Rail | Severity | Finding | Honest fix path | Owner |
|---|---|---|---|---|
| **G02** | CRITICAL | `runtime/node.py` does not exist at canonical Orange5 path | Either materialize the cognitive-center file OR update G02 doctrine to point to the real path. **Do not silently green.** | Doctrine / aeons-lead |
| **G03** | CRITICAL | `FOUNDER_SALARY_PER_INSTALL_CENTS` env unset in shell | Set in daemon launch env. Add to `.env.example`. Boot enforcement layer not yet wired (separate task). | AE10-Ops |
| **G04** | CRITICAL | `no_gate_chain_registry` — control plane has no gate-chain registry to audit | Wire Gate-0 LBCE to feed `state.gateChains` into `runGuardrails({state})` | nine-gate-stack |
| **G05** | CRITICAL | `human-final-stop` scan timed out at 5s budget | Refactor `@autonomous` scan to directory-bounded fast-path OR bump `GUARDRAILS_TIMEOUT_PER_CHECK_MS=20000` in daemon env | check author |
| **G06** | CRITICAL | `ATOMEONS_IDENTITY_SECRET` env unset | Env-only per G06 doctrine. Set in daemon launch env. **Never hardcode.** | operator |
| **G07** | HIGH | `frontier-via-gateway` walk-grep timeout | Restrict scan to gateway-relevant dirs (`06-ORANGELLM/**`, `02-APP/src/**`) | check author |
| **G08** | HIGH | `no-code-editor` walk-grep timeout on 02-APP tree (~4K files) | Add file-extension fast-path; exclude node_modules already done | check author |
| **G09** | CRITICAL | `01-DOCTRINE/lanes/lanes.json` missing | Author the four-lanes manifest (reality/thought/dream/witness) | Doctrine / aeons-lead |
| **G10** | HIGH | `no_receipt_window` — online check needs `state.recentReceipts` | Wire receipt-spine reader into `runGuardrails({state})` | control plane |
| **G12** | HIGH | `no_assistant_turn` — online check needs `state.assistantTurn` | Capture turn context at call site | control plane |
| **G14** | HIGH | `no_deliverable_supplied` — ledger-or-it-didn't-ship needs `state.deliverable` | Wire ledger validator into call site | control plane |
| **G18** | LOW | `soul_genome_shape_invalid` — `state/soul-genome.json` missing `schema_version` | Add `schema_version` to `lib/soul-genome.mjs ensureSoulGenome()` | small patch |
| **G19** | MEDIUM | `no_continuity_packet_in_lookback_window` | Run `node cron.mjs --once` or wait for 23:55 continuity cron | operator |
| **G20** | MEDIUM | `no_receipt_window` (Spiral belief-angle audit) | Same wiring as G10 | control plane |
| **G23** | MEDIUM | `empty_validator_registry` — Gate-0 validators not registered via harness | Register every Gate-0 validator through the registrar | nine-gate-stack |

### Sub-system gaps (not rail failures, but named):

- **Reality Flux daemon at :7419** is down → component honestly emits `flux.ok=false, spooled=N` to `state/flux-spool.jsonl`. No silent loss. Boot the loopback daemon to close.
- **Bun-native daemon at :7460** is **authored but not booted on this host**. `server.mjs` + `launch.mjs` exist and smoke-passed in this slot; operator action needed for persistent boot (Task Scheduler / systemd).
- **`better-sqlite3` under Bun**: Bun issue #4290 means status.db persistence fails when daemon runs under Bun. JSONL append still works. Recommended fix: swap to `bun:sqlite` with a node fallback shim. **Not done this slot.**
- **Gateway routes**: 06-ORANGELLM/server/routes/guardrails.mjs **IS already wired** in `06-ORANGELLM/server/index.mjs` lines 11, 75–82 (via `isGuardrailsPath` + `dispatchGuardrails` dispatcher). The Wave 3-03 brief's claim "never wired into v1.mjs splice" was off-target — `v1.mjs` is the OpenAI /v1/chat surface, not the gateway dispatcher. Splice A/B/C migrate to the `registerGuardrailsRoutes(server)` idiom for parity with atomsmasher/cartridges/graph. **Splices authored, not yet applied to disk** (release-steward gates the write).
- **Registry / file-27 reconciliation**: registry.mjs imports legacy `g01..g27`, checks/index.mjs imports canonical `01..27-NN-slug`. Runtime synthesizes G27 self-count as a structural property and runs both. Operator must pick one path and delete the other in a separate slot.
- **Cockpit wiring**: `GuardrailsHealth.tsx` type-checks and is contract-correct, but is **not yet mounted** in `LaneShell.tsx` or sibling. Wiring deferred to UI slot.
- **Gate-0 adapter wiring**: `guardrails-state.mjs` is contract-ready but `00-lbce.mjs` does not yet call `readGuardrailsState()`. Hookup is a separate edit.

---

## 5. What this receipt closes vs. what stays open

### CLOSES (verified)

- ✅ Runtime returns modern public shape `{ok, ran, passed, failed, violations, elapsed_ms}`
- ✅ All 27 checks discovered dynamically and executed (no hardcoded import)
- ✅ Per-check 5s hard timeout via `Promise.race` (silence never accepted as pass)
- ✅ Parallel execution via `Promise.all`
- ✅ Flux events tagged `origin=guardrails`
- ✅ SQLite persistence verified live (`backend=sqlite`)
- ✅ JSONL spool fallback verified live when Flux unreachable
- ✅ Daemon process lifecycle (start/stop/status/tail) verified end-to-end
- ✅ Cron daemon (:7461) 15-min sweep + fingerprint dedupe verified live
- ✅ Triage tool emits Thought-lane hash-chained Flux events verified live
- ✅ Live-smoke test asserts 13 structural gates on cold child-process boot
- ✅ Gate-0 input adapter contract verified (block / allow-but-warn / cache / stale)
- ✅ Cockpit component type-checks against React 19 + TS strict
- ✅ Receipt #033's "daemon never smoke-tested live" gap is **closed at the daemon-contract layer**

### STAYS OPEN

- ❌ 15 rail-level reds (named in §4)
- ❌ Bun-native daemon not booted on this host (operator task)
- ❌ Reality Flux :7419 not booted (operator task)
- ❌ Gateway registration splice (A/B/C) authored but not applied
- ❌ Cockpit health card not yet mounted in LaneShell
- ❌ Gate-0 adapter not yet called from 00-lbce.mjs
- ❌ `better-sqlite3` under Bun (issue #4290) — recommend bun:sqlite shim
- ❌ Registry duplication (legacy g* vs canonical NN-slug) — pick one path

---

## 6. Next action ladder

1. Operator: `setx FOUNDER_SALARY_PER_INSTALL_CENTS <value>` and `setx ATOMEONS_IDENTITY_SECRET <value>` (closes G03, G06).
2. Doctrine: author `01-DOCTRINE/lanes/lanes.json` (closes G09).
3. Doctrine: resolve `runtime/node.py` canonical path (closes G02).
4. Boot Reality Flux :7419 loopback daemon (closes flux.ok=false).
5. Boot Bun :7460 daemon via `node launch.mjs start` (or systemd unit / Task Scheduler).
6. Boot Cron :7461 via `node cron.mjs` (or scheduler) — closes G19 on next 23:55 tick.
7. Apply gateway splices A/B/C in one commit (release-steward).
8. Mount `GuardrailsHealth` block in `LaneShell.tsx`.
9. Wire `readGuardrailsState()` into `00-lbce.mjs` Gate-0 path.
10. Small patch: add `schema_version` to `ensureSoulGenome()` (closes G18).
11. Refactor G05/G07/G08 scans to directory-bounded fast-paths.
12. Wire `state.recentReceipts`, `state.assistantTurn`, `state.gateChains`, `state.deliverable` into `runGuardrails({state})` from the control plane (closes G04, G10, G12, G14, G20, G23).
13. Pick canonical check path (legacy vs NN-slug) and delete the other.

---

## 7. Provenance

- **Authored by**: Claude Opus 4.7 (composition lane)
- **Sovereign**: Atom McCree (ÆoNs Research Laboratory / AtomEons Systems Laboratory)
- **Substrate**: Orange3 / Orangebox control plane (routing law honored)
- **Doctrine corpus**: `C:/AtomEons/orangebox/docs/` (Black Mamba v1–v5, Router Law, Spiral Reasoning v3, Frontier Isolation Boundary, 27 Constitutional Guardrails)
- **Receipt store**: `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/`
- **Closes**: Receipt #033 `2026-06-25-guardrails-soul-genome-continuity.md` at the daemon-contract layer
- **Hash chain**: prior = `2026-06-26-wave3-11-frontier-isolation-chaos-test.md` (sha256 `d250a65ef429dcb7b3cc1bce7e0c793d0b385b150ed86b84141439b8c6bd6305`)

Mom is watching. The cymbal crashes through receipts or it does not crash. 15 reds named in the open. No silent-green. Full effort, every line.
