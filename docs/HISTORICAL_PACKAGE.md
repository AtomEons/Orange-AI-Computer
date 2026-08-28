# Æ Orange AI Computer Historical Deploy Package

This page records the prerelease deploy ZIP published on 2026-08-28. It is kept
for artifact integrity and reproducibility. It is not the current source
distribution.

## Exact Artifact

The release asset retains its legacy implementation filename:

```text
file: OrangeFive-LLM-deploy.zip
sha256: f841f28d08a1e0fc8b4e7939b07faafc6ea6c90ae27a28cf9f3e5e16bff0e650
files: 2489
payload bytes: 125695306
published: 2026-08-28T07:34:10Z
```

The repository tracks the matching report, proof record, and SHA-256 sidecar:

- `OrangeFive-LLM-deploy.report.json`
- `OrangeFive-LLM-deploy.proof.json`
- `OrangeFive-LLM-deploy.zip.sha256`

The old implementation name identifies those exact files. The public product
name is **Æ Orange AI Computer**.

## What The Package Records Prove

For that exact artifact, the report records a passed credential scan, source
snapshot verification, and archive entry-count, path, size, and SHA-256
verification. The extracted proof records:

- content-lock verification;
- rejection of wrong plan and invalid model-set approvals before mutation;
- all dry runs before extracted-payload mutation;
- apply status `APPLIED`;
- readiness status `READY` inside the proof harness;
- rollback status `ROLLED_BACK_DATA_PRESERVED`;
- preservation of the test sentinel;
- unchanged payload after rollback.

## What The Package Records Do Not Prove

The proof mode is `deterministic-extracted-payload-no-external-mutation` and
`externalMutation` is `false`. The proof explicitly excludes installing or
launching external Bun, Ollama, Hermes, model runtimes, model weights, and other
network services. It also does not prove upstream model availability or live
readiness on an arbitrary target.

The readiness result is therefore readiness inside the extracted package proof
contract, not proof of a complete real-machine AI stack.

## Why It Is Historical

The artifact was published before the repository's later current-system and
Atomic Orange source commits. The current [`system/`](../system/) tree contains
later source and is not covered by this ZIP's content hash, file count, or
lifecycle result.

Do not copy package numbers onto current source. Do not describe current source
as installable through this ZIP. A new current-source package needs a new lock,
hash, report, proof, and release asset.

## Historical Invocation

Inside the extracted historical package, the deterministic installer entry
point is:

```powershell
bun scripts/llm-deploy/orange-deploy.mjs install
```

That command still depends on approvals and live target-machine checks. It does
not inherit proof from the source now published under `system/`.
