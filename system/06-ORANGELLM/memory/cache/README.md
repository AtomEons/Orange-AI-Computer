# Orange Memory Shadow

This module provides a disk-backed degraded-memory snapshot for OrangeBrain.
It is not a second memory authority and it does not call Codexa or a command
rail. The canonical AE Cobra ledger already lives on the N150.

## Runtime path

```text
Canonical source:
  %USERPROFILE%\OrangeBox-Data\orange5\ae-cobra-flux\events\<lane>\YYYY-MM-DD.jsonl

Shadow snapshot:
  %USERPROFILE%\OrangeBox-Data\orange5\memory-shadow\
```

The source tree contains code only. Runtime JSONL, state, and logs stay under
`OrangeBox-Data` so Git never becomes a memory database.

## Behavior

- `sync.mjs` reads the last 24 hours from local Reality and Thought ledgers.
- It writes per-day snapshot files and `.sync-state.json` atomically.
- A failed run preserves the prior successful freshness timestamp.
- `shadow-reader.mjs` exposes records plus per-lane freshness.
- OrangeBrain uses the snapshot only when live AE Cobra is unavailable.
- Shadow results are always marked degraded. Reality and receipts outrank
  Thought on conflict.
- No API key, rail token, network, PowerShell child, or cloud service is used.

## Manual snapshot

```powershell
bun C:\AtomEons\Orange5\06-ORANGELLM\memory\cache\sync.mjs
Get-Content "$env:USERPROFILE\OrangeBox-Data\orange5\memory-shadow\.sync-state.json"
```

Optional overrides:

```powershell
bun .\sync.mjs --cache-dir D:\OrangeData\memory-shadow --source-root D:\OrangeData\ae-cobra-flux\events
```

## Hidden scheduled snapshot

Run elevated once:

```powershell
cd C:\AtomEons\Orange5\06-ORANGELLM\memory\cache
.\cron-windows.ps1 -Install
.\cron-windows.ps1 -RunNow
.\cron-windows.ps1 -Status
```

The scheduled action launches `bun.exe` directly with hidden task settings.
It does not open `cmd.exe` or a visible PowerShell window.

Remove it with:

```powershell
.\cron-windows.ps1 -Uninstall
```

## Freshness

| Snapshot age | Classification |
|---|---|
| up to 60 minutes | fresh |
| 60 to 120 minutes | aging |
| over 120 minutes | stale |
| no successful snapshot | unknown |

Defaults can be changed with `ORANGE5_SHADOW_FRESH_MS` and
`ORANGE5_SHADOW_STALE_MS`. A failed refresh never resets age.

## Files

- `sync.mjs`: local canonical-ledger snapshotter
- `shadow-reader.mjs`: bounded file reader and freshness contract
- `shadow-state-brief.mjs`: compressed fallback StateBrief
- `cron-windows.ps1`: hidden Bun scheduled-task installer
