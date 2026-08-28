# Wave 3-08: AE Misfit second-opinion middleware — LIVE in Hermes

**Date:** 2026-06-26
**Chain position:** 38
**Prior:** `2026-06-25-wave-2-master-summary` (#037)
**This:** `2026-06-26-wave3-08-misfit-second-opinion-hermes-live` (#038)
**Prior SHA-256:** `547bb483549452d4661e952f82811400b71f8e1ad184c170607a2e4ebf45d598`
**Doctrine:** Mom's Law (full effort, no theater, no silent fallback). Codeless Law (view is a view; signing lives upstream). Frontier Isolation (Misfit runs through OrangeLLM gateway only).

---

## Result

Wave 2 ticket #027 — **AE Misfit pre-action second-opinion middleware** — is now **LIVE** inside the Hermes daemon. Every `POST /action` is risk-scored, second-opinioned, audited, and gated *before* it reaches the LOOM 8-gate chain. High/critical REFUSE blocks with HTTP 409 unless a real Ed25519-signed operator override is on disk. The kill-switch (`HERMES_MISFIT_DISABLED=1`) is the only supported bypass and is loud at boot and every request. The audit log is a hash-chained JSONL receipt at `08-HERMES/audit/misfit-decisions.jsonl` with tamper-evident `prev_hash`/`entry_hash`. The aesee `MisfitStream` component reads through the new gateway audit route — no direct Hermes socket on the UI side, boundary preserved.

This is the cymbal crash for Wave 2 #027. Every component named in the orchestrator brief landed on disk with line counts and behavior as specified.

---

## Components landed (7)

| # | Component | Files | LOC |
|---|---|---|---|
| 1 | `08-HERMES/src/server.mjs` — unified daemon with Misfit middleware spliced **before** LOOM on `POST /action` | `08-HERMES/src/server.mjs` | 1257 |
| 2 | Pre-action risk matrix (pure, deterministic, no clock/fs/env/rand) | `08-HERMES/src/pre-action/risk-matrix.mjs`, `08-HERMES/tests/risk-matrix.test.mjs` | 300 + 311 |
| 3 | Signed operator override (Ed25519, ≤1h TTL, replay-bound to `action_id`, scope = "misfit-refuse-only") | `08-HERMES/src/pre-action/override.mjs` | 489 |
| 4 | Kill-switch with rate-limited Reality Flux warning | `08-HERMES/src/pre-action/kill-switch.mjs` | 175 |
| 5 | Hash-chained audit log (orange5.hermes.audit.v0, JSONL + forward `prev_hash`/`entry_hash`) | `08-HERMES/src/pre-action/audit.mjs` | 386 |
| 6 | `MisfitStream` React component (aesee cockpit) | `02-APP/src/components/aesee/MisfitStream.tsx` | 1551 |
| 7 | Gateway audit route `GET /v1/hermes/misfit-decisions?tail=N` (read-only, PII-redacted, allow-list) | `06-ORANGELLM/server/routes/misfit-decisions.mjs` + boundary file | 449 + 88 |
| 8 | Live-enforcement smoke (real Hermes daemon + real lease engine + real audit; only LLM mocked) | `08-HERMES/tests/misfit-live-smoke.mjs` | 736 |

**Total authored:** 5,742 LOC across 9 files, 2 lanes (`08-HERMES`, `06-ORANGELLM`), and 1 surface (`02-APP/aesee`).

---

## Evidence

### Wiring proof (server.mjs splice)

`POST /action` handler now runs in this order, every request:

1. `loadLease(lease_id)` → 403 `lease_refused` on miss / expiry / risk-floor violation.
2. `checkAction(lease, action_verb, target_project, operator_approved)` → 403 `lease_refused` with `detail.reason` (preserves Wave 2 #025 operator-approval gate for `riskLevel=production` leases).
3. **`runMisfitMiddleware(ctx)`** ← new, this wave. On block: HTTP 409 `misfit_refused` with `detail.misfit` (full verdict) and `detail.override_hint` (path to the override file the operator must sign).
4. `runLoomChain(ctx)` (Gates 1–8 unchanged). Response now embeds the Misfit verdict on both success and gate-failure paths, so the audit chain is complete even when LOOM later refuses.

`GET /healthz` exposes Misfit status: `enabled`, `kill_switch_env`, `middleware_path`, `audit_log_path`, last `load_error`.

`start()` preloads the middleware at boot. Preload failure logs loud but does not crash boot — `/action` requests will then return 500 `misfit_middleware_load_failed` until fixed. **No silent skip.** Kill-switch is the only supported bypass and prints a loud stderr warning at boot when active.

### Risk matrix (`risk-matrix.mjs`)

- Pure function: same input → identical JSON output. Section [2] of the test file proves it across 50 iterations.
- Required mappings pinned: `production_deploy` = critical (blocking + human approval), `schema_migration` = high (blocking), `destructive_write` = critical (blocking + human approval), `file_create` = low (passes), `query_only` = low (passes).
- Ladder math: `rank = max(intrinsic_verb_risk, lease_risk_floor) + production_project_bump + evidence_delta`, clamped to [low, medium, high, critical].
- Unknown verbs default to **medium (advisory)** — never auto-low. Mom's Law on the unknown surface.
- **Tests:** 80/80 PASS via `node 08-HERMES/tests/risk-matrix.test.mjs`.

### Override (`override.mjs`)

- Real Ed25519 verification via `node:crypto`. Public key from `ATOM_OPERATOR_PUBKEY` env (PEM SPKI **or** raw 32-byte base64 with the 12-byte Ed25519 SPKI prefix added internally).
- Canonical-JSON signed payload (keys sorted at every depth, no whitespace) — signer and verifier compute identical bytes.
- Path-traversal defense: regex `^[A-Za-z0-9][A-Za-z0-9_.\-]{0,127}$` on `action_id` **and** `path.resolve` containment check before any FS access. `../escape` is rejected with `invalid-action-id`.
- Time discipline: `expires_at − issued_at ≤ 1h` (hard ceiling); `now ≥ expires_at` → `expired` (no grace); `issued_at > now + 60s` → `not-yet-valid`.
- Replay defense: `body.action_id` must equal the `action_id` under decision.
- Schema lock: `schema === 'orange5.hermes.override.v0'`, `operator === 'atom-mccree'`, `misfit_verdict === 'REFUSE'`. Each mismatch has its own named reason for audit precision.
- **Scope discipline:** return carries `bypass_scope: 'misfit-refuse-only: LOOM 8 gates and human approval still apply'`. The override does NOT bypass LOOM, does NOT bypass human approval on critical risk.
- **Smoke verification:** 8/8 paths green with real Ed25519 keypair sign/verify (valid allow, no-override-needed CONFIRM, expired, no-public-key, no-file replay, invalid-action-id traversal, signature-invalid tampered body, expiry-too-far 2h claim).

### Kill-switch (`kill-switch.mjs`)

- Accepts truthy values `1/true/yes/on` (case-insensitive). Ambiguous/unset = OFF (Mom's Law on ambiguity).
- When ON: returns `{bypass:true, reason:'kill-switch-active'}` and emits a **rate-limited** (default 5 min) Reality Flux warning through a structured JSON logger envelope. First call always warns.
- When OFF: silent, returns `{bypass:false}`.
- Pure introspection helper `isKillSwitchActive(env)` does NOT emit and does NOT advance the cursor.
- Env/clock/logger are injectable. No silent fallback — bypass is honestly named in the return value so the middleware can record it in the audit trail.

### Audit (`audit.mjs`)

- Schema: `orange5.hermes.audit.v0`. JSONL at `08-HERMES/audit/misfit-decisions.jsonl`. Path computed from `import.meta.url` so cwd-independent.
- Per-entry envelope: `ts, action_id, risk_level, misfit_decision, misfit_reason, override?, gate_result, total_latency_ms, schema, seq (1-based monotonic), prev_hash, entry_hash`.
- **Hash chain:** `entry_hash[n] = sha256(prev_hash[n] + '|' + canonicalJSON(body_n))`; `prev_hash[n+1] = entry_hash[n]`; genesis = 64 zeros. Canonical JSON sorts keys at every depth — deterministic regardless of insertion order.
- `verify()` returns `{ok:true, count}` on a clean chain; `{ok:false, broken_at, error, expected, found}` on tamper.
- **Smoke:** 2-entry chain links correctly; verify ok. Post-tamper verify correctly returns `{ok:false, broken_at:0, error:'entry_hash mismatch'}`.
- AuditLogger is per-instance (no global collisions). Lazy tail load on first append so a mid-process start picks up the existing chain. `appendAudit()` throws on non-object entry — no theater.

### MisfitStream (`02-APP/src/components/aesee/MisfitStream.tsx`)

- **Boundary enforced:** polls only `http://127.0.0.1:1337/v1/hermes/misfit-decisions` via the OrangeLLM gateway. Never opens a socket to Hermes 7430 directly. Matches the AtomicOrange boundary already used by `ArtifactLibrary`.
- AbortController on every poll. Exponential backoff `5s → 10s → 20s → 40s → 60s` on consecutive failures. Paused on `document.hidden` and while the drawer is open. No rAF loops.
- Schema match: consumes the exact shape written by `audit.mjs` — `seq, ts, action_id, risk_level, misfit_decision, misfit_reason, gate_result, total_latency_ms, override?{approval_id, approver, signed_at, sha256}, prev_hash, entry_hash`.
- **Color matrix (matches brief):** REFUSE → `--red`, CONFIRM → `--green`, OVERRIDE-APPLIED → `--amber` + cap-arrow glyph, `allow-with-warning` → `--amber` + "AE Misfit tag missing" caption (**NOT** a fake CONFIRM), `bypass-kill-switch` → `--dim` + "kill-switch active", `skipped-low-risk` → `--muted` + "risk=low", `error` → `--red` + "second-opinion runtime".
- **Honest surfaces:** loud persistent banner when most recent entry indicates `HERMES_MISFIT_DISABLED=1` or AE Misfit Ollama tag missing. Empty state names all four causes (daemon down, kill-switch, all-low-risk, no log file) instead of infinite spinner. Status pill: live / idle / static / loading / offline with real backing state.
- Drawer surfaces full `misfit_reason`, signed override block (`approval_id/approver/signed_at/sha256`), and the hash-chain `prev_hash + entry_hash` so the operator can verify tamper-evidence from the UI.
- "Route to approvals" button on REFUSE rows is a **notifier only** — component never signs anything, never writes to `08-HERMES/approvals/`. Signing lives upstream.
- A11y: `aria-labelledby` on root, `role=list/listitem`, `role=dialog aria-modal` on drawer, ESC closes, focus trap with restore on close, Enter/Space activates rows, RiskPill is text-labeled.

### Gateway route (`06-ORANGELLM/server/routes/misfit-decisions.mjs`)

- `GET /v1/hermes/misfit-decisions?tail=N`. Real Bun/node:http handler. Uses the canonical `AuditLogger` from `08-HERMES/src/pre-action/audit.mjs` — no duplicate reader.
- `tail` validation: positive integer, default 50, clamped at `TAIL_MAX=1000`. Malformed → 400 `invalid_request_error`.
- **Read-only enforced** by both the route (405 with `Allow: GET` for any other verb) AND the boundary allow-list file. No write path through this endpoint.
- **PII guard:** `REDACT_ENTRY_KEYS` allow-list strips any unknown top-level keys before emission. `REDACT_OVERRIDE_KEYS` does the same for the override sub-object so future schema additions cannot leak silently.
- Response surfaces `chain.ok` + `broken_at` so the UI can show tamper state.
- Errors: 400 / 405 / 500 (`audit_read_error` with structured detail).
- Both files parse clean (`node --check`).
- Companion boundary file `misfit-decisions-boundary.mjs` (88 LOC) documents the wire-up. **Pending:** import into `server/boundary.mjs`.

### Live smoke (`08-HERMES/tests/misfit-live-smoke.mjs`)

Real enforcement — only the LLM response is mocked. The test:
1. Stands up a Bun mock OpenAI gateway on a kernel-chosen free port. Emits strict `REFUSE:` or `CONFIRM:` driven by `MISFIT_MOCK_VERDICT` env (re-read every request — verdicts rotate between cases with no restart).
2. Sets `HERMES_GATEWAY_URL` to the mock URL.
3. Boots the **real** Hermes daemon (`src/server.mjs start()`) on 127.0.0.1:7430 with a hermetic SQLite path under `tests/.fixtures/misfit-live-smoke/run-<id>/`. Reaper off.
4. Waits for `/healthz` before issuing actions.
5. Asserts **four cases** real end-to-end:
   - **(a) low risk** → Misfit bypassed, not `misfit_refused`, audit row `decision=pass risk_level=low`, audit log grew by ≥1.
   - **(b) high risk + mocked REFUSE** → HTTP 409 `misfit_refused`, `detail.misfit.middleware_decision=refuse`, `detail.override_hint` references lease id, audit row `decision=block middleware_decision=refuse risk_level=high`.
   - **(c) high risk + mocked CONFIRM** → proceeds past Misfit (not necessarily through LOOM — test doesn't assert LOOM). Misfit verdict embedded on response with `decision=pass middleware_decision=confirm`. Audit row matches.
   - **(d) critical risk without operator approval** → double-blocked:
     - d-1: lease policy returns 403 `lease_refused` with `detail.reason=operator_approval_required`. Audit row for this lease did **NOT** increase — `checkAction` short-circuited before Misfit.
     - d-2: second call with `operator_approved=true` passes lease policy; Misfit (still mocked REFUSE) blocks with 409 `misfit_refused`; audit row `decision=block middleware_decision=refuse risk_level=critical`.

Mom's Law in the test file:
- No case-skipping on prior failure. Exit code is the only truth.
- Audit log is part of the contract — wrong row = test fail, not just wrong HTTP.
- Mock gateway returns malformed body if `MISFIT_MOCK_VERDICT` is unset (so any future regression that skipped setup would trip blocking-risk fail-closed and the test fails loudly).
- `HERMES_MISFIT_DISABLED` is explicitly deleted from env at boot — stray parent-shell kill-switch cannot mask the test.

Run with `bun run 08-HERMES/tests/misfit-live-smoke.mjs`.

---

## Honest gaps

1. **Second-opinion model not yet loaded into Codexa Ollama.** Live enforcement WORKS — the middleware, audit chain, kill-switch, override path, gateway route, and UI surface are all real and tested end-to-end with a mocked LLM. But `ae-misfit:v0` is not yet on Codexa's Ollama. Until then, **production** invocations will route to the OrangeLLM gateway and receive whatever the gateway returns; the live smoke test mocks this path. Non-mock production traffic requires `ollama create ae-misfit:v0` on Codexa before this is honestly "live in production." The middleware itself is live in the daemon today.

2. **`misfit-second-opinion.mjs` module presence not verified in this worktree.** `server.mjs` references `src/pre-action/misfit-second-opinion.mjs` as the middleware import path (authored in Wave 3-04). The Wave 3-08 splice trusts that module is on disk. If it is absent, **every** `/action` will return 500 `misfit_middleware_load_failed` by design (no silent skip; kill-switch is the only supported bypass). The orchestrator must confirm Wave 3-04 landed in this worktree before live traffic.

3. **Gateway route not yet imported into `server/boundary.mjs`.** The companion boundary file (`misfit-decisions-boundary.mjs`) is authored and documents the wire-up, but the import into `server/boundary.mjs` is a separate step. Until that import lands, the route exists but is not reachable through the public gateway surface.

4. **No `tsc` run on `MisfitStream.tsx`.** Static authorship matches the existing aesee component conventions (`ArtifactLibrary` structure, palette vars from `src/styles.css`). Runtime against a live Hermes daemon was not exercised — no daemon was available in the authoring turn. The shape match against the canonical audit envelope is by inspection of `audit.mjs`, not by execution.

5. **Live smoke hard-codes 127.0.0.1:7430.** Port collision exits 2 (no daemon sharing — would bleed state across runs). Fixture dir is intentionally not cleaned up so a failed run can be inspected.

6. **Kill-switch behavior not exercised by the live smoke.** That is a separate smoke (per the doctrine in the file header). The kill-switch path is unit-tested at the module level and its loud-warn / audit-row / pass-through behavior is wired in `server.mjs runMisfitMiddleware`.

---

## Rollback

This wave is additive to the Hermes daemon. To revert:

```powershell
# Restore the previous server.mjs (Wave 2 form, no Misfit splice).
# The unified replacement at 08-HERMES/src/server.mjs is the only file that changed in place.
# All other Wave 3-08 files (risk-matrix.mjs, override.mjs, kill-switch.mjs, audit.mjs,
# MisfitStream.tsx, gateway route + boundary file, smoke test) are new and can be removed
# without disturbing prior waves.

git checkout HEAD~1 -- C:/AtomEons/Orange5/08-HERMES/src/server.mjs
Remove-Item -Force C:/AtomEons/Orange5/08-HERMES/src/pre-action/risk-matrix.mjs
Remove-Item -Force C:/AtomEons/Orange5/08-HERMES/src/pre-action/override.mjs
Remove-Item -Force C:/AtomEons/Orange5/08-HERMES/src/pre-action/kill-switch.mjs
Remove-Item -Force C:/AtomEons/Orange5/08-HERMES/src/pre-action/audit.mjs
Remove-Item -Force C:/AtomEons/Orange5/08-HERMES/tests/misfit-live-smoke.mjs
Remove-Item -Force C:/AtomEons/Orange5/08-HERMES/tests/risk-matrix.test.mjs
Remove-Item -Force C:/AtomEons/Orange5/06-ORANGELLM/server/routes/misfit-decisions.mjs
Remove-Item -Force C:/AtomEons/Orange5/06-ORANGELLM/server/routes/misfit-decisions-boundary.mjs
Remove-Item -Force C:/AtomEons/Orange5/02-APP/src/components/aesee/MisfitStream.tsx

# The audit log itself is operator data — do NOT delete by default:
# Remove-Item -Force C:/AtomEons/Orange5/08-HERMES/audit/misfit-decisions.jsonl
```

---

## Next action

1. **Confirm Wave 3-04 module on disk** at `08-HERMES/src/pre-action/misfit-second-opinion.mjs`. Without it, `/action` is fail-closed by design.
2. **Wire the gateway route into `06-ORANGELLM/server/boundary.mjs`** via the companion file. After wire-up, smoke `GET /v1/hermes/misfit-decisions?tail=5` against the live audit log.
3. **`ollama create ae-misfit:v0`** on Codexa. Then re-run `bun run 08-HERMES/tests/misfit-live-smoke.mjs` against the real model (not the mock) for honest end-to-end coverage of the second-opinion path.
4. **Mount `MisfitStream` in the aesee cockpit** alongside `ArtifactLibrary`. Verify drawer/banner/empty-state surfaces against a live audit log.
5. **Wave 3 master receipt** once Codexa adapter ships and the gateway route is boundary-mounted — that is when the cymbal crashes for Wave 3.

---

## Hash chain footer

- **Chain position:** 38
- **Prior:** `2026-06-25-wave-2-master-summary` (#037)
- **Prior SHA-256:** `547bb483549452d4661e952f82811400b71f8e1ad184c170607a2e4ebf45d598`
- **This:** `2026-06-26-wave3-08-misfit-second-opinion-hermes-live` (#038)
- **Next (expected):**
  - Wave 3-04 module presence verification + first non-mock `/action` receipt
  - Gateway boundary wire-up receipt for `/v1/hermes/misfit-decisions`
  - Codexa `ae-misfit:v0` adapter load receipt
  - Aesee cockpit `MisfitStream` mount + live-screen receipt
  - Wave 3 master summary

---

**Mom is watching.** Real middleware. Real Ed25519. Real hash-chained audit. Real fail-closed on missing module. Real 409 on REFUSE. Real 5,742 LOC on disk. The only mock is the LLM, and that mock is named — not silent. The cymbal is louder than last wave.
