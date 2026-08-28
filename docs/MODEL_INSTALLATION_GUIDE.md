# Æ Orange AI Computer Model Installation Guide

Orange installs capabilities by role, not by collecting model names. The
released deploy payload is immutable. Hermes profiles, system configuration,
schemas, role definitions, and the component manifest ship pre-authored.

The installer may be guided entirely through an LLM conversation, but the LLM
has no authority to invent or edit the system. It only presents the fixed
manifest, records deselections, requests approval, and invokes the deterministic
Bun deploy engine.

OpenAI 5.6 or the strongest hosted coding agent available is the preferred
optional guide for a difficult setup. It is not required to run Orange.

## 1. Installation Contract

The installation conversation should feel automatic:

```text
read fixed manifest
-> discover hardware
-> inventory and adopt compatible existing runtimes and models
-> show the manifest's recommended selection
-> operator deselects optional roles
-> operator approves selected roles
-> automatically download missing approved components
-> deterministic install and configuration materialization
-> checksum and runtime verification
-> capability bakeoff
-> receipt
-> rollback information
```

The LLM explains and invokes. Bun, pinned PowerShell, package managers, and
runtime-specific tools execute exactly the pre-authored manifest.

## 2. Immutable Payload Boundary

The deploy engine must never mutate the shipped payload. It may verify its
hash, read templates, and copy machine-specific material into the data root.

All mutable data lives outside the payload:

```text
%USERPROFILE%\OrangeBox-Data\
  orange5\
    config\
    memory\
    receipts\
    logs\
    models\
    downloads\
    topology\
    rollback\
    secrets\
```

Exact subdirectories are owned by the deploy manifest. The LLM must not invent
a competing layout.

Compatible existing Bun, Ollama, model files, and tool installations are
adopted when their version, path, hash/revision, and runtime probe meet the
manifest. Adoption is receipt-backed and does not copy or replace working
components unnecessarily.

## 3. Approval Is Mandatory

No model download begins until the operator approves the exact role plan.

The fixed manifest view must contain:

- role and capability;
- exact model name, revision, and source;
- license and redistribution posture;
- target host;
- runtime backend;
- compressed download bytes;
- installed disk bytes and required free-space reserve;
- estimated peak live RAM and confidence in that estimate;
- maximum context and practical context target;
- checksum or immutable source revision;
- resumable download method;
- environment changes;
- proof and quality benchmark;
- uninstall and rollback commands.

The manifest supplies a recommended default selection. The operator can:

- approve all proposed roles;
- approve selected roles;
- replace a role;
- defer a role;
- opt out permanently for this installation.

An opt-out must leave the rest of Orange functional and record the unavailable
capability honestly. Deselection changes machine-local deployment state, not
the immutable manifest.

## 4. Deployment Profiles

### Preferred: N150 plus Codexa

Install no resident answer model on N150. Keep Bun control responsive. Put
Navigator, code, visual, creative, training, and long jobs on Codexa.

### One Windows computer

Keep Bun reflex, memory, receipts, and policy local. Use hardware discovery to
choose models that fit. Do not overcommit RAM to imitate the two-computer stack.
Optional hosted roles can fill gaps without becoming dependencies.

### Hosted-assisted

Use OpenAI 5.6 or the strongest hosted agent for setup, review, or an earned
frontier lease. Never give the hosted model direct receipt authority, stored
credentials, or unrestricted Orange internals.

## 5. Core Role Registry

Current runtime authority names these roles. A fresh inventory and route receipt
must confirm current availability.

| Role | Model or implementation | Preferred host | Residency |
|---|---|---|---|
| Reflex | Bun Navigator Kernel | control or single host | no model weights required |
| Navigator | `orange-navigator:ornith-1.5-9b-q4km` | compute host | lease-loaded when installed |
| Code | `qwen3-coder:30b` | compute host | bounded lease when installed |
| Visual description | `qwen3.8:27b-current` | compute host | bounded lease when installed |
| Visual retrieval | ColQwen2 Torch XPU worker plus Qdrant | compute host | configured role; probe required |
| Memory embedding | `qwen3-embedding:0.6b` where configured | compute host | utility role when installed |

The Q4_K_M Ornith row reflects checked-in runtime policy and one recorded lab
route. It is not proof of installation or present availability. Do not
substitute another model merely because it is installed. Historical receipts
keep the exact model identity they observed.

## 6. Creative Role Registry

Captain Planet enforces one heavy specialist and a 50 GiB live-memory ceiling.

### Installed and technically valid, studio quality unassessed

- FLUX.2 Klein 4B FP8: image draft/reference role.
- LTX-Video 2B 0.9.8 distilled: fallback image-to-video role.
- Qwen3-TTS 1.7B CustomVoice: speech role.
- ACE-Step 1.5 turbo: music role.

The 2026-08-27 integrated proof independently decoded the image/video artifacts,
verified motion, and measured non-silent speech/music with stable hashes. This
is technical validity only, not a human or model-reviewed studio-quality
promotion.

### Candidate only

- FLUX.2 Dev: quality image/edit tier.
- LTX-2.5 22B distilled: modern synchronized video/audio tier.
- Hunyuan3D 2.1: image-to-3D role.
- PaddleOCR-VL 1.6: document refinement role.
- SeedVR2 7B: image/video restoration role.

Candidate means no installation claim. It must not appear in an approved plan
without a license, size, memory, and bakeoff proposal.

## 7. Deterministic Planning

Before installation, run inventory and dry-run commands:

```powershell
Set-Location .\system
bun 03-BACKEND/spine-cli.mjs --health
bun 14-SUPERSTACK/captain-planet-governor.mjs catalog
bun 14-SUPERSTACK/captain-planet-governor.mjs dry-run --all
```

For the current creative source/environment bootstrap, use its planning mode
without `-InstallEnvironments`. Review the script and pinned commits before any
apply operation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\codexa-captain-planet-bootstrap.ps1
```

This verifies or stages source intent; it does not make candidate weights
active. Installation and artifact proof remain separate.

## 8. Download Requirements

Every download path must support:

- temporary partial files rather than overwriting the final artifact;
- resume after network interruption;
- byte count validation;
- SHA-256 or immutable revision validation;
- atomic rename after validation;
- bounded retries with visible errors;
- receipt with source, revision, bytes, hash, and destination;
- cleanup of only owned partial files;
- no automatic deletion of existing unowned models.

If an upstream does not publish a checksum, record the immutable repository or
model revision and hash the downloaded artifact locally before activation.

## 9. RAM And Storage Planning

Model storage and live memory are different.

- Disk can hold the library.
- RAM holds only the current route and required utility workers.
- Shared GPU memory consumes physical RAM.
- Unknown peak memory is denied for heavy creative promotion.
- Captain Planet's current heavy-lease ceiling is 50 GiB.
- Unload one heavyweight before loading another.

The plan must reserve room for the OS, Bun control, memory services, Docker,
receipts, and temporary model conversion files. Do not plan against total RAM
as though every byte were available to weights.

## 10. Installation Execution

After explicit approval:

1. Verify the immutable payload and fixed manifest hashes.
2. Freeze the approved selection and receipt its hash.
3. Adopt compatible existing components.
4. Create or verify machine-local target directories under OrangeBox-Data.
5. Download missing approved components with resume and partial-file discipline.
6. Verify checksum/revision.
7. Install the runtime environment from pinned inputs.
8. Materialize machine-local configuration from shipped templates.
9. Register the model by role without changing unrelated defaults.
10. Start it only under the declared lease.
11. Measure process-tree peak memory and latency.
12. Validate output schema or decode the produced artifact independently.
13. Run the capability-specific quality bakeoff.
14. Write install and promotion receipts separately.
15. Record rollback.

An install receipt proves installation. A promotion receipt proves the role.
They are not interchangeable.

## 11. Promotion Gates

A model role becomes active only after:

- exact inventory is observed;
- runtime starts on the target host;
- peak memory fits the approved limit;
- the expected report or artifact is independently validated;
- role-specific quality beats or matches the incumbent;
- false-green and offline behavior pass;
- rollback works;
- the operator approves promotion where required.

For Navigator and text roles, include:

- report-schema validity;
- routing correctness;
- hallucinated-tool rejection;
- Codexa-unavailable handling;
- latency and stability;
- project-scope retention.

For media roles, include decoded artifacts, content checks, quality review, and
proven memory usage. A generated file that opens is not studio-quality proof.

## 12. Rollback And Removal

- Keep the prior working role until the replacement passes.
- Demote by restoring the prior role mapping, not by deleting first.
- Delete only artifacts owned by the approved installation record.
- Preserve unowned Ollama models and user-created adapters.
- Keep install, bakeoff, promotion, demotion, and removal receipts.
- Never place private or abliterated operator-only models in a public release.

## 13. LLM-Guided Install Prompt

```text
Read docs\MODEL_INSTALLATION_GUIDE.md and docs\LLM_OPERATOR_GUIDE.md from the
repository root. Treat system\ as current source. Discover this computer and
any operator-approved reachable compute host.
Inventory runtimes, installed models, free disk, RAM, GPU/shared memory, and
network paths. Read the immutable fixed manifest; do not invent or edit any
component, profile, policy, schema, or system file. Present its recommended
selection with exact sources, revisions, licenses, download and installed
sizes, peak-RAM estimates, checksums, resume strategy, proofs, and rollback. I
may deselect optional roles. Do not download, install, remove, restart, or
promote anything until I explicitly approve the selected roles. After approval,
invoke the deterministic Bun deploy engine. It must adopt compatible existing
components and automatically download only missing approved components. Keep
all runtime state, secrets, memory, logs, receipts, and topology under
%USERPROFILE%\OrangeBox-Data. Return receipt paths. Keep Orange functional if I
opt out of any role.
```

## Related Guides

- [Quick Start](QUICK_START.md)
- [Operator Manual](OPERATOR_MANUAL.md)
- [Technical Architecture](TECHNICAL_ARCHITECTURE.md)
- [LLM Operator Guide](LLM_OPERATOR_GUIDE.md)
- [Features Guide](FEATURES_GUIDE.md)
