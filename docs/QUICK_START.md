# Æ Orange AI Computer Quick Start

Start by identifying which object you have. The current source checkout, the
historical deploy ZIP, and an already configured runtime are not interchangeable.

## 1. Identify Your Object

### Current public source checkout

You cloned this repository and have a `system/` directory. This is the current
inspectable implementation. It is not yet accompanied by a current-source
package proof or clean-machine installation claim.

### Historical deploy ZIP

You downloaded the 2026-08-28 prerelease asset whose exact legacy filename is
`OrangeFive-LLM-deploy.zip`. Its hash and extracted lifecycle are recorded, but
it predates the current source and does not include Atomic Orange. Read
[Historical Package](HISTORICAL_PACKAGE.md) before invoking it.

### Configured runtime

An operator or installer already prepared services, models, credentials, and
machine-local state. Only this case supports meaningful live health and order
probes. A source checkout by itself is not a configured runtime.

## 2. Inspect Current Source

From the repository root:

```powershell
git status --short
Set-Location .\system
bun --version
```

Do not erase a dirty tree, install dependencies, acquire models, start services,
or change machine state until the exact plan and rollback are understood.

The source-level verifier entry point is:

```powershell
bun run verify
```

This is a source and test command, not an installer. The tracked public summary
for the latest broad run was 227 green test files and one red operational-audit
aggregate out of 228 discovered files. Environment-dependent checks may report
additional blockers on another machine.

## 3. Ask A Coding Agent To Inspect Safely

From the repository root, use this prompt:

```text
Read docs/LLM_OPERATOR_GUIDE.md and docs/CURRENT_SOURCE_AND_GAPS.md.
Treat system/ as current source. Inspect only. Do not install, download, delete,
restart, authenticate, or change machine state until you show the exact plan,
evidence requirements, and rollback, and I approve it.
```

The agent should first report source state, available runtimes, and blockers. It
must not translate file presence, a process start, or HTTP 200 into readiness.

## 4. Probe A Configured Runtime

Only after confirming that the current source has been configured for this
machine, run from `system/`:

```powershell
bun 03-BACKEND/spine-cli.mjs --health
bun 03-BACKEND/orange.mjs status
```

Read the semantic result. It should name route, host, blockers, and evidence.
Failure is a valid result and must remain visible.

For a read-only order, dry-run first:

```powershell
bun 03-BACKEND/spine-cli.mjs --order '{"action":"read.health","payload":{}}' --dry-run
bun 03-BACKEND/spine-cli.mjs --order '{"action":"read.health","payload":{}}'
```

On Windows, prefer a reviewed order file for complex JSON:

```powershell
bun 03-BACKEND/spine-cli.mjs --order-file C:\path\to\order.json
```

## 5. Historical Package Invocation

Inside the extracted historical ZIP, its installer entry point is:

```powershell
bun scripts/llm-deploy/orange-deploy.mjs install
```

That command applies only to the historical package. It does not install the
current `system/` tree. Review the fixed plan, target topology, downloads,
licenses, hashes, disk and memory requirements, credentials, proof commands,
and rollback before approval.

## 6. Status Words

- `PROVEN`: the referenced receipt or live probe supports the exact named path.
- `CONFIGURED`: source and configuration exist; execution proof is pending.
- `DEGRADED`: the path works only within a named limitation.
- `BLOCKED`: a required runtime, authority, resource, or proof is absent.
- `CANDIDATE`: research or planned work; not an active capability.

Documentation never turns a feature green. A package hash proves artifact
identity, not a live AI stack.

## Read Next

- [Current Source and Gaps](CURRENT_SOURCE_AND_GAPS.md)
- [Operator Manual](OPERATOR_MANUAL.md)
- [Features Guide](FEATURES_GUIDE.md)
- [Model Installation Guide](MODEL_INSTALLATION_GUIDE.md)
- [Proof and Benchmarks](PROOF_AND_BENCHMARKS.md)
