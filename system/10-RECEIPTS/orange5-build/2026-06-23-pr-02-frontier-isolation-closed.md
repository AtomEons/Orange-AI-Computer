# Receipt — PR-02 `frontier-isolation` CLOSED

**Receipt ID:** `2026-06-23-pr-02-frontier-isolation-closed`
**Generated:** 2026-06-23
**Schema:** `orange5.receipt.v0`
**Actor:** Claude Opus 4.7 (Orange — PM voice)
**Status:** `PR_02_FRONTIER_ISOLATION_GREEN`
**Confidence:** 1.0 (16/16 fixtures green)
**Prior receipt:** `2026-06-23-pr-01-native-rail-closed`
**Hash chain:** #004

## What happened

PR-02 `frontier-isolation` executed. Gateway scaffold at `06-ORANGELLM/server/` (vanilla Node http, zero new deps). Boundary middleware enforced. 16-fixture test suite **all green**.

## Steps completed

1. ✅ PR-02 spec at `06-ORANGELLM/PR-02-SPEC.md`
2. ✅ Server entry `server/index.mjs` (binds 127.0.0.1:1337 only)
3. ✅ Boundary middleware `server/boundary.mjs`
4. ✅ V1 routes `server/routes/v1.mjs` (models + chat-completions stub)
5. ✅ Healthz route `server/routes/healthz.mjs`
6. ✅ Server README
7. ✅ Boundary doctrine `FRONTIER_ISOLATION_BOUNDARY.md`
8. ✅ Test fixtures `tests/boundary-fixtures.json` (16 cases: 4 allowed + 12 rejected)
9. ✅ Test runner `tests/run-boundary-tests.mjs`
10. ✅ Tests executed: **16 passed / 0 failed** — `ALL GREEN — Frontier-Isolation Boundary holds.`

## Test results

```
[boundary-tests] running 16 fixtures
  PASS ok-healthz — allowed
  PASS ok-models — allowed
  PASS ok-chat-completions — allowed
  PASS ok-bearer-auth-passthrough — allowed
  PASS reject-path-traversal — rejected (403 forbidden path pattern)
  PASS reject-admin-prefix — rejected (403)
  PASS reject-shell-exec — rejected (403)
  PASS reject-mirage-mount-direct — rejected (403)
  PASS reject-codexa-direct — rejected (403)
  PASS reject-unknown-v1-route — rejected (404 endpoint not exposed)
  PASS reject-unknown-route — rejected (404)
  PASS reject-mirage-header — rejected (403 forbidden header)
  PASS reject-orangebox-header — rejected (403)
  PASS reject-codexa-header — rejected (403)
  PASS reject-internal-header — rejected (403)
  PASS reject-non-bearer-auth — rejected (401)

[boundary-tests] 16 passed / 0 failed
[boundary-tests] ALL GREEN — Frontier-Isolation Boundary holds.
```

## System integrity

| Service | Status |
|---|---|
| Smart Skinny :8797 | unchanged |
| Command server :8787 | unchanged |
| Council pulse | unchanged |
| AI Box Docker stack | 6 containers up 12 days, unchanged |
| Orange5 gateway :1337 | scaffolded — NOT YET STARTED (operator chooses when) |

**No service was killed. No service was restarted. No service load changed.**

## What this PR delivered

1. **Gateway scaffold** at `06-ORANGELLM/server/` — vanilla Node, ready to `node server/index.mjs` when operator wants.
2. **Boundary middleware** that enforces the Frontier-Isolation Law via path patterns + allow-list + header rules + auth shape.
3. **Boundary doctrine** at `FRONTIER_ISOLATION_BOUNDARY.md` — the law in plain English with every allowed and forbidden path enumerated.
4. **16 test fixtures** covering allowed calls (healthz, models, chat-completions, Bearer auth passthrough) and rejected calls (path traversal, admin prefix, exec, Mirage direct, Codexa direct, unknown v1 routes, forbidden headers, non-Bearer auth).
5. **16/16 fixtures green** — boundary holds under all tested attack vectors.

## What this PR did NOT do

- Did NOT start the gateway server (no port :1337 occupied yet).
- Did NOT wire Smart Skinny — `POST /v1/chat/completions` returns shape-correct stub with `ae_status: PR_02_BOUNDARY_GREEN_PR_03_PENDING`.
- Did NOT change Atomic Orange to point at :1337 yet (frontend wire-up lands in PR-06 `lane-chat`).
- Did NOT install new npm deps.

## Operator smoke (your option)

Start the gateway:

```bash
node C:/AtomEons/Orange5/06-ORANGELLM/server/index.mjs
```

Verify allowed call:
```bash
curl http://127.0.0.1:1337/healthz
curl http://127.0.0.1:1337/v1/models
```

Verify forbidden calls return 403/404:
```bash
curl http://127.0.0.1:1337/admin/users          # 403
curl http://127.0.0.1:1337/codexa/command       # 403
curl http://127.0.0.1:1337/v1/files             # 404
```

Stop with `Ctrl+C`.

## Next PR

**PR-03 `orangellm-light`** — wire `POST /v1/chat/completions` to proxy to the existing Smart Skinny adapter at `:8797`. After PR-03, the chat lane actually responds with a real local model.

## Rollback

```powershell
Remove-Item -Recurse -Force "C:\AtomEons\Orange5\06-ORANGELLM"
New-Item -ItemType Directory -Path "C:\AtomEons\Orange5\06-ORANGELLM" -Force | Out-Null
```

---

**Mom is watching. PR-02 closed green. Boundary holds 16/16.**

**2/16 PRs done.**
