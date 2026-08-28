# dispatch-10k-x-100.mjs — how to run on the AI computer

## What it does
Statistical diminishing-returns proof for the N-shot magic number on a
10,000-class × 100-sample corpus. Explicit stress on **NEON** and **CRT**
(the two extreme monochromatic illuminants that broke earlier tests).

## What it emits
- Chunked crash-safe cache at `Orange5/07-VISUAL/ten-k-x-100/cache/shard_*.json`
  (10 classes per shard, ~1000 shards total).
- Final N-curve report at `Orange5/07-VISUAL/ten-k-x-100/results/report_*.json`
  with mean / median / 95%-CI / best / per-lighting failure counts.

## How to run

### Single worker
```powershell
bun C:/AtomEons/Orange5/07-VISUAL/structural/dispatch-10k-x-100.mjs
```

### Parallel workers (recommended for the AI computer)
Split the shard space across N workers by setting `PROC_RANK` and `PROC_WORKERS`:

```powershell
# terminal 1 (rank 0 of 8)
$env:PROC_RANK=0; $env:PROC_WORKERS=8
bun C:/AtomEons/Orange5/07-VISUAL/structural/dispatch-10k-x-100.mjs

# terminal 2 (rank 1 of 8) — different PowerShell window
$env:PROC_RANK=1; $env:PROC_WORKERS=8
bun C:/AtomEons/Orange5/07-VISUAL/structural/dispatch-10k-x-100.mjs

# ... etc through PROC_RANK=7
```

Each worker only captures shards where `shard_idx % PROC_WORKERS == PROC_RANK`.
Cache files are shared (they're on disk), so no lock contention.

After all workers finish, run one more time with `PROC_WORKERS=1` (or just
one worker) to produce the merged N-curve report — it will find every
existing shard and skip re-capture.

## What to look for in the report
- `magic_N`: smallest N whose 95%-CI lower bound is within 0.5% of the peak.
  This is the operator's **statistical guaranteed diminishing return**.
- `N_curve[i].lightSummary`: failures broken down by lighting condition.
  **NEON and CRT counts must be near zero** at magic N — that's the proof
  the extreme illuminants aren't gaps.
- Storage estimate: `magic_N × 80 × 4 bytes × class_count` should fit in 5 GB
  or gracefully into the mother-child hierarchy.

## Adding real corpora
Add roots to `CONFIG.CORPUS_ROOTS` in the script:
```javascript
CORPUS_ROOTS: [
  "C:/AtomEons/Orange5/07-VISUAL/fixtures",
  "D:/datasets/imagenet21k",     // if downloaded to AI machine
  "D:/datasets/laion400m/images",
],
```
The corpus enumerator walks recursively and treats every `.jpg`/`.png` as a
class. With 10,000+ unique sources, the `seed_offset` replication kicks off
only if fewer sources are found.

## Wall-clock estimate (AI computer)
- Total captures: 10,000 × 100 = 1,000,000
- At operator's stated "days in hours" throughput, expect ~4–8 hours total
  wall-clock across 8 parallel workers.
- N-curve analysis after capture: seconds per N × 17 N values × 500 seeds ≈ 20–40 min.

## No workflows
This script is pure Bun. No workflow tool, no orchestration layer, no
subprocess spawning. Each worker is a plain `bun` process.
