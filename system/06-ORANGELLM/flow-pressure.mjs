// flow-pressure.mjs
//
// OrangeBrain / Flowstate pressure-field model — PURE FUNCTIONS ONLY.
//
// Purpose:
//   The least-action router (router-least-action.mjs) needs a compact,
//   deterministic read of the live pressure field before it picks a model
//   lane. Master Plan §7 models the runtime as currents (work under
//   pressure), agents (workers riding currents), deltas (the event log), and
//   governors (backpressure rules). 05-FLOW/src/flow.mjs is the stateful
//   runtime that mutates that field; THIS module is the read-only physics
//   that turns a FlowState snapshot into three scalars the router keys on:
//
//     1. lane warmth        — is a lane already hot (cheap to reuse) or cold
//                             (must spin up)? Prefer warm lanes.
//     2. governor backpressure — how saturated is the field? High backpressure
//                             means "do not escalate to a bigger, slower lane
//                             right now; the system is already under load."
//     3. open-current pressure — the ambient demand on the field, used to
//                             bias the estimate and to decide whether a
//                             borderline order should hold at a cheaper lane.
//
// Doctrine (Mom's Law: real physics, no theater):
//   - Every function here is PURE. Same FlowState in -> same numbers out. No
//     Date.now(), no I/O, no mutation of the input. The router stays
//     deterministic because this layer is deterministic.
//   - We never invent field state. If a snapshot omits currents/agents, the
//     helpers return the calm-field defaults (warmth from the static lane
//     table, zero backpressure, zero ambient pressure) and SAY they defaulted
//     via the returned shape — no silent guess dressed as measurement.
//   - Numbers are bounded and named. Backpressure is [0,1]. Warmth is [0,1].
//     Ambient pressure is [0,1]. The router treats them as scales, not
//     probabilities.
//   - This module knows nothing about models or costs. It only reads the
//     field. Lane<->model<->cost mapping lives in the router. Keeping the
//     physics separate from the economics is deliberate.
//
// Exports:
//   LANES                       -> frozen canonical 5-lane superstack order
//   laneWarmth(state, lane)     -> { warmth:0..1, warm:boolean, source }
//   governorBackpressure(state, opts?) -> { backpressure:0..1, in_progress, cap, over, throttled_recently }
//   openCurrentsPressure(state) -> { ambient:0..1, open, max_pressure, mean_pressure }
//   summarizePressure(state, opts?) -> full field digest for one order
//   __pressureInternals         -> helpers for tests

// ---------------------------------------------------------------------------
// Canonical lane order — the 5-lane model superstack (Master Plan §8 / §5,
// echoed at Master Plan line 569: reflex / local-fast / local-code /
// subscription-frontier / tool-execution). The router names the two heavier
// reasoning lanes `heavy` and `frontier`; here we keep the runtime lane axis
// that Flowstate agents actually declare in capability.lane, PLUS the router
// lanes, so warmth can be read for either vocabulary.
// ---------------------------------------------------------------------------

export const LANES = Object.freeze([
  "reflex",      // qwen3:0.6b stock, N150, always-warm
  "local-fast",  // Codexa warm mid model
  "local-code",  // Qwen Coder Specialist, Codexa, warm on demand
  "heavy",       // Codexa fatty (qwen3:30b-a3b / warrant 70b)
  "frontier",    // BYO Opus / GPT / Gemini / GLM via Atomic Orange
]);

// Static baseline warmth per lane when the field carries no agent evidence.
// Reflex is always-warm by charter (§8 "always-warm"), so its floor is high.
// The heavier lanes are cold by default (they cost time/RAM to bring up) so
// the router pays a spin-up penalty unless the live field proves them hot.
const BASELINE_WARMTH = Object.freeze({
  reflex: 1.0,        // always-warm on N150 — never cold
  "local-fast": 0.5,  // Codexa warm-on-demand mid model
  "local-code": 0.35, // warm on demand
  heavy: 0.25,        // fatty; big footprint, usually needs a beat to warm
  frontier: 0.0,      // BYO remote; always a cold network round-trip
});

// How much a currently-riding agent on a lane raises that lane's warmth above
// baseline. A lane with an active agent is demonstrably hot.
const RIDING_WARMTH_BONUS = 0.5;

// ---------------------------------------------------------------------------
// small pure helpers
// ---------------------------------------------------------------------------

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function currentsOf(state) {
  const c = state && typeof state === "object" ? state.currents : null;
  return c && typeof c === "object" ? Object.values(c) : [];
}

function agentsOf(state) {
  const a = state && typeof state === "object" ? state.agents : null;
  return a && typeof a === "object" ? Object.values(a) : [];
}

function deltasOf(state) {
  const d = state && typeof state === "object" ? state.deltas : null;
  return Array.isArray(d) ? d : [];
}

// ---------------------------------------------------------------------------
// laneWarmth — is this lane hot?
// ---------------------------------------------------------------------------

/**
 * Read the warmth of a single lane from the field.
 *
 * Warmth = baseline(lane) + RIDING_WARMTH_BONUS if any agent whose
 * capability.lane === lane is currently 'riding'. Clamped to [0,1].
 *
 * @param {object} state  FlowState snapshot (may be partial/empty)
 * @param {string} lane   one of LANES
 * @returns {{ warmth:number, warm:boolean, source:'field'|'baseline', riding_agents:number }}
 */
export function laneWarmth(state, lane) {
  const baseline = BASELINE_WARMTH[lane];
  if (baseline === undefined) {
    // Unknown lane — treat as cold, and be explicit it isn't in the table.
    return { warmth: 0, warm: false, source: "baseline", riding_agents: 0 };
  }
  const riding = agentsOf(state).filter(
    (a) => a && a.state === "riding" && a.capability && a.capability.lane === lane,
  ).length;

  const warmth = clamp01(baseline + (riding > 0 ? RIDING_WARMTH_BONUS : 0));
  return {
    warmth,
    warm: warmth >= 0.5,
    source: riding > 0 ? "field" : "baseline",
    riding_agents: riding,
  };
}

// ---------------------------------------------------------------------------
// governorBackpressure — how saturated is the field?
// ---------------------------------------------------------------------------

/**
 * Model the concurrency governor as backpressure. Flowstate's built-in
 * governor throttles when in_progress currents exceed a cap (default 3, see
 * 05-FLOW/src/flow.mjs governorConcurrencyCap). We turn "how far over the
 * cap are we" into a [0,1] backpressure scalar, and separately report whether
 * the recent delta log shows the governor actually throttling.
 *
 * backpressure model:
 *   - in_progress <= cap        -> ramps 0 -> ~0.5 linearly across the cap
 *                                  (a full-but-not-over field already carries
 *                                  meaningful load and should discourage
 *                                  frivolous escalation).
 *   - in_progress  > cap        -> 0.5 .. 1.0, saturating as overflow grows.
 *
 * @param {object} state FlowState snapshot
 * @param {object} [opts]
 * @param {number} [opts.cap=3]              concurrency cap (match the runtime)
 * @param {number} [opts.throttle_window=25] how many trailing deltas to scan
 *                                           for governor_throttled evidence
 * @returns {{ backpressure:number, in_progress:number, cap:number, over:number, throttled_recently:boolean }}
 */
export function governorBackpressure(state, { cap = 3, throttle_window = 25 } = {}) {
  const capSafe = Number.isFinite(cap) && cap > 0 ? cap : 3;
  const inProgress = currentsOf(state).filter((c) => c && c.status === "in_progress").length;

  let backpressure;
  if (inProgress <= capSafe) {
    // 0 at empty, ~0.5 at exactly cap.
    backpressure = 0.5 * (inProgress / capSafe);
  } else {
    const over = inProgress - capSafe;
    // 0.5 at cap+0, approaching 1.0 as overflow grows (over/(over+cap) shape).
    backpressure = 0.5 + 0.5 * (over / (over + capSafe));
  }

  const recent = deltasOf(state).slice(-Math.max(1, throttle_window));
  const throttledRecently = recent.some((d) => d && d.kind === "governor_throttled");

  return {
    backpressure: clamp01(backpressure),
    in_progress: inProgress,
    cap: capSafe,
    over: Math.max(0, inProgress - capSafe),
    throttled_recently: throttledRecently,
  };
}

// ---------------------------------------------------------------------------
// openCurrentsPressure — ambient demand on the field
// ---------------------------------------------------------------------------

/**
 * Summarize the pressure carried by open (pending or in_progress) currents.
 * `ambient` blends the peak and mean open pressure so a single screaming
 * current AND a field full of medium currents both register.
 *
 * @param {object} state FlowState snapshot
 * @returns {{ ambient:number, open:number, max_pressure:number, mean_pressure:number }}
 */
export function openCurrentsPressure(state) {
  const open = currentsOf(state).filter(
    (c) => c && (c.status === "pending" || c.status === "in_progress"),
  );
  if (open.length === 0) {
    return { ambient: 0, open: 0, max_pressure: 0, mean_pressure: 0 };
  }
  let sum = 0;
  let max = 0;
  for (const c of open) {
    const p = clamp01(typeof c.pressure === "number" ? c.pressure : 0);
    sum += p;
    if (p > max) max = p;
  }
  const mean = sum / open.length;
  // Peak-weighted blend: 60% peak, 40% mean. Bounded [0,1].
  const ambient = clamp01(0.6 * max + 0.4 * mean);
  return { ambient, open: open.length, max_pressure: max, mean_pressure: mean };
}

// ---------------------------------------------------------------------------
// summarizePressure — one call the router makes per order
// ---------------------------------------------------------------------------

/**
 * Produce the full field digest the router consumes for a single routing
 * decision. Pure: derived entirely from `state` + `opts`.
 *
 * @param {object} state FlowState snapshot (may be null/partial/empty)
 * @param {object} [opts]
 * @param {number} [opts.cap=3]
 * @returns {{
 *   warmth: Record<string,{warmth:number,warm:boolean,source:string,riding_agents:number}>,
 *   governor: ReturnType<typeof governorBackpressure>,
 *   ambient: ReturnType<typeof openCurrentsPressure>,
 *   field_present: boolean
 * }}
 */
export function summarizePressure(state, { cap = 3 } = {}) {
  const fieldPresent =
    !!state &&
    typeof state === "object" &&
    (currentsOf(state).length > 0 || agentsOf(state).length > 0);

  const warmth = {};
  for (const lane of LANES) warmth[lane] = laneWarmth(state, lane);

  return {
    warmth,
    governor: governorBackpressure(state, { cap }),
    ambient: openCurrentsPressure(state),
    field_present: fieldPresent,
  };
}

// ---------------------------------------------------------------------------
// internals for tests
// ---------------------------------------------------------------------------

export const __pressureInternals = Object.freeze({
  clamp01,
  currentsOf,
  agentsOf,
  deltasOf,
  BASELINE_WARMTH,
  RIDING_WARMTH_BONUS,
});
