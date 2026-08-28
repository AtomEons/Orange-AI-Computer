# 27 Constitutional Guardrails — Orange5 doctrine runtime

This directory is the operational expression of the 27 Constitutional
Guardrails: the invariants Orange5 must preserve at runtime to remain itself
across model swaps, refactors, and forks. The doctrine lives in the registry;
the realization is one check file per guardrail. The runtime runs all 27 in
parallel and ships violations to the Reality Flux ledger.

## Files

- `registry.mjs` — single source of truth: 27 guardrail IDs, names,
  severities (CRITICAL / HIGH / MEDIUM / LOW), doctrine source, check module
  filename.
- `runtime.mjs` — exports `runGuardrails()`. Runs all 27 checks in parallel,
  returns `{ok, violations, elapsed_ms, results, run_id, stop, backend, flux}`.
  Persists every run to SQLite (or JSONL fallback). Writes violations to
  Reality Flux at `http://127.0.0.1:7419/event` (with on-disk spool if cobra
  is unreachable).
- `server.mjs` — Bun-native daemon at `127.0.0.1:7460` exposing
  `/healthz`, `/run`, `/latest`, `/continuity`, `/soul-genome`. Also runs on
  Node via `npm run serve:node`.
- `checks/g01-…g27-*.mjs` — one file per guardrail. Each exports
  `async run()` returning `{pass, details}`. No I/O outside the helpers in
  `lib/`.
- `lib/paths.mjs` — env-overridable filesystem anchors.
- `lib/db.mjs` — SQLite (`better-sqlite3`) status with JSONL fallback.
- `lib/soul-genome.mjs` — operator continuity config. File-based JSON,
  single source of truth at `state/soul-genome.json`. Read on session start,
  written only on explicit operator update. The `z_0` anchor for Spiral
  Reasoning.
- `lib/continuity-packet.mjs` — forward-looking daily JSON record
  (`state/continuity/YYYY-MM-DD.json`). Cron writes the day's packet at
  23:55 local; the next session loads it as first context injection.
- `lib/flux-client.mjs` — direct fetch client for the cobra Flux daemon.
  Spools on unreach to `state/flux-spool.jsonl`.
- `tests/runtime.test.mjs` — smoke test (shape, count, self-check).
- `state/` — runtime artifacts: `guardrails.sqlite`, `soul-genome.json`,
  `continuity/`, `flux-spool.jsonl`. All ignored by git unless explicitly
  added.

## Severity classes

| Severity | Effect                                              |
| -------- | --------------------------------------------------- |
| CRITICAL | Stop promotion; `stop: true` and CLI exits non-zero |
| HIGH     | Halt new writes; `stop: true`                       |
| MEDIUM   | Emit warning; sweep stays green                     |
| LOW      | Informational                                       |

## Usage

```bash
# One-shot CLI
node runtime.mjs

# Daemon (Bun preferred)
bun server.mjs
# or
node server.mjs

# Probe
curl http://127.0.0.1:7460/healthz
curl http://127.0.0.1:7460/run

# Write today's continuity packet
node lib/continuity-packet.mjs write

# Show / init Soul Genome
node lib/soul-genome.mjs show
node lib/soul-genome.mjs init
```

## Environment

- `ORANGE5_ROOT` — defaults to `C:/AtomEons/Orange5`
- `ORANGE5_GUARDRAILS_DB` — defaults to `state/guardrails.sqlite`
- `ORANGE5_SOUL_GENOME` — defaults to `state/soul-genome.json`
- `ORANGE5_CONTINUITY_DIR` — defaults to `state/continuity/`
- `AE_COBRA_BASE` — defaults to `http://127.0.0.1:7419`
- `GUARDRAILS_HOST` — defaults to `127.0.0.1` (loopback-only by doctrine)
- `GUARDRAILS_PORT` — defaults to `7460`

## Doctrine references

- `C:\Users\a\.claude\CLAUDE.md` — ÆSkill Suite V1.4 invariants and the
  Standing Law on Orange3/Orangebox routing.
- `C:\AtomEons\.claude\rules\00-moms-law.md` — Mom's Law, above all rules.
- `C:\AtomEons\Orange5\02-APP\src\router.tsx` — the 4 lanes ground truth.
- `C:\AtomEons\Orange5\06-ORANGELLM\FRONTIER_ISOLATION_BOUNDARY.md` —
  frontier loopback discipline.
- `C:\AtomEons\Orange5\11-MIRAGE\adapters\flux.mjs` — Reality Flux protocol.
- Spiral Reasoning v3 manuscript (`C:\Users\a\Downloads\Spiral_Reasoning_Manuscript_v3.pdf`)
  and its integration doctrine.

The 27 are not a wishlist. They are the conditions under which Orange5
remains Orange5. Mom's Law sits above the whole stack: the checker runs
because giving full effort means proving the invariants every time.
