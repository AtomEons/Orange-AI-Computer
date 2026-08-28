# Æ Orange AI Computer Documentation

This directory is the public manual set for Æ Orange AI Computer. Markdown is
the canonical documentation source. PDFs are generated copies and never outrank
their Markdown or the evidence they cite.

## Start With Truth

1. [Current Source and Gaps](CURRENT_SOURCE_AND_GAPS.md)
2. [Historical Package](HISTORICAL_PACKAGE.md)
3. [Public status](../PREVIEW_STATUS.md)
4. [Public evidence ledger](../proof/EVIDENCE_LEDGER.md)

## Operate And Inspect

| Document | Purpose |
|---|---|
| [Quick Start](QUICK_START.md) | distinguish source checkout, historical package, and configured runtime |
| [Operator Manual](OPERATOR_MANUAL.md) | operate a configured system without confusing presence with proof |
| [LLM Operator Guide](LLM_OPERATOR_GUIDE.md) | exact instructions for a coding model working inside the source tree |
| [Technical Architecture](TECHNICAL_ARCHITECTURE.md) | boundaries, organs, data flow, and topology |
| [Features Guide](FEATURES_GUIDE.md) | capability inventory with status vocabulary |
| [Model Installation Guide](MODEL_INSTALLATION_GUIDE.md) | approval, provenance, acquisition, promotion, and rollback |
| [Troubleshooting and Recovery](TROUBLESHOOTING_AND_RECOVERY.md) | diagnosis and bounded repair |

## Review Claims

| Document | Purpose |
|---|---|
| [Proof and Benchmarks](PROOF_AND_BENCHMARKS.md) | metrics, denominators, receipts, and reproduction commands |
| [Receipts and Audit](RECEIPTS_AND_AUDIT.md) | proof states, precedence, and chain review |
| [Skeptic's Field Guide](SKEPTICS_FIELD_GUIDE.md) | falsifiable boundaries and objections |
| [Bun Runtime](BUN_RUNTIME.md) | deterministic runtime scope and bounded measurements |
| [Memory and Learning](MEMORY_AND_LEARNING.md) | retrieval, contradiction handling, and promotion limits |
| [AtomSmasher Production](ATOMSMASHER_PRODUCTION.md) | compact worksets, source hydration, and limits |
| [Atomic Orange Native App](ATOMIC_ORANGE_NATIVE_APP.md) | app ownership boundary and proof requirements |
| [Conservation Kernel](CONSERVATION_KERNEL.md) | source-present transition invariants without runtime promotion |
| [STRONGARM Discipline](STRONGARM_DISCIPLINE.md) | bounded execution pressure and verification handoff |
| [Systems Design Research](FEMALE_SYSTEMS_DESIGN_INNOVATIONS.md) | sourced research candidates, not implementation claims |
| [Alpha Adoption Ledger](GLOBAL_SYSTEMS_ALPHA_ADOPTION_LEDGER.md) | fact, candidate, archive, and reject boundaries |
| [AE Phase Fabric Paper](AE_PHASE_FABRIC_TECHNICAL_PAPER.md) | a specific experimental transport and its measured limits |

## Evidence Precedence

When documents conflict, use this order:

1. a current semantic live probe for the exact target;
2. a current receipt for the exact path;
3. a current executable test for the stated contract;
4. current source and configuration;
5. historical package records and plans;
6. prose claims.

A process start, HTTP 200, file presence, model response, screenshot, or build
success is not end-to-end proof unless the acceptance contract says it is.

## Preserved History

Planning and idea records using prior internal vocabulary are preserved under
[`docs/history/internal-development/`](history/internal-development/). They are
historical inputs, not current public naming, runtime authority, or proof.

## Build PDFs

From the repository root:

```powershell
bun docs/build-manuals.mjs
```

The builder writes only under `docs/pdf/` and updates
`docs/manual-build-manifest.json` with source and output SHA-256 values.

Internal compatibility names appear only where an exact path, schema, artifact,
or command requires them. The public product name is **Æ Orange AI Computer**.
