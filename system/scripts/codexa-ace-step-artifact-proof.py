#!/usr/bin/env python3
"""Generate one deterministic ACE-Step music artifact on Codexa Intel XPU."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path


MODEL_ID = "ACE-Step/Ace-Step1.5"
MODEL_REVISION = "19671f406d603126926c1b7e2adc169acbcade22"
DIT_MODEL = "acestep-v15-turbo"
REQUIRED_FILES = (
    "checkpoints/acestep-v15-turbo/model.safetensors",
    "checkpoints/Qwen3-Embedding-0.6B/model.safetensors",
    "checkpoints/vae/diffusion_pytorch_model.safetensors",
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--duration", type=float, default=12.0)
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    missing = [relative for relative in REQUIRED_FILES if not (project_root / relative).is_file()]
    if missing:
        raise FileNotFoundError(f"ACE-Step snapshot incomplete at {MODEL_REVISION}: {missing}")
    model_hashes = {
        relative: sha256_file(project_root / relative)
        for relative in REQUIRED_FILES
    }

    os.environ["ACESTEP_CHECKPOINTS_DIR"] = str(project_root / "checkpoints")
    os.environ["HF_HUB_OFFLINE"] = "1"
    os.environ["TRANSFORMERS_OFFLINE"] = "1"
    os.environ["MODELSCOPE_OFFLINE"] = "1"

    import soundfile as sf
    import torch
    import acestep.model_downloader as model_downloader

    # ACE-Step's shared checkpoint guard includes the optional 1.7B thinking
    # model even when the caller supplies no LM and thinking is disabled.  The
    # DiT-only Orange lane needs exactly the three runtime components verified
    # above, so narrow the guard before the handler imports it.  No model load
    # or generation code is bypassed.
    model_downloader.MAIN_MODEL_COMPONENTS = [
        component
        for component in model_downloader.MAIN_MODEL_COMPONENTS
        if component != model_downloader.DEFAULT_LM_MODEL
    ]

    from acestep.handler import AceStepHandler
    from acestep.inference import GenerationConfig, GenerationParams, generate_music

    if not hasattr(torch, "xpu") or not torch.xpu.is_available():
        raise RuntimeError("Intel XPU is not available")

    started = time.perf_counter()
    handler = AceStepHandler()
    status_message, initialized = handler.initialize_service(
        project_root=str(project_root),
        config_path=DIT_MODEL,
        device="xpu",
        use_flash_attention=False,
        compile_model=False,
        offload_to_cpu=False,
        offload_dit_to_cpu=False,
        quantization=None,
    )
    if not initialized:
        raise RuntimeError(status_message)

    params = GenerationParams(
        task_type="text2music",
        caption=(
            "Instrumental futuristic electronic score, precise mechanical percussion, "
            "warm analog bass, luminous synthesizer motif, confident forward motion, no vocals"
        ),
        lyrics="[Instrumental]",
        instrumental=True,
        bpm=118,
        keyscale="D minor",
        timesignature="4",
        vocal_language="unknown",
        duration=max(10.0, min(30.0, args.duration)),
        thinking=False,
        inference_steps=8,
        seed=20260826,
        enable_normalization=True,
    )
    config = GenerationConfig(
        batch_size=1,
        use_random_seed=False,
        seeds=[20260826],
        audio_format="wav",
    )
    generation_started = time.perf_counter()
    result = generate_music(handler, None, params, config, save_dir=str(output_dir))
    if not result.success or not result.audios:
        raise RuntimeError(result.error or result.status_message or "ACE-Step returned no audio")

    produced = Path(result.audios[0]["path"]).resolve()
    if not produced.is_file():
        raise FileNotFoundError(f"ACE-Step reported a missing artifact: {produced}")
    artifact = output_dir / "orangefive-ace-step-proof.wav"
    if produced != artifact:
        shutil.copy2(produced, artifact)
    audio, sample_rate = sf.read(artifact, always_2d=True)
    peak = float(abs(audio).max()) if audio.size else 0.0
    rms = float((audio ** 2).mean() ** 0.5) if audio.size else 0.0
    duration = float(audio.shape[0] / sample_rate) if sample_rate else 0.0
    if duration < 9.5 or rms <= 0.005 or peak <= 0.02:
        raise RuntimeError(f"generated audio failed signal proof: duration={duration} rms={rms} peak={peak}")

    receipt = {
        "schema": "orange.captain_planet.music_artifact.v1",
        "status": "MUSIC_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "model_id": MODEL_ID,
        "model_revision": MODEL_REVISION,
        "runner_sha256": sha256_file(Path(__file__).resolve()),
        "dit_model": DIT_MODEL,
        "lm_model": None,
        "checkpoint_policy": "dit-only; optional thinking LM not loaded",
        "model_hashes": model_hashes,
        "device": str(torch.xpu.get_device_name(0)),
        "torch_version": torch.__version__,
        "initialization_seconds": round(generation_started - started, 3),
        "generation_seconds": round(time.perf_counter() - generation_started, 3),
        "artifact_proven": True,
        "studio_quality_proven": False,
        "quality_status": "PENDING_LISTENING_AND_MUSIC_QUALITY_BENCHMARK",
        "artifact": str(artifact),
        "artifact_bytes": artifact.stat().st_size,
        "artifact_sha256": sha256_file(artifact),
        "sample_rate": sample_rate,
        "channels": int(audio.shape[1]),
        "duration_seconds": round(duration, 3),
        "rms": round(rms, 6),
        "peak": round(peak, 6),
        "seed": 20260826,
        "prompt": params.caption,
    }
    receipt_path = output_dir / "ace-step-artifact-proof.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
