# OrangeFive Runtime Authority

**Schema:** `orange5.runtime-authority.v1`
**Product:** Orange
**Release:** OrangeFive
**Authority:** current code, live probes, and hash-chained receipts
**Historical design source:** `ORANGE5_MASTER_PLAN.md`

This file resolves implementation drift between the locked design history and
the running system. When a historical plan, old receipt, or legacy name
conflicts with this file, inspect the live endpoint and latest receipt. Live
evidence wins.

## Current Topology

OrangeFive is a two-computer system:

| Host | Current responsibility |
|---|---|
| N150 control host | Bun control plane, canonical spine, receipts, reflex routing, local services, development, and operator clients. No answer model is required to remain resident. |
| Codexa `10.0.0.4` | Resident Orange Navigator, bounded heavy-model leases, visual workers, training, Docker services, and long jobs. |

The N150 reflex is deterministic Bun code. It is not a renamed model and it
does not consume model RAM. A local model may be used as an explicit fallback,
but it is not required for normal OrangeFive operation.

## Current Model Lanes

| Lane | Current implementation | Residency |
|---|---|---|
| Reflex | Bun Navigator Kernel | always available in-process on N150; zero model RAM |
| Navigator | `orange-navigator:ornith-1.5-9b-q4km` | lease-loaded on Codexa; default Orange-aware generative conductor |
| Heavy/code | `qwen3-coder:30b` | bounded Codexa lease; not always resident |
| Visual description | `qwen3.8:27b-current` | bounded multimodal Codexa lease |
| Visual retrieval | resident ColQwen2 Torch XPU worker plus Qdrant | Codexa |

Navigator transport is selected by measured least action. The production path
is the Codexa Ollama endpoint reached through the N150 loopback tunnel at
`127.0.0.1:11437`, with the Wi-Fi service address `10.0.0.4:11434` as the
governed fallback. The retired 4B Vulkan bridge at `11436` is not eligible for
primary selection. A tunnel failure must change the reported route to
`direct_ollama`; it must not silently change the model identity.

The former Ornith Q8 model is retired from current routing authority. Preserve
its historical receipts as recorded; installed Q8 weights are inventory or an
explicit benchmark baseline, not the live primary.

Installed weights are inventory, not active lanes. A route and receipt must
prove model use. Historical Smart Skinny, `qwen3:0.6b` answer-model, and
one-machine statements are not current runtime instructions.

## Required Live Organs

| Organ | Endpoint or entrypoint |
|---|---|
| OrangeBrain gateway | `http://127.0.0.1:1337/healthz` |
| AE Memory / Cobra | `http://127.0.0.1:7419/healthz` |
| Hermes | `http://127.0.0.1:7430/healthz` |
| AE Eyes facade | `http://127.0.0.1:7440/health` |
| AtomSmasher 2 | `http://127.0.0.1:8901/health` |
| Codexa command rail | `http://10.0.0.4:8097` with authenticated command requests |
| Canonical order spine | `bun C:/AtomEons/Orange5/03-BACKEND/spine-cli.mjs` |

Health must be semantic. An HTTP 200 alone cannot prove an organ operational.
Use:

```powershell
bun C:/AtomEons/Orange5/03-BACKEND/orange.mjs status
bun C:/AtomEons/Orange5/03-BACKEND/spine-cli.mjs --health
```

## Operational Crossing

The governed order path is:

```text
orange.order.v1
-> LOOM procedural gate
-> least-action route
-> topology selection
-> AE Memory recall
-> lossless AtomSmasher sieve
-> adversarial review when claim-bearing
-> strict epistemic preflight when required
-> executor or bounded Hermes lease
-> post-output epistemic review
-> orange.report.v1
-> hash-chained receipt
```

Navigator model inference emits only a compact decision packet. Bun
deterministically adds the public schema, trusted order identity, empty model
action attestation, and null receipt provenance. Semantic guards replace
unsupported completion instructions and any attempt to delegate receipt-path
authority back to a model or caller.

Model, lane, route, and fallback choice are system responsibilities. Navigator
may request genuine approval or missing intent, but it cannot ask the operator
to choose among execution lanes. Bun replaces that burden with deterministic
route selection and an eligible fallback; no eligible route remains fail-closed.

A model may finish a cognitive review, but model completion is never execution
proof. Every compiled gateway envelope carries `ae_execution_performed=false`,
marks model evidence as unverified, and reserves receipt authority for the
governed runtime. Only the spine, executor, epistemic review, and hash-chained
receipt may promote those claims into operational truth.

When a user order contains an explicit string evidence array, the gateway
hashes that exact array and independently hashes the compiled model evidence.
It emits `exact`, `mismatch`, or `not_supplied`; the spine and cross-organ
receipts carry the result. This detects subtle evidence drift without granting
the model or the unverified input any additional authority.

Explicit evidence defaults to `preserve_exact`: a completed report with drift
is downgraded to `needs_action`, capped at 0.5 confidence, and sent to governed
verification. Callers that legitimately derive new verdict evidence, including
the independent refuter, must declare `derive`. Both policies still carry
`ae_execution_performed=false` until the governed spine executes and receipts.

Evidence values are canonicalized before comparison: strings remain byte-exact,
while structured JSON values are serialized deterministically. The `derive`
policy is an internal protocol boundary, not a public override. It requires an
order identity ending in `:refuter` and the latest user packet to declare
`role=falsifier`; ordinary callers receive `403 derive_policy_forbidden`.
Explicit evidence cannot select `none`, evidence policy cannot be used outside
the operational report contract, and `preserve_exact` cannot be asserted
without evidence. These invalid combinations are rejected before routing or
model inference, so callers cannot downgrade evidence handling by configuration.
Preserve-exact evidence uses the same bounded workbench as the compact model
packet: at most two items and 96 characters per item. Larger evidence belongs
in governed source pointers and hydration, not duplicated model output. The
gateway rejects impossible exact-preservation packets before routing, while
the internal derived refuter may still inspect larger contextual evidence.
The model-facing report packet uses private single-character keys
`s/c/e/b/n`; Bun expands them into the stable public `orange.report.v1` fields.
This codec is not exposed to clients and cannot change receipt or execution
authority. Promotion measurements include raw validity, repair rate, and
latency; a single-model measurement is never labeled a promotion.

No missing organ silently degrades to a successful execution. Missing or
failed control organs must produce `needs_action`, `executed: false`, and a
receipt naming the unavailable boundary.

## Evidence Hierarchy

1. Current live semantic probe.
2. Current hash-chained receipt.
3. Current executable test.
4. Current source and configuration.
5. This runtime authority.
6. Historical plans and design documents.
7. Chat claims.

The current operational ledger is `ORANGE5_NOT_GREEN_LEDGER.md`. The canonical
full verifier is:

```powershell
powershell -ExecutionPolicy Bypass -File C:/AtomEons/Orange5/00-CHARTER/run-all-tests.ps1
```

## Explicit Holds

These are intentionally outside the active repair queue until the operator
releases them:

1. Custom Misfit/Gremlin model training and promotion.
2. Treating subscription products as unrestricted API endpoints.

Their existing deterministic policies, datasets, tests, and bounded runtime
paths may remain. Do not invent a completion claim or route around either hold.
