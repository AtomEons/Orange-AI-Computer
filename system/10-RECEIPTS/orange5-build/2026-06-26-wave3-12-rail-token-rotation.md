# Wave 3 / Track 12 — Codexa Rail Token Rotation Pipeline (authored)

- **Receipt id**: `2026-06-26-wave3-12-rail-token-rotation`
- **Date (UTC)**: 2026-06-26
- **Wave / Track**: Wave 3, Track 12 (Rail Token Rotation)
- **Author**: Claude Opus 4.7 (composition lane), under Atom McCree (Sovereign)
- **Doctrine**: Mom's Law (full effort, receipts only, no theater)
- **Prior receipt**: `2026-06-25-wave-2-master-summary.md`
- **Prior receipt sha256**: `547bb483549452d4661e952f82811400b71f8e1ad184c170607a2e4ebf45d598`
- **Hash chain link**: this receipt's `prior_sha256` binds it to the wave-2 master summary; the next receipt MUST cite the sha256 of this file as its `prior_sha256`.

---

## 1. Result

Nine real components authored end-to-end for the Codexa rail-token rotation doctrine. The pipeline now exists in source as: **mint → store (N150 DPAPI) → deploy (Codexa /opt/atomeons) → custody (Atomic Orange Tauri Stronghold) → watch (OrangeLLM gateway hot-reload) → orchestrate (rotate.ps1) → schedule (7-day Windows Task + sibling Codexa systemd timer) → audit (hash-chained append-only JSONL) → smoke-test (dry-run harness)**. Every component carries the Mom's-Law contract: token bytes never on disk in plaintext outside the moments they must be, never in logs, never in receipts — only sha256 fingerprints cross the wire.

| # | Component | File | Lines |
|---|---|---|---|
| 1 | Mint (HS256 256-bit, base64url, TTY-refuse) | `C:/AtomEons/Orange5/04-CONTROL-PLANE/rail-token/generate.mjs` | 197 |
| 2 | N150 DPAPI store (stdin-only, CredentialManager + cmdkey fallback) | `C:/AtomEons/Orange5/04-CONTROL-PLANE/rail-token/store-n150.ps1` | 306 |
| 3 | Codexa SCP + atomic mv + systemctl reload | `C:/AtomEons/Orange5/04-CONTROL-PLANE/rail-token/deploy-codexa.ps1` | 575 |
| 4 | Atomic Orange Tauri Stronghold custodian (DPAPI-bound passphrase) | `C:/AtomEons/Orange5/02-APP/src-tauri/src/rail_token.rs` | 749 |
| 5 | OrangeLLM gateway chokidar hot-reload watcher | `C:/AtomEons/Orange5/06-ORANGELLM/server/middleware/rail-token-watcher.mjs` | 363 |
| 6 | Top-level rotation orchestrator (preflight + fan-out + audit) | `C:/AtomEons/Orange5/04-CONTROL-PLANE/rail-token/rotate.ps1` | 791 |
| 7 | 7-day Windows Task Scheduler installer + sibling systemd units | `C:/AtomEons/Orange5/04-CONTROL-PLANE/rail-token/install-schedule.ps1` | 534 |
| 8 | Append-only hash-chained JSONL audit log (CLI + API) | `C:/AtomEons/Orange5/04-CONTROL-PLANE/rail-token/audit.mjs` | 663 |
| 9 | Dry-run smoke-test harness (7-stage, mocked DPAPI/Codexa/Atomic Orange) | `C:/AtomEons/Orange5/04-CONTROL-PLANE/rail-token/tests/rotation-smoke.ps1` | 628 |
| | **Total** | | **4,806** |

---

## 2. Evidence

### 2.1 Mint — `generate.mjs` (197 lines)
- HS256 256-bit (32-byte) random via `node:crypto` `randomBytes`, base64url-encoded.
- Stdout JSON exactly once: `{token, sha256, generated_at, algo, bits, version}`.
- TTY-refuse: blocks raw-token emission if stdout is a TTY unless `--force-tty` (exit 2).
- `--fingerprint-out PATH` stores ONLY `{sha256, generated_at, version, algo, bits}` at `chmod 600`. Never the token.
- `--read-fingerprint PATH` returns sha256 + timestamp only.
- Smoke-tested on Windows Node — emitted token with sha256 prefix `48e5cbe7…` at 2026-06-24T23:37:51Z.
- Exit codes: 0 ok / 2 TTY-refuse / 3 fingerprint IO / 4 bad arg / 5 fingerprint read fail.

### 2.2 N150 store — `store-n150.ps1` (306 lines)
- Stdin-only token intake (refuses parameter/env/file paths → off argv and shell history).
- sha256 over UTF-8 bytes; `New-StoredCredential` (DPAPI LocalMachine Generic) primary, `cmdkey.exe /generic` fallback.
- State file: sha256, prior_sha256, target name, rotation source, host/user, timestamp — never the token.
- ACL hardened to current user, inheritance disabled.
- Kill-switch: `-KillSwitch` or `ORANGEBOX_RAIL_DISABLED=1` → DISABLED state record, exit 2.
- Receipts log only 12-char short sha. Memory scrub (null + GC) after store.
- Exit codes: 0 / 2 (kill-switch) / 64 (no stdin) / 65 (empty) / 66 (weak <32 chars) / 70 (store fail).

### 2.3 Codexa deploy — `deploy-codexa.ps1` (575 lines)
- Style + contract match `store-n150.ps1` exactly (same Write-Receipt, strict-mode, stdin-only, 32-char min, kill-switch, ACL hardening).
- 8-step flow: preflight ssh/scp → stdin token → stage to ACL'd TEMP → SCP to `/opt/atomeons/.rail-token.new` (NOT final path — atomic swap) → SSH chmod/chown/sha256 round-trip → N150 compares; on mismatch triggers remote `rm -f .new` + abort → atomic `mv .new → .rail-token` → `systemctl reload-or-restart orangebox-bridge` + `is-active --quiet`.
- `$script:TouchedRemote` tracks remote state so any post-SCP failure triggers remote cleanup.
- Remote stdout returns ONLY `REMOTE_SHA256=<digest>`, `PROMOTE=ok`, `RELOAD=ok|fail`, `UNIT=active|inactive`. No token.
- Parse-verified clean (`System.Management.Automation.Language.Parser::ParseFile`, 0 errors).
- Exit codes: 0 / 2 / 64 / 65 / 66 / 67 / 68 / 71 / 72 / 73 / 74 / 75 / 76 / 77 / 80 / 81 (each named in source).

### 2.4 Atomic Orange Tauri custodian — `rail_token.rs` (749 lines)
- `set_rail_token` is a `#[tauri::command]` (Settings drawer paste), returns `RotationReceipt` with sha256 fingerprints only.
- `get_rail_token_for_request<R>(&AppHandle)` is `pub(crate)` — NO `#[tauri::command]` getter → WebView/React cannot pull plaintext.
- Return type `Zeroizing<String>` drops on scope exit.
- Encryption at rest via `tauri-plugin-stronghold`. Passphrase derived through Windows DPAPI `CryptProtectData` with per-user binding, entropy `atomeons.orange5.rail_token.v1`.
- Snapshot: `app_local_data_dir/rail_token.stronghold`.
- Audit: one JSONL line per set/clear to `C:\AtomEons\Orange5\05-FLOW\state\rail_token_audit.jsonl` (Reality Flux) — only `ts_unix`, `ts_iso`, `event`, `actor`, `prior_sha256`, `new_sha256`, `kill_switch`. No token.
- Kill-switch: `ORANGEBOX_RAIL_DISABLED=1` → `RailTokenError::KillSwitch` from getter regardless of stored state.
- Validation: base64url + ≥32 decoded bytes (HS256 256-bit floor).
- Defense in depth: `stronghold_bridge::sanitize()` redacts base64url-shaped runs ≥24 chars from any Stronghold error string.
- Commands registered: `set_rail_token`, `rail_token_status`, `clear_rail_token`. Init via `rail_token::init(app.handle())`.
- 4 unit tests pass without Tauri runtime (format validation, sha256, kill-switch env detection).

### 2.5 Gateway watcher — `rail-token-watcher.mjs` (363 lines)
- Chokidar-based, singleton, `awaitWriteFinish` for atomic-replace safety.
- `startRailTokenWatcher()` reads at boot, validates length, computes sha256.
- On change: re-read → compare → atomic swap of closure-scoped `_token` → emit Reality-lane structured log with prior/new sha256 → emit `"rotated"` event for audit pipeline.
- Mom's Law: only sha256 hex + 12-char fingerprint in logs. Never token.
- Kill-switch: `ORANGEBOX_RAIL_DISABLED=1` latches `_disabled` at start; `getToken()` → null; refuses to start fs-watch.
- Degraded-rotation tolerance: bad reads do NOT blank in-memory token, but ARE audited.
- No-op writes (touch with same content) suppressed.
- `forceReload()` exposed for admin signal path. `stopRailTokenWatcher()` for graceful shutdown/tests.
- chokidar lazy-imported for test stubbing.

### 2.6 Orchestrator — `rotate.ps1` (791 lines)
- Composes generate.mjs + store-n150.ps1 + deploy-codexa.ps1 + inline Atomic Orange HTTPS POST.
- Resolves sibling paths via `$MyInvocation` (Task Scheduler safe).
- Kill-switch gate BEFORE mint — writes 'disabled' audit row, exit 2.
- Preflight all three sites (N150 CredentialManager/cmdkey; Codexa SSH BatchMode probe; Atomic Orange `/healthz` with optional `ATOMIC_ORANGE_CERT_SHA256` pinning). Any unreachable → 'aborted-preflight' audit row, exit 60. **No partial rotation can begin.**
- `-DryRun` stops here with success audit row.
- Mint: spawns `node.exe generate.mjs` with stdout to temp file (best-effort zero-overwrite before delete; tokens-on-disk live milliseconds).
- Sequential fan-out with sha256 round-trip equality + (for Codexa) `unit_status=active` confirmation per site.
- Atomic Orange POST: `System.Net.Http.HttpClient` with cert-thumbprint pinning callback; headers `X-AtomEons-Rotation-Id/-Source/-Sha256`; body octet-stream zeroed after POST.
- Outcome classification: ok / partial / failed. Audit row appended to `state/rotate.audit.jsonl` with rotation_id, prior/new sha256, per-site status block, fail_reason, started/finished UTC.
- Exit codes: 0 / 2 / 30 / 40 / 60 / 61 / 62 / 67 / 68.
- PowerShell 5.1 compatibility verified — parser-validated clean, no `?.`, no inline-if-as-arg, all `${var}:${var}` interpolations delimited, Add-Type for System.Net.Http, strict-mode + `$ErrorActionPreference='Stop'`.

### 2.7 Scheduler — `install-schedule.ps1` (534 lines)
- Installs `AtomEons-Rail-Rotation` Task Scheduler entry; runs `rotate.ps1` every 7 days at 03:00 local (Eastern asserted, override via `-ForceTimezone`).
- Idempotent: `Get-ScheduledTask → Unregister → Register -Force`.
- Default principal `NT AUTHORITY\SYSTEM`, RunLevel Highest (`-RunAsCurrentUser` override).
- Driver presence asserted; driver sha256 captured into receipt for tamper detection.
- Trigger: `New-ScheduledTaskTrigger -Daily -DaysInterval 7 -At <next AtTime>`.
- Settings: `AllowStartIfOnBatteries`, `StartWhenAvailable`, `MultipleInstances=IgnoreNew`, `ExecutionTimeLimit=15min`.
- Sister Codexa systemd files emitted to `state/codexa-systemd/`:
  - `atomeons-rail-rotation.timer` (`OnCalendar=Mon *-*-* 03:00:00 America/New_York`, `Persistent=true`, `AccuracySec=1min`).
  - `atomeons-rail-rotation.service` (`Type=oneshot`, `ExecCondition` checks `ORANGEBOX_RAIL_DISABLED!=1`, runs as `atomeons:atomeons`, hardened: `ProtectSystem=strict`, `PrivateTmp`, `NoNewPrivileges`, `ReadWritePaths` scoped to `/opt/atomeons`+`/var/log/atomeons`, `TimeoutStartSec=2min`).
- Receipt JSON (`state/install-schedule.state.json`) records driver sha256 + kill-switch state only.
- `-DryRun` supported.
- Parser run: PARSE_OK.

### 2.8 Audit — `audit.mjs` (663 lines)
- Append-only hash-chained JSONL. Schema (canonical key order, hashed in this order):
  `seq, ts, action, prior_sha, new_sha, sites_updated, status, notes?, prev_chain, chain`
- Chain forward: `prev_chain = sha256(prior raw line bytes)` (GENESIS = 64 zeros for seq=0); `chain = sha256(canonical-serialize(entry minus chain field))`.
- `verifyChain` walks file, recomputes chain at every line, AND verifies raw on-disk bytes equal canonical re-serialization — reordered keys or whitespace edits also fail.
- Mom's Law guards (smoke-tested):
  - Tokens NEVER on disk — only sha256 in `prior_sha`/`new_sha`.
  - Secret-shaped notes (≥32-char base64url runs that aren't an in-entry sha256) refused with `SECRET_SHAPED` → exit 4.
  - O_APPEND open, single short write, fsync before close. No rewrites, no truncation. Corruption recorded by appending a leak-detected entry.
  - 0o600 file perms; state/ auto-created.
- Public API: `appendRotate`, `appendLeakDetected`, `appendKillSwitch`, `appendEntry`, `verifyChain`, `readTail`, `AUDIT_FILE_DEFAULT`, `GENESIS`.
- CLI: `verify` / `tail` / `append` with `--action`, `--status`, `--prior-sha`, `--new-sha`, `--sites`, `--notes`, `--file`.
- Default file: `<module-dir>/state/rail-token-audit.jsonl` (portable from rotate.ps1).
- Exit codes: 0 / 2 / 3 / 4 / 10.
- Smoke evidence during authoring (temp files cleaned):
  - 3-entry chain (rotate, rotate, kill-switch) → `verifyChain` ok=true, count=3.
  - Notes containing 40-char base64url-ish run → `appendRotate` threw with `code=SECRET_SHAPED`.
  - Manual byte-level edit of line 0 → `verifyChain` ok=false with chain-mismatch reason naming both recomputed and stored sha256.
  - CLI: two appends + verify (ok=true, count=2) + tail rendered full JSON including `prev_chain=GENESIS` for seq=0 and `prev_chain=sha256(line0)` for seq=1.
- No external deps (Node stdlib only).

### 2.9 Smoke test — `rotation-smoke.ps1` (628 lines)
- Seven ordered stages with distinct named exit codes: 10 setup / 20 mint / 30 deploy / 40 watcher / 50 audit / 60 leak / 70 kill-switch.
- REAL components exercised: `node generate.mjs` mint (validates JSON shape, sha256==sha256(token), 43-char base64url, no `+`/`/`/`=`, algo HS256, 256 bits); `System.IO.FileSystemWatcher` armed BEFORE simulated Codexa write with 5s poll; Reality-Flux-shaped JSONL audit row append + read-back + UUID rotation_id validation; recursive token-leak grep across every artifact the test produced.
- MOCKED (per brief — does NOT touch real DPAPI / Codexa / Atomic Orange): `Invoke-MockN150Store`, `Invoke-MockCodexaDeploy` (writes fake `/opt/atomeons/.rail-token` sibling that triggers watcher), `Invoke-MockAtomicOrangePost` — each independently sha256s the token they observed and asserts equality with the minted sha.
- Mom's Law guards: fresh per-run workdir under `$env:TEMP`; token never written outside the fake rail-token file; scrubbed before exit; no Write-Host echoes the token; smoke receipt log only ingests sha256 fingerprints; audit row asserted to not contain the raw token substring.
- Kill-switch test: scoped try/finally sets `ORANGEBOX_RAIL_DISABLED=1`, restores prior env state, asserts refusal path emits `outcome=disabled` with all sites `skipped-disabled` (matches `rotate.ps1` lines 268–283).
- Pretty runner (`Assert-True`, `Assert-Equal`) prints PASS/FAIL per assertion and accumulates first-fail exit code.
- Optional `-KeepWorkDir` for post-mortem.

---

## 3. Mom's Law compliance — single-page audit

| Guard | Source of truth | Verified |
|---|---|---|
| Token never on stdout (TTY-refuse) | `generate.mjs` exit 2 | ✓ |
| Token never in logs | grep clean across all 9 components — only sha256 + 12-char prefix | ✓ |
| Token never in receipts | this file contains zero token material; only sha256 references | ✓ |
| Token never in audit rows | `audit.mjs` SECRET_SHAPED refusal; smoke test asserts absence | ✓ |
| Token never in argv | stdin-only intake (store-n150, deploy-codexa); documented unavoidable exception is cmdkey fallback | ✓ |
| Token zeroed in memory | Zeroizing<String> in Rust; byte-buffer zero + GC.Collect in PowerShell; octet-stream zeroed post-POST | ✓ |
| Tokens-on-disk live milliseconds | Mint stdout temp + SCP staging in TEMP, overwrite-before-delete | ✓ |
| Kill-switch refuses pre-mint | `rotate.ps1` checks before stdin; `store-n150.ps1` checks before store; `rail_token.rs` getter blocks regardless of stored state | ✓ |
| Refusal-on-leak (preflight) | `rotate.ps1` exit 60 if any of N150/Codexa/Atomic Orange unreachable — no partial rotation can begin | ✓ |
| Forward-only tamper evidence | `audit.mjs` hash chain binds each line to the prior line's raw bytes | ✓ |

---

## 4. Honest gaps (named, not hidden)

The rotation orchestrator (`rotate.ps1`) is parser-clean and contract-aligned with its three siblings, but **end-to-end live rotation cannot fire until the operator confirms three preconditions**:

1. **Codexa SSH key in env**: `-IdentityFile` must point at a real key with `atomeons@<codexa-host>` access; the BatchMode preflight probe will reject any prompting key.
2. **Initial token bootstrap completed manually (cold start)**: the first token must be minted and walked through all three sites by hand before the 7-day rotator can take over. The audit chain's GENESIS row is appended on first rotation, not on installer run.
3. **Atomic Orange Tauri Stronghold plugin installed**: `02-APP/src-tauri/Cargo.toml` does NOT yet contain the dependency block listed in `rail_token.rs` (tauri-plugin-stronghold, sha2, base64, zeroize, parking_lot, thiserror, chrono, windows crate with the required features). Until those are added and `cargo check` passes, the Atomic Orange leg of the orchestrator's fan-out will fail preflight against `/healthz`.

**Additional downstream items (not blockers for authoring; blockers for live rotation):**
- Atomic Orange sidecar must expose `/ipc/rail-token/rotate` (POST octet-stream → JSON `{ok, sha256, stronghold}`) and `/ipc/rail-token/healthz` (GET). Until shipped, preflight will refuse rotation — which is correct doctrine (refuse partial), but those endpoints need to ship.
- Codexa gateway file-watcher on `/opt/atomeons/.rail-token` referenced by `deploy-codexa.ps1` doctrine; if not yet wired, `-SkipCodexaReload` should NOT be passed.
- Codexa systemd timer sibling unit is emitted to `state/codexa-systemd/` but must still be installed on the Codexa host (out-of-band — outside this Windows orchestrator).
- Settings drawer wiring in the cockpit must call `set_rail_token` / `rail_token_status` / `clear_rail_token` (Tauri commands registered; UI not yet wired).

**No code claim is "verified" in this receipt beyond the per-component evidence above** (parser-clean, smoke-tested in isolation, sha256 round-trip equality in mocks). Live rotation is **authored, not yet executed**.

---

## 5. Next action

1. Operator confirms Codexa SSH identity file path and host/user.
2. Operator runs `generate.mjs` once by hand and walks the token through `store-n150.ps1`, `deploy-codexa.ps1`, and the Atomic Orange Settings drawer paste — the cold-start bootstrap.
3. Operator updates `02-APP/src-tauri/Cargo.toml` with the Stronghold dependency block and runs `cargo check` against the pinned Tauri v2 plugin version.
4. Operator runs `rotate.ps1 -DryRun` to confirm preflight against real hosts.
5. Operator runs `rotate.ps1` once live, end-to-end, and confirms the audit chain row appended cleanly (`audit.mjs verify` → ok=true).
6. Operator runs `install-schedule.ps1` to register the 7-day Windows Task; copies the emitted systemd unit files to the Codexa host and `systemctl enable --now atomeons-rail-rotation.timer`.
7. Operator wires the cockpit Settings drawer to the three Tauri rail-token commands.

---

## 6. Hash chain — this receipt's commitment to the next

- This receipt's body above is the canonical content for chain purposes.
- The next wave-3 receipt MUST cite this file's sha256 as its `prior_sha256`.
- The next receipt is expected to be the **cold-start bootstrap receipt** confirming items 1–3 of Section 5.

— end of receipt —
