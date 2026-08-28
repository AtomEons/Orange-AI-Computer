# Receipt - OrangeEye Phase-1 Scaffold AUTHORED

**Receipt ID:** `2026-06-24-orangeeye-phase-1-scaffold-authored`
**Schema:** `orange5.receipt.v0`
**Hash chain:** #014
**Prior receipt:** `2026-06-24-step-01-native-truth-partial-build-time-gate`
**Generated at:** 2026-06-24
**Status:** `ORANGEEYE_PHASE_1_SCAFFOLD_AUTHORED_AWAITING_CODEXA_INTEGRATION`
**Confidence:** 0.83
**Actor:** Claude / orangeeye-phase-1 workflow (6 parallel authors + synthesis agent)
**Sovereign:** Atom McCree

---

## What happened

Six parallel authors landed the OrangeEye Phase-1 visual cortex scaffold across the `07-VISUAL/` lane and the `06-ORANGELLM/server/routes/` gateway. All files are syntax-checked at author time (`node --check`, `python ast.parse`, `bun build` clean). Nothing has been executed end-to-end against live Codexa services — this receipt records authorship readiness, not field verification. Integration smoke is the next operator step.

---

## Component table

| # | Component | Files | Lines |
|---|---|---|---|
| 1 | colpali-service (Bun gateway + Python ColQwen2 worker + systemd unit) | `07-VISUAL/colpali-service/server.mjs`, `07-VISUAL/colpali-service/python/colqwen_ingest.py`, `07-VISUAL/colpali-service/systemd/colpali.service`, `07-VISUAL/colpali-service/README.md` | 232 + 205 + 68 + 141 = **646** |
| 2 | orangeeye-qdrant-init (collection bootstrap + upsert + query stand-in) | `07-VISUAL/qdrant/init-collection.mjs`, `07-VISUAL/qdrant/upsert.mjs`, `07-VISUAL/qdrant/query.mjs`, `07-VISUAL/qdrant/README.md` | 195 + 172 + 198 + 195 = **760** |
| 3 | orangeeye-visual-event-writer (Reality-lane Flux append wrapper) | `07-VISUAL/visual-event/writer.mjs`, `07-VISUAL/visual-event/test-fixtures.json`, `07-VISUAL/visual-event/README.md` | 193 + 73 + 147 = **413** |
| 4 | orangellm-visual-routes (gateway `/v1/visual/*` + boundary patch) | `06-ORANGELLM/server/routes/visual.mjs`, `06-ORANGELLM/server/routes/visual-boundary.mjs`, `06-ORANGELLM/server/routes/README.md` | 893 + 79 + 349 = **1321** |
| 5 | orangeeye-vault-ui-patches (atomic-orange Vault lane drop-in) | `07-VISUAL/atomic-orange-patches/Vault.tsx`, `07-VISUAL/atomic-orange-patches/vault-styles.css`, `07-VISUAL/atomic-orange-patches/README.md` | 416 + 96 + 94 = **606** |
| 6 | 07-VISUAL/smoke-test (Bun five-step end-to-end validator + deterministic PDF generator) | `07-VISUAL/smoke-test.mjs`, `07-VISUAL/test-pdf-generator.mjs`, `07-VISUAL/README.md` | 434 + 214 + 202 = **850** |
| **Total** | **6 components** | **19 files** | **4,596 lines** |

---

## Endpoint inventory (new HTTP surface)

| Endpoint | Method | Host:Port | Purpose | Source |
|---|---|---|---|---|
| `/ingest` | POST | `127.0.0.1:7440` | Multipart image → ColQwen2 patch embeddings (int8, 128-dim) | `colpali-service/server.mjs` |
| `/v1/visual/ingest` | POST | `127.0.0.1:1337` (gateway) | Multipart image/PDF → ColPali → Qdrant upsert → Reality Flux append | `06-ORANGELLM/server/routes/visual.mjs` |
| `/v1/visual/query` | POST | `127.0.0.1:1337` (gateway) | Text query → query embedding → Qdrant search (max_sim) → ranked hits | `06-ORANGELLM/server/routes/visual.mjs` |
| `/v1/visual/describe` | POST | `127.0.0.1:1337` (gateway) | doc_id+page+bbox → GLM-4.6V local cortex → optional frontier offload (via self-call to `/v1/chat/completions`) → Reality Flux append | `06-ORANGELLM/server/routes/visual.mjs` |

All four endpoints bind loopback-only. Frontier offload on `/describe` is mediated by the gateway's existing chat-completions route — no direct frontier socket is opened from the visual lane. **Frontier-Isolation Law upheld.**

---

## Integration order (operator runs on Codexa)

Run in this order. Each step has a clear pass/fail signal.

1. **Bootstrap Qdrant collection**
   ```
   cd Orange5/07-VISUAL/qdrant && node init-collection.mjs
   ```
   Expect exit 0. Creates `orange5-vision` (vec size 128, dot, multivector max_sim, datatype uint8, on_disk true) plus payload indexes (source, page, doc_id, ingested_at, lane). Idempotent — re-runs no-op if compatible, refuse with exit 2 if incompatible.

2. **Install + enable ColPali service**
   ```
   sudo cp Orange5/07-VISUAL/colpali-service/systemd/colpali.service /etc/systemd/system/
   sudo useradd -r -s /sbin/nologin colpali  # if not present
   sudo systemctl daemon-reload
   sudo systemctl enable --now colpali
   curl http://127.0.0.1:7440/  # any 200/405 = up
   ```
   MemoryMax=10G enforced. ColQwen2-v1.0 weights pulled on first start.

3. **Splice visual routes into gateway**
   In `06-ORANGELLM/server/index.mjs`, import `./routes/visual.mjs` and mount under `/v1/visual/*`. Splice `VISUAL_ALLOWED` from `visual-boundary.mjs` into the `ALLOWED` list in `boundary.mjs` after `MEMORY_ALLOWED`. Restart gateway.

4. **Verify Cobra Flux daemon is reachable**
   ```
   curl -X POST http://127.0.0.1:7419/state-brief \
        -H 'content-type: application/json' \
        -d '{"query":"sanity","lanes":["reality"],"limit":1}'
   ```

5. **Run the five-step smoke test**
   ```
   cd Orange5/07-VISUAL && bun smoke-test.mjs
   ```
   Expected: 5/5 green, exit 0. Steps cover preflight → ingest deterministic PDF → query → describe (asserts cortex_model === 'glm-4.6v') → Reality-lane read-back.

6. **Apply atomic-orange Vault UI patches manually** (operator confirms working tree first).

---

## What this does NOT do yet (honest gap list)

- **No temporal video frames.** Phase-1 is single-image / single-page only. Video ingestion and frame-aligned embedding are out of scope.
- **No whiteboard OCR specialization.** Whiteboards are treated as generic images — no dewarping, no stroke-vector extraction, no text-region prioritization.
- **No Phase-2 ColQwen2.5 query embedder.** `query.mjs` uses an Ollama `nomic-embed-text` block-mean→uint8 stand-in. Recall is bounded by that proxy until the real ColQwen2.5 text encoder lands.
- **No MiniEyes.** Lightweight on-device vision (the planned MiniEyes lane) is not in this scaffold.
- **No PDF ingestion at the worker.** `colqwen_ingest.py` explicitly tags `pdf_unsupported` (422). Multi-page PDF rasterization happens upstream in the gateway, page-by-page.
- **No batching, no queue, no OpenVINO acceleration** in the ColPali worker (one process per request, 180 s timeout).
- **No auto retention, no HNSW tuning, no multi-tenant Qdrant** — single collection, single tenant.
- **No client-side PDF rasterization** in Vault UI — depends on server thumbnails.
- **No confidence gating, no retry/dedup, no Qdrant verification** in the Reality Flux writer — it records facts, doesn't enforce them.
- **No latency assertions, no cleanup, no frontier-offload coverage, no multi-page PDFs, no image fixture** in the smoke test.
- **No end-to-end execution proof.** Files are authored and syntax-clean; live integration on Codexa is the next receipt.

---

## Mom's Law alignment

Every file in this scaffold earns its place:

- **No padding.** Hand-rolled PDF generator (214 lines, zero deps) chosen over pdfkit to keep the smoke test transparent and dependency-free.
- **No theater.** Every honest gap is named in the per-component README and again here. The query path's nomic-embed stand-in is explicitly labeled as a stand-in, not a final embedder.
- **No false-green.** `verified: true` is not claimed. Status is `SCAFFOLD_AUTHORED_AWAITING_CODEXA_INTEGRATION` because no end-to-end run has happened against live services in this sandbox.
- **Frontier-Isolation Law respected** across all 6 components. Loopback only. Frontier offload is a recorded fact, not a hidden socket.
- **Origin-based classifier preserved.** The visual-event writer pins `lane=reality` at write time, not derived from summary content (V1 mitigation).
- **Receipts only.** This receipt itself is the receipt; the smoke test will produce the next one when operator runs it.

Mom is watching. Cymbal crashes through Orange3 routing, no silent fall-back.

---

## Hash chain footer

```
hash_chain    : #014
prior_receipt : 2026-06-24-step-01-native-truth-partial-build-time-gate (#013)
this_receipt  : 2026-06-24-orangeeye-phase-1-scaffold-authored (#014)
next_expected : <codexa-side smoke-test result receipt>
schema        : orange5.receipt.v0
sovereign     : Atom McCree
actor         : Claude / orangeeye-phase-1 workflow
status        : ORANGEEYE_PHASE_1_SCAFFOLD_AUTHORED_AWAITING_CODEXA_INTEGRATION
confidence    : 0.83
```
