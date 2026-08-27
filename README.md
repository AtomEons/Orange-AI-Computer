# Orange AI Computer

Orange AI Computer is the public Codex-deployable preview of **Orange release OrangeFive**.

It is a Windows-first, local-first intelligence operating layer that gives an AI coding agent a governed runtime for:

- Orange orders and structured reports
- OrangeBrain and least-action model routing
- Hermès agent orchestration
- AE Cobra durable memory and recall
- AtomSmasher compression
- FLOW execution control
- Brain MCP and OpenAI-compatible access
- Codexa or single-computer compute discovery
- ToolMesh execution
- receipts, rollback, and no-fake-green verification

The interface is not the intelligence. This release is the headless Codex deployment. Atomic Orange is developed separately and can connect to the same runtime.

## Install With Codex

1. Download `OrangeFive-LLM-deploy.zip` from the latest GitHub release.
2. Verify its SHA-256 using the attached `.sha256` file.
3. Extract the ZIP.
4. Open the extracted folder in Codex or Claude Code.
5. Tell the agent: `Read INSTALL_ORANGE.md completely and install Orange AI Computer.`

The normal agent command is:

```powershell
bun scripts/llm-deploy/orange-deploy.mjs install
```

Running `install` is the single installation authorization. The deploy engine discovers the machine, chooses one-computer or control-plus-compute topology, generates a hash-bound plan, installs or adopts approved components, configures clients, starts hidden services, verifies readiness, and records rollback state. It does not repeatedly stop for plan-hash prompts.

If Bun is absent, run `ORANGE_START.cmd`; it prints or performs the pinned bootstrap path and returns to the deploy engine.

## Release Proof

The preview package contains 2,386 locked files. Packaging verified every archive path, byte count, and SHA-256; scanned for high-confidence credentials; extracted into a guarded temporary root; proved wrong-hash rejection, dry-run-before-mutation, readiness, rollback, data preservation, and payload immutability.

Current package SHA-256:

```text
fd66fdf8d660d746bd5b5d00fd6bc65a9aebdd747376e2a3791d5bba9234f596
```

See `KNOWN_ISSUES.md`. This is a public preview, not a false final-green claim.
