# colpali-service — OrangeEye Phase-1 ingestion

ColQwen2 patch-embedding extractor. Bun HTTP front, persistent Python model
worker with one-shot availability fallback, loopback-only.

## What this does

- Listens on `127.0.0.1:7440`.
- `POST /ingest` multipart form, field `file` = image bytes (PNG / JPEG / WebP).
- Forks `python/colqwen_ingest.py`, which loads `vidore/colqwen2-v1.0` via
  HuggingFace `transformers` + Pillow, runs a single forward pass, clamps
  float32 outputs to `[-128, 127]`, rounds to int8, and returns
  `196 patches × 128 dims` per page.
- Bun returns:
  ```json
  {
    "doc_id": "<uuid>",
    "page_count": 1,
    "patches": [[[int8, ...128], ...196]],
    "image_sha256": "<hex>",
    "took_ms": 0
  }
  ```
- `GET /health` returns a small JSON status doc.

Caller (Reality writer / Æ Cobra Flux) is responsible for upserting the patches
into the Qdrant collection `orange5-vision` (multi-vector, `max_sim`, uint8,
dot distance) and emitting the `ae_visual` block.

## Run (dev, on Codexa)

```bash
# 1. Python env (per-host, one-time)
python3 -m venv .venv
. .venv/bin/activate
pip install --upgrade pip
pip install "transformers>=4.45" "torch>=2.3" "Pillow>=10" "accelerate>=0.30"

# 2. Pre-warm the model cache so first /ingest is not 30 s slow
HF_HOME=./.hf python -c "from transformers import AutoModel, AutoProcessor; \
  AutoProcessor.from_pretrained('vidore/colqwen2-v1.0', trust_remote_code=True); \
  AutoModel.from_pretrained('vidore/colqwen2-v1.0', trust_remote_code=True)"

# 3. Boot Bun server
COLPALI_PYTHON=$(pwd)/.venv/bin/python \
HF_HOME=$(pwd)/.hf \
bun run server.mjs

# 4. Smoke test
curl -sS -F "file=@/path/to/page.png" http://127.0.0.1:7440/ingest | head -c 400
```

## Deploy (systemd)

```bash
sudo useradd -r -s /usr/sbin/nologin colpali || true
sudo install -d -o colpali -g colpali /var/lib/colpali/hf /var/log/colpali
sudo install -m 0644 systemd/colpali.service /etc/systemd/system/colpali.service
sudo systemctl daemon-reload
sudo systemctl enable --now colpali
sudo systemctl status colpali
```

The unit pins `MemoryMax=10G`, blocks all non-loopback traffic via
`IPAddressDeny=any` + `IPAddressAllow=127.0.0.1/32 ::1/128`, and runs as the
unprivileged `colpali` user with `ProtectSystem=strict`.

## Environment variables

| var | default | meaning |
|---|---|---|
| `COLPALI_PORT` | `7440` | bind port (loopback only) |
| `COLPALI_PYTHON` | `python3` | python interpreter |
| `COLPALI_MAX_BYTES` | `52428800` | upload cap (50 MB) |
| `COLPALI_TIMEOUT_MS` | `180000` | python worker timeout |
| `COLPALI_MODEL_ID` | `vidore/colqwen2-v1.0` | HF model id |
| `COLPALI_EXPECTED_PATCHES` | `196` | sanity check, soft-warn only |
| `COLPALI_EXPECTED_DIM` | `128` | sanity check, hard error |
| `HF_HOME` | `/var/lib/colpali/hf` | HF cache dir |

## Error contract

The Python worker exits non-zero with a one-line tag on stderr; the Bun server
surfaces those as HTTP status codes:

| python tag | HTTP | meaning |
|---|---|---|
| `decode_fail` | 422 | Pillow could not open the bytes |
| `pdf_unsupported` | 422 | multi-page PDF sent (Phase-2) |
| `model_load_fail` | 500 | transformers / torch / Pillow missing or broken |
| `oom` | 503 | torch raised OOM |
| `inference_fail` | 500 | other forward-pass exception |
| `bad_output` | 500 | tensor shape mismatch |
| (timeout) | 504 | python ran longer than `COLPALI_TIMEOUT_MS` |

## Current proven backend

Codexa currently serves the real ColQwen2 model through **PyTorch XPU**. The
service is operational; it is not a facade. A separate conversion environment
proved that OpenVINO 2026.2.1 and Optimum-Intel 1.27 load correctly with a
compatible Transformers version, but stock `main_export` rejects ColQwen2's
custom architecture because no built-in export configuration exists.

Do not claim that `optimum-cli export openvino` or `main_export` can convert
this model without a custom export configuration. The next acceleration path
is either a model-specific custom exporter or direct PyTorch-to-OpenVINO
conversion, followed by output-parity and latency benchmarks against Torch XPU.

## Resident worker and queue

The default image path keeps one ColQwen2 process resident and serializes
binary-framed requests through it. The model loads once, not once per image.
If the resident process fails, the service records the failure and falls back
to the original one-shot worker for availability. Set
`COLPALI_RESIDENT_WORKER=0` to force the reference path.

The service also mounts the existing SQLite-backed routes at `/enqueue`,
`/queue`, and `/queue/:id`. Queue concurrency is intentionally one: XPU model
work is serialized to prevent memory stampedes. Queue state defaults to
`%USERPROFILE%\OrangeBox-Data\orange5\ae-eyes-queue.db` on Windows and can be
overridden with `COLPALI_QUEUE_DB`.

Measured Codexa proof on the same image and exact embedding hash:

- one-shot production reference: 10.35 s
- resident first request: 1.93 s
- resident warm request: 0.50 s
- warm speedup: 20.7x
- output parity: exact quantized patch hash match

## Remaining optimization backlog

- **No promoted OpenVINO path for ColQwen2.** The current live worker uses
  Torch XPU. Stock Optimum export does not support the custom architecture.
  OpenVINO promotion requires a custom exporter, output-parity proof, and a
  measured improvement over the current XPU backend. The older CPU-only
  statement below is retained only as historical Phase-2 context.
  The doctrine target is OpenVINO IR on Codexa CPU+NPU with ONNX runtime
  fallback; that conversion (export → `mo` → `compile_model("AUTO")`) is the
  Phase-2 milestone.
- **No PDF page splitting.** The Python worker explicitly refuses PDFs with
  `pdf_unsupported`. Phase-2 either adds `pypdfium2` page-by-page rasterization
  here, or pushes PDF handling upstream into a `pdf-splitter` service.
- **No Qdrant writes.** This service only emits patches; the caller is on the
  hook for upserting them into `orange5-vision`. That is deliberate so the
  ingestion service has no dependency on Qdrant being up.
- **No GLM-4.6V / frontier handoff here.** That logic lives in the edge cortex
  + OrangeLLM gateway, downstream of Qdrant retrieval. This service is the
  *embedding* layer only.
- **No auth.** Loopback-only is the security boundary. Do not expose this
  port off-host; the systemd unit enforces it but the Bun server itself is
  unauthenticated.

## File layout

```
colpali-service/
├── README.md                # this file
├── server.mjs               # Bun HTTP server
├── python/
│   └── colqwen_ingest.py    # one-shot inference worker
└── systemd/
    └── colpali.service      # systemd unit (loopback + 10 G cap)
```

## Cross-references

- `../AE_ORANGEEYE_FOUNDATION_SPEC.md` — full OrangeEye doctrine.
- `../PR-13-SPEC.md` — the PR-13 scope this service fulfills.
- Frontier-Isolation Law: external frontier models are only ever reached via
  the OrangeLLM gateway at `127.0.0.1:1337/v1`. This service never calls out.
- Codeless Law: this service exposes no editor / file-tree / repo surface; it
  is a pure embedding endpoint.
