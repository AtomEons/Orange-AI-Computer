# PR-03 — `orangellm-light` Spec

**PR ID:** Orange5/PR-03
**Branch name:** `orangellm-light`
**Status:** EXECUTING
**Prior PR:** PR-02 `frontier-isolation` (closed, 16/16 green)

---

## Goal

Wire the OrangeLLM gateway's `POST /v1/chat/completions` to the existing Smart Skinny adapter at `127.0.0.1:8797`. After this PR, frontier hitting `:1337/v1/chat/completions` gets a real local model response, not a stub.

The Frontier-Isolation Boundary from PR-02 still applies — every request still passes through `boundary.mjs` first.

## What this PR ships

1. **Upstream config** at `06-ORANGELLM/server/upstream.mjs` — declares Smart Skinny endpoint and timeout.
2. **Updated `routes/v1.mjs`** — chat-completions proxies to `:8797`. Returns the upstream response shape-as-is.
3. **Updated `routes/healthz.mjs`** — probes `:8797` and reports upstream live/dead in healthz body.
4. **Upstream probe test** at `06-ORANGELLM/tests/upstream-probe.mjs` — verifies Smart Skinny is reachable from this machine. Operator-run.
5. **Updated boundary fixtures** — add a fixture noting chat-completions now expects 200 (post PR-03), not 503.

## What this PR does NOT do

- Does NOT auto-start the gateway server.
- Does NOT modify the running Smart Skinny adapter at `:8797`.
- Does NOT restart anything.
- Does NOT install new npm deps.

## Operator smoke (your option, after PR-03 lands)

```bash
# Terminal 1 — start the gateway
node C:/AtomEons/Orange5/06-ORANGELLM/server/index.mjs

# Terminal 2 — verify upstream probe
node C:/AtomEons/Orange5/06-ORANGELLM/tests/upstream-probe.mjs

# Terminal 3 — real chat through the gateway
curl http://127.0.0.1:1337/healthz
curl -X POST http://127.0.0.1:1337/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"say hi in 5 words"}]}'
```

If the curl returns a real model response with `choices[0].message.content` populated, PR-03 closes confident 1.0.

## Risk

| Risk | Mitigation |
|---|---|
| Smart Skinny `:8797` returns slowly or hangs | Upstream timeout set to 60s; gateway returns 504 GATEWAY_TIMEOUT if exceeded |
| Smart Skinny shape doesn't match OpenAI exactly | We pass through with minimal munging; if it's already OpenAI-compatible per orangebox_status, no munging needed |
| Smart Skinny down | healthz reports `upstream: down`; chat-completions returns 503 |
| N150 CPU spike | Gateway adds negligible load — it's just a proxy |

## Rollback

```powershell
# Revert v1.mjs to PR-02 stub version
# (re-write from PR-02-SPEC.md)
Remove-Item -Force "C:\AtomEons\Orange5\06-ORANGELLM\server\upstream.mjs"
Remove-Item -Force "C:\AtomEons\Orange5\06-ORANGELLM\tests\upstream-probe.mjs"
```

## Next PR

**PR-04 `orangellm-heavy`** — spec the fatty model on Codexa (Qwen 35B A3B default warm; LoRA training pipeline). PR-04 is mostly spec + Codexa setup; the heavy model is provisioned via Codexa rail, not local.
