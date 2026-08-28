# PR-14 `hermes-llm-agents` Spec

Hermes = bounded agentic execution. Replaces OpenClaw. Every action by OrangeLLM or any superstack LLM passes through a Hermes lease.

## Ships

1. `src/lease.mjs` — lease creation + enforcement.
2. `src/loom-gates.mjs` — 8-gate LOOM chain.
3. `tests/lease.test.mjs` — passes/blocks the right actions.

## LOOM 8 gates (per Master Plan §10)

`order_schema · report_schema · receipt_spine · human_approval · codexa_lease · openai_gateway · mcp_default · false_green_guard`

All 8 must pass before the action lands.
