// 08-HERMES / src/loom-fastpath.mjs
//
// LOOM 8-gate fastpath — an optimized, short-circuiting evaluator for the
// Hermes pre-flight chain. This is a SPEED + CLARITY optimization of the
// canonical evaluator in ./loom-gates.mjs (`runLoom`). It is NOT a policy
// change: for any input, `evaluateGates` returns the SAME per-gate pass/fail
// verdict and the SAME overall pass/fail as `runLoom`. Parity is proven in
// tests/loom-fastpath.test.mjs against a battery of actions.
//
// Why a fastpath at all
// ---------------------
// The hot path in Hermes is "gate every action before it lands." Under the
// LLM-over-Agent law (Master Plan §10) every action by OrangeBrain's agents
// AND by any superstack frontier model runs through this chain. `runLoom`
// evaluates all 8 gates unconditionally and builds a reason string for every
// gate even when the first one already sank the action. This module:
//
//   1. Precompiles the 8 gate predicates once, at module load, into an
//      ordered array of pure closures (no per-call array/closure allocation
//      of the predicate list itself).
//   2. Short-circuits on the first HARD fail — a gate whose failure is
//      dispositive for the whole chain. It stops evaluating further gates,
//      records `first_fail`, and returns. This mirrors how a real refusal
//      works: once the action is refused, the remaining checks are moot.
//   3. Times the evaluation with a monotonic clock and reports `elapsed_us`.
//
// Semantic parity contract (READ THIS)
// ------------------------------------
// The 8 gates and their pass conditions are lifted verbatim from
// `runLoom` in ./loom-gates.mjs:
//
//   1. order_schema      : ctx.order?.schema === "orange.order.v1"
//   2. report_schema     : ctx.report?.schema === "orange.report.v1"
//   3. receipt_spine     : Boolean(ctx.receipt_path)
//   4. human_approval    : lease.requires_approval ? Boolean(has_human_approval) : true
//   5. codexa_lease      : Boolean(lease)
//   6. openai_gateway    : Boolean(ctx.has_openai_gateway ?? true)
//   7. mcp_default       : Boolean(ctx.has_mcp_default ?? true)
//   8. false_green_guard : status contains no fake-green term
//
// Overall verdict: `passed === gate_results.every(g => g.pass)`.
//
// Short-circuit and parity live together because EVERY gate here is a hard
// gate: in `runLoom`, `pass` is `results.every(r => r.pass)`, so a single
// failing gate is always dispositive. Therefore short-circuiting on the
// first failure cannot change the overall verdict — it only changes how many
// gates we bothered to evaluate. To preserve byte-for-byte parity of the
// `gate_results` array with a caller that wants the FULL grid, pass
// `opts.shortCircuit = false` (or call `evaluateGatesFull`). The default is
// short-circuit ON, which is the throughput win.
//
// The fake-green term list, the `?? true` defaults for gates 6/7, and the
// approval logic for gate 4 are all identical to `runLoom`. If `runLoom`
// ever changes its doctrine, THIS FILE MUST CHANGE IN LOCKSTEP and the
// parity test will fail until it does — that is by design.
//
// Input shape
// -----------
// `evaluateGates(action, lease, ctx)` — the three-argument form the Hermes
// gateway binds to. The evaluator reads a single normalized context; the
// three arguments are folded into it so callers can pass whichever they
// have:
//   - `lease`               : the lease record (gate 5 presence, gate 4 flag).
//   - `action`              : the proposed action. `action.status` and
//                             `action.report?.status` feed gate 8; an
//                             action-level report also satisfies gate 2 if
//                             ctx does not carry one. `action` is optional —
//                             callers that already flattened everything into
//                             `ctx` may pass `null`.
//   - `ctx`                 : { order, report, receipt_path, status,
//                             has_human_approval, has_openai_gateway,
//                             has_mcp_default }. Any field also resolvable
//                             from `action`/`lease` may be omitted here.
//
// Precedence (explicit, matches how the gateway assembles context): an
// explicit `ctx` field wins; then the `action`/`lease` fallback; then the
// gate's own default. `status` resolves ctx.status → action.status. `report`
// resolves ctx.report → action.report. This lets the gateway pass a bare
// `(action, lease)` and still reproduce `runLoom(ctx)` exactly when the ctx
// fields are derivable from the action, while a caller that hands us a fully
// built ctx (as `runLoom` takes) gets identical results by leaving
// action/lease null.
//
// Honest gaps
// -----------
//   - This is the compact ctx-level evaluator, the same abstraction level as
//     `runLoom`: it checks the SHAPE MARKERS the chain cares about (schema
//     const strings, receipt-path presence, approval flag, lease presence,
//     gateway/mcp booleans, fake-green prose). It does NOT re-implement the
//     deep per-gate validators in ./loom-gates/0N-*.mjs (full JSON-schema
//     subset, receipt spine hash-chain walk, signed-approval queue, gateway
//     origin parsing, MCP handshake inspection). Those are a different,
//     heavier surface with a different signature (`{pass, reasons}` per gate,
//     async, one object per gate). The fastpath is the analogue of `runLoom`,
//     not of the gate modules. Wiring the deep validators behind this
//     signature is a separate task and must keep this parity test green.
//   - `elapsed_us` is wall-clock via `performance.now()` (sub-microsecond
//     resolution under Bun). It measures THIS evaluator's own time, not the
//     deep validators. It is advisory telemetry, not a policy input — no gate
//     reads it. Do not gate on it.
//   - fake-green detection here matches `runLoom`'s list exactly
//     (`green_assumed|looks_ok|probably|should_work|fake_green`) via
//     substring `includes` on the lowercased status. That is intentionally
//     the SAME (looser) check `runLoom` uses — NOT the word-boundary regex in
//     gate 8 (08-false-green.mjs). Parity is with `runLoom`, the evaluator
//     this file optimizes. The gate-8 module remains the strict authority for
//     the deep chain; nothing here weakens it.
//   - No I/O, no network, no allocation of the predicate list per call.
//     Bun-only per operator law (uses no Bun-specific API directly, but the
//     suite and the wider Hermes layer are Bun-only).

import { LOOM_GATES } from "./loom-gates.mjs";

// Re-export the canonical ordered gate id list so callers bind to one source
// of truth. Order is load-bearing: gate_results and first_fail follow it.
export { LOOM_GATES };

// Fake-green deny terms — IDENTICAL to runLoom's list in ./loom-gates.mjs.
// Frozen so a caller cannot mutate policy at runtime.
export const FAKE_GREEN_TERMS = Object.freeze([
  "green_assumed",
  "looks_ok",
  "probably",
  "should_work",
  "fake_green",
]);

/**
 * Resolve the status string the false_green_guard should inspect.
 * ctx.status wins; otherwise action.status. Coerced to string, never throws.
 * @returns {string} lowercased status ("" if none)
 */
function resolveStatus(action, ctx) {
  let s = ctx && ctx.status !== undefined && ctx.status !== null ? ctx.status : undefined;
  if (s === undefined && action && typeof action === "object" && !Array.isArray(action)) {
    if (action.status !== undefined && action.status !== null) s = action.status;
  }
  return typeof s === "string" ? s.toLowerCase() : s == null ? "" : String(s).toLowerCase();
}

/**
 * Resolve the report object gate 2 should read. ctx.report wins; otherwise
 * action.report. Returns whatever is there (validation is the gate's job).
 */
function resolveReport(action, ctx) {
  if (ctx && ctx.report !== undefined) return ctx.report;
  if (action && typeof action === "object" && !Array.isArray(action) && action.report !== undefined) {
    return action.report;
  }
  return undefined;
}

// ── Precompiled gate predicates ──────────────────────────────────────────────
//
// Each entry: { gate, hard, predicate }. `predicate(s)` returns
// { pass: boolean, reason?: string } given a normalized state `s`:
//   s = { order, report, receipt_path, status, lease,
//         has_human_approval, has_openai_gateway, has_mcp_default }
//
// `hard: true` means "if this fails, short-circuit the chain." All 8 LOOM
// gates are hard (runLoom's verdict is every()), so every entry is hard — the
// flag is kept explicit so a future soft/advisory gate can be added without
// restructuring, and so the short-circuit decision is data, not a magic
// constant buried in the loop.
//
// Built ONCE at module load. The array and its closures are shared across all
// calls; nothing here captures per-call state.
const GATE_PREDICATES = Object.freeze([
  {
    gate: "order_schema",
    hard: true,
    predicate: (s) =>
      s.order?.schema === "orange.order.v1"
        ? { pass: true }
        : { pass: false, reason: "order_schema not satisfied" },
  },
  {
    gate: "report_schema",
    hard: true,
    predicate: (s) =>
      s.report?.schema === "orange.report.v1"
        ? { pass: true }
        : { pass: false, reason: "report_schema not satisfied" },
  },
  {
    gate: "receipt_spine",
    hard: true,
    predicate: (s) =>
      s.receipt_path
        ? { pass: true }
        : { pass: false, reason: "receipt_spine not satisfied" },
  },
  {
    gate: "human_approval",
    hard: true,
    predicate: (s) => {
      // Mirror runLoom exactly: if the lease requires approval, an approval
      // signal must be present; otherwise the gate is a no-op pass. This is
      // the Human Final Stop invariant — it stays STRICT.
      const need = s.lease?.requires_approval;
      const ok = need ? Boolean(s.has_human_approval) : true;
      return ok
        ? { pass: true }
        : { pass: false, reason: "human_approval not satisfied" };
    },
  },
  {
    gate: "codexa_lease",
    hard: true,
    predicate: (s) =>
      s.lease
        ? { pass: true }
        : { pass: false, reason: "codexa_lease not satisfied" },
  },
  {
    gate: "openai_gateway",
    hard: true,
    // `?? true` default matches runLoom: absence is treated as satisfied
    // (non-LLM actions do not fail this gate). An explicit false fails.
    predicate: (s) =>
      Boolean(s.has_openai_gateway ?? true)
        ? { pass: true }
        : { pass: false, reason: "openai_gateway not satisfied" },
  },
  {
    gate: "mcp_default",
    hard: true,
    predicate: (s) =>
      Boolean(s.has_mcp_default ?? true)
        ? { pass: true }
        : { pass: false, reason: "mcp_default not satisfied" },
  },
  {
    gate: "false_green_guard",
    hard: true,
    // STRICT and identical to runLoom: any fake-green term anywhere in the
    // (lowercased) status is a hard fail. No fake-green, ever.
    predicate: (s) => {
      const status = s.status || "";
      for (let i = 0; i < FAKE_GREEN_TERMS.length; i++) {
        if (status.includes(FAKE_GREEN_TERMS[i])) {
          return { pass: false, reason: "fake-green word in status" };
        }
      }
      return { pass: true };
    },
  },
]);

// Compile-time sanity: the fastpath's gate order MUST equal the canonical
// LOOM_GATES order. If someone reorders one list and not the other, fail loud
// at import rather than silently drift. (Cheap: runs once at module load.)
{
  const mine = GATE_PREDICATES.map((g) => g.gate);
  const canon = LOOM_GATES;
  const same =
    mine.length === canon.length && mine.every((g, i) => g === canon[i]);
  if (!same) {
    throw new Error(
      `loom-fastpath: gate order drift vs LOOM_GATES\n  fastpath: ${JSON.stringify(mine)}\n  canonical: ${JSON.stringify(canon)}`,
    );
  }
}

/**
 * Fold (action, lease, ctx) into the single normalized state the predicates
 * read. Precedence: explicit ctx field → action/lease fallback → (gate
 * default applied inside the predicate).
 */
function normalize(action, lease, ctx) {
  const c = ctx && typeof ctx === "object" ? ctx : {};
  const resolvedLease = c.lease !== undefined ? c.lease : lease;
  return {
    order: c.order,
    report: resolveReport(action, c),
    receipt_path: c.receipt_path,
    status: resolveStatus(action, c),
    lease: resolvedLease,
    has_human_approval: c.has_human_approval,
    has_openai_gateway: c.has_openai_gateway,
    has_mcp_default: c.has_mcp_default,
  };
}

/**
 * @typedef {Object} GateResult
 * @property {string}  gate     — LOOM gate id
 * @property {boolean} pass
 * @property {string=} reason   — present only when pass === false
 * @property {boolean=} skipped — true if short-circuit stopped before this gate
 */

/**
 * @typedef {Object} LoomFastpathResult
 * @property {boolean}       passed        — true iff every EVALUATED hard gate passed
 * @property {GateResult[]}  gate_results  — one entry per gate, in LOOM order
 * @property {string|null}   first_fail    — gate id of the first failing gate, or null
 * @property {number}        elapsed_us    — evaluator wall time in microseconds
 */

/**
 * Optimized LOOM 8-gate evaluator. Short-circuits on the first hard fail.
 *
 * Semantic parity with runLoom(ctx): for identical inputs the per-gate
 * verdicts and the overall `passed` are identical. With short-circuit on
 * (default), gates after the first failure are reported as `{pass:false-not-
 * evaluated}` via `skipped:true` and are NOT counted against `passed` beyond
 * the dispositive first fail — but since a single fail already sinks the
 * chain, `passed` equals runLoom's `pass` regardless. For a full 8-row grid
 * identical to runLoom's `gates` array, pass `{ shortCircuit:false }`.
 *
 * @param {object|null} action
 * @param {object|null} lease
 * @param {object}      [ctx]
 * @param {{ shortCircuit?: boolean }} [opts]
 * @returns {LoomFastpathResult}
 */
export function evaluateGates(action, lease, ctx = {}, opts = {}) {
  const shortCircuit = opts.shortCircuit !== false; // default ON
  const t0 = performance.now();

  const s = normalize(action, lease, ctx);
  const gate_results = [];
  let firstFail = null;

  for (let i = 0; i < GATE_PREDICATES.length; i++) {
    const g = GATE_PREDICATES[i];

    if (firstFail !== null && shortCircuit && g.hard) {
      // Short-circuited: record the gate as unevaluated so the array length
      // and gate order are preserved for downstream loggers, but do not run
      // the predicate. `pass:false + skipped:true` is unambiguous.
      gate_results.push({ gate: g.gate, pass: false, skipped: true });
      continue;
    }

    const r = g.predicate(s);
    if (r.pass) {
      gate_results.push({ gate: g.gate, pass: true });
    } else {
      gate_results.push({ gate: g.gate, pass: false, reason: r.reason });
      if (firstFail === null) firstFail = g.gate;
    }
  }

  // `passed`: every gate that we actually evaluated must have passed. Skipped
  // gates only exist after a fail, so this is equivalent to "no fail at all".
  const passed = firstFail === null;
  const elapsed_us = (performance.now() - t0) * 1000;

  return { passed, gate_results, first_fail: firstFail, elapsed_us };
}

/**
 * Full-grid variant: evaluates ALL 8 gates unconditionally (no short-circuit)
 * and returns a gate_results array byte-for-byte comparable to runLoom's
 * `gates`. Thin wrapper over evaluateGates for callers/audits that want the
 * complete picture. Slower by design.
 *
 * @param {object|null} action
 * @param {object|null} lease
 * @param {object}      [ctx]
 * @returns {LoomFastpathResult}
 */
export function evaluateGatesFull(action, lease, ctx = {}) {
  return evaluateGates(action, lease, ctx, { shortCircuit: false });
}

// ── lease-throughput helper ──────────────────────────────────────────────────
//
// Batch lease-presence + approval-flag validation. This is the gate-4/gate-5
// slice of the chain applied across MANY leases at once — the shape the
// gateway needs when it is about to fan a burst of actions out under a set of
// leases and wants to reject the dead ones before spending a full 8-gate
// evaluation on each.
//
// It is deliberately NARROW: it answers "is this lease present and, if it
// demands approval, is approval on hand?" — the two lease-side hard gates that
// can be decided without an order/report/receipt. It does NOT re-implement the
// deep lease engine (expiry, actor match, allow/forbid) — that authority stays
// in ./lease-engine.mjs (checkAction) and gate 5's module. Use this to shed
// obviously-dead leases cheaply, then run the full evaluator on survivors.

/**
 * @typedef {Object} LeaseBatchItem
 * @property {object} lease
 * @property {boolean} [has_human_approval]
 */

/**
 * @typedef {Object} LeaseBatchResult
 * @property {number} index
 * @property {boolean} ok
 * @property {string|null} reason      — "no_lease" | "human_approval_required" | null
 * @property {string|undefined} lease_id
 */

/**
 * Validate a batch of leases for presence + approval readiness.
 *
 * @param {LeaseBatchItem[]} items
 * @returns {{ results: LeaseBatchResult[], ok_count: number, elapsed_us: number }}
 */
export function validateLeaseBatch(items) {
  const t0 = performance.now();
  const results = [];
  let ok_count = 0;

  const list = Array.isArray(items) ? items : [];
  for (let i = 0; i < list.length; i++) {
    const item = list[i] || {};
    const lease = item.lease;
    let ok = true;
    let reason = null;

    if (!lease || typeof lease !== "object" || Array.isArray(lease)) {
      ok = false;
      reason = "no_lease"; // gate 5 (codexa_lease) would reject
    } else if (lease.requires_approval && !item.has_human_approval) {
      ok = false;
      reason = "human_approval_required"; // gate 4 would reject — stays strict
    }

    if (ok) ok_count++;
    results.push({
      index: i,
      ok,
      reason,
      lease_id: lease && typeof lease === "object" ? lease.id : undefined,
    });
  }

  const elapsed_us = (performance.now() - t0) * 1000;
  return { results, ok_count, elapsed_us };
}

export default evaluateGates;
