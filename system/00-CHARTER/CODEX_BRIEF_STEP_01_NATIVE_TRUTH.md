# Codex Marching Orders — Step 1: Atomic Orange Native Truth

**Date:** 2026-06-23
**Sovereign:** Atom McCree
**For:** Codex executor working on Atomic Orange
**Project root:** `C:\AtomEons\Orange5\`
**Work scope:** `C:\AtomEons\Orange5\02-APP\`
**Goal:** Take Atomic Orange from "web build works" to **real installable native app that launches, runs all 4 lanes, proves an OrangeLLM chat roundtrip end-to-end, with screenshots and a hash-chained receipt.**
**Spec source:** `00-CHARTER/ORANGE5_MASTER_PLAN.md` (read first)

---

## 0. Who you are

You are **Codex**, the executor for the Atomic Orange UI face only. You are NOT the architect, NOT the planner, NOT the memory daemon, NOT the gateway, NOT Hermes, NOT the visual lane. You build what this brief says, verify it, write a receipt, and stop.

Your lane is `02-APP/`. Stay in it.

---

## 1. The single objective

Land Atomic Orange as a **real installable Windows app** (NSIS or MSI bundle) that:

1. Builds via `npm run tauri:build` without errors.
2. Installs cleanly on the N150 (Windows 11) like a real user installation.
3. Launches into a window showing the four lanes (Chat / Cockpit / Vault / Settings).
4. Proves an end-to-end chat roundtrip: type a message → OrangeLLM gateway at `127.0.0.1:1337` → Smart Skinny via Ollama → response renders in the Chat lane.
5. Generates a receipt with attached screenshots and SHA-256 hashes of the bundle artifact.

No more, no less. Anything beyond this in this PR is scope creep.

---

## 2. Non-negotiable laws (these are above your judgment)

| Law | Meaning for you |
|---|---|
| **Mom's Law** | Give full effort. No theater. Every claim has a receipt. Every shortcut is named in the open. |
| **Frontier-Isolation Law** | Atomic Orange talks ONLY to `127.0.0.1:1337` (OrangeLLM gateway). Never `:8797`, never `:8094`, never `:8787`, never `10.0.99.1:*`. The gateway is the only legal door. |
| **Codeless Law** | NO code editor / Monaco / IDE features / Tab autocomplete / Agent Mode / Repo indexer inside Atomic Orange. Ever. |
| **No-Take-Down Law** | Do not restart, kill, or stop any running service. The gateway at `:1337`, Smart Skinny at `:8797`, command server at `:8787`, Vite dev at `:1420` — leave them all alone. If a build conflicts with a running port, change the build, not the port. |
| **No-New-Deps Law** | Do not `npm install` any new dependency unless this brief explicitly says to. Tauri CLI 2.x is the only thing that may be added if missing. |
| **Hash-Chain Preserve Law** | Every receipt in `10-RECEIPTS/orange5-build/` is part of a hash chain. Your new receipt's `prior_receipt` field MUST match the last receipt id in the chain. Read the last receipt first, get its id, use it as your `prior_receipt`. |
| **Git Discipline Law** | DO NOT commit. DO NOT push. DO NOT change branches. DO NOT touch `.git/`. The operator handles git. |
| **Scope Lock Law** | Only touch `02-APP/**` and `10-RECEIPTS/orange5-build/**`. Reading anything else is fine. Writing anything else is forbidden without explicit operator approval. |

---

## 3. Read these files BEFORE you touch anything

This is mandatory pre-flight. Read all six. Do not skim.

| Path | Why |
|---|---|
| `C:\AtomEons\Orange5\00-CHARTER\ORANGE5_MASTER_PLAN.md` | The whole map. Sections 1, 2, 4 are most relevant. |
| `C:\AtomEons\Orange5\00-CHARTER\ORANGE5_NOT_GREEN_LEDGER.md` | Current state of every claim. **Notice C10 + C11 are already closed by operator** — your build is the FULL close of native delivery, not a regression. |
| `C:\AtomEons\Orange5\02-APP\PR-01-SPEC.md` | The original PR-01 spec. Updated by this brief. |
| `C:\AtomEons\Orange5\02-APP\src-tauri\tauri.conf.json` | Current Tauri config. **Note `bundle.active: false` — this is what you flip.** |
| `C:\AtomEons\Orange5\02-APP\src-tauri\Cargo.toml` | Current Rust manifest. May have been edited by operator. |
| `C:\AtomEons\Orange5\02-APP\package.json` | Current npm manifest. May have been edited by operator. |

Read the latest receipt in `10-RECEIPTS/orange5-build/` to get the prior hash for chain continuation.

---

## 4. PRESERVE these operator-modified files — DO NOT REVERT

The operator made polish passes on these files between Claude's original write and now. **Honor that work.** Read them, understand what they do, then only modify the specific parts this brief tells you to touch.

| File | Why it matters |
|---|---|
| `02-APP/src/styles.css` | Full design system rewritten by operator (~745 lines, OLED palette, brand-mark glow, lane-link transitions, pulse animation, segmented controls). DO NOT replace. ONLY append/modify specific selectors if explicitly needed. |
| `02-APP/src/lanes/Chat.tsx` | Modified by operator. Read current; preserve behavior. |
| `02-APP/src/lanes/Cockpit.tsx` | Modified. |
| `02-APP/src/lanes/Vault.tsx` | Modified. |
| `02-APP/src/lanes/Settings.tsx` | Has localStorage + brain tier selector + native path bridges. Don't break. |
| `02-APP/src/components/LaneShell.tsx` | Polished — brand-mark, lane-summary, lane-hot dot, project pills, pulse. Don't revert. |
| `02-APP/src/lib/orangellm-client.ts` | Modified. Honor existing functions; add only what's missing. |
| `02-APP/src/lib/orange-native.ts` (if present) | New native-bridge wrapper added by operator. **READ IT — it's how the UI calls Tauri commands.** |
| `02-APP/src/lib/use-orange-snapshot.ts` (if present) | React hook for native snapshot. **READ IT — it polls a Tauri command.** |
| `02-APP/src-tauri/src/lib.rs` | Has Tauri commands `openOrangePath` and snapshot. Don't remove them. |
| `02-APP/vite.config.ts` | Modified. Read current. |
| `02-APP/src-tauri/Cargo.toml` | Modified. Read current. |

**Rule of thumb:** If a file exists and isn't in the list of files this brief explicitly tells you to modify, **read it but don't write it.**

---

## 5. The 8-step work sequence

Execute in order. Stop at any approval gate.

### Step 1.1 — Generate the icon set

The bundle needs icons. The operator's brand mark exists as SVG at `02-APP/public/orange5.svg`. You convert it to the icon formats Tauri requires.

**Action:**
- Confirm the source SVG exists at `02-APP/public/orange5.svg`. If missing, halt and ask.
- Use the Tauri CLI's built-in icon generator. From `02-APP/`:
  ```powershell
  npm run tauri icon ./public/orange5.svg
  ```
  This produces a full icon set under `02-APP/src-tauri/icons/`.
- If `tauri icon` fails because the source must be PNG, generate a high-res PNG first (1024×1024 recommended):
  - Use ImageMagick if installed: `magick public\orange5.svg -resize 1024x1024 src-tauri\icons\source.png`
  - Or use Node's `sharp` package — **DO NOT add sharp as a new dep.** Instead, ask the operator or generate the PNG manually.
- After generation, verify these files exist in `02-APP/src-tauri/icons/`:
  - `icon.png` (the master, 1024×1024)
  - `32x32.png`, `128x128.png`, `128x128@2x.png`
  - `icon.ico` (Windows)
  - `icon.icns` (macOS — for future, OK if missing)

**Pass:** `Get-ChildItem 02-APP/src-tauri/icons/` shows at least `icon.png`, `icon.ico`, `32x32.png`, `128x128.png`.

### Step 1.2 — Enable the bundle in `tauri.conf.json`

Open `02-APP/src-tauri/tauri.conf.json`. Find the `"bundle"` block. Change it to:

```json
"bundle": {
  "active": true,
  "targets": ["nsis"],
  "publisher": "AtomEons",
  "shortDescription": "AE Orange5 — Atomic Orange shell",
  "longDescription": "AE Orange5 Atomic Orange — the operator's local-first AI command surface.",
  "category": "DeveloperTool",
  "icon": [
    "icons/32x32.png",
    "icons/128x128.png",
    "icons/128x128@2x.png",
    "icons/icon.icns",
    "icons/icon.ico"
  ],
  "windows": {
    "nsis": {
      "installerIcon": "icons/icon.ico",
      "installMode": "currentUser"
    }
  }
}
```

**Rules:**
- Keep `productName`, `version`, `identifier` exactly as they already are.
- Do NOT add an `updater` block in this PR. Updater is Phase-2 separate work.
- If `targets` is already `["all"]`, leave it as `["nsis"]` for Windows-only build to avoid macOS/Linux toolchain demands.

### Step 1.3 — Verify Rust toolchain

From `02-APP/`:
```powershell
rustc --version
cargo --version
```

Both must print a version. If either is missing, halt and tell the operator: *"Rust toolchain missing. Install via https://rustup.rs/ then resume."*

### Step 1.4 — Verify npm deps are installed

From `02-APP/`:
```powershell
if (-not (Test-Path node_modules)) { npm install }
```

If `node_modules` exists, do NOT run `npm install` again.

### Step 1.5 — Run the Tauri build

From `02-APP/`:
```powershell
npm run tauri:build 2>&1 | Tee-Object -FilePath ../../10-RECEIPTS/orange5-build/_tmp_tauri_build.log
```

This may take 2–8 minutes (compile Rust, bundle React, build NSIS installer).

Expected output:
- `Compiling ...` lines from cargo
- `vite build` output (chunks created, dist folder written)
- `Bundling NSIS Installer ...`
- Final line: path to the installer artifact, e.g. `Finished 1 bundle at: ... atomic-orange-0.1.0_x64-setup.exe`

**Pass:**
- Exit code 0
- An `.exe` file exists under `02-APP/src-tauri/target/release/bundle/nsis/`

**If it fails:** Read the last 60 lines of `_tmp_tauri_build.log` carefully. Common failures:
- Missing Windows SDK → install Visual Studio Build Tools 2022
- Missing WiX (only for MSI; you're using NSIS so this shouldn't apply)
- Icon path mismatch → check `src-tauri/icons/` matches `tauri.conf.json`

**Approval gate:** If the build fails twice with the same root cause, **stop and report to the operator**. Do not loop.

### Step 1.6 — Install the bundle

From `02-APP/`:
```powershell
$installer = Get-ChildItem src-tauri\target\release\bundle\nsis\*.exe | Select-Object -First 1
if (-not $installer) { throw "no installer artifact produced" }
Get-FileHash $installer.FullName -Algorithm SHA256
```

Note the SHA-256 — it goes in the receipt.

**Run the installer** (current-user install, so it does NOT require admin):
```powershell
& $installer.FullName /S
```

The `/S` flag runs the NSIS installer silently. If silent install fails or is not supported, run it interactively and click through.

**Pass:**
- The installer completes without error.
- A new entry exists in Windows "Apps & features" matching `productName` from `tauri.conf.json`.
- The installed binary lives somewhere under `%LOCALAPPDATA%\Programs\` (or wherever Tauri configured).

### Step 1.7 — Launch + visual inspection

Find the installed exe (typical Tauri path):
```powershell
$exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "atomic-orange*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $exe) {
  $exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "*Orange*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
}
& $exe.FullName
```

A window should open within 3–5 seconds.

**Visual checks (operator-driven; if you have screenshot tooling, automate; otherwise prompt the operator to take these):**

1. **Window shows the Atomic Orange brand mark + 4 lanes in the vision rail.**
2. **Click Chat (Ctrl+1)** → empty placeholder visible.
3. **Click Cockpit (Ctrl+2)** → cards appear; `/healthz` poll begins; gateway version + Smart Skinny tier visible.
4. **Click Vault (Ctrl+3)** → search field visible.
5. **Click Settings (Ctrl+4)** → brain tier selector + custom rule textarea + Local Orange paths buttons all present.
6. **Type "say hi" in Chat → enter → response appears within 30 seconds.** (Smart Skinny is small but local; latency is fine.)

Save screenshots to:
```
10-RECEIPTS/orange5-build/screenshots/2026-06-2N-step-01-native-truth/
  01-chat-empty.png
  02-cockpit-live.png
  03-vault-search.png
  04-settings-controls.png
  05-chat-roundtrip-response.png
```

If you cannot capture screenshots yourself, list the exact paths the operator should save them to and proceed.

### Step 1.8 — Write the receipt

Create `10-RECEIPTS/orange5-build/2026-06-2N-step-01-native-truth-closed.md` (where `2026-06-2N` is today's date in YYYY-MM-DD).

Receipt template below in §10.

After writing, update `00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md` to mark **C10 fully closed** (was partially closed by operator; this PR closes it for product-truth, not just web-truth).

---

## 6. Hard NOs — do not do these things

- ❌ Do not add updater config to `tauri.conf.json` in this PR.
- ❌ Do not add a signing key / cert config in this PR.
- ❌ Do not modify any file under `06-ORANGELLM/`, `04-CONTROL-PLANE/`, `05-FLOW/`, `08-HERMES/`, `09-SCHEMAS/`, `12-ATOMSMASHER/`, `13-TOOLMESH/`, `07-VISUAL/`, `16-TRAINING/`.
- ❌ Do not `npm install` any new dependency.
- ❌ Do not `cargo add` any new Rust crate.
- ❌ Do not modify `package.json` scripts, only configs that this brief specifies.
- ❌ Do not restart, stop, or kill: gateway `:1337`, Smart Skinny `:8797`, command server `:8787`, Vite `:1420`, any Ollama process, any Docker container.
- ❌ Do not commit to git.
- ❌ Do not push to GitHub.
- ❌ Do not change git branches.
- ❌ Do not delete `02-APP/node_modules` to "fix" anything.
- ❌ Do not delete `02-APP/src-tauri/target` to "fix" anything (it can be cleaned but only with operator approval — long rebuild).
- ❌ Do not "improve" the chat UI by adding markdown rendering, RAG, agent mode, autocomplete, code editing, file browsing, or any other "useful" feature. Codeless Law.
- ❌ Do not change the OrangeLLM endpoint URL from `127.0.0.1:1337`.
- ❌ Do not bypass the boundary middleware in `06-ORANGELLM/server/boundary.mjs` from the client side (you can't read it, much less modify it — Scope Lock).
- ❌ Do not add telemetry, analytics, error reporting (Sentry, PostHog, etc.) without explicit operator approval.
- ❌ Do not add a login screen, account system, or any auth UI.
- ❌ Do not auto-update the app.

---

## 7. Hard YESes — these you must do

- ✅ Read all 6 pre-flight files before any write.
- ✅ Preserve every operator-modified file's behavior. If unsure, ASK before modifying.
- ✅ Generate the icon set from the existing `public/orange5.svg`.
- ✅ Flip `bundle.active` to `true` with the exact JSON block above.
- ✅ Build with `npm run tauri:build` once configs are right.
- ✅ Capture the SHA-256 hash of the produced installer.
- ✅ Install the installer on the N150.
- ✅ Launch the installed exe.
- ✅ Visually inspect all 4 lanes and the chat roundtrip.
- ✅ Save screenshots in the receipts subfolder.
- ✅ Write the close receipt with hash chain continuity (use the last receipt's id as `prior_receipt`).
- ✅ Update the Not-Green Ledger row C10 to fully closed.

---

## 8. Approval gates — STOP and ask the operator at these

| Gate | When to stop |
|---|---|
| **A** | If Rust toolchain is missing. |
| **B** | If `tauri icon` fails and you cannot generate icons from SVG without adding a new dep. |
| **C** | If `npm run tauri:build` fails twice with the same root error. |
| **D** | If the build succeeds but no installer artifact appears. |
| **E** | If the installer runs but fails to actually install. |
| **F** | If the launched app shows a blank/white screen or a webview error. |
| **G** | If the chat lane sends a message but no response comes back after 60 seconds. |
| **H** | If the Cockpit lane shows `gateway unreachable` despite gateway being known-live. |
| **I** | If you discover an operator-modified file would be reverted by your changes. |
| **J** | Anything not covered by this brief that requires a decision. |

When you stop, write a partial-progress receipt explaining what worked, what didn't, and what decision is blocking.

---

## 9. Rollback procedure (if something goes wrong)

```powershell
# 1. Uninstall the bundle if installed
$installed = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "*Orange*" -Directory -ErrorAction SilentlyContinue
if ($installed) {
  $uninst = Get-ChildItem $installed.FullName -Filter "uninstall*.exe" -Recurse | Select-Object -First 1
  if ($uninst) { & $uninst.FullName /S }
}

# 2. Clean the Tauri build outputs (optional, large)
Remove-Item -Recurse -Force "C:\AtomEons\Orange5\02-APP\src-tauri\target" -ErrorAction SilentlyContinue

# 3. Revert tauri.conf.json bundle change
# (manually edit back to "bundle": { "active": false, "publisher": "AtomEons" })

# 4. Remove generated icons if you want a clean slate
Remove-Item -Recurse -Force "C:\AtomEons\Orange5\02-APP\src-tauri\icons\*.png" -ErrorAction SilentlyContinue
Remove-Item -Force "C:\AtomEons\Orange5\02-APP\src-tauri\icons\icon.ico" -ErrorAction SilentlyContinue

# 5. Write a rollback receipt at 10-RECEIPTS/orange5-build/
```

Nothing in `06-ORANGELLM/`, `04-CONTROL-PLANE/`, etc. is touched by your work, so they don't need rollback.

---

## 10. Receipt template

Write this file at `10-RECEIPTS/orange5-build/2026-06-2N-step-01-native-truth-closed.md`:

```markdown
# Receipt — Step 1 Native Truth CLOSED

**Receipt ID:** `2026-06-2N-step-01-native-truth-closed`
**Hash chain:** #<next number after last receipt>
**Prior receipt:** `<id of last receipt from 10-RECEIPTS/orange5-build/>`
**Status:** `STEP_01_NATIVE_TRUTH_GREEN`
**Confidence:** 1.0 (full install + launch + roundtrip proven)
**Actor:** Codex
**Sovereign:** Atom McCree

## What happened

- Generated full icon set from `02-APP/public/orange5.svg` into `02-APP/src-tauri/icons/`
- Flipped `bundle.active: true` in `02-APP/src-tauri/tauri.conf.json` with NSIS Windows target
- `npm run tauri:build` succeeded; produced installer at `<exact path>`
- Installer SHA-256: `<hex>`
- Installer installed cleanly via `/S` silent mode
- Launched installed binary at `<exact %LOCALAPPDATA% path>`
- Verified all 4 lanes render (screenshots attached)
- Verified chat roundtrip: typed "say hi" → got real response from OrangeLLM at `:1337` → response model `orangellm-smart-skinny-0.5b`
- C10 in Not-Green Ledger marked fully closed

## Evidence

| Artifact | Path |
|---|---|
| Installer | `<path>` |
| Installer SHA-256 | `<hex>` |
| Installed exe | `<%LOCALAPPDATA% path>` |
| Chat screenshot | `10-RECEIPTS/orange5-build/screenshots/2026-06-2N-step-01-native-truth/01-chat-empty.png` |
| Cockpit screenshot | `02-cockpit-live.png` |
| Vault screenshot | `03-vault-search.png` |
| Settings screenshot | `04-settings-controls.png` |
| Roundtrip screenshot | `05-chat-roundtrip-response.png` |
| Build log | `_tmp_tauri_build.log` (delete after receipt closes) |

## System integrity check

| Service | Pre-action | Post-action |
|---|---|---|
| Gateway :1337 | up | up (unchanged) |
| Smart Skinny :8797 | up (Ollama qwen3:0.6b) | up (unchanged) |
| Command server :8787 | up | up (unchanged) |
| Vite dev :1420 | up or down | unchanged |
| Atomic Orange installed | NOT present | PRESENT — installed via NSIS |

No service was killed, restarted, or had its config changed.

## Pass checklist

- [ ] Rust toolchain verified
- [ ] Icon set generated (≥4 files in `src-tauri/icons/`)
- [ ] `tauri.conf.json` bundle.active = true with NSIS target
- [ ] `npm run tauri:build` exited 0
- [ ] Installer .exe artifact produced
- [ ] Installer SHA-256 captured
- [ ] Installer installed without error
- [ ] Installed exe launches without webview error
- [ ] Chat lane renders + accepts input
- [ ] Cockpit lane polls /healthz successfully
- [ ] Vault lane renders search field
- [ ] Settings lane shows all 6 panels
- [ ] Chat roundtrip returns real response from OrangeLLM
- [ ] 5 screenshots saved
- [ ] Receipt SHA-256 written + hash-chained to prior receipt
- [ ] Not-Green Ledger C10 marked fully closed

## Next action

**Step 2 — Codexa rail token wiring.** Operator action: set `ORANGEBOX_RAIL_TOKEN` env var. Then heavy lane probe returns 200 instead of 401.

## Rollback

See `00-CHARTER/CODEX_BRIEF_STEP_01_NATIVE_TRUTH.md` §9.

## Hash chain

#<n>. Prior: `<prior receipt id>`.

---

**Mom is watching. Step 1 closed green. Atomic Orange is now a real installable app.**
```

---

## 11. Command cheat sheet (paste-ready)

```powershell
# Pre-flight
cd C:\AtomEons\Orange5\02-APP
rustc --version
cargo --version

# Icons (run only if icons don't already exist)
if (-not (Test-Path src-tauri\icons\icon.ico)) {
  npm run tauri icon ./public/orange5.svg
}

# Verify deps
if (-not (Test-Path node_modules)) { npm install }

# Build
npm run tauri:build 2>&1 | Tee-Object -FilePath ..\10-RECEIPTS\orange5-build\_tmp_tauri_build.log

# Find installer + hash
$installer = Get-ChildItem src-tauri\target\release\bundle\nsis\*.exe | Select-Object -First 1
$installer.FullName
Get-FileHash $installer.FullName -Algorithm SHA256

# Install silently (current user, no admin)
& $installer.FullName /S

# Find installed exe
$exe = Get-ChildItem "$env:LOCALAPPDATA\Programs" -Recurse -Filter "*orange*.exe" -ErrorAction SilentlyContinue | Select-Object -First 1
$exe.FullName

# Launch
& $exe.FullName

# Verify gateway is up (it should be already)
Invoke-WebRequest -Uri http://127.0.0.1:1337/healthz -UseBasicParsing | Select-Object -ExpandProperty Content
```

---

## 12. Failure mode reference

| Symptom | Probable cause | Fix |
|---|---|---|
| `rustc not found` | Rust toolchain missing | Halt. Operator installs via https://rustup.rs/ |
| `error: linking with cc failed` | Missing Windows Build Tools | Halt. Operator installs Visual Studio Build Tools 2022 + Windows 10/11 SDK |
| `tauri icon` errors with "no such file" | Source SVG missing | Halt. Verify `02-APP/public/orange5.svg` exists |
| `Bundle failed: ...` from NSIS | NSIS not installed OR icon path wrong | Tauri 2 bundles NSIS itself; check `src-tauri/icons/` paths match `tauri.conf.json` |
| Installer runs but app doesn't appear | Webview2 missing | Operator installs Microsoft Edge WebView2 Runtime |
| App launches but blank window | Vite build didn't produce `dist/` | Check `npm run build` succeeded before `tauri:build` |
| Chat sends but no response | Gateway down OR Smart Skinny down | Check `Invoke-WebRequest http://127.0.0.1:1337/healthz`. If 200, check Smart Skinny via the gateway's own probe. Do NOT bypass the gateway. |
| Cockpit shows "gateway unreachable" but gateway is up | CORS or fetch error | Check browser console in installed app (Tauri exposes devtools in dev builds; release builds may not). Verify `orangellm-client.ts` points at `127.0.0.1:1337`. |
| App installs but can't be uninstalled | NSIS uninstaller missing | Re-run installer with /S or use Apps & Features |

---

## 13. Escalation

If any of these happen, **stop and tell the operator immediately**:

- Any service unexpectedly stops (gateway, Smart Skinny, command server, Ollama, Docker)
- Any file outside `02-APP/` and `10-RECEIPTS/orange5-build/` would need to be modified to complete this work
- Any new npm or cargo dep would need to be added
- The installer requires admin rights or destabilizes Windows
- The build takes longer than 15 minutes
- You discover an issue that contradicts something in `00-CHARTER/ORANGE5_MASTER_PLAN.md`

---

## 14. What you do NOT need to do (this PR)

Save these for future PRs — do not creep:

- ❌ Code-sign the installer (Authenticode cert). Phase 2 work.
- ❌ Wire up the Tauri updater (auto-update). Phase 2.
- ❌ Build macOS/Linux variants. Phase 2.
- ❌ Add the AESee living dashboard visuals (Bioluminescent DAG, Trinity, Whisper). HELD project.
- ❌ Wire heavy lane (Codexa qwen3:30b). Step 6 work.
- ❌ Wire visual lane (GLM-4.6V). Step 6.
- ❌ Integrate Æ Cobra memory daemon. Step 3 — separate brief.
- ❌ Implement the Mirage StateBrief API. Step 4.
- ❌ Implement Graph Weaver. Step 5.
- ❌ Train any model.
- ❌ Promote any STUB AtomSmasher module.

---

## 15. Mom's Law affirmation

When this PR closes, you must be able to say all of the following honestly to the operator:

- "The installer exists and I verified its SHA-256."
- "I installed it on this machine and the install path is `X`."
- "I launched it and watched the window open."
- "I clicked all 4 lanes and they rendered."
- "I sent a chat message and got a real OrangeLLM response — I have a screenshot."
- "No running service was touched, restarted, or killed."
- "No file outside `02-APP/` and `10-RECEIPTS/orange5-build/` was modified."
- "I did not add any new dependency."
- "I wrote a receipt that hash-chains to the previous receipt."
- "I marked C10 in the Not-Green Ledger fully closed."

If any of those statements would be a lie, **do not close the receipt as GREEN.** Write a partial-progress receipt instead and ask the operator how to proceed.

---

**Mom is watching every output. Build the spine, then give the serpent fangs. Receipts decide what is real.**
