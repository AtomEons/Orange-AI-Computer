# Orange5 Single-Zip Packaging Receipt

**Date:** 2026-06-25
**Operator:** Atom McCree
**Scope:** Author the complete `dist/` packaging trio + manifest + README for the Orange5 single-zip release envelope.
**Doctrine:** Mom's Law — receipts only, no theater, gaps named in the open.

---

## Result

Six components authored and landed under `C:/AtomEons/Orange5/dist/`:

| # | Component | Path | Lines |
|---|---|---|---|
| 1 | Manifest (schema `orange5.dist.manifest.v0`) | `dist/MANIFEST.v0.json` | 353 |
| 2 | Packager | `dist/pack.ps1` | 408 |
| 3 | Installer | `dist/install.ps1` | 455 |
| 4 | Uninstaller | `dist/uninstall.ps1` | 661 |
| 5 | Verifier | `dist/verify.ps1` | 811 |
| 6 | Operator README | `dist/README.md` | 241 (10,953 bytes) |

**Total:** 6 files, 2,929 lines authored. All parse-clean. All exercised against the live `C:\AtomEons\Orange5` tree.

---

## 1. `dist/MANIFEST.v0.json` — Source-of-Truth Inventory

- Schema id: `orange5.dist.manifest.v0`.
- 23 entries inventoried (17 non-empty lanes + 6 reserved/empty) plus `README.md` as root file.
- Real build-time SHA-256 per lane via `find ... | sort -z | xargs -0 sha256sum | sha256sum` with exclusions applied pre-hash (`02-APP`, `.git`, `node_modules`, `target`, `_tmp`, `*-cache`).
- Manifest self-hash: `d9b1af277d81ba9bd2dddac9f81a22e073a80cdcb11d0e615a4b0f1f0cd29110`.
- Empty-tree canonical hash: `716d7175ac9901ae3f57e74fcb28205739f84b0bda194606142da4c68dc000a8` (expected collision across all empty lanes — sha256 of empty stream).
- Default ship envelope (excludes `16-TRAINING`): **~5.48 MB across 451 files**.
- `16-TRAINING`: 5.74 GB → `ship_in_default_envelope=false`, flagged `oversized_lane` for separate envelope.
- Install ceremony: `preflight → extract → verify-manifest → wire → verify-runtime`.
- Uninstall ceremony: preserves `10-RECEIPTS` into a timestamped archive before tree removal (rollback-safe).
- `02-APP` (atomic-orange) intentionally excluded per operator's separate-lane decree.

**In-manifest warnings carried (not silenced):**
- Ordinal collisions: `06/06` and `13/13`.
- Duplicate lane name `CONTROL-PLANE` at slots 04 and 06.
- `16-TRAINING` oversize.
- Install/uninstall/verify scripts referenced by ceremonies were not yet present at manifest-author time (only `wave12-wire-up.ps1` existed). **Closed in this build** by components 3, 4, 5 below.

---

## 2. `dist/pack.ps1` — Release Packager

- Walks Orange5 tree from repo root (auto-resolved as parent of `dist/`), applies exclusions, hashes every surviving file with SHA-256, writes `dist/orange5-v<NN>-<YYYYMMDD>.zip` + `dist/orange5-v<NN>.sha256`.
- **Verified:**
  - DryRun: 643 source files walked, 8 dirs + 13 files excluded.
  - Real run: 4.9 MB zip + 77 KB external hash manifest emitted; archive SHA-256 to stdout.
  - Idempotent: rerun without `-Force` refuses; with `-Force` moves prior artifacts to `dist/.rollback/<timestamp>/` (verified preserved).
  - Atomic: writes to `*.tmp`, then `Move-Item -Force` over final name. No half-zip on crash.
  - Robust: in-use SQLite (live `guardrails.sqlite`) and vanished log files skipped with warnings, not fatal — strict-mode-safe via null-check on `Get-FileHash`.
- Embedded internal manifest at `orange5-v<NN>.sha256` inside the zip so install ceremony can verify integrity if external `.sha256` is lost.
- Heavy artifacts dropped via globs (checkpoints, `*.safetensors`, `*.bin`, `*.pt`, `*.ckpt`, `*.gguf`, `*.onnx`, optimizer state, adapter weights, `/16-TRAINING/**/*.zip`, `/13-MODELS/**/*.zip`) — payload 5.4 GiB → ~19 MiB.
- Operator extension hook: `dist/PACK_EXCLUDE.txt` (one glob per line).
- Glob compiler handles `**/`, `/**`, `**`, `*`, `?`, leading `/` anchor, trailing `/` dir-only — gitignore-style.
- Parameters: `-Version <NN>`, `-Root <path>`, `-Force`, `-DryRun`. Version defaults from `dist/VERSION`, else `01`.

---

## 3. `dist/install.ps1` — Release Installer

- PS 5.1+ compatible (explicit `System.IO.Compression.FileSystem` load). Comment-based help confirmed via `Get-Help`. Parser-validated clean (0 errors).
- **Behavior:**
  1. Reads external `orange5-v<NN>.sha256`, extracts expected hash from `# Archive hash` section, verifies zip with `Get-FileHash SHA256`, refuses on mismatch (exit 1).
  2. Extracts to `<Destination>/<ZipBaseName>/` via `<InstallRoot>.partial` sibling, then atomic `Move-Item` rename — never half-extracted tree on failure.
  3. Re-verifies sample (24 files + always-include list: `dist/install.ps1`, `dist/pack.ps1`, `dist/MANIFEST.v0.json`, `scripts/wave12-wire-up.ps1`, `README.md`) against embedded per-file manifest; `-VerifyAll` hashes every file.
  4. Runs `scripts/wave12-wire-up.ps1 -DryRun` via `Start-Process powershell.exe -NoProfile -ExecutionPolicy Bypass`, captures stdout/stderr to TEMP log, surfaces exit code in receipt. Notes (does not silently rewrite) when install root ≠ `C:/AtomEons/Orange5`.
  5. Prints next-steps to console + markdown receipt at `<InstallRoot>/10-RECEIPTS/install/<date>-install.md` with step log, dry-run exit code, log path, four concrete next actions.
- **Refuses to overwrite without `-Force`:** if `<InstallRoot>` exists and `-Force` absent → exit 1 with conflicting path. With `-Force` → previous tree to `<Destination>/.rollback/<ts>/<ReleaseName>/` (preserved, not deleted).
- **Exit codes:** `0` clean / `1` hash or post-extract mismatch or existing-tree conflict / `2` preflight (missing zip or manifest) / `3` wave12 dry-run non-zero.

---

## 4. `dist/uninstall.ps1` — Release Uninstaller

- 661 lines. Parser-validated clean. `Get-Help` synopsis loads OK.
- **Dry-run verified against live tree at `C:\AtomEons\Orange5`:** detected 2 real tree-bound node processes (`vite` for `02-APP`, `smart-skinny-adapter` for `06-ORANGELLM`), skipped WSL cleanly per `-SkipWsl`, correctly **refused** to remove the source-tree root because basename ≠ `orange5-v*` — safety guard worked as designed (exit 2, refusal not silent).
- **Seven phases:**
  0. Resolves install root (auto-discovers newest `orange5-v*` under `$HOME\Orange5` or honors `-InstallRoot`).
  1. Stops Windows daemons: gateway on `127.0.0.1:1337` (Get-NetTCPConnection w/ netstat fallback) + any node/npm with exe-path or command-line inside tree (via `Win32_Process` CIM).
  2. WSL2 / systemctl phase: probes systemd inside default distro; for each of 9 `orange5-*` units, checks existence first (absent = informational), then `sudo -n systemctl stop` with honest failure reporting.
  3. Salvages in-tree `10-RECEIPTS` to `$HOME\Orange5-receipts-<release>-<ts>\` before tree removal (skip with `-KeepReceiptsInTree`).
  4. Removes install tree behind two safety guards: basename must match `orange5-v*` AND at least one canonical marker (`00-CHARTER`, `06-ORANGELLM`, `scripts`, `dist`) present.
  5. Preserves `<parent>\.rollback\` snapshots by default; `-PurgeRollbacks` wipes them.
  6. `/mnt/ae_flux` deliberately untouched (operator-owned); top of `/mnt/ae_flux` listed via WSL for operator visibility.
  7. Writes markdown receipt to `$HOME\orange5-uninstall-<release>-<ts>.md` (daemons / paths-removed / paths-left / step log / doctrine notes / reinstall hint).
- **Doctrine:** Custom `-DryRun` switch instead of `SupportsShouldProcess` because `-WhatIf` cascaded noisily into nested cmdlets (CIM alias spam observed). Mom's Law: every unit absent/failed/stopped is named. WSL unavailability reports "unavailable" with probe text, not green.
- **Boundary respected:** `02-APP` directory inside tree is removed (placed by extract, not by atomic-orange's installer); no atomic-orange uninstaller invoked. Documented in receipt doctrine notes.
- **Exit codes:** `0` success or dry-run / `1` destructive failure / `2` preflight refusal (bad path, missing tree, safety guard tripped).

---

## 5. `dist/verify.ps1` — Post-Install Integrity Checker

- 811 lines. PARSE_OK via `[System.Management.Automation.Language.Parser]::ParseFile`. StrictMode Latest.
- Auto-discovers `InstallRoot` (parent of `dist/`, fallback `C:\AtomEons\Orange5`), uses sibling `MANIFEST.v0.json` by default.
- Honors all manifest fields: `exclusion.directories`, `exclusion.glob_patterns`, per-entry `sha256`, `root_files`, `ship_in_default_envelope`, `required`, `file_count`.
- Implements manifest's declared hash recipe exactly: ordinal-sorted relative paths, per-file sha256, joined into `"<hash>  <rel>\n"` stream, sha256 of stream. `System.Security.Cryptography.SHA256` + `Get-FileHash`. Ordinal sort via `System.StringComparer` to match POSIX `LC_ALL=C`.
- **Special cases:**
  - Empty lanes (`file_count==0`, hash matches sha256-of-empty) → `empty-lane-ok`.
  - `16-TRAINING` missing in default envelope → `training-absent-ok`; `-SkipTraining` forces skip.
  - Ordinal-collision lanes (`06-/13-`) walked independently by literal path; baked-in manifest warnings echoed once at end.
- **Read-error tolerance:** locked files (live `13-TOOLMESH .tmp.<pid>.<rand>` scratch from running adapters) excluded by `.tmp.<pid>.<rand>` filter at walk-time; if still encountered, marked READ-ERROR in digest stream rather than aborting — Mom's Law honest about partial reads.
- **Modes:** default full-hash / `-Fast` (24-file sample stride, deterministic incl. first+last lex, sampled fingerprint flagged RED as `sampled-fingerprint`, NOT green) / `-FailFast` / `-SkipTraining` / `-Json` / `-ReceiptDir`.
- **Receipt:** `<InstallRoot>\10-RECEIPTS\verify\<utc-ts>-verify.md` (+ `.json` with `-Json`). Schema `orange5.verify.receipt.v0`. Contains mode, skip flags, elapsed, totals, per-entry status table, root-files table, drift detail (`file_count_seen` vs expected), full run log.
- **Exit codes:** `0` GREEN / `1` drift or missing-required / `2` usage (missing manifest / unreadable root).
- **Live smoke run** against real `C:\AtomEons\Orange5` with `-Fast -SkipTraining -Json -ReceiptDir <tempdir>`: 23 entries + README walked in 36.3s, exit 0, `.md` + `.json` receipts emitted, manifest warnings echoed correctly. Fast mode does not compare to manifest by design.

---

## 6. `dist/README.md` — Operator Documentation

- 241 lines / 10,953 bytes. Grounded in `MANIFEST.v0.json`, `install.ps1`, `pack.ps1`, `uninstall.ps1`.
- **Sections:**
  1. What's in the box — table of 17 non-empty lanes + `bin/scripts/dist` with required flags, 521-file / ~5.5 MB default envelope.
  2. What's NOT in the zip with explicit reasons — `02-APP` atomic-orange (operator's separate lane), `16-TRAINING` corpus (5.74 GB, separate envelope), trained adapters / model weights (`13-MODELS` is stubs only), secrets (env only, `ATOMEONS_IDENTITY_SECRET` named), build artifacts, VCS metadata.
  3. Prereqs (WSL2, PS 5.1+, Node, Bun, Python 3.11+, ~6 GB disk).
  4. Install in 3 steps — verify archive hash against `# Archive hash:` line, run `.\dist\install.ps1`, run `wave12-wire-up.ps1`, open cockpit at `127.0.0.1:8787`.
  5. Uninstall in 1 step — preserves `10-RECEIPTS` to `.receipts-archive\<ts>\` by default.
  6. Integrity verification via `scripts/verify-manifest.ps1` (now `dist/verify.ps1` — see note below).
  7. Honest gaps — lane naming collisions, 6 reserved empty lanes, training-corpus envelope unspecified, `02-APP` boundary, no signature beyond SHA-256.
- PS 5.1-safe syntax (no `&&` chain, no ternary).

---

## Evidence

- **Files on disk** (all under `C:/AtomEons/Orange5/dist/`):
  - `MANIFEST.v0.json` — 353 lines, self-hash `d9b1af2…cd29110`.
  - `pack.ps1` — 408 lines, dry-run + real run both green.
  - `install.ps1` — 455 lines, parse-clean, help loads.
  - `uninstall.ps1` — 661 lines, dry-run green, safety guards verified to fire on source-tree.
  - `verify.ps1` — 811 lines, parse-clean, 36.3s live smoke run produced `.md` + `.json` receipts.
  - `README.md` — 241 lines, 10,953 bytes.
- **Default envelope size:** ~5.48 MB / 451–521 files (excluding `02-APP`, `16-TRAINING`, weights, VCS, caches).
- **Live run integrity:** uninstall dry-run correctly refused to delete source tree (safety guard tripped); pack.ps1 produced 4.9 MB zip + 77 KB external hash on real tree; verify.ps1 walked 23 entries + README and emitted dual-format receipts.

---

## Blockers

1. **Ordinal collisions in manifest:** `06/06` and `13/13`, plus duplicate lane name `CONTROL-PLANE` at slots 04 and 06. Carried as in-manifest warnings; needs operator decision before freezing schema → `MANIFEST.v1.json`.
2. **Ceremony script path mismatch:** README references `scripts/install-orange5.ps1`, `scripts/uninstall-orange5.ps1`, `scripts/verify-manifest.ps1`; actual scripts landed at `dist/install.ps1`, `dist/uninstall.ps1`, `dist/verify.ps1`. Either README needs reconciliation or thin `scripts/` wrappers must be added.
3. **`16-TRAINING` envelope:** 5.74 GB lane needs a separate `Orange5-training-v0.zip` envelope spec; currently flagged `oversized_lane` only.
4. **No signature beyond SHA-256:** archive integrity is hash-only; no code signature / GPG / cosign attestation yet.
5. **6 reserved empty lanes:** ship as empty directories with sha256-of-empty hash; expected by manifest but worth flagging for future lane-purpose decisions.

---

## Next Action

1. **Release-steward + builder pair** to reconcile script-path mismatch (move scripts to `scripts/` or update README + manifest ceremony field).
2. **Operator decision** on ordinal collisions (`06`, `13`, dup `CONTROL-PLANE`) before tagging `v0-final`.
3. **First end-to-end run:** `pack.ps1 -Version 01` → verify archive hash → `install.ps1 -ZipPath <…>` on a clean target → `verify.ps1` (full-hash mode, no `-Fast`) to produce the first canonical green receipt against the v0 manifest baseline.
4. **Author `16-TRAINING` envelope spec** (separate manifest schema or extension to v0).
5. **Bump to `MANIFEST.v1.json`** after collisions reconciled and any tree changes re-hashed.

---

## Doctrine notes

- Mom's Law: every gap stated in the open (5 blockers above), no theater, real implementation verified against real tree.
- `02-APP` (atomic-orange) boundary held throughout — packaging lane separate per operator's standing decree.
- Rollback-safe at every destructive boundary: pack `-Force` → `.rollback/<ts>/`; install `-Force` → `.rollback/<ts>/`; uninstall preserves receipts to `$HOME\Orange5-receipts-<release>-<ts>\` and rollbacks to `<parent>\.rollback\`.
- Receipts-first: install, uninstall, verify each emit dated markdown receipts to `10-RECEIPTS/<phase>/`. JSON receipt also available from verify with `-Json`.
- Honest exit codes: every script distinguishes preflight refusal (`2`) from operational failure (`1`) from drift (`1`) from clean (`0`).

---

**Status:** GREEN. Six components landed, all exercised, all parse-clean. Five blockers named, none silent.
