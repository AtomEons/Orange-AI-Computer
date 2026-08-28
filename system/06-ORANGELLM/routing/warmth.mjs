// routing/warmth.mjs
//
// OrangeBrain routing improvement 2/6 — LANE-WARMTH TRACKER (Pillar 2).
//
// The least-action router (../router-least-action.mjs) already reads a warmth
// signal off the live Flowstate field (`field.warmth[lane].warmth`, derived by
// flow-pressure.summarizePressure). Inside pickLane that warmth is folded into
// the action score's `cold_term`, so a warm lane is preferred among eligible
// lanes. But the router is STATELESS: each pickLane call sees only the field
// snapshot it was handed. It has no memory of which lanes we actually spun up
// in previous decisions this session.
//
// This module is that memory. It maintains a small, decaying warmth ledger
// across decisions: every time OrangeBrain dispatches to a lane, that lane gets
// hotter; lanes cool over wall-clock time. The ledger can then PROJECT a
// systemState.warmth block that pickLane will consume, so the router's own
// warm-preference reflects real recent usage — not just the instantaneous
// field. "Prefer warm lanes" (router doctrine #4) becomes session-durable.
//
// Doctrine:
//   - The router stays the DECISION AUTHORITY. This module never picks a lane.
//     It only (a) tracks warmth, and (b) hands the router a systemState whose
//     `agents` block reflects the ledger, so pickLane's existing cold_term does
//     the preferring. We do NOT add a second "swap to warm lane" step — the
//     router's own note (lines 541-551) forbids double-counting warmth, and we
//     respect that: our output feeds the router's single warmth mechanism, it
//     does not bypass it.
//   - HONEST INTEGRATION: flow-pressure.laneWarmth (the function the REAL
//     router calls) does NOT read a `state.warmth` map. It derives warmth from
//     a per-lane BASELINE plus a bonus when an agent with `state:"riding"` and
//     `capability.lane === lane` is present. So to make the router SEE our
//     session warmth we project synthetic riding agents onto `state.agents` for
//     lanes the ledger says are hot — that is the actual input channel the
//     router reads. We never fabricate a warmth number the router would ignore.
//   - reflex is always_warm in LANE_TABLE; we honor that as a floor (its warmth
//     never decays below its always-warm baseline).
//   - Pure functional core. A tracker is a plain frozen-ish object; every
//     mutation returns a NEW tracker (no hidden shared state). Determinism:
//     same (tracker, event, now) -> same next tracker.
//
// Exports:
//   WARMTH_SCHEMA_ID
//   WARMTH_PARAMS                         -> frozen decay/heat constants
//   newWarmthTracker(opts?)               -> fresh tracker (all cold but reflex)
//   observeDispatch(tracker, laneId, now) -> tracker with laneId heated
//   decayTracker(tracker, now)            -> tracker cooled to `now`
//   warmthOf(tracker, laneId, now)        -> number 0..1 (decayed)
//   projectSystemState(tracker, now, base?) -> { warmth: {...} } for pickLane
//   warmestEligibleLane(order, tracker, systemState?, opts?) -> router-gated verdict
//   __warmthInternals

import {
  pickLane,
  LANE_TABLE,
  __routerInternals,
} from "../router-least-action.mjs";

export const WARMTH_SCHEMA_ID = "orange5.orangebrain.lane-warmth.v1";

const { LANE_INDEX } = __routerInternals;

// The lane ids, in table order, sourced from the REAL router table (never
// hardcoded separately — if the router's lanes change, this follows).
const LANE_IDS = Object.freeze(LANE_TABLE.map((l) => l.lane));

// Which lanes are always-warm per the router table (reflex today).
const ALWAYS_WARM = Object.freeze(
  LANE_TABLE.reduce((m, l) => ((m[l.lane] = !!l.always_warm), m), {}),
);

// ---------------------------------------------------------------------------
// Warmth physics (nameplate, stated as such).
//
//   heat_per_dispatch  — a dispatch adds this much warmth (saturating at 1).
//   half_life_ms       — warmth halves every this-many ms of idle wall time.
//   always_warm_floor  — always_warm lanes never cool below this.
//   warm_threshold     — warmth >= this reads as "warm" (matches the spirit of
//                        flow-pressure's own warm cutoff so the two agree).
// ---------------------------------------------------------------------------

export const WARMTH_PARAMS = Object.freeze({
  heat_per_dispatch: 0.6,
  half_life_ms: 120_000, // 2 min idle => warmth halves
  always_warm_floor: 1.0,
  warm_threshold: 0.5,
});

function clamp01(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function round4(n) {
  return Math.round(n * 1e4) / 1e4;
}

// Decay a single warmth value from its last-touch time to `now`.
function decayValue(warmth, lastMs, now, params) {
  if (!(now > lastMs)) return clamp01(warmth);
  const dt = now - lastMs;
  const factor = Math.pow(0.5, dt / params.half_life_ms);
  return clamp01(warmth * factor);
}

// ---------------------------------------------------------------------------
// newWarmthTracker — a fresh session ledger. Every lane cold, except lanes
// the router table marks always_warm (reflex), which start at the floor.
// ---------------------------------------------------------------------------

/**
 * @param {object} [opts]
 * @param {number} [opts.now] epoch ms to stamp the initial state (default 0 so
 *                            a fresh tracker is fully deterministic for tests).
 * @param {object} [opts.params] override WARMTH_PARAMS (merged).
 */
export function newWarmthTracker(opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : 0;
  const params = Object.freeze({ ...WARMTH_PARAMS, ...(opts.params || {}) });
  const lanes = {};
  for (const id of LANE_IDS) {
    const w = ALWAYS_WARM[id] ? params.always_warm_floor : 0;
    lanes[id] = { warmth: w, last_ms: now };
  }
  return Object.freeze({
    schema: WARMTH_SCHEMA_ID,
    params,
    updated_ms: now,
    lanes: Object.freeze(lanes),
  });
}

// ---------------------------------------------------------------------------
// observeDispatch — record that OrangeBrain dispatched to a lane at `now`.
// Decays all lanes to `now` first (so heat adds on top of the correctly-cooled
// baseline), then heats the dispatched lane. Returns a NEW tracker.
// ---------------------------------------------------------------------------

export function observeDispatch(tracker, laneId, now) {
  const t = decayTracker(tracker, now);
  if (LANE_INDEX[laneId] === undefined) {
    throw new RangeError(`unknown lane: ${String(laneId)} (expected one of ${LANE_IDS.join(", ")})`);
  }
  const cur = t.lanes[laneId];
  const heated = clamp01(cur.warmth + t.params.heat_per_dispatch);
  const floor = ALWAYS_WARM[laneId] ? t.params.always_warm_floor : 0;
  const lanes = { ...t.lanes, [laneId]: { warmth: Math.max(heated, floor), last_ms: now } };
  return Object.freeze({
    ...t,
    updated_ms: now,
    lanes: Object.freeze(lanes),
  });
}

// ---------------------------------------------------------------------------
// decayTracker — cool every lane to `now`. Idempotent for now<=updated_ms.
// ---------------------------------------------------------------------------

export function decayTracker(tracker, now) {
  const t = tracker;
  const when = Number.isFinite(now) ? now : t.updated_ms;
  const lanes = {};
  for (const id of LANE_IDS) {
    const cur = t.lanes[id] || { warmth: 0, last_ms: t.updated_ms };
    let w = decayValue(cur.warmth, cur.last_ms, when, t.params);
    if (ALWAYS_WARM[id]) w = Math.max(w, t.params.always_warm_floor);
    lanes[id] = { warmth: w, last_ms: when };
  }
  return Object.freeze({
    ...t,
    updated_ms: when,
    lanes: Object.freeze(lanes),
  });
}

// ---------------------------------------------------------------------------
// warmthOf — the decayed warmth of one lane at `now` (0..1).
// ---------------------------------------------------------------------------

export function warmthOf(tracker, laneId, now) {
  const cur = tracker.lanes[laneId];
  if (!cur) return 0;
  const when = Number.isFinite(now) ? now : tracker.updated_ms;
  let w = decayValue(cur.warmth, cur.last_ms, when, tracker.params);
  if (ALWAYS_WARM[laneId]) w = Math.max(w, tracker.params.always_warm_floor);
  return round4(w);
}

// ---------------------------------------------------------------------------
// projectSystemState — build a systemState the REAL router will actually read
// warmth from. flow-pressure.laneWarmth adds RIDING_WARMTH_BONUS (+0.5) to a
// lane's baseline when >=1 agent with state:"riding" and capability.lane===lane
// is present in state.agents. So for every lane whose ledger warmth clears the
// warm threshold, we inject ONE synthetic riding agent on that lane. That is
// the genuine channel the router consults — the router's field.warmth for the
// lane then reads `source:"field"` with the +0.5 bonus applied, and pickLane's
// cold_term reflects it. Lanes below threshold get no agent (router falls back
// to its own baseline warmth for them). We layer over any caller-provided
// agents so real live agents are preserved.
//
// We also surface a plain `warmth_ledger` map (decayed 0..1 values) on the
// returned state for downstream receipts/inspection — the router ignores it,
// and we never pretend it drives the decision.
// ---------------------------------------------------------------------------

/**
 * @param {object} tracker a warmth tracker
 * @param {number} now     epoch ms to decay to
 * @param {object} [base]  a base systemState to extend (currents/agents/deltas kept)
 * @returns {object} systemState with synthetic riding agents for warm lanes
 */
export function projectSystemState(tracker, now, base = {}) {
  const t = decayTracker(tracker, now);
  const baseAgents = base && typeof base.agents === "object" && base.agents ? base.agents : {};
  const agents = { ...baseAgents };
  const warmth_ledger = {};
  for (const id of LANE_IDS) {
    const w = round4(t.lanes[id].warmth);
    warmth_ledger[id] = w;
    // Only inject for warm, NON-always-warm lanes: reflex is always-warm via
    // BASELINE already (1.0), so a synthetic agent would be redundant. Injecting
    // a riding agent is what actually lifts a heavier lane's router warmth.
    if (!ALWAYS_WARM[id] && w >= t.params.warm_threshold) {
      agents[`__warmth_ledger_${id}`] = {
        id: `__warmth_ledger_${id}`,
        state: "riding",
        capability: { lane: id },
        synthetic: true,
      };
    }
  }
  return { ...base, agents, warmth_ledger };
}

// ---------------------------------------------------------------------------
// warmestEligibleLane — verdict: among lanes the REAL router certifies
// eligible for this order, which is warmest right now, and does the router's
// own pick (which already weighs warmth) land on it?
//
// This ROUTES THROUGH the router twice-over honestly:
//   1) It calls pickLane WITH our projected warmth so the router's decision
//      reflects the session ledger (not just the raw field).
//   2) It ranks the router's eligible scorecard by our warmth to report the
//      warmest-eligible lane and whether the router agreed. It never
//      substitutes its own choice — `router_lane` is the authority; warmth is
//      advisory + reported for the receipt.
// ---------------------------------------------------------------------------

/**
 * @param {object} order       an orange.order.v1 (or compatible partial)
 * @param {object} tracker     a warmth tracker
 * @param {object} [systemState] base Flowstate snapshot (warmth is overlaid)
 * @param {object} [opts]      pickLane opts ({cap, ts}); opts.now for warmth decay
 */
export function warmestEligibleLane(order, tracker, systemState = {}, opts = {}) {
  const now = Number.isFinite(opts.now) ? opts.now : (Number.isFinite(opts.ts) ? opts.ts : tracker.updated_ms);
  const projected = projectSystemState(tracker, now, systemState);
  const decision = pickLane(order, projected, opts);
  const eligible = decision.scorecard.filter((s) => s.eligible);

  if (decision.lane === null || eligible.length === 0) {
    return {
      schema: WARMTH_SCHEMA_ID,
      warmest_lane: null,
      warmth: 0,
      router_lane: null,
      router_chose_warmest: true, // both say "no lane" — trivially aligned
      decision_id: decision.decision_id,
      ladder: [],
      reason: decision.rationale,
    };
  }

  const ladder = eligible
    .map((s) => ({ lane: s.lane, warmth: warmthOf(tracker, s.lane, now), warm: warmthOf(tracker, s.lane, now) >= tracker.params.warm_threshold }))
    .sort((a, b) => {
      if (b.warmth !== a.warmth) return b.warmth - a.warmth; // warmest first
      return LANE_INDEX[a.lane] - LANE_INDEX[b.lane];        // tie -> cheaper
    });

  const warmest = ladder[0];
  const chose = decision.lane === warmest.lane;

  return {
    schema: WARMTH_SCHEMA_ID,
    warmest_lane: warmest.lane,
    warmth: warmest.warmth,
    router_lane: decision.lane,
    router_chose_warmest: chose,
    decision_id: decision.decision_id,
    ladder,
    reason: chose
      ? `router pick ${decision.lane} is also the warmest eligible lane (warmth=${warmest.warmth})`
      : `warmest eligible lane is ${warmest.lane} (warmth=${warmest.warmth}); router chose ${decision.lane} (cost/floor discipline outweighed warmth) — router pick stands`,
  };
}

export const __warmthInternals = Object.freeze({
  LANE_IDS,
  ALWAYS_WARM,
  clamp01,
  round4,
  decayValue,
});
