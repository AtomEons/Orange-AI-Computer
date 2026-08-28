<p align="center">
  <img src="assets/orange-ai-computer-hero.png" alt="Orange AI Computer control and compute nodes" width="100%">
</p>

<h1 align="center">Æ Orange AI Computer</h1>

<p align="center"><strong>A local-first intelligence operating layer for models, agents, memory, tools, and proof.</strong></p>

<p align="center">
  <img alt="Public preview" src="https://img.shields.io/badge/release-public_preview-ff6a00?style=for-the-badge">
  <img alt="Windows" src="https://img.shields.io/badge/platform-Windows-111111?style=for-the-badge">
  <img alt="Bun" src="https://img.shields.io/badge/runtime-Bun-111111?style=for-the-badge">
  <img alt="Proven package" src="https://img.shields.io/badge/package-PROVEN-2ea043?style=for-the-badge">
</p>

<p align="center">
  <a href="https://github.com/AtomEons/Orange-AI-Computer/releases/tag/wave-2-preview"><strong>Download the LLM deploy</strong></a>
  · <a href="OrangeFive-LLM-deploy.proof.json">Package proof</a>
  · <a href="proof/EVIDENCE_LEDGER.md">Evidence ledger</a>
  · <a href="docs/README.md">Manuals</a>
  · <a href="PREVIEW_STATUS.md">Preview status</a>
</p>

---

Æ Orange AI Computer turns one Windows computer, or a control computer plus a network AI box, into one governed intelligence system. Models are replaceable workers. Orange owns project truth, routing, memory, compression, tools, agents, receipts, and recovery.

The interface is not the intelligence. Use Orange through Codex, Claude Code, MCP, an OpenAI-compatible client, or the separately developed Atomic Orange app.

The public repository is the canonical launch object. Start with the
[Wave 2 brief](launch/WAVE_2_LAUNCH.md), inspect the
[evidence ledger](proof/EVIDENCE_LEDGER.md), and then visit
[Atom Eons](https://atomeons.com) for the wider body of work.

Active development is preserving the next operational-intelligence layer in the
[Wave 3 Full-Strength Treasury](docs/WAVE3_FULL_STRENGTH_TREASURY.md), with an
executable [Conservation Kernel](docs/CONSERVATION_KERNEL.md) and bounded
[STRONGARM discipline](docs/STRONGARM_DISCIPLINE.md). These development records
do not alter the preview package's receipt-backed status.

## Install Through An LLM

1. Download <code>OrangeFive-LLM-deploy.zip</code> from the [Wave 2 release](https://github.com/AtomEons/Orange-AI-Computer/releases/tag/wave-2-preview).
2. Extract it and open the folder in Codex or Claude Code.
3. Say: **Read <code>INSTALL_ORANGE.md</code> completely and install Orange AI Computer.**

The agent runs one command:

    bun scripts/llm-deploy/orange-deploy.mjs install

That invocation authorizes the complete deterministic install. Orange discovers hardware, selects one-computer or distributed topology, adopts compatible runtimes, installs missing approved components, configures AI clients, starts hidden services, verifies readiness, and records rollback state.

If Bun is absent, <code>ORANGE_START.cmd</code> performs the pinned bootstrap path and returns to the deploy engine.

## How Orange Thinks

    Operator / Codex / Claude / MCP client
                        |
                 orange.order.v1
                        |
            Brain MCP + Orange Navigator
                        |
         FLOW least-action orchestration
              /         |          \
       AE Cobra      Hermes       ToolMesh
       memory        agents       effectors
              \         |          /
              AtomSmasher compression
                        |
           evidence + receipt + rollback
                        |
                 orange.report.v1

| Organ | Responsibility |
|---|---|
| **OrangeBrain** | Holds project law and compiles decisions into executable orders. |
| **Navigator** | Selects reflex, local model, specialist, or heavy-compute paths. |
| **FLOW** | Keeps work moving through bounded, evidence-aware execution. |
| **Hermes** | Dispatches role-specific agents and durable work without hidden authority. |
| **AE Cobra** | Stores durable memory, recalls why, and surfaces prior failures. |
| **AtomSmasher** | Compresses context and work while preserving source truth. |
| **ToolMesh** | Exposes governed tools without model bypass. |
| **Receipts** | Prove actions, hashes, evidence, blockers, and rollback pointers. |
| **Compute Fabric** | Runs on one computer or discovers a Codexa-class compute node. |

## Operating Law

- One public product: **Æ Orange AI Computer**.
- Source evidence and receipts outrank model claims.
- Models wake by lease instead of occupying memory permanently.
- No model receives silent authority.
- No feature is green without its exact live proof.
- User memory, secrets, logs, and machine state remain outside the payload.
- Failed probes stay visible. Orange never translates a blocker into success.

## Package Proof

The Wave 2 deploy ZIP contains **2,492 hash-locked files** representing
**125,695,306 source payload bytes**. Packaging performed credential scanning,
archive path/size/hash verification, guarded clean extraction, wrong-approval
rejection, dry-run-before-mutation checks, apply/readiness proof, rollback,
data-preservation proof, and post-lifecycle payload verification.

    SHA-256
    f841f28d08a1e0fc8b4e7939b07faafc6ea6c90ae27a28cf9f3e5e16bff0e650

Machine-specific runtime behavior remains receipt-gated. [Preview Status](PREVIEW_STATUS.md) records the deliberately visible field-test limits.

## Documentation

| Reader | Start here |
|---|---|
| New operator | [Quick Start](docs/QUICK_START.md) |
| System operator | [Operator Manual](docs/OPERATOR_MANUAL.md) |
| Codex, Claude Code, or another coding model | [LLM Operator Guide](docs/LLM_OPERATOR_GUIDE.md) |
| Systems engineer | [Technical Architecture](docs/TECHNICAL_ARCHITECTURE.md) |
| Benchmark reviewer | [Proof and Benchmarks](docs/PROOF_AND_BENCHMARKS.md) |
| Skeptical reviewer | [Skeptic's Field Guide](docs/SKEPTICS_FIELD_GUIDE.md) |
| Memory researcher | [Memory and Learning](docs/MEMORY_AND_LEARNING.md) |
| Compression researcher | [AtomSmasher Production](docs/ATOMSMASHER_PRODUCTION.md) |
| Incident responder | [Troubleshooting and Recovery](docs/TROUBLESHOOTING_AND_RECOVERY.md) |

The complete Markdown and PDF knowledge pack is in [`docs/`](docs). Public
launch copy and the international distribution surface are in
[`launch/`](launch).

Launch material is also available in [Spanish, French, German, Brazilian
Portuguese, Hindi, Arabic, and Russian](launch/LANGUAGES_GLOBAL.md), plus
[Simplified Chinese, Japanese, and Korean](launch/LANGUAGES_EAST_ASIA.md).

## Repository Map

| File | Purpose |
|---|---|
| [AGENTS.md](AGENTS.md) | Installation and repair law for Codex and Claude Code. |
| [OrangeFive-LLM-deploy.proof.json](OrangeFive-LLM-deploy.proof.json) | Extracted package lifecycle proof. |
| [OrangeFive-LLM-deploy.report.json](OrangeFive-LLM-deploy.report.json) | Package inventory and verification report. |
| [OrangeFive-LLM-deploy.zip.sha256](OrangeFive-LLM-deploy.zip.sha256) | Download integrity sidecar. |
| [PREVIEW_STATUS.md](PREVIEW_STATUS.md) | Honest field-test status. |

---

<p align="center"><strong>Daybreak Blue × Atom Eons</strong><br>Intelligence with a memory, a method, and a receipt.</p>
