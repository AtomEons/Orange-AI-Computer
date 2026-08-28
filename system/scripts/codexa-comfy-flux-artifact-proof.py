#!/usr/bin/env python3
"""Run one real FLUX.2 Klein image through ComfyUI on Codexa Intel XPU."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


MODEL_REVISIONS = {
    "black-forest-labs/FLUX.2-klein-4b-fp8": "5b4408e59397a4a37ccb46afe426d8ed86379441",
}
MODEL_FILES = {
    "diffusion_models/flux-2-klein-4b-fp8.safetensors": "97ed34fe0567e436200f2faee3939b88f2b5d99f8af2a4dc16532c4245c0ccb6",
    "text_encoders/qwen_3_4b.safetensors": "6c671498573ac2f7a5501502ccce8d2b08ea6ca2f661c458e708f36b36edfc5a",
    "vae/flux2-vae.safetensors": "d64f3a68e1cc4f9f4e29b6e0da38a0204fe9a49f2d4053f0ec1fa1ca02f9c4b5",
}
DEFAULT_SEED = 20260826
DEFAULT_PROMPT = (
    "A precision-engineered orange glass command instrument on a black technical workbench, "
    "machined aluminum controls, luminous amber data filaments, physically plausible studio "
    "lighting, premium industrial design photography, sharp material detail, no text, no logo"
)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def request_json(url: str, payload: dict | None = None, timeout: float = 30.0) -> dict:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method="POST" if body is not None else "GET",
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def wait_for_server(base_url: str, process: subprocess.Popen, timeout: float = 180.0) -> dict:
    deadline = time.monotonic() + timeout
    last_error = "not started"
    while time.monotonic() < deadline:
        if process.poll() is not None:
            raise RuntimeError(f"ComfyUI exited during startup with code {process.returncode}")
        try:
            return request_json(f"{base_url}/system_stats", timeout=5)
        except (OSError, urllib.error.URLError, json.JSONDecodeError) as exc:
            last_error = str(exc)
            time.sleep(1)
    raise TimeoutError(f"ComfyUI did not become ready: {last_error}")


def workflow(*, prompt: str, seed: int, width: int, height: int, filename_prefix: str) -> dict:
    return {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": "flux-2-klein-4b-fp8.safetensors", "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": "qwen_3_4b.safetensors", "type": "flux2", "device": "default"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": "flux2-vae.safetensors"}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": prompt}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {"clip": ["2", 0], "text": ""}},
        "6": {"class_type": "EmptyFlux2LatentImage", "inputs": {
            "width": width, "height": height, "batch_size": 1}},
        "7": {"class_type": "RandomNoise", "inputs": {"noise_seed": seed}},
        "8": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "euler"}},
        "9": {"class_type": "Flux2Scheduler", "inputs": {
            "steps": 4, "width": width, "height": height}},
        "10": {"class_type": "CFGGuider", "inputs": {
            "model": ["1", 0], "positive": ["4", 0], "negative": ["5", 0], "cfg": 1.0}},
        "11": {"class_type": "SamplerCustomAdvanced", "inputs": {
            "noise": ["7", 0], "guider": ["10", 0], "sampler": ["8", 0],
            "sigmas": ["9", 0], "latent_image": ["6", 0]}},
        "12": {"class_type": "VAEDecode", "inputs": {"samples": ["11", 0], "vae": ["3", 0]}},
        "13": {"class_type": "SaveImage", "inputs": {
            "images": ["12", 0], "filename_prefix": filename_prefix}},
    }


def wait_for_artifact(base_url: str, prompt_id: str, output_root: Path, timeout: float = 900.0) -> Path:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        history = request_json(f"{base_url}/history/{prompt_id}", timeout=10)
        run = history.get(prompt_id)
        if run:
            status = run.get("status", {})
            if status.get("status_str") == "error":
                raise RuntimeError(f"ComfyUI workflow failed: {json.dumps(status)}")
            outputs = run.get("outputs", {})
            images = outputs.get("13", {}).get("images", [])
            if images:
                item = images[0]
                artifact = output_root / item.get("subfolder", "") / item["filename"]
                if artifact.is_file():
                    return artifact.resolve()
        time.sleep(1)
    raise TimeoutError("ComfyUI workflow did not produce an image")


def image_statistics(path: Path) -> dict:
    from PIL import Image, ImageStat

    with Image.open(path) as image:
        rgb = image.convert("RGB")
        stat = ImageStat.Stat(rgb)
        extrema = rgb.getextrema()
        entropy = float(rgb.entropy())
        return {
            "format": image.format,
            "width": rgb.width,
            "height": rgb.height,
            "mean_rgb": [round(float(value), 3) for value in stat.mean],
            "stddev_rgb": [round(float(value), 3) for value in stat.stddev],
            "extrema_rgb": extrema,
            "entropy": round(entropy, 4),
            "nonblank": entropy > 3.0 and max(stat.stddev) > 10.0,
        }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", required=True)
    parser.add_argument("--output-dir", required=True)
    parser.add_argument("--port", type=int, default=8191)
    parser.add_argument("--prompt", default=DEFAULT_PROMPT)
    parser.add_argument(
        "--prompt-file",
        help="UTF-8 prompt file. Preferred for remote runs because it avoids shell quoting drift.",
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument("--width", type=int, default=1024)
    parser.add_argument("--height", type=int, default=1024)
    parser.add_argument("--artifact-name", default="orangefive-flux2-klein-proof.png")
    parser.add_argument("--filename-prefix", default="OrangeFive/flux2-klein-proof")
    parser.add_argument("--receipt-name", default="flux2-image-artifact-proof.json")
    args = parser.parse_args()

    prompt = args.prompt
    if args.prompt_file:
        prompt_path = Path(args.prompt_file).resolve()
        if not prompt_path.is_file():
            raise FileNotFoundError(f"prompt file not found: {prompt_path}")
        prompt = prompt_path.read_text(encoding="utf-8").strip()
        if not prompt:
            raise ValueError(f"prompt file is empty: {prompt_path}")

    project_root = Path(args.project_root).resolve()
    model_root = project_root / "models"
    output_dir = Path(args.output_dir).resolve()
    output_dir.mkdir(parents=True, exist_ok=True)
    for relative, expected_hash in MODEL_FILES.items():
        model_path = model_root / relative
        if not model_path.is_file():
            raise FileNotFoundError(f"missing model component: {model_path}")
        actual_hash = sha256_file(model_path)
        if actual_hash != expected_hash:
            raise RuntimeError(f"model hash mismatch for {relative}: {actual_hash}")

    python = project_root / ".venv" / "Scripts" / "python.exe"
    if not python.is_file():
        raise FileNotFoundError(python)
    log_path = output_dir / "comfyui-flux2-proof.log"
    base_url = f"http://127.0.0.1:{args.port}"
    creation_flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    started = time.perf_counter()
    with log_path.open("wb") as log:
        process = subprocess.Popen(
            [
                str(python), str(project_root / "main.py"),
                "--listen", "127.0.0.1", "--port", str(args.port),
                "--disable-auto-launch", "--output-directory", str(output_dir),
            ],
            cwd=project_root,
            stdout=log,
            stderr=subprocess.STDOUT,
            creationflags=creation_flags,
        )
        try:
            stats = wait_for_server(base_url, process)
            startup_seconds = time.perf_counter() - started
            generation_started = time.perf_counter()
            queued = request_json(f"{base_url}/prompt", {"prompt": workflow(
                prompt=prompt,
                seed=args.seed,
                width=args.width,
                height=args.height,
                filename_prefix=args.filename_prefix,
            )}, timeout=30)
            prompt_id = queued["prompt_id"]
            produced = wait_for_artifact(base_url, prompt_id, output_dir)
            generation_seconds = time.perf_counter() - generation_started
        finally:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

    artifact = output_dir / args.artifact_name
    if produced != artifact:
        artifact.write_bytes(produced.read_bytes())
    pixels = image_statistics(artifact)
    if not pixels["nonblank"] or pixels["width"] != args.width or pixels["height"] != args.height:
        raise RuntimeError(f"generated image failed deterministic pixel proof: {pixels}")

    device = None
    devices = stats.get("devices", []) if isinstance(stats, dict) else []
    if devices:
        device = devices[0].get("name") or devices[0].get("type")
    try:
        comfy_commit = subprocess.check_output(
            ["git", "-C", str(project_root), "rev-parse", "HEAD"], text=True
        ).strip()
    except (OSError, subprocess.CalledProcessError):
        comfy_commit = None
    receipt = {
        "schema": "orange.captain_planet.image_artifact.v1",
        "status": "IMAGE_ARTIFACT_RUNTIME_PROVEN_QUALITY_UNASSESSED",
        "created_at": datetime.now(timezone.utc).isoformat(),
        "engine": "ComfyUI",
        "engine_commit": comfy_commit,
        "runner_sha256": sha256_file(Path(__file__).resolve()),
        "model": "black-forest-labs/FLUX.2-klein-4b-fp8",
        "model_revisions": MODEL_REVISIONS,
        "model_hashes": MODEL_FILES,
        "device": device,
        "workflow": "flux2-klein-distilled-4-step-fixed-seed",
        "seed": args.seed,
        "prompt": prompt,
        "startup_seconds": round(startup_seconds, 3),
        "generation_seconds": round(generation_seconds, 3),
        "artifact_proven": True,
        "studio_quality_proven": False,
        "quality_status": "PENDING_VISUAL_REVIEW_AND_IMAGE_QUALITY_BENCHMARK",
        "artifact": str(artifact),
        "artifact_bytes": artifact.stat().st_size,
        "artifact_sha256": sha256_file(artifact),
        "pixels": pixels,
        "log": str(log_path),
    }
    receipt_path = output_dir / args.receipt_name
    receipt_path.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(receipt, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
