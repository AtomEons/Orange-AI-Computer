# OrangeFive FLUX.2 Quality System

**Decision:** FLUX.2 remains OrangeFive's sovereign image engine.  
**Current tier:** `FLUX.2-klein-4b-fp8` through ComfyUI on Codexa Intel Arc 140T XPU.  
**Current status:** runtime and artifact proof passed; studio-quality promotion has not passed.  
**Future compatibility:** FLUX.3 may challenge a capability slot after open weights exist and a receipt-backed bakeoff beats the FLUX.2 incumbent.

## Why FLUX.2 Stays

- The installed 4B model is Apache 2.0 and locally controllable.
- It runs on the existing Codexa XPU path without an API.
- It supports generation, image editing, and multi-reference editing in one family.
- The distilled model is suitable for rapid candidate generation.
- FLUX.2 Base and Dev provide higher-flexibility and higher-quality tiers without replacing the interface contract.
- The present weakness is the one-pass workflow, not proof that the FLUX family is wrong.

## Current Proven Baseline

| Property | Result |
|---|---|
| Engine | ComfyUI commit `a25c7bf2b8c7408d8724f4245dbe09d95992e3a1` |
| Model | `black-forest-labs/FLUX.2-klein-4b-fp8` |
| Device | Intel Arc 140T XPU, 48 GB shared GPU memory reported |
| Workflow | four-step distilled, deterministic seed |
| Original generation | `34.862 s`, 1280x768, hash proven |
| Refined-prompt generation | `36.006 s`, 1280x768, hash proven |
| Runtime verdict | proven |
| Studio-quality verdict | not proven |

Primary receipts:

- `10-RECEIPTS/orange5-build/captain-planet/flux2/orangefive-technical-manual-cover-receipt.json`
- `10-RECEIPTS/orange5-build/captain-planet/flux2/flux2-refined-image-proof.json`

## What The Two Local Runs Taught Us

The first run produced a stronger compression-lattice concept but invented extensive pseudo-text. The refined prompt removed the document wall and simplified the scene, yet text-like markings remained on the hardware and composition became flatter. This falsifies the idea that a longer negative phrase alone can reach final quality.

Prompting remains useful, but quality needs a controlled multi-pass system.

## Five Optimization Tools Around FLUX.2

### 1. FLUX.2 Klein Distilled Candidate Generator

Keep the current 4B four-step model as the rapid ideation tier.

Required upgrades:

- generate 4-8 deterministic seeds per brief;
- save every prompt, seed, model hash, latency, and artifact hash;
- reject blank, corrupt, and obvious text-leak candidates;
- do not upscale every candidate.

### 2. FLUX.2 Base Or Dev Finalizer

Use the same FLUX family for the selected final composition.

- `FLUX.2 Klein 4B Base` is the first hardware-fit challenger because it keeps the Apache 2.0 family and replaces four-step distillation with a flexible approximately 50-step path.
- `FLUX.2 Dev` is the maximum-quality challenger, but its 32B size and non-commercial license require a Codexa resource and distribution review.
- Official guidance identifies Klein for real-time use, Base for flexibility/fine-tuning, and Dev for maximum quality.

Promotion requires an identical-brief A/B test, peak shared-memory measurement, latency, prompt adherence, and operator visual choice.

### 3. Native FLUX.2 Edit And Multi-Reference Pass

Do not regenerate the entire scene to repair one defect.

- Feed the selected candidate back into FLUX.2 image editing.
- Use a clean sketch or reference for exact two-device placement.
- Use a separate reference for material and lighting.
- Remove pseudo-text, duplicated controls, malformed ports, and irrelevant layers by local edit.
- Preserve the accepted geometry between passes.

ComfyUI's official FLUX.2 Klein guide includes distilled and Base image-edit workflows. FLUX.2 Dev supports multi-reference consistency and higher-resolution photorealism.

### 4. Deterministic Rejection And VisionReward Ranking

The system must reject defects before asking a human to review.

Gate each candidate on:

- OCR or text-region detection when the brief forbids text;
- prompt-object coverage;
- duplicate-object count;
- edge clipping and malformed aspect ratio;
- image entropy/nonblank proof;
- visual reward score;
- comparison with the incumbent candidate.

VisionReward is the preferred open scorer for image and video ranking. It is an advisor, not final truth. Human review remains the promotion authority for premium work.

### 5. SeedVR2 Restoration After Approval

Restoration is the final pass, not the design engine.

- Run it only after composition and semantics pass.
- Compare restored and original output for identity and geometry drift.
- Record output dimensions, runtime, peak memory, and hashes.
- Reject oversharpening, invented texture, and temporal instability.

SeedVR2 provides a one-step image/video restoration path under Apache 2.0. It can improve final texture and resolution but cannot rescue a bad concept.

## Separate Motion Lane

LTX-2 remains the controlled motion/audio lane for turning an accepted FLUX.2 key image into video. It does not replace FLUX.2. It consumes the approved image and adds governed motion, keyframes, camera logic, and synchronized sound.

The correct handoff is:

```text
FLUX.2 approved image
-> LTX-2 image-to-video
-> visual/motion quality gate
-> SeedVR2 restoration
-> artifact receipt
```

## FLUX.3 Upgrade Law

FLUX.3 is a future challenger, not an assumed dependency.

Orange exposes stable capability slots:

```text
image.generate.preview
image.generate.final
image.edit
image.rank
image.restore
```

FLUX.3 may enter a slot only when:

1. open weights and an acceptable license exist;
2. it runs on the available hardware or a bounded remote lease;
3. the exact Orange prompt suite is tested;
4. peak memory remains under the 50 GB live-model ceiling;
5. quality beats FLUX.2 by operator review and deterministic metrics;
6. a rollback path preserves the FLUX.2 incumbent.

No application, MCP, or agent interface should need to change when a model slot changes.

## Reproducible Remote Prompting

The proof runner now supports `--prompt-file`. This avoids Windows/SSH shell quoting drift and turns prompts into versioned assets.

```powershell
python scripts/codexa-comfy-flux-artifact-proof.py `
  --project-root C:/AtomEons/ai-box/creative/ComfyUI `
  --output-dir C:/AtomEons/ai-box/receipts/captain-planet/artifacts/run `
  --prompt-file C:/AtomEons/ai-box/creative/flux-manual-cover-refined.txt `
  --seed 20260828 `
  --width 1280 `
  --height 768
```

Prompt source:

`14-SUPERSTACK/prompts/flux-manual-cover-refined.txt`

## Benchmark Suite Required For Promotion

Use at least 25 briefs across:

- product hero photography;
- technical systems diagram without text;
- readable poster typography;
- people and hands;
- interior architecture;
- precise branded color;
- multi-reference product consistency;
- image edit and object removal;
- wide, square, portrait, and 4MP output;
- FLUX image to LTX motion handoff.

For each candidate record:

- model/version/hash/license;
- workflow JSON/hash;
- prompt and references;
- seed;
- generation and edit latency;
- peak system and shared GPU memory;
- artifact hash;
- OCR violations;
- prompt-adherence and reward scores;
- human pairwise choice;
- failure reason.

Do not claim Midjourney- or Seedance-class quality until the broad suite and human A/B review pass.

## Primary Sources

- FLUX.2 official repository: https://github.com/black-forest-labs/flux2
- Official ComfyUI FLUX.2 Klein guide: https://docs.comfy.org/tutorials/flux/flux-2-klein
- Official ComfyUI FLUX.2 Dev guide: https://docs.comfy.org/tutorials/flux/flux-2-dev
- VisionReward organization repository: https://github.com/zai-org/VisionReward
- SeedVR2: https://github.com/IceClear/SeedVR2
- LTX-2: https://github.com/Lightricks/LTX-2
- PyTorch XPU guidance: https://github.com/pytorch/pytorch/blob/main/docs/source/notes/get_start_xpu.md

