<p align="center">
  <img src="assets/orange-ai-computer-hero.png" alt="Æ Orange AI Computer control and compute nodes" width="100%">
</p>

<h1 align="center">Æ Orange AI Computer</h1>

<p align="center"><strong>Local-first AI operations with explicit authority, inspectable evidence, and receipts.</strong></p>

<p align="center">
  <img alt="Source available" src="https://img.shields.io/badge/source-current-2ea043?style=for-the-badge">
  <img alt="Windows first" src="https://img.shields.io/badge/platform-Windows_first-111111?style=for-the-badge">
  <img alt="Evidence status bounded" src="https://img.shields.io/badge/evidence-bounded-ff6a00?style=for-the-badge">
</p>

<p align="center">
  <a href="docs/CURRENT_SOURCE_AND_GAPS.md"><strong>Current source and gaps</strong></a>
  · <a href="proof/EVIDENCE_LEDGER.md">Public evidence</a>
  · <a href="docs/QUICK_START.md">Quick start</a>
  · <a href="PREVIEW_STATUS.md">Status</a>
</p>

---

> **Work in progress:** Æ Orange AI Computer is being built in public. The
> source is available now for inspection, experimentation, and contribution;
> current gaps stay visible until live evidence closes them.

Æ Orange AI Computer is a local-first control plane for operating models,
memory, tools, bounded agents, and compute. Models may propose or perform work
inside an approved path; deterministic code owns scope, policy, execution
state, verification, and receipt authority.

This repository contains current source, selected public evidence, and public
manuals. Those are different evidence classes. Source proves that an
implementation is present. A receipt proves only the named observation it
records. Neither proves that an arbitrary computer is installed, integrated,
or ready now.

## What Is Current

The current inspectable source is [`system/`](system/). It was published after
the separately released deploy ZIP and includes later control-plane, native-app,
research, and integration work. The source tree is the object to review for the
current implementation; the older ZIP is not a current-source snapshot.

| Public object | What it establishes | What it does not establish |
|---|---|---|
| [`system/`](system/) | Current source and checked-in configuration exist | Services are live, dependencies are installed, or every path is green |
| [`proof/`](proof/) | The named lab runs produced the tracked results | Universal performance, third-party reproduction, or present machine health |
| [Historical deploy record](docs/HISTORICAL_PACKAGE.md) | One prerelease ZIP passed its recorded package lifecycle | That ZIP contains current `system/` source or launched external runtimes and models |
| [`docs/`](docs/) | Public operating and review guidance | A manual cannot promote a feature or close an integration gap |

## Current Organs

These organs are present in current source. Their names describe ownership
boundaries, not a blanket runtime-status claim.

| Organ | Current source | Responsibility |
|---|---|---|
| Charter and doctrine | [`system/00-CHARTER`](system/00-CHARTER), [`system/01-DOCTRINE`](system/01-DOCTRINE) | Authority, safety, runtime policy, and operator contracts |
| Control spine | [`system/03-BACKEND`](system/03-BACKEND), [`system/04-CONTROL-PLANE`](system/04-CONTROL-PLANE) | Orders, durable runs, routing decisions, recovery, and completion boundaries |
| Flow and gateway | [`system/05-FLOW`](system/05-FLOW), [`system/06-ORANGELLM`](system/06-ORANGELLM) | Work scheduling and OpenAI-compatible model access |
| Memory and compression | [`system/06-ORANGELLM/memory`](system/06-ORANGELLM/memory), [`system/12-ATOMSMASHER`](system/12-ATOMSMASHER) | Retrieval, continuity, compact worksets, and source hydration |
| Bounded execution and tools | [`system/08-HERMES`](system/08-HERMES), [`system/13-TOOLMESH`](system/13-TOOLMESH) | Governed actions, tool adapters, and authorization gates |
| Visual and model roles | [`system/07-VISUAL`](system/07-VISUAL), [`system/14-SUPERSTACK`](system/14-SUPERSTACK) | Visual evidence and lease-governed specialist roles |
| Atomic Orange | [`system/ATOMICORANGE`](system/ATOMICORANGE) | Optional native operator application source |
| Schemas and receipts | [`system/09-SCHEMAS`](system/09-SCHEMAS), [`system/10-RECEIPTS`](system/10-RECEIPTS) | Contracts, proof artifacts, and audit chains |
| Integrations and training | [`system/15-INTEGRATIONS`](system/15-INTEGRATIONS), [`system/16-TRAINING`](system/16-TRAINING) | Client bridges, infrastructure adapters, evaluation, and promotion work |

The product remains usable in a headless design; Atomic Orange is an operator
surface, not the owner of memory, policy, execution, or proof.

## What Public Evidence Proves

The tracked [Public Evidence Ledger](proof/EVIDENCE_LEDGER.md) reports bounded
results for named runs, including:

- a 10-lane lab suite accepted 10/10 lanes in its recorded two-computer run;
- a 23-case retrieval benchmark recorded MRR `0.9058`;
- a five-case Context Crystal benchmark preserved its required answers and
  source pointers on the recorded held-out corpus;
- one bounded Brain MCP and Hermes filesystem-read delegation completed its
  authorization, child action, synthesis, receipt, and lease-revocation path;
- controlled Fixer and link-recovery runs completed for their named injected
  failures;
- the latest tracked whole-repository summary found 228 test files, with 227
  green and one red operational-audit aggregate.

These are not claims of general intelligence, universal compression,
arbitrary autonomy, studio-quality media, cross-platform readiness, or a fully
green product.

## Historical Deploy ZIP

The GitHub prerelease published on 2026-08-28 contains the legacy-named asset
`OrangeFive-LLM-deploy.zip`. The tracked report records 2,489 files,
125,695,306 payload bytes, and this SHA-256:

```text
f841f28d08a1e0fc8b4e7939b07faafc6ea6c90ae27a28cf9f3e5e16bff0e650
```

Its extracted-payload proof exercised guarded planning, apply, readiness,
rollback, data preservation, and payload re-verification without external
mutation. The proof explicitly did **not** install or launch Bun, Ollama,
Hermes, external services, model runtimes, or model weights. See the
[historical package record](docs/HISTORICAL_PACKAGE.md) before using it.

## Open Gaps

- No current-source deploy ZIP, package proof, and release asset are published
  together yet.
- The historical ZIP is headless and predates current `system/` and Atomic
  Orange source.
- Atomic Orange source is present, but no signed current-source installer or
  independent public end-to-end app proof is published here.
- Models, credentials, optional runtimes, and external services are not bundled;
  availability, licensing, download, and target-machine readiness remain live
  gates.
- Public integration evidence comes from named Atom Eons lab runs. Arbitrary
  hardware, other operating systems, external MCP clients, and third-party
  reproduction remain open coverage.
- The tracked broad verifier is not wholly green.

The detailed register is in [Current Source and Gaps](docs/CURRENT_SOURCE_AND_GAPS.md).

## Documentation

| Need | Document |
|---|---|
| Understand source, evidence, and gaps | [Current Source and Gaps](docs/CURRENT_SOURCE_AND_GAPS.md) |
| Inspect the old package boundary | [Historical Package](docs/HISTORICAL_PACKAGE.md) |
| Start from current source | [Quick Start](docs/QUICK_START.md) |
| Operate a configured system | [Operator Manual](docs/OPERATOR_MANUAL.md) |
| Review architecture | [Technical Architecture](docs/TECHNICAL_ARCHITECTURE.md) |
| Audit claims | [Proof and Benchmarks](docs/PROOF_AND_BENCHMARKS.md) |
| Diagnose failures | [Troubleshooting and Recovery](docs/TROUBLESHOOTING_AND_RECOVERY.md) |

Internal compatibility names still appear inside exact filenames, paths,
schemas, and commands. They are implementation identifiers, not public product
or release names.

---

<p align="center"><strong>Æ Orange AI Computer</strong><br>Built by Atom Eons.</p>
