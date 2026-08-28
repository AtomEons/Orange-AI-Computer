# OrangeFive How-To-Use Manual

> Naming: **AE Eyes** is the operational OrangeFive view system. **Cortex** begins with Orange6. **Atomic Orange** is the product/app; `OrangeEye` is not its operator-facing name. See `ORANGE_NAMING_LAW.md`.

**Product:** Orange  
**Release:** OrangeFive  
**Canonical root:** `C:\AtomEons\Orange5`  
**Canonical private remote:** `https://github.com/AtomEons/Atomic-Orange-Five`  
**Runtime split:** N150 controls; Codexa performs heavy inference, Docker, training, and batch work.
**Live-state refresh:** 2026-08-28. Always use the probes below for current truth.

This is the canonical operating manual for a human or a zero-memory coding
model. Read this file before using OrangeFive. Receipts and direct probes still
outrank this document when runtime state changes.

## 1. What OrangeFive Is

OrangeFive is one governed local AI operations system with five primary organs:

| Organ | Job | Current endpoint |
|---|---|---|
| Atomic Orange | Native operator application and interaction surface | app lane |
| OrangeBrain | Model routing, topology, fallback, structured cognition | `127.0.0.1:1337` |
| AE Memory / Cobra | Reality/Thought ledgers, recall-before-action, learning | `127.0.0.1:7419` |
| AE Eyes | Image, screenshot, document, retrieval, and visual proof | `127.0.0.1:7440` |
| AtomSmasher 2 | Compression, least-action work, tool/receipt processing | `127.0.0.1:8901` |

Hermes/LOOM is the governed authorization authority at `127.0.0.1:7430`.
Hermes decides whether an action may land; it is not itself a standing agent
team or a general host executor. Local Ollama is at `127.0.0.1:11434`.
Codexa's authenticated command rail is on the AE network at `10.0.0.4:8097`.

Orange3 and Orangebox Delta are archived lineage. Orange4 was a theory phase.
Do not route active work through them.

### Current Verified Runtime

Fresh semantic health reports the listed runtime surfaces live. A fresh Hermes
Brain MCP delegation also completed parent mediation, child execution,
synthesis, receipts, and lease revocation with all ten checks true.

| Runtime | Endpoint | Role |
|---|---|---|
| N150 Ollama | `127.0.0.1:11434` | installed utility runtime; no answer model kept resident |
| Navigator Kernel | in-process Bun | classification, routing, FLOW pressure, Little Navigators; zero model RAM |
| OrangeBrain | `127.0.0.1:1337` | OpenAI-compatible routing gateway |
| AE Memory / Cobra | `127.0.0.1:7419` | Reality/Thought ledgers and recall |
| Hermes | `127.0.0.1:7430` | leases, Misfit, LOOM authorization |
| AE Eyes | `127.0.0.1:7440` | visual ingest, retrieval, description, proof |
| AtomSmasher 2 | `127.0.0.1:8901` | compression and receipt processing |
| Codexa rail | `10.0.0.4:8097` | authenticated heavy-machine execution |

### Current Navigator

Select `orange-auto` for normal Orange work. It is the hot deterministic conductor: the Bun Navigator Kernel classifies the request before any model runs, sends generated conversation to the Codexa Navigator, repository coding to the Codexa code specialist, and deep work to the heavy lease. N150 performs control work only and keeps no answer model resident. Every generative lane receives the same compact Orange doctrine envelope. Explicit model names remain available when the operator intentionally wants a fixed specialist.

The hierarchy is `Navigator Kernel -> specialist model -> Little Navigator -> bounded Hermes lease`. Little Navigators are compiled domain packets, not resident models. They may command only their declared agent and tool subset, expire after 30 minutes, require receipts by default, and execute serially while the receipt chain has one canonical writer.

The live primary is `orange-navigator:ornith-1.5-9b-q4km` on Codexa
`10.0.0.4`. The former Ornith Q8 primary is retired; its receipts remain valid
for the historical runtime they recorded. The trained 32B OrangeBrain is a deep candidate, not the
default. Its source LoRA is verified, converted to GGUF, and staged on Codexa as
`orangebrain-trained:v0`; it must beat the report bakeoff before any live
promotion.

Accepted integrated receipt:
`10-RECEIPTS/orange5-build/2026-08-28T03-42-45-242Z-integrated-operational-proof.json`.

Accepted Blue Bench receipt:
`10-RECEIPTS/orange5-build/2026-08-28T03-40-44-768Z-blue-bench.json`.

## 2. First Minute In Any New Chat

Atomic Orange is optional for headless operation. Codex, Claude Desktop,
Antigravity, and Gemini use the canonical Bun MCP server directly:

```text
C:\Users\a\.bun\bin\bun.exe
C:\AtomEons\Orange5\03-BACKEND\orange5-brain-mcp-server.mjs
```

In an MCP-aware chat, call `orange5_health` first. Use `orange5_route` for a
non-mutating plan, `orange5_order` for governed execution, `orange5_chat` for
least-action model routing, and `orange5_receipts` for evidence. The client
installer is repeatable and preserves unrelated MCP servers:

The 2026-08-27 dual-transport proof observed 10 tools over stdio and 12 over
authenticated loopback Streamable HTTP. Different counts are expected because
the transports expose different bounded surfaces; do not rewrite this as a
parity failure.

```powershell
Set-Location C:\AtomEons\Orange5
bun .\03-BACKEND\install-orange5-clients.mjs --dry-run
bun .\03-BACKEND\install-orange5-clients.mjs
```

For a clean technical terminal view:

```powershell
bun .\03-BACKEND\orange.mjs status
bun .\03-BACKEND\orange.mjs ask "Summarize the active project state."
bun .\03-BACKEND\orange.mjs route build.feature
bun .\03-BACKEND\orange.mjs order read.status
```

Use `--json` for machine-readable output. The wire path remains
`orange.order.v1` -> `orange.report.v1`; the technical display is presentation
only.

Run these from PowerShell:

```powershell
Set-Location C:\AtomEons\Orange5
$env:ORANGE5_ORANGEBRAIN_URL = 'http://127.0.0.1:1337'
bun .\03-BACKEND\spine-cli.mjs --health
@{action='read.status';payload=@{target='all'}} | ConvertTo-Json -Compress | bun .\03-BACKEND\spine-cli.mjs
```

Interpretation:

- `orangebrain.live=true`: model routing is reachable.
- `status=ok` on `read.status`: the named endpoints were directly observed.
- `status=needs_action`: nothing completed the requested operation. Do not call it done.
- `status=halted`: a LOOM boundary stopped the crossing. Read the blocker; do not retry blindly.
- HTTP 200 from a model is not execution proof.

If health is not live, recover once:

```powershell
bun .\scripts\orange5-runtime-supervisor.mjs
Get-Content -Raw .\10-RECEIPTS\orange5-build\runtime-logs\orange5-runtime-start-latest.json
```

Never start duplicate processes on an occupied port. The recovery script
suppresses duplicate starts and writes a runtime receipt.

## 3. How A Coding Model Uses OrangeFive

OrangeFive is the control and evidence spine; the coding model remains the
hands inside its authorized workspace.

1. Read this manual and the target repository's governing files.
2. Run the health and direct-status commands above.
3. Ask OrangeFive for a dry-run route before substantial work.
4. Inspect the real target files.
5. Make the scoped change with the coding host's normal file/shell tools.
6. Run deterministic tests before model review.
7. Use OrangeBrain for analysis/review, not as proof that edits occurred.
8. Preserve evidence: command, exit code, changed files, hashes, receipt path.
9. Update the project truth only when exact runtime evidence supports it.

Dry-run example:

```powershell
@{action='build.feature';payload=@{targetProject='C:/AtomEons/example';intent='add bounded queue';allowedPaths=@('src','tests')}} | ConvertTo-Json -Compress | bun .\03-BACKEND\spine-cli.mjs --dry-run
```

Cognitive request example:

```powershell
@{action='analyze.system';payload=@{question='Find the highest-impact verified bottleneck in the current runtime'}} | ConvertTo-Json -Compress | bun .\03-BACKEND\spine-cli.mjs
```

Direct observation examples:

```powershell
@{action='read.status';payload=@{target='orangebrain'}} | ConvertTo-Json -Compress | bun .\03-BACKEND\spine-cli.mjs
@{action='read.health';payload=@{target='ae-eyes'}} | ConvertTo-Json -Compress | bun .\03-BACKEND\spine-cli.mjs
```

Supported direct target names include `all`, `ollama`, `orangebrain`, `cobra`,
`memory`, `hermes`, `ae-eyes`, `eyes`, `atomsmasher`, and `atomsmasher2`.

## 4. Execution Truth

The spine enforces this distinction:

- **Observation:** direct endpoint probe may return `ok`.
- **Cognition:** OrangeBrain may complete `query`, `ask`, `explain`, `analyze`,
  or `plan` actions with structured output.
- **Mutation:** `build`, `write`, `edit`, `install`, `deploy`, and other actions
  are not complete merely because a model answered. Without a deterministic
  executor, OrangeFive returns `needs_action`, records
  `execution:not_performed`, and exits nonzero.

This is intentional. A coding agent should then perform the edits/tests with
its real tools. Never rewrite `needs_action` as success in prose.

## 5. Orders And Reports

Internal model-to-model traffic uses two contracts:

- Input: `orange.order.v1`
- Output: `orange.report.v1`

The current CLI accepts the compact execution form:

```json
{
  "action": "verb.noun",
  "payload": {}
}
```

For interop/API work, use the full order schema in
`09-SCHEMAS/orange.order.v1.schema.json`. Reports follow
`09-SCHEMAS/orange.report.v1.schema.json`.

Useful flags:

| Flag | Meaning |
|---|---|
| `--health` | Spine and OrangeBrain state |
| `--dry-run` | Route and gate without writing a receipt |
| `--learn` | Close the AE Memory learning loop after a successful operation |
| `--seed VALUE` | Deterministic replay seed |
| `--strict` | Force strict epistemic enforcement even for a non-claim topology |
| `--advisory` | Explicit diagnostic override; records weak evidence but does not authorize it as proof |
| `--expert ID` | Attribute the selected expert |
| `--campaign ID` | Link work to a campaign |

## 6. Memory And Learning

AE Memory/Cobra owns recall-before-action. OrangeFive checks prior related
mistakes before execution and records new outcomes in the Reality/Thought
ledger. Use `--learn` only on an actually successful operation.

Proof commands:

```powershell
bun run proof:learning-behavior
bun .\06-ORANGELLM\memory\ae-cobra\smoke-test.mjs
```

Expected current proof: learning behavior `VERIFIED`; Cobra smoke `6/6`.
Do not inject an unverified model guess into hot memory as a fact.

Current held-out memory quality is 23/23 cases with hybrid MRR `0.9058`, p50
`281 ms`, and p95 `445 ms` in
`10-RECEIPTS/orange5-build/2026-08-27T16-42-16-141Z-memory-quality-benchmark.json`.

Context Crystal held-out quality passed 5/5 with a minimum `1422.901x`
operational context ratio across a 7,056,795-byte corpus. Keep workload,
denominator, and source-pointer checks attached whenever quoting this result.

## 7. AE Eyes

Health:

```powershell
Invoke-RestMethod http://127.0.0.1:7440/health
```

AE Eyes is operational only when a real visual input is accepted and returns a
structured result. Facade health alone is insufficient. The production system
has two cooperating visual paths:

- ColQwen2 on a persistent Codexa Torch XPU worker performs document/image
  patch embeddings and retrieval.
- `gemma4:e2b` on Codexa performs structured visual description through
  OrangeBrain; local `llava:7b` is the bounded fallback.

The service supports synchronous image/PDF ingest, durable queue routes,
Qdrant retrieval, structured description, and AE Cobra observation receipts.
Receipts must name the actual backend and whether fallback occurred.

Do not claim OpenVINO acceleration until output parity and latency both beat the
Torch XPU baseline.

## 8. Current Model Routing

Installed models are inventory. Only models named by a live route are active.

| Tier | Current active model | Host | Use |
|---|---|---|---|
| Reflex | Bun Navigator Kernel | N150 | deterministic status, routing, FLOW pressure, and tool discipline; zero resident model RAM |
| Navigator | `orange-navigator:ornith-1.5-9b-q4km` | Codexa | bounded 9B Q4_K_M conductor for routing and report generation |
| Heavy | `qwen2.5-coder:32b` | Codexa | harder coding and architecture work |
| Visual description | `gemma4:e2b` | Codexa | structured image/document interpretation |
| Visual fallback | `llava:7b` | N150 | explicit bounded fallback only; not required for normal operation |
| Embeddings | `nomic-embed-text` | N150 | local semantic embedding path; not an answer model |

The Q4_K_M Ornith candidate passed its promotion bakeoff and now owns the live
primary tag above. Q8 remains historical inventory and is not a fallback
authority merely because its weights are installed.

Captain Planet media lanes currently prove technical artifact validity:
decodable image/video, non-silent speech/music, motion where applicable, and
stable hashes. They do **not** prove studio quality; that requires the pending
cross-prompt human and model quality bakeoff.

Codexa also holds larger and wildcard models including Qwen3 30B A3B,
DeepSeek-R1 32B/70B, Llama 3.3 70B, Command-R 35B, Dolphin 8B, and an
abliterated Llama 3.1 8B. They are not automatically active merely because
they are installed. OrangeBrain routing and a receipt must prove their use.

### Pretrained OrangeBrain Artifact

The original trained OrangeBrain lineage exists locally as
`16-TRAINING/adapters/orangellm-fatty-v0/`:

- exact base: `unsloth/qwen2.5-32b-instruct-bnb-4bit`
- method: QLoRA, rank 16, alpha 32
- training: 375 steps, 3 epochs
- final logged loss: `0.4291230201721191`
- adapter: `adapter/adapter_model.safetensors`
- size: `536,991,984` bytes
- SHA-256: `852d3386d995a19b06485dcfb5afd161caa6c4301cfb1d7b94e295ea132c7fd7`

The historical `training-receipt.json` incorrectly names a Qwen3 base. The
adapter's own `adapter_config.json` is authoritative and proves Qwen2.5-32B
Instruct. Do not rewrite the historical receipt; preserve it and record the
correction in newer operational evidence.

This trained adapter is **not the currently active model**. The live Navigator
is Ornith 1.5 9B Q4_K_M and the live Heavy lane is separately routed.
Applying the adapter to that Coder model would be an invalid base mismatch.
The trained model becomes eligible for promotion only after it is merged or
converted against the exact Qwen2.5-32B Instruct base, exported to a supported
runtime format, and beats the current Navigator/Heavy routes in the Orange
report bakeoff. A file existing in `16-TRAINING` is not runtime promotion.

Check the live routes instead of guessing:

```powershell
Invoke-RestMethod http://127.0.0.1:1337/healthz | ConvertTo-Json -Depth 10
```

## 9. Codexa Heavy Work

Connectivity:

```powershell
ssh -i C:/Users/a/.ssh/orange_codexa_automation_ed25519 Atom@10.0.0.4 hostname
```

Expected hostname: `CODEXA`.

Use Codexa for heavy models, training, Docker, batch evaluation, and long jobs.
Use the N150 for orchestration, receipts, local reflex, and development. Never
put passwords, rail tokens, API keys, or private-key contents in repositories,
prompts, manuals, or receipts.

## 10. Hermes, LOOM, And Agents

Hermes is real, but its job must be described precisely.

```text
OrangeBrain plans and selects a lane.
Hermes mints a bounded lease and evaluates policy.
Misfit pressure-checks medium/high-risk actions.
LOOM applies eight deterministic gates.
An MCP adapter, coding host, or command executor performs the action.
AtomSmasher and AE Memory record the result.
```

Hermes does **not** wake a permanent group of autonomous agents. An idle health
response with `active_leases: 0` is normal. It also does not perform a host
side effect merely because `POST /action` passes. A passing action means
"authorized to execute". The caller or adapter must still perform the work and
submit evidence.

The eight LOOM gates are:

1. order schema
2. report schema
3. receipt spine
4. human approval
5. Codexa/actor lease
6. OrangeBrain gateway provenance
7. MCP handshake and tool-card resolution
8. false-green rejection

Prove the authorization path:

```powershell
bun .\08-HERMES\smoke-test.mjs
```

Expected behavior: gateway reachable, lease minted, forbidden action refused,
and an allowed action passes all eight gates. A gate pass is authorization, not
delegated-worker completion.

Prove the MCP adapter path:

```powershell
bun .\08-HERMES\mcp-smoke.mjs
```

Expected behavior: allowed adapter action executes, forbidden and
approval-required actions refuse, expired/revoked leases refuse, upstream-down
is reported honestly, audit trace is written, and concurrent leases remain
isolated.

**Current proof:** the latest Hermes Brain MCP delegation completed parent
execution, one child, synthesis, receipt creation, and lease revocation with all
ten checks true in `11,409.53 ms`. The receipt is
`10-RECEIPTS/orange5-build/2026-08-28T04-13-22-203Z-brain-mcp-delegation-live-proof.json`.
This proves the harmless read contract; mutating and long-job contracts retain
their own evidence requirements.

Prove the full Hermes test suite:

```powershell
bun test .\08-HERMES\tests
```

To obtain actual agent power, all four layers must be present:

- **Planner:** OrangeBrain produces a bounded `orange.order.v1`.
- **Governor:** Hermes issues the exact lease and clears LOOM.
- **Effector:** Codex, Claude, Codexa command rail, or an MCP adapter performs
  the concrete operation.
- **Verifier:** deterministic tests and receipts prove the operation landed.

If a session only calls Hermes health or `/action`, no useful work has landed.
If it invokes an adapter but produces no artifact/receipt, it is also not done.
The live cross-organ read-only proof is:

```powershell
bun .\03-BACKEND\cross-organ-mission-cli.mjs
```

That proof exercises OrangeBrain, Hermes, AE Memory/Cobra, AtomSmasher, and the
spine together. It proves orchestration for a read-only mission, not arbitrary
code mutation.

## 11. Verification Levels

Use the smallest proof that covers the claim:

```powershell
# Direct runtime truth
bun .\scripts\orange5-operational-snapshot.mjs

# A focused module
bun test path\to\focused.test.mjs

# Full source system
bun run verify

# Outer workspace and private-repo authority
bun .\scripts\atomeons-root-authority-audit.mjs --full
```

Do not copy a historical pass count into a status report. Run the verifier and
report the exact result and timestamp from that run.

## 12. Receipts

Primary locations:

```text
C:\AtomEons\Orange5\10-RECEIPTS\spine-chain.jsonl
C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\
C:\Users\a\OrangeBox-Data\orange5\
```

A useful report states:

- exact status
- actions actually taken
- commands and exit codes
- file/commit hashes
- evidence and receipt paths
- blockers
- next executable action

No receipt means no promotion to operational green.

## 13. Failure Recovery

1. Probe the exact organ.
2. Confirm whether its port is occupied.
3. Read its latest receipt/log.
4. Restart only that organ if necessary.
5. Rerun the focused proof.
6. Run full verification only after the focused path is green.

Do not revive Orange3/Delta startup tasks. Do not run visible PowerShell popup
loops. Do not kill OBS while streaming. Do not restart all services because one
probe failed.

## 14. Zero-Memory Model Card

Paste or load this at the start of an unprimed model session:

```text
You are operating Orange release OrangeFive at C:\AtomEons\Orange5.
Orange3/Delta are archived; Orange4 was theory. Read
00-CHARTER\ORANGEFIVE_HOW_TO_USE.md before acting. N150 controls; Codexa
10.0.0.4 performs heavy work. Use Bun and the OrangeFive spine. Probe current
state; do not infer it from docs. Receipts and direct evidence outrank claims.
Model output is cognition, not mutation proof. A mutation is complete only
after real tools changed the artifact and deterministic tests passed. Never
convert needs_action, halted, unverified, candidate, or degraded into green.
```

## 15. Source Of Current Truth

Read in this order:

1. `ORANGEFIVE_CURRENT_OPERATIONAL_TRUTH.md`
2. `00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md`
3. latest runtime receipt
4. latest focused receipt for the organ being used
5. source and tests for the exact path

When those disagree, fresh direct evidence wins and the stale document must be
corrected.
