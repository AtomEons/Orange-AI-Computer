#!/usr/bin/env python3
"""Generate and prove one real LTX-Video artifact on Codexa Intel XPU.

The upstream LTXV 0.9.8 inference pipeline supports arbitrary torch devices
internally but its CLI device selector only exposes CUDA, MPS, and CPU.  This
wrapper leaves model and sampler behavior untouched and supplies the missing
Intel XPU selection at the boundary.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from datetime import datetime, timezone
from pathlib import Path


LTX_REPO_REVISION = "8984fa25007f376c1a299016d0957a37a2f797bb"
PIXART_REPO_REVISION = "b89adadeccd9ead2adcb9fa2825d3fabec48d404"
SEED = 20260826
PROMPT = (
    "The orange glass command instrument awakens on a black technical workbench. "
    "Its central amber filaments pulse with controlled energy while the camera makes "
    "a slow precise orbit. Machined aluminum controls remain physically stable, "
    "reflections move naturally, premium industrial design film, no text, no logo."
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def inspect_video(path: Path) -> dict:
    import imageio.v2 as imageio
    import numpy as np

    reader = imageio.get_reader(path)
    metadata = reader.get_meta_data()
    sampled = []
    frame_count = 0
    first_shape = None
    for frame_count, frame in enumerate(reader, start=1):
        if first_shape is None:
            first_shape = list(frame.shape)
        if len(sampled) < 12:
            sampled.append(frame.astype(np.float32))
    reader.close()
    if frame_count < 2 or first_shape is None:
        raise RuntimeError(f"encoded video has too few frames: {frame_count}")
    deltas = [float(np.mean(np.abs(sampled[index] - sampled[index - 1])))
              for index in range(1, len(sampled))]
    mean_delta = float(np.mean(deltas)) if deltas else 0.0
    max_delta = float(np.max(deltas)) if deltas else 0.0
    fps = float(metadata.get("fps") or 0.0)
    return {
        "container": metadata.get("plugin") or metadata.get("codec") or "mp4",
        "codec": metadata.get("codec"),
        "frame_count": frame_count,
        "fps": round(fps, 3),
        "duration_seconds": round(frame_count / fps, 3) if fps > 0 else None,
        "height": int(first_shape[0]),
        "width": int(first_shape[1]),
        "channels": int(first_shape[2]) if len(first_shape) > 2 else 1,
        "sampled_consecutive_mean_abs_delta": round(mean_delta, 4),
        "sampled_consecutive_max_abs_delta": round(max_delta, 4),
        "motion_proven": mean_delta > 0.35 and max_delta > 0.75,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--conditioning-image", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--height", type=int, default=512)
    parser.add_argument("--width", type=int, default=768)
    parser.add_argument("--frames", type=int, default=33)
    parser.add_argument("--fps", type=int, default=24)
    args = parser.parse_args()

    project_root = Path(args.project_root).resolve()
    model_root = Path(args.model_root).resolve()
    conditioning_image = Path(args.conditioning_image).resolve()
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)

    model_paths = {
        "ltxv": model_root / "ltxv-2b-0.9.8-distilled.safetensors",
        "upscaler": model_root / "ltxv-spatial-upscaler-0.9.8.safetensors",
        "text_encoder_1": model_root / "PixArt-XL-2-1024-MS" / "text_encoder" / "model-00001-of-00002.safetensors",
        "text_encoder_2": model_root / "PixArt-XL-2-1024-MS" / "text_encoder" / "model-00002-of-00002.safetensors",
    }
    for name, model_path in model_paths.items():
        if not model_path.is_file() or model_path.stat().st_size < 100_000_000:
            raise FileNotFoundError(f"missing or incomplete {name} model component: {model_path}")
    if not conditioning_image.is_file():
        raise FileNotFoundError(conditioning_image)

    os.environ.update({
        "HF_HUB_OFFLINE": "1",
        "TRANSFORMERS_OFFLINE": "1",
        "HF_DATASETS_OFFLINE": "1",
        "TOKENIZERS_PARALLELISM": "false",
    })
    sys.path.insert(0, str(project_root))

    import torch
    import yaml
    import ltx_video.inference as ltx

    if not hasattr(torch, "xpu") or not torch.xpu.is_available():
        raise RuntimeError("Intel XPU is not available to the LTX runtime")

    original_seed = ltx.seed_everething

    def seed_with_xpu(seed: int):
        original_seed(seed)
        torch.xpu.manual_seed_all(seed)

    # Upstream's only missing Intel path: choose XPU and report its real memory.
    ltx.get_device = lambda: "xpu"
    ltx.get_total_gpu_memory = lambda: (
        torch.xpu.get_device_properties(0).total_memory / (1024 ** 3)
    )
    ltx.seed_everething = seed_with_xpu

    config = {
        "pipeline_type": "multi-scale",
        "checkpoint_path": str(model_paths["ltxv"]),
        "downscale_factor": 0.6666666,
        "spatial_upscaler_model_path": str(model_paths["upscaler"]),
        "stg_mode": "attention_values",
        "decode_timestep": 0.05,
        "decode_noise_scale": 0.025,
        "text_encoder_model_name_or_path": str(model_root / "PixArt-XL-2-1024-MS"),
        "precision": "bfloat16",
        "sampler": "from_checkpoint",
        "prompt_enhancement_words_threshold": 0,
        "prompt_enhancer_image_caption_model_name_or_path": "disabled-offline",
        "prompt_enhancer_llm_model_name_or_path": "disabled-offline",
        "stochastic_sampling": False,
        "first_pass": {
            "timesteps": [1.0, 0.9937, 0.9875, 0.9812, 0.9750, 0.9094, 0.7250],
            "guidance_scale": 1,
            "stg_scale": 0,
            "rescaling_scale": 1,
            "skip_block_list": [42],
        },
        "second_pass": {
            "timesteps": [0.9094, 0.7250, 0.4219],
            "guidance_scale": 1,
            "stg_scale": 0,
            "rescaling_scale": 1,
            "skip_block_list": [42],
        },
    }
    config_path = output_dir / "orangefive-ltxv-xpu.yaml"
    config_path.write_text(yaml.safe_dump(config, sort_keys=False), encoding="utf-8")

    before = set(output_dir.glob("*.mp4"))
    started = time.perf_counter()
    ltx.infer(ltx.InferenceConfig(
        prompt=PROMPT,
        output_path=output_dir,
        pipeline_config=str(config_path),
        seed=SEED,
        height=args.height,
        width=args.width,
        num_frames=args.frames,
        frame_rate=args.fps,
        offload_to_cpu=False,
        negative_prompt="blurry, jittery, distorted, unstable geometry, text, logo",
        # LTX 0.9.8 distinguishes img2img media replacement from frame
        # conditioning. The first sampler step is 1.0, so media replacement
        # would be discarded and is correctly rejected upstream. A frame-0
        # conditioning item preserves the image while sampling from noise.
        conditioning_media_paths=[str(conditioning_image)],
        conditioning_strengths=[1.0],
        conditioning_start_frames=[0],
    ))
    generation_seconds = time.perf_counter() - started
    produced = sorted(set(output_dir.glob("*.mp4")) - before, key=lambda item: item.stat().st_mtime)
    if not produced:
        raise RuntimeError("LTX completed without producing an MP4 artifact")
    source_artifact = produced[-1]
    artifact = output_dir / "orangefive-ltxv-2b-proof.mp4"
    if source_artifact != artifact:
        shutil.copy2(source_artifact, artifact)

    video = inspect_video(artifact)
    if artifact.stat().st_size < 100_000 or not video["motion_proven"]:
        raise RuntimeError(f"video artifact failed motion proof: {video}")

    model_hashes = {name: sha256_file(model_path) for name, model_path in model_paths.items()}
    receipt = {
        "schema": "orange.captain_planet.video_artifact.v1",
        "status": "VIDEO_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "engine": "Lightricks/LTX-Video",
        "engine_commit": LTX_REPO_REVISION,
        "runner_sha256": sha256_file(Path(__file__).resolve()),
        "model": "Lightricks/LTX-Video ltxv-2b-0.9.8-distilled",
        "model_revision": LTX_REPO_REVISION,
        "text_encoder": "PixArt-alpha/PixArt-XL-2-1024-MS",
        "text_encoder_revision": PIXART_REPO_REVISION,
        "model_hashes": model_hashes,
        "device": f"xpu:0 {torch.xpu.get_device_name(0)}",
        "device_total_memory_gib": round(
            torch.xpu.get_device_properties(0).total_memory / (1024 ** 3), 3
        ),
        "seed": SEED,
        "prompt": PROMPT,
        "conditioning_image": str(conditioning_image),
        "conditioning_image_sha256": sha256_file(conditioning_image),
        "generation_seconds": round(generation_seconds, 3),
        "artifact_proven": True,
        "motion_proven": True,
        "studio_quality_proven": False,
        "quality_status": "PENDING_VISUAL_REVIEW_AND_VIDEO_QUALITY_BENCHMARK",
        "artifact": str(artifact),
        "artifact_bytes": artifact.stat().st_size,
        "artifact_sha256": sha256_file(artifact),
        "video": video,
        "xpu_boundary_patch": "device selector and seed only; model and sampler unchanged",
    }
    receipt_path = output_dir / "ltx-video-artifact-proof.json"
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
