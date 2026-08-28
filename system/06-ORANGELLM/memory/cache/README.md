# N150 Shadow Cache — `06-ORANGELLM/memory/cache/`

The N150 shadow cache is the **fallback memory plane** for the OrangeLLM
gateway when the live Æ Cobra daemon (`127.0.0.1:7419`) is unreachable.
It pulls recent Flux events from the Codexa command rail
(`10.0.99.1:8097`) on a schedule and stores them as flat JSONL files so a
StateBrief can still be computed offline.

Mirage doctrine reminder:

- This directory is **mirage/memory** — internal store, read-write per
  the Sovereign.
- Records here are **Thought** by default. **Reality** (the live Cobra
  daemon and the receipts lane on the rail) **always overrides Thought**
  on conflict. Any StateBrief produced from this cache is tagged
  `shadow=true` so the model knows it is consuming cached, not live,
  memory.
- This is **not** a substitute for live Cobra. It is a survival surface.

---

## Files in this directory

| File | Role |
|---|---|
| `sync.mjs` | The puller. Hits the rail, writes lane JSONL, updates state. |
| `shadow-reader.mjs` | `readShadowCache({lanes, startMs, endMs, maxRecords})` — same shape as the Æ Cobra reader. |
| `shadow-state-brief.mjs` | `computeStateBrief({query, windowMs, limits})` — same StateBrief shape as live, plus `shadow=true` and `last_sync_at`. |
| `cron-windows.ps1` | Installs the Windows scheduled task that runs `node sync.mjs` hourly. |
| `<lane>-YYYY-MM-DD.jsonl` | One file per lane per UTC day. Written by `sync.mjs`. |
| `.sync-state.json` | Last-sync bookkeeping. Read by `shadow-reader.mjs` for freshness. |
| `sync.log` | Rolling log from the scheduled task (`>>` appended each run). |

---

## Lanes synced (default)

- `reality` — what actually happened (verified events, sensor data, system facts)
- `thought` — what the model concluded, planned, or hypothesized
- `receipts` — durable, hash-signed receipts (override recollection)
- `conflicts` — explicit reality-vs-thought disagreements

Override with the env var `ORANGE5_LANES=reality,thought,receipts,conflicts,custom`.

---

## Schedule

- **Cadence:** every **60 minutes** (Windows Scheduled Task, `cron-windows.ps1`).
- **Window per pull:** last 24h of each lane.
- **Run principal:** `SYSTEM` by default so it survives logout. Switch to a
  user principal if `ORANGEBOX_RAIL_TOKEN` is only set in a user-scope env.
- **Idempotent:** the rail is source of truth for the 24h window;
  `sync.mjs` overwrites the per-day JSONL files cleanly each run.
- **Execution cap:** 5 minutes per run (task `ExecutionTimeLimit`). If the
  rail is slow, individual lane fetches still time out at 15s (env-tunable
  via `ORANGE5_SYNC_TIMEOUT_MS`).

---

## Freshness SLA

| `age = now - last_sync_ms` | Classification | Gateway behavior |
|---|---|---|
| `age ≤ 60 min` | **fresh** | Use shadow brief silently when Cobra is down. |
| `60 min < age ≤ 120 min` | **aging** | Use shadow brief, log a warning to the gateway error stream. |
| `age > 120 min` | **stale** | Use shadow brief but raise a visible `stale` indicator: `freshness.stale = true` in the brief; the gateway should prepend `[MEMORY:STALE]` to the auto-inject system message and surface a banner on `/healthz`. |
| `age` unknown (`.sync-state.json` missing) | **unknown** | Treat as stale. |

Thresholds are env-tunable on the reader side:
`ORANGE5_SHADOW_FRESH_MS`, `ORANGE5_SHADOW_STALE_MS`.

---

## Install (Windows N150)

```powershell
# 1) Set the rail token machine-wide (one time):
[Environment]::SetEnvironmentVariable('ORANGEBOX_RAIL_TOKEN','<token>','Machine')

# 2) Install the scheduled task (run elevated PowerShell):
cd C:\AtomEons\Orange5\06-ORANGELLM\memory\cache
.\cron-windows.ps1 -Install

# 3) Force a first sync now to populate the cache:
.\cron-windows.ps1 -RunNow

# 4) Verify:
.\cron-windows.ps1 -Status
Get-Content .\sync.log -Tail 30
```

To remove:

```powershell
.\cron-windows.ps1 -Uninstall
```

---

## Manual one-shot sync

```bash
# Bun
bun run sync.mjs

# Node 20+
node sync.mjs
```

Required env: `ORANGEBOX_RAIL_TOKEN`.

Exit codes:

- `0` — all lanes synced
- `1` — config error (missing token)
- `2` — total network failure (no lane succeeded; do NOT update freshness)
- `3` — partial success (some lanes succeeded; `.sync-state.json` still updated for those)

---

## Gateway integration (OrangeLLM, `127.0.0.1:1337`)

Pseudo-code for the fallback path on `POST /v1/chat/completions`:

```js
import { computeStateBrief, formatBriefAsSystemMessage }
  from '../memory/cache/shadow-state-brief.mjs';

async function getStateBrief({ query }) {
  try {
    const r = await fetch('http://127.0.0.1:7419/state-brief?query=' +
                          encodeURIComponent(query || ''));
    if (r.ok) return await r.json();   // live Cobra — Reality
    throw new Error('cobra non-ok');
  } catch {
    return await computeStateBrief({ query }); // shadow — Thought
  }
}

// Option C auto-inject:
const brief = await getStateBrief({ query: null });
const sysMsg = brief.shadow
  ? formatBriefAsSystemMessage(brief)
  : formatLiveBrief(brief);
messages.unshift({ role: 'system', content: sysMsg });

// <recall>{query}</recall> mid-turn:
// when the assistant emits the tag, the gateway intercepts, calls
// getStateBrief({ query }), and injects:
//   { role: 'system', content: '[MEMORY:RECALLED]\n' + body }
```

When `brief.shadow && brief.freshness.stale === true`, the gateway should:

1. Prepend `[MEMORY:STALE]` to the system message body.
2. Add `X-Memory-Source: shadow-cache` and `X-Memory-Stale: true` headers on the response.
3. Surface a `memory.stale` field on `/healthz` so the cockpit can light up the indicator.

---

## What happens when the rail is unreachable

1. `sync.mjs` exits `2`; `.sync-state.json` retains the previous successful
   `last_run_ms`. Age keeps growing.
2. After 60 minutes without a successful sync, the cache is **aging**;
   after 120 minutes it is **stale**.
3. The gateway keeps serving from the shadow cache with the `stale`
   indicator set. Briefs explicitly carry `freshness.stale = true` so the
   model knows the memory is old.
4. Once the rail is back, the next scheduled run (or `cron-windows.ps1 -RunNow`)
   refreshes everything; staleness disappears within the hour.

---

## What happens when the cache is empty

- First-ever boot before any sync has succeeded: `readShadowCache()`
  returns empty records and `freshness.classification = 'unknown'`.
- `computeStateBrief()` returns a brief with empty `reality/thought/receipts`
  arrays. `formatBriefAsSystemMessage()` still emits `[MEMORY:SHADOW]`
  with `last_sync_at=never` so the model knows there is no memory yet.
- Gateway should treat `unknown` the same as `stale` for surfacing.

---

## Receipts trump everything

If a `receipts` lane record contradicts a `thought` or even a `reality`
record, **the receipt wins**. The brief formatter lists receipts last so
they are the most recent thing the model reads, and the system message
ends with the explicit rule:

> Reality + Receipts override Thought on any conflict.

This is the same doctrine the live Cobra brief enforces.
