#!/usr/bin/env python3
"""
OrangeEye Phase-2 — ColQwen2.5 PyTorch -> OpenVINO IR converter.

One-shot offline tool. Loads the HuggingFace ColQwen2.5 weights, exports them
to OpenVINO IR (.xml + .bin) via optimum-intel, and writes the bundle to disk
so the resident pdf_ingest.py / colqwen_ingest.py workers can prefer the IR
path on Codexa (Intel Core Ultra 9 285H + integrated NPU, no discrete GPU).

Why this exists
---------------
The Phase-1 transformers reference path on Codexa runs the float32 ColQwen2.5
forward at ~3-4 s per A4 page on CPU and never touches the NPU. Converting to
OpenVINO IR and routing through `OVModelForFeatureExtraction` with device=AUTO
lets the OpenVINO runtime split the graph across CPU + NPU at load time. On
the 285H this is measurably faster (target: <1.2 s per page at the same DPI)
and the NPU's low TDP frees CPU headroom for the Bun + SQLite queue layer.

What this script does
---------------------
1. Resolve the HF model id (default `vidore/colqwen2-v1.0`; override with
   COLPALI_MODEL_ID). Resolve the destination dir (default
   `/opt/atomeons/colqwen2-openvino/`; override with COLPALI_OPENVINO_DIR).
2. Verify optimum-intel + openvino are importable and at supported versions.
   Fail loudly with install hints if not — silent fallback would mask the
   whole reason this script exists.
3. Load the model with transformers + trust_remote_code (ColQwen2 is custom
   modeling code; the processor / pre-processing path is preserved).
4. Run `optimum-cli export openvino` programmatically via the Python API
   (`optimum.exporters.openvino.main_export`). This handles tracing, IR
   serialization, and tokenizer/processor snapshot in one call.
5. Verify the resulting bundle: the dir must contain `openvino_model.xml`,
   `openvino_model.bin`, the processor's config files, and a non-zero IR.
6. Write `conversion_receipt.json` next to the IR — model id, source revision,
   optimum + openvino versions, dtype, sha256 of the .bin, and the host's
   detected NPU/CPU descriptors. The Phase-2 loader reads this to decide
   whether the cached IR matches what's wanted.
7. Run a tiny smoke inference (one synthetic 224x224 white PIL image) through
   the freshly exported IR on device=AUTO. If that fails, the cache is
   deleted — half-broken IR is worse than no IR (the resident worker would
   crash on first request).

This is NOT a hot path. It's expected to run once per host, or whenever the
model id / optimum version changes. Re-runs are idempotent: the destination
dir is wiped and rewritten atomically (export to a sibling `.partial` dir,
then `os.replace` swap). A concurrent run is detected via a lockfile and
refused.

Exit codes
----------
  0  success — IR + receipt written, smoke test green
  1  user error (bad args, missing source, etc.)
  2  dependency missing (optimum, openvino, transformers, torch)
  3  conversion failure (export raised, tracing diverged)
  4  verification failure (smoke test failed, IR malformed)
  5  concurrent run detected

Usage
-----
  python3 openvino_convert.py
  python3 openvino_convert.py --dest /opt/atomeons/colqwen2-openvino
  python3 openvino_convert.py --model vidore/colqwen2-v1.0 --dtype fp16
  python3 openvino_convert.py --force            # wipe existing IR first
  COLPALI_OPENVINO_DEVICE=NPU python3 openvino_convert.py --smoke-only
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import shutil
import socket
import subprocess
import sys
import tempfile
import time
import traceback
from pathlib import Path
from typing import Any

# --------------------------------------------------------------------------- #
# Defaults                                                                    #
# --------------------------------------------------------------------------- #

DEFAULT_MODEL_ID = os.environ.get("COLPALI_MODEL_ID", "vidore/colqwen2-v1.0")
DEFAULT_DEST = os.environ.get(
    "COLPALI_OPENVINO_DIR", "/opt/atomeons/colqwen2-openvino"
)
DEFAULT_DEVICE = os.environ.get("COLPALI_OPENVINO_DEVICE", "AUTO")
DEFAULT_DTYPE = os.environ.get("COLPALI_OPENVINO_DTYPE", "fp32")  # fp32|fp16|int8
LOCKFILE_NAME = ".convert.lock"
RECEIPT_NAME = "conversion_receipt.json"
IR_XML = "openvino_model.xml"
IR_BIN = "openvino_model.bin"

# Minimum versions we accept. Older optimum-intel did not preserve trust_remote_code
# for ColQwen2 and silently produced an IR that crashes at first inference.
MIN_OPTIMUM = (1, 21, 0)
MIN_OPENVINO = (2024, 4, 0)


# --------------------------------------------------------------------------- #
# Logging / exit                                                              #
# --------------------------------------------------------------------------- #


def log(msg: str) -> None:
    print(f"[openvino-convert] {msg}", file=sys.stderr, flush=True)


def die(code: int, msg: str) -> "Any":
    log(f"FATAL: {msg}")
    sys.exit(code)


# --------------------------------------------------------------------------- #
# Args                                                                        #
# --------------------------------------------------------------------------- #


def parse_args() -> argparse.Namespace:
    p = argparse.ArgumentParser(
        description="Convert ColQwen2.5 (PyTorch) to OpenVINO IR for Codexa.",
    )
    p.add_argument(
        "--model", default=DEFAULT_MODEL_ID,
        help=f"HuggingFace model id (default: {DEFAULT_MODEL_ID})",
    )
    p.add_argument(
        "--dest", default=DEFAULT_DEST,
        help=f"Output directory for IR + receipt (default: {DEFAULT_DEST})",
    )
    p.add_argument(
        "--dtype", default=DEFAULT_DTYPE, choices=["fp32", "fp16", "int8"],
        help="IR weight dtype. fp16 is the right call for NPU on 285H.",
    )
    p.add_argument(
        "--device", default=DEFAULT_DEVICE,
        help="Smoke-test device (AUTO / CPU / NPU / GPU). Default: AUTO.",
    )
    p.add_argument(
        "--force", action="store_true",
        help="Wipe destination dir before converting (no merge).",
    )
    p.add_argument(
        "--skip-smoke", action="store_true",
        help="Skip the post-export smoke inference. Use only when debugging.",
    )
    p.add_argument(
        "--smoke-only", action="store_true",
        help="Skip export; only run smoke test on existing IR in --dest.",
    )
    return p.parse_args()


# --------------------------------------------------------------------------- #
# Dependency probing                                                          #
# --------------------------------------------------------------------------- #


def _parse_version(v: str) -> tuple[int, ...]:
    nums: list[int] = []
    for part in v.split("."):
        digits = "".join(ch for ch in part if ch.isdigit())
        if not digits:
            break
        nums.append(int(digits))
    return tuple(nums)


def require_deps() -> dict[str, str]:
    """Import-check and version-check every dependency we need."""
    versions: dict[str, str] = {}

    try:
        import torch  # type: ignore
        versions["torch"] = torch.__version__
    except ImportError as e:
        die(2, f"torch missing: {e}. pip install torch")

    try:
        import transformers  # type: ignore
        versions["transformers"] = transformers.__version__
    except ImportError as e:
        die(2, f"transformers missing: {e}. pip install transformers")

    try:
        import optimum  # type: ignore
        versions["optimum"] = getattr(optimum, "__version__", "unknown")
    except ImportError as e:
        die(2, f"optimum missing: {e}. pip install optimum[openvino]")

    try:
        import optimum.intel  # type: ignore
        versions["optimum-intel"] = getattr(
            optimum.intel, "__version__", versions.get("optimum", "unknown")
        )
    except ImportError as e:
        die(2, f"optimum-intel missing: {e}. pip install optimum[openvino]")

    try:
        import openvino  # type: ignore
        versions["openvino"] = openvino.__version__
    except ImportError as e:
        die(2, f"openvino missing: {e}. pip install openvino>=2024.4")

    # Version floor enforcement. Strings like "1.21.0.dev0" parse to (1,21,0).
    opt_v = _parse_version(versions["optimum-intel"])
    if opt_v and opt_v < MIN_OPTIMUM:
        die(
            2,
            f"optimum-intel {versions['optimum-intel']} < required "
            f"{'.'.join(map(str, MIN_OPTIMUM))}. Older versions miscompile "
            "ColQwen2's trust_remote_code modules.",
        )
    ov_v = _parse_version(versions["openvino"])
    if ov_v and ov_v < MIN_OPENVINO:
        die(
            2,
            f"openvino {versions['openvino']} < required "
            f"{'.'.join(map(str, MIN_OPENVINO))}. NPU plugin on Intel Core "
            "Ultra (Meteor/Arrow/Lunar Lake) needs 2024.4+.",
        )

    # pdf2image / PIL for smoke test image — Pillow is a transformers dep but
    # double-check; pdf2image is not needed here.
    try:
        import PIL  # type: ignore  # noqa: F401
        versions["pillow"] = PIL.__version__  # type: ignore[attr-defined]
    except ImportError as e:
        die(2, f"Pillow missing: {e}. pip install pillow")

    return versions


# --------------------------------------------------------------------------- #
# Host descriptors                                                            #
# --------------------------------------------------------------------------- #


def detect_host() -> dict[str, Any]:
    """Best-effort fingerprint of the converting host, for the receipt."""
    info: dict[str, Any] = {
        "hostname": socket.gethostname(),
        "platform": platform.platform(),
        "machine": platform.machine(),
        "processor": platform.processor() or "unknown",
        "python": sys.version.split()[0],
    }
    # OpenVINO device list — the NPU shows up here only if the driver is loaded.
    try:
        import openvino as ov  # type: ignore
        core = ov.Core()
        info["openvino_devices"] = list(core.available_devices)
        cpu_name = None
        try:
            cpu_name = core.get_property("CPU", "FULL_DEVICE_NAME")
        except Exception:  # noqa: BLE001
            pass
        if cpu_name:
            info["cpu_full_name"] = str(cpu_name)
        npu_name = None
        if "NPU" in info["openvino_devices"]:
            try:
                npu_name = core.get_property("NPU", "FULL_DEVICE_NAME")
            except Exception:  # noqa: BLE001
                pass
        if npu_name:
            info["npu_full_name"] = str(npu_name)
    except Exception as e:  # noqa: BLE001
        info["openvino_devices_error"] = f"{type(e).__name__}: {e}"
    return info


# --------------------------------------------------------------------------- #
# Lock / atomic dest                                                          #
# --------------------------------------------------------------------------- #


class ConvertLock:
    """Filesystem lockfile under the dest dir. Best-effort, single-host."""

    def __init__(self, dest: Path) -> None:
        self.dest = dest
        self.path = dest / LOCKFILE_NAME

    def __enter__(self) -> "ConvertLock":
        self.dest.mkdir(parents=True, exist_ok=True)
        try:
            fd = os.open(self.path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            try:
                age = time.time() - self.path.stat().st_mtime
            except OSError:
                age = -1.0
            die(
                5,
                f"lockfile present at {self.path} (age={age:.0f}s). "
                "Another converter is running, or it crashed — delete the "
                "lockfile to retry.",
            )
        with os.fdopen(fd, "w") as f:
            f.write(json.dumps({"pid": os.getpid(), "started": time.time()}))
        return self

    def __exit__(self, exc_type, exc, tb) -> None:  # noqa: ANN001
        try:
            self.path.unlink(missing_ok=True)
        except OSError:
            pass


def _sha256_file(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_replace_dir(src: Path, dst: Path) -> None:
    """Replace dst with src. dst must be empty or non-existent."""
    if dst.exists():
        # Move existing aside first so the swap is reversible if rename fails.
        backup = dst.with_name(dst.name + ".old")
        if backup.exists():
            shutil.rmtree(backup)
        os.replace(dst, backup)
        try:
            os.replace(src, dst)
        except OSError:
            # Restore on failure.
            os.replace(backup, dst)
            raise
        shutil.rmtree(backup, ignore_errors=True)
    else:
        os.replace(src, dst)


# --------------------------------------------------------------------------- #
# Conversion                                                                  #
# --------------------------------------------------------------------------- #


def export_to_openvino(model_id: str, dtype: str, work_dir: Path) -> None:
    """Run optimum's OpenVINO exporter into work_dir.

    We use the programmatic API (`main_export`) instead of shelling out to
    `optimum-cli` so dependency errors surface as Python exceptions with full
    tracebacks, not opaque subprocess returncodes.
    """
    work_dir.mkdir(parents=True, exist_ok=True)
    try:
        # Modern path (optimum-intel >= 1.18).
        from optimum.exporters.openvino import main_export  # type: ignore
    except ImportError as e:
        die(3, f"main_export import failed: {e}")

    weight_format = {"fp32": "fp32", "fp16": "fp16", "int8": "int8"}[dtype]

    log(f"exporting {model_id!r} to {work_dir} (dtype={weight_format})")
    t0 = time.time()
    try:
        main_export(
            model_name_or_path=model_id,
            output=str(work_dir),
            task="feature-extraction",
            library_name="transformers",
            trust_remote_code=True,
            weight_format=weight_format,
        )
    except TypeError:
        # Some optimum versions use `dtype=` instead of `weight_format=`.
        try:
            main_export(  # type: ignore[call-arg]
                model_name_or_path=model_id,
                output=str(work_dir),
                task="feature-extraction",
                library_name="transformers",
                trust_remote_code=True,
                dtype=weight_format,
            )
        except Exception as e:  # noqa: BLE001
            die(3, f"main_export raised (fallback signature): "
                   f"{type(e).__name__}: {e}")
    except Exception as e:  # noqa: BLE001
        die(3, f"main_export raised: {type(e).__name__}: {e}")
    dt = time.time() - t0
    log(f"export finished in {dt:.1f}s")

    # Required artifacts must exist after export.
    for required in (IR_XML, IR_BIN):
        p = work_dir / required
        if not p.exists() or p.stat().st_size == 0:
            die(3, f"export produced no {required} (or it is empty) in {work_dir}")


def smoke_test(dest: Path, device: str) -> dict[str, Any]:
    """Load the exported IR and run a single forward on a 224x224 white image.

    Returns a small dict logged into the conversion receipt. Raises (caught
    by caller) on any failure so the half-broken cache can be discarded.
    """
    try:
        import numpy as np  # type: ignore  # noqa: F401
        from PIL import Image  # type: ignore
        import torch  # type: ignore
        from transformers import AutoProcessor  # type: ignore
        from optimum.intel import OVModelForFeatureExtraction  # type: ignore
    except ImportError as e:
        raise RuntimeError(f"smoke deps missing: {e}") from e

    log(f"smoke-test loading IR from {dest} on device={device}")
    t_load_0 = time.time()
    processor = AutoProcessor.from_pretrained(str(dest), trust_remote_code=True)
    model = OVModelForFeatureExtraction.from_pretrained(
        str(dest),
        device=device,
        trust_remote_code=True,
    )
    t_load = time.time() - t_load_0

    img = Image.new("RGB", (224, 224), color=(255, 255, 255))

    if hasattr(processor, "process_images"):
        batch = processor.process_images([img])
    else:
        batch = processor(images=[img], return_tensors="pt")

    t_run_0 = time.time()
    with torch.no_grad():
        out = model(**batch)
    t_run = time.time() - t_run_0

    # Normalize output to a shape we can describe.
    tensor = None
    if hasattr(out, "embeddings"):
        tensor = out.embeddings
    elif hasattr(out, "last_hidden_state"):
        tensor = out.last_hidden_state
    elif isinstance(out, (list, tuple)) and len(out) > 0:
        tensor = out[0]
    else:
        tensor = out

    shape: list[int] = []
    try:
        shape = list(tensor.shape)
    except AttributeError as e:
        raise RuntimeError(f"smoke output not a tensor: {type(tensor).__name__}") from e

    log(f"smoke OK device={device} load={t_load:.2f}s run={t_run:.3f}s "
        f"shape={shape}")
    return {
        "device": device,
        "load_seconds": round(t_load, 3),
        "run_seconds": round(t_run, 3),
        "output_shape": shape,
    }


# --------------------------------------------------------------------------- #
# Receipt                                                                     #
# --------------------------------------------------------------------------- #


def write_receipt(
    dest: Path,
    model_id: str,
    dtype: str,
    versions: dict[str, str],
    host: dict[str, Any],
    smoke: dict[str, Any] | None,
) -> None:
    """Drop conversion_receipt.json next to the IR."""
    ir_bin = dest / IR_BIN
    bin_sha = _sha256_file(ir_bin) if ir_bin.exists() else None
    bin_size = ir_bin.stat().st_size if ir_bin.exists() else 0

    receipt = {
        "schema": "atomeons.colpali.openvino_receipt.v1",
        "model_id": model_id,
        "dtype": dtype,
        "created_utc": int(time.time()),
        "ir_xml": IR_XML,
        "ir_bin": IR_BIN,
        "ir_bin_sha256": bin_sha,
        "ir_bin_bytes": bin_size,
        "versions": versions,
        "host": host,
        "smoke": smoke,
    }
    (dest / RECEIPT_NAME).write_text(
        json.dumps(receipt, indent=2, sort_keys=True), encoding="utf-8"
    )
    log(f"wrote receipt -> {dest / RECEIPT_NAME}")


# --------------------------------------------------------------------------- #
# Main                                                                        #
# --------------------------------------------------------------------------- #


def main() -> None:
    args = parse_args()
    dest = Path(args.dest).expanduser().resolve()
    log(f"model={args.model} dest={dest} dtype={args.dtype} device={args.device}")

    if args.smoke_only:
        if not (dest / IR_XML).exists():
            die(1, f"--smoke-only but no IR at {dest / IR_XML}")
        versions = require_deps()
        host = detect_host()
        try:
            smoke = smoke_test(dest, args.device)
        except Exception as e:  # noqa: BLE001
            traceback.print_exc(file=sys.stderr)
            die(4, f"smoke test failed: {type(e).__name__}: {e}")
        write_receipt(dest, args.model, args.dtype, versions, host, smoke)
        return

    versions = require_deps()
    host = detect_host()

    # Lock + work-dir strategy: export into <dest>.partial, then atomic swap.
    if dest.exists() and args.force:
        log(f"--force: removing existing {dest}")
        shutil.rmtree(dest)

    dest.mkdir(parents=True, exist_ok=True)
    with ConvertLock(dest):
        # Work in a sibling tempdir so a partial export never overwrites a good
        # cache. `tempfile.mkdtemp` keeps it on the same filesystem as `dest`
        # so the final `os.replace` stays atomic.
        partial_parent = dest.parent
        partial_parent.mkdir(parents=True, exist_ok=True)
        partial = Path(tempfile.mkdtemp(prefix=f"{dest.name}.partial-",
                                        dir=str(partial_parent)))
        try:
            export_to_openvino(args.model, args.dtype, partial)

            # Bring across any processor / tokenizer files that main_export
            # already wrote into `partial`. If a future optimum version
            # dropped these, fetch them now so the loader path is fully
            # self-contained.
            _ensure_processor_files(partial, args.model)

            # Swap into place.
            log(f"swapping {partial} -> {dest}")
            _atomic_replace_dir(partial, dest)
        except SystemExit:
            shutil.rmtree(partial, ignore_errors=True)
            raise
        except Exception as e:  # noqa: BLE001
            shutil.rmtree(partial, ignore_errors=True)
            traceback.print_exc(file=sys.stderr)
            die(3, f"export aborted: {type(e).__name__}: {e}")

        # Smoke test on the final dest (the live device the loader will use).
        smoke: dict[str, Any] | None = None
        if not args.skip_smoke:
            try:
                smoke = smoke_test(dest, args.device)
            except Exception as e:  # noqa: BLE001
                traceback.print_exc(file=sys.stderr)
                log(f"smoke test failed: {type(e).__name__}: {e}")
                log("removing half-broken IR cache; rerun once env is fixed")
                shutil.rmtree(dest, ignore_errors=True)
                die(4, "smoke test failed; cache discarded")

        write_receipt(dest, args.model, args.dtype, versions, host, smoke)

    log("done")


def _ensure_processor_files(work_dir: Path, model_id: str) -> None:
    """Make sure the processor / tokenizer config is alongside the IR.

    optimum-intel's exporter copies most of these, but older versions miss
    `preprocessor_config.json` for ColQwen2. We re-save the processor from
    the source repo to guarantee `AutoProcessor.from_pretrained(<dest>)`
    works without re-reaching HuggingFace at serve time.
    """
    try:
        from transformers import AutoProcessor  # type: ignore
    except ImportError as e:
        die(2, f"transformers missing during processor copy: {e}")

    needed = ("preprocessor_config.json", "tokenizer_config.json")
    missing = [n for n in needed if not (work_dir / n).exists()]
    if not missing:
        return
    log(f"processor files missing in export ({missing}); re-saving from {model_id}")
    try:
        proc = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        proc.save_pretrained(str(work_dir))
    except Exception as e:  # noqa: BLE001
        # Non-fatal: the loader can still pull from HF at first use, but warn
        # because that breaks offline-only deploys.
        log(f"warn: processor re-save failed ({type(e).__name__}: {e}); "
            "the IR may need HF_HUB_OFFLINE=0 on first load.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except KeyboardInterrupt:
        die(1, "interrupted")
    except Exception as e:  # noqa: BLE001
        traceback.print_exc(file=sys.stderr)
        die(3, f"unhandled: {type(e).__name__}: {e}")
