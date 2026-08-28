# Atomic Orange — Graphics System Manual (v1.0)

The living organism's render stack: what every organ is, where it lives, what feeds it,
and the laws it obeys. Written from full source inspection 2026-07-06. 2,533 lines total.

## Architecture (one frame)

```
ops.rs (truth) ──► main.rs update() ──► Uniforms (592 B) ──► GPU
                                                             │
   scene → HDR Rgba16Float ("hdr-a"):                        │
     1. field.wgsl   fullscreen  REPLACE      nebula/rings/stars/lensing/shockwave
     2. web.wgsl     90k quads   ADDITIVE     storm/riders/streams/bokeh/comets
     3. core.wgsl    fullscreen  PREMULT      the citrus Strategic Brain
   post:
     4. post.wgsl fs_bright_h    HDR→B0 (½res)  threshold 0.58 + H-gauss
     5. post.wgsl fs_blur_v      B0→B1  (½res)  V-gauss
     6. post.wgsl fs_composite   A+B1 → swapchain  bloom 0.42 + 22-tap god-rays 0.13
                                                   + edge-focus falloff + ACES
   egui HUD paints over the composite (glass panels, screen-space).
```

## The uniform bridge — 592 bytes, byte-identical in Rust + all three scene WGSL

| Field | Layout | Written by (main.rs) | Read by |
|---|---|---|---|
| `res` | w, h, time, bodyCount | physical pixels (DPI law) | all |
| `bodies[16]` | x, y, mass, _ | ops projects → SLOTS; dive → task ring; +presence seat | field (lensing/accretion), web (stream anchors) |
| `tints[16]` | r, g, b, _ | project/task state colors | field, web |
| `mood` | intensity, ring_speed, **ghost**, _ | preset + surge; ghost = 7-day pace fraction | field (accents), web (brightness/speed), core (boost + ghost wedges) |
| `bias` | r, g, b, _ | preset color lean ("state weather") | field |
| `pulse` | x, y, **age**, **doneFrac** | shockwave origin+age (age≥1 ⇒ off); portfolio dial | field (shockwave), core (lit wedges) |
| `cam` | offx, offy, zoom, _ | eased living camera | all three (one eye: world→view) |

**Law:** change the struct → change it in `main.rs` AND `field.wgsl` AND `web.wgsl` AND
`core.wgsl`, same pass, fields appended at the end only.

## The organs

- **field.wgsl** — dual-family nebula (indigo/ember, circadian ~30-min warmth cycle),
  teal + rose spectral families, dust lanes (ridged fbm), asymmetric radiant pocket,
  gravitational lensing per body, 5 non-uniform orbital tracks (radii .150/.198/.258/
  .336/.435, per-ring presence) + comets + 8 department spokes, hearth, 1/f pink
  breathing, completion shockwave (green truth ring), 3 parallax starfields, vignette
  floor 0.16, filmic curve.
- **web.wgsl** — 90,000 instanced soft quads, ALL trajectory math in the vertex shader
  by instance id: bokeh (8, id-gated — id-gate, never probability-gate, else fog bug),
  ember storm (born r≥0.11, amber-born so whites can't stack), ring riders (14%),
  anchor streams (state-tinted, brightness 0.45), 6 shooting stars (~20–30 s periods).
- **core.wgsl** — the citrus brain: 9 wedges, thin membranes (distance-to-boundary
  mask — the reversed-smoothstep "paper plate" bug is documented dead), pulp fbm,
  crimson→hot juice, backlight blaze, **portfolio dial** (wedges ignite by pulse.w),
  **velocity ghost** (pale promise wedges by mood.z), hex seed, pith + speckled rind,
  corona, 3D dome light (key upper-left, wet specular dot, rind occlusion).
- **post.wgsl** — bright-pass threshold 0.58 (only true light blooms), separable
  gaussian at half-res, composite: scene 0.66 + bloom 0.42 + god-rays 0.13 toward the
  heart, cinematic edge-focus falloff, ACES.

## The living behaviors (main.rs)

- **Living camera** — 1/f drift + breath-zoom + pointer parallax + surge/dive zoom,
  eased 4.5%/frame (`cam_s`). One eye across all organs.
- **Surge** — real work heats the organism (+0.9 complete, +0.7 create, +0.6 gateway
  flip, +0.5 estate receipt), decays ×0.985/frame. Feeds mood, camera, voice.
- **Shockwave** — 1.6 s green truth ring from the completed project's mass. The ONE
  earned fast motion (mindrest law).
- **Presence** — cursor becomes a faint cool 17th mass; the gas leans toward you.
- **State atlas** — 72 presets (operator architecture): 5 hand-tuned AELID anchors +
  67 systematic seats to build out. Keys 1–5, `[` `]` cycle.
- **Time machine** — `←` `→` scrub the journal; the WHOLE cosmos (masses, cards, dial)
  renders the viewed snapshot; any work key returns to LIVE.
- **Dive** — Enter falls into the runway project (tasks become the sky), Esc ascends.
- **Voice** — M toggles the cpal harmonic drone; chord = real portfolio state.
- **Self-photograph** — S key (or auto at launch+10 s and 1.5 s after every state
  change): composite → Rgba8 → readback → PNG receipt in
  `10-RECEIPTS/atomic-orange/pixel/native-*.png`. The organism proves its own pixels.
- **Mindrest throttle** — 33 ms focused / 250 ms unfocused. It rests when you look away.

## Machine law (the N150 nearly died for this)

- **Never** run build loops or parallel cargo processes. ONE build per pass, `-j 2`.
- Kill `atomic-orange.exe` BEFORE building (file-lock race), never during a build chain.
- Verify by SOURCE INSPECTION first; build once when the source is proven.
- Release builds (~20 min, saturating) only as a deliberate, operator-aware step.

## Verify loop (receipts)

1. `cargo build -j 2` → green line.
2. `cargo run` → auto-shot lands at t+10 s (scene truth, no HUD).
3. `tools/pixel-receipt.ps1 -Label <x>` → windowed capture (HUD + real FPS vital).
4. Read both PNGs. Judge. Seal via `/orange5` spine order (`--learn`).

## Open (not defects — the operator's taste loop)

- Corona presence vs ring brightness; juice hue temperature; storm density — operator
  scores, one knob per pass.
- 67 atlas seats await individual build-out (operator's roadmap).
- `LOCAL MODEL` vital stays "none" until /v1/models wired (S-waves, SOVEREIGN_50GB_PLAN).
