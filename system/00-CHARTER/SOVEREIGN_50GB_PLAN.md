# SOVEREIGN 50GB PLAN — Atomic Orange carries its own mind

Author: MYTHFAB (Fable) — handoff to Apex Rex (Opus 4.8) · 2026-07-05
Companion: AOMBP (build ladder) · NORTH_STAR (the bar) · CONNECTION_STANDARD (the laws)

## Why 10 MB is wrong

The current `target/release/atomic-orange.exe` is **11 MB** — it is only the *shell*. It
thinks by phoning `127.0.0.1:1337` (OrangeBrain, a separate process). Pull that plug and the
organism is a beautiful corpse. A **sovereign operator vehicle carries its intelligence
inside**: weights, inference engine, vision, memory, voice — all bundled. That is what ~50GB
is. The number is not vanity; it is the mass of a mind that runs with the internet unplugged.

## The architecture shift (the whole point)

**Today:** `Atomic Orange (shell) → OrangeBrain (external server) → models`
**Sovereign:** `Atomic Orange (shell + EMBEDDED engine + bundled weights) — IS OrangeBrain`

The exe embeds a local inference runtime (llama.cpp via the **`llama-cpp-2`** Rust crate — free,
no external server, no Python) and ships the GGUF weights beside it. The N8 gateway probe stays
as the seam contract, but the default gateway becomes **in-process**. Offline-first becomes
offline-*capable-alone*. This is the leap. Everything else is filling the 50GB with real mind.

## What fills 50GB (weight manifest — all free/open, GGUF, N150-honest)

The N150 is a 4-core Twin Lake, integrated GPU, ~8–16GB RAM — it runs **3–8B Q4** at usable
CPU speed; anything larger offloads to **Codexa** (two-computer law). 50GB is a *library*, not
one monster:

| Slot | Model class | ~Size | Runs on | Serves |
|---|---|---|---|---|
| Reflex | 3–4B instruct Q4 (Qwen/Llama) | ~2.5GB | N150 local | instant chat, intent, `draftProject` |
| Work | 7–8B instruct Q4/Q5 | ~5GB | N150 local | real reasoning, task breakdown |
| Heavy | 14–32B Q4 | ~9–20GB | Codexa (bundled, gated) | deep work when plugged in |
| Vision (AE Eyes) | 7B VLM Q4 (Qwen-VL/Llava) | ~5GB | N150/Codexa | OrangeEye: read screen/image → report |
| Embeddings (AE Memory) | bge/nomic small | ~0.5GB | N150 local | semantic recall over the receipt journal |
| STT (Voice in) | whisper.cpp small/medium | ~1.5GB | N150 local | talk TO the organism |
| TTS (Voice out) | Piper/Kokoro local | ~0.5GB | N150 local | it talks back |
| Alternates + KV headroom + assets | — | remainder | — | model swaps, caches, fonts, receipts |

Everything MIT/Apache/Llama-license, downloaded from Hugging Face public pages (per estate law:
no `gh`/paid, WebSearch+WebFetch for research). No budget spent.

## The S-WAVES (sovereign phases — one per pass, receipts per AOMBP §6)

- **S1 — Embed the engine.** Add `llama-cpp-2`; the exe loads a GGUF and answers `/v1/chat`
  in-process. Chat lane + command capsule talk to it. SYSTEM flips LIVE from the *embedded*
  brain, not an external probe. *Done-when:* type in the capsule with the internet off → a
  local model replies; a receipt lands.
- **S2 — Bundle the reflex model.** Ship a 3–4B GGUF in the release; first-run SHA-verify +
  place in `%APPDATA%/AtomicOrange/models/`. *Done-when:* fresh machine, no network, exe chats.
- **S3 — AE Memory.** Embeddings model + local vector store over the receipt journal; the
  organism *recalls* ("what did I ship last week?") with cited receipts. *Done-when:* a recall
  query returns real past moments, sourced.
- **S4 — AE Eyes.** Bundle the VLM; the OrangeEye order (`eyes.see`, already spine-routed,
  rcpt_011a97424b8224d9) actually reads a screenshot/image and reports what it sees.
  *Done-when:* point it at the running app → an honest visual read, no human relay.
- **S5 — Voice full-duplex.** whisper.cpp (STT) + Piper (TTS) on the existing cpal spine.
  *Done-when:* speak an order, hear the organism answer.
- **S6 — Two-computer routing.** Reflex/work local on N150; heavy/vision offload to Codexa when
  its rail is green (currently FAILED — honest badge until then). *Done-when:* the same order
  routes local vs Codexa by size, badged truthfully.
- **S7 — The 50GB installer.** Orbital auto-installer (teenager-grade doctrine): single flow,
  weights + exe + engine, SHA-manifest, resume-safe download, API keys the only manual input.
  *Done-when:* one artifact installs the whole sovereign mind on the N150.

## Definition of done (the airplane test)

Kill the internet. Open the exe. Order a project → a **local** model plans it. Chat → it thinks
locally. Point the eyes at your screen → it reads for real. Speak → it hears and answers. Watch
the cosmos live through all of it. **One ~50GB sovereign vehicle, thinking alone.** That is the
bar this plan closes — and it makes the 4.6/10 visual score almost beside the point, because the
thing is finally *alive without a leash*.

## Ground truth at handoff (2026-07-05)

Native app: N0–N8 + N10a closed (ladder in AOMBP). Release exe 11MB (shell only — S-waves fix
this). Visuals: 5 convergence rounds, peak living-camera cinema. Ops brain, time machine,
velocity ghost, estate awareness, 72-state atlas, native voice — all live and receipted.
Codexa rail FAILED (gates heavy/S6). OrangeBrain external + offline (S1 makes it internal).
Start point: **S1**. First move: `cargo add llama-cpp-2`, load a GGUF, answer one prompt in-process.
