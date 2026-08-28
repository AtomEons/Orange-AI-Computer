# Æ Orange AI Computer Troubleshooting And Recovery

## Recovery Principle

Diagnose from meaning, ownership, and evidence. A port, process, model file, or
HTTP status is only one observation. Orange recovery asks:

1. Which organ owns the capability?
2. Is the expected process the process actually bound to the port?
3. Does semantic health describe the expected function?
4. Did a real order complete?
5. Is the completion linked to a valid receipt?
6. Can the result be recalled after restart?

## First Minute

```powershell
Set-Location .\system
bun 03-BACKEND/spine-cli.mjs --health
bun 03-BACKEND/orange.mjs status
bun scripts/orange5-runtime-services.mjs status
git status --short
```

Record the semantic status and exact blocker before changing anything.

## Core Services

| Service | Default health | Responsibility |
|---|---|---|
| OrangeLLM | `http://127.0.0.1:1337/healthz` | OpenAI-compatible chat and routing gateway |
| AE Memory / Cobra | `http://127.0.0.1:7419/healthz` | durable recall and memory crossing |
| Hermes | `http://127.0.0.1:7430/healthz` | bounded agent execution |
| Brain MCP | `http://127.0.0.1:7431/health` | governed client and model-to-model tools |
| AE Eyes tunnel | `http://127.0.0.1:7440` | structured visual worker crossing |

These addresses are defaults for the current installation. A public install may
discover different hosts while preserving the same roles.

## Start Or Stop Only Owned Orange Services

```powershell
bun scripts/orange5-runtime-services.mjs status
bun scripts/orange5-runtime-services.mjs start <service>
bun scripts/orange5-runtime-services.mjs stop <service>
```

Use the service manager rather than killing every Bun, PowerShell, Ollama, or
Docker process. Neighboring services may belong to the operator or another
project.

Before terminating an unhealthy listener, verify process identity, command
line, executable path, expected entrypoint, and port ownership. A matching
`bun.exe` image name alone is not ownership proof.

## OrangeLLM Responds But Chat Does Not Flow

Check:

1. `/healthz` names the expected active route.
2. the selected model exists on the selected host;
3. the app sends `stream: true`;
4. the request uses conversation mode when conversational streaming is desired;
5. time to first upstream content is recorded separately from final completion;
6. the native Tauri bridge forwards chunks rather than buffering the whole body;
7. Stop/cancel reaches the underlying native request and upstream generation.

Direct probe:

```powershell
bun -e "const r=await fetch('http://127.0.0.1:1337/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:'orange-auto',stream:false,messages:[{role:'user',content:'Return one sentence describing current Orange health.'}]})}); console.log(r.status,await r.text())"
```

This proves the gateway crossing. It does not prove the native interface until
the same result appears in Atomic Orange with matching run/receipt identity.

## BuildRun Is Missing Or Stale

Probe the live gateway:

```powershell
bun -e "const r=await fetch('http://127.0.0.1:1337/v1/build-runs'); console.log(r.status,await r.text())"
```

Expected behavior:

- valid page schema;
- runs stored under the machine-local Orange data root;
- chain verification reports every malformed or mismatched line;
- successful work transitions to `completed`;
- compilation or execution failure transitions to `failed`;
- the native dock distinguishes active, completed, blocked, cancelled, and
  failed states.

Do not delete a BuildRun ledger to clear a stale display. Repair the lifecycle
or projection while preserving evidence.

## Hermes Delegation Does Not Complete

Run the focused live proof:

```powershell
bun 03-BACKEND\brain-mcp-delegation-live-proof.mjs
```

Inspect the first failed gate:

- order schema: verify required root fields, especially `action`;
- report schema: verify constrained result shape;
- receipt spine: verify sequence and predecessor hash within the correct chain;
- approval: verify declared risk and operator decision;
- Codexa lease: verify target and availability;
- gateway/MCP: verify the governed crossing;
- false-green guard: verify actual execution evidence;
- completion: verify child, synthesis, and lease revocation.

Repair the first causal failure and rerun once. A new failed gate is new
information; repeating the same unchanged failure is a loop.

## Codexa Is Unreachable

Orange should keep deterministic control available and return a named route
blocker or local fallback. Diagnose in this order:

1. host discovery (`CODEXA`, `CODEXA.local`, configured address);
2. Wi-Fi/LAN reachability;
3. SSH reachability with the configured automation key;
4. authenticated rail health;
5. Ollama/model runtime health;
6. free memory and active leases;
7. role-specific endpoint.

Never place passwords or rail tokens in a command transcript, repository file,
or receipt. Use the machine's protected configuration.

## A Model Is Installed But Not Used

Inventory and route are different facts.

- Inventory: the model exists on disk or in Ollama.
- Availability: the runtime can load it.
- Residency: it is currently loaded.
- Route: Orange selected it for this request.
- Promotion: it passed the role bakeoff.

Use a fresh route receipt to identify the actual model. Do not infer route use
from `ollama list`.

## Memory Finds The Wrong Fact

1. Preserve the query and returned evidence.
2. Check project scope and source timestamps.
3. Compare lexical, dense, and hybrid ranking.
4. Verify the expected source is indexed.
5. Apply evidence precedence for contradictions.
6. Record contradiction or compression debt.
7. Add the case to the held-out quality suite.
8. Promote a ranking change only if the full suite remains green.

Reproduce the current quality suite:

```powershell
bun run bench:memory-quality
```

## Compression Omits Needed Context

Context Crystal must preserve a route to exact source.

1. Check the source pointer.
2. Hydrate the smallest missing span.
3. Record compression debt.
4. Determine whether the missing fact is a commitment, residual, exception, or
   task-neighborhood error.
5. Add the case to held-out quality tests.
6. Re-run answer parity and pointer verification.

Never repair compression by permanently injecting the entire project.

## Fixer Says Closed Without Strong Evidence

A valid Fixer lifecycle requires:

- observed failure evidence;
- localized cause;
- successful repair evidence;
- a real passing regression artifact;
- a valid success receipt that exists on disk;
- rollback or recovery context.

Any missing condition keeps the case open. A path string is not a regression.
An `{ ok: false }` record is not repair evidence.

## AE Eyes Returns A Result Without Visual Proof

Require the complete chain:

- local source path or permitted URL;
- source hash;
- visual worker route;
- structured visual result;
- report identity;
- receipt identity;
- operator-visible rendering where applicable.

For remote URLs, verify the SSRF and network boundary before retrieval.

## Media File Exists But Quality Is Unclear

Separate technical and aesthetic proof.

Technical checks:

- independent decode;
- dimensions, duration, frame/audio properties;
- non-silence or motion where expected;
- artifact hash;
- model/runtime provenance;
- peak memory and elapsed time.

Quality checks:

- task-specific rubric;
- reference comparison;
- prompt adherence;
- temporal or anatomical consistency;
- text fidelity where relevant;
- human final judgment for premium output.

## Popup Windows Appear

Resident Orange services should launch as hidden detached children. Inspect:

- startup folders;
- Run keys;
- scheduled tasks;
- legacy Orange directories;
- PowerShell wrapper scripts;
- process command lines.

Disable only entries whose exact target belongs to an archived Orange version.
Keep current Orange services under the Bun service manager or compiled hidden
runtime supervisor.

## Clean Recovery Procedure

1. Save current Git status and runtime status.
2. Identify the exact failing organ.
3. Preserve its latest receipt and relevant logs.
4. Stop only the owned service if a restart is necessary.
5. Repair the smallest causal defect.
6. Run focused tests.
7. Start only the owned service.
8. Run a semantic live probe.
9. Run one real harmless order through the repaired path.
10. Verify report, receipt, and restart/recall behavior.
11. Add the failure as a regression case.

## Escalation Packet

When handing a problem to another human or model, include:

```text
PRODUCT: Æ Orange AI Computer
SOURCE ROOT: <repository>\system
GOAL: <one exact result>
OBSERVED: <semantic status and timestamp>
EXPECTED: <contract>
FIRST FAILED GATE: <name>
EVIDENCE: <receipt/log/test/path>
OWNED SCOPE: <allowed files/actions>
FORBIDDEN: <destructive or unrelated actions>
ROLLBACK: <known working state>
NEXT DISPROVING TEST: <one command>
```

That packet lets a fresh account resume the real project instead of rebuilding
an imaginary one.
