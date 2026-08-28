# OrangeFive Current Operational Truth

**Updated:** 2026-07-29  
**Product:** Orange  
**Release:** OrangeFive  
**Host roles:** N150 control/dev; Codexa heavy inference, Docker, training, and batch work

## Verified Green

- Canonical source verifier: **116 green / 0 red**.
- Independent clean clone at the prior canonical remote SHA: **113 green / 0 red**
  and Git-clean after verification.
- Isolated Codexa Linux container proof at the execution-boundary SHA: **114 green / 0 red**, network disabled,
  no live Orange state mounted, and source bytes unchanged after verification.
- Runtime boot receipt: `ORANGE5_RUNTIME_GREEN`.
- Fresh operational snapshot: **8/8 endpoints green**.
- OrangeBrain: live with Smart Skinny, Codexa Navigator, and Codexa Fatty routes.
- Operational status and health orders use direct deterministic endpoint probes;
  model guidance cannot claim that a mutation completed without a real executor.
- AE Memory / Cobra: live; controlled failure was recalled before a later action.
- Cobra smoke: **6/6**, including fake-green rejection and intact Reality chain.
- Hermes: live with Misfit enabled.
- AE Eyes: live; real ColQwen2 inference uses a persistent Codexa Torch XPU
  worker. The promoted production path measured **1.909 s** for the first
  request and **0.478 s** warm, with exact quantized patch-hash parity against
  the one-shot reference. Its SQLite queue completed through the same resident
  worker, and the hidden S4U startup task is running unattended.
- AtomSmasher 2: live and accepting receipt traffic.
- Codexa rail: reachable and authenticated over AE Wi-Fi.
- Codexa memory mirror: current files copied with chained receipts.
- Hidden boot recovery: Task Scheduler result `0`; boot execution advances the runtime receipt.
- Archived Orange4, Orangebox Delta, AEFactory SelfHeal, old AEorangeBOX, and Codex watchdog startup tasks are disabled.
- Old Delta ports `8787` and `8094` are not listening; current OrangeFive ports are listening.

## Current Live Endpoints

| Organ | Endpoint |
|---|---|
| Ollama | `127.0.0.1:11434` |
| Smart Skinny | `127.0.0.1:8797` |
| OrangeBrain | `127.0.0.1:1337` |
| AE Memory / Cobra | `127.0.0.1:7419` |
| Hermes | `127.0.0.1:7430` |
| AE Eyes | `127.0.0.1:7440` |
| AtomSmasher 2 | `127.0.0.1:8901` |
| Codexa command rail | `10.0.0.4:8097` |

## Optional Research Optimization

ColQwen2 OpenVINO acceleration is not promoted and is not an operational gap.
The resident Torch XPU path removed the dominant model-reload cost and is the
current production implementation. Stock Optimum-Intel export does not support
the custom ColQwen2 architecture. OpenVINO remains quarantined research unless
a custom exporter proves exact output parity and beats the measured resident
XPU path.

## Repository Authority

- Local canonical root: `C:\AtomEons\Orange5`.
- Private canonical remote: `https://github.com/AtomEons/Atomic-Orange-Five`.
- Current proof target SHA: `c76ec13dbc5d1e9090dd26a045f908e1086c83c9`.
- Independent proof clone: `C:\AtomEons\Orange5-clean-proof`.
- The outer `C:\AtomEons` repository explicitly ignores `Orange5/` so the
  private product cannot be absorbed into the unrelated workspace/site repo.
- Root integration can be restored with
  `scripts/install-atomeons-root-integration.ps1`.

## Proof Integrity Repair

The original full verifier used a hard-coded `C:\AtomEons\Orange5` root. That
made an earlier clean-clone run execute the live checkout instead of the clone.
That clean-clone claim was withdrawn. Commit `be56314` corrected the verifier
to resolve its own checkout and isolated FLOW and continuity state per test.
The corrected verifier was then run inside the independent clone at the exact
remote SHA: **113/113 passed and `git status` remained empty**. A second proof
used a Git archive of `819d9ea` in a fresh Codexa Linux container with no
network and no live Orange mount. That run passed **113/113** and a full
before/after file-hash manifest proved `SOURCE_IMMUTABLE=true`.

Core runtime portability is now enforced by a regression test. Active runtime
modules contain no canonical-machine OrangeFive path, and active routing
doctrine cannot point back to the archived Orange3 cockpit. Remaining literal
paths are isolated to operator scripts, test/attack fixtures, offline visual
experiments, and historical workflow manifests; none remain in the active
runtime-review bucket.

## Operational Completion Boundary

OrangeFive now distinguishes model guidance from executed work. `read.status`
and `read.health` are completed by direct endpoint observations and preserve
`model: null` provenance. Mutation orders cannot become `ok` merely because an
LLM endpoint returned HTTP 200; without a deterministic executor they return
`needs_action`, emit `execution:not_performed`, receive a chain-linked receipt,
and exit nonzero. Commit `8c58c30` is proven on N150 and from an immutable Git
archive on Codexa with networking disabled: **114/114 green**.

GitHub Actions activation is not claimed. The reviewed Windows workflow
template is stored under `00-CHARTER/ci/`; the current GitHub token lacks the
`workflow` OAuth scope required to publish it under `.github/workflows/`.

## Primary Evidence

- `10-RECEIPTS/orange5-build/2026-07-29T06-46-42-873Z-operational-snapshot.json`
- `10-RECEIPTS/orange5-build/2026-07-29T06-26-53-703Z-learning-behavior-proof.json`
- `10-RECEIPTS/orange5-build/2026-07-29T06-26-51-769Z-ae-cobra-codexa-mirror.json`
- `10-RECEIPTS/orange5-build/runtime-logs/orange5-runtime-start-latest.json`
- `10-RECEIPTS/orange5-build/2026-07-29T17-33-34-338Z-atomeons-root-authority-audit.json`
- `10-RECEIPTS/orange5-build/2026-07-29T18-03-09-078Z-isolated-codexa-source-proof.json`
- `10-RECEIPTS/orange5-build/2026-07-29T18-24-07-781Z-runtime-portability-proof.json`
- `10-RECEIPTS/orange5-build/2026-07-29T18-34-42-264Z-operational-execution-boundary-proof.json`
- `10-RECEIPTS/orange5-build/2026-07-29T18-57-12-994Z-ae-eyes-resident-production-proof.json`
- `00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md`

## Recovery Commands

```powershell
cd C:\AtomEons\Orange5
powershell -ExecutionPolicy Bypass -File .\scripts\start-orange5-runtime.ps1 -Once
bun .\scripts\orange5-operational-snapshot.mjs
bun run proof:learning-behavior
bun .\06-ORANGELLM\memory\ae-cobra\smoke-test.mjs
bun run verify
bun .\scripts\atomeons-root-authority-audit.mjs --full
```
