# Make OrangeBrain the only Atomic Orange chat crossing

Date: 2026-08-25

## Status

Accepted.

## Context

Atomic Chat supports local engines and many OpenAI-compatible providers. That
flexibility is valuable for engine management but would let a selected model
bypass OrangeFive memory, routing, leases, compression, and receipts.

## Decision

Atomic Orange keeps Atomic Chat's engine and provider management, but normal
chat always uses the built-in `orangebrain` provider at
`http://127.0.0.1:1337/v1`. The model selector chooses only an Orange lane.
OrangeBrain decides the physical model and host. Tool execution crosses Hermes
and the Orange spine before its result can be promoted.

The fork uses a new Windows app identity so it cannot overwrite an upstream
Atomic Chat installation. Legacy internal `jan*` names remain unchanged.

## Consequences

- A provider prompt cannot disable Orange governance.
- Local and cloud engines remain available behind OrangeBrain.
- Codex, Claude, Hermes, and other agents are workers, not promotion authorities.
- Upstream merges must preserve this transport lock and the unique bundle ID.

## Deterministic proof

The built-in provider, first-use health handshake, and live OpenAI model list
share one canonical runtime contract. The handshake rejects a listener unless
it identifies as the OrangeLLM gateway, reports frontier isolation active,
advertises `POST /v1/chat/completions`, and has a live primary navigator.

```bash
bun run verify:orangefive
bun run verify:orangefive:roundtrip
```

The first command proves configuration, gateway identity, route availability,
and the four expected Orange model lanes. The second also performs a real
non-streaming chat completion and requires Orange gateway and receipt evidence.
