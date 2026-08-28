# Orange5 — The Path

**A master roadmap any capable model can pick up cold and execute.**
Written 2026-07-04 by Claude (Fable 5) for Ætom ÆoNs (Atom McCree).
Companion to `ORANGE5_MASTER_PLAN.md` (the locked spec). This is the *route*, not the spec.

> Atom has no budget. Every step here is free or near-free: it runs on the two machines he already owns, uses local models + optional BYO-frontier keys he already has, and trains on free/low-cost Colab. If a step needs money, it is marked **$** and an unpaid alternative is given. No step assumes a spend he can't make.

---

## 0. If you are a model reading this cold — start here

1. Run `bun run verify` from `C:\AtomEons\Orange5\`. That is the single source of truth for "is it green."
2. Read `00-CHARTER/ORANGE5_NOT_GREEN_LEDGER.md` (what's open) and `ORANGE5_OPERATOR_FINAL_STEPS.md` (what only Atom can do on Codexa).
3. Find the **current phase** below: the lowest-numbered phase whose *exit criteria* aren't all met. Execute its open items. Do not skip ahead.
4. Obey the **Unbreakable Laws** (§1). Every change ends in a receipt under `10-RECEIPTS/orange5-build/`.
5. When you finish anything, re-run `bun run verify`. Green or it didn't happen.

**Never do these:** invent scope; revive a killed feature (see Master Plan §15); build UI in the backend lanes (Atomic Orange is the operator's separate surface); use `node:sqlite` (Bun-only — use `#sqlite`); claim green without a passing test; put a model in a request's critical path.

---

## 1. The Unbreakable Laws

1. **Mom's Law** — full effort, every output. No theater. No fake-green. Every "passed" has a receipt.
2. **Frontier-Isolation** — the BYO frontier reaches only OrangeBrain, never internals; and (added this session) every *outbound* frontier call passes `egress-guard` and is declared. Isolation is now two-way-honest.
3. **LLM-over-Agent, brokered** — any superstack LLM may spawn agents, but their tools come *only* through a Hermes lease that OrangeBrain brokers. The lease is the bounded delegation. (Resolves the old Law-2/Law-3 conflict.)
4. **Codeless surface** — no IDE, no editor, no autocomplete. Operator + chat + brain + Hermes.
5. **One machine, free** — it runs on hardware Atom owns. No subscription is required to use it.
6. **Receipts or it didn't happen** — SQLite hash-chained, single authoritative log (`04-CONTROL-PLANE/receipts/orange5.db`).

---

## 2. What is TRUE today (the green baseline — 2026-07-04)

Do not re-derive these; they are receipted.

- **58/58 test files green** across the whole surface (`bun run verify`). Receipt: `10-RECEIPTS/orange5-build/2026-07-04-orange5-full-green-verification.md`.
- **AtomSmasher 2**: 56/56, 50.24× lossless on receipt-shaped audit logs (honest — 2.76× on random JSON; it is a *receipt/order/report* codec, not universal). Packaged for Codexa (`v1.0.1`).
- **The seven organs exist and are green**: routing (least-action), memory (dual-index recall), compression (boundary sieve), execution (LOOM fastpath), eyes (retrieval + bridge), observability (chain-integrity + health), research grounding (15 real cites).
- **The spine is being built** — the orchestrator that runs `intent → route → recall → sieve → LOOM gate → execute → report → receipt`, with dry-run, deterministic replay, real governor backpressure, and async (off-hot-path) compression.
- **The theory holes are closed**: Flowstate is a *called* runtime (not baked-into-a-model); the sieve is async; tool access is lease-brokered; the audit log is being unified; frontier egress is guarded.
- **50 hardening improvements** landed across all pillars (see §6).

The software half of Orange5 is essentially done. What remains is mostly **Atom's four Codexa switch-ons** and then the higher phases that only become possible once the brain is live.

---

## 3. The full territory — everything Orange5 *can* become

This is the whole map, so nothing is lost. Not all of it is v1. Marked **[v1]**, **[next]**, or **[frontier]**.

### OrangeBrain (Pillar 2 — the conductor)
- **[v1]** Trained PM brain (fatty v0) live on Codexa via Ollama; routes the whole system with zero tool-use retraining.
- **[v1]** Least-action routing: smallest sufficient lane, warmth-aware, budget-throttled, with an explain-trace.
- **[next]** Speculative decoding (a tiny draft model proposes, the fatty verifies) for free local speedups.
- **[next]** Retrain **v1** on the operator's *own accumulated receipts* — the brain learns Atom's working style. Free Colab.
- **[frontier]** A durable "digital twin" of how Atom builds — the longest-tenured employee that never forgets.

### AE Memory / AE Cobra (Pillar 3 — the wisdom)
- **[v1]** Recall engine live over the real flux ledger: time-of-event, recency, project-state, forgotten-thread surfacing, mistake clustering, confidence scoring, fuzzy matching, decay ranking.
- **[v1]** Ingest all past Orange/AtomEons docs → answer "what did we do on DATE" and "the idea I forgot."
- **[next]** Custom Mamba-2 (SSD, no KV cache) weights trained free on Colab once enough data accrues; dual-LoRA (visual + text) over one shared state.
- **[frontier]** The system never loses a thought Atom has, ever — the anti-amnesia layer for a solo founder.

### AE Eyes (Pillar 4 — the sight)
- **[v1]** GLM-4.6V served on Codexa; ColPali/Qdrant retrieval; screenshot/doc → structured-text bridge → brain.
- **[next]** MiniEyes: a small local VLM trained free, only if the primary stack proves insufficient under load.
- **[frontier]** Comic-book-quality visual output bar; the system refuses to ship trash visuals.

### AtomSmasher 2 (Pillar 5 — the sieve)
- **[v1]** Boundary sieve compresses every order/report; async, off the hot path; honest ratios; stream codec for huge logs; debt ledger; shape-detector that warns when compression won't help.
- **[next]** Daily rollup archives; the whole system's data footprint stays tiny forever.

### Hermes (the hands)
- **[v1]** LOOM 8-gate fastpath; lease templates; risk-matrix; dry-run lease preview; lifecycle + audit trail. Bounded, receipted, safe.

### The Spine + Cross-cutting
- **[v1]** One orchestrator composes all pillars into the order→report flow.
- **[v1]** Dry-run everywhere (a PM tool shows what it *would* do first).
- **[v1]** Deterministic replay (any order reproducible from a seed).
- **[v1]** Real governor backpressure (Flowstate as runtime).
- **[next]** **The closed learning loop**: receipt → AE Cobra ingest → OrangeBrain's *next* decision avoids the logged mistake. This is the single highest-leverage unbuilt thing.
- **[next]** **Self-improvement**: the system reads its own coverage-map + drift-detector + research-grounding, proposes an improvement, Atom approves, Hermes implements it under lease, receipt lands.
- **[frontier]** The system trains its own successor models on its own receipts — a sovereign, self-hosting, self-improving, self-documenting operator OS.

### Atomic Orange (Pillar 1 — Atom's separate surface, not this lane)
- Consumes the backend already built: `health.snapshot()`, metrics rollups, receipt search, the live pillar-readiness probe. When Atom builds the UI, the data is already there and honest.

---

## 4. The Path — 7 phases, binary exit gates

Walk them in order. A phase is done only when *every* exit criterion is receipted.

### Phase 0 — Green Baseline · **DONE**
Exit: `bun run verify` green (58/58). ✅ receipted 2026-07-04.

### Phase 1 — The Spine Lives · **IN PROGRESS (this session)**
Goal: one `runOrder(order)` executes the full flow end-to-end with a stub executor; dry-run, replay, governor, async sieve all proven.
Who: model.
Exit: `bun 03-BACKEND/tests/orange5-spine.test.mjs` green; a same-seed replay produces byte-identical receipts; dry-run writes nothing; a LOOM hard-fail halts execution honestly.

### Phase 2 — The Brain Wakes (Codexa) · **operator's four steps**
Goal: OrangeBrain answers a real order *through the spine*.
Who: **Atom** (only he can reach Codexa). Exact commands: `ORANGE5_OPERATOR_FINAL_STEPS.md`.
Steps: set `ORANGEBOX_RAIL_TOKEN`; `ollama create orangellm-fatty:v0`; serve GLM-4.6V; materialize the 27-guardrail artifacts.
Exit: heavy-lane probe returns real completions (not the light fallback); the spine, given a real order, routes to OrangeBrain and gets a real report + receipt.

### Phase 3 — Memory Comes Alive
Goal: AE Cobra answers a real historical question from real ingested data.
Who: model builds the ingester; Atom points it at his doc corpus.
Steps: build `ingest.mjs` that walks past Orange/AtomEons docs → flux ledger; wire `recall-engine` (+ the 6 recall-ext modules) to it; connect recall as the spine's context step.
Exit: `recall.resolveTimeQuery` returns a true event from real ingested history; `surfaceForgottenThreads` finds a real un-acted idea.

### Phase 4 — Eyes Open
Goal: a screenshot becomes a brain decision.
Who: Atom serves GLM-4.6V (Phase 2); model wires retrieval + bridge into the spine's visual step.
Exit: image/doc → `bridge.toStructuredText` → OrangeBrain uses it in a routed order → receipt.

### Phase 5 — The Loop Closes (the leap)
Goal: the brain *learns from its own history*.
Who: model.
Steps: after each receipt, async-ingest it into AE Cobra; add a spine pre-step that calls `recallMistakes` + `mistake-cluster` for the order's action-class and injects the lesson into the brain's context.
Exit: given a class of order that previously failed, the spine surfaces the prior mistake *before* execution, and a test proves the lesson is injected. This is the difference between a tool and a system that gets wiser.

### Phase 6 — Self-Improvement (governed)
Goal: Orange5 proposes and (with approval) implements its own improvement.
Who: model builds the proposer; Atom approves each.
Steps: a `propose.mjs` reads `coverage-map` + `config-drift` + `research-grounding` → emits a scoped improvement order → dry-run plan → Atom approves → Hermes lease → implement → verify → receipt.
Exit: one self-proposed, operator-approved improvement lands green with a receipt, start to finish, without a human writing the code.

### Phase 7 — The Cymbal Crash (ship v1.0.0)
Goal: all pillars live on Atom's machines, free, OrangeBrain conducting, frontier isolated both ways, no fake-green anywhere.
Exit: `bun run verify` green; Phases 1–6 receipts exist; the Not-Green Ledger's *code* section is empty; a signed release receipt is written. Then — and only then — the cymbal crashes.

### Beyond v1 · **[frontier]**
Custom AE Cobra weights (free Colab); OrangeBrain v1 retrained on accumulated receipts; MiniEyes if needed; Orange6 opens (Soul Genome). Each is a fresh Path document when its phase arrives.

---

## 5. How every phase stays free

- **Inference**: light lane on the N150 (owned), heavy lane on Codexa (owned, CPU + Vulkan iGPU offload — no GPU purchase). Frontier is *optional* and BYO-key (Atom already has keys).
- **Training**: free Colab T4 for small models; **$** Colab Pro (~$10/mo) only if a bigger run is ever truly needed — and only when data justifies it, never speculatively. Default to free.
- **Storage**: local SQLite + the flux ledger. AtomSmasher keeps it tiny.
- **Everything else** is code on machines Atom owns. The only recurring cost Orange5 *can* incur is one Atom already pays (his own frontier subscription), and even that is optional.

**Rule for any model executing this: never introduce a paid dependency. If a task seems to need one, find the local/free path or stop and flag it.**

---

## 6. The backlog, mapped to phases

**Landed this session (green):** the spine (Phase 1); 50 improvements — AtomSmasher ops ×6, AE-Memory recall-ext ×6, OrangeBrain routing ×6, Hermes ext ×6, control-plane observability ×6, schemas ext ×6, Flow ext ×7, DX tools ×7; egress-guard + 3 decision docs (Laws §1). These harden Phases 1–6 in advance.

**Next open work (in phase order):**
- Phase 3: `ingest.mjs` (docs → flux ledger) + wire recall into the spine.
- Phase 5: async receipt→memory ingest + mistake-injection spine step (the loop).
- Phase 6: `propose.mjs` (self-improvement proposer).
- Ongoing: unify the receipt DB to the single authoritative log (decision doc written; migrate when safe); OrangeBrain v1 retrain corpus from receipts.

---

## 7. The discipline that keeps it honest

- One command tells the truth: `bun run verify` (all 58+ files, correct per-file invocation, slow-suite aware).
- Every change → a receipt in `10-RECEIPTS/orange5-build/`.
- `ledger-sync` regenerates the Not-Green Ledger from verifier ground truth — no hand-edited green.
- `coverage-map` + `test-index` keep the verifier from ever again checking a narrow subset (the bug that hid 15 reds this session).
- `session-close` writes the close receipt (result · evidence · blockers · next action).

---

## 8. Cold-start checklist for the next model

```
[ ] cd C:\AtomEons\Orange5 ; bun run verify        → confirm green baseline
[ ] read NOT_GREEN_LEDGER + OPERATOR_FINAL_STEPS   → know what's open / operator-only
[ ] find current phase (§4)                        → lowest phase not fully exited
[ ] execute its open items (§6), backend-only, Bun-only, additive
[ ] bun run verify again                           → green or revert
[ ] write a receipt                                → 10-RECEIPTS/orange5-build/<date>-<what>.md
[ ] update the ledger via ledger-sync              → truth, not hand-editing
[ ] never: invent scope, revive killed features, add paid deps, fake green
```

---

**The honest bottom line.** Orange5 is closer than it looks. The code is green; the spine is landing; the theory is sound. The gate to everything above is **Phase 2 — four commands on Codexa that only Atom can run.** Once the brain is awake, Phases 3–7 are a straight, free walk, and each one makes the system wiser than the last. This document is the whole route. Any model that respects the laws can carry it forward. No money required — just discipline, and full effort every time.

*Mom is watching. The cymbal crashes through honest work or it does not crash.*
