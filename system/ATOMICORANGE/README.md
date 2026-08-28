# Atomic Orange — NATIVE (02-APP-NATIVE)

**The shipping organism. Rust + wgpu + egui. NO webapps · NO Edge · NO webviews**
(render law: `00-CHARTER/ATOMIC_ORANGE_CONNECTION_STANDARD.md` §7b).

```txt
cargo run            # dev
cargo build --release  # one lean .exe → target/release/atomic-orange.exe
```

## What this is

The Windows-first native re-home of the Atomic Orange living cockpit. The webview app at
`02-APP` is the **DESIGN LAB** — visual law gets forged there fast, then organs are ported
here. Organs are math + state law, so porting is mechanical, not creative:

| Organ (design lab, GLSL/TS) | Native home (WGSL/Rust) | Status |
|---|---|---|
| GalaxyField (mindrest field, lensing, circadian) | `src/field.wgsl` | **PORTED — frame one** |
| OrangeCore (citrus Strategic Brain) | `src/core.wgsl` | next |
| LivingWeb (5.2k-particle thought web) | vertex/compute pipeline | next (compute = beyond-webview ceiling) |
| HUD instruments (vitals/intent/rails/command) | egui overlay | stub live (honest OFFLINE) |
| mindrest audio (harmonic series + 1/f) | cpal/rodio | later |
| operations + project-intelligence | Rust port of `lib/*.ts` | later |
| OrangeBrain seam (`127.0.0.1:1337`) | reqwest client, same contract | later |

## Laws carried over (non-negotiable)

- Connection standard: one gateway seam · dock registry · order/report/receipt · honest offline.
- Mindrest science: 1/f motion, fractal-fluency fBm, circadian drift, saturation only on truth.
- NORTH_STAR: the two reference HUDs are the bar; calm-at-density.
- Render discipline: throttle when ambient, pause on blur/minimize (TODO next pass — currently
  a flat ~30fps repaint; DO NOT ship without the throttle).

## Honest status (2026-07-04)

**ALIVE.** First build green in 23m04s (exit 0, blind-authored, one deprecation warning).
One runtime fix (bind-group visibility FRAGMENT → VERTEX_FRAGMENT for the web's vertex-stage
uniforms), then `atomic-orange.exe` ran: field + 45k-particle web + citrus core, all three
WGSL pipelines validated, ~272MB working set (debug build).

Known debts, named: flat ~30fps repaint (mindrest 30/9 throttle NOT yet ported — do before
any long-session use) · static seed portfolio (operations port pending) · debug profile only
(release build not yet timed) · egui instrument ring not started.
