# Æ Orange AI Computer Documentation Map

This directory is the canonical public manual set for Æ Orange AI Computer.
Markdown is source. Files under `pdf/` and `html/` are generated artifacts.

## Reading Paths

### I want to use Orange

1. [Quick Start](QUICK_START.md)
2. [Operator Manual](OPERATOR_MANUAL.md)
3. [Troubleshooting and Recovery](TROUBLESHOOTING_AND_RECOVERY.md)
4. [Atomic Orange Native App](ATOMIC_ORANGE_NATIVE_APP.md)

### I am a coding model with no prior memory

1. [LLM Operator Guide](LLM_OPERATOR_GUIDE.md)
2. [Technical Architecture](TECHNICAL_ARCHITECTURE.md)
3. [Memory and Learning](MEMORY_AND_LEARNING.md)
4. [Model Installation Guide](MODEL_INSTALLATION_GUIDE.md)

### I am reviewing the engineering claims

1. [Skeptic's Field Guide](SKEPTICS_FIELD_GUIDE.md)
2. [Proof and Benchmarks](PROOF_AND_BENCHMARKS.md)
3. [Receipts and Audit](RECEIPTS_AND_AUDIT.md)
4. [Features Guide](FEATURES_GUIDE.md)
5. [Bun Runtime](BUN_RUNTIME.md)
6. [AtomSmasher Production](ATOMSMASHER_PRODUCTION.md)
7. [Female Systems Design Innovations](FEMALE_SYSTEMS_DESIGN_INNOVATIONS.md)
8. [Wave 3 Full-Strength Treasury](WAVE3_FULL_STRENGTH_TREASURY.md)
9. [Conservation Kernel](CONSERVATION_KERNEL.md)
10. [STRONGARM Execution Discipline](STRONGARM_DISCIPLINE.md)

## Manual Set

| Manual | Purpose |
|---|---|
| `QUICK_START.md` | first safe health probe and order |
| `OPERATOR_MANUAL.md` | daily operation, routes, evidence, recovery |
| `LLM_OPERATOR_GUIDE.md` | zero-memory instructions for Codex, Claude, local models, and other clients |
| `TECHNICAL_ARCHITECTURE.md` | system boundaries, data flow, topology, and design rationale |
| `FEATURES_GUIDE.md` | capability inventory with evidence posture |
| `MODEL_INSTALLATION_GUIDE.md` | fixed-manifest, role-based model deployment |
| `BUN_RUNTIME.md` | why Bun owns the deterministic hot path |
| `SKEPTICS_FIELD_GUIDE.md` | falsifiable answers to likely technical objections |
| `PROOF_AND_BENCHMARKS.md` | exact evidence, metrics, denominators, and reproduction |
| `TROUBLESHOOTING_AND_RECOVERY.md` | diagnosis and bounded repair |
| `MEMORY_AND_LEARNING.md` | durable memory, retrieval, contradiction handling, and governed learning |
| `RECEIPTS_AND_AUDIT.md` | receipt meaning, precedence, chains, and independent audit |
| `ATOMIC_ORANGE_NATIVE_APP.md` | native operator surface, runtime crossing, states, and proof |
| `ATOMSMASHER_PRODUCTION.md` | production workbench reduction, cold truth, operation, and limits |
| `FEMALE_SYSTEMS_DESIGN_INNOVATIONS.md` | pre-1990 systems principles mapped to present and proposed architecture |
| `WAVE3_FULL_STRENGTH_TREASURY.md` | 100 preserved mechanisms and the no-weaker-version law |
| `CONSERVATION_KERNEL.md` | deterministic authority, custody, evidence, semantic, and uncertainty conservation |
| `STRONGARM_DISCIPLINE.md` | bounded execution pressure, verification handoff, and authority law |

Charter companion: [Wave 2 Captain's Log](../ORANGE_AI_COMPUTER_WAVE2_CAPTAINS_LOG.md).

## Evidence Authority

When documents conflict, use:

1. fresh semantic live probe;
2. fresh receipt for the exact path;
3. current executable test;
4. current source/configuration;
5. runtime authority;
6. historical plans;
7. chat claims.

A generated PDF never outranks its Markdown source. A manual never turns a
feature green.

## Rebuild HTML And PDF

```powershell
cd C:\AtomEons\Orange5
bun run docs:build
```

The build uses Bun's Markdown renderer and an installed Chrome or Edge headless
printer. It emits `00-CHARTER/GUIDES/manual-build-manifest.json` with SHA-256
hashes for every source and generated artifact.

## Editing Law

- Edit Markdown only.
- Keep machine-specific secrets and tokens out of documentation.
- Pin claims to a receipt and state what the receipt does not prove.
- Do not turn research, installation, or configuration into runtime claims.
- Rebuild generated artifacts after source changes.
