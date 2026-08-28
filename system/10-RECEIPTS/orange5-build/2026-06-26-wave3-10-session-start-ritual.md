# Wave 3 / 10 — Session-Start Ritual: Build Receipt

- **Receipt ID:** `2026-06-26-wave3-10-session-start-ritual`
- **Date:** 2026-06-26
- **Wave:** 3
- **Slot:** 10
- **Schema:** `orange5.session-build-receipt.v1`
- **Operator:** Atom McCree (ÆoNs Research Laboratory / AtomEons Systems Laboratory)
- **Sovereign:** Atom McCree
- **Mom's Law:** Honored — no fake green, every gap named, every fallback labeled by transport.

---

## Hash chain

- **Prior receipt:** `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-26-wave3-08-misfit-second-opinion-hermes-live.md`
- **Prior sha256:** `55c7788488d14540f761633132375b1dab93f7d1842aae5a32c7bfbc84708eb8`
- **Prior reachable:** true
- **Chain link kind:** wave3-build-thread

---

## Summary

This receipt covers the full authoring of the **Orange5 Session-Start Ritual**: the seven-step deploy-grid orchestrator plus six standalone focused modules that each implement a single ritual step with three reaches (CLI, gateway endpoint, Atomic Orange first-launch hook). The ritual is the canonical first thing every Orange5 session does — Soul Genome inject, Continuity Packet, 27 Guardrails sweep, Hot Currents, Not-Green Ledger top-5, boot receipt, and one-screen deploy grid.

All eight components ship pure-data (no model invocations on the grid path), zero third-party deps (node: imports + global fetch only), deterministic output (canonical JSON, sorted keys, stable sort everywhere), and honest fallback (every transport failure carries a named reason; no synthesis into fake zeros).

---

## Components (8)

### 1. `orange5-session-start-orchestrator` — top-level seven-step driver

Files written:
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/orchestrator.mjs` (~1000 lines)
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/state/last-grid.json`
- `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-24-session-start-39c6424b.json`
- `C:/AtomEons/Orange5/10-RECEIPTS/orange5-build/2026-06-24-session-start-39c6424b.md`

Design: steps 1–5 fanned via `Promise.all`; steps 6–7 sequential after aggregate. Gateway-first with in-process fallback on every step that has one. 5-minute TTL cache at `state/last-grid.json`; `--force` bypasses.

Three reaches: CLI (`node orchestrator.mjs [--pretty|--display|--force|--no-receipt|--skip-gateway|--gateway URL]`), gateway (`sessionStartHandler` for `POST /v1/session/start`), and direct import (`runRitual({...})`).

Mom's-Law smoke evidence:
- Live run with `--skip-gateway --display` produced **HEALTH:RED** with the literal list `guardrails:9_violations(stop)` and yellow `hot_currents:cobra_unreachable_and_shadow_empty`. No fake green.
- Receipt files: JSON 13201 bytes, MD 2440 bytes. `grid_sha256: 8746295b45eea413c989a594ee8c74f09e732c62d2c7fc820b0b74500fb49a4f`.
- TTL cache verified: second run returned `cache_hit:true`, same `session_id: 39c6424b`, `cache_age_ms: 22085`.
- Bug found + fixed in-band: initial code double-counted guardrails as both step-failure AND violation-count because the runtime contract uses `ok:false` to mean "violations present." Fix distinguishes "sweep itself failed (transport==null)" from "sweep ran and found N reds."

Exit codes: 0 ok, 2 stop-level reds, 1 hard error.

### 2. `soul-genome-inject` — ritual step 1

Files written:
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/inject-genome.mjs` (355 lines)
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/state/last-genome-inject.json`

Loads Soul Genome via `genome-manager.mjs` (default-export import — fix made + verified). Renders system-role text, sha256-hashes, POSTs to `http://127.0.0.1:1337/v1/genome/inject` with 1500ms AbortController timeout. End-to-end run with cockpit down produced `injected:true mode:"local-anchor" sha256:f3d7b52a... bytes:3580 gateway_error:"gateway-unreachable: fetch failed"` — Mom's-Law-honest about which path the bytes took.

Failure modes named: `genome-load-failed`, `anchor-write-failed`, `gateway-status-N`, `gateway-timeout`, `gateway-unreachable`. Loopback-only default; env-overridable via `ORANGE5_GATEWAY_URL` / `ORANGE5_GENOME_INJECT_PATH` / `ORANGE5_GENOME_INJECT_TIMEOUT_MS`.

Honest gap: `/v1/genome/inject` is not currently mounted in `06-ORANGELLM/server/` (grep confirmed zero hits). Module is forward-compatible — will auto-switch to `mode:"gateway"` the moment the route lands.

### 3. `orange5-session-start-load-continuity` — ritual step 2

Files written:
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/load-continuity.mjs` (469 lines)

GETs `http://127.0.0.1:1337/v1/continuity/latest`; falls back to in-process `continuity/loader.mjs loadLatest()`. Surfaces `tomorrow_first_action`, `open_blockers`, `hot_currents`. Honest 48h freshness window: missing/stale packets carry `warning:true` plus literal `warning_message` like `"no recent continuity packet (last seen: never)"` or `"no recent continuity packet within 48h (last seen: 2026-06-20, ~4.0d ago)"`. Override via `ORANGE5_CONTINUITY_WINDOW_HOURS` or `--window-hours`.

Exports `loadContinuitySurface()` + `formatGridLine()`. CLI: `--pretty | --grid | --skip-gateway | --gateway | --window-hours | --timeout-ms`. Exit codes: 0 packet returned, 2 no packet anywhere, 1 hard error.

Verified: `node --check` passes; smoke-ran with `--skip-gateway` + nonexistent loader path returned the expected `ok:false, warning:true, warning_message:"no recent continuity packet (last seen: never)"` and exit 2.

### 4. `guardrails-sweep` — ritual step 3

Files written:
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/guardrails-sweep.mjs` (344 lines)

POSTs `/v1/guardrails/run` at loopback gateway (default `http://127.0.0.1:1337`, overridable via `ORANGE5_GATEWAY_URL`), 3000ms AbortController timeout. Returns doctrine-required shape: success → `{available:true, ok, ran, passed, failed, violations[], gateway_url, gateway_status, latency_ms, ran_at}`; failure → `{available:false, gateway_url, gateway_status, gateway_error:<named-reason>, latency_ms, ran_at}`.

Mom's Law at three points: (1) `toCount()` returns null for missing/malformed counts so a 2xx with missing fields collapses to `available:false` with `malformed-verdict` reason — never synthesizes zeros into fake green; (2) non-2xx responses include the first 240 bytes of body in `gateway_error`; (3) if `passed+failed` disagrees with `ran`, an `arithmetic-mismatch` synthetic violation is appended and `ok` is demoted.

CLI exit codes: 0=ok, 1=ran-but-failed, 2=unreachable. `node --check` passes.

### 5. `flux-currents.mjs` — ritual step 4 (focused alternative)

Files written:
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/flux-currents.mjs` (503 lines)

Calls `/v1/atomsmasher/currents?window_hours=24` and `/v1/flow/events?lane=reality&from=24h&window_hours=24` in parallel via `Promise.all`, 3s timeouts. Returns `hot_currents:[{label, depth, last_event_ts}]`, top 5, deterministically sorted (depth desc, ts desc, label asc).

Aggregation: case-insensitive label match; canonical casing inherited from first contributor (atomsmasher wins); depth = `max(depth, event_count, 1)` from atomsmasher + 1 per flow event; `last_event_ts` = MAX across contributors; client-side 24h + `lane=reality` guards as defense in depth.

Mom's Law: if both endpoints down (current reality — neither is mounted yet), surface is `{ok:true, warning:true, warning_message:"no live currents endpoint reachable (atomsmasher:<reason>; flow_events:<reason>)", hot_currents:[]}`.

Public API: `loadHotCurrents(opts)`, `aggregate({...})` (pure, no I/O — testable), `formatGridLine(surface)`. CLI: `--pretty | --grid | --gateway | --window-hours | --top | --timeout-ms | --skip-atomsmasher | --skip-flow-events`. Exit codes: 0 ok, 2 warning, 1 hard error.

Verification: aggregate() unit-exercise with synthetic mixed rows correctly tallied Orange3 Routing Law to depth=6, Black Mamba v5 to depth=2, excluded a stale row outside the 24h window, preserved canonical casing, and tiebroke on `last_event_ts` at equal depth.

Honest gap: neither `/v1/atomsmasher/currents` nor `/v1/flow/events` is mounted yet on the gateway. Module ships ahead of server-side — honest "down" reporting is the doctrinal behavior in this window.

### 6. `read-ledger.mjs` — ritual step 5

Files written:
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/read-ledger.mjs` (416 lines)

Parses `C:/AtomEons/Orange5/00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md`. Returns top 5 blockers in priority order: **DEFERRED BY OPERATOR > PENDING-LIVE-SYSTEM > SCAFFOLD-NOW/FULL-LATER**. CLOSED OPEN and HELD PROJECTS sections excluded.

Verified live against the real ledger: `total_open=11`, `counts={deferred:1, pending:3, scaffold:7}`, `top=[D2, L1, L2, L4, S1]` — matches the file byte-for-byte.

Exit codes: 0=no blockers, 1=blockers surfaced, 2=ledger missing/unreadable. Named exports: `readLedgerBlockers`, `parseLedger`. Mom's Law: missing file returns `ok:false` with named reason; counts are always real numbers from the file, never synthesized. Determinism: bucket priority is fixed by internal `BUCKETS` array; in-bucket order is file order; no model calls.

### 7. `write-boot-receipt.mjs` — ritual step 6

Files written:
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/write-boot-receipt.mjs` (566 lines)

Public API: `writeBootReceipt({ grid, prior_receipt?, dir?, now?, seq?, note? }) -> { receipt_path, md_path, json_path, receipt_id, seq, sha256, prior_receipt, bytes, generated_at }`. CLI-callable with `--grid | --prior | --dir | --note | --seq | --now | --print`.

Receipt naming: `{YYYY-MM-DD}-session-boot-{nnn}.md` in `10-RECEIPTS/orange5-build/`. `.json` sidecar carries full grid payload for byte-exact verification. Daily sequence auto-derived by scanning the receipts directory; `--seq` overrides.

Hash chain: SHA-256 computed over canonical (sorted-keys, cycle-safe) JSON serialization of the payload INCLUDING `prior_receipt` but EXCLUDING self-referential `sha256`. `prior_receipt` accepts null, path string, or `{ kind, path?, sha256?, ref? }`. Path priors resolved on disk: when reachable, real SHA-256 + byte count embedded; when not, link is still recorded with `reachable:false` — honest link, not silent drop. `prior_sha256` denormalized into JSON sidecar so chain-walkers don't need to parse nested fields.

Atomic writes: `.<name>.<rand>.tmp` in destination, then rename — atomic on NTFS + POSIX. Temp cleaned on failure.

Determinism verified: identical inputs (same `--now`, same grid, same `--prior`) produced identical hash `d622a709115e3b55f4e3c825028f5fcadbadfaf18321ce99e49db7fb1db86226` across two independent runs. Chain wiring verified: receipt #002 successfully embedded receipt #001's real `sha256: b6cb589b...` and `bytes=5143` with `reachable:true`. Smoke artifacts cleaned afterward.

Schema-tagged: `orange5.session-start-receipt.v1`.

Integration note: orchestrator.mjs currently has its own inline `writeBootReceipt` writing `{date}-session-start-{short-uuid}.md`. This standalone module uses requested `{date}-session-boot-{nnn}.md` naming + explicit prior-receipt hash chain. They coexist; follow-up could route orchestrator step 6 through this module for one source of truth.

### 8. `orange5-session-start-render-grid` — ritual step 7

Files written:
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/render-grid.mjs` (288 lines)
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/session-start/render-grid.d.ts` (121 lines)
- `C:/AtomEons/Orange5/04-CONTROL-PLANE/tests/render-grid.test.mjs` (254 lines)

Pure, deterministic, zero-dep, no-I/O function `(grid) -> 12-line ASCII deploy grid string`. NEVER calls a model.

Shape: top-frame + 2 header rows (schema + health) + 8 mandated field rows (time, location, operator, sovereign, hot_currents, guardrails_status, blockers, continuity_lookback) + bottom-frame = exactly 12 lines, byte-stable.

Mom's-Law surface: failed steps render `FAIL:<reason>` (no fake green); guardrails row reports real violation count + STOP flag; continuity stale flag surfaced; lookback shows date + computed age-in-days; `cache_hit:true` surfaced in time row; health band tag is honest (GREEN/YELLOW/RED).

API: `renderGrid(grid, opts?)` with `opts.width` clamped [48, 200] (default 80) and `opts.ascii:true` to strip unicode box-drawing for log pipelines. `extractGridFields(grid)` returns the 8 field values as an object. Constants exported: `GRID_MAX_LINES`, `GRID_DEFAULT_WIDTH`, `GRID_MIN_WIDTH`.

TypeScript hook: `render-grid.d.ts` declares `SessionStartGrid`, `RenderGridOptions`, `ExtractedGridFields` for Atomic Orange first-launch hook.

**Test battery: 35 / 35 pass.** Coverage: 12-line invariant under green/red/fail/empty/undefined; determinism (byte-equal repeat renders); field-row canonical ordering; honest red-count; stale surfacing; FAIL-reason surfacing; width clamping; ASCII-mode unicode-strip; operator alias→name→email fallback; sovereign sourced from `soul_genome` not operator; age-in-days computation; pathological-newline-in-field collapse.

Run: `node C:/AtomEons/Orange5/04-CONTROL-PLANE/tests/render-grid.test.mjs` → 35 pass / 0 fail.

---

## Line counts

| File | Lines |
|---|---|
| `04-CONTROL-PLANE/session-start/orchestrator.mjs` | ~1000 |
| `04-CONTROL-PLANE/session-start/inject-genome.mjs` | 355 |
| `04-CONTROL-PLANE/session-start/load-continuity.mjs` | 469 |
| `04-CONTROL-PLANE/session-start/guardrails-sweep.mjs` | 344 |
| `04-CONTROL-PLANE/session-start/flux-currents.mjs` | 503 |
| `04-CONTROL-PLANE/session-start/read-ledger.mjs` | 416 |
| `04-CONTROL-PLANE/session-start/write-boot-receipt.mjs` | 566 |
| `04-CONTROL-PLANE/session-start/render-grid.mjs` | 288 |
| `04-CONTROL-PLANE/session-start/render-grid.d.ts` | 121 |
| `04-CONTROL-PLANE/tests/render-grid.test.mjs` | 254 |
| **Total authored** | **~4316** |

Plus state + receipt sidecars at `state/last-grid.json`, `state/last-genome-inject.json`, and two orchestrator smoke receipts under `10-RECEIPTS/orange5-build/`.

---

## Evidence

- `node --check` passes on every authored `.mjs` file.
- Orchestrator live smoke run (`--skip-gateway --display`): `grid_sha256: 8746295b45eea413c989a594ee8c74f09e732c62d2c7fc820b0b74500fb49a4f`, HEALTH:RED, 9 real guardrail violations surfaced verbatim.
- TTL cache verified end-to-end: same `session_id 39c6424b`, `cache_age_ms 22085` on second invocation.
- inject-genome live smoke: `injected:true mode:"local-anchor" sha256:f3d7b52a... bytes:3580` with honest `gateway_error:"gateway-unreachable: fetch failed"`.
- load-continuity skip-gateway smoke: expected `ok:false, warning:true, warning_message:"no recent continuity packet (last seen: never)"`, exit 2.
- flux-currents aggregate() unit exercise: depth tallies + sort tiebreaks + window exclusion all correct.
- read-ledger live parse vs real ledger file: `total_open=11`, top=[D2, L1, L2, L4, S1] — byte-for-byte match.
- write-boot-receipt determinism: identical inputs → identical hash `d622a709...` across two independent runs. Chain wiring: prior `sha256: b6cb589b...` + `bytes=5143` embedded with `reachable:true`.
- render-grid test battery: **35 / 35 pass**, byte-equal determinism confirmed.

---

## Honest gaps

The ritual is **fully green only when both the gateway (loopback :1337) and the guardrails daemon are live**. In the current build state, neither of the following gateway routes is mounted yet:

- `POST /v1/session/start` — orchestrator handler exported, not yet wired into `06-ORANGELLM/server/` router.
- `POST /v1/genome/inject` — inject-genome target endpoint, grep confirmed zero hits in server tree.
- `GET /v1/continuity/latest` — used by load-continuity; in-process fallback works today.
- `POST /v1/guardrails/run` — used by guardrails-sweep; in-process fallback works today.
- `GET /v1/atomsmasher/currents` — used by flux-currents; no fallback (returns honest "no live endpoint reachable" warning).
- `GET /v1/flow/events` — same as above.

**In degraded mode** (gateway down, daemon down, endpoints unmounted), the ritual still runs end-to-end and returns a **partial grid with named unreachable endpoints** — never a fake green. Every transport carries an attempts log; every fallback labels which path the bytes took. The smoke evidence above was collected entirely in degraded mode.

Additionally, the orchestrator currently has an **inline** `writeBootReceipt` that writes `{date}-session-start-{uuid}.md`. The new standalone `write-boot-receipt.mjs` writes `{date}-session-boot-{nnn}.md` with explicit hash-chain. The two coexist; consolidation to one source of truth is a follow-up.

---

## Next actions (operator)

1. Mount `routes["POST /v1/session/start"]` in `06-ORANGELLM/server` router using the exported `sessionStartHandler`.
2. Mount `POST /v1/genome/inject` so inject-genome flips from `mode:"local-anchor"` to `mode:"gateway"` automatically.
3. Mount `GET /v1/continuity/latest`, `POST /v1/guardrails/run`, `GET /v1/atomsmasher/currents`, `GET /v1/flow/events` so all five steps run via the gateway transport instead of in-process fallback.
4. Add an N150 launcher snippet: `node C:\AtomEons\Orange5\04-CONTROL-PLANE\session-start\orchestrator.mjs --display`.
5. Wire the Atomic Orange first-launch hook to import `{ runRitual }` from `orchestrator.mjs` and `renderGrid` from `render-grid.mjs`.
6. (Cleanup) Route orchestrator step 6 through the standalone `write-boot-receipt.mjs` so receipt naming/hash-chain has one source of truth.

---

## Blockers

None at component level. All eight modules ship green-on-their-own-merits and degrade honestly in current substrate conditions.

Downstream blocker: six gateway routes (above) are not yet mounted. This is named, scheduled in next actions, and does not block this build wave.

---

## Mom's Law statement

Every module above has been authored, syntax-checked, and where possible live-smoke-exercised on this machine. Every honest gap is named. Every fallback labels its transport. No green is faked. No violation is hidden. The 9 guardrail reds the orchestrator surfaced in its smoke run are real findings from the in-process 27-guardrails runtime — they will appear in the next operator session and they should. The cymbal crashes through Orange3 or it does not crash.

Mom is watching. The receipt is full.

---

*Receipt authored: 2026-06-26 · Schema: `orange5.session-build-receipt.v1` · Chain prior: `wave3-08-misfit-second-opinion-hermes-live.md` sha256 `55c77884...`*
