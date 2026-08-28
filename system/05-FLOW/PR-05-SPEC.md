# PR-05 — `flow-direct` Spec

**Goal:** Implement AE Flow as a working pressure-field runtime. Currents / agents / deltas / governors / acceptance criteria.

Per Master Plan §7 — OrangeLLM does not run on a flat task queue. It runs on a pressure field. High-priority work bubbles up. The Cockpit shows deltas, not log spam.

## What this PR ships

1. **Types** at `src/types.mjs` — Current, Agent, Delta, Governor shapes (JSDoc, no TS compile needed).
2. **Storage** at `src/store.mjs` — JSON-snapshot to disk (`state/flow.json`). SQLite proper lands in PR-10 with the adapter registry.
3. **Runtime** at `src/flow.mjs` — tick loop, pressure compute, agent assignment, delta emission.
4. **Public API** at `src/index.mjs` — `createFlow()`, `tick()`, `pushCurrent()`, `closeCurrent()`, `subscribe()`.
5. **Tests** at `tests/flow.test.mjs` — pressure ordering, delta emission, governor throttling, acceptance gating.

## Why JSON snapshot, not SQLite

- Zero new npm deps (Codeless honored — no `better-sqlite3` install yet).
- PR-10 `adapters` brings SQLite as part of the control-plane registry. Flow gets migrated cleanly then.
- For PR-05 a single `state/flow.json` written atomically per tick is plenty for the cockpit poll.

## Acceptance

Tests pass. State file written. Boundary still 16/16.
