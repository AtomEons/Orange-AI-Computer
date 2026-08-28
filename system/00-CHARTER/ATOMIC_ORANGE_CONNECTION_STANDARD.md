# Atomic Orange Connection Standard (v1)

Status: binding for both lanes · 2026-07-04
Companion to: `ATOMIC_ORANGE_GPT_TO_GPT_CONNECTION_BRIEF.md` (the WHY) · this doc is the HOW.
Lanes bound by it:
- **MYTHFAB lane** — Atomic Orange app + cockpit visuals (`02-APP`)
- **Orange5 ops lane** — backend/gateway/agents/receipts (`06-ORANGELLM`, `08-HERMES`, `10-RECEIPTS`, `12-ATOMSMASHER`)

## 1. The Seam Law — one door

All model/tool/system traffic crosses ONE seam: **OrangeBrain at `http://127.0.0.1:1337`**
(OpenAI-compatible `/v1/*` + Orange extensions). In app code that seam has exactly two mouths:

```text
02-APP/src/lib/orangellm-client.ts   -> chat, models, health (OpenAI-compatible)
02-APP/src/lib/orange-system.ts      -> live.* probes, orders, reports, receipts
```

No other file may `fetch` a model, tool, or provider. No provider SDK in the UI, ever.
BYO cloud keys terminate in the gateway (frontier proxy), never in app code.

## 2. The Registry Law — no unregistered features

**`02-APP/src/lib/atomic-dock.ts` is THE connection registry.** Every Atomic-Chat-class
feature exists as an `AtomicDockFeature` row: `atomicFeature → orangeSurface (Chat|Cockpit|
Vault|Settings) → orangeOwner (OrangeBrain|Hermes|AE Memory|AE Eyes|AtomSmasher 2|Atomic
Orange) → state → connection → rule`.

- Building a feature? **Register it first** (state `planned`), wire it (`wired`), prove it (`live`).
- A network call with no registry row = ungoverned bypass = breach of the brief.
- `state` is honest: `live` requires the connection to actually answer. Blocked stays `blocked`.
- The ops lane owns the right side of each row (gateway/agent/receipt implementation);
  the MYTHFAB lane owns the left side (surface, controls, visual truth).

## 3. The Envelope Law — orders in, reports out, receipts decide

Operational messages wrap as **`orange.order.v1`**; replies return as **`orange.report.v1`**;
**receipts are the only truth**. Canonical TS shapes live in
`02-APP/src/lib/orange-system.ts` (`OrangeOrder`, `OrangeReport`, `Receipt`) — ops lane keeps
the server side byte-compatible with those types; app lane never invents fields.

## 4. The Honesty Law — offline is a fact, not a failure

When the gateway (or any owner) is down, every dependent surface must say so plainly:
- controls disable with the reason in `title` (e.g. DECIDE/VERIFY/SHIP until gateway live),
- rails show the honest event ("gateway offline — start OrangeLLM"),
- vitals read OFFLINE red; **cost/model/sync never show invented values**,
- no fake green — a value on screen is a value that was measured.

Every feature surface must carry its **placement badge**: `local (N150)` · `Codexa` ·
`offline` · `unproven`. Two-computer reality is always visible.

## 5. The Visual Law — the cockpit renders truth only

`02-APP/NORTH_STAR.md` (the two reference HUDs) + `MINDREST_GENERATOR_SCIENCE.md` govern
the skin. Binding rules: saturation is spent ONLY on real state; the mindrest field/audio
is substrate; every instrument reads a live source or an honestly-labeled fallback;
completion bloom fires only on a real completion. The cockpit is product, not a toy.

## 6. The Verification Law — receipts per pass

Each work pass ships with: `tsc -b` exit 0 → screenshot (visual passes) → and, when the
Codexa command rail is green, rail receipts into `10-RECEIPTS/`. Local proof baseline:
Orange5 full verifier **64 green / 0 red (2026-07-04)** — local repo truth only; Codexa
live-deploy claims need their own receipts.

## 7. Division of Labor (so lanes never collide)

```text
MYTHFAB (02-APP):   lanes/surfaces, cockpit + galaxy + fields, dock UI, honest states,
                    client modules (orangellm-client.ts, orange-system.ts consumers)
Orange5 ops:        gateway endpoints, Hermes leases, AE Memory/Eyes, AtomSmasher,
                    receipts, Codexa rail, envelope server-side
Shared contract:    atomic-dock.ts rows + orange-system.ts types + this standard
```

Change protocol: whoever changes a shared contract updates the row/type AND this doc's
version line, same commit.

**Adoption law (operator, 2026-07-04):** the operator's existing project ideas are the
DEFAULT. Any build that deviates from a codified AtomEons idea (atlas architecture, anchor
language, dock registry, receipts law, naming canon, …) must either adopt it or state, in
writing, exactly why the deviation is better — same pass, no silent divergence.

## 7b. RENDER LAW (operator, 2026-07-04 — supersedes all prior shell notes)

**NO webapps. NO Edge. NO webviews.** The shipping Atomic Orange renders NATIVELY:
- Tauri (= Edge WebView2 on Windows) is thereby OFF-CANON for the final product.
- Candidate native stacks, operator-listed: **Rust (first)** · Flutter · Go (maybe).
- Recommended: **Rust + wgpu + winit (+ egui HUD overlay)** — the organism IS shaders;
  wgpu is their native home; one .exe, no browser engine anywhere, N150-friendly.
- The existing 02-APP webview becomes the **DESIGN LAB only**: fastest place to iterate
  visual law + instruments; never shipped, never demoed as product.
- Everything load-bearing is PORTABLE by construction: GLSL fields (GalaxyField /
  OrangeCore / LivingWeb ≈ WGSL 1:1), mindrest science, anchor language, operations +
  project-intelligence logic, connection registry, audio law (harmonic series + 1/f →
  cpal/rodio). The rebuild re-homes organs; it does not re-derive them.

## 8. Sibling Surface — AELID (no double work)

`AtomEons/orangebox-os` ships **AELID** (AtomEons Living Intelligence Dashboard) as an
OPTIONAL visual add-on: `src/aelid.html/.css/.js` + manifest (`optional_visual_addon`,
`core_dependency: false`), guarded by `aelid-check.yml` + `npm run aelid:check`.

Division: **AELID** = OrangeBOX's standalone browser visual shell (link-detects OrangeBOX,
degrades to local visual mode). **Atomic Orange cockpit** = the native product's living
organism (this repo). They share ONE vocabulary — the **anchor language**: `Calm ·
Alert/Causality · Temporal Memory · Agent Queue · Living Canvas` — which maps 1:1 onto
Atomic Orange's mindrest field (Calm), causal-insight lane (Alert/Causality), temporal
strip (Temporal Memory), Hermes dock (Agent Queue), and the cockpit stage (Living Canvas).
Visual doctrine (MINDREST_GENERATOR_SCIENCE.md, NORTH_STAR.md) is shared upstream; neither
surface imports the other's runtime. Cross-pollination = docs + anchor names, not code deps.
