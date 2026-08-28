# Æ Orange AI Computer Status

**Evidence date:** 2026-08-28<br>
**Public posture:** current source available; bounded lab evidence; packaging
and integration work remains open.

**Wave 4A Green:** work-in-progress public source release. The edition name is
not a whole-system proof claim; live failures remain listed until repaired.

## Current Source

The current public implementation is the checked-in [`system/`](system/)
tree. It contains the control plane, memory, compression, execution, tool,
visual, model-role, receipt, integration, training, and Atomic Orange source.

Source presence is not a live-health claim. This status page does not claim
that a reader's services are installed, configured, authenticated, or ready.

## Public Evidence

The tracked [evidence ledger](proof/EVIDENCE_LEDGER.md) supports only its named
results and boundaries. It includes accepted receipts for a 10-lane lab run,
held-out memory and compact-context benchmarks, one bounded Brain MCP and Hermes
delegation, controlled recovery paths, a current-awareness order, and two
explicitly alpha experiments.

The latest tracked broad-verifier summary is **227 green test files and one red
operational-audit aggregate out of 228 discovered test files**. Whole-system
green is not claimed.

## Historical Package

The 2026-08-28 GitHub prerelease asset
`OrangeFive-LLM-deploy.zip` is a historical package, not a package of the
current `system/` tree. The tracked package records state:

- 2,489 files;
- 125,695,306 payload bytes;
- credential scan passed for that artifact;
- entry path, size, and SHA-256 archive verification passed;
- guarded extracted-payload apply, readiness, rollback, and data-preservation
  checks completed;
- SHA-256
  `f841f28d08a1e0fc8b4e7939b07faafc6ea6c90ae27a28cf9f3e5e16bff0e650`.

That proof used `deterministic-extracted-payload-no-external-mutation` mode. It
did not install or launch external Bun, Ollama, Hermes, model runtimes, model
weights, or other network services. Runtime and model readiness still require
live target-machine probes.

## Remaining Gaps

- Build and publish a current-source package with a new content lock, report,
  sidecar, extracted lifecycle proof, and release asset.
- Prove clean installation and rollback on independent machines and publish the
  hardware and operating-system matrix.
- Build, sign, package, and independently exercise Atomic Orange from the
  current public source, including bridge, streaming, cancellation, restart,
  and visible error-state paths.
- Validate optional models and external integrations on each target. The
  repository does not redistribute weights or credentials.
- Expand MCP and client coverage beyond the named lab paths.
- Resolve the tracked operational-audit aggregate before making a whole-system
  green claim.

A failed live probe remains a failure. Package hashes, source presence, process
start, HTTP status, and model output do not substitute for end-to-end evidence.
