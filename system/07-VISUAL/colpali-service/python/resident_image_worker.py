#!/usr/bin/env python3
"""Persistent framed ColQwen2 image worker: load once, process many images."""

from __future__ import annotations

import json
import sys
import traceback

from colqwen_ingest import decode_image, load_model, quantize_int8, run_inference


def emit(value: dict) -> None:
    sys.stdout.write(json.dumps(value, separators=(",", ":")) + "\n")
    sys.stdout.flush()


def read_exact(length: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < length:
        chunk = sys.stdin.buffer.read(length - len(chunks))
        if not chunk:
            raise EOFError(f"stdin ended at {len(chunks)} of {length} bytes")
        chunks.extend(chunk)
    return bytes(chunks)


def main() -> None:
    processor, model, torch = load_model()
    emit({"type": "ready", "backend": str(type(model).__name__)})
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return
        try:
            header = json.loads(line)
            if header.get("type") == "shutdown":
                return
            request_id = str(header["id"])
            length = int(header["bytes"])
            if length <= 0:
                raise ValueError("bytes must be positive")
            raw = read_exact(length)
            image = decode_image(raw)
            tensor = run_inference(processor, model, torch, image)
            patches = quantize_int8(tensor)
            emit({
                "id": request_id,
                "ok": True,
                "result": {"page_count": 1, "patches": [patches]},
            })
        except SystemExit as error:
            emit({
                "id": locals().get("request_id", "unknown"),
                "ok": False,
                "error": f"worker request exited: {error.code}",
            })
        except Exception as error:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            emit({
                "id": locals().get("request_id", "unknown"),
                "ok": False,
                "error": f"{type(error).__name__}: {error}",
            })


if __name__ == "__main__":
    main()
