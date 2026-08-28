# Orange5 Build Receipt — Guardrails / Soul Genome / Continuity Packet

- **Date (ET):** 2026-06-25
- **Wave:** Orange5 Wave 2 — Constitutional Doctrine Layer
- **Prior receipt:** `2026-06-25-mirage-eight-adapters-wired.md`
- **Prior receipt sha256:** `4d23ee0e19b9192e219847e9144fc0ed0b505814fda3af0d0301fe2319d14c09`
- **Hash chain:** linked
- **Mom's Law:** witnessed — every gap below is named in the open.

---

## Result

Constitutional doctrine layer landed end-to-end across six components:

1. **27 Guardrails spec** (`01-DOCTRINE/27-guardrails/spec.md`, 596 lines) — G-00..G-26 in constitutional dependency order, severity matrix, runtime check approach, canonical receipt-trigger strings, JSON schemas for Soul Genome and Continuity Packet, amendment procedure requiring Sovereign signature.
2. **Guardrails runtime + daemon** (`01-DOCTRINE/27-guardrails/runtime.mjs`, `server.mjs`, `registry.mjs`, 9 lib files, 27 check modules `g01..g27`, tests) — Node 20+/Bun, better-sqlite3 with JSONL fallback, loopback HTTP at 127.0.0.1:7460, hash-chained receipts, Reality Flux POST to 127.0.0.1:7419 with spool-on-unreach.
3. **27 Guardrails numbered checks** (`01-DOCTRINE/27-guardrails/checks/01..27-*.mjs`, plus `lib/check-util.mjs`, `checks/index.mjs`) — second parallel naming convention authored by sibling agent; both sets coexist without collision.
4. **Soul Genome v1** (`13-MODELS/orange-llm/soul_genome.json` + `genome-manager.mjs`) — sovereign + location + preferences + intent + active project + hardware + runtime pointers + 27 enumerated invariants; atomic temp+rename writes; deep-merge update; system-role injection.
5. **Continuity Packet generator** (`04-CONTROL-PLANE/continuity/generator.mjs` + test) — synthesizes from Reality Flux + AE Flow currents + fresh receipts; tomorrow's-action priority cascade; dual write (canonical store + Flux ledger); 23:50 ET cron-ready; CLI flags for dry-run/date/no-flux.
6. **Continuity Packet loader** (`04-CONTROL-PLANE/continuity/loader.mjs` + test) — boot-time three-source fallback (Flux → local file → last-known-good cache); accepts both schema variants and both file-naming conventions; HTTP handler exported.
7. **OrangeLLM gateway routes** (`06-ORANGELLM/server/routes/guardrails.mjs`, boundary, index dispatch, smoke test) — 5 routes mounted at 127.0.0.1:1337 behind `x-ae-operator-token` constant-time check against `ATOMEONS_IDENTITY_SECRET` (G-05 honored).

---

## Components

| Component | Files | Lines (key) |
|---|---|---|
| 27-guardrails-spec | `01-DOCTRINE/27-guardrails/spec.md` | 596 |
| guardrails-runtime | 39 files under `01-DOCTRINE/27-guardrails/` | runtime 132, server 122, registry 175, 27 g??-*.mjs checks + lib + tests |
| 27-guardrails-checks (parallel naming) | 29 files (check-util + 27 numbered + index) | check-util 154, 27 numbered checks, index 95 |
| soul-genome | `13-MODELS/orange-llm/soul_genome.json`, `genome-manager.mjs` | 257, 298 |
| continuity-generator | `04-CONTROL-PLANE/continuity/generator.mjs` + test + today's packet | 642, 223, 1 |
| continuity-loader | `04-CONTROL-PLANE/continuity/loader.mjs` + test | 657, 377 |
| orangellm-guardrails-gateway | `06-ORANGELLM/server/routes/guardrails.mjs`, `guardrails-boundary.mjs`, `boundary.mjs`, `index.mjs`, smoke test | 420, 49, 451 |

Total: **~80 files written**, roughly **5,500+ lines** of doctrine, runtime, and test code.

---

## Evidence

- **Runtime live sweep:** 27/27 checks executed under Node v24.14.1. Wave-2 sweep returned `ok=false, stop=true, elapsed_ms=18684, 6 violations` (G03 CRITICAL gate-chain naming, G09 CRITICAL CLAUDE.md path-detection, G10 HIGH pre-chain receipts, G12 HIGH old reality-lane writes, G15 MEDIUM continuity-packet pre-bootstrap, G22 MEDIUM cobra daemon not running). These are **real signal from the live tree**, not test artifacts. After continuity-generator wrote today's packet, G15 now passes.
- **Runtime tests:** 6/6 assertions pass (shape, 27 results, G27 self-check, elapsed_ms sane, Soul Genome materialized, backend resolved).
- **Continuity generator tests:** 15/15 unit tests pass — ET date math, dual-schema validation, progress filtering, blocker pickup, priority cascade, real ledger read, end-to-end dry-run with sha256.
- **Continuity loader tests:** 51/51 pass — date math, dual-schema validation, dual-naming lookup, malformed-packet refusal, throwing-adapter resilience, HTTP handler, routes-table sanity.
- **Gateway smoke tests:** 53/53 pass — boundary allow-list exact, forbidden headers block, operator-gate fails closed on missing/wrong token, authorized run persists with `backend=sqlite`, Soul Genome schema_mismatch on bogus schema, schema-v1 update roundtrip with sha256+updated_at, Continuity Packet present/absent paths.
- **Soul Genome roundtrip:** load → update → revert clean; 15 top-level keys; 27 invariants enumerated; render output ~3.3 KB.
- **Live CLI:** `node loader.mjs --no-flux --pretty` returned today's actual packet at `01-DOCTRINE/27-guardrails/state/continuity/2026-06-24.json` with `ok:true, stale:false`. Generator CLI wrote `2026-06-24.json` with `sha256 2dc52df2...`, picking up 1 hot current + 19 fresh receipts. Flux write verified against tmp ledger root: chained record `3f3894d1...` with `prev_hash=GENESIS`.
- **Live gateway:** 5 routes verified end-to-end behind boundary at `127.0.0.1:1337`. Backend reported `sqlite`. Operator-token gate confirmed constant-time, env-only.

---

## Honest gaps

These are named in the open per Mom's Law:

1. **Two parallel check directories.** The runtime agent authored `g??-*.mjs` (g01..g27) under `01-DOCTRINE/27-guardrails/checks/`; a sibling agent authored `01-*.mjs..27-*.mjs` in the same directory mapping to G-00..G-26 from spec.md. Both naming conventions coexist; the runtime only loads its own `g??-*` set via registry.mjs. **Release-steward must decide which set is canonical and delete the other.** I (this receipt-writer) did not unilaterally delete either — that would breach the no-silent-drift rule.
2. **better-sqlite3 not yet installed in default checkout.** Runtime falls back to JSONL at `state/runs.jsonl`. Next action: `npm install better-sqlite3` in `01-DOCTRINE/27-guardrails/`. Gateway smoke test injected its own sqlite path so its `backend=sqlite` claim is independent.
3. **Cron not yet registered.** The 23:50 ET (preferred: 23:55 in some component notes) continuity writer is implemented but not scheduled. Preferred path is systemd timer on Codexa (`OnCalendar=*-*-* 23:50, TZ=America/New_York`); Windows N150 fallback is `node generator.mjs --start` under a service supervisor.
4. **Reality Flux daemon (Cobra) was not reachable** from this Windows shell during the sweep. Flux writes were verified against synthesized ledger roots and via spool-on-unreach. G22 currently reports MEDIUM — by design, not blocking.
5. **Two continuity-cron timings drifted in notes** — one component says 23:50, another 23:55. Spec says **23:50 ET**. Treat 23:50 as canonical and align the writers + cron entries when scheduling.
6. **Two soul-genome paths drifted across components** — one set lives at `13-MODELS/orange-llm/soul_genome.json` (used by genome-manager.mjs), another references `01-DOCTRINE/27-guardrails/state/soul-genome.json` and `04-CONTROL-PLANE/continuity/.../soul_genome.json`. **Release-steward must pick one canonical path** (the spec implies `01-DOCTRINE/soul-genome/soul_genome.json`; the runtime currently uses the state-dir variant). G14/G17/G18 each reference a different path right now. This is the highest-priority reconciliation before any first-turn injection middleware ships.
7. **Soul Genome formatter touch-up.** A formatter reflowed inline invariant objects onto multi-line. Semantic content unchanged; 27 invariants still parse and enumerate.
8. **Gateway mount of `/v1/continuity/latest`** from `continuity/loader.mjs`'s `latestHandler` is not yet wired into `06-ORANGELLM/server/index.mjs` (only the guardrails routes were wired). One mount line + one boundary allow-list entry remain. Loader is gateway-ready and tested.
9. **Six live-sweep violations are real.** They are honest red flags from the doctrine layer about the rest of the tree, not bugs in this delivery.

---

## Next actions

1. **Reconcile parallel check directories** — release-steward picks `g??-*` vs `??-*` naming; loser is deleted; registry.mjs and checks/index.mjs are unified to one source of truth.
2. **Reconcile Soul Genome canonical path** — pick one of the three candidate locations; update genome-manager.mjs and the G14/G17/G18 checks to point at it; migrate any existing content.
3. **`npm install better-sqlite3`** in `01-DOCTRINE/27-guardrails/` to lift the runtime daemon off JSONL fallback.
4. **Schedule the 23:50 ET continuity cron** — systemd on Codexa preferred, Windows service-supervisor fallback on N150.
5. **Wire `/v1/continuity/latest`** into `06-ORANGELLM/server/index.mjs` + boundary allow-list (one line each).
6. **Address the 6 live-sweep violations** — at minimum G03 + G09 CRITICAL before any boot is allowed to claim "constitutional".
7. **Bring up the doctrine daemon** — `cd 01-DOCTRINE/27-guardrails && bun server.mjs` or `node server.mjs`; verify `GET /healthz` and `GET /latest` on `127.0.0.1:7460`.
8. **Wire AECC cockpit banner** to `GET /v1/guardrails/status` + `GET /v1/continuity-packet` via gateway for boot-time context injection.

---

## Doctrine fidelity check (Mom's Law)

- runtime/node.py sole authority — referenced as G-01, check authored.
- FOUNDER_SALARY_PER_INSTALL_CENTS env-bound — G-02, check authored.
- Gate 0 LBCE first — G-03, check authored; currently failing on live sweep (real signal).
- Human Final Stop reachable — G-04, check authored.
- ATOMEONS_IDENTITY_SECRET env-only — G-05, check authored; gateway honors it for operator-gated endpoints.
- Frontier-only-via-gateway — G-06, check authored.
- No code editor in operator surface — G-07, check authored.
- Four lanes immutable — G-08, check authored.
- Mom's Law above all — G-09 / G-00, check authored; currently failing on live sweep (real signal — name your tradeoffs, do not skate).
- Receipts hash-chained — G-10, check authored; **this receipt links prior_sha256 above**.
- No fake-green in commits — G-11, check authored.

No fake-green claimed. No simulation of real people. Every test count above is from real test runs. Every honest gap above is named, not hidden under good prose.

---

## Self-hash

This receipt's own sha256 will be computed and chained into the next receipt.

— end —
