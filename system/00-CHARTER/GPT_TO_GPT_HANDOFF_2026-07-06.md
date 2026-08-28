# Orange5 GPT-to-GPT Handoff — 2026-07-06

This document summarizes the last active Orange5 work session for the next model/operator. It is written to reduce repeated context burn.

## Current Product Truth

- Product: **Orange**
- Active release/version: **OrangeFive / Orange5**
- Active root: `C:\AtomEons\Orange5`
- Orange3/Orange4 are not active product identities.
- Orange3 is archived backend lineage.
- Orange4 is theory/features/script namespace only.
- Current work is **Orange5 operationalization**, not commerce.
- Rule: operational means live, callable, and receipt-backed. No conceptual/scaffold/inactive feature may count as operational.

## Hard Operator Preferences

- Use reduced words when limits are tight.
- No fake green.
- No release/timer obsession when the user asks for operational functionality.
- OBS is protected while streaming. Do not kill OBS.
- Hidden services only. Visible PowerShell popup loops are a defect.
- AE Eyes must actually see, not merely have tests.
- Orange5 operationals must be real: not conceptual, not scaffold, not inactive.

## New / Edited Files This Session

### Added

- `C:\AtomEons\Orange5\00-CHARTER\ORANGE5_OPERATIONAL_LAW.md`
  - Defines what counts as operational.
  - Explicitly bans concepts/scaffolds/mock-only/future integrations from the operational bucket.
  - Defines allowed statuses:
    - `OPERATIONAL`
    - `DEGRADED_OPERATIONAL`
    - `PACKAGED_UPGRADE`
    - `RESEARCH_ARCHIVE`
    - `REMOVED_FROM_SCOPE`
    - `BLOCKED_NEEDS_OPERATOR_OR_HOST`
  - States AE Eyes is operational only when the visual chain can actually accept visual input and return structured output.

- `C:\AtomEons\Orange5\00-CHARTER\services\orange5-ae-eyes-bringup.ps1`
  - Hidden service bringup script.
  - Starts/checks:
    - Orange5 gateway `1337`
    - Hermes MCP `7430`
    - Smart Skinny `8797`
    - Codexa Ollama proxy `11435`
    - AE Eyes ColPali `7440`
    - AE Cobra `7419`
    - Qdrant `6333`
    - local Ollama `11434`
  - Registers hidden scheduled task:
    - `Orange5-AE-Eyes-Services`
  - Runs AE Eyes backend/facade tests.
  - Writes receipt:
    - `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\ae-eyes-services-*.json`

- `C:\AtomEons\Orange5\00-CHARTER\services\orange5-operational-audit.ps1`
  - Audits live operational inventory.
  - Writes receipt:
    - `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\orange5-operational-audit-*.json`

- `C:\AtomEons\Orange5\00-CHARTER\GPT_TO_GPT_HANDOFF_2026-07-06.md`
  - This handoff file.

### Edited

- `C:\AtomEons\Orange5\12-ATOMSMASHER\dist\codexa-install\install-windows.ps1`
  - Fixed stale tarball name.
  - Was looking for:
    - `atomsmasher2-2026-06-27.tar.gz`
  - Corrected to:
    - `atomsmasher2-v1.0.1-2026-07-03.tar.gz`

- `C:\AtomEons\Orange5\07-VISUAL\smoke-test.mjs`
  - Partially edited before turn interruption.
  - Added:
    - `const CORTEX_MODEL = process.env.ORANGE5_CORTEX_MODEL || process.env.OLLAMA_VISION_MODEL || "glm-4.6v";`
  - Remaining needed patch:
    - Replace hardcoded `glm-4.6v` checks with `CORTEX_MODEL`.
    - The patch was started but interrupted.

## Proven Receipts / Logs

### Orange5 Prior Green State From Earlier In Same Work Window

- Full verifier:
  - `bun run verify`
  - Result: `85 green / 0 red`

- Hermes MCP smoke:
  - `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\hermes-mcp-smoke-20260704T234447.log`
  - Result: `9/9 pass`

- Hermes/MCP closure receipt:
  - `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\orange5-hermes-mcp-full-green-20260705T054512Z.json`

### AE Eyes Bringup Receipt

- Latest green receipt:
  - `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\ae-eyes-services-20260705T235404Z.json`

Result:

```text
verdict: AE_EYES_SERVICE_CHAIN_GREEN
```

Live services in that receipt:

```text
orange5-gateway              1337   open
orange5-hermes               7430   open
orange5-smart-skinny         8797   open
orange5-codexa-ollama-proxy  11435  open
ae-eyes-colpali              7440   open
ae-cobra                     7419   open
qdrant                       6333   open
ollama-local                 11434  open
```

Tests in that receipt:

```text
07-VISUAL/tests/ae-eyes-backend.test.mjs   exitCode 0
07-VISUAL/tests/visual-facade.test.mjs     exitCode 0
```

Hidden scheduled task:

```text
Orange5-AE-Eyes-Services: registered
```

### Operational Audit Receipt

- Latest all-operational receipt:
  - `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\orange5-operational-audit-20260705T235733Z.json`

Result:

```text
verdict: ORANGE5_ALL_OPERATIONAL
counts:
  OPERATIONAL: 9
  DEGRADED_OPERATIONAL: 0
  PACKAGED_UPGRADE: 0
  RESEARCH_ARCHIVE: 0
  REMOVED_FROM_SCOPE: 0
  BLOCKED_NEEDS_OPERATOR_OR_HOST: 0
```

Operational features in that receipt:

```text
orange5_gateway
hermes_mcp
smart_skinny_reflex
codexa_ollama_proxy
ae_eyes_colpali
ae_cobra
qdrant_visual_memory
local_ollama
atomsmasher2
```

## Services Started / Fixed

### Already Running / Confirmed

- Orange5 Brain Gateway:
  - Port `1337`
  - Entrypoint:
    - `C:\AtomEons\Orange5\06-ORANGELLM\server\index.mjs`

- Hermes MCP:
  - Port `7430`
  - Entrypoint:
    - `C:\AtomEons\Orange5\08-HERMES\src\server.mjs`

- Smart Skinny:
  - Port `8797`
  - Entrypoint:
    - `C:\AtomEons\Orange5\06-ORANGELLM\server\smart-skinny-adapter.mjs`

- Codexa Ollama proxy:
  - Port `11435`
  - Entrypoint:
    - `C:\AtomEons\Orange5\docker\n150-runtime\codexa-ollama-host-proxy.mjs`

- local Ollama:
  - Port `11434`

### Brought Up / Repaired

- AE Eyes ColPali:
  - Port `7440`
  - Entrypoint:
    - `C:\AtomEons\Orange5\07-VISUAL\colpali-service\server.mjs`
  - Status:
    - Live in latest AE Eyes receipt.

- AE Cobra:
  - Port `7419`
  - Real entrypoint found:
    - `C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra\flow-direct\server.mjs`
  - Initial script had wrong candidate path.
  - Patched bringup script to use this entrypoint.
  - Status:
    - Live in latest AE Eyes receipt.

- Qdrant:
  - Port `6333`
  - Docker image existed:
    - `qdrant/qdrant:latest`
  - Container existed but was not running:
    - `orange5-qdrant`
  - Started with:
    - `docker start orange5-qdrant`
  - Status:
    - Live in latest audit receipt.

- AtomSmasher2:
  - Port `8901`
  - Initial daemon start from `dist/codexa-install/start-daemon.mjs` failed because dependency files were not in that folder.
  - Fixed Windows installer tarball name.
  - Installed to:
    - `C:\Users\a\OrangeBox-Data\atomsmasher2-final-local`
  - Entrypoint:
    - `C:\Users\a\OrangeBox-Data\atomsmasher2-final-local\start-daemon.mjs`
  - Status:
    - Live in latest operational audit receipt.

## Model / Vision Work

### Confirmed Model State

Local Ollama `11434` initially had:

```text
qwen3:0.6b
```

Codexa proxy `11435` had many heavy models including:

```text
deepseek-r1:70b
command-r:35b
llama3.3:70b
dolphin3:8b
qwen2.5-coder:32b
qwen3:30b-a3b
deepseek-r1:32b
mistral-small:24b
qwen3:14b
qwen3:4b
llama3.1:8b-abliterated
ae-orangebox-local:latest
qwen2.5-coder:7b
```

`glm-4.6v` was not present locally or through Codexa proxy.

Attempted:

```text
ollama pull glm-4.6v
```

Result:

```text
Error: pull model manifest: file does not exist
```

Installed instead:

```text
ollama pull llava:7b
```

Result:

```text
success
```

Reason:

- AE Eyes smoke requires a local vision model.
- `glm-4.6v` is not currently an Ollama tag on this system.
- `llava:7b` is a working local Ollama vision model and can be used as current local visual model until a better GLM/OpenAI-compatible vision lane is wired.

## AE Eyes Smoke Status

Command run:

```powershell
bun C:\AtomEons\Orange5\07-VISUAL\smoke-test.mjs
```

Result before `llava:7b` install:

```text
FAIL step-1 preflight:
ok Qdrant :6333
ok ColPali :7440
down Ollama :11434 + glm-4.6v
ok AE Cobra :7419

Reason:
glm-4.6v missing; have: qwen3:0.6b
```

After this:

- `llava:7b` was installed successfully.
- Smoke test still needs code/config completion because it is hardcoded to require `glm-4.6v`.
- Partial patch added `CORTEX_MODEL` variable.
- Remaining patch must replace all hardcoded `glm-4.6v` references in `smoke-test.mjs` with `CORTEX_MODEL`.
- Then restart Orange5 gateway with:

```powershell
$env:ORANGE5_CORTEX_MODEL="llava:7b"
```

or make the service bringup set that env when starting gateway.

## Important: What Is Green vs Not Fully Proven

### Green / Receipt-Backed

- 9/9 operational inventory:
  - Receipt:
    - `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\orange5-operational-audit-20260705T235733Z.json`

- AE Eyes service chain:
  - Receipt:
    - `C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\ae-eyes-services-20260705T235404Z.json`

- AE Eyes backend and facade tests:
  - Both exit code `0` in AE Eyes receipt.

- Qdrant:
  - Running on `6333`.

- AE Cobra:
  - Running on `7419`.

- ColPali:
  - Running on `7440`.

- local Ollama:
  - Running on `11434`.

- AtomSmasher2:
  - Running on `8901`.

### Not Yet Fully Proven

- Full AE Eyes real end-to-end “see” smoke:
  - Still blocked by smoke script/model expectation mismatch.
  - Needs final patch to use `CORTEX_MODEL`.
  - Then rerun smoke with `ORANGE5_CORTEX_MODEL=llava:7b`.

- Native app installer:
  - Not rebuilt or retested in this work segment.

- Git sync:
  - Not handled in this work segment.

- Codexa remote install parity:
  - Not handled in this work segment.

## Exact Next Steps For Next Agent

### 1. Finish Smoke Test Config Patch

File:

```text
C:\AtomEons\Orange5\07-VISUAL\smoke-test.mjs
```

Replace hardcoded `glm-4.6v` checks:

```js
names.some((n) => n.toLowerCase().startsWith("glm-4.6v"))
```

with equivalent logic using:

```js
CORTEX_MODEL
```

Also replace:

```js
name: "Ollama :11434 + glm-4.6v"
cortex !== "glm-4.6v"
want 'glm-4.6v'
```

with configured-model versions.

### 2. Restart Gateway With Vision Model

Preferred env:

```powershell
$env:ORANGE5_CORTEX_MODEL="llava:7b"
```

Then restart:

```powershell
node C:\AtomEons\Orange5\06-ORANGELLM\server\index.mjs
```

Do it hidden in service script, not visible popup.

### 3. Rerun AE Eyes Bringup

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\AtomEons\Orange5\00-CHARTER\services\orange5-ae-eyes-bringup.ps1
```

### 4. Rerun Operational Audit

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File C:\AtomEons\Orange5\00-CHARTER\services\orange5-operational-audit.ps1
```

Expected:

```text
ORANGE5_ALL_OPERATIONAL
```

### 5. Rerun Actual AE Eyes Smoke

```powershell
$env:ORANGE5_CORTEX_MODEL="llava:7b"
bun C:\AtomEons\Orange5\07-VISUAL\smoke-test.mjs
```

If this passes, AE Eyes is not just service-green; it is actual visual-path green.

## Known Important Paths

```text
C:\AtomEons\Orange5
C:\AtomEons\Orange5\00-CHARTER
C:\AtomEons\Orange5\00-CHARTER\services
C:\AtomEons\Orange5\06-ORANGELLM
C:\AtomEons\Orange5\06-ORANGELLM\server
C:\AtomEons\Orange5\06-ORANGELLM\memory\ae-cobra
C:\AtomEons\Orange5\07-VISUAL
C:\AtomEons\Orange5\08-HERMES
C:\AtomEons\Orange5\10-RECEIPTS\orange5-build
C:\AtomEons\Orange5\12-ATOMSMASHER
C:\Users\a\OrangeBox-Data\atomsmasher2-final-local
```

## Commands That Worked

```powershell
docker start orange5-qdrant
ollama pull llava:7b
powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File C:\AtomEons\Orange5\00-CHARTER\services\orange5-ae-eyes-bringup.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\AtomEons\Orange5\00-CHARTER\services\orange5-operational-audit.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File C:\AtomEons\Orange5\12-ATOMSMASHER\dist\codexa-install\install-windows.ps1 -InstallPath C:\Users\a\OrangeBox-Data\atomsmasher2-final-local -NoBackup -Port 8901
```

## Commands That Failed / Why

```powershell
ollama pull glm-4.6v
```

Failed because Ollama manifest does not exist for that tag.

```powershell
bun C:\AtomEons\Orange5\07-VISUAL\smoke-test.mjs
```

Failed before `llava:7b` install because smoke required `glm-4.6v`.

## Final Handoff Summary

Orange5 backend operationals are now receipt-green at the service/port/process level:

```text
ORANGE5_ALL_OPERATIONAL
AE_EYES_SERVICE_CHAIN_GREEN
```

The remaining high-value next fix is **actual AE Eyes end-to-end visual smoke**:

1. Finish `smoke-test.mjs` configured model patch.
2. Use `llava:7b` as current local vision model.
3. Restart gateway with `ORANGE5_CORTEX_MODEL=llava:7b`.
4. Run smoke.
5. Write/pass receipt.

Do not claim full visual seeing until that final smoke passes.
