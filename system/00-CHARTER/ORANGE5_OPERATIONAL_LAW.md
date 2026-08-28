# Orange5 Operational Law

Orange5 operational inventory must contain only capabilities that are live, callable, and receipt-backed.

## Operational Definition

A feature is `OPERATIONAL` only when all of these are true:

1. It has a real local entrypoint, service, command, or app lane.
2. It can be started or called on the current Orange5 system.
3. It has a fresh proof receipt or test log showing the expected behavior.
4. Its dependencies are either running or explicitly degraded with a truthful report.
5. The operator can use it without reading a concept document or manually assembling missing parts.

## Not Operational

These must not appear in the operational bucket:

- Concept notes
- Research candidates
- Scaffolds
- Mock-only paths
- Fixture-only tests
- Deferred model lanes
- Future integrations
- Docs that describe behavior not wired into a runnable command
- Services that exist in code but are not installed, reachable, or proofed

## Allowed Statuses

Every Orange5 feature must be classified as exactly one of:

- `OPERATIONAL`
- `DEGRADED_OPERATIONAL`
- `PACKAGED_UPGRADE`
- `RESEARCH_ARCHIVE`
- `REMOVED_FROM_SCOPE`
- `BLOCKED_NEEDS_OPERATOR_OR_HOST`

`CANDIDATE`, `PARTIAL`, `WORKING_WITH_WARNINGS`, and vague green language are not final statuses.

## Promotion Rule

Promotion to `OPERATIONAL` requires a receipt. Chat claims do not count.

Promotion receipt must include:

- feature id
- command or service entrypoint
- dependency status
- proof command or probe
- pass/fail result
- receipt path
- known limitations

## AE Eyes Rule

AE Eyes is operational only when the visual chain can actually see:

- image/screenshot/document input accepted
- visual service reachable
- visual analysis or indexing call returns a structured result
- result returns through Orange5 report or receipt path

Backend facade tests alone are not enough to claim AE Eyes fully operational.

## Service Rule

Required Orange5 services must run hidden/invisible by default. Visible PowerShell popup loops are a defect.

OBS is protected while streaming and must not be killed by cleanup actions.

## Current Execution Note

If the local command executor cannot return from trivial commands, live operational promotion is blocked until the host shell/session is healthy again. In that state, only file preparation can be performed honestly.
