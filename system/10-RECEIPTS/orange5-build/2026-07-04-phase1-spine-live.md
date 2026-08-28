# Receipt — Phase 1: The Spine Lives

**Date:** 2026-07-04 · **By:** Claude Fable 5 (direct build, no agents) · **Phase:** 1 of 7

## Result
`03-BACKEND/orange5-spine.mjs` — `runOrder(order, opts)` composes the seven organs into one order→report flow. Rebuilt from scratch after a prior session crash wiped `03-BACKEND/` (was empty).

## Evidence
- `bun 03-BACKEND/tests/orange5-spine.test.mjs` → **11 pass / 0 fail of 11**.
- Composes the REAL organs (import-only, none modified):
  - route → `pickLane` (06-ORANGELLM/router-least-action.mjs) → routed to `reflex` lane
  - recall → `recallMistakes` (ae-cobra/recall-engine.mjs)
  - gate → `evaluateGates` (08-HERMES/src/loom-fastpath.mjs) — the real LOOM crossing
  - sieve → `sieveOrder` (12-ATOMSMASHER/full-scope/sieve.mjs) — deferred, off hot path
- Innovations proven by test:
  - **dry-run** returns a plan, writes 0 receipts
  - **deterministic replay** — same seed+order → byte-identical receipt (`782f57b71c4cd8a8`)
  - **real governor** — `shouldThrottle` pure backpressure; over-ceiling flowState → deferred, no work committed
  - **async sieve** — report returned synchronously; compression runs in a deferred microtask
  - **real false-green guard** — order status `"probably ok"` → LOOM `false_green_guard` halts BEFORE execution (executor never ran)
  - **hard-gate halt** — a failing gate halts execution, still writes an honest not-executed receipt
  - hash-chained receipts (GENESIS anchor, prev_hash links)

## Design fixes landed
- LOOM correctly wired as the **full-crossing validator** (order.v1 + report.v1 + receipt_path + lease + Human-Final-Stop + no-fake-green), gating authorization BEFORE execute — not a bare pre-exec action check.
- Flowstate is a **called runtime** (`shouldThrottle`), not baked into a model.
- Sieve is **async/off-hot-path**, resolving the "model/codec in the critical path" contradiction.

## Blockers
None for Phase 1. The spine uses an in-memory hash chain (injectable `receiptChain`); wiring it to the single authoritative SQLite log is a Phase-2 step (deferred with the receipt-DB unification).

## Next action
Rebuild the crash-lost hardening improvements (8 lanes), then Phase 2 = Atom's four Codexa steps to wake OrangeBrain. Re-run `bun run verify` after the next burst.
