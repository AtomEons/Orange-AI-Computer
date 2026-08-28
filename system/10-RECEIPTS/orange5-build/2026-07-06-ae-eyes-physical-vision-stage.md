# Receipt — AE Eyes: physical vision stage (M1 · M2 · M3 · photoreceptor)

**Date:** 2026-07-06 · **By:** Claude Fable 5 · **Verifier:** `bun run verify` → **89 green / 0 red of 89**

## Result
AE Eyes gets a *physically real* front-end. Not a metaphor. Not a decorated pixel pipeline. Two deterministic extractors — codec-domain (Path 1) and retinal-domain (Path 2) — compile any visual input into the same `ae.structural-tokens.v1` contract. The retinal path now runs the four fields on **R(x,y,t)** (post-photoreceptor Naka-Rushton response with temporal adaptation), not raw luminance L.

## What shipped this session (all backend, Bun, additive, no paid deps)

### M1 — the API contract both paths satisfy
- [`09-SCHEMAS/ae-structural-tokens.v1.schema.json`](../../09-SCHEMAS/ae-structural-tokens.v1.schema.json) — schema id `ae.structural-tokens.v1`, additive to `orange.order.v1` / `orange.report.v1` lineage.
- [`07-VISUAL/AE_STRUCTURAL_TOKENS_v1.md`](../../07-VISUAL/AE_STRUCTURAL_TOKENS_v1.md) — design doctrine, both paths' logic, anti-drift rules.

### M2 — codec translator (Path 1), 7/7 green
- [`07-VISUAL/structural/codec-translator.mjs`](../../07-VISUAL/structural/codec-translator.mjs) — ffmpeg 8.1.2, motion vectors + block modes + I/P/B structure + scene cuts → structural tokens. Deterministic. No neural inference.
- [`06-ORANGELLM/server/routes/visual-structure.mjs`](../../06-ORANGELLM/server/routes/visual-structure.mjs) + gateway `POST /v1/visual/structure` (multipart video). Returns tokens; honest `501 FFMPEG_UNAVAILABLE` when ffmpeg missing.
- Fixtures: `07-VISUAL/fixtures/testsrc-2s-320x240.mp4` + `cutmix-2s-320x240.mp4`. 2 entities detected across a real scene cut at 1000 ms.

### M3 — retinal transform (Path 2, raw-L baseline), 9/9 green
- [`07-VISUAL/structural/retinal-transform.mjs`](../../07-VISUAL/structural/retinal-transform.mjs) — four fields (∇L Sobel, ∂L/∂t frame-diff, log(L+1/255), block-matched motion correlation), entity clustering, texture vocabulary (≤64 signatures).
- [`07-VISUAL/structural/luminance-ffmpeg.mjs`](../../07-VISUAL/structural/luminance-ffmpeg.mjs) — image/video → Y-channel Float32.
- Gateway `POST /v1/visual/retinal` (JSON raw_luminance OR multipart via ffmpeg). Same 501 honest-fail on missing ffmpeg.
- Entities detected on checkerboard-still (2 entities, 5 texture codes) and shifting-square sequence (motion coherence 0.791).

### Photoreceptor stage — the physics between photons and fields, 10/10 green
- [`07-VISUAL/structural/photoreceptor.mjs`](../../07-VISUAL/structural/photoreceptor.mjs) — **Naka-Rushton response with temporal adaptation.** `R = L^n / (L^n + K^n)`, K(t) exponentially tracks mean L with τ≈250ms. Pure JS, byte-deterministic, no deps.
- Tests prove: Michaelis identity (R=0.5 at L=K), monotonic response, **Weber-invariance across three background levels (K=0.10, 0.50, 0.80 → R=0.6 identically for +50% contrast)**, adaptation converges to mean over 5τ, saturation flagged honestly, `honestNotes()` surfaces real physical limits.

### Physical retinal transform (photoreceptor + M3 composed), 6/6 green
- [`07-VISUAL/structural/physical-retinal-transform.mjs`](../../07-VISUAL/structural/physical-retinal-transform.mjs) — non-destructive wrapper. Runs photoreceptor first, feeds R (not L) into M3's transform. Threads adaptation state across frames. Extends `provenance.translator_version` with `+photoreceptor.v1`.
- **Proven distinct from raw-L path:** on the same checkerboard input, raw path gives `gradient_energy_mean=0.9954`, wired path gives `0.5101`. The physics is doing real work.
- Adaptation state threads across 5 frames: K advances 0.1800 → 0.1633.

## Evidence
- `bun run verify` → **89/89 green** (up from 87 at M3's landing — the two new photoreceptor test suites landed and are auto-discovered).
- Every existing test still green (Sobel, motion correlation, codec translator, spine, learning loop, all pillar tests).
- Every new record satisfies the schema and carries a non-empty `notes[]` disclosing what the extractor could NOT see.

## Honest limits held in front (Mom's Law channel)
- **Single-image path has no ∂L/∂t** — disclosed in every still record's `notes[]`.
- **Adaptation cannot advance without `dt`** — disclosed when `lastTsMs==null`.
- **Codec path inherits its codec's blind spots** — fast motion at cuts, texture under masking, fine detail below flicker fusion. Each record `notes[]` lists them for the actual source.
- **The saturating-flash test is dark-adapted-eye physics** (K0=0.005), not a bug. Bright uniform field at default K0=0.18 gives R≈0.85 — not saturating — which is realistic.
- **AE Eyes end-to-end visual smoke** (the ingest → query → describe → mirage-recall pipeline Codex's `07-VISUAL/smoke-test.mjs` runs) still needs the gateway's `POST /v1/visual/ingest`, `/query`, `/describe` routes wired to a live vision model on Codexa. My work adds `/v1/visual/structure` and `/v1/visual/retinal` — new, orthogonal — but does NOT close that older visual pipeline.

## Blockers (only Atom can close)
- **GLM-4.6V-Flash on Codexa** — the pull command is ready in chat (`ollama run hf.co/unsloth/GLM-4.6V-Flash-GGUF:UD-Q4_K_XL`) but requires Codexa shell access. The dev box cannot reach codexa.local ports (probed — all closed to the network; services likely bound loopback-only on Codexa).
- Wiring the older `/v1/visual/ingest|query|describe` routes to whichever vision model is live (llava:7b now, GLM-4.6V-Flash when it lands).

## What is now durably true about AE Eyes
1. There is a substrate-invariant token contract (`ae.structural-tokens.v1`) that both extractors satisfy.
2. There is a codec-domain translator (Path 1) that unlocks any encoded video ffmpeg can decode.
3. There is a retinal-domain transform (Path 2) with a physically-real Naka-Rushton front-end and temporal adaptation — Weber-invariant, deterministic, byte-exact.
4. Both paths ship honest `notes[]` disclosing what they could NOT see.
5. Both paths have gateway routes and pass integration tests against a spawned gateway subprocess.

## Next action (not this session)
Where the physical vision stage now points, when Atom is ready:
- **Rosetta layer** — mapping stable attractors in the derivative field to world-model tokens the reasoning layer consumes. The schema already has the slots (`entities[]`, `texture_vocabulary[]`); building the mapping deserves a supervised session, not an unsupervised burst.
- **Bind the structural tokens into the spine** — feed `ae.structural-tokens.v1` records into AE Cobra memory (as recallable structural observations, not just captions), and into the AtomSmasher sieve as a first-class compressible object.

Mom is watching. The system holds.
