# OrangeEye Phase-2 — Authored

- **Date**: 2026-06-25
- **Phase**: OrangeEye Phase-2 (PDF ingest, persistent queue, OpenVINO loader, video frames, gateway routes, smoke)
- **Status**: Authored — syntax-clean, end-to-end execution NOT yet performed
- **Operator**: Atom McCree (Sovereign)
- **Doctrine**: Mom's Law + AtomEons Build & Receipts law (`.claude/rules/03-build-and-receipts.md`)

## Hash chain

- **prior_receipt**: `2026-06-24-orangeeye-phase-1-scaffold-authored.md`
- **prior_receipt_sha256**: `2f562d60ea70bc1a19b185a605fa7bb469f8a8459fd0b06bde8c54207581be3f`
- **this_receipt**: `2026-06-25-orangeeye-phase-2.md`

## Components

### 1. PDF ingest worker (`pdf_ingest.py`)

- **Path**: `C:/AtomEons/Orange5/07-VISUAL/colpali-service/python/pdf_ingest.py`
- **Lines**: 405
- **SHA-256**: `5f864357005669efde657cdf8abf19c768b461b75c1e1deb907fad53b390db17`
- **Contract**: stdin → stdout JSON, int8-quantized patches, one process per ingest (preserves Phase-1 colqwen_ingest.py contract).
- **Key behavior**:
  - pdf2image (Poppler) rasterizes every page at `COLPALI_PDF_DPI` (default 200); rejects non-PDF / empty / over `COLPALI_MAX_PAGES` (default 256).
  - Multi-page emission: single `page_count` + `patches[num_pages][num_patches][dim]`; parent assigns one `doc_id`, writes per-point `page=` field to Qdrant.
  - Batched forward pass `_batched(pages, COLPALI_BATCH)` (default 2) bounds Codexa CPU RSS.
  - OpenVINO path: `COLPALI_USE_OPENVINO=1` + `COLPALI_OPENVINO_DIR` loads `optimum.intel.OVModelForFeatureExtraction` on `COLPALI_OPENVINO_DEVICE` (default AUTO, covers CPU+NPU). Soft-falls back to transformers with stderr warn.
  - Per-page SHA-256 of rendered PNG + width/height in top-level `pages[]`.
  - Failure tags: `decode_fail`, `poppler_missing`, `pdf_empty`, `pdf_too_large`, `model_load_fail`, `oom`, `inference_fail`, `bad_output`, `cancelled`.
  - SIGTERM/SIGINT handler; public helpers `batch_embed_images()` + `quantize_int8()` importable by sibling `temporal_video_ingest.py`.
- **Verification**: AST parse clean. No end-to-end run (no pdf2image/transformers in shell).

### 2. Persistent SQLite queue (`queue.mjs`)

- **Path**: `C:/AtomEons/Orange5/07-VISUAL/colpali-service/queue.mjs`
- **Lines**: 385
- **SHA-256**: `18b75805f1bde16272c38bf569a8fac67f5f63136c933402bed7dadf5392df04`
- **Behavior**:
  - `bun:sqlite` (zero-dep, matches existing Bun runtime). DB at `07-VISUAL/queue.db`.
  - Schema: id, path, status (queued|running|done|error|cancelled), enqueued_at/started_at/finished_at, error_msg, result_json, attempts.
  - WAL + NORMAL sync (crash-safe without fsync stalls).
  - On open, stale `running` rows from prior crash reset to `queued`; idempotency relies on Qdrant image_sha256 dedup downstream.
  - Single-pop drain loop with `sClaim` guard (1-at-a-time per spec).
  - Path-agnostic runner callback — Phase-2 dispatch (image vs PDF vs video) lives in server.mjs.
  - Public surface: `enqueue`, `enqueueBatch` (transactional), `get`, `list`, `counts`, `cancel`, `purgeFinished`, `start`, `stop`, `close`.
  - `bun run queue.mjs` runs inspect-only mode.
- **Verification**: Bun transpile-check clean.

### 3. HTTP route layer (`queue-routes.mjs`)

- **Path**: `C:/AtomEons/Orange5/07-VISUAL/colpali-service/queue-routes.mjs`
- **Lines**: 362
- **SHA-256**: `146fc060aa6e2ff90bc65721e3d421d6de3836cc0713df4fa5d8e8595b70dc4a`
- **Endpoints**:
  - `POST /enqueue` — single or batch; rejects non-absolute paths + unknown extensions (400/415); returns 202 with sniffed kind, exists, size.
  - `GET /queue` — status/limit/offset; counts + in_flight_id + decorated rows.
  - `GET /queue/:id` — 404 missing, 400 non-integer, parsed `result`.
  - `DELETE /queue/:id` — queued-only; 409 on running/done/error/cancelled (race-safe).
- **Kind sniffer**: image (png/jpg/jpeg/webp/bmp/tif/tiff/gif), pdf, video (mp4/mov/mkv/webm/avi/m4v) — gates garbage before Python spawn.
- `_internals` export for tests + runner.
- **Verification**: syntax-clean.

### 4. OpenVINO converter + server loader (`openvino_convert.py`, `server.mjs`)

- **Path A**: `C:/AtomEons/Orange5/07-VISUAL/colpali-service/python/openvino_convert.py`
- **Lines**: 615
- **SHA-256**: `4ddd79fc64963c02291ce88b4f32cdcd1a696669805a30ab203752d7f2b9d3d2`
- **Path B**: `C:/AtomEons/Orange5/07-VISUAL/colpali-service/server.mjs`
- **Lines**: 400
- **SHA-256**: `3bd3f55be8f7976172fc50a46567bd7255551f2bdc7f74a0da641cd338587e47`
- **Converter behavior**:
  - One-shot offline tool. Exports `vidore/colqwen2-v1.0` → OpenVINO IR via `optimum.exporters.openvino.main_export` at `/opt/atomeons/colqwen2-openvino/`.
  - Version floors: `optimum-intel >= 1.21.0`, `openvino >= 2024.4.0` (NPU floor for Meteor/Arrow/Lunar Lake).
  - Atomic swap via `<dest>.partial-XXXX` + `os.replace`. Lockfile `<dest>/.convert.lock` (exit 5 on concurrent run).
  - Smoke test on `device=AUTO` (override `COLPALI_OPENVINO_DEVICE`); failed smoke discards IR (no half-broken cache).
  - `conversion_receipt.json` (schema `atomeons.colpali.openvino_receipt.v1`): model id, dtype, versions, IR bin SHA-256 + bytes, available_devices, FULL_DEVICE_NAME, smoke timings.
  - Exit codes: 0/1/2/3/4/5 (OK/user/dep/export/verify/concurrent).
- **server.mjs patch behavior**:
  - `resolveBackend()` boot probe: verifies `openvino_model.xml` + `.bin` + `conversion_receipt.json`. Returns `{kind:'openvino',...}` or `{kind:'transformers',reason}`. `COLPALI_FORCE_TRANSFORMERS=1` overrides.
  - `pythonEnv()` overlays `COLPALI_USE_OPENVINO`, `_DIR`, `_DEVICE` (or forces `=0` for clean fallback).
  - `runPython(script, bytes)` takes script path — services both `colqwen_ingest.py` and `pdf_ingest.py`.
  - `/ingest` sniffs first 5 bytes for `%PDF-` and dispatches.
  - Error map: `decode_fail`/`pdf_too_large`/`pdf_empty` → 422, `poppler_missing` → 500, timeout → 504, oom → 503.
  - `/health` exposes backend tag + IR sha prefix.
- **Verification**: `bun build server.mjs --target=bun` → 1 module, no diagnostics. `ast.parse(openvino_convert.py)` → OK.

### 5. Temporal video frame extractor (`frame-extractor.mjs`)

- **Path**: `C:/AtomEons/Orange5/07-VISUAL/video/frame-extractor.mjs`
- **Lines**: 673
- **SHA-256**: `ad386a5fb21afe34c6d1efd3119b9fff3835222f0678aeee0adc2384107347d4`
- **Behavior**:
  - `ffmpeg -vf fps=1/N -vsync vfr` (default N=5s) → JPEG per interval.
  - Per-frame sidecar `<frame>.meta.json` with `lane='video-frame'`, `doc_id`, `frame_index`, `timestamp_seconds`, `interval_seconds`.
  - Deterministic `doc_id` = sha256(first 1MB + size + mtime).
  - Idempotent: re-run returns existing frames + backfills missing sidecars; `force:true` overrides.
  - Hard limits: absolute path, interval > 0 (≥ 0.1s), 10k frame cap, 30-min SIGKILL timeout, 64KB stderr tail.
  - Optional `enqueue(absPath, sidecar)` callback or CLI `--enqueue <url>` (POST `/enqueue` kind=image).
  - Per-frame enqueue errors → `result.enqueue_errors` (null ids, retry-friendly).
- **Verification**: `node --check` clean; CLI help renders.

### 6. Phase-2 gateway routes + smoke (`visual.mjs`, `visual-boundary.mjs`, `smoke-test-phase2.mjs`)

- **Path A**: `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/visual.mjs`
- **Lines**: 1340
- **SHA-256**: `76123bb7a973b5c18960f027f8e5e2e505e74c926adcdef6e448d3eb04b19b29`
- **Path B**: `C:/AtomEons/Orange5/06-ORANGELLM/server/routes/visual-boundary.mjs`
- **Lines**: 97
- **SHA-256**: `6dda5ef97a3520a6232b4cc7c70a773a5cf0092262b7f1330fea22001abd805c`
- **Path C**: `C:/AtomEons/Orange5/07-VISUAL/smoke-test-phase2.mjs`
- **Lines**: 502
- **SHA-256**: `e24b806975dbd58b8c70df77f55b165f9c6d363f1df26050e000592931a5b4c5`
- **Gateway routes** (visual.mjs):
  - `POST /v1/visual/ingest/batch` — paths[] proxy to colpali `/enqueue`; 202; caps 1000.
  - `GET /v1/visual/queue` — proxies counts + in_flight_id + rows.
  - `GET /v1/visual/queue/:id` — proxies single row.
  - `DELETE /v1/visual/queue/:id` — proxies cancel.
  - `POST /v1/visual/video/ingest` — spawns ffmpeg into `os.tmpdir()/orangeeye-frames-*`, batch-enqueues frames. Bounds: interval [0.1, 3600], max_frames ≤ 1000, 300s ffmpeg timeout.
  - `proxyJson()` helper: honest 503 (unreachable) / 502 (bad JSON).
  - `VISUAL_PREFIX_ROUTES` + `matchPrefixRoute()` for `/queue/:id` (single-segment guard, no traversal).
- **Boundary** (visual-boundary.mjs):
  - `VISUAL_ALLOWED`: 6 fixed routes (ingest, ingest/batch, query, describe, queue, video/ingest).
  - `VISUAL_PREFIX_ALLOWED`: GET/DELETE `/v1/visual/queue/:id`.
  - `VISUAL_BODY_CAPS`: batch/video JSON ≤ 1 MB.
  - Loopback only (Frontier-Isolation Law preserved).
- **Smoke** (smoke-test-phase2.mjs, runs under bun):
  - Step 1 preflight (gateway + colpali :7440).
  - Step 2 OpenVINO probe (warn-only).
  - Step 3 batch-pdf (3 distinct PDFs via existing test-pdf-generator.mjs).
  - Step 4 queue-drain (180s budget, requires ≥1 done).
  - Step 5 video-ingest (4s testsrc MP4 via ffmpeg lavfi, interval_sec=1; frames ≥ 2). Warn-degrades if ffmpeg absent.
  - Exit codes: 0 / 1 / 2 / 3.
- **Verification**: all three files pass `node --check`.

## Result

7 net-new files + 1 patched file, 4,779 total LOC, all syntax-clean, none end-to-end-verified in this session.

## Evidence

- Files exist at requested absolute paths (verified via `ls` + `wc -l`).
- Line counts match handoff exactly (405 / 385 / 362 / 615 / 400 / 673 / 1340 / 97 / 502).
- SHA-256 captured per-file above.
- AST/parse checks: `pdf_ingest.py` and `openvino_convert.py` → `ast.parse OK`; `queue.mjs`, `queue-routes.mjs`, `server.mjs`, `frame-extractor.mjs`, `visual.mjs`, `visual-boundary.mjs`, `smoke-test-phase2.mjs` → `node --check` / `bun build` clean.

## Honest gaps (Mom's Law — name them)

1. **No end-to-end execution on this Windows shell.** No `python3` alias, no `optimum-intel`, no `openvino`, no `pdf2image`, no `transformers`, no live Bun colpali-service running. All verification is static (parse + bundle).
2. **OpenVINO IR not yet produced.** `/opt/atomeons/colqwen2-openvino/` does not exist; `conversion_receipt.json` not yet written. The loader switch is wired, but on first boot it will fall through to transformers + log the reason. Requires a one-time Codexa-side run of `openvino_convert.py`.
3. **queue.mjs ↔ server.mjs HTTP wiring incomplete.** queue.mjs is on disk; queue-routes.mjs is on disk; neither has been mounted into server.mjs's request handler in this delivery. Phase-2 endpoints (`POST /enqueue`, `GET /queue`, etc.) will 404 until that mount lands.
4. **Queue runner does not consume the video-frame sidecar.** `frame-extractor.mjs` writes `<frame>.meta.json` with `lane`, `doc_id`, `frame_index`, `timestamp_seconds`. The queue runner that drains rows into `runPython()` does not yet read the sidecar to stamp Qdrant payload — gateway echoes lane/source_hint in the 202 response, but the runner-to-Qdrant plumbing is unbuilt.
5. **`/health` shape may not match smoke expectations.** Smoke step-2 expects `{backend:{kind,device,reason}}`; server.mjs writes the equivalent fields but the exact JSON shape was not cross-validated against the smoke parser. Step-2 already warn-degrades by design.
6. **`temporal_video_ingest.py` referenced but not delivered.** `pdf_ingest.py` docstring advertises shared helpers (`batch_embed_images`, `quantize_int8`) for a sibling temporal worker. The Python sibling is not part of this drop — video frames currently flow through the image worker (`colqwen_ingest.py`) one at a time after extraction.
7. **No test corpus, no Qdrant write evidence.** Receipt covers authorship only. Field-phase gauntlet (Qdrant upserts visible, dedup confirmed, page=/frame_index= verified on a real point) is owed.
8. **Frame temp dirs not cleaned.** `orangeeye-frames-*` under `os.tmpdir()` belong to the queue runner; an operator cron is named in the notes but not authored.
9. **Bun build verification was on server.mjs only.** queue-routes.mjs, queue.mjs, frame-extractor.mjs verified via `node --check` (syntax) not via the actual bundler that will load them.
10. **No SBOM / dep manifest update.** pdf2image, Poppler, optimum[openvino]>=1.21, openvino>=2024.4 are new runtime requirements. Not yet recorded in `06-ORANGELLM/` or `07-VISUAL/` lockfiles.

## Blockers

- Codexa-side dependency install (`pip install pdf2image optimum[openvino]>=1.21 openvino>=2024.4 transformers`) + Poppler binary on PATH.
- One-time `python openvino_convert.py` run to materialize `/opt/atomeons/colqwen2-openvino/`.
- server.mjs needs the `mountQueueRoutes()` call to actually expose the queue HTTP surface.
- Queue runner module (the function passed to `openQueue({runner})`) needs the sidecar-reading + Qdrant lane-stamping logic.

## Next action

1. On Codexa: install dep set, run `py python/openvino_convert.py --skip-smoke` for first pass, then full run with smoke. Confirm `conversion_receipt.json` SHA-256 matches loaded IR bin.
2. Mount `queue-routes.mjs` into `server.mjs` `fetch()` (call `mountQueueRoutes({queue, log}).handle(req, url)` before existing `/ingest` `/health` branches).
3. Author the queue runner that reads `<frame>.meta.json` sidecar and passes `lane`/`doc_id`/`frame_index`/`page`/`source_hint` into Qdrant payload.
4. Drop a 5-minute cron / systemd timer to sweep stale `orangeeye-frames-*` under `os.tmpdir()`.
5. Run `smoke-test-phase2.mjs` under bun; capture the receipt as `2026-06-25-orangeeye-phase-2-verified.md` (next link in this hash chain).
6. Build `temporal_video_ingest.py` sibling worker so video frames flow through one batched forward pass per video instead of N single-image calls.

## Receipts law compliance

- result: stated
- evidence: SHA-256 + line counts + parse/bundle status captured
- blockers: stated explicitly
- next action: enumerated
- unresolved risk: 10 honest gaps named

Mom is watching.
