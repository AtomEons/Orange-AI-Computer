#!/usr/bin/env python3
"""
OrangeEye Phase-1 — ColQwen2.5 ingestion worker.

One-shot process. Reads image bytes from stdin, emits a single JSON object to
stdout:

    {
      "page_count": 1,
      "patches": [
        [ [int8, int8, ... 128 dims], ... 196 patches ]
      ]
    }

Patches are quantized to int8 by clamping float32 outputs to [-128, 127] and
rounding. The model is vidore/colqwen2-v1.0 (ColQwen2 / ColPali family) loaded
via HuggingFace transformers AutoProcessor + AutoModel. Pillow handles decode.

This script intentionally exits after one document. The Bun server spawns a
fresh interpreter per /ingest call. Phase-2 will replace this with a resident
OpenVINO process and a queue; see README.

Failure modes (each exits non-zero with a one-line tag on stderr that the Bun
parent surfaces to the HTTP caller):

  decode_fail     — Pillow could not parse the bytes
  pdf_unsupported — caller sent multi-page PDF; Phase-1 supports image only
  model_load_fail — transformers AutoModel.from_pretrained raised
  oom             — torch raised an OOM (CPU or accelerator)
  inference_fail  — any other exception during forward
  bad_output      — model returned a tensor with unexpected shape
"""

from __future__ import annotations

import io
import json
import os
import sys
import traceback
from typing import Any

from hf_dns_fallback import install as install_hf_dns_fallback

install_hf_dns_fallback()

MODEL_ID = os.environ.get("COLPALI_MODEL_ID", "vidore/colqwen2-v1.0-hf")
EXPECTED_PATCHES = int(os.environ.get("COLPALI_EXPECTED_PATCHES", "196"))
EXPECTED_DIM = int(os.environ.get("COLPALI_EXPECTED_DIM", "128"))
USE_OPENVINO = os.environ.get("COLPALI_USE_OPENVINO", "0") == "1"
OPENVINO_DIR = os.environ.get("COLPALI_OPENVINO_DIR") or None
OPENVINO_DEVICE = os.environ.get("COLPALI_OPENVINO_DEVICE", "AUTO")
TORCH_DEVICE = os.environ.get("COLPALI_TORCH_DEVICE", "auto").lower()


def die(tag: str, msg: str, code: int = 1) -> None:
    """Emit a structured error to stderr and exit."""
    print(f"{tag}: {msg}", file=sys.stderr, flush=True)
    sys.exit(code)


def read_stdin_bytes() -> bytes:
    data = sys.stdin.buffer.read()
    if not data:
        die("decode_fail", "no bytes on stdin")
    return data


def decode_image(raw: bytes):
    """Return a PIL.Image.Image in RGB. Reject multi-page PDFs in Phase-1."""
    # PDF sniff — caller may forward a PDF; we explicitly refuse it for now so
    # the failure is honest rather than silently using only page 1.
    if raw[:5] == b"%PDF-":
        die("pdf_unsupported",
            "Phase-1 image-only; route PDFs through pdf-splitter (not yet built)")
    try:
        from PIL import Image, UnidentifiedImageError  # type: ignore
    except ImportError as e:
        die("model_load_fail", f"Pillow not installed: {e}")

    try:
        img = Image.open(io.BytesIO(raw))
        img.load()
    except UnidentifiedImageError as e:
        die("decode_fail", f"Pillow could not identify image: {e}")
    except Exception as e:  # noqa: BLE001
        die("decode_fail", f"image open failed: {e}")

    try:
        if img.mode != "RGB":
            img = img.convert("RGB")
    except Exception as e:  # noqa: BLE001
        die("decode_fail", f"image convert RGB failed: {e}")
    return img


def load_model():
    """Load the exported OpenVINO model when available, else CPU reference."""
    try:
        import torch  # type: ignore
    except ImportError as e:
        die("model_load_fail", f"transformers/torch missing: {e}")

    try:
        if USE_OPENVINO and OPENVINO_DIR and os.path.isdir(OPENVINO_DIR):
            from transformers import AutoProcessor  # type: ignore
            from optimum.intel import OVModelForFeatureExtraction  # type: ignore
            processor = AutoProcessor.from_pretrained(MODEL_ID, trust_remote_code=True)
            model = OVModelForFeatureExtraction.from_pretrained(
                OPENVINO_DIR,
                device=OPENVINO_DEVICE,
                trust_remote_code=True,
            )
            return processor, model, torch

        from transformers import ColQwen2ForRetrieval, ColQwen2Processor  # type: ignore
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

    return processor, model, torch


def run_inference(processor, model, torch, img) -> Any:
    """Return the raw float32 patch tensor [num_patches, dim]."""
    try:
        # ColPali / ColQwen2 processors expose process_images(); fall back to
        # standard __call__ if the variant doesn't have it.
        if hasattr(processor, "process_images"):
            batch = processor.process_images([img])
        else:
            batch = processor(images=[img], return_tensors="pt")
        # Move everything to the model's device.
        try:
            device = next(model.parameters()).device
            batch = {k: v.to(device) if hasattr(v, "to") else v for k, v in batch.items()}
        except (AttributeError, StopIteration, TypeError):
            # Optimum/OpenVINO models own device placement internally.
            pass

        with torch.no_grad():
            out = model(**batch)
    except RuntimeError as e:
        msg = str(e).lower()
        if "out of memory" in msg or "cuda oom" in msg:
            die("oom", str(e))
        die("inference_fail", f"RuntimeError: {e}")
    except Exception as e:  # noqa: BLE001
        die("inference_fail", f"{type(e).__name__}: {e}")

    # ColQwen2 returns the embedding tensor directly OR a tuple/obj with
    # `.embeddings`. Normalize.
    tensor = None
    if hasattr(out, "embeddings"):
        tensor = out.embeddings
    elif isinstance(out, (list, tuple)) and len(out) > 0:
        tensor = out[0]
    else:
        tensor = out

    try:
        # Expected shape [1, num_patches, dim].
        if tensor.dim() == 3:
            tensor = tensor[0]
        if tensor.dim() != 2:
            die("bad_output", f"unexpected tensor rank {tensor.dim()}; shape={tuple(tensor.shape)}")
    except AttributeError:
        die("bad_output", f"model output not a tensor: {type(tensor).__name__}")

    return tensor


def quantize_int8(tensor) -> list[list[int]]:
    """Symmetrically map normalized embeddings [-1, 1] to signed int8."""
    try:
        import torch  # type: ignore
        t = tensor.detach().to(torch.float32).cpu()
        t = torch.clamp(t, min=-1.0, max=1.0)
        t = torch.round(t * 127.0).to(torch.int8)
        return t.tolist()
    except Exception as e:  # noqa: BLE001
        die("bad_output", f"quantize failed: {e}")
        return []  # unreachable, keeps type checkers happy


def main() -> None:
    raw = read_stdin_bytes()
    img = decode_image(raw)
    processor, model, torch = load_model()
    tensor = run_inference(processor, model, torch, img)
    patches = quantize_int8(tensor)

    n = len(patches)
    dim = len(patches[0]) if n else 0
    if n != EXPECTED_PATCHES:
        # Soft warn only — different image aspect ratios can shift patch count
        # in some ColPali variants. Caller is responsible for max-sim padding.
        print(
            f"warn: got {n} patches (expected {EXPECTED_PATCHES})",
            file=sys.stderr,
            flush=True,
        )
    if dim != EXPECTED_DIM:
        die("bad_output", f"patch dim {dim} != expected {EXPECTED_DIM}")

    json.dump(
        {"page_count": 1, "patches": [patches]},
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
