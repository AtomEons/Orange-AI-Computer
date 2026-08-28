# Atomic Orange - NATIVE (02-APP-NATIVE)

**The shipping organism. Rust + wgpu + egui. NO webapps, NO Edge, NO webviews**
(render law: `00-CHARTER/ATOMIC_ORANGE_CONNECTION_STANDARD.md` section 7b).

```txt
cargo run
cargo build --release
```

## What this is

The Windows-first native re-home of the Atomic Orange living cockpit. The
webview app at `02-APP` is the **DESIGN LAB**: visual law gets forged there fast,
then organs are ported here. Organs are math plus state law, so porting is
mechanical, not creative.

| Organ (design lab, GLSL/TS) | Native home (WGSL/Rust) | Status |
|---|---|---|
| GalaxyField (mindrest field, lensing, circadian) | `src/field.wgsl` | **PORTED - frame one** |
| OrangeCore (citrus Strategic Brain) | `src/core.wgsl` | next |
| LivingWeb (5.2k-particle thought web) | vertex/compute pipeline | next (compute = beyond-webview ceiling) |
| HUD instruments (vitals/intent/rails/command) | egui overlay | stub live (honest OFFLINE) |
| mindrest audio (harmonic series + 1/f) | cpal/rodio | later |
| operations + project-intelligence | Rust port of `lib/*.ts` | later |
| OrangeBrain seam (`127.0.0.1:1337`) | reqwest client, same contract | later |

## Laws carried over (non-negotiable)

- Connection standard: one gateway seam, dock registry, order/report/receipt,
  and honest offline state.
- Mindrest science: 1/f motion, fractal-fluency fBm, circadian drift, saturation
  only on truth.
- NORTH_STAR: the two reference HUDs are the bar; calm-at-density.
- Render discipline: throttle when ambient, pause on blur/minimize. The archived
  implementation still uses a flat approximately 30 fps repaint.

## Honest status (2026-07-04)

**ALIVE.** First build completed successfully in 23m04s with one deprecation
warning. One runtime fix changed bind-group visibility from `FRAGMENT` to
`VERTEX_FRAGMENT` for the web's vertex-stage uniforms. The debug executable ran
the field, 45k-particle web, and citrus core; all three WGSL pipelines validated
at approximately 272 MB working set.

Known debts: flat approximately 30 fps repaint, static seed portfolio,
operations port pending, release build not timed, and egui instrument ring not
started.
