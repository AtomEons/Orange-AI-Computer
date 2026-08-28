# 06-ORANGELLM / server — Gateway

The OrangeLLM gateway. Binds `127.0.0.1:1337`. The **only legal door** from frontier models (BYO Opus / Gemini / GPT / GLM) to Orange5.

## Run

```bash
node C:/AtomEons/Orange5/06-ORANGELLM/server/index.mjs
```

Server logs:
```
[orangellm] listening on 127.0.0.1:1337 (orange5.orangellm.v0.1.0-pr02)
[orangellm] frontier-isolation law active — only /v1/chat/completions, /v1/models, /healthz reachable
```

## Verify

```bash
curl http://127.0.0.1:1337/healthz
curl http://127.0.0.1:1337/v1/models
curl -X POST http://127.0.0.1:1337/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"hello"}]}'
```

The chat-completions call returns a 503-stub until PR-03 wires Smart Skinny.

## Forbidden — should all return 404 or 403

```bash
curl http://127.0.0.1:1337/api/admin            # 403 (forbidden path pattern)
curl http://127.0.0.1:1337/v1/files             # 404 (endpoint not exposed)
curl http://127.0.0.1:1337/../etc/passwd        # 403 (path traversal)
curl http://127.0.0.1:1337/v1/models \
  -H "X-Mirage-Mount: postgres_write"           # 403 (forbidden header)
```

## Boundary

See `../FRONTIER_ISOLATION_BOUNDARY.md` for the law.

## What's next

PR-03 `orangellm-light` proxies `POST /v1/chat/completions` to Smart Skinny at `:8797`.
