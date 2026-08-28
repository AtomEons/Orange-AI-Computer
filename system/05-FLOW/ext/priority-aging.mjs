// Flowstate ext — priority aging (anti-starvation).
// Path: 05-FLOW/ext/priority-aging.mjs
//
// The core scheduler assigns agents strictly by pressure. A 0.2-pressure
// current behind a steady stream of 0.8s waits forever. This module ages
// pending currents: effective pressure grows linearly with waited time, so
// every current eventually wins an agent.
//
// agedPressure / rankPending are pure. applyAging mutates only fields on
// the state object it is handed (current.pressure, a base_pressure stash,
// updated_at) and appends deltas — it never touches 05-FLOW/src modules.
// Idempotent for a fixed `now`: aging always recomputes from base_pressure,
// never compounds on an already-aged value.
//
// Spine usage:  applyAging(state, { now: Date.now() }); tick(state, {...});

export const DEFAULT_AGING = Object.freeze({
  rate_per_minute: 0.01, // +0.01 effective pressure per waiting minute
  cap: 1.0,              // aged pressure never exceeds the field max
  min_emit_delta: 0.01,  // re-emit/mutate only when movement >= this
});

let xcounter = 0;
function xid() {
  xcounter += 1;
  return `xdelta_${Date.now()}_${xcounter}`;
}

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * Pure: effective pressure of a current at time `now`.
 * Bases on current.base_pressure when the stash exists (set by applyAging),
 * else current.pressure.
 */
export function agedPressure(current, opts = {}) {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const rate = Number.isFinite(opts.rate_per_minute)
    ? opts.rate_per_minute
    : DEFAULT_AGING.rate_per_minute;
  const cap = Number.isFinite(opts.cap) ? opts.cap : DEFAULT_AGING.cap;
  const base = typeof current.base_pressure === "number"
    ? current.base_pressure
    : current.pressure;
  const waited_ms = Math.max(0, now - current.created_at);
  const aged = base + (waited_ms / 60_000) * rate;
  return round4(Math.min(cap, aged));
}

/**
 * Pure: rank pending currents by aged pressure (desc), tie-broken by id (asc)
 * for deterministic ordering. No mutation.
 * @returns {Array<{id, title, base_pressure, aged_pressure, waited_ms}>}
 */
export function rankPending(state, opts = {}) {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const rows = [];
  for (const c of Object.values(state.currents)) {
    if (c.status !== "pending") continue;
    rows.push({
      id: c.id,
      title: c.title,
      base_pressure: typeof c.base_pressure === "number" ? c.base_pressure : c.pressure,
      aged_pressure: agedPressure(c, { ...opts, now }),
      waited_ms: Math.max(0, now - c.created_at),
    });
  }
  rows.sort((a, b) =>
    b.aged_pressure - a.aged_pressure || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return rows;
}

/**
 * Apply aging to every pending current in place, so the core scheduler's
 * pressure-desc assignment and the concurrency governor both see aged values.
 * Stashes the original pressure in current.base_pressure on first touch.
 * Emits a `current_pressure_change` delta per changed current (existing
 * delta kind — consumers keep working; payload carries aged:true).
 *
 * @returns {Array<{id, from, to, waited_ms}>} the changes applied
 */
export function applyAging(state, opts = {}) {
  const now = typeof opts.now === "number" ? opts.now : Date.now();
  const minDelta = Number.isFinite(opts.min_emit_delta)
    ? opts.min_emit_delta
    : DEFAULT_AGING.min_emit_delta;
  const changes = [];
  for (const c of Object.values(state.currents)) {
    if (c.status !== "pending") continue;
    if (typeof c.base_pressure !== "number") c.base_pressure = c.pressure;
    const aged = agedPressure(c, { ...opts, now });
    if (Math.abs(aged - c.pressure) < minDelta) continue;
    const from = c.pressure;
    c.pressure = aged;
    c.updated_at = now;
    state.deltas.push({
      id: xid(),
      ts: now,
      kind: "current_pressure_change",
      subject_id: c.id,
      payload: {
        pressure: aged,
        from,
        base_pressure: c.base_pressure,
        aged: true,
        waited_ms: Math.max(0, now - c.created_at),
      },
    });
    changes.push({ id: c.id, from, to: aged, waited_ms: Math.max(0, now - c.created_at) });
  }
  return changes;
}
