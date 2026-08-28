# Codexa migration W2 -- evaluate postgres + redis

- Date (UTC): 20260625T010740Z
- Strict mode: False
- SkipContainers: True
- Docker reachable: False

## Verdicts

| Adapter | Verdict | Consumer hits | Env set |
|---------|---------|---------------|---------|
| postgres | **IN-USE** | 2 | ATOMEONS_PG_URL=False |
| redis    | **IN-USE** | 2 | REDIS_URL=False |

## What the verdicts mean

- **RETIRABLE** -- zero consumer hits in Orange5 outside the adapter file, registry index, SPEC, tests, and migration scripts. The legacy Codexa backend is a candidate for retirement. The kill is still gated on the No-Take-Down Law: backup volume(s), verify no inbound traffic for one quiet day, then run the destructive script.
- **AMBIGUOUS** -- zero consumer hits, but the env variable is plumbed. The adapter is wired for use but nothing calls it yet. Operator decides; do NOT retire until ambiguity is resolved (either by deleting the env or by promoting a consumer). Re-run with `-Strict` to treat this as IN-USE for unattended cron evaluation.
- **IN-USE** -- one or more consumer hits found outside the exclusion list. Backend is live; retirement is BLOCKED. See the hit tables below.

## postgres consumer hits

| File | Line | Pattern | Snippet |
|------|------|---------|---------|
| `04-CONTROL-PLANE\workflows\wave2-04-mirage-eight-adapters.workflow.mjs` | 21 | `ATOMEONS_PG_URL` | `{ id: 'postgres', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/postgres.mjs with the pg npm client. Auth: ATOMEONS_PG_URL env. Read: query(sql, params), schema(table), list_tables(). Write: insert/update/` |
| `04-CONTROL-PLANE\workflows\wave3-29-sovereign-reproducibility.workflow.mjs` | 11 | `ATOMEONS_PG_URL` | `{id:'env-template', prompt:`Author ${ROOT}/scripts/repro/.env.template — every env var Orange5 needs: ORANGEBOX_RAIL_TOKEN, ATOMEONS_PG_URL, GOOGLE_DRIVE_*, GMAIL_REFRESH_TOKEN, SLACK_BOT_TOKEN, GITHU` |

## redis consumer hits

| File | Line | Pattern | Snippet |
|------|------|---------|---------|
| `04-CONTROL-PLANE\workflows\wave2-04-mirage-eight-adapters.workflow.mjs` | 26 | `REDIS_URL` | `{ id: 'redis', prompt: `Wire ${ROOT}/11-MIRAGE/adapters/redis.mjs with ioredis. Auth: REDIS_URL env. Read: get, mget, keys (with caution), hgetall. Write: set/del via Hermes lease. ${CTX}` },` |
| `04-CONTROL-PLANE\workflows\wave3-29-sovereign-reproducibility.workflow.mjs` | 11 | `REDIS_URL` | `{id:'env-template', prompt:`Author ${ROOT}/scripts/repro/.env.template — every env var Orange5 needs: ORANGEBOX_RAIL_TOKEN, ATOMEONS_PG_URL, GOOGLE_DRIVE_*, GMAIL_REFRESH_TOKEN, SLACK_BOT_TOKEN, GITHU` |

## Live container snapshot

### aeorangebox-ai-box-postgres-1

_(probe skipped)_

### aeorangebox-ai-box-redis-1

_(probe skipped)_

## Steps

| Phase | Status | Title | Detail |
|-------|--------|-------|--------|
| 0 | green | Orange5 root exists | C:\AtomEons\Orange5 |
| 0 | green | receipt dir exists | C:\AtomEons\Orange5\10-RECEIPTS\codexa-migration |
| 0 | yellow | docker daemon reachable | docker not reachable; live container probe will be SKIPPED -- code-side evidence still counts |
| 1 | yellow | postgres consumer hits | count=2 |
| 1 | yellow | redis consumer hits | count=2 |
| 2 | skip | container snapshot | -SkipContainers set |
| 3 | green | ATOMEONS_PG_URL set | set=False |
| 3 | green | REDIS_URL set | set=False |
| 4 | red | postgres verdict | IN-USE |
| 4 | red | redis verdict | IN-USE |

## Proposed retirement order (only for RETIRABLE adapters)

This script does NOT kill anything. It only proposes the order. The operator must author and run a destructive sibling script (e.g. `05-kill-postgres.ps1`, `06-kill-redis.ps1`) modeled on `01-kill-open-webui.ps1`, with the same gates:

1. Pre-flight -- verify replacement is healthy (or `-SkipGatewayCheck` with loud yellow row).
2. Inspect container; capture image + named volumes + restart policy.
3. Back up each named volume to `C:\opt\atomeons\migrations` as `<service>-<UTC-date>.tar.gz`; SHA-256; refuse on small archive.
4. Snapshot metadata to `<service>-<UTC-date>.meta.json` (image digest, mounts, env minus secrets).
5. `docker stop --time 30` then `docker rm`. Image stays cached unless `-ReclaimImage`.
6. Emit a Markdown receipt to `10-RECEIPTS/codexa-migration/`.

Suggested scheduled window: any RETIRABLE adapter -> kill at W2 close, one quiet day after this evaluation, paired with a rollback script that restores the volume tar into a fresh named volume + recreates the container.

## Doctrine

- Mom's Law: receipts only, no theater.
- No-Take-Down Law: this script is read-only; nothing dies without an explicit destructive script and operator authorization.
- Receipt #013: open-webui + n8n at W1 close, orangebox-wiki at W2 close, KEEP qdrant, EVALUATE postgres + redis (this script).
- Exclusion list (mentions here are descriptive, not consuming): ``11-MIRAGE\adapters\postgres.mjs``, ``11-MIRAGE\adapters\redis.mjs``, ``11-MIRAGE\adapters\index.mjs``, ``11-MIRAGE\SPEC.md``, ``11-MIRAGE\tests\*``, ``scripts\codexa-migration\*``, ``10-RECEIPTS\codexa-migration\*``, ``10-RECEIPTS\orange5-build\*``, ``node_modules\*``, ``.git\*``
