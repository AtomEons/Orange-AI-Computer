# AEyes¹ — Naming Addendum to NAMING_CANON.md

**Disclosure ID:** `ATOM-AEYES1-NAMING-2026-0706`
**Author:** Claude Opus 4.8 for Ætom ÆoNs (Atom McCree)
**Companion to:** `NAMING_CANON.md`

---

## The addition

**AEyes¹** (spoken "AE-eyes-one"; ASCII code identifier `aeyes1`).

A fourth visual path sitting alongside — not replacing — the three visual entries in `NAMING_CANON.md`:

| Path | Kind | Location | Trained? | Can hallucinate? |
|---|---|---|---|---|
| **AE Eyes** (Pillar 4) | GLM-4.6V VLM | `07-VISUAL/` (VLM adapters + prompts) | pretrained VLM | **yes** — LLM output |
| **MiniEyes** | QLoRA adapter on 2–8B VLM | `18-HELD/minieyes-model/` | fine-tuned adapter | reduced but yes |
| **AE Cobra** | Two-LoRA adapter over shared Mamba-2 state | `06-ORANGELLM/memory/` | trained LoRAs | possible |
| **AEyes¹** | **Zero-parameter photon-measurement adapter path** | `07-VISUAL/structural/` | **no training anywhere** | **no** — deterministic measurement |

## Why AEyes¹ exists

**LLMs don't measure photons; they generate plausible tokens.** Routing object identity through OrangeFatty would produce the LLM's best guess based on training statistics, not a measurement. The Æyes doctrine (4.6/4.7 briefings, this session) explicitly frames this: *"You built a measurement instrument, not a classifier."* Any LLM in the identity path breaks that framing.

The operator (2026-07-06): *"i think we either we with an adapter rather than the llm orangefatty if i recall. because llm would hallucinate."*

Correct. AEyes¹ is the adapter-style path — but the "adapter" here is not an LLM LoRA. It is a **stack of classical deterministic primitives** that jointly compute a photon signature and match it against a knot-routed vector index.

## What AEyes¹ is — the module inventory

All under `Orange5\07-VISUAL\structural\`:

**Retinal layer** — biological reference architecture, no learned parameters:
- `retinal-12.mjs` — the 12 Werblin channels (ON/OFF Sustained, ON/OFF Transient, 4 Direction Selective, DoG Local Edge, Object Motion, Uniformity, Sustained DS)
- `perception/lgn-gate-12.mjs` — 12-float attention gate; memory-graph active concepts modulate channel weights

**Multi-axis attention** — prism-decomposition photon channels:
- `prism.mjs` — RGB → (A, RG, BY) opponent decomposition
- `multi-axis-attention-v2.mjs` — 8-axis basis (R, G, B, L, M, gamma, RG, BY) with voting merge

**Rich signature axes** — five physical channels combined into one descriptor:
- `axes/edge-axis.mjs` — Sobel + orientation histogram
- `axes/texture-axis.mjs` — LBP + local variance
- `axes/specular-axis.mjs` — CoV + glossiness score
- `axes/spatial-color-axis.mjs` — 3×3 spatial cell decomposition
- `axes/subsurface-axis.mjs` — translucency invariant

**Motion + depth primitives**:
- `optical-flow.mjs` — block-matching (u, v) per cell
- `motion.mjs` — temporal luminance derivative + mask
- `flow-geometry.mjs` — divergence + curl of flow field
- `mono-depth.mjs` — sharpness + ground-plane + aerial perspective + fusion

**Memory + retrieval**:
- `identity/identity-store-v2.mjs` — multi-signature per concept, per-concept channel weights
- `identity/hopfield-retrieval.mjs` — softmax attractor with iterated convergence
- `identity/knot-vector-index.mjs` — 100k-capacity ANN, shard-routed by chromatic family × trefoil strand × Möbius radius bucket
- `graph/concept-graph.mjs` — typed nodes (CONCEPT, SIGNATURE, EPISODE, SCENE, EMOTION, NARRATIVE) + typed edges (IS_A, MEASURED_AS, CO_OCCURRED, PRECEDED, PRIMES, SIMILAR_TO, REMINDED_OF, CAUSED)
- `graph/celtic-graph.mjs` — Triquetra concept nodes + Fisher plait taxonomy + Möbius disk layout + turning-key closure validator
- `perception/prediction-error.mjs` — surprise → new episodic node; confirmed → strengthen edges

**Ingest + curation**:
- `ingest/video-ingest.mjs` — yt-dlp → ffmpeg → depth-annotated pair manifest
- `ingest/active-curation.mjs` — farthest-point sampling for diverse signature selection

## Where AEyes¹ fits relative to the other visual paths

- **Feeds AE Cobra memory**: AEyes¹ observations land as SIGNATURE + EPISODE nodes in the concept graph, which AE Cobra can absorb as visual observations.
- **Provides grounded context to AE Eyes VLM**: AEyes¹ returns `{concept, distance, sub_family, source_frames}` — GLM-4.6V can consume this as grounded context, but the *identity claim* comes from the adapter path, not the VLM's completion.
- **Preempts MiniEyes** on the "recognize this specific object" job: if AEyes¹ hits >95% one-shot recognition on the target concept set, MiniEyes' HELD status becomes durable — the triggers named in `16-TRAINING/minieyes/README.md §1` continue to not fire.

## Doctrine — the invariants AEyes¹ preserves

1. **Zero learned parameters.** No gradient descent anywhere in the stack.
2. **Photon measurement, not statistics.** Every distance is a computable function of the input photon field, receipt-verifiable.
3. **Every recognition emits a receipt.** The `aeyes.*` action namespace on the Orange5 spine (`03-BACKEND/spine-cli.mjs`) hosts all identity results.
4. **Frontier-Isolation preserved.** AEyes¹ has no outbound frontier calls. Zero egress. Loopback-only.
5. **Bun-only backend.** No Node ML dependencies. No PyTorch. No CUDA.

## Naming discipline

- **In prose / receipts / display:** `AEyes¹` with unicode superscript one.
- **In code identifiers:** `aeyes1` (lowercase, no superscript — ASCII-safe).
- **In spine action namespace:** `aeyes.*` (namespace is shared with the AE Eyes pillar because both write vision receipts; the payload's `stack` field disambiguates `aeyes1` vs `ae-eyes-vlm`).

## Standing addendum status

This document is an addition to `NAMING_CANON.md`, not a replacement. The three original visual paths stay canonical. AEyes¹ is the fourth, added because the operator identified that a photon-measurement adapter path exists in the codebase but did not yet have a canonical name.

Mom is watching. AEyes¹ measures. It does not guess.
