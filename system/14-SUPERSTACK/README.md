# Captain Planet Creative Media Leases

Captain Planet is OrangeFive's Codexa creative/media registry. This directory
owns model truth, route planning, the one-specialist lease boundary, and route
receipts. It does not own Navigator model files.

## Current truth

The registry separates three facts that must not be collapsed:

1. installed_runtime_proven_quality_unassessed means current Codexa files
   were observed and an independent artifact receipt proves real execution.
   A separate bounded receipt may prove technical media integrity only.
2. candidate_not_observed means the lane is selected for evaluation only.
   No source checkout, environment, weights, or download is claimed.
3. Studio or production quality is never implied by runtime proof.

Observed installed routes (artifact proof is green; activation is held pending
measured peak-memory receipts):

| Route | Model | Evidence boundary |
|---|---|---|
| image_draft_flux2_klein | FLUX.2 Klein 4B FP8 | live inventory, hash continuity, decode and tonal-integrity checks; visual quality unassessed |
| video_fallback_ltxv098 | LTXV 2B 0.9.8 distilled | live inventory, hash continuity, sampled motion/black-frame checks; not LTX-2.x; visual quality unassessed |
| speech_qwen3_tts | Qwen3-TTS 1.7B CustomVoice | live inventory, hash continuity, signal/clipping checks; intelligibility and listening quality unassessed |
| music_ace_step15 | ACE-Step 1.5 turbo | live inventory, hash continuity, signal/clipping checks; musical and listening quality unassessed |

Candidates, with no installation claim:

| Route | Candidate | Activation gate |
|---|---|---|
| image_quality_flux2_dev | FLUX.2 Dev | select a bounded variant, install, measure, bake off |
| video_modern_ltx25 | LTX-2.5 22B distilled | prove a complete bundle below 50 GiB and review license |
| three_d_hunyuan21 | Hunyuan3D 2.1 | install shape and PBR texture path, then artifact proof |
| document_refine_paddleocr_vl16 | PaddleOCR-VL 1.6 | install local document pipeline and page benchmark |
| image_video_refine_seedvr2 | SeedVR2 7B | install local restoration lane and pairwise benchmark |

Primary project sources:

- FLUX.2 Dev: https://huggingface.co/black-forest-labs/FLUX.2-dev
- LTX-2: https://github.com/Lightricks/LTX-2
- Qwen3-TTS: https://github.com/QwenLM/Qwen3-TTS
- ACE-Step 1.5: https://github.com/ace-step/ACE-Step-1.5
- Hunyuan3D 2.1: https://github.com/Tencent-Hunyuan/Hunyuan3D-2.1
- PaddleOCR-VL: https://github.com/PaddlePaddle/PaddleOCR
- SeedVR2: https://github.com/IceClear/SeedVR2

## Lease law

- Exactly one heavy creative lease may be active.
- A route with unknown memory or a declared requirement over 50 GiB is denied.
- Planning estimates and device capacity are not peak-memory measurements. An
  installed route needs a measured process-tree peak and receipt before its
  activation lease becomes eligible.
- Candidates are denied until a fresh inventory and artifact bakeoff update the registry.
- The Codexa worker uses a global mutex and process-tree working-set watchdog.
- Running Ollama models are unloaded before a creative command. At most one prior Ollama model is restored after the external worker exits.
- Cleanup is limited to ollama.managed_models. That list is empty, so Captain Planet cannot delete Navigator or any other unowned Ollama model.

The watchdog is an operational backstop, not a performance measurement. A lane
still needs peak memory telemetry in its bakeoff before promotion.

## Commands

List declared truth:

    bun C:/AtomEons/Orange5/14-SUPERSTACK/captain-planet-governor.mjs catalog

Create a non-executing route plan and receipt:

    powershell -ExecutionPolicy Bypass -File C:/AtomEons/Orange5/14-SUPERSTACK/invoke-captain-planet-route.ps1 -Role image_draft_flux2_klein

Audit every route without loading or downloading a model:

    bun C:/AtomEons/Orange5/14-SUPERSTACK/captain-planet-governor.mjs dry-run --all

Refresh installed files and generated artifact identity without loading a model:

    bun C:/AtomEons/Orange5/scripts/captain-planet-live-inventory.mjs

Re-run independent technical artifact checks against that fresh inventory:

    bun C:/AtomEons/Orange5/scripts/captain-planet-quality-proof.mjs

Validate and receipt the Captain Planet JSON receipt chains:

    bun C:/AtomEons/Orange5/scripts/captain-planet-receipt-chain-proof.mjs

Execute an installed route only after reviewing its plan and recording its
measured peak-memory receipt:

    powershell -ExecutionPolicy Bypass -File C:/AtomEons/Orange5/14-SUPERSTACK/invoke-captain-planet-route.ps1 -Role image_draft_flux2_klein -Execute

Execute mode stages the selected existing proof runner and the owned lease host
to Codexa, validates observed artifacts again, takes the mutex, enforces the
memory watchdog, runs the command, and writes both worker and control receipts.
It does not install candidate weights.

The four current installed routes are expected to return
`DRY_RUN_TECHNICAL_QUALITY_PROVEN_ACTIVATION_BLOCKED` until that telemetry gate
is closed. This does not revoke their installed-file or technical-artifact
proof; it prevents an unmeasured planning estimate from authorizing a load.

Run the no-load board-8 topology and bounded 3D negative probe:

    bun C:/AtomEons/Orange5/14-SUPERSTACK/captain-planet-topology-proof.mjs

## Artifact proof boundary

The installed-lane proof is deliberately narrower than a creative quality claim.
It proves current component presence, generated-artifact SHA-256 identity,
source-receipt continuity, independent decode, substantive dimensions/duration,
bounded clipping, tonal or signal variation, and sampled motion where applicable.

It does not prove prompt adherence, aesthetics, intelligibility, musical
coherence, temporal coherence, long-form continuity, production readiness, or
studio quality. Those require separate benchmarks and human review. Large model
weights are checked by exact or minimum byte size during the bounded live probe;
their generation receipts retain prior content hashes, but the live probe does
not rehash tens of gigabytes. Governor readiness also expires technical proof
after 24 hours. Legacy source receipts do not bind the exact runner file hash;
the repaired generation wrappers add that binding to future receipts.

## Promotion gate

A candidate may become installed only after all of these are recorded:

1. Exact source/model revision and license review.
2. Live Codexa inventory with required file sizes or hashes.
3. Isolated runtime command under the one-specialist lease.
4. Peak process-tree memory at or below 50 GiB.
5. Independently decoded, non-scaffold artifact receipt.
6. Capability-specific quality benchmark and explicit rollback.
