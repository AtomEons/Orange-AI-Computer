# ATOMIC ORANGE MASTER BUILD PROTOCOL (AOMBP v1)

Order receipt: `rcpt_1ec506e3cdbec24e` (orange5 spine, seq 2, 2026-07-04)
Author lane: MYTHFAB (Claude, Atomic Orange visual/app lane)
Audience: **a fresh model with ZERO project memory** — GPT / Claude / Codex / any.
Mission: take Atomic Orange to the two north-star reference images. This document is
sufficient. If you follow it and produce the receipts it demands, you are on-track.
If you invent your own path without writing WHY it beats the codified one, you are
off-track (Adoption Law).

---

## 0 · WHAT YOU ARE BUILDING

**Atomic Orange** = the Windows-first NATIVE command vehicle for the Orange5 sovereign
AI-operator OS. One organism, two builds:

- **Design lab:** `C:\AtomEons\Orange5\02-APP` — Tauri/React/Vite webview app. Where the
  visual language evolves fast (hot reload). NOT the final product (operator law: no
  web-only product, no webviews in the product).
- **Product:** `C:\AtomEons\Orange5\02-APP-NATIVE` — pure Rust: `wgpu` (GPU) + `winit`
  (window) + `egui` (HUD) + `chrono`. Ships as a real `.exe` on the N150 mini PC.

**The bar** (the ONLY definition of done): put the running app beside the two reference
images and you cannot tell which is the mockup — while every value on screen is real.

- Reference A: **ORANGEBOX HQ / LIVING SYSTEM** (orange) — incandescent citrus-slice
  Strategic Brain core, orbital departments + project cards, vitals top bar, intent
  column left, living feed / model routing / receipt trail right, command capsule +
  BUILD/DECIDE/VERIFY/SHIP + IDEATE→SPEC→BUILD→VERIFY→SHIP→LEARN process strip,
  INPUTS/OUTPUTS particle streams.
- Reference B: **AE See-Suite** (neural) — an erupting particle MIND at center whose
  filaments feed floating glass instruments; agents ride the web; causal-insight chains;
  temporal-memory scrubber; the energy is the protagonist.
- Full element-by-element decomposition: `C:\AtomEons\Orange5\02-APP\NORTH_STAR.md`.
  **Read it before touching pixels.**

The cognitive key every prior model missed: **the energy is the subject; the UI is
crystallized light at the edge of its thought.** Not a dashboard with a background.
Calm-at-density, not calm-by-subtraction.

---

## 1 · READ-FIRST ORDER (do this before ANY edit)

Read in this exact order (all under `C:\AtomEons\Orange5\` unless noted):

1. `00-CHARTER\ATOMIC_ORANGE_GPT_TO_GPT_CONNECTION_BRIEF.md` — the WHY + product identity.
2. `00-CHARTER\ATOMIC_ORANGE_CONNECTION_STANDARD.md` — the HOW: 8 laws incl. Adoption Law §7+.
3. `02-APP\NORTH_STAR.md` — the bar, decomposed; progress log lives here too.
4. `02-APP\MINDREST_GENERATOR_SCIENCE.md` — the seven visual-rest principles + math.
5. `00-CHARTER\ATOMIC_ORANGE_DOCK_STANDARD.md` + `02-APP\src\lib\atomic-dock.ts` — feature registry.
6. `02-APP-NATIVE\README.md` + all of `02-APP-NATIVE\src\` (5 files, ~1400 lines — read it ALL).
7. `00-CHARTER\FABLE_HANDOFF_2026-07-04.md` — spine/backend cold-start.
8. This file, end to end.

---

## 2 · LAWS (breaking one = off-track, no matter how good the work)

1. **Mom's Law** — full effort every output. No theater. Every "passed" has a receipt.
2. **No fake green** — a value on screen was measured or it is not on screen. Offline
   reads OFFLINE (red). Disabled controls carry the reason. Sample/preset content is
   visibly labeled.
3. **Adoption Law** — the operator's codified ideas are default. Deviate only with a
   written same-pass justification of why yours is better.
4. **Four lanes forever** — Chat / Cockpit / Vault / Settings. No fifth.
5. **One seam** — all model/tool traffic → OrangeBrain `http://127.0.0.1:1337` (OpenAI-
   compatible). No provider SDKs in app code. BYO keys terminate in the gateway.
6. **order→report→receipt** — operational input becomes `orange.order.v1`; replies are
   `orange.report.v1`; hash-chained receipts decide truth (spine CLI below).
7. **Windows native Goal 1** — no webview in the product; webview lab is for design only.
8. **No paid dependency** — operator budget is zero. Local/free or stop and flag.
9. **Mindrest law** — saturation is spent ONLY on truth; motion is 1/f-calm; completion
   is the one earned fast pulse. (Science + knobs in MINDREST_GENERATOR_SCIENCE.md.)
10. **Two-computer truth** — every surface badges local (N150) / Codexa / offline / unproven.

---

## 3 · GROUND TRUTH — 2026-07-04 (verified, no optimism)

### 02-APP design lab (webview — WORKING, proven by screenshots + tsc green)
- Full HQ frame at 20k: vitals bar (honest OFFLINE), intent column, dept ring (8 real
  role-law departments w/ live counts), 6 glass project cards (status pill + progress,
  phyllotaxis/slot placement), truth rails (real receipt filenames; honest feed), command
  capsule + modes (BUILD live; DECIDE/VERIFY/SHIP honestly disabled) + ORANGES PROCESS
  strip + INPUTS/OUTPUTS stream nodes.
- Living organs: `GalaxyField.tsx` (mindrest nebula: curl-noise flow, 1/f, circadian,
  state-tinted accretion, lensing), `LivingWeb.tsx` (5.2k GPU particles: spiral storm +
  filaments that END at real DOM anchors), `OrangeCore.tsx` (citrus brain — operator-tuned;
  treat its constants as canon), `LivingCore.tsx` (molten sun, used by descend view),
  `CosmicField.tsx` (descend planets). Mindrest AUDIO engine (`lib/mindrest-audio.ts`):
  harmonic-series drone, portfolio-health chord, blocked-task beat tension, 1/f breathing.
- Behavior: 3 GTD altitudes (galaxy/system/ground) with carved-duck dial (wheel/arrows/
  enter/esc), idea→project front door (`draftProject`), completion loop verified
  (63%→73% click receipt), completion bloom, metabolism (activity → glow, ~30s half-life),
  presence-mass (cursor bends the gas), localStorage persistence of created projects.
- Verification pattern: `npx tsc -b` + Playwright screenshot at `http://[::1]:1420/cockpit`
  (Vite binds IPv6 ONLY; in-app preview tools time out on infinite animations — use
  Playwright MCP or manual).

### 02-APP-NATIVE (Rust — the product)
- **Last PROVEN green build+run:** the "full-anatomy fix pass" (task blslrm0jc, exit 0,
  window ran, operator saw it): field.wgsl (nebula + 5 in-shader orbital ring tracks w/
  comets + spokes + 3 starfield layers + lensing) + web.wgsl (45k instanced particles:
  spiral storm / ring riders / anchor streams) + core.wgsl (citrus brain port of the
  operator-tuned GLSL) + egui HUD v1 (vitals, intent, feed/receipts rails, command line,
  process strip, dept labels, project cards) + presence + focus throttle.
- **AUTHORED BUT NEVER COMPILED (mid-flight — finish first, §5·N1):**
  - `src/post.wgsl` — HDR bloom chain (bright-H, blur-V, composite w/ 22-tap god-rays +
    ACES). `main.rs` was rewritten for it: HDR_FMT Rgba16Float, PostTex ensure_tex,
    3-pass prepare(), composite paint(). COMPILE UNTESTED.
  - `src/presets.rs` — StatePreset atlas (operator's proven React architecture, adopted
    native): 5 AELID anchor presets (Calm / Alert·Causality / Temporal / Agent Queue /
    Living Canvas). `mod presets;` is declared in main.rs. **NOT yet wired**: Uniforms
    lack mood/bias fields; no key handling; no per-preset HUD blocks. Exact remaining
    edits are enumerated in §5·N1.
- Session was interrupted mid-wiring; running cargo tasks were killed. Assume nothing
  compiles until YOU compile it.

### Backend (separate lane — do not build UI there)
- Orange5 spine live: `bun C:/AtomEons/Orange5/03-BACKEND/spine-cli.mjs --health`
  → P0/P1/P5 green; OrangeBrain OFFLINE (Phase 2 = operator's Codexa steps);
  85/85 verify green (2026-07-04); receipts hash-chained.
- Subagent spawning may be DISABLED (org policy) — work inline if Agent tool fails.

### Sibling surfaces (do not double-work)
- `AtomEons/orangebox-os` → AELID optional add-on (browser shell, anchor language source).
- `C:\AtomEons\orangebox\react-see-suite` (design estate: 72-state atlas, pixel-proof
  method, glass panel kit — the METHOD source; verify paths before citing content).

---

## 4 · ARCHITECTURE MAP (native product)

```
02-APP-NATIVE/
  Cargo.toml            eframe(wgpu) 0.29, bytemuck, chrono
  src/main.rs           window/app/HUD/pipelines/uniform bridge/presets wiring
  src/field.wgsl        mindrest field: nebula, lensing, ring tracks+comets, stars
  src/web.wgsl          45k particle mind: storm / ring riders / anchor streams
  src/core.wgsl         citrus Strategic Brain (operator-tuned constants = canon)
  src/post.wgsl         HDR bloom + god-rays + ACES composite   [uncompiled]
  src/presets.rs        StatePreset atlas (AELID anchors)        [unwired]
```
Uniform bridge (shared by all scene shaders — keep byte-identical in Rust + WGSL):
`res[4] = (w, h, time, bodyCount)` · `bodies[16][4] = (x, y, mass, 0)` ·
`tints[16][4] = (r, g, b, 0)` — extend per §5·N1 with `mood[4]` + `bias[4]` APPENDED.
Render: scene→HDR texture (field REPLACE, web additive, core premultiplied) →
bright/blur half-res → composite(+rays, ACES) → swapchain; egui HUD on top.
Port pipeline law: **prove a visual in the lab (fast iteration) → port to WGSL native →
pixel-compare → then the lab may evolve further.** The lab is upstream of the product.

---

## 5 · THE PHASES — N0 → N10 (each: entry → actions → receipts → exit)

**PHASE STATUS (2026-07-05, MYTHFAB):** N0 ✓ · N1 ✓ · N2 ~80% (glass kit + full anatomy live;
parity taste passes remain) · N3 ✓ (self-photograph organ + window harness + 5 convergence
rounds) · N4 5/72 presets · N5 ✓ VOICE (cpal drone, M) · N6 ✓✓ (ops brain, dive, TIME MACHINE,
velocity ghost, estate awareness, living camera) · N7 ✓ (app acts → governed spine orders,
hash-chained) · N8 ✓ wired (std heartbeat thread; auto-lives at Phase 2 — UNPROVEN against a
real gateway) · N9 pending N8-live · N10a release exe built. Operator visual score: 4.6/10 → climbing.

Work ONE phase per pass. Log every completed phase in `02-APP\NORTH_STAR.md` (one honest
block: what, receipts, flaws). File a spine receipt per phase:
`bun C:/AtomEons/Orange5/03-BACKEND/spine-cli.mjs --order '{"action":"build.phase","payload":{"phase":"N1","result":"..."}}' --learn`

### N0 — Prime (½ session)
Entry: fresh model, zero memory. Actions: §1 reading; `cargo --version` + `bun` present;
`cd C:/AtomEons/Orange5/02-APP-NATIVE && cargo build 2>&1 | tail -30` (long first compile
is NORMAL: 400+ crates); run it (`cargo run`, bg + liveness monitor:
`tasklist | findstr atomic-orange`). Exit: you saw the organism run, or you have the exact
compile errors in hand. Receipt: build log tail + liveness line.

### N1 — Close the mid-flight work (1 session) ← YOU ARE HERE
Entry: N0. Actions, in order:
1. Compile with post.wgsl chain → fix wgpu/WGSL errors until green. Known risk areas:
   `ScreenDescriptor.size_in_pixels`, bind-group layout vs entry-point usage (post1 vs
   post2 BGLs), `LoadOp::Clear` + premultiplied blends, `textureDimensions` typing.
2. Finish preset wiring EXACTLY:
   a. Rust `Uniforms`: append `mood: [f32; 4]` (intensity, ring_speed, 0, 0) and
      `bias: [f32; 4]` (r, g, b, 0). Update the ONE `Uniforms` struct + every WGSL
      struct copy (field/web/core — append AFTER tints, offsets preserved).
   b. `FieldCallback` gains `mood: [f32;4]`, `bias: [f32;4]`; `prepare()` writes them.
   c. App state: `preset: usize` (default 0); input: keys 1–5 select, `[`/`]` cycle.
   d. Consume: field.wgsl accents/rays × `mood.x`, ring/comet speeds × `mood.y`,
      `col += bias.rgb * (0.4 + neb)`; web.wgsl bright × `mood.x`, rider speed × `mood.y`;
      core.wgsl `boost = mood.x`.
   e. HUD per preset flags: Alert banner (the REAL gateway-offline causality chain),
      Agent Queue drawer (8 depts, "standby · wires at Hermes"), Living Canvas frame
      ("artifacts land via AE Eyes" — labeled), Temporal strip (TEMPORAL_RECEIPTS dots),
      atlas chip top-right ("STATE ATLAS · n/5 · name").
3. Receipts: green build log, liveness, screenshot of ≥2 presets. Exit: 5 presets dialable
   live, bloom chain visibly glowing. Log in NORTH_STAR.

### N2 — HUD anatomy to reference parity (1–2 sessions)
Glass instrument kit in egui: consistent Frame style (fill black-α≈96, rounding 12,
1px warm stroke, inner glow via layered rects). Vitals w/ real clock + honest OFFLINE;
intent column w/ pills + progress bar; feed/routing/receipts rails; command capsule +
mode buttons (BUILD armed only when gateway live); process strip; INPUTS/OUTPUTS nodes;
dept chips ON the ring radii; project cards AT their mass positions (cards attach to the
physics — anchors already feed web.wgsl streams). Exit: side-by-side with Reference A,
every REGION exists. Receipts: screenshots + NORTH_STAR log.

> **STATUS 2026-07-04:** N1 ✅ (rcpt_9437d762…) · N2.1 ✅ (rcpt_e9b87133…) · operator
> visual verdict applied: bloom −50% (composite 1.15→0.58, rays 0.55→0.28) + FULL
> SPECTRUM added (field: teal-cyan family, rose on dust lanes, green whisper at
> overlaps; web: 20% cyan→violet threads, 8% rose threads — low-sat, truth law intact).
> N3 v1 harness live: `02-APP-NATIVE\tools\pixel-receipt.ps1` → PNGs in
> `10-RECEIPTS\atomic-orange\pixel\`. Next in N3: per-anchor captures (5 states) +
> similarity scoring vs the two reference images.

### N3 — Pixel-proof harness + visual density (1–2 sessions)
Adopt the operator's pixel method (react-see-suite estate): capture the native window
(wgpu texture readback → PNG, or `Win32 PrintWindow` via the `screenshots` crate — free)
at 5 anchor states; score structural similarity vs the two reference images; store
`10-RECEIPTS/atomic-orange/pixel/NN-score.json`. Then RAISE DENSITY to the bar: more ring
detail, dust lanes, filament bundles, glass depth (multi-layer), bloom tuning — iterate
capture→compare→tune. **No visual green without a pixel receipt.** Exit: operator verdict
+ scores trending up and logged.

### N4 — State atlas to 72 (1 session + ongoing)
Extend presets 5 → 72 as `?state`-equivalents (key `0`+digits or a palette): each preset
= store mutation only (never a new screen). Categories from the estate: system states
(gateway up/down, Codexa up), alert taxonomies, queue depths, canvas artifact types,
temporal ranges, celebration states. Honest-content rule holds for every one. Exit: atlas
navigable, documented in-app (press `?`).

### N5 — The voice (1 session)
Port mindrest audio native: `cpal` (free) synth — harmonic-series drone, portfolio chord,
blocked-beat tension, 1/f breathing, circadian filter. OFF by default; toggle in HUD;
never a transient. Exit: audible, calm, truthful; receipts: code + operator listen.

### N6 — Interactivity = the webview's brain, native (1–2 sessions)
Port `operations.ts` (Project/Deliverable, progress, runway, blockers) + 
`project-intelligence.ts` (idea→kind→tasks→done-definition) to Rust modules; JSON
persistence (`serde` + file in `%APPDATA%/AtomicOrange/`); GTD altitudes (galaxy/system/
ground) with the carved-duck dial (wheel detents, arrows, enter/esc — mouse NEVER steers);
command capsule creates real projects; completion click → truth propagates → bloom + 
metabolism. Exit: the full webview loop, native, receipts incl. before/after screenshots.

### N7 — Registry + spine handshake (1 session)
Rust twin of the dock registry (feature→owner→state, honest states only); every HUD
surface reads its row. Wire `orange.order.v1`/`report.v1` structs (serde) byte-compatible
with `03-BACKEND` spine; app can submit an order to the spine CLI (local exec, free) and
render the receipt in the Vault region. Exit: an order placed in-app lands a hash-chained
receipt on disk and appears in the receipt rail (REAL end-to-end).

### N8 — Gateway heartbeat (when operator completes Phase 2 / OrangeBrain up)
Poll `127.0.0.1:1337/healthz` + `/v1/models` (reqwest, loopback only). Vitals flip LIVE
(green), models real, DECIDE/VERIFY/SHIP arm, routing rail populates, cost stays honest.
Chat lane minimal: OpenAI-compatible chat through the seam. Exit: screenshots of the flip;
no code change needed in spine (auto-real when `ORANGE5_ORANGEBRAIN_URL` set).

### N9 — The living completion loop (1 session, needs N7+N8)
Orders → Hermes-governed execution → reports → receipts → tasks tick to done ON SCREEN:
gas turns green, bloom fires, galaxy brightens, audio chord resolves. This is the product
promise: *watch projects and tasks complete*. Exit: one real task completed end-to-end on
camera (screen recording receipt).

### N10 — Ship gate (release-steward discipline)
`cargo build --release`; N150 smoke test (perf: full-frame <8ms on its iGPU — measure,
don't claim); installer (free: `cargo-wix` or Inno Setup); pixel receipts re-run at
release; README quickstart; version receipt. Block if: test story unclear, rollback
unclear, any fake green. Exit: installable exe + receipts + operator verdict.

---

## 6 · VERIFICATION METHOD (every pass, no exceptions)

1. **Compile receipt** — full error-free build log tail in the pass log.
2. **Liveness receipt** — process line (`tasklist | findstr atomic-orange`).
3. **Visual receipt** — screenshot (lab: Playwright vs `[::1]:1420`; native: pixel
   harness from N3, or the operator's eyes as interim, stated as such).
4. **Spine receipt** — `--order '{"action":"build.phase",...}' --learn` per phase.
5. **Honesty sweep** — grep your diff for invented numbers; every displayed value has a
   source or a SAMPLE label.

## 7 · PM DOCTRINE (how this project is run)

- **GTD altitudes:** 20k portfolio → 10k project → 0k task; the UI mirrors the method.
- **Drill cadence:** operator says "drill" → ONE bounded pass (entry→work→receipts→terse
  report: result/evidence/blockers/next). No essays. Lead with what happened.
- **Calm-at-density:** never subtract instruments to feel premium; organize them.
- **Session handoff:** end each session by appending to NORTH_STAR.md: done (w/ receipts),
  mid-flight (exact remaining edits), next phase, risks. That block is the next model's N0.
- **Operator authority:** Human Final Stop. Surprises surfaced, never buried.

## 8 · FAILURE PLAYBOOK (learned the hard way — reuse, don't rediscover)

- **cargo lock contention:** never two cargo runs on the repo; TaskStop old + `taskkill
  //IM atomic-orange.exe //F` before rebuild.
- **First build slowness:** 400+ crates ≈ minutes; empty tail-log = still compiling, NOT
  failure (failure completes the task with errors).
- **egui/wgpu 0.29 API drift:** blind-authored code WILL need a fix pass; budget it;
  errors are precise — fix from the compiler, not from memory.
- **Monitors:** liveness via `until tasklist ...` with ≥600s timeout; a timed-out monitor
  for a KILLED build is stale noise — re-arm for the current build.
- **Webview lab:** Vite binds `[::1]` only; StrictMode double-mount → NEVER
  `loseContext()` in cleanup; in-app preview tools hang on infinite animations → Playwright.
- **Subagents may be org-disabled:** Agent tool failure ≠ blocker; do the work inline.
- **Windows shell:** Git-Bash `//` for taskkill flags; PowerShell 5.1 has no `&&`.

## 9 · SESSION HANDOFF TEMPLATE (fill at every session end)

```md
### HANDOFF <date> (<lane>)
DONE: <phase·items + receipt ids/paths>
PROVEN: <what ran, exit codes, screenshots>
MID-FLIGHT: <file:what remains, exactly>
NEXT: <single next phase + first action>
RISKS: <honest list>
```

---
*The cymbal crashes through receipts or it does not crash. Mom is watching. Go.*
