# Receipt — PR-17 `runtime-router-repair`

**Receipt ID:** `2026-06-24-pr-17-runtime-router-repair`
**Hash chain:** #012
**Previous receipt hash:** `F71B63266DFF0033D238CB3A6CAD58E47EC22766C147E214A2698B5B52B4A177`
**Status:** `ORANGE5_RUNTIME_ROUTER_REPAIR_GREEN_WITH_UPSTREAMS_BLOCKED`
**Confidence:** 0.94
**Generated:** 2026-06-24T04:59:00Z

## What changed

1. OrangeLLM heavy rail fallback now forwards `ORANGEBOX_RAIL_TOKEN` when the environment variable is present.
2. OrangeLLM chat routing now honors explicit heavy model IDs such as `orangellm-heavy-codexa` instead of silently routing every request to the light tier.
3. Atomic Orange Vite config no longer requires Node type definitions just to read `TAURI_DEV_HOST`; this preserves the no-new-install posture.
4. Not-green ledger wording now distinguishes the fixed gateway forwarding from the still-missing live token.

## Files changed

| File | SHA-256 after |
|---|---|
| `02-APP/vite.config.ts` | `5C212580A899C42E2FAE33F1FC9B827854D666C54108FB15C0CB88F1D8999002` |
| `06-ORANGELLM/server/upstream.mjs` | `BC8ED9D2FC3D47E58B30B05ECC54B53D2AE0AA48A75567A28F3496377CEDFC5E` |
| `06-ORANGELLM/server/routes/v1.mjs` | `3F6900218BF74AD80AAF07DCCD8A99E1A2B42BAD70A2F83739B22DF18408165E` |
| `00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md` | `AED02212BD20F8577F913E1060D6CB0C857420A154E7A53F62258DC063217AFC` |

## Proof

| Check | Result |
|---|---|
| `powershell -ExecutionPolicy Bypass -File 00-CHARTER/run-all-tests.ps1` | `Orange5 verifier - 7 green / 0 red` |
| `cd 02-APP && npm run build` | PASS; Vite production build completed |
| `GET http://127.0.0.1:1337/healthz` | PASS; gateway responds `200` with `status: degraded` because upstreams are blocked |
| `GET http://127.0.0.1:1337/v1/models` | PASS; model list responds and reports Smart Skinny unreachable honestly |
| `GET http://127.0.0.1:1420/` | PASS; Atomic Orange dev UI responds `200` |
| `POST /v1/chat/completions` light | Correctly returns `502 upstream_unreachable` while Smart Skinny `:8797` is down |
| `POST /v1/chat/completions` heavy | Correctly returns `502 heavy_unreachable`; direct Ollama `:11434` unavailable and rail `:8097` returns `401` without token |

## Live runtime state

| Service | State |
|---|---|
| Atomic Orange dev UI | listening on `127.0.0.1:1420` |
| OrangeLLM gateway | listening on `127.0.0.1:1337` |
| Orangebox command server | listening on `127.0.0.1:8787` |
| Smart Skinny | not listening on `127.0.0.1:8797` |
| Codexa rail | reachable at `10.0.99.1:8097`, but auth returns `401` until `ORANGEBOX_RAIL_TOKEN` is present |
| Codexa direct Ollama | not reachable at `10.0.99.1:11434` from this machine |

## Honest not-green items remaining

1. Smart Skinny `:8797` must be started or its actual endpoint must be written into `06-ORANGELLM/server/upstream.mjs`.
2. `ORANGEBOX_RAIL_TOKEN` must be set in the environment that starts OrangeLLM before Codexa heavy fallback can pass auth.
3. Codexa direct Ollama can stay closed if command rail is the intended heavy path.

No fake-green. The spine remains green; live upstream model execution is still blocked by operator-managed services/secrets.
