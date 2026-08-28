# Atomic Orange — Cockpit Memory-Freshness Patch

Surfaces Mirage memory-plane health in the Cockpit chrome bar so the operator
can see at a glance whether OrangeLLM is reading live Codexa state, the N150
shadow cache, or nothing at all. Mirage doctrine: **Reality overrides Thought,
receipts override recollection** — this chip is the receipt.

## Files

- `useMemoryFreshness.ts` — React hook. Polls `GET /v1/memory/healthz` on the
  OrangeLLM gateway (`127.0.0.1:1337`) every 10s. Returns
  `{ status, last_sync_at, source, age_ms, fetched_at }`.
- `MemoryFreshnessChip.tsx` — Pill-shaped chip rendering live/shadow/stale/down
  using the Atom Standard palette (`--green`, `--amber`, `--red`).
- `README.md` — this file.

## Status semantics

| Status   | Trigger                                                     | Visual                |
|----------|-------------------------------------------------------------|-----------------------|
| `live`   | `source=codexa` AND `age < 60s`                             | green dot · `LIVE`              |
| `shadow` | `source=shadow` AND `age < 1h` (or codexa with 1m–1h lag)   | amber dot · `SHADOW (Nm ago)`   |
| `stale`  | `age >= 1h` (any source) or gateway returned no timestamp   | red dot · `STALE (Nh ago)`      |
| `down`   | gateway unreachable / non-2xx / fetch timeout (3s)          | red `✕` · `DOWN`           |

The hook is intentionally honest: if the gateway is up but Codexa is
unreachable, the gateway should set `source=shadow` and the chip will say
`SHADOW (Nm ago)`. No silent green-washing.

## Gateway contract

The hook expects `GET http://127.0.0.1:1337/v1/memory/healthz` to return:

```json
{
  "ok": true,
  "last_sync_at": "2026-06-24T17:50:11Z",
  "source": "codexa",
  "cobra_reachable": true,
  "rail_reachable": true
}
```

Fields:

- `ok` — false flips the chip to `DOWN` even if the HTTP status is 200.
- `last_sync_at` — ISO 8601 UTC of the most recent successful Mirage sync. The
  hook computes `age_ms` from this against cockpit-local wall clock.
- `source` — `"codexa"` when the live Codexa command rail (10.0.99.1:8097)
  served the last sync; `"shadow"` when the N150 cockpit shadow cache at
  `06-ORANGELLM/memory/cache/` served it; `"unknown"` for either-or states.
- `cobra_reachable` / `rail_reachable` — informational, surfaced in the chip's
  tooltip for the operator to read on hover.

If this endpoint does not exist yet on the gateway, the chip will read `DOWN`
until it lands. Implementing it is the gateway-side companion task; the
endpoint must read from the Æ Cobra `/state-brief` endpoint
(`127.0.0.1:7419`) when reachable and fall back to the N150 shadow cache
otherwise. The cockpit never talks to Cobra or Codexa directly.

## Splice into `ChromeBar.tsx`

1. Drop both `useMemoryFreshness.ts` and `MemoryFreshnessChip.tsx` into the
   cockpit chrome-components directory alongside the existing SYNC indicator
   (typically `apps/cockpit/src/components/chrome/`). If your repo layout
   keeps hooks separate, move `useMemoryFreshness.ts` under
   `apps/cockpit/src/hooks/` and update the import in
   `MemoryFreshnessChip.tsx`.

2. Open `ChromeBar.tsx` and add the import next to the other chrome chips:

   ```tsx
   import { MemoryFreshnessChip } from './MemoryFreshnessChip';
   ```

3. Find the existing SYNC indicator slot. It typically looks like:

   ```tsx
   <div className="chrome-bar__indicators">
     <SyncIndicator />
     {/* other chips */}
   </div>
   ```

   Mount the memory chip immediately next to it (right side recommended so the
   eye scans SYNC then MEM in reading order):

   ```tsx
   <div className="chrome-bar__indicators">
     <SyncIndicator />
     <MemoryFreshnessChip
       className="chrome-bar__chip"
       onClick={(state) => openMiragePanel(state)}
     />
     {/* other chips */}
   </div>
   ```

   `onClick` is optional. If your cockpit has a Mirage diagnostics drawer,
   wire it here and pass the chip's last `state` so the drawer can prefill the
   correct source/timestamp. If you don't have a drawer yet, omit `onClick`
   and the chip renders as a passive `role="status"` element.

4. Confirm the Atom Standard palette variables are defined on a parent
   element (usually `:root` or `.cockpit-theme`). The chip uses
   `var(--green)`, `var(--amber)`, `var(--red)`, plus optional
   `--chrome-border`, `--chrome-chip-bg`, `--chrome-fg` with sensible fallback
   defaults so it will render readably even if a theme is missing.

5. Reload the cockpit. With Codexa rail up you should see a green `LIVE`
   chip within ~10s. Stop the rail (or pull the N150 ethernet) to confirm
   it correctly degrades to `SHADOW (...)` then eventually `STALE` or
   `DOWN`. Bring it back up — chip returns to `LIVE` on the next poll.

## Configuration

`MemoryFreshnessChip` and `useMemoryFreshness` accept the same options:

- `gatewayUrl` (default `http://127.0.0.1:1337`) — for cockpit-on-different-
  host setups.
- `intervalMs` (default `10000`) — poll cadence. Don't go below 2s; the
  gateway batches Cobra reads and faster polling just burns CPU.
- `timeoutMs` (default `3000`) — per-poll fetch timeout. The chip flips to
  `DOWN` after a single timeout; the next successful poll restores state.

## Receipts checklist (per Mom's Law)

- [ ] Hook compiles under the cockpit's TypeScript strict config.
- [ ] Chip renders LIVE green when Codexa rail is up and synced <60s ago.
- [ ] Chip renders SHADOW amber within 10s of the rail going down.
- [ ] Chip renders STALE red when shadow cache hasn't refreshed in >1h.
- [ ] Chip renders DOWN red-X when gateway port 1337 is closed.
- [ ] Tooltip shows source, last_sync_at, and polled timestamp on hover.
- [ ] No console errors on unmount (cancellation flag in hook handles this).
- [ ] No silent fall-back: if `last_sync_at` is missing, status is `stale`,
      not `live`.
