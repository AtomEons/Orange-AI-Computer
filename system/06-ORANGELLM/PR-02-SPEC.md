# PR-02 — `frontier-isolation` Spec

**PR ID:** Orange5/PR-02
**Branch name:** `frontier-isolation`
**Status:** EXECUTING
**Prior PR:** PR-01 `native-rail` (closed)

---

## Law being enforced

**Frontier-Isolation Law (from Master Plan §2.1):**

> The frontier model hosted in Atomic Orange (Opus 4.7 / Gemini / GPT-5.5 / GLM, BYO key) talks only to OrangeLLM. It never touches Orange5 internals.

This PR builds the only legal door: `127.0.0.1:1337/v1`.

---

## What this PR ships

1. **OrangeLLM gateway server** scaffold at `06-ORANGELLM/server/` — vanilla Node http (zero new deps; no extra npm install needed).
2. **OpenAI-compatible endpoint surface** on `127.0.0.1:1337/v1`:
   - `POST /v1/chat/completions`
   - `GET /v1/models`
   - `GET /healthz` (system check)
3. **Boundary middleware** (`server/boundary.mjs`) that:
   - Accepts only `POST /v1/chat/completions` and `GET /v1/models` and `GET /healthz`
   - Rejects any path containing `..`, absolute filesystem paths, or non-v1 prefixes with 404
   - Rejects suspicious headers (Authorization with non-bearer; Mirage mount headers)
   - Caps body size at 1 MB
   - Logs every rejection to receipts
4. **Boundary doc** at `06-ORANGELLM/FRONTIER_ISOLATION_BOUNDARY.md` — the law in plain English.
5. **Test fixtures** at `06-ORANGELLM/tests/boundary-fixtures.json` — allowed calls + forbidden calls.

## What this PR does NOT do

- Does NOT make OrangeLLM serve real model responses (that's PR-03 — gateway returns 503 SERVICE_NOT_YET_WIRED for now).
- Does NOT bind to non-loopback addresses (security: 127.0.0.1 only).
- Does NOT start the server (operator runs `node 06-ORANGELLM/server/index.mjs` or it gets supervised in PR-10 adapters).
- Does NOT touch the existing `:8787` command server or `:8797` Smart Skinny.

## Steps

| # | File | Purpose |
|---|---|---|
| 1 | `06-ORANGELLM/PR-02-SPEC.md` | This file |
| 2 | `06-ORANGELLM/server/index.mjs` | http server entry, 127.0.0.1:1337 |
| 3 | `06-ORANGELLM/server/boundary.mjs` | Boundary enforcement middleware |
| 4 | `06-ORANGELLM/server/routes/v1.mjs` | /v1/chat/completions + /v1/models route handlers |
| 5 | `06-ORANGELLM/server/routes/healthz.mjs` | /healthz handler |
| 6 | `06-ORANGELLM/server/README.md` | How to run + supervised mode |
| 7 | `06-ORANGELLM/FRONTIER_ISOLATION_BOUNDARY.md` | The law doc |
| 8 | `06-ORANGELLM/tests/boundary-fixtures.json` | Test fixtures |
| 9 | `06-ORANGELLM/tests/run-boundary-tests.mjs` | Test runner |
| 10 | `10-RECEIPTS/orange5-build/2026-06-23-pr-02-frontier-isolation-closed.md` | Close receipt |

## Approval gates inside this PR

None — all writes land inside `06-ORANGELLM/` and `10-RECEIPTS/`. No service restart. No npm install.

## Risk + rollback

**Risk:** None to running services. The server is scaffolded but NOT started. Existing `:1337/v1` (if anything is on it) is untouched.

**Rollback:**
```powershell
Remove-Item -Recurse -Force "C:\AtomEons\Orange5\06-ORANGELLM\server"
Remove-Item -Force "C:\AtomEons\Orange5\06-ORANGELLM\PR-02-SPEC.md"
Remove-Item -Force "C:\AtomEons\Orange5\06-ORANGELLM\FRONTIER_ISOLATION_BOUNDARY.md"
Remove-Item -Recurse -Force "C:\AtomEons\Orange5\06-ORANGELLM\tests"
```

## Next PR

**PR-03 `orangellm-light`** — Smart Skinny on N150 always-warm. The PR-02 gateway proxies to Smart Skinny at `:8797`. After PR-03 closes, `POST :1337/v1/chat/completions` returns real model output.
