# OrangeLLM gateway — visual routes

Path: `06-ORANGELLM/server/routes/visual.mjs`
Boundary patch: `06-ORANGELLM/server/routes/visual-boundary.mjs`
Doctrine: `07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md`

The visual routes are the only legal door from the operator's app + frontier
model to OrangeEye Phase-1. Three endpoints, all loopback-only via the parent
gateway on `127.0.0.1:1337`.

## Frontier-Isolation Law (binding)

- External frontier models reach OrangeEye **only** through this gateway.
- `/v1/visual/describe` may offload to a frontier model. When it does, it
  self-calls `POST /v1/chat/completions` on `127.0.0.1:1337`. It never opens
  a direct socket to Anthropic, OpenAI, Google, etc.
- The frontier never sees Mirage mounts, Codexa rails, Orangebox commands,
  raw Qdrant URLs, or local filesystem paths. Routes return Qdrant payloads
  only after sanitization through the upsert/query modules.

## Routes

### `POST /v1/visual/ingest`

Pipe a single image or PDF into the visual index.

**Request — multipart/form-data:**

| field         | required | shape                                                       |
| ------------- | -------- | ----------------------------------------------------------- |
| `file`        | yes      | binary (image: PNG/JPEG/WebP; or PDF). Max 50 MB by default. |
| `source_hint` | no       | short string, ≤256 chars. Free-form context tag.            |
| `lane`        | no       | one of `doc`, `ui-screenshot`, `video-frame`, `chart`, `whiteboard`. Default `doc`. |

**Pipeline:**

1. POST bytes to ColPali service at `127.0.0.1:7440/ingest`.
2. Upsert each page's patch matrix into Qdrant collection `orange5-vision`
   via `07-VISUAL/qdrant/upsert.mjs`.
3. Append a Reality-lane observation via `07-VISUAL/visual-event/writer.mjs`
   with origin `orangeeye` and an `ae_visual` block.

**Response 200:**

```json
{
  "doc_id": "doc-3f2c…",
  "pages_ingested": 1,
  "patches_indexed": 196,
  "image_sha256": "…",
  "visual_event_written": true
}
```

**Response 207 (partial):** index succeeded, but Reality-lane writer failed.
`warning` field explains. The Qdrant points are not rolled back — they are
already useful for retrieval; the operator can retry just the event-write.

**Error codes:**

| HTTP | code                    | meaning                                           |
| ---- | ----------------------- | ------------------------------------------------- |
| 400  | `FILE_REQUIRED`         | multipart had no `file` field or it was empty.    |
| 400  | `INVALID_LANE`          | lane not in the allow-set.                        |
| 400  | `MULTIPART_MALFORMED`   | boundary parser couldn't decode the body.         |
| 413  | `PAYLOAD_TOO_LARGE`     | file > `ORANGE5_VISUAL_MAX_BYTES` (default 50 MB). |
| 415  | `EXPECT_MULTIPART`      | `Content-Type` was not `multipart/form-data`.     |
| 502  | `COLPALI_HTTP_ERROR`    | ColPali responded non-2xx.                        |
| 502  | `COLPALI_BAD_RESPONSE`  | ColPali response wasn't JSON or missing patches.  |
| 502  | `QDRANT_UPSERT_FAILED`  | Qdrant rejected the upsert; partial pages noted.  |
| 503  | `COLPALI_UNREACHABLE`   | ColPali service at :7440 is down.                 |
| 503  | `VISUAL_DEPS_MISSING`   | sibling Qdrant / visual-event modules not loadable. |

### `POST /v1/visual/query`

Find pages in `orange5-vision` whose patch matrix matches a text query.

**Request — application/json:**

```json
{
  "query": "schematic showing coolant flow",
  "top_k": 8,
  "lane": null
}
```

- `query` — required, non-empty string.
- `top_k` — integer, default 8, clamped to `[1, 64]`.
- `lane` — optional. String or array of strings from the lane allow-set, or `null` for all lanes.

**Response 200:**

```json
{
  "results": [
    {
      "doc_id": "doc-3f2c…",
      "page": 1,
      "score": 31.7,
      "payload": { "lane": "doc", "source": "datasheet.pdf", "image_sha256": "…" },
      "patch_grounding": []
    }
  ],
  "stand_in": "nomic-768-to-128-blockpool",
  "note": "Phase-2 swaps in ColQwen2.5 query embedding…"
}
```

`patch_grounding` is intentionally empty in Night-1 — see "What this does NOT
do yet" below.

**Error codes:**

| HTTP | code                  | meaning                                              |
| ---- | --------------------- | ---------------------------------------------------- |
| 400  | `QUERY_REQUIRED`      | empty or missing `query` string.                     |
| 400  | `INVALID_LANE`        | lane value not recognized.                           |
| 400  | `INVALID_JSON`        | body wasn't valid JSON.                              |
| 502  | `QUERY_FAILED`        | Qdrant returned an error.                            |
| 503  | `QUERY_FAILED`        | embedder or Qdrant unreachable (message names which). |
| 503  | `VISUAL_DEPS_MISSING` | sibling query module not loadable.                   |

### `POST /v1/visual/describe`

Generate a structured description of one indexed page or one inline image.

**Request — application/json (exactly one of `doc_id` or `image_url`):**

```json
{
  "doc_id": "doc-3f2c…",
  "page": 1,
  "prompt": "Summarize what this page shows.",
  "deep": false,
  "model": "claude-opus-4-7"
}
```

OR:

```json
{
  "image_url": "http://127.0.0.1:8080/static/page-3.png",
  "prompt": "What chart type is this?",
  "deep": true
}
```

- `image_url` must resolve to loopback (`127.0.0.1`, `localhost`, `::1`).
  SSRF guard: any other host is rejected with `IMAGE_URL_NOT_LOOPBACK`.
- `deep` — explicit operator override to skip the local cortex and go
  straight to a frontier offload via the gateway.
- `prompt` — optional override; default asks for a JSON-shaped summary.
- `model` — optional override of the frontier model id used on offload.
  Must start with `orangellm-` to satisfy the existing `/v1/chat/completions`
  guard.

**Pipeline:**

1. Try local cortex: GLM-4.6V via Ollama at `127.0.0.1:11434/api/generate`,
   `stream=false`, `temperature=0.2`. Parse the response as JSON
   (code-fence stripping is defensive).
2. If any of the following hold, offload to the frontier via the gateway:
   - `deep: true` was passed.
   - Local confidence < `ORANGE5_CORTEX_CONFIDENCE` (default `0.7`).
   - The cortex flagged `layout_complexity_high` or `token_budget_exceeded`.
3. Frontier offload self-calls `POST 127.0.0.1:1337/v1/chat/completions`.
   The caller's `Authorization: Bearer …` is forwarded so the BYO API key
   reaches the configured upstream.
4. Best-effort append to the Reality lane via the visual-event writer.

**Response 200:**

```json
{
  "answer": {
    "summary": "…",
    "entities": ["coolant pump", "throttle body"],
    "files": ["datasheet.pdf"],
    "commands": [],
    "risk": "low",
    "next_action": "respond",
    "confidence": 0.83
  },
  "grounding": {
    "doc_id": "doc-3f2c…",
    "page": 1,
    "lane": "doc",
    "source": "datasheet.pdf",
    "source_hint": "Q3 hardware audit"
  },
  "cortex_model": "glm-4.6v",
  "frontier_used": false,
  "frontier_model": null
}
```

**Response 207 (partial):** local cortex produced an answer but the
frontier offload failed. `frontier_error` explains; `answer` is still the
local cortex output.

**Error codes:**

| HTTP | code                          | meaning                                                  |
| ---- | ----------------------------- | -------------------------------------------------------- |
| 400  | `TARGET_REQUIRED`             | neither `doc_id` nor `image_url` provided.               |
| 400  | `TARGET_AMBIGUOUS`            | both `doc_id` and `image_url` provided.                  |
| 400  | `IMAGE_URL_NOT_LOOPBACK`      | non-loopback URL — SSRF guard.                           |
| 404  | `DOC_NOT_FOUND`               | doc_id (+page) not in Qdrant.                            |
| 413  | `IMAGE_TOO_LARGE`             | inline image > 50 MB.                                    |
| 502  | `CORTEX_HTTP_ERROR`           | Ollama responded non-2xx.                                |
| 502  | `CORTEX_BAD_RESPONSE`         | Ollama response wasn't JSON.                             |
| 502  | `FRONTIER_HTTP_ERROR`         | gateway self-call returned non-2xx (BYO key bad?).       |
| 503  | `CORTEX_UNREACHABLE`          | Ollama at :11434 is down.                                |
| 503  | `FRONTIER_GATEWAY_UNREACHABLE`| gateway can't self-call (loopback broken / port shifted).|

## Boundary patch

Add the three paths to the gateway's allow-list with a single splice in
`boundary.mjs`:

```js
import { MEMORY_ALLOWED } from "./routes/memory-boundary.mjs";
import { VISUAL_ALLOWED } from "./routes/visual-boundary.mjs";

const ALLOWED = [
  { method: "GET",  path: "/healthz" },
  { method: "GET",  path: "/v1/models" },
  { method: "POST", path: "/v1/chat/completions" },
  ...MEMORY_ALLOWED,
  ...VISUAL_ALLOWED,
];
```

The existing `FORBIDDEN_PATH_PATTERNS` regex passes `/v1/visual/*` because
the prefix is `/v1/`, not `/api/` or `/mirage/`. Keep visual routes under
`/v1/` to inherit that pass and to stay OpenAI-shape-adjacent.

## Wiring into `index.mjs`

Two options. Either splice handler calls into the existing if-ladder:

```js
import { __handlers as visualHandlers } from "./routes/visual.mjs";
// inside createServer's request handler:
if (method === "POST" && path === "/v1/visual/ingest")   return visualHandlers.handleIngest(req, res);
if (method === "POST" && path === "/v1/visual/query")    return visualHandlers.handleQuery(req, res);
if (method === "POST" && path === "/v1/visual/describe") return visualHandlers.handleDescribe(req, res);
```

Or attach a second request listener once at startup:

```js
import { registerVisualRoutes } from "./routes/visual.mjs";
// after `const server = createServer(...)`:
registerVisualRoutes(server);
```

The listener approach is non-invasive and lets the existing 404 fallthrough
keep working for unknown paths.

## Environment

| variable                          | default                          | meaning                                  |
| --------------------------------- | -------------------------------- | ---------------------------------------- |
| `ORANGE5_COLPALI_URL`             | `http://127.0.0.1:7440`          | ColPali / ColQwen2.5 service.            |
| `OLLAMA_URL`                      | `http://127.0.0.1:11434`         | Ollama host for cortex + embedder.       |
| `ORANGE5_CORTEX_MODEL`            | `glm-4.6v`                       | Local cortex model id in Ollama.         |
| `ORANGE5_CORTEX_CONFIDENCE`       | `0.7`                            | Below this triggers frontier offload.    |
| `ORANGE5_GATEWAY_SELF_URL`        | `http://127.0.0.1:1337`          | Gateway self-call base for offload.      |
| `ORANGE5_VISUAL_MAX_BYTES`        | `52428800` (50 MB)               | Multipart ingest cap.                    |
| `ORANGE5_VISUAL_MAX_JSON`         | `1000000` (1 MB)                 | JSON body cap for query/describe.        |
| `QDRANT_URL`                      | `http://127.0.0.1:6333`          | Read by sibling Qdrant modules.          |
| `ORANGE5_VISION_COLLECTION`       | `orange5-vision`                 | Read by sibling Qdrant modules.          |

## Backpressure when Qdrant is unreachable

- `/v1/visual/ingest` returns `503 COLPALI_UNREACHABLE` if ColPali is down,
  or `502 QDRANT_UPSERT_FAILED` (with `pages_succeeded`) if ColPali succeeded
  but Qdrant rejected the upsert. No retry/queue is built into the gateway
  layer — that is a Phase-2 concern. The operator should treat 502/503 on
  ingest as "back off and retry from the client".
- `/v1/visual/query` returns `503 QUERY_FAILED` with the underlying message
  ("Ollama unreachable…" or "Qdrant unreachable…") so the caller can tell
  the embedder side from the index side without parsing tracebacks.
- `/v1/visual/describe` degrades gracefully: if the frontier offload fails
  but the local cortex succeeded, the response is `207` with `frontier_used:
  false` and `frontier_error: "..."`. The Reality-lane append is wrapped in
  a try/catch and never fails the response — receipts upstream will still
  show the cortex call, just not the visual_event row.

## What this does NOT do yet

- **Multi-page PDF ingest.** ColPali Phase-1 is single-image. Multi-page
  PDFs need server-side splitting first. The gateway normalizes both the
  2-D and 3-D patches shape so the day ColPali supports multi-page, no
  gateway change is needed.
- **Per-patch grounding on query.** Night-1 query embedding is a
  block-pooled stand-in (`nomic-768-to-128-blockpool`); per-patch
  attribution is structurally impossible until ColQwen2.5 query
  embeddings land. `patch_grounding` is returned as `[]` honestly.
- **Streaming responses.** Visual answers are short; non-stream is fine.
  When the frontier offload is large, the gateway buffers the full response
  before returning.
- **Re-rendering Qdrant pages back into images for describe.** The image
  bytes are not stored in Qdrant or in the Reality lane. `doc_id`-mode
  describe runs text-only context against the cortex; only `image_url`
  mode passes inline bytes. A later phase can add a `content://` blob
  store and lift that limitation.
- **Authentication beyond the boundary.** The gateway runs on loopback and
  trusts the boundary middleware. The operator is responsible for not
  exposing :1337 to the network.
- **Rate-limiting and queueing.** A burst of large multipart ingests will
  back up against ColPali's single-process Python. The gateway does not
  serialize or fair-share; that is a Phase-2 control-plane concern.
- **OpenAI tool-call shape for /describe.** Output is a JSON object, not a
  `tool_calls` array. The frontier offload's response is unwrapped from the
  chat-completions envelope into the same shape.

## Testing the path locally

Smoke test, assuming ColPali, Qdrant, and Ollama are running and the
gateway is up:

```bash
# Ingest one page
curl -sS -F "file=@page.png" -F "lane=doc" -F "source_hint=q3-audit" \
  http://127.0.0.1:1337/v1/visual/ingest | jq .

# Query
curl -sS -X POST http://127.0.0.1:1337/v1/visual/query \
  -H "content-type: application/json" \
  -d '{"query":"coolant flow schematic","top_k":4}' | jq .

# Describe by doc_id (local cortex only)
curl -sS -X POST http://127.0.0.1:1337/v1/visual/describe \
  -H "content-type: application/json" \
  -d '{"doc_id":"doc-3f2c…","page":1}' | jq .

# Describe by inline loopback image, force deep
curl -sS -X POST http://127.0.0.1:1337/v1/visual/describe \
  -H "content-type: application/json" \
  -H "authorization: Bearer sk-…" \
  -d '{"image_url":"http://127.0.0.1:8080/page.png","deep":true}' | jq .
```

If any of ColPali, Qdrant, or Ollama is down, the response will name the
specific failing service so you do not have to guess.
