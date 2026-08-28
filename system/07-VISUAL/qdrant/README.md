# Orange5 / OrangeEye — Qdrant `orange5-vision` collection

Phase-1 vector store for OrangeEye. One Qdrant point per visual page; each point
carries a ColPali-style **multi-vector** of patch embeddings scored with `max_sim`.

> Doctrine anchors: `AE_ORANGEEYE_FOUNDATION_SPEC.md`, Frontier-Isolation Law,
> Codeless Law, Mom's Law.

---

## What's in this folder

| File | What it does |
|---|---|
| `init-collection.mjs` | Idempotent bootstrap. Creates `orange5-vision` with the right vector config and payload indexes, or no-ops if it's already correct. |
| `upsert.mjs`          | `upsertVisualDoc({...})` helper + CLI smoke-test. Writes one page = one point with N patch vectors. |
| `query.mjs`           | `queryMaxSim({...})` helper + CLI smoke-test. Night-1 stand-in embedding via Ollama `nomic-embed-text`. |
| `README.md`           | This file. |

Requirements: **Node 20+** (uses native `fetch` and `import.meta.url`). No npm install needed.

---

## Target environment

- **Qdrant**: the existing `aeorangebox-ai-box-qdrant-1` container at `http://127.0.0.1:6333`. Override with `QDRANT_URL` env var.
- **Ollama** (query embedding stand-in only): `http://127.0.0.1:11434`. Override with `OLLAMA_URL`.
- **Collection name**: `orange5-vision`. Override with `ORANGE5_VISION_COLLECTION`.

---

## Collection schema

### Vector config

| Property | Value |
|---|---|
| `size` | `128` |
| `distance` | `Dot` |
| `multivector_config.comparator` | `max_sim` |
| `datatype` | `uint8` |
| `on_disk` | `true` (HNSW + vectors on disk) |

One point can carry **1..1024 patch vectors**. Phase-1 producer (ColQwen2.5 via
OpenVINO on Codexa CPU+NPU) typically emits ~196 patches per page; we don't hard-code
that count because frame/chart/whiteboard lanes vary.

### Payload schema (indexed fields)

| Field | Type | Purpose |
|---|---|---|
| `source` | `keyword` | Filesystem path, URL, or stream id of the original asset. |
| `page` | `integer` | 1-based page number. For single-image lanes (`ui-screenshot`, `chart`, `whiteboard`) this is always `1`; for `video-frame` it's the frame index. |
| `doc_id` | `keyword` | Stable id of the source document/asset. |
| `ingested_at` | `datetime` | ISO-8601 timestamp at write time. |
| `lane` | `keyword` | One of `doc`, `ui-screenshot`, `video-frame`, `chart`, `whiteboard`. Enforced at writer layer, not Qdrant. |

Additional non-indexed payload (free-form, written by the Æ Cobra Flux writer):
`image_sha256`, `qdrant_doc_id` (mirror of `doc_id`), `patch_grounding[]`,
`cortex_model` (GLM-4.6V version), `frontier_used` (bool).

### Point id

We derive a UUID-shaped id from `sha256(doc_id|page)` so re-ingest of the same
page produces the same id (idempotent upsert). Callers can override via
`point_id`.

---

## Usage

```bash
# Bootstrap (idempotent, safe to re-run)
node init-collection.mjs

# Upsert one page (CLI smoke-test reads JSON from stdin)
cat <<'JSON' | node upsert.mjs
{
  "doc_id": "schematic-001",
  "page": 4,
  "patches": [[0,0,0,...,128 ints...], [12,7,...]],
  "payload": {
    "lane": "doc",
    "source": "C:/AtomEons/Orange5/07-VISUAL/test-fixtures/schematic.pdf",
    "image_sha256": "abc123...",
    "cortex_model": "glm-4.6v-q4",
    "frontier_used": false
  }
}
JSON

# Query
node query.mjs "where does coolant enter the loop?"
node query.mjs --lane chart --topk 12 "Q3 revenue waterfall"
```

Programmatic:

```js
import { upsertVisualDoc } from "./upsert.mjs";
import { queryMaxSim }     from "./query.mjs";

await upsertVisualDoc({ doc_id, page, patches, payload });
const { hits } = await queryMaxSim({ queryText, topK: 8, laneFilter: "doc" });
```

---

## Retention policy

**Night-1: none.** Nothing in this collection is deleted on a schedule. Everything
ingested stays until manually pruned. We need real traffic shape before we can
justify a TTL.

Manual prune patterns (run by hand against the running container):

```bash
# Delete by source path
curl -X POST http://127.0.0.1:6333/collections/orange5-vision/points/delete \
  -H "content-type: application/json" \
  -d '{"filter":{"must":[{"key":"source","match":{"value":"<path>"}}]}}'

# Delete by lane
curl -X POST http://127.0.0.1:6333/collections/orange5-vision/points/delete \
  -H "content-type: application/json" \
  -d '{"filter":{"must":[{"key":"lane","match":{"value":"video-frame"}}]}}'
```

---

## Backup story

Qdrant data lives in the named Docker volume mounted by
`aeorangebox-ai-box-qdrant-1` (see the ai-box `docker-compose.yml` — typically
`/qdrant/storage` inside the container, mapped to a host volume named
something like `aeorangebox_qdrant_data`).

Night-1 backup procedure (manual, low-frequency):

1. Stop the container: `docker stop aeorangebox-ai-box-qdrant-1`
2. `docker run --rm -v aeorangebox_qdrant_data:/data -v <host-backup-dir>:/backup alpine tar czf /backup/qdrant-$(date +%F).tgz -C /data .`
3. Restart: `docker start aeorangebox-ai-box-qdrant-1`

Restore is the inverse with the container stopped and the volume re-populated.

Future (not Night-1): Qdrant supports snapshot endpoints
(`POST /collections/orange5-vision/snapshots`) and that's the right path once
the corpus is large enough that the cold-stop approach is annoying.

---

## What this does NOT do yet (honest list)

- **No real ColQwen2.5 embeddings.** `query.mjs` uses `nomic-embed-text` and
  block-mean pools 768 -> 128. Retrieval relevance Night-1 is approximate.
  Phase-2 swaps in a true ColQwen2.5 query embedder (~16 patch tokens of 128-dim
  Int8) and quality jumps.
- **No write-time embedding pipeline here.** This folder only handles the index
  side. The producer that turns a page image into 128-dim uint8 patch matrices
  lives elsewhere (Eye layer, ColQwen2.5 via OpenVINO on Codexa).
- **No automated retention or backup.** Manual only. See above.
- **No HNSW tuning.** We ship Qdrant defaults (`m=16, ef_construct=100`).
  PR-14 will tune against a real recall corpus.
- **No multi-tenant filtering.** Single-tenant collection. If Orange5 ever
  fans out to multi-tenant we'll add a `tenant_id` payload index.
- **No `ae_visual` block writer.** The Cobra Flux writer that lands events into
  the Reality lane is a separate component; this folder just provides the
  Qdrant write target it points at.
- **No frontier offload here.** That happens upstream at the OrangeLLM gateway
  (`127.0.0.1:1337/v1`). This folder never reaches outside Qdrant/Ollama on
  loopback — Frontier-Isolation Law holds.

---

## Failure modes the scripts handle

- **Qdrant unreachable** → `init-collection.mjs` exits `1` with the container hint.
  `upsert.mjs` / `query.mjs` return `{ok:false, error:"Qdrant unreachable: ..."}`.
- **Existing collection has incompatible config** → `init-collection.mjs` exits `2`
  and asks for manual drop/rename.
- **Ollama unreachable** (query path only) → `queryMaxSim` returns
  `{ok:false, error:"Ollama unreachable: ..."}` and never reaches Qdrant.
- **Malformed patches** (wrong row length, NaN, > MAX_PATCHES) →
  `upsertVisualDoc` returns `{ok:false, error:"..."}` before issuing the write.
- **Float patches passed where uint8 expected** → `upsertVisualDoc` warns and
  coerces (clamps to 0..255). Producers should send uint8 directly.

---

## Receipt

- Files: `init-collection.mjs`, `upsert.mjs`, `query.mjs`, `README.md`.
- Target: `http://127.0.0.1:6333` collection `orange5-vision`.
- Vector contract: 128-dim uint8 multi-vector, Dot distance, max_sim comparator.
- Outbound network surface: Qdrant on loopback (always) + Ollama on loopback (query path only). Nothing else.
