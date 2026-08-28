# Atomic Orange GPT-to-GPT Connection Brief

Status: operator intent handoff
Audience: GPT / Claude / Opus / Codex / any fresh model with zero project memory
Product: Orange
Release line: Orange5
Primary platform goal: Windows first

## One-Sentence Truth

Atomic Orange is the Windows-first Orange5-native evolution of the Atomic Chat product class: a beautiful native AI chat/control app that keeps Atomic Chat's best local-model, project, memory, agent, MCP, artifact, and OpenAI-compatible API features, but routes every serious action through Orange5's governed backend, receipts, and two-computer deployment.

## Windows Is Goal 1

The first serious product target is Windows.

That means:

- Native Windows app first.
- Tauri v2 app shell, not Electron.
- Installable `.exe` / Windows package path.
- Works on the N150 dev mini PC.
- Can connect to Codexa / AI Box for heavy work.
- Can run local/offline when possible.
- Can expose a local OpenAI-compatible API on loopback.
- Does not require a browser tab to be the real product.

Browser/Vite dev mode is acceptable for development only. It is not the finished operator experience.

## Product Relationship

Atomic Chat is the upstream inspiration and compatibility target.

AtomEons / Orange5 is the operating system behind it.

Atomic Orange is the product handshake:

```text
Atomic Chat-style native shell
-> Atomic Orange interface and cockpit
-> OrangeBrain OpenAI-compatible gateway
-> Orange5 tools, memory, visual system, agents, compression, receipts
-> structured report back to the user
```

Do not collapse these into one tangled app. Keep the roles clean.

## What Atomic Chat Contributes

Atomic Chat's important feature classes:

- Local AI chat.
- Local/offline privacy posture.
- Windows/macOS/Linux/mobile app path.
- 1,000+ model catalog concept.
- Hugging Face model browsing/downloading.
- GGUF / MLX / ONNX model support.
- OpenAI-compatible local server at `http://localhost:1337/v1`.
- Local inference engines including llama.cpp-style backends.
- TurboQuant / KV-cache / speculative decoding style upgrade path.
- Custom assistants with system prompts.
- Projects and conversation trees.
- Persistent memory.
- Artifacts / live preview.
- Multiple MCP server support.
- One-click agent launches.
- Cloud BYO providers where desired.

Sources to review:

- https://atomic.chat/#features
- https://github.com/AtomicBot-ai/Atomic-Chat

## What Orange Adds

Orange5 turns those app features into a governed operating system.

Orange adds:

- `orange.order.v1` as the input language.
- `orange.report.v1` as the output language.
- OrangeBrain as the only model gateway.
- Hermes as bounded agentic execution.
- AE Memory as receipt/source-backed memory.
- AE Eyes as the visual proof and image/UI understanding lane.
- AtomSmasher 2 as compression and tool registry.
- Codexa / AI Box as heavy compute.
- N150 dev box as the always-on local control surface.
- Receipts as truth.
- No fake green.
- No hidden tool bypass.

## The Required Connection

Atomic Orange must keep Atomic Chat's useful feature shape, but each feature must connect to an Orange owner.

| Atomic Chat feature class | Atomic Orange placement | Orange owner | Rule |
|---|---|---|---|
| Local chat | Chat lane | OrangeBrain | Every prompt wraps into Orange discipline. |
| OpenAI-compatible server | `127.0.0.1:1337/v1` | OrangeBrain | This is the only model API seam. |
| Model catalog | Settings / model dock | OrangeBrain | Browse many, promote only benchmarked models. |
| Custom assistants | Settings rule + assistant profiles | OrangeBrain | Rules cannot bypass orders/reports. |
| Projects | Recent rail + Project Galaxy | Atomic Orange + AE Memory | Projects are operational contexts, not loose chats. |
| Persistent memory | Vault + recall chips | AE Memory | Memory cites receipts or source pointers. |
| MCP servers | MCP dock | Hermes | Tool calls require leases, policy, and receipts. |
| One-click agents | Agent dock | Hermes | Agents are hands, never rulers. |
| Artifacts/live preview | Vault artifacts + cockpit proof | AE Eyes | Artifacts need visual/source/receipt proof. |
| Local inference engines | Model engine status | OrangeBrain + AtomSmasher 2 | Engine changes require benchmark receipts. |
| Cloud providers | Frontier settings | OrangeBrain frontier proxy | BYO keys stay local; no direct provider SDK from UI. |
| Offline/private mode | Egress setting + boundary badges | Atomic Orange | Loopback/local-first is default. |

## Four-Lane Law

Atomic Orange keeps exactly four lanes:

```text
Chat
Cockpit
Vault
Settings
```

Do not add a fifth lane.

Atomic Chat compatibility must fit inside these four:

- Chat: conversation, assistant, model selector, OpenAI-compatible chat.
- Cockpit: living visual command center, health, project state, routes, agents, receipts.
- Vault: memory, artifacts, receipts, source-backed project context.
- Settings: brain tier, model dock, MCP dock, egress, BYO keys, local profile.

## Desired User Experience

The operator wants Atomic Orange to feel like:

```text
Atomic Chat if AI took it to space,
merged with AE See-Suite,
running the Orange5 backend for real.
```

It should not feel like:

- a plain dashboard,
- a generic ChatGPT wrapper,
- a web demo,
- an Electron clone,
- a fake cockpit,
- or a tool list with no live backend.

It should feel like a native Windows command vehicle for the Orange system.

## Two-Computer Reality

The intended deployment is:

```text
N150 dev mini PC
  - Windows-first Atomic Orange native app
  - light local/reflex model support
  - local gateway/control surface
  - status, receipts, cockpit, operator chat

Codexa / AI Box
  - heavy models
  - training
  - batch jobs
  - AE Eyes heavy vision
  - AtomSmasher 2 deploy/proof
  - Docker/heavy service stack
```

Atomic Orange must always show what is local, what is Codexa, what is offline, and what is not yet proven.

## GPT-to-GPT Instruction

If a future model is asked to continue this project, it must understand:

1. Orange is the product.
2. Orange5 is the current release line.
3. Atomic Orange is the Windows-first native app.
4. Atomic Chat is the upstream product class / feature inspiration.
5. Orange5 is the governed backend/control system.
6. Atomic Orange talks to OrangeBrain, not random tools directly.
7. OrangeBrain speaks OpenAI-compatible API for app/tool compatibility.
8. Operational messages must become `orange.order.v1`.
9. Operational replies must become `orange.report.v1`.
10. Receipts decide truth.
11. Codexa handles heavy work.
12. N150 handles the operator app/control surface.
13. The visual cockpit is part of the product, not a side toy.
14. No fake green.
15. No web-only final product.
16. Windows is the first target.

## Current Implementation Anchors

Important local files:

```text
C:\AtomEons\Orange5\00-CHARTER\NAMING_CANON.md
C:\AtomEons\Orange5\00-CHARTER\ORANGE5_MASTER_PLAN.md
C:\AtomEons\Orange5\00-CHARTER\ATOMIC_ORANGE_DOCK_STANDARD.md
C:\AtomEons\Orange5\02-APP\
C:\AtomEons\Orange5\02-APP\NORTH_STAR.md
C:\AtomEons\Orange5\02-APP\STYLE_BRIEF.md
C:\AtomEons\Orange5\02-APP\src\lib\atomic-dock.ts
C:\AtomEons\Orange5\06-ORANGELLM\server\
C:\AtomEons\Orange5\08-HERMES\
C:\AtomEons\Orange5\10-RECEIPTS\orange5-build\
C:\AtomEons\Orange5\12-ATOMSMASHER\
```

## Current Proof Note

The local Orange5 verifier was run on 2026-07-04 and passed:

```text
Orange5 full verifier: 64 green / 0 red
```

That proves the local repo/test surface. It does not by itself prove all Codexa live deployment paths.

## What Must Happen Next

Next work should focus on the handshake:

1. Keep Atomic Chat feature compatibility visible and maintained.
2. Keep the native Windows app standard.
3. Make the Settings lane the model/MCP/agent dock.
4. Make Chat use OrangeBrain as the only OpenAI-compatible gateway.
5. Make Cockpit display live Orange5 system truth.
6. Make Vault carry memory, artifacts, and receipts.
7. Prove Codexa connection and heavy lanes.
8. Prove Atomic Orange native launch/install path.
9. Keep docs aligned with this connection brief.

If a model tries to build unrelated features before this handshake is strong, it is off-track.

