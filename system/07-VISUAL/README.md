# 07-VISUAL — OrangeEye

Visual capability under OrangeLLM. Read-only sight. Translates pixels into structured text.

| Slot | Tool |
|---|---|
| Primary | GLM-4.6V (z.ai) |
| Secondary | Playwright MCP · Chrome DevTools MCP |
| Tertiary | Screenshot + UX inspection |
| Addendum | MiniEyes (2–8B local VLM) — only if primary insufficient |

## Enable

```bash
$env:ORANGE5_VISUAL_ENABLED = "1"
```

Wiring proceeds once GLM-4.6V is reachable through the Codexa heavy rail and the relevant MCP bridges are active.

Doctrine: `07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md`.

---

# OrangeEye Phase-1 — smoke test

End-to-end validation that the visual lane is wired correctly on Codexa.
Five steps; either 5/5 green or the lane is not shippable. No theatre.

## Run

```bash
cd C:/AtomEons/Orange5/07-VISUAL
bun smoke-test.mjs
```

Expected output (abridged):

```
OrangeEye Phase-1 smoke test
  gateway=http://127.0.0.1:1337
  qdrant=http://127.0.0.1:6333  colpali=http://127.0.0.1:7440
  ollama=http://127.0.0.1:11434  cobra=http://127.0.0.1:7419

[PASS] step-1 preflight: ok Qdrant :6333 · ok ColPali :7440 · ok Ollama :11434 + glm-4.6v · ok AE Cobra :7419
[PASS] step-2 ingest: pages_ingested=1 doc_id=doc-... (842ms)
[PASS] step-3 query: results=1 top.score=0.7421 doc_id=doc-... (310ms)
[PASS] step-4 describe: answer 184ch cortex=glm-4.6v frontier=false (4118ms)
[PASS] step-5 mirage: reality=1 first.kind=observation (47ms)

result: 5/5 green · 5512ms total
OrangeEye Phase-1 lane is OPEN.
```

Exit codes:

| code | meaning |
|------|---------|
| 0    | 5/5 green — lane shippable |
| 1    | a step assertion failed (see red line) |
| 2    | pre-flight fatal: a dependency is unreachable |
| 3    | smoke harness bug (PDF fixture build failed, etc.) |

## What this validates

1. **Pre-flight** — every loopback dependency answers:
   - Qdrant on `:6333`
   - ColPali ingest service on `:7440`
   - Ollama on `:11434` **with the `glm-4.6v` model already pulled**
   - Æ Cobra daemon on `:7419`
2. **Ingest** — `POST /v1/visual/ingest` on the OrangeLLM gateway (`:1337`)
   accepts a generated 1-page PDF, drives the ColPali → Qdrant chain, and
   returns `pages_ingested >= 1`.
3. **Query** — `POST /v1/visual/query` returns at least one MaxSim hit with
   a positive score for a query derived from the fixture text.
4. **Describe** — `POST /v1/visual/describe` with the current ingest hit's
   `doc_id`+`page` returns a structured answer whose summary is longer than 20
   characters from the configured `ORANGE5_CORTEX_MODEL`.
5. **Mirage recall** — `POST :7419/state-brief` finds the visual event in the
   Reality lane (`kind === "observation"`). Closes the vision ↔ memory loop.

## Files

| file | role |
|------|------|
| `smoke-test.mjs`         | the five-step runner |
| `test-pdf-generator.mjs` | builds a deterministic 1-page PDF; usable standalone (`bun test-pdf-generator.mjs out.pdf`) |
| `README.md`              | this file (lane summary + smoke-test docs) |

The PDF fixture is hand-rolled — no `pdfkit`, no node_modules tree. The smoke
suite is fully offline-runnable; nothing outbound, no DNS.

## Configuration (env)

| var | default | purpose |
|-----|---------|---------|
| `ORANGELLM_GATEWAY`        | `http://127.0.0.1:1337` | OrangeLLM gateway base |
| `QDRANT_BASE`              | `http://127.0.0.1:6333` | Qdrant base |
| `COLPALI_BASE`             | `http://127.0.0.1:7440` | ColPali ingest service |
| `OLLAMA_BASE`              | `http://127.0.0.1:11434` | Ollama base |
| `AE_COBRA_BASE`            | `http://127.0.0.1:7419` | Æ Cobra daemon |
| `SMOKE_FETCH_TIMEOUT_MS`   | `30000` | per-request timeout |
| `NO_COLOR`                 | unset   | set to disable ANSI colour |

## Failure modes (in the order they normally bite)

### step-1 preflight

- **`down Qdrant :6333`** — the docker container `aeorangebox-ai-box-qdrant-1`
  is not up. Bring it back with `docker start aeorangebox-ai-box-qdrant-1`
  on Codexa.
- **`down ColPali :7440`** — start the service from
  `07-VISUAL/colpali-service/server.mjs` (`bun colpali-service/server.mjs`).
  Confirm the python venv exists at
  `colpali-service/python/.venv` and that `vidore/colqwen2-v1.0` has been
  downloaded.
- **`down Ollama :11434 + glm-4.6v`** — Ollama may be running but missing
  the model. The probe lists what *is* present. Pull with
  `ollama pull glm-4.6v` (or whichever GLM-4.6V variant your Ollama tag
  points at). The test currently requires the model name to start with
  `glm-4.6v`.
- **`down AE Cobra :7419`** — start Æ Cobra from
  `06-ORANGELLM/memory/ae-cobra/`. Without Cobra, step 5 cannot run, and the
  Reality lane has nowhere to record the visual event.

### step-2 ingest

- **`HTTP 413`** — the PDF exceeded the gateway's upload cap (default 50 MB,
  but the fixture is well under 4 KB so this should never trigger on the
  smoke fixture). If you see it, something is wrong with the multipart
  framing, not the file size.
- **`HTTP 502 COLPALI_FAILED`** — ColPali was reachable on the probe but
  failed mid-encode. Check `colpali-service/server.mjs` logs for the python
  traceback. Most common cause: out-of-RAM under load on Codexa, or the
  model weights weren't fully downloaded.
- **`pages_ingested=0`** — ColPali returned no patches. Inspect the gateway
  log; this usually means the PDF rasterisation pipeline silently fell back
  to a zero-byte image.

### step-3 query

- **`HTTP 503 QUERY_FAILED · Ollama unreachable`** — the query embedder
  failed even though `/api/tags` answered. Confirm the embedding model the
  gateway is wired to (likely a small text encoder) is also pulled in
  Ollama.
- **`results.length=0`** — the query embedder returned a vector but Qdrant
  has no neighbours. Either step 2 silently failed to upsert (rare; gateway
  returns 502 in that case) or the collection name in the gateway does not
  match `orange5-vision`.
- **`results[0].score=0`** — every patch is orthogonal to the query token
  embedding. Almost always means the query embedder is producing a constant
  zero vector (misconfigured model path).

### step-4 describe

- **`HTTP 503`** — Ollama dropped between step 1 and step 4. Re-run.
- **`answer.length=0` or short** — GLM-4.6V refused the prompt or hit a
  context-window error. Lower `max_tokens` in the test, or check the model
  tag in Ollama (Q4 vs Q5 quants behave differently).
- **`cortex_model='qwen3-vl' (want 'glm-4.6v')`** — somebody swapped the
  edge cortex. That's the Phase-2 move; this smoke test is Phase-1 only
  and will not pass under Phase-2 without updating the assertion.

### step-5 mirage

- **`reality.length=0`** — the visual event was NOT written to the Reality
  lane. Most likely cause: the visual-event writer at
  `07-VISUAL/visual-event/writer.mjs` is mocked or the Flux writer at
  `06-ORANGELLM/memory/ae-cobra/flux/writer.mjs` is pointing at a different
  flux root than the daemon. Confirm `AE_FLUX_ROOT` is consistent across
  both processes.
- **`reality[0].kind='thought'`** — origin-based classifier got bypassed.
  The writer's origin should be hard-coded to `'orangeeye'`, which forces
  lane=reality and kind=observation. If it's coming back as thought, that
  invariant is broken — block release until fixed.

## What this does NOT do (yet)

- **No latency assertions.** Per-step times are logged but never fail the
  suite. Phase-2 should add a soft budget (e.g. describe < 12 s).
- **No cleanup.** The fixture text is deterministic so repeat runs are
  idempotent at the doc level (same SHA → same `doc_id`), but the Reality
  lane will accumulate one Flux record per run. Acceptable for smoke; not
  acceptable for a load test.
- **No frontier-offload coverage.** Step 4 explicitly asserts local cortex
  (`cortex_model === 'glm-4.6v'`). Frontier-offload validation needs its
  own suite — see Master Plan §6 for the offload trigger conditions.
- **No multi-page PDFs.** ColPali's single-page Python script is the
  Phase-1 contract.
- **No image/screenshot fixture.** The spec mentions UI-grounding
  (`/v1/visual/ground-ui`); that's a separate test target.
- **No 16-fixture boundary check.** That lives in
  `06-ORANGELLM/tests/boundary/` and runs in a separate harness.

## Relation to the spec

Doctrine: `07-VISUAL/AE_ORANGEEYE_FOUNDATION_SPEC.md` §1 (five layers),
§4 (Phase-1 build map), §7 (visual ↔ Æ Cobra loop).

This smoke covers the **Phase-1 pass criteria 1, 3, 4, 7** from §6 in a
single ~10-second run. The remaining criteria (8 vault UI render, 9 no new
npm dep, 10 RAM steady, 11 boundary fixtures green, 12 receipt) require
their own dedicated checks.
