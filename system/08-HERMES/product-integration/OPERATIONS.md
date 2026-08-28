# OrangeFive Hermes Product Integration

## Purpose

This pack integrates the official Hermes Agent product into OrangeFive without
replacing Orange governance. Hermes supplies profiles, durable Kanban work, tools,
memory, Bot/API surfaces, and agent sessions. Orange owns routing policy, approvals,
execution truth, and receipts.

Pinned upstream: Hermes Agent `0.20.5`, tag `v2026.8.19`, commit
`fcbd1076a93841fa88855acce810e342a5b78101`.

## Runtime Shape

- One default Hermes gateway owns the listener, multiplexing, API server, and Kanban dispatcher.
- Six named, state-isolated profiles: Navigator, Builder, Researcher, Reviewer, Visual, Misfit.
- One durable default Kanban board. Orange authorizes work; Navigator decomposes it explicitly.
- One filtered Orange Brain MCP server. Only health, route, order, receipts, and bounded delegation are exposed.
- One authenticated OpenAI-compatible loopback API at `127.0.0.1:8642`.
- One centralized Navigator plus a six-wide immediate swarm. Depth 2 lets an
  explicitly selected orchestrator split independent work into as many as 36
  bounded leaves without creating a second gateway or dispatcher.
- Durable Kanban dispatch admits eight in-progress tasks, capped at two per
  profile. Queue breadth is disk-backed and unbounded by model residency.
- Model residency is governed separately by Orange's 50 GiB live-memory lease.
  Six Hermes workers may share one loaded model or use tools; they do not imply
  six simultaneously resident heavyweight models.
- One governed model gateway at `127.0.0.1:1337/v1`; profile model aliases select the role.
- No telemetry, no cloud default, no repository secrets, no LAN bind.

Hermes 0.20.5 brings the current MCP 2.x / 2026-07-28 protocol floor, Bot Mode,
Cua 0.20, durable Kanban fixes, remote-gateway recovery, execution stall guards,
and update receipts. The integration intentionally uses the product instead of
reimplementing those organs.

`config/capabilities.json` distinguishes configured capability from capability
that is merely available upstream. In particular, Cua is not exposed to any role
until Orange grants a scoped computer-use and visual-proof policy; remote gateway
self-healing is not active until a service is deliberately installed.

## Profile Duties

| Profile | Role | Effective capability |
|---|---|---|
| Navigator | conductor | Orange MCP, Kanban, memory, short read-only delegation |
| Builder | implementation | debugging/file/terminal; Orange route/order/receipt tools |
| Researcher | current evidence | web/browser and bounded delegation; health/receipts only |
| Reviewer | proof tribunal | attached evidence and Orange health/receipts; no mutation tools |
| Visual | rendered truth | vision/browser and Orange health/receipts; no mutation tools |
| Misfit | dissent packet | Orange health/receipts only; no action, delegation, or signing authority |

Hermes profiles isolate state, not OS permissions. Toolsets are the enforced product
boundary here. Builder is the only role with direct Hermes mutation tools, and its
SOUL plus Orange order still constrain the assignment. For hostile multi-user use,
move Builder to a Docker backend with explicit mounts and egress policy.

## Static Verification (Safe Now)

```powershell
cd C:\AtomEons\Orange5\08-HERMES\product-integration
bun run check
bun test
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-hermes-product.ps1
```

The installer command above is a dry-run. It installs nothing and starts nothing.

If Codexa already has the official pinned executable, adopt it without cloning or
modifying upstream source:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-hermes-product.ps1 `
  -Apply `
  -ExistingHermesExe C:\Users\Atom\AppData\Local\hermes\hermes-agent\venv\Scripts\hermes.exe
```

Adoption requires the executable to report `0.20.5`, freezes its SHA-256 in the
install manifest, and records that source-commit provenance was not independently
reconstructed. The normal install path remains available when exact Git-commit and
`uv.lock` provenance is required. Neither mode patches or forks Hermes source.

## Install On Codexa

First ensure Python 3.11-3.13 and Bun are present. Then:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\install-hermes-product.ps1 `
  -Apply `
  -InstallRoot C:\AtomEons\ai-box\hermes-product `
  -DataRoot C:\AtomEons\ai-box\hermes-product\data `
  -OrangeRoot C:\AtomEons\Orange5 `
  -BunPath C:\Users\Atom\.bun\bin\bun.exe
```

The installer:

1. Verifies the annotated tag object and its resolved commit against both pinned SHAs.
2. Fetches and checks out the exact Git object, never `main` or `latest`.
3. Uses upstream `uv.lock` with `uv sync --locked` for hash-checked dependencies.
4. Verifies installed package version `0.20.5`.
5. Materializes managed profile configs.
6. Generates unique API keys only in the runtime data root and restricts their ACLs.
7. Does not start or restart a service.

## Preflight Before Start

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1
```

Before the first start, gateway/API/board checks will correctly report `BLOCKED`.
That is not a failed install and must not be relabeled green.

## Start Exactly One Gateway

Run this only after preflight confirms the files and pin are correct:

```powershell
$env:HERMES_HOME='C:\AtomEons\ai-box\hermes-product\data\.hermes'
$env:GATEWAY_MULTIPLEX_PROFILES='true'
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-owner.ps1 -Apply
```

Do not start gateways for Navigator, Builder, Researcher, Reviewer, Visual, or
Misfit. The default gateway multiplexes all six and owns the only dispatcher.
The owner starts hidden with `hermes gateway run --external-supervisor`; plain
`hermes gateway` is not a valid production launch command.

## Prove Runtime

With the gateway and Orange model gateway already running:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\preflight.ps1 -ProbeAgentInference -WriteReceipt
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\agent-lease-proof.ps1 -WriteReceipt
```

The lease proof compiles one read/receipts-only agent lease through the live
Orange MCP endpoint with `execute: false`. It proves boundaries and expiry
without loading a model, running an agent, or mutating a project.
The inference probe runs only after the Navigator profile proves its filtered
tool surface. A broad or missing toolset blocks the prompt instead of risking
an agent run with unintended capabilities.

`READY` requires all of these to pass at the same time:

- installed version and commit
- six materialized profiles
- exactly one TCP listener at `127.0.0.1:8642`, owned by a process descended
  from the recorded gateway launch PID
- listener-to-launch process ownership restricted to the invoking user or SYSTEM
- SQLite Kanban integrity
- Orange Brain MCP 2026-07-28 initialize and required tools
- authenticated OpenAI-compatible loopback capabilities
- Orange model gateway model discovery

Anything else returns `NOT_READY` with exact blockers.

Gateway wrapper and ancestor processes are ancestry evidence, not additional
listeners. Preflight fails closed on a second port-8642 listener, a non-loopback
bind, an unrelated process owner, or a process chain that does not reach the
recorded launch PID. Authenticated toolset probes allow 15 seconds; missing,
wrong, owner-on-profile, and peer-profile credentials must still return `401` or
`403`.

## Atomic And Other OpenAI-Compatible Clients

Use `config/clients/openai-compatible.json` as the connection contract. The main
endpoint is `http://127.0.0.1:8642/v1`. The key is generated at install under the
runtime `.hermes/.env`; do not copy it into this repository. Named profile routes
use `/p/<profile>/v1` and each requires that profile's distinct runtime key.

## Durable Work Rule

Use Kanban when work crosses a profile, survives restart, produces an artifact, or
needs review. Use `delegate_task` only for a short read-only answer that the current
turn must await. There is no second Orange or Hermes dispatcher.

Completion flow:

1. Orange health and route.
2. Orange-approved root order.
3. Navigator classifies dependency structure, creates explicit tasks with
   idempotency keys, and fans out only independent work.
4. Builder/Researcher/Visual completes bounded work and attaches evidence.
5. Reviewer requests changes or approves evidence.
6. Navigator closes the root only after Orange receipt verification.

Kanban `done` is workflow state. An Orange receipt is operational proof.

## Swarm Law

Use six-way delegation for independent research, review, test, or file-owner
partitions. Use one depth-two orchestrator only when its child goals are separable.
Sequential debugging, shared-file mutation, and irreversible Orange actions stay
centralized. Reviewer must not share the Builder's conclusion as assumed context.
The Orange MCP mutation surface remains serialized even when reasoning is wide.

## Update Policy

Do not run `hermes update` blindly. Discover a stable upstream release, review its
security and migration notes, update `upstream.lock.json` to an immutable tag and
commit, run static tests, install into a staging root, then promote only after live
preflight. Update receipts from Hermes are evidence, not automatic approval.
