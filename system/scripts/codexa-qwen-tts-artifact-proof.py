#!/usr/bin/env python3
"""Prove one locally installed Qwen3-TTS artifact on Codexa."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path


MODEL_ID = "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice"
MODEL_REVISION = "0c0e3051f131929182e2c023b9537f8b1c68adfe"
REQUIRED_MODEL_FILES = ("model.safetensors", "speech_tokenizer/model.safetensors")
PROOF_TEXT = "OrangeFive is awake. Evidence leads, receipts prove, and the operator remains in command."
PROOF_LANGUAGE = "English"
PROOF_SPEAKER = "Ryan"
PROOF_INSTRUCTION = "Calm technical confidence, concise, no theatrical delivery."


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model-dir", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--download-only", action="store_true")
    parser.add_argument(
        "--allow-download",
        action="store_true",
        help="Explicitly allow snapshot_download. The proof route is offline by default.",
    )
    parser.add_argument("--revision", default=MODEL_REVISION)
    args = parser.parse_args()

    model_dir = Path(args.model_dir).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    started = time.perf_counter()

    revision = args.revision
    offline = not args.allow_download
    if args.allow_download:
        from huggingface_hub import snapshot_download

        snapshot_download(MODEL_ID, revision=revision, local_dir=model_dir)
    else:
        os.environ.update({
            "HF_HUB_OFFLINE": "1",
            "TRANSFORMERS_OFFLINE": "1",
            "HF_DATASETS_OFFLINE": "1",
        })
    missing = [relative for relative in REQUIRED_MODEL_FILES if not (model_dir / relative).is_file()]
    if missing:
        raise FileNotFoundError(f"model snapshot incomplete at pinned revision {revision}: {missing}")
    model_hashes = {
        relative: sha256_file(model_dir / relative)
        for relative in REQUIRED_MODEL_FILES
    }

    receipt: dict[str, object] = {
        "schema": "orange.captain_planet.tts_artifact.v1",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model_id": MODEL_ID,
        "model_revision": revision,
        "runner_sha256": sha256_file(Path(__file__).resolve()),
        "model_dir": str(model_dir),
        "offline": offline,
        "download_seconds": round(time.perf_counter() - started, 3),
        "download_performed": args.allow_download,
        "model_hashes": model_hashes,
        "artifact_proven": False,
    }

    if args.download_only:
        receipt["status"] = "MODEL_DOWNLOADED_ARTIFACT_PENDING"
    else:
        import soundfile as sf
        import torch
        from qwen_tts import Qwen3TTSModel

        if not hasattr(torch, "xpu") or not torch.xpu.is_available():
            raise RuntimeError("Intel XPU is not available")
        generation_started = time.perf_counter()
        model = Qwen3TTSModel.from_pretrained(
            str(model_dir),
            device_map="xpu:0",
            dtype=torch.bfloat16,
            attn_implementation="sdpa",
        )
        wavs, sample_rate = model.generate_custom_voice(
            text=PROOF_TEXT,
            language=PROOF_LANGUAGE,
            speaker=PROOF_SPEAKER,
            instruct=PROOF_INSTRUCTION,
            max_new_tokens=512,
        )
        artifact = output_dir / "orangefive-qwen3-tts-proof.wav"
        sf.write(artifact, wavs[0], sample_rate)
        size = artifact.stat().st_size
        if size <= 44:
            raise RuntimeError("Generated WAV has no audio payload")
        receipt.update(
            {
                "status": "TTS_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED",
                "artifact_proven": True,
                "studio_quality_proven": False,
                "quality_status": "PENDING_INTELLIGIBILITY_AND_LISTENING_BENCHMARK",
                "text": PROOF_TEXT,
                "language": PROOF_LANGUAGE,
                "speaker": PROOF_SPEAKER,
                "instruction": PROOF_INSTRUCTION,
                "artifact": str(artifact),
                "artifact_bytes": size,
                "artifact_sha256": sha256_file(artifact),
                "sample_rate": sample_rate,
                "generation_seconds": round(time.perf_counter() - generation_started, 3),
                "torch_version": torch.__version__,
                "device": str(torch.xpu.get_device_name(0)),
            }
        )

    receipt_path = output_dir / "qwen3-tts-artifact-proof.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
