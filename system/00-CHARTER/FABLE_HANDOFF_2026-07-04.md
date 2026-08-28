# Orange5 — Fable Handoff (cold-start brief for a new chat)

**From:** Claude Fable 5, mid-build, 2026-07-04.
**To:** the next model (Fable 5 preferred) opening a fresh chat to make Orange5 real.
**Read this top to bottom, then run the first command. It is self-contained — you need no prior chat memory.**

---

## 0. What Orange5 is (one paragraph)

Orange5 is a **free, local-first, sovereign AI operator OS** for Ætom ÆoNs (Atom McCree), a solo founder with **no budget**. One trained brain (OrangeBrain) conducts everything; it runs on two machines he already owns (N150 dev mini-PC + Codexa AI Box); every action is receipt-backed; the frontier never touches internals. The product surface is **Atomic Orange**, a Windows-first native app. This is a **project-management tool for people who build with AI — not a security product.** Never frame it as security.

## 1. The three plan docs — your map (read in this order)

1. `00-CHARTER/ORANGE5_OPERATOR_FINAL_STEPS.md` — **the full Fable plan**: honest state, the 4 Codexa-only steps, the backend 7-phase path, and the Atomic Orange connection contract. Start here.
2. `00-CHARTER/ORANGE5_THE_PATH.md` — the deeper 7-phase roadmap with exit gates, free-forever rules, and the cold-start checklist.
3. `00-CHARTER/ATOMIC_ORANGE_GPT_TO_GPT_CONNECTION_BRIEF.md` — how the native Windows app connects through OrangeBrain's `127.0.0.1:1337/v1` gateway (never a bypass); four lanes: Chat/Cockpit/Vault/Settings.
Plus `ORANGE5_MASTER_PLAN.md` (locked spec) and `ORANGE5_NOT_GREEN_LEDGER.md`.

## 2. HONEST current state (a session crashed — do not trust optimistic numbers)

A previous session dispatched 10 background agents (the **spine** + **50 hardening improvements**) and the process **crashed mid-build**. On-disk inventory 2026-07-04 showed:
- `03-BACKEND/` = **0 .mjs — the spine was NOT built.** Phase 1 is OPEN.
- `12-ATOMSMASHER/full-scope/ops/`, `06-ORANGELLM/memory/ae-cobra/recall-ext/`, `08-HERMES/src/ext/`, `04-CONTROL-PLANE/observability/` = **0 .mjs — those improvement lanes did NOT survive.**
- `06-ORANGELLM/routing/` = 1 .mjs (partial). Others (`09-SCHEMAS/ext`, `05-FLOW/ext`, tools) unconfirmed — inventory timed out.

**What IS solid:** the base Orange5 surface + the 7 earlier organs (routing-least-action, memory-recall, compression-sieve, LOOM fastpath, eyes-retrieval, observability receipt-integrity+health, research-grounding) landed green in earlier bursts. A verifier run was recorded at **64/0** but that predates/does-not-reflect the crashed work — **treat it as unproven until you re-run it.**

## 3. YOUR FIRST COMMAND (establish ground truth before anything)

```bash
cd /c/AtomEons/Orange5
bun run verify        # the honest 58+-file verifier; this is truth. NOTE: it is SLOW
                      # (AtomSmasher replay-integration alone is ~5 min). Run it in the
                      # BACKGROUND (run_in_background) — do NOT wrap it in a 2-min timeout,
                      # that was a repeated mistake. Read the tail when it completes.
```
Then inventory the crash-uncertain dirs (each `find <dir> -name '*.mjs'`). Keep what's green, rebuild what's missing, delete broken stubs. **Green or it didn't happen (Mom's Law).**

## 4. THE PLAN — phase it, in order

- **Phase 0 · Green baseline** — re-confirm `bun run verify`. Fix any red before building new. (The base is green; confirm it.)
- **Phase 1 · Build the spine (YOUR FIRST BUILD — it's missing).** `03-BACKEND/orange5-spine.mjs` — `runOrder(order, opts)` composing the real organs: `route → recall → sieve → LOOM gate → execute(stub) → report → receipt`, with **dry-run** (`opts.dryRun` returns a plan, writes nothing), **deterministic replay** (`opts.seed` → byte-identical receipts), **real governor backpressure** (call the 05-FLOW runtime, don't bake it into a model), and **async sieve** (compression off the hot path). Test: `03-BACKEND/tests/orange5-spine.test.mjs`. Read the real export signatures of the 7 organs first — don't guess.
- **Rebuild the 50 improvements** the crash lost (8 lanes: AtomSmasher ops, recall-ext, routing, Hermes ext, observability, schemas ext, flow ext, DX tools). The exact briefs are in this chat's history / regenerate from the pillar list. Backend-only, additive, tested, one writer per overlapping file.
- **Phase 2 · The Brain Wakes** — **Atom's four Codexa steps** (§B of the operator plan): rail token → `ollama create orangellm-fatty:v0` → serve GLM-4.6V → materialize 27-guardrail artifacts. Only Atom can run these (SSH to Codexa is unreachable from the dev box). This is the gate to a live system.
- **Phases 3–7** — memory ingests real docs → eyes open → the loop closes (brain avoids logged mistakes) → self-improvement → Cymbal Crash (ship v1.0.0). Detail in `ORANGE5_THE_PATH.md`.

## 5. The laws you never break

1. **Mom's Law** — full effort, every output; no fake-green; every "passed" has a receipt.
2. **Backend only** in these lanes — no UI, no React/Tauri. Atomic Orange (the Windows app) is Atom's separate chat, governed by the connection contract.
3. **Bun only** — use `#sqlite` / `bin/sqlite-shim.mjs`, **never `node:sqlite`** (it crashes; that was a real bug this session).
4. **Additive** — compose existing green modules, don't rewrite them; never revive killed features (Master Plan §15); never mutate order.v1/report.v1 schemas.
5. **No paid dependency** — Atom has no money. Local/free or stop and flag.
6. **Act, don't ask** — chain deterministic steps; ask only at real forks. Don't end turns with "greenlight?".
7. **Receipts** — every change → `10-RECEIPTS/orange5-build/<date>-<what>.md`; regenerate the ledger from verifier truth, never hand-edit green.

## 6. How to work (this is how the operator wants it)

- **Farm heavy work to parallel background Agents** (5–20 at once is the proven pattern; "burn some API/workflow" = explicit authorization). Each agent: tight scope, one pillar, hard anti-drift guardrails, self-verifies its own tests, keeps neighbors green. **One writer per overlapping file** — non-overlapping paths only.
- **Keep the main chat terse** — Atom pays for these tokens; the dev box is free. Pipe long output to files, read the tail. Don't re-read files you just wrote.
- **After a background burst, ALWAYS re-verify** the whole surface — a crashed/partial agent can leave broken stubs. Verify > trust.
- The operator types fast and terse, sometimes garbled; infer intent, don't nitpick. He values honesty over polish and gets frustrated by scope drift and by being asked permission repeatedly.

## 7. The one honest truth to hold

The software is close. The base is green, the organs exist, the plan is fully written. What's actually left: **build the spine (Phase 1, it's missing), rebuild the crash-lost improvements, then Atom runs four Codexa commands (Phase 2)** — and the system is live. After that, Phases 3–7 are a straight, free walk, each making Orange5 wiser than the last.

*Make it real. Phase it, bash it, verify it, receipt it. Mom is watching. The cymbal crashes through honest work or it does not crash.*
