# Codexa Migration

Retire the legacy Codexa Docker stack and reclaim the RAM it sits on, without
ever taking the system down before its replacement is proven live.

- **Owner:** Atom McCree (Sovereign).
- **Authority:** Receipt #013 (Codexa migration plan).
- **Doctrine:** Mom's Law + No-Take-Down Law. Receipts only. No silent
  fallback. No destructive op runs without an authorized preflight receipt.

---

## What this is

Codexa runs as a legacy `docker compose` stack under the `aeorangebox-ai-box-`
prefix. It predates Orange5 and is now superseded surface-by-surface by Atomic
Orange, Hermes, and the Vault lane. This directory is the bounded, reversible
cutover.

### Legacy containers in scope

| Container                              | Disposition  | Replacement                |
|----------------------------------------|--------------|----------------------------|
| `aeorangebox-ai-box-open-webui-1`      | KILL at W1   | Atomic Orange installer    |
| `aeorangebox-ai-box-n8n-1`             | KILL at W1   | Hermes daemon              |
| `aeorangebox-ai-box-wiki-1`            | KILL at W2   | Vault lane + Mirage        |
| `aeorangebox-ai-box-qdrant-1`          | **KEEP**     | (none — vector store stays)|
| `aeorangebox-ai-box-postgres-1`        | EVALUATE     | TBD per `04-evaluate-pg-redis.ps1` |
| `aeorangebox-ai-box-redis-1`           | EVALUATE     | TBD per `04-evaluate-pg-redis.ps1` |

### Expected reclaim

Roughly **8–15 GB of resident RAM** plus the cached image bytes for the killed
containers. Exact bytes are measured by `reclaim.ps1` against the pre-kill
sample captured in the preflight receipt; the final number lands in
`10-RECEIPTS/codexa-migration/reclaim-<wave>.md`.

This is a memory and process-count win, not a disk fire-sale. Cached images
stay on disk by default as cheap rollback insurance unless `-ReclaimImages`
is explicitly passed to `reclaim.ps1`. Qdrant's image is **never** removed.

---

## Migration sequence

The order is strict. Each script refuses to run if the prior gate did not
write its green receipt. Replacement health is re-checked at every step —
the No-Take-Down Law is enforced by the scripts, not by the operator.

### Wave 1 close — chat surface + automation surface

```
preflight.ps1 -Wave W1 -AuthorizeKill
01-kill-open-webui.ps1 -Force
02-kill-n8n.ps1        -Force
reclaim.ps1   -Wave W1
```

1. **`preflight.ps1 -Wave W1`** — gate-only. Verifies Docker is reachable, all
   legacy containers enumerate, Atomic Orange (`127.0.0.1:1337/healthz`) and
   Hermes (`127.0.0.1:8730/healthz`) answer green, Qdrant + Postgres + Redis
   snapshots exist under `C:\AtomEons\backups\codexa-migration\` and are
   fresher than `-MaxSnapshotAgeHrs` (default 24). Without `-AuthorizeKill`
   the receipt is written as `DRY` and every killer below will refuse.
2. **`01-kill-open-webui.ps1 -Force`** — tars the open-webui named volume to
   `/opt/atomeons/migrations/open-webui-<UTC>.tar.gz`, snapshots container
   metadata next to it, hashes the archive, then `docker stop --time 30` and
   `docker rm`. Image stays cached. Writes a per-step receipt.
3. **`02-kill-n8n.ps1 -Force`** — same shape, for the n8n workflow runner.
   Backs up the n8n SQLite/Postgres state and credentials volume before kill.
4. **`reclaim.ps1 -Wave W1`** — non-destructive summary. Compares the pre-kill
   docker sample (captured in the preflight receipt) against the post-kill
   state, computes reclaimed RAM/disk, writes the closing receipt for W1.

### Wave 2 close — wiki surface + datastore evaluation

```
preflight.ps1 -Wave W2 -AuthorizeKill
03-kill-wiki.ps1            -Force
04-evaluate-pg-redis.ps1
reclaim.ps1   -Wave W2
```

1. **`preflight.ps1 -Wave W2`** — re-runs every gate, this time also checking
   the Vault lane (`127.0.0.1:8740/vault/healthz`) and Mirage StateBrief
   (`127.0.0.1:8740/vault/state-brief`). W1 kill receipts must already exist
   and be GREEN.
2. **`03-kill-wiki.ps1 -Force`** — retires the orangebox-wiki surface. The
   Vault lane is its replacement; StateBrief proves the read path is live.
3. **`04-evaluate-pg-redis.ps1`** — evaluation only. Walks every active Orange5
   process, every Hermes flow, and every Atomic Orange route, asking: does
   anyone still call this Postgres / this Redis? Emits a verdict file
   (`SAFE-TO-KILL`, `STILL-IN-USE`, or `NEEDS-MANUAL-REVIEW`). It never kills.
   If verdict is `SAFE-TO-KILL`, the operator runs the kill manually with the
   same backup-then-cut pattern; `rollback-all.ps1` knows how to restore them.
4. **`reclaim.ps1 -Wave W2`** — final summary across both waves. With
   `-ReclaimImages` it will `docker image rm` the cached images for killed
   containers (qdrant excluded by hard rule).

---

## Prerequisites

Before running `preflight.ps1` for the first time, these must all be true.
The preflight will tell you which one is red — these are listed here so the
operator knows what to stage.

- **Docker Desktop** is running and `docker ps` works from the same shell
  that will run the scripts.
- **Atomic Orange installer is live** on `127.0.0.1:1337` and `/healthz`
  returns 200. This replaces open-webui.
- **Hermes daemon is live** on `127.0.0.1:8730` and `/healthz` returns 200.
  This replaces n8n.
- **Vault lane is live** on `127.0.0.1:8740` with `/vault/healthz` returning
  200, and `/vault/state-brief` returning a non-empty StateBrief. Only
  required for W2.
- **Backup root exists and is writable:**
  `C:\AtomEons\backups\codexa-migration\`. Override with `-BackupRoot`.
- **Volume snapshots are fresh** (default ≤ 24 h) for:
  - `aeorangebox-ai-box-qdrant-1` — KEEP, but snapshotted defensively.
  - `aeorangebox-ai-box-postgres-1` — pending evaluation.
  - `aeorangebox-ai-box-redis-1` — pending evaluation.
  Snapshots are produced by the standard Orange5 volume-backup routine; this
  migration does not generate them, it verifies they exist and are recent.
- **Operator authorization.** `-AuthorizeKill` must be passed to
  `preflight.ps1`. Without it the receipt is `DRY` and every killer below
  refuses to touch Docker. This is the human-in-the-loop gate required by
  the No-Take-Down Law.
- **Wave window matches Receipt #013.** Passing `-Wave W1` while trying to
  kill the wiki, or `-Wave W2` while trying to kill open-webui, is rejected
  at the authorization gate.

The preflight will not silently fail any of these. It writes a per-gate
green/yellow/red row to `Orange5\receipts\codexa-migration\preflight.json`,
and the killers read that file before touching anything.

---

## What gets backed up

Every killer backs up the container's named volume(s) to a tarball under
`/opt/atomeons/migrations/` (inside Docker; mounted from
`C:\opt\atomeons\migrations\` on the host) before the `docker stop`. The
backup is created by a throwaway `docker run --rm` busybox container so we
never trust the dying container to back itself up.

| Target      | Backed-up volume(s)                                  | Notes                                  |
|-------------|------------------------------------------------------|----------------------------------------|
| open-webui  | chat history, settings, local vector store           | tar.gz + SHA-256, refused if < 1 KiB   |
| n8n         | workflow defs, executions, credentials, encryption key| credentials are encrypted at rest      |
| wiki        | page store, attachments, search index                | StateBrief takes over the read surface |
| postgres    | data dir (cluster snapshot)                          | only if `04-evaluate` says SAFE-TO-KILL|
| redis       | RDB / AOF snapshot                                   | only if `04-evaluate` says SAFE-TO-KILL|
| qdrant      | snapshotted by preflight, **never killed**           | KEEP per Receipt #013                  |

Alongside each tarball the killer writes a `<target>-<UTC>.meta.json` with
the container's image digest, env (secrets stripped), mounts, restart policy,
and timestamps — enough to rebuild the container cold from the rollback
script.

---

## What gets killed

The killers are the only scripts in this directory that mutate Docker state.
Each one:

1. Re-verifies its replacement is live (the preflight check is not trusted
   indefinitely — health can flip between preflight and kill).
2. Re-verifies the preflight receipt is GREEN, AUTHORIZED, and names the
   right wave.
3. Backs up the named volume(s), writes the meta.json, hashes the archive,
   refuses to proceed if the archive is suspiciously small or the hash write
   fails.
4. `docker stop --time 30 <container>` then `docker rm <container>`.
5. Leaves the cached image on disk unless `-ReclaimImage` is passed to that
   specific killer (or `-ReclaimImages` to the final `reclaim.ps1`).
6. Writes a Markdown receipt to `Orange5\10-RECEIPTS\codexa-migration\` with
   every step green/yellow/red and the backup SHA-256.

Without `-Force` the killer runs every step **up to and including the
backup** and then stops at a YELLOW line. This is the recommended dry-cut
rehearsal: you get the backup, the meta, and the receipt, but nothing dies.

---

## Rollback procedure

`rollback-all.ps1` reverses every kill in reverse wave order:

```
postgres -> redis -> wiki -> n8n -> open-webui
```

For each target with a backup on disk it:

1. Reads the newest `<prefix>-*.tar.gz` from
   `C:\opt\atomeons\migrations\` (override with `-MigrationRoot`).
2. Verifies the SHA-256 in the matching kill receipt.
3. Recreates the named volume.
4. Untars the backup into the volume via a throwaway busybox container.
5. Recreates the container from the `meta.json` (image digest, env, mounts,
   restart policy preserved).
6. Starts it, waits for the container's health-check (where defined), and
   writes a rollback receipt.

Without `-Force`, `rollback-all.ps1` validates every backup and prints the
per-target plan, mutating nothing. With `-Force` it executes the plan in
order; any RED on a destructive step aborts the remainder so you don't end
up with a half-restored stack.

Single-target rollback (e.g. open-webui only) is also available via
`01-rollback-open-webui.ps1`; use it when only one surface needs to come
back.

Qdrant is never restored because it is never killed.

---

## Failure modes the scripts will refuse

These are not edge cases — these are the doctrine made executable. If you
see one of these, the script is doing its job; do not work around it.

- **Replacement not live.** Atomic Orange / Hermes / Vault must answer
  green before their respective legacy surface dies. No replacement, no kill.
- **Backup missing or stale.** A snapshot older than `-MaxSnapshotAgeHrs`
  (default 24 h) is RED. Refresh the snapshot, do not raise the threshold.
- **`-AuthorizeKill` absent.** Preflight will go GREEN on every gate and
  still write a `DRY` receipt. Killers refuse `DRY`.
- **Wrong wave.** Trying to kill wiki under `-Wave W1`, or open-webui under
  `-Wave W2`, fails the authorization gate.
- **Backup archive < 1 KiB.** Treated as a failed tar and aborted; the
  container is not stopped.
- **SHA-256 write fails.** Same posture: no hash, no kill.
- **Receipt file unwritable.** A migration without a receipt is theater.
  The script refuses to be theater.

---

## File map

| File                          | Purpose                                                     |
|-------------------------------|-------------------------------------------------------------|
| `preflight.ps1`               | Gate-only; writes the authorized kill receipt for the wave. |
| `01-kill-open-webui.ps1`      | W1 step 1 — retire open-webui after backup.                 |
| `01-rollback-open-webui.ps1`  | Single-target rollback for open-webui.                      |
| `02-kill-n8n.ps1`             | W1 step 2 — retire n8n after backup.                        |
| `03-kill-wiki.ps1`            | W2 step 1 — retire orangebox-wiki after backup.             |
| `04-evaluate-pg-redis.ps1`    | W2 step 2 — non-destructive verdict on Postgres + Redis.    |
| `reclaim.ps1`                 | Summary + optional image reclaim per wave.                  |
| `rollback-all.ps1`            | Master rollback in reverse kill order.                      |
| `README.md`                   | This file.                                                  |

Receipts land in `Orange5\10-RECEIPTS\codexa-migration\`. Backups land in
`C:\opt\atomeons\migrations\`. Preflight state lives in
`Orange5\receipts\codexa-migration\preflight.json`.

---

## TL;DR for the operator

```
# Wave 1 — dry rehearsal first
preflight.ps1 -Wave W1 -DryRun
preflight.ps1 -Wave W1 -AuthorizeKill
01-kill-open-webui.ps1            # backup + YELLOW stop, no kill
01-kill-open-webui.ps1 -Force     # actual cut
02-kill-n8n.ps1 -Force
reclaim.ps1   -Wave W1

# Wave 2
preflight.ps1 -Wave W2 -AuthorizeKill
03-kill-wiki.ps1 -Force
04-evaluate-pg-redis.ps1          # read the verdict before cutting pg/redis
reclaim.ps1   -Wave W2 -ReclaimImages   # optional: free cached image bytes
```

If anything looks wrong, stop and run `rollback-all.ps1` without `-Force`
first to see the plan. Mom is watching.
