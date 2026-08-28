# OrangeFive Eight-Hour Optimization Report

Date: 2026-08-26

Scope: live OrangeFive control, inference, memory, learning, agent, visual,
compression, observability, current-awareness, and two-computer execution paths.

## Verdict

The OrangeFive backend is materially faster, more truthful, and more complete
than it was at the start of this campaign. The final source verifier is 163/163.
The live 15-turn Navigator reliability gate is green with zero false-green
reports. All measured service health targets pass. Memory quality passes 23/23.
The authenticated Codexa command rail executed `hostname` and returned `CODEXA`
with a remote receipt.

This document does not declare the entire product released. Atomic Orange native
product closure and one AE Eyes human-grade recognition miss remain open. Those
items are listed explicitly below.

## Final Live Topology

| Organ | Endpoint | Final state |
|---|---:|---|
| OrangeLLM gateway | `127.0.0.1:1337` | live |
| AE Cobra memory | `127.0.0.1:7419` | live |
| Hermes | `127.0.0.1:7430` | live |
| AtomSmasher | `127.0.0.1:8901` | live |
| AE Eyes | `127.0.0.1:7440` | live |
| Qdrant | `127.0.0.1:6333` | live |
| Codexa Ollama tunnel | `127.0.0.1:11437` | live |
| Codexa Navigator tunnel | `127.0.0.1:11436` | live |
| Codexa command rail | `10.0.0.4:8097` | authenticated and verified |

Final selected models:

- Navigator: `orange-navigator:7b` through llama.cpp/Vulkan on Codexa.
- Code specialist: `qwen3-coder:30b` through Ollama on Codexa.
- Heavy reasoner: `qwen3:30b-a3b` through Ollama on Codexa.
- N150: deterministic Bun control and service plane. It does not need a resident
  answer model for normal operation.

## What Changed

### Truth and governance

- Replaced the marker-only adversarial pass with a real refuter result and
  explicit verification-action requirement.
- Prevented recursive refuter invocation.
- Added deterministic mutation holds so a model cannot report source changes
  without executor evidence.
- Added requested-route versus effective-route truth to every governed turn.
- Kept model output advisory. Bun owns schema, order identity, action evidence,
  repair, and receipt provenance.
- Moved learning ingestion off the critical response path into a durable SQLite
  queue and verified completed ingestion after each reliability turn.

### Least-action routing

- Removed ambient pressure as authority to promote a model tier.
- Made the smallest risk- and capability-sufficient lane the absolute tier
  choice. Warmth and queue pressure remain scheduling telemetry only.
- Made visual capability depend on an actual image modality rather than words
  such as `screenshot` in ordinary discussion.
- Replaced substring code detection with boundary-aware lexical detection.
  `Codexa` can no longer be misread as `code`.
- Added regression tests for pressure, warmth, visual modality, and the Codexa
  lexical collision.

### Specialist inference

- Pulled and measured `qwen3-coder:30b` on Codexa.
- Built an executable specialist bakeoff using restricted `node:vm` and hidden
  assertions instead of judging model prose.
- Ran the hardened bakeoff twice. Qwen3-Coder passed 3/3 both times; the general
  Qwen3 and Navigator baselines passed 1/3.
- Added a serialized specialist lease manager with bounded preload, `15m`
  keep-alive, resident verification, prewarm, and no duplicate load jobs.
- Added adaptive context sizing: 4096 for short code work, 8192 for medium work,
  16384 for large work, and a 32768 ceiling.
- Verified prefix-cache reuse: the first governed code turn paid prompt setup;
  the second same-prefix governed turn completed in 2.305 seconds.

### Memory, learning, and continuity

- Added source-backed semantic retrieval and citations to AE Cobra.
- Added semantic index and cache metadata while retaining Reality as the
  authoritative source.
- Added project knowledge ingestion, durable mission state, MCP Tasks, traces,
  and resumable cross-organ missions.
- Verified 12/12 durable mission checks. Resume is about 100 ms versus roughly
  16-20 seconds for the initial run.
- Fixed memory telemetry pollution so benchmark and health chatter do not
  displace useful project evidence.
- Added exact equation reconstruction to AtomSmasher using residuals and raw
  identity proof.

### Current awareness and research

- Added a current-awareness evidence packet with expiry, source count, hashes,
  and candidate ranking.
- Final packet: 12 current sources and 60 candidates.
- Candidates remain benchmark-required. Discovery is not promotion.

### Observability and operations

- Added stage timing for harness, prompt budget, route, inference, compile,
  finalize, and total turn time.
- Added trace storage and OpenTelemetry-compatible pull/export surfaces.
- Added operator observability routes.
- Added system, Navigator, memory, specialist, and durable mission benchmarks.
- Added compute-fabric discovery and explicit physical-node identity.
- Fixed a production-state mutation bug: health discovery now uses
  `persist:false`, so tests and health probes cannot overwrite live model
  selections.
- Refreshed the live compute fabric and verified the authenticated command rail.

### Hermes, AE Eyes, and AtomSmasher

- Ran the Hermes suite and kept agent leases bounded by LOOM and receipts.
- Fixed optional AE Eyes channel handling and strengthened structural identity
  retrieval.
- Kept the AE Eyes human-grade claim honest at 15/16 instead of renaming it
  green.
- Ran AtomSmasher full-scope proof at 56/56 and retained exact reconstruction,
  replay, concurrency, codec, and storage checks.

## Benchmark Results

### Full source verifier

Final: **163 green / 0 red** test files.

Command:

```powershell
bun run verify
```

### Live Navigator reliability

Final receipt:

`10-RECEIPTS/orange5-build/2026-08-26T11-00-44-955Z-navigator-reliability-benchmark.json`

| Measure | Final |
|---|---:|
| Trials | 15/15 green |
| False-green reports | 0 |
| Contract validity | 100% |
| Route-truth validity | 100% |
| Semantic validity | 100% |
| Learning jobs verified | 15/15 |
| Mean latency | 7.253 s |
| P50 latency | 7.430 s |
| P95 latency | 8.639 s |
| Maximum latency | 8.639 s |

The failed pre-fix run had p95 88.392 seconds because `Codexa` was interpreted
as code work and activated the 30B specialist. Final p95 is 90.2% lower.

### System performance

Final receipt:

`10-RECEIPTS/orange5-build/2026-08-26T11-02-09-813Z-system-performance-benchmark.json`

Status: `PERFORMANCE_TARGETS_MET`

| Measure | Final p95 |
|---|---:|
| Gateway health | 54.45 ms |
| Cobra health | 46.19 ms |
| Hermes health | 4.51 ms |
| AtomSmasher health | 21.41 ms |
| AE Eyes health | 113.23 ms |
| Qdrant health | 71.25 ms |
| Codexa Ollama health | 94.01 ms |
| Navigator health | 167.83 ms |
| Semantic recall | 301.66 ms |
| Deterministic routing | 19,999 routes/s |

### Memory quality

Status: `MEMORY_QUALITY_GREEN`

| Measure | Final |
|---|---:|
| Cases | 23/23 |
| Mean reciprocal rank | 0.9058 |
| P50 | 272 ms |
| P95 | 451 ms |
| Maximum | 554 ms |

Covered categories include failure recall, topology, governance, learning,
operations, routing, execution, interfaces, agents, vision, durability, and
abstention.

### Codexa command proof

- Status: `VERIFIED`
- Exit code: 0
- Remote stdout: `CODEXA`
- Remote machine: `CODEXA`
- Receipt:
  `C:\AtomEons\ai-box\receipts\orangebox-command-rail-command-2026-08-26T11-03-29-719Z.json`

## Negative Results That Drove Fixes

No failed run was rewritten as green:

- Specialist bakeoff initially failed Qwen3-Coder 0/3 because the output
  contract accepted declarations while the executor required expressions. The
  contract was made explicit and machine-executable; two later runs passed 3/3.
- A visual-discussion reliability turn was incorrectly sent to a heavy lane and
  timed out. Routing now checks actual modalities.
- Reliability was functionally 15/15 but latency-red twice because runtime
  pressure and then model warmth could promote tier. Both authorities were
  removed from tier selection.
- Reliability remained latency-red once because `Codexa` matched `code` by
  substring. Boundary-aware code intent fixed it.
- The full verifier rewrote live compute-fabric state through a health call.
  Health discovery is now non-persistent and covered by a regression test.

## Industry Re-evaluation

OrangeFive now has direct equivalents for several current agent-system best
practices:

- Eval-driven development with executable hidden assertions, repeated live
  reliability runs, and explicit negative receipts.
- Durable agent work through SQLite mission state, resumable runs, and MCP Tasks.
- Structured tracing and OpenTelemetry-compatible export.
- Tool contracts, bounded leases, action evidence, and non-model execution law.
- OpenAI-compatible model serving while keeping the Orange harness structurally
  in front of every normal turn.
- Prompt-prefix reuse, adaptive context, bounded specialist residency, and a
  small always-hot Navigator.

Primary current references used for comparison:

- OpenAI Agents tracing, guardrails, and testing:
  <https://openai.github.io/openai-agents-python/tracing/>
  <https://openai.github.io/openai-agents-python/guardrails/>
  <https://openai.github.io/openai-agents-python/testing/>
- Anthropic eval, tool-design, and long-running harness guidance:
  <https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents>
  <https://www.anthropic.com/engineering/writing-tools-for-agents>
  <https://www.anthropic.com/engineering/harness-design-long-running-apps>
- MCP Tasks and protocol evolution:
  <https://modelcontextprotocol.io/extensions/tasks/overview>
  <https://blog.modelcontextprotocol.io/posts/2026-07-28-release-candidate/>
- OpenTelemetry generative-AI semantic conventions:
  <https://opentelemetry.io/docs/specs/semconv/registry/attributes/gen-ai/>
- Restate durable-agent patterns:
  <https://docs.restate.dev/ai/patterns/durable-agents>
- Ollama model residency and usage telemetry:
  <https://docs.ollama.com/faq>
  <https://docs.ollama.com/api/usage>
- Qwen3-Coder distribution:
  <https://ollama.com/library/qwen3-coder>

## What Is Still Not Green

1. **AE Eyes human-grade recognition:** 15/16. `fruits.jpg` remains the honest
   miss. The service and deterministic structural paths are live, but the broad
   human-grade claim is not closed.
2. **Atomic Orange native product closure:** this campaign optimized the
   intelligence and operations plane. It did not prove the complete native
   install/update/product journey required by the broader active goal.
3. **OTLP push collector:** traces are stored and exportable, but no always-on
   OTLP collector was proven. The implemented pull/export path is real.
4. **Long endurance:** 15 live turns and the full source verifier are green;
   this is not a substitute for multi-day unattended soak and fault injection.
5. **Research auto-promotion:** current tools are discovered and ranked, but
   candidates correctly require local install, benchmark, and receipt before
   adoption.
6. **Repository integration:** this was a dirty pre-existing worktree. No user
   work was reverted, and this campaign did not commit or push the accumulated
   changes.

## Next Highest-Value Work

1. Close the single AE Eyes human-grade miss with a falsifiable recognition
   improvement and rerun the full 16-case sweep.
2. Run the Atomic Orange native install, update, launch, and governed chat path
   as one end-to-end release proof.
3. Add an OTLP collector only if it improves diagnosis over the current compact
   local trace store without imposing N150 overhead.
4. Run an extended mixed-load soak with injected tunnel, model, memory, and rail
   failures; require zero false green and bounded recovery time.
5. Commit durable source separately from generated benchmark and runtime state,
   then push only after a clean review of the existing dirty worktree.

## Final Evidence Index

- Reliability:
  `10-RECEIPTS/orange5-build/2026-08-26T11-00-44-955Z-navigator-reliability-benchmark.json`
- System performance:
  `10-RECEIPTS/orange5-build/2026-08-26T11-02-09-813Z-system-performance-benchmark.json`
- Specialist bakeoff repeat 1:
  `10-RECEIPTS/orange5-build/2026-08-26T10-31-06-304Z-specialist-code-bakeoff.json`
- Specialist bakeoff repeat 2:
  `10-RECEIPTS/orange5-build/2026-08-26T10-33-01-951Z-specialist-code-bakeoff.json`
- Codexa rail:
  `C:\AtomEons\ai-box\receipts\orangebox-command-rail-command-2026-08-26T11-03-29-719Z.json`
- Compute fabric:
  `C:\Users\a\OrangeBox-Data\orange5\compute-fabric.json`

The interface remains replaceable. The intelligence is the governed OrangeFive
system behind it: deterministic control, scoped model cognition, durable
memory, bounded agents, evidence-backed execution, compression, and receipts.
