# Æ Orange AI Computer Quick Start

Orange is a local-first AI computer control plane. Æ Orange AI Computer is the current
release. It connects project memory, models, agents, visual workers,
compression, deterministic policy, and receipts into one governed system.

You do not need to understand every subsystem to begin. The interface can be
Atomic Orange, Codex, Claude, Hermes, or another compatible client. The
interface is not the intelligence. The Orange backend remains the authority.

## Current Truth Pin - 2026-08-28

- Live primary: `orange-navigator:ornith-1.5-9b-q4km` on authenticated Codexa
  `10.0.0.4`; Q8 is retired from current authority and remains historical evidence.
- Brain MCP: 10 stdio tools and 12 authenticated loopback HTTP tools.
- Accepted integrated proof: green at
  `10-RECEIPTS/orange5-build/2026-08-28T03-42-45-242Z-integrated-operational-proof.json`.
- Blue Bench: 10/10 exact-path lanes accepted at
  `10-RECEIPTS/orange5-build/2026-08-28T03-40-44-768Z-blue-bench.json`.
- Context Crystal: 5/5 held-out parity, minimum `1422.901x` across a
  7,056,795-byte corpus.
- Memory: 23/23 cases, hybrid MRR `0.9058`, p50 `281 ms`, p95 `445 ms`.
- Media: technically valid artifacts; studio quality is not certified.
- Hermes Brain MCP delegation: fresh governed parent execution, child report,
  child receipt, synthesis, and lease revocation passed all ten checks in
  `11,409.53 ms`; receipt
  `10-RECEIPTS/orange5-build/2026-08-28T04-13-22-203Z-brain-mcp-delegation-live-proof.json`.

Read `..\ORANGE5_NOT_GREEN_LEDGER.md` for remaining path-specific work; a green
receipt closes only the exact contract it names.

## Choose A Setup

### Preferred: two computers

- Control computer: runs Bun, the Orange spine, receipts, and your client.
- Codexa: runs the Orange Navigator, heavy code and visual models, Docker,
  training, and long jobs.

This is the preferred setup because heavy models do not compete with the
operator experience for memory or CPU.

### Supported: one computer

Orange can run on one Windows computer. The deterministic Bun reflex, orders,
reports, receipts, memory, and policy do not require a resident language model.
Install only the model roles that fit the machine. Heavy roles can remain
disabled or use an optional hosted lease.

Generic one-computer clean-install proof is still a release verification item.
Do not assume every model fits every machine.

## The Simplest Start

1. Open a strong coding agent such as Codex, Claude, or the strongest hosted
   agent available to you.
2. Give it this exact instruction:

```text
Read C:\AtomEons\Orange5\00-CHARTER\GUIDES\LLM_OPERATOR_GUIDE.md.
Then inspect Æ Orange AI Computer health. Do not install, download, delete, restart, or
change anything until you show me the exact plan and receive my approval.
```

3. The agent should run:

```powershell
cd C:\AtomEons\Orange5
bun 03-BACKEND/spine-cli.mjs --health
bun 03-BACKEND/orange.mjs status
```

4. Read the result. A port or HTTP 200 is not enough. The semantic status must
   identify the working organ, active route, and blockers.
5. If a model is missing, the agent should offer a role-by-role plan. You may
   approve all, approve selected roles, or opt out of any role.

OpenAI 5.6 or the strongest hosted coding agent is a useful optional setup and
frontier lease when available. It is never an Orange dependency.

## Your First Safe Order

Use a dry run first:

```powershell
cd C:\AtomEons\Orange5
bun 03-BACKEND/spine-cli.mjs --order '{"action":"read.health","payload":{}}' --dry-run
```

Then run the real read-only order:

```powershell
bun 03-BACKEND/spine-cli.mjs --order '{"action":"read.health","payload":{}}'
```

On Windows, an order file is safer than complex inline JSON:

```powershell
bun 03-BACKEND/spine-cli.mjs --order-file C:\path\to\order.json
```

## What Automatic Model Setup Means

Orange presents a fixed, payload-authored deployment manifest. The LLM may
explain the manifest, but it must not invent components, edit Orange, rewrite
Hermes profiles, or create a new installation plan.

The deploy engine discovers compatible existing Bun, Ollama, model, and tool
installations and adopts them without replacing working copies. It shows a
recommended default selection. You may deselect any optional role before
approval. After approval, missing selected components download automatically.

Before approval, the fixed manifest view must show:

- role and exact model revision;
- source and license posture;
- target computer and runtime;
- download size and free disk requirement;
- estimated live RAM and the lease ceiling;
- checksum or immutable revision;
- resume behavior;
- proof command;
- rollback and removal path.

After you approve selected roles, the deterministic Bun deploy engine performs
the work and writes receipts. The LLM only presents the fixed manifest, records
your selection, requests approval, and invokes that engine.

The shipped payload remains immutable. Runtime configuration, secrets, memory,
receipts, logs, and machine-specific topology live outside it under
`%USERPROFILE%\OrangeBox-Data`.

## Status Words

- `PROVEN`: a referenced receipt or live probe proved the exact path.
- `CONFIGURED`: files and policy exist, but runtime proof is still required.
- `DEGRADED`: the feature works with a named limitation.
- `BLOCKED`: an active path cannot proceed and says why.
- `FUTURE` or `CANDIDATE`: research only; not active.

Documentation never turns a feature green.

## Daily Use

```powershell
cd C:\AtomEons\Orange5
bun 03-BACKEND/spine-cli.mjs --health
bun 03-BACKEND/spine-cli.mjs --order-file C:\path\to\order.json
```

Use `--dry-run` to plan, `--learn` to write a governed lesson after successful
work, and `--seed <value>` for deterministic replay.

## Read Next

- [Operator Manual](OPERATOR_MANUAL.md)
- [Features Guide](FEATURES_GUIDE.md)
- [Model Installation Guide](MODEL_INSTALLATION_GUIDE.md)
- [LLM Operator Guide](LLM_OPERATOR_GUIDE.md)
- [Technical Architecture](TECHNICAL_ARCHITECTURE.md)
