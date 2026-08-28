# OrangeFive Operator Runbook

> Canonical usage manual: `00-CHARTER/ORANGEFIVE_HOW_TO_USE.md`. This file is
> retained as a short recovery card.

**Updated:** 2026-07-29 from live receipts  
**Product:** Orange  
**Release:** OrangeFive  
**Rule:** Receipt truth outranks prose.

## Current State

- Canonical verifier baseline: **116 green / 0 red**.
- Runtime boot receipt: **ORANGE5_RUNTIME_GREEN**.
- OrangeBrain, AE Memory/Cobra, Hermes, AE Eyes, AtomSmasher 2, and local Ollama are live.
- Codexa command rail is reachable and authenticated at `10.0.0.4:8097`.
- Navigator and Fatty heavy routes execute on Codexa.
- Memory recall-before-action is behaviorally proven and mirrored to Codexa.
- AE Eyes uses a persistent real ColQwen2 worker on Codexa Torch XPU. The
  production warm path is proven at **0.478 s** with exact one-shot output
  parity, and the persistent queue drains through the same worker.
- ColQwen2 OpenVINO conversion is optional research, not an operational gap;
  stock Optimum export does not support this custom architecture.

## Boot Or Recover

```powershell
cd C:\AtomEons\Orange5
bun .\scripts\orange5-runtime-supervisor.mjs
```

Read the resulting truth:

```powershell
Get-Content -Raw .\10-RECEIPTS\orange5-build\runtime-logs\orange5-runtime-start-latest.json
```

Required status: `ORANGE5_RUNTIME_GREEN`.

## Verify Behavior

```powershell
cd C:\AtomEons\Orange5
bun run proof:learning-behavior
bun .\06-ORANGELLM\memory\ae-cobra\smoke-test.mjs
bun run verify
```

Required outcomes:

- learning behavior receipt: `VERIFIED`
- Cobra smoke: `6/6`
- canonical verifier: `116 green / 0 red` (rerun before repeating this claim)

## Live Topology

| Organ | Endpoint | Role |
|---|---|---|
| OrangeBrain | `127.0.0.1:1337` | governed model routing and OpenAI-compatible seam |
| AE Memory / Cobra | `127.0.0.1:7419` | Reality/Thought ledger, recall, behavior memory |
| Hermes | `127.0.0.1:7430` | governed execution agents and Misfit pressure |
| AE Eyes | `127.0.0.1:7440` | visual ingestion/retrieval facade to Codexa |
| Smart Skinny | `127.0.0.1:8797` | local reflex adapter |
| AtomSmasher 2 | `127.0.0.1:8901` | compression and receipt processing |
| Codexa rail | `10.0.0.4:8097` | authenticated heavy-machine execution |

## Recovery Boundaries

- Do not restart every service because one endpoint fails. Probe and restart only the failed OrangeFive organ.
- Do not revive Orange3 or Orangebox Delta startup jobs; they are archived lineage.
- Do not bypass OrangeBrain with direct provider calls from the app.
- Do not mark an optional model or accelerator green without runtime and benchmark receipts.
- Keep OpenVINO conversion isolated from the live AE Eyes Python environment.

The obsolete July 4 manual setup gates are closed. Current truth comes from the runtime-start receipt, learning proof, Cobra smoke, Codexa rail receipts, and canonical verifier.
