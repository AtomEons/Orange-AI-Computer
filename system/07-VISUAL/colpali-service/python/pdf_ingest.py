#!/usr/bin/env python3
"""
OrangeEye Phase-2 — ColQwen2.5 PDF ingestion worker.

Companion to colqwen_ingest.py (Phase-1, image-only). This worker accepts a
PDF on stdin, rasterizes every page with pdf2image (Poppler backend), feeds
each page through ColQwen2.5 in a batched forward pass, and emits a single
JSON object preserving the shared contract:

    {
      "page_count": <int>,
      "patches": [
        [ [int8, int8, ... DIM dims], ... PATCHES patches ],   # page 1
        [ [int8, int8, ... DIM dims], ... PATCHES patches ],   # page 2
        ...
      ],
      "pages": [
        { "page": 1, "width": <px>, "height": <px>, "sha256": "<hex>" },
        ...
      ]
    }

Patch entries are int8-quantized (clamp [-128, 127], round) so the wire format
matches the Phase-1 image worker. The Bun parent (server.mjs) treats the
result as a single logical doc_id whose Qdrant points carry a per-point
`page=` field; this worker hands the parent everything needed to do that
upsert without re-parsing the PDF.

Phase-2 additions over Phase-1:

  * pdf2image rasterization (Poppler must be on PATH or supplied via the
    POPPLER_PATH env var). DPI is configurable; default 200 dpi balances
    text fidelity against memory for ColQwen2's image preprocessor.
  * Multi-page batching. Pages are processed in groups of COLPALI_BATCH
    (default 2) — small enough to keep CPU peak RSS bounded on a Codexa
    box, large enough to amortize processor + model overhead.
  * Optional OpenVINO inference path. When COLPALI_USE_OPENVINO=1 and an
    exported IR is present at COLPALI_OPENVINO_DIR, the model loads via
    optimum.intel.OVModelForFeatureExtraction and runs on AUTO (CPU/NPU).
    Falls back to transformers if anything is missing — the env flag is a
    hint, not a hard requirement.
  * Page-level SHA-256 of the rasterized PNG bytes is returned so downstream
    consumers can dedupe and reference exact frames.

Failure tags on stderr (one line, then exit nonzero — Bun parent forwards):

  decode_fail       — bytes are not a parseable PDF
  poppler_missing   — pdf2image could not locate the Poppler binaries
  pdf_empty         — PDF parsed but rendered to zero pages
  pdf_too_large     — page count exceeds COLPALI_MAX_PAGES
  model_load_fail   — transformers / OpenVINO load raised
  oom               — torch raised an OOM during a batch forward
  inference_fail    — any other exception during forward
  bad_output        — model returned a tensor with unexpected shape
  cancelled         — SIGTERM/SIGINT mid-run (parent timeout)

This script is one-shot per ingest. The temporal-video worker
(temporal_video_ingest.py, sibling Phase-2 deliverable) reuses
batch_embed_images() and quantize_int8() by importing this module.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import signal
import sys
import traceback
from typing import Any, Iterator

from hf_dns_fallback import install as install_hf_dns_fallback

install_hf_dns_fallback()

MODEL_ID = os.environ.get("COLPALI_MODEL_ID", "vidore/colqwen2-v1.0-hf")
EXPECTED_PATCHES = int(os.environ.get("COLPALI_EXPECTED_PATCHES", "196"))
EXPECTED_DIM = int(os.environ.get("COLPALI_EXPECTED_DIM", "128"))

PDF_DPI = int(os.environ.get("COLPALI_PDF_DPI", "200"))
PDF_BATCH = max(1, int(os.environ.get("COLPALI_BATCH", "2")))
MAX_PAGES = int(os.environ.get("COLPALI_MAX_PAGES", "256"))
POPPLER_PATH = os.environ.get("POPPLER_PATH") or None

USE_OPENVINO = os.environ.get("COLPALI_USE_OPENVINO", "0") == "1"
OPENVINO_DIR = os.environ.get("COLPALI_OPENVINO_DIR") or None
OPENVINO_DEVICE = os.environ.get("COLPALI_OPENVINO_DEVICE", "AUTO")
TORCH_DEVICE = os.environ.get("COLPALI_TORCH_DEVICE", "auto").lower()


def die(tag: str, msg: str, code: int = 1) -> None:
    """Emit a structured error to stderr and exit non-zero."""
    print(f"{tag}: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def _install_signal_handlers() -> None:
    def _bail(signum, _frame):  # noqa: ANN001
        die("cancelled", f"signal {signum}", code=130)

    for sig in (signal.SIGTERM, signal.SIGINT):
        try:
            signal.signal(sig, _bail)
        except (ValueError, OSError):
            # Not main thread or platform doesn't allow — ignore.
            pass


def read_stdin_bytes() -> bytes:
    data = sys.stdin.buffer.read()
    if not data:
        die("decode_fail", "no bytes on stdin")
    return data


def rasterize_pdf(raw: bytes) -> list:
    """Return a list of PIL.Image.Image (RGB) — one per page."""
    if raw[:5] != b"%PDF-":
        die("decode_fail", "magic bytes are not %PDF-")
    try:
        from pdf2image import convert_from_bytes  # type: ignore
        from pdf2image.exceptions import (  # type: ignore
            PDFInfoNotInstalledError,
            PDFPageCountError,
            PDFSyntaxError,
        )
    except ImportError as e:
        die("model_load_fail", f"pdf2image not installed: {e}")

    kwargs: dict[str, Any] = {"dpi": PDF_DPI, "fmt": "png"}
    if POPPLER_PATH:
        kwargs["poppler_path"] = POPPLER_PATH
    # Cap rasterization at MAX_PAGES + 1 so we can detect overflow honestly.
    kwargs["first_page"] = 1
    kwargs["last_page"] = MAX_PAGES + 1

    try:
        pages = convert_from_bytes(raw, **kwargs)
    except PDFInfoNotInstalledError as e:
        # Windows Codexa uses the self-contained PDFium wheel so Eyes does not
        # depend on a separately installed Poppler binary distribution.
        try:
            import pypdfium2 as pdfium  # type: ignore
            doc = pdfium.PdfDocument(raw)
            if len(doc) > MAX_PAGES:
                die("pdf_too_large", f"pdf has > {MAX_PAGES} pages (got {len(doc)})")
            scale = PDF_DPI / 72.0
            pages = [page.render(scale=scale).to_pil() for page in doc]
        except SystemExit:
            raise
        except Exception as fallback_error:
            die(
                "poppler_missing",
                f"Poppler unavailable ({e}); PDFium fallback failed: {fallback_error}",
            )
    except (PDFPageCountError, PDFSyntaxError) as e:
        die("decode_fail", f"pdf parse failed: {type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001
        die("decode_fail", f"pdf2image raised: {type(e).__name__}: {e}")

    if not pages:
        die("pdf_empty", "pdf rendered to zero pages")
    if len(pages) > MAX_PAGES:
        die("pdf_too_large",
            f"pdf has > {MAX_PAGES} pages (got {len(pages)})")

    # Force RGB for processor consistency.
    out = []
    for i, img in enumerate(pages):
        try:
            if img.mode != "RGB":
                img = img.convert("RGB")
            img.load()
        except Exception as e:  # noqa: BLE001
            die("decode_fail", f"page {i+1} convert failed: {e}")
        out.append(img)
    return out


def _page_sha256(img) -> tuple[str, int, int]:
    """SHA-256 of the page's PNG bytes + (w, h). Stable per render."""
    buf = io.BytesIO()
    img.save(buf, format="PNG", optimize=False, compress_level=1)
    raw = buf.getvalue()
    return hashlib.sha256(raw).hexdigest(), img.width, img.height


# --------------------------------------------------------------------------- #
# Model loading                                                               #
# --------------------------------------------------------------------------- #


def _load_openvino():
    """Return (processor, model, torch_module, backend_tag) or None on miss."""
    if not USE_OPENVINO:
        return None
    if not OPENVINO_DIR or not os.path.isdir(OPENVINO_DIR):
        print(
            f"warn: COLPALI_USE_OPENVINO=1 but COLPALI_OPENVINO_DIR "
            f"missing or not a dir ({OPENVINO_DIR!r}); falling back to "
            f"transformers",
            file=sys.stderr,
            flush=True,
        )
        return None
    try:
        import torch  # type: ignore
        from transformers import AutoProcessor  # type: ignore
        from optimum.intel import OVModelForFeatureExtraction  # type: ignore
    except ImportError as e:
        print(
            f"warn: optimum.intel not available ({e}); falling back to "
            f"transformers",
            file=sys.stderr,
            flush=True,
        )
        return None

    try:
        processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
        model = OVModelForFeatureExtraction.from_pretrained(
            OPENVINO_DIR,
            device=OPENVINO_DEVICE,
            trust_remote_code=True,
        )
    except Exception as e:  # noqa: BLE001
        die("model_load_fail", f"openvino load: {type(e).__name__}: {e}")

    return processor, model, torch, f"openvino:{OPENVINO_DEVICE}"


def _load_transformers():
    try:
        import torch  # type: ignore
        from transformers import ColQwen2ForRetrieval, ColQwen2Processor  # type: ignore
    except ImportError as e:
        die("model_load_fail", f"transformers/torch missing: {e}")

    try:
        use_xpu = TORCH_DEVICE in ("auto", "xpu") and bool(
            getattr(torch, "xpu", None) and torch.xpu.is_available()
        )
        processor = ColQwen2Processor.from_pretrained(MODEL_ID)
        model = ColQwen2ForRetrieval.from_pretrained(
            MODEL_ID,
            torch_dtype=torch.bfloat16 if use_xpu else torch.float32,
            low_cpu_mem_usage=True,
        )
        if use_xpu:
            model = model.to("xpu")
        model.eval()
    except Exception as e:  # noqa: BLE001
        die("model_load_fail", f"{type(e).__name__}: {e}")

    return processor, model, torch, "transformers:xpu" if use_xpu else "transformers:cpu"


def load_model():
    ov = _load_openvino()
    if ov is not None:
        return ov
    return _load_transformers()


# --------------------------------------------------------------------------- #
# Inference                                                                   #
# --------------------------------------------------------------------------- #


def _batched(seq: list, n: int) -> Iterator[list]:
    for i in range(0, len(seq), n):
        yield seq[i : i + n]


def _normalize_output(out) -> Any:
    """Unwrap model output to a 3-D tensor [B, num_patches, dim]."""
    tensor = None
    if hasattr(out, "embeddings"):
        tensor = out.embeddings
    elif hasattr(out, "last_hidden_state"):
        tensor = out.last_hidden_state
    elif isinstance(out, (list, tuple)) and len(out) > 0:
        tensor = out[0]
    else:
        tensor = out
    return tensor


def batch_embed_images(processor, model, torch, images: list) -> Any:
    """Run a single forward pass over a batch of PIL images.

    Returns a float32 tensor of shape [B, num_patches, dim] on CPU.
    """
    try:
        if hasattr(processor, "process_images"):
            batch = processor.process_images(images)
        else:
            batch = processor(images=images, return_tensors="pt")
        # Move tensors to model device. OV models may not expose .parameters();
        # in that case we leave inputs on CPU (OV handles transfer).
        device = None
        try:
            device = next(model.parameters()).device
        except (StopIteration, AttributeError):
            device = None
        if device is not None:
            batch = {
                k: v.to(device) if hasattr(v, "to") else v
                for k, v in batch.items()
            }

        with torch.no_grad():
            out = model(**batch)
    except RuntimeError as e:
        msg = str(e).lower()
        if "out of memory" in msg or "cuda oom" in msg:
            die("oom", str(e))
        die("inference_fail", f"RuntimeError: {e}")
    except Exception as e:  # noqa: BLE001
        die("inference_fail", f"{type(e).__name__}: {e}")

    tensor = _normalize_output(out)
    try:
        if tensor.dim() == 2:
            # Single-page slipped through as [P, D]; promote.
            tensor = tensor.unsqueeze(0)
        if tensor.dim() != 3:
            die("bad_output",
                f"unexpected tensor rank {tensor.dim()}; "
                f"shape={tuple(tensor.shape)}")
    except AttributeError:
        die("bad_output", f"model output not a tensor: {type(tensor).__name__}")

    return tensor.detach().to(torch.float32).cpu()


def quantize_int8(tensor) -> list[list[list[int]]]:
    """Symmetrically map normalized embeddings [-1, 1] to signed int8.

    Input shape [B, P, D]; output shape [B][P][D].
    """
    try:
        import torch  # type: ignore
        t = tensor.detach().to(torch.float32).cpu()
        t = torch.clamp(t, min=-1.0, max=1.0)
        t = torch.round(t * 127.0).to(torch.int8)
        return t.tolist()
    except Exception as e:  # noqa: BLE001
        die("bad_output", f"quantize failed: {e}")
        return []  # unreachable


# --------------------------------------------------------------------------- #
# Main                                                                        #
# --------------------------------------------------------------------------- #


def _validate_patch_shape(patches_per_page: list[list[list[int]]]) -> None:
    """Warn on patch-count drift; hard-fail on dim drift."""
    for idx, page in enumerate(patches_per_page):
        n = len(page)
        d = len(page[0]) if n else 0
        if n != EXPECTED_PATCHES:
            print(
                f"warn: page {idx+1} got {n} patches "
                f"(expected {EXPECTED_PATCHES})",
                file=sys.stderr,
                flush=True,
            )
        if d != EXPECTED_DIM:
            die("bad_output",
                f"page {idx+1} patch dim {d} != expected {EXPECTED_DIM}")


def main() -> None:
    _install_signal_handlers()
    raw = read_stdin_bytes()
    pages = rasterize_pdf(raw)

    # Per-page metadata before we hand images to the processor; the processor
    # may resize/in-place mutate.
    page_meta = []
    for i, img in enumerate(pages):
        sha, w, h = _page_sha256(img)
        page_meta.append({
            "page": i + 1,
            "width": w,
            "height": h,
            "sha256": sha,
        })

    processor, model, torch, backend = load_model()
    print(f"info: backend={backend} pages={len(pages)} batch={PDF_BATCH}",
          file=sys.stderr, flush=True)

    all_patches: list[list[list[int]]] = []
    for chunk in _batched(pages, PDF_BATCH):
        tensor = batch_embed_images(processor, model, torch, chunk)
        all_patches.extend(quantize_int8(tensor))

    if len(all_patches) != len(pages):
        die("bad_output",
            f"emitted {len(all_patches)} page embeddings for "
            f"{len(pages)} rasterized pages")

    _validate_patch_shape(all_patches)

    json.dump(
        {
            "page_count": len(pages),
            "patches": all_patches,
            "pages": page_meta,
        },
        sys.stdout,
        separators=(",", ":"),
    )
    sys.stdout.flush()


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        die("inference_fail", f"unhandled: {e}")
