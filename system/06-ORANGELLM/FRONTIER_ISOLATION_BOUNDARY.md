# Frontier-Isolation Boundary

**Doctrine ID:** ATOM-ORANGE5-FRONTIER-ISOLATION-2026-0623
**Law:** Master Plan §2.1
**Enforced by:** `06-ORANGELLM/server/boundary.mjs`

---

## The law (plain English)

The frontier model hosted inside Atomic Orange (Claude Opus 4.7 / Gemini / GPT-5.5 / GLM, BYO key) is treated as an **untrusted third party**. It is allowed to talk to OrangeLLM and **nothing else** inside Orange5.

This makes BYO-key frontier integration safe by design: the third-party API cannot leak Orange5 internals because it never touches them.

---

## What the frontier CAN reach

| Endpoint | Verb | Use |
|---|---|---|
| `http://127.0.0.1:1337/healthz` | GET | System check — version, boundary state, upstream status |
| `http://127.0.0.1:1337/v1/models` | GET | List of OrangeLLM-served models |
| `http://127.0.0.1:1337/v1/chat/completions` | POST | OpenAI-compatible chat — OrangeLLM is the responder |

## What the frontier CANNOT reach

| Forbidden | Why |
|---|---|
| `http://127.0.0.1:8787/*` (command server) | Internal Orange5 only — operator + OrangeLLM use it |
| `http://127.0.0.1:8797/*` (Smart Skinny direct) | Internal — frontier must go through `:1337/v1` which proxies on its behalf |
| `http://127.0.0.1:8094/*` (STRONGARM sidecar) | Internal pressure-check service |
| `http://10.0.99.1:8097-8099/*` (Codexa rails) | Internal cross-machine rail |
| `file://*` | No filesystem access |
| Mirage mounts (postgres / drive / gmail / slack / github / redis) | Mirage is OrangeLLM's data plane; frontier never touches mounts |
| `/v1/files`, `/v1/embeddings`, `/v1/audio`, `/v1/images` (OpenAI legacy) | Not exposed — OrangeLLM doesn't ship these surfaces yet |
| Any path containing `..` | Traversal blocked |
| Headers starting with `X-Mirage-`, `X-Orangebox-`, `X-Codexa-`, `X-Internal-` | Reserved for internal use only |

## Enforcement

All requests pass through `boundary.mjs` first. Boundary checks (in order):

1. **Path traversal** — `..` or absolute path patterns rejected with 403.
2. **Forbidden path patterns** — `/api/*`, `/admin/*`, `/cmd/*`, `/exec/*`, `/shell/*`, `/fs/*`, `/mirage/*`, `/codexa/*`, `/orangebox/*`, `/hermes/*`, `/vault/*` all rejected with 403.
3. **Allow-list match** — only the 3 endpoints above accepted. Anything else returns 404.
4. **Forbidden headers** — any header starting with reserved internal prefixes rejected with 403.
5. **Authorization shape** — if present, must be Bearer (so a BYO frontier API key can be forwarded properly; never a Basic or weird auth).

Every rejection is logged. Every rejection writes a receipt entry. No silent allow.

## Bind discipline

The server binds **only** `127.0.0.1:1337`. Not `0.0.0.0`. Not LAN. Not WAN. The frontier inside Atomic Orange runs on the same machine and reaches localhost. No external network exposes `:1337`.

## Body size cap

Request bodies are capped at 1 MB. Anything larger has the connection destroyed.

## Future tightening (post-v1)

- mTLS between Atomic Orange and OrangeLLM gateway (mutual auth)
- Rate limit per-frontier-key
- Per-tool-call structured output validation
- Audit log replay for security review

## Mom is watching

Every rejection becomes a receipt. Every allow leaves a trace. No silent fall-back. No fake-green.
