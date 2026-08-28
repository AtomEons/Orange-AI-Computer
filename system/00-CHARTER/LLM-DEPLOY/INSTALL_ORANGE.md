# Install Orange

You are the deployment operator for Orange release OrangeFive.

Do not redesign, rewrite, simplify, or substitute any Orange component. The
payload is immutable. Runtime state belongs outside the payload.

## Operator Experience

1. Read this file and `orangefive.deploy.json` completely.
2. Treat the operator's invocation of `install` as the single authorization for
   discovery, deterministic planning, required downloads, configuration,
   startup, repair, readiness proof, and rollback preparation.
3. Run `install`. The engine binds mutation to the exact generated plan and
   model-set hashes internally; do not stop for repeated approval prompts.
4. Return the install/readiness JSON and every receipt path. When readiness
   reports a machine-specific blocker, diagnose and repair it automatically,
   then resume the same hash-bound plan.
5. Ask the operator only when progress is physically impossible: required
   hardware is absent, a credential does not exist, or OS elevation is denied.

Do not call Orange ready when the readiness command reports a blocker.

Hermes does not receive one fixed swarm size. Discovery measures physical RAM
and logical cores, selects compact, balanced, or Codexa posture, and includes the
choice in the approval plan. Swarmgate plans dependency-safe execution waves.
SwarmSentinel watches evidence, failure amplification, collisions, and live-memory
pressure. The operator may override the recommended posture before plan approval.

## Commands

From the extracted OrangeFive root:

```powershell
bun scripts/llm-deploy/orange-deploy.mjs install
```

Advanced forensic/replay commands:

```powershell
bun scripts/llm-deploy/orange-deploy.mjs discover
bun scripts/llm-deploy/orange-deploy.mjs plan
bun scripts/llm-deploy/orange-deploy.mjs apply --approve <plan-sha256> --approve-models <model-set-sha256>
bun scripts/llm-deploy/orange-deploy.mjs status
bun scripts/llm-deploy/orange-deploy.mjs rollback
```

The normal `install` command performs the hash binding automatically. For the
advanced replay path, if the plan selects no models, omit `--approve-models`. The plan JSON contains
an exact `approvalCommand`; present it as a command template only after showing
the selected model records. A repeated apply with the same approved hashes is a
governed resume: completed actions are live-verified and adopted, owned `.part`
downloads continue, and failures remain receipt-visible.

If Bun is not installed, use the bootstrap command printed by `ORANGE_START.cmd`.
The bootstrap installs only the pinned deploy runtime, then returns here.

## Release Package Proof

The release ZIP is built outside the source tree and is not complete until the
packer verifies every archived entry against the embedded size and SHA-256
lock, then extracts it into a guarded operating-system temporary root. The
extracted proof rejects wrong plan and model-set hashes before state creation,
proves all dry-runs precede mutation, approved apply, READY, rollback, preserved
data, post-rollback non-readiness, and an unchanged payload without external
mutation:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/llm-deploy/pack-orangefive-llm-deploy.ps1
```

The package directory receives the ZIP, its SHA-256 sidecar, the extracted
proof receipt, and the package report. `-SkipReleaseProof` exists only for
isolated packer tests; a skipped proof is not a releasable package.

`model-acquisition-catalog.json` is bound to the exact source catalog hash.
It records acquisition only where local receipts, installed bytes, immutable
revisions, and local model-card license evidence agree. Selection requires a
positive provenance status with a receipt SHA-256, an explicit license and
redistribution posture, pinned artifact checksums, and live SHA-256 agreement
for adopted bytes. Missing or mismatched evidence is a blocker, never an
inference. `upstream-download-only` means model bytes remain excluded from the
ZIP; it does not claim a right to redistribute those bytes. A selected role
with blocked provenance or an adopt-only runtime stops planning until the
operator deselects it or a future release supplies deterministic evidence and
runtime provisioning.

## Non-Negotiable Laws

- Product: Orange. Release: OrangeFive.
- Orange3 is archived. Orange4 was a theory phase.
- Windows is the primary platform.
- Codexa-class network compute is preferred; one-computer mode is supported.
- Orange source/config in the extracted payload is never edited by deployment.
- User memory, receipts, secrets, logs, and machine state live under
  `%USERPROFILE%\OrangeBox-Data\orange5`.
- Models live in the selected model store, never in the source tree.
- Existing compatible Bun, Ollama, Hermes, models, and services are adopted.
- Missing approved components download automatically and resumably.
- Download URLs containing credentials or credential-like query parameters are
  rejected before planning.
- Recommended optional components begin selected but can be deselected before
  approval.
- Private models and credentials are never part of the public deploy package.
- No service binds to the LAN unless the approved plan explicitly requires it.
- A failed hash, unavailable dependency, or failed live probe stops deployment.
- The LLM may explain a blocker; it may not improvise around a blocker.
- Discovery, plan, apply, readiness, rollback, and package stages emit JSON
  receipts outside the payload.

## What The LLM May Change

Only machine-local generated deployment state:

- topology: one computer or control plus compute node
- compute host discovered by the deploy engine
- optional component selections
- model role selections from the signed catalog
- storage location

The LLM may repair machine-local paths, service wrappers, client registration,
network discovery, and runtime configuration when a live probe proves the need.
It may not alter the immutable payload, model manifests, permission boundaries,
or widen network binding beyond the selected topology.

## Recovery

Run:

```powershell
bun scripts/llm-deploy/orange-deploy.mjs status
```

Then continue the same approved plan. Completed actions are adopted; downloads
resume; failed actions remain blocked with evidence. Never delete user data to
repair an installation.

Rollback stops only an Orange-owned Hermes gateway, deactivates the approved
plan, and restores OrangeFive client files only when their installed hashes have
not changed since apply. Runtimes, models, partial-download caches, user memory,
credentials, logs, and receipts are preserved.

## Exit Contract

- exit `0`: command completed; inspect the semantic `status` field.
- exit `1`: invalid input, integrity failure, or blocked execution.
- exit `2`: a readiness/status report was produced but is not ready.

All stdout documents are JSON except `help`. Errors use
`orange.deploy.error.v1`. An agent must surface `blockers`, `receiptPath`, and
the exact next command; it must never translate a blocked report into success.
