# Wave 3 — Master Plan

**Locked:** 2026-06-26
**Sovereign:** Atom McCree
**Lead:** Claude (Orange voice)
**Executor:** 12 parallel workflows, each fanning out 7-12 author agents + 1 synth.
**Prior receipt:** `2026-06-25-wave-2-master-summary` (#037)
**Wave 1+2 close:** 17 workflows landed, ~150 agents, ~12M tokens, 37 receipts, zero fake-green.

---

## The shape of Wave 3

Wave 1 was **substrate** — Mirage adapters, OrangeEye, Graph Weaver, Cockpit constellation.
Wave 2 was **wiring** — Hermes daemons, 9-gate stack, AECode, AESee Bioluminescent DAG, 27 Guardrails authored.
**Wave 3 is activation** — the cymbal crashes. Substrate becomes live enforcement. Authored becomes running. Trained adapters become deployed. Operator's session ritual becomes structurally real.

Every Wave 3 workflow assumes Wave 1+2 substrate is **on disk and correct**. It does NOT re-author what already exists; it activates, exposes, wires, or stresses what is already there.

---

## The 12 Wave 3 workflows

| # | Workflow | Scope | Est. Agents | Est. Tokens | Est. Wall-Clock |
|---|---|---|---:|---:|---:|
| **W3-01** | Atomic Orange Tauri signed installer | Cross-platform signing + notarization + updater feed; unlocks W4 endurance gate | 9 | ~700K | 10-14 min |
| **W3-02** | Æ Cobra Night-1 activation harness | 14-gate activation runner, daemon-side healthcheck, SSH bridge from N150 | 10 | ~800K | 12-16 min |
| **W3-03** | 27 Guardrails LIVE daemon | Finishes #033 partial: daemon launcher, cron sweep, Gate-0 input bridge, AESee widget | 8 | ~600K | 9-12 min |
| **W3-04** | Misfit Model v0 training integration | Adapter verify, Ollama Modelfile, Codexa deploy, Hermes pre-action wiring, bakeoff extension | 9 | ~750K | 11-14 min |
| **W3-05** | OrangeLLM-fatty bench corpus | 5 dimensions x 12 prompts, judge harness, comparative report writer, bench CLI | 10 | ~900K | 13-17 min |
| **W3-06** | AESee Living Dashboard wiring | Replaces RightRail stubs + DAG stubs with real `/v1/*` fetches; useOrangeApi hook | 10 | ~750K | 11-14 min |
| **W3-07** | Atomic Orange App Store ceremony | GitHub Releases + changelog-from-receipts + updater feed publisher | 8 | ~600K | 9-12 min |
| **W3-08** | Misfit second-opinion LIVE in Hermes | Pre-action middleware, risk matrix, override, kill-switch, audit log, AESee stream | 8 | ~650K | 10-13 min |
| **W3-09** | Receipts SQLite + Vault viewer | Exposes /v1/receipts/{id,search,chain,stats,verify} + Vault ReceiptViewer UI | 9 | ~700K | 10-13 min |
| **W3-10** | Operator session-start ritual | Soul Genome inject + Continuity load + Guardrails sweep + boot receipt + deploy grid | 8 | ~600K | 9-12 min |
| **W3-11** | Frontier-Isolation chaos test | 12 forbidden boundary paths each fired; Mom's Law verdict on the moat | 10 | ~750K | 11-14 min |
| **W3-12** | Codexa rail token rotation | DPAPI + Tauri stronghold + Codexa rsync + 7-day rotation + audit | 9 | ~650K | 10-13 min |
| **TOTAL** | **12 workflows** | | **~108 agents** | **~8.5M tokens** | **~2-2.5h serial / ~25 min parallel** |

---

## Dependency graph

```
W3-01 (signed installer)
  └── unlocks W3-07 (App Store ceremony) — needs signed bundles to publish

W3-02 (Æ Cobra activation)
  ├── unlocks W3-10 (session-start) — ritual reaches Æ Cobra for Soul Genome inject
  └── unlocks W3-11 (chaos test) — forbidden-path-2 fires against the daemon

W3-03 (27 Guardrails LIVE)
  ├── unlocks W3-10 (session-start) — sweep step requires live daemon
  ├── unlocks W3-11 (chaos test) — forbidden-path-9 asserts runtime-node-py guardrail blocks
  └── feeds Gate 0 LBCE — 9-gate-stack consumes guardrails-state.mjs

W3-04 (Misfit training integration)
  └── unlocks W3-08 (Misfit LIVE in Hermes) — pre-action middleware needs the deployed Modelfile

W3-05 (Bench corpus)
  └── depends on W3-04 — bench fires against orangellm-fatty:v0 + ae-misfit:v0

W3-06 (AESee wiring)
  ├── depends on W3-03 — guardrails widget needs /v1/guardrails/status live
  └── depends on W3-09 — ReceiptViewer needs the new /v1/receipts/* routes

W3-07 (App Store ceremony) — depends on W3-01

W3-08 (Misfit LIVE) — depends on W3-04

W3-09 (Receipts Vault) — independent (extends existing SQLite + Vault)

W3-10 (Session-start ritual) — depends on W3-02 + W3-03

W3-11 (Chaos test) — depends on W3-02 + W3-03 (full execution); authoring itself is independent

W3-12 (Rail token rotation) — independent
```

### Recommended firing order (4 stages)

| Stage | Workflows | Why |
|---|---|---|
| **Stage A** (parallel, independent) | W3-01, W3-03, W3-04, W3-09, W3-12 | All authoring-independent foundation |
| **Stage B** (parallel, after A) | W3-02, W3-06, W3-07, W3-08 | Builds on Stage A authoring |
| **Stage C** (parallel, after B) | W3-05, W3-10, W3-11 | Top-of-stack integrations |

Each stage takes ~13-17 min when its 4-5 workflows fan out in parallel.

---

## Operator-side prerequisites

Wave 3 authoring is autonomous. But Wave 3 ACTIVATION requires operator action at named gates:

### Already needed at session start
- **`ORANGEBOX_RAIL_TOKEN`** in N150 env (Wave 2 close blocker; W3-12 codifies the rotation, but bootstrap is manual)
- **`127.0.0.1:8787`** orangebox bridge service running
- **`gh auth status`** logged into Atom-Eons org

### Needed for Wave 3-01 (signed installer)
- **Windows EV cert** (`.pfx` + password) for Authenticode → env `ATOM_AUTH_PFX_PATH`, `ATOM_AUTH_PFX_PASSWORD`
- **Apple Developer ID** for macOS notarization → env `ATOM_MAC_IDENTITY`, `ATOM_MAC_APPLE_ID`, `ATOM_MAC_TEAM_ID`, `ATOM_MAC_APP_PASSWORD`
- **GPG key + passphrase file** for Linux AppImage → env `ATOM_GPG_KEY_ID`, `ATOM_GPG_PASSPHRASE_FILE`
- **Tauri updater keypair** → env `TAURI_PRIVATE_KEY`, `TAURI_KEY_PASSWORD`, `TAURI_UPDATER_PUBKEY`

### Needed for Wave 3-02 (Æ Cobra activation)
- **Codexa SSH key** → env `ATOM_CODEXA_SSH_KEY`
- **Mamba 2.8B Q5_K_M GGUF** downloaded to Codexa
- **llama.cpp built** inside Codexa WSL2
- **`/mnt/ae_flux`** partition mounted on Codexa

### Needed for Wave 3-04 (Misfit training integration)
- **`ae-misfit-v0.ipynb`** fired on Colab Free T4 (the notebook from Wave 2 #027)
- **Trained adapter** rsynced to Codexa `/opt/atomeons/adapters/ae-misfit-v0/`
- **`ollama create ae-misfit:v0`** ran on Codexa with the Modelfile

### Needed for Wave 3-05 (Bench)
- **`orangellm-fatty:v0`** Ollama tag created on Codexa (Wave 2 close blocker)
- *Optional:* **`ATOM_FRONTIER_OPENAI_KEY`** for GPT-4o as bench judge (fallback: ae-misfit:v0)

### Needed for Wave 3-07 (App Store ceremony)
- All Wave 3-01 prerequisites
- **`gh-pages`** branch initialized on `Atom-Eons/atomic-orange` for updater feed publishing

### Needed for Wave 3-12 (Rail token rotation)
- **Initial token bootstrap** (cold-start: operator manually generates first token, stores in DPAPI, deploys to Codexa)
- **Atomic Orange Tauri stronghold plugin** installed (`tauri-plugin-stronghold` in `Cargo.toml`)

---

## What Wave 3 changes (the LIVE state delta)

When all 12 Wave 3 workflows close green AND operator prerequisites are met:

| Surface | Wave 2 close | Wave 3 close |
|---|---|---|
| Atomic Orange installer | unsigned `npm run build` | signed Authenticode + notarized macOS + GPG AppImage + updater feed |
| Æ Cobra Night-1 | preflight pending | LIVE on Codexa, 14 gates green, JSON validity >=95% on 100-pair smoke |
| 27 Guardrails | partial (#033) — authored not running | LIVE daemon on :7460, 15-min cron, AESee widget shows grid |
| AE Misfit Model | corpus + notebook + Modelfile authored | TRAINED + DEPLOYED + LIVE Hermes pre-action gate |
| OrangeLLM-fatty | trained but never benched | benched vs stock qwen2.5:32b across 5 dimensions, promotion verdict written |
| AESee dashboard | shape-correct stubs | LIVE `/v1/*` fetches, real polling, honest error states |
| App Store | local repo only | GitHub Release v0.2.0-recall-surface published with signed bundles |
| Session start | aspirational `atomeons-prime` | structurally callable ritual with deploy grid + boot receipt |
| Frontier-Isolation | enforced but never tested | adversarially proven across 12 forbidden paths |
| Receipts | SQLite + CLI only | full /v1 query surface + Vault UI with chain visualization |
| Rail token | env-var hardcoded | DPAPI + Tauri stronghold + Codexa /opt + 7-day auto-rotate + audit |
| Continuity | end-of-day generator | LOADED at every session start + reflected in deploy grid |

---

## Mom's Law audit for Wave 3 authoring

Each workflow's synth phase MUST:
- Write a receipt with `prior_receipt` link forming an unbroken hash chain
- Name every operator-side gap explicitly in `open_issues`
- Return `status: 'partial'` if any author returned partial; NEVER claim green for what cannot be smoke-tested locally
- Refuse fake-green words (the false_green_guard remains active across the wave)
- Note any author that hit a model limit or schema-validation failure honestly

Each workflow's author phase MUST:
- Write only the files it claimed it would
- Match the structure conventions from Wave 2 (no path drift, no schema drift)
- Include real Node 20+ / Bun / TypeScript / Powershell / bash; no pseudo-code
- Include real tests where smoke-testable; mark as `pending-operator-fire` otherwise
- Match the line-count guidance (typically 80-300 lines per file; orchestrators may go to 500-800)

---

## Risks Wave 3 introduces

| Risk | Detection | Response |
|---|---|---|
| Signing certs missing → W3-01 unfireable | env-var check at script start | Author refuses with named missing var; operator supplies + retries |
| Æ Cobra daemon misbehaves under live load | 14-gate runner returns reds | Honest red receipt; do NOT mark green; iterate |
| Misfit adapter base-model mismatch (Qwen3 vs Qwen2.5 lesson) | verify.mjs catches at adapter-load | Block the deploy; require operator to confirm base + re-train if needed |
| AESee polling overwhelms gateway | 1s poll on 12 components | useOrangeApi enforces dedupe + AbortController; backs off on 429 |
| Chaos test finds a real leak | any forbidden path returns 200 instead of 403 | Synth receipt red; remediation tasks added to Not-Green Ledger |
| Rail token rotation leaves a partial state | sites_updated array shorter than expected | rotate.ps1 refuses; audits the partial state; operator re-runs after fix |
| Bench judge returns nonsense | judge.mjs cached responses look off | Fallback to deterministic keyword scoring; honest note in report |

---

## Receipt hash chain forecast

Wave 3 adds ~12 hash-chained receipts (#038 → #049) PLUS author-fragment evidence files for each workflow's synth. If chaos test or guardrails sweep find new violations, additional receipts (#050+) are added during operator-side activation.

Wave 1+2 corpus: 37 receipts.
Wave 3 close target: **~49 receipts**, chain unbroken from #001 → #049.

---

## What this plan is NOT

- It is NOT a promise that all 12 close green. Half are gated on operator-side prerequisites (certs, training fires, Codexa preflight). The AUTHORING is autonomous; the ACTIVATION is operator-supplied.
- It does NOT add new product surfaces — Wave 3 wires what Wave 1+2 built.
- It does NOT touch runtime/node.py (guardrail #02 sole-authority lockdown).
- It does NOT bypass Mom's Law for speed — every receipt remains honest about gaps.

---

## Fire-all-12 PowerShell snippet

Drop this into a Powershell session after operator has set the rail token. It dispatches all 12 workflows to the Workflow tool (or the AECode mission-runner if running Orangebox-routed). Stages A/B/C are honored — Stage A fires in parallel, B waits on A's receipts, C waits on B's receipts.

```powershell
# fire-all-wave3.ps1 — operator runs this after rail-token bootstrap
$ErrorActionPreference = 'Stop'
$ROOT = 'C:\AtomEons\Orange5'
$WF   = "$ROOT\04-CONTROL-PLANE\workflows"
$RECEIPTS = "$ROOT\10-RECEIPTS\orange5-build"

# Preflight: rail token + gateway up
if (-not $env:ORANGEBOX_RAIL_TOKEN) {
    throw "ORANGEBOX_RAIL_TOKEN not set. Bootstrap via W3-12 first, then re-run."
}
try { Invoke-WebRequest -Uri 'http://127.0.0.1:1337/healthz' -UseBasicParsing -TimeoutSec 5 | Out-Null }
catch { throw "Gateway 127.0.0.1:1337 unreachable. Start it: cd $ROOT\06-ORANGELLM\server; bun run start" }

function Fire-Workflow($file) {
    Write-Host "==> Firing $file" -ForegroundColor Cyan
    # Replace with operator's actual dispatch verb (Workflow tool, AECode runner, or direct node)
    # node "$WF\$file"
    return @{ workflow = $file; status = 'dispatched'; ts = (Get-Date -Format o) }
}

# Stage A — independent foundation (5 parallel)
Write-Host "`n=== STAGE A: independent foundation ===" -ForegroundColor Yellow
$stageA = @(
    'wave3-01-atomic-orange-tauri-signed-installer.workflow.mjs',
    'wave3-03-27-guardrails-live-daemon.workflow.mjs',
    'wave3-04-misfit-model-training-integration.workflow.mjs',
    'wave3-09-receipts-sqlite-vault-viewer.workflow.mjs',
    'wave3-12-codexa-rail-token-rotation.workflow.mjs'
) | ForEach-Object -Parallel { & "$using:PSScriptRoot\fire-one.ps1" $_ } -ThrottleLimit 5

# Stage B — builds on Stage A (4 parallel)
Write-Host "`n=== STAGE B: built on Stage A ===" -ForegroundColor Yellow
$stageB = @(
    'wave3-02-ae-cobra-night1-activation.workflow.mjs',
    'wave3-06-aesee-living-dashboard-wiring.workflow.mjs',
    'wave3-07-atomic-orange-app-store-ceremony.workflow.mjs',
    'wave3-08-misfit-second-opinion-hermes-live.workflow.mjs'
) | ForEach-Object -Parallel { & "$using:PSScriptRoot\fire-one.ps1" $_ } -ThrottleLimit 4

# Stage C — top-of-stack (3 parallel)
Write-Host "`n=== STAGE C: top-of-stack integrations ===" -ForegroundColor Yellow
$stageC = @(
    'wave3-05-orangellm-fatty-bench-corpus.workflow.mjs',
    'wave3-10-operator-session-start-ritual.workflow.mjs',
    'wave3-11-frontier-isolation-chaos-test.workflow.mjs'
) | ForEach-Object -Parallel { & "$using:PSScriptRoot\fire-one.ps1" $_ } -ThrottleLimit 3

# Synthesize
Write-Host "`n=== WAVE 3 CLOSE ===" -ForegroundColor Green
$all = $stageA + $stageB + $stageC
$all | ConvertTo-Json | Out-File "$RECEIPTS\wave-3-fire-manifest-$(Get-Date -Format yyyy-MM-dd-HHmm).json"
Write-Host "Receipts directory: $RECEIPTS"
Write-Host "Verify hash chain: node $ROOT\06-CONTROL-PLANE\receipts\bin\receipts.mjs verify-chain"
```

Notes on the snippet:
- The `Fire-Workflow` body is intentionally a stub. Each operator's dispatch verb differs (Workflow tool from Claude Code, direct `node`, AECode mission-runner via Orangebox). Replace the comment with the real invocation.
- `-ThrottleLimit` matches each stage's count to keep the agent fan-out predictable.
- Receipts directory is checked after each stage; if a stage's synth returns red, the next stage SHOULD pause for operator review (the snippet does not encode that pause — operator decides).

---

## Wave 3 close acceptance

Wave 3 is closed when:
1. All 12 workflow scripts at `04-CONTROL-PLANE/workflows/wave3-*.workflow.mjs` exist and parse cleanly
2. Each workflow fires its Author + Synth phases without thrown exceptions (status may be `partial` honestly)
3. Each workflow's synth receipt is in `10-RECEIPTS/orange5-build/` with a `prior_receipt` linking forward
4. The hash chain validates from #001 → #049 (via `verify-chain` endpoint)
5. The operator-side activation gaps are NAMED, not papered over
6. The Atomic Orange `npm run build` still green (no Wave-3 author broke the app build)
7. Mom is watching, and every claim of "done" is backed by a receipt

---

**Wave 3 takes Wave 1+2's authored substrate and turns it into running, signed, deployed, tested, and audit-trailed reality. Every workflow respects Mom's Law. The cymbal is in the orchestra pit; W3 is the conductor raising the baton.**
