// Flowstate ext — backpressure metrics (pressure-field observability).
// Path: 05-FLOW/ext/backpressure-metrics.mjs
//
// Measures the field: open currents, status/agent distribution, pending
// pressure stats, throttle events, and (when a governor config is supplied)
// saturation ratios + level. Pure reads over state — no mutation, no I/O.
//
// Honesty note: throttle counts come from state.deltas, which the store trims
// to its last MAX_DELTAS entries; they are counts *in the retained buffer*,
// named accordingly, not lifetime totals.

import { STATUSES } from "../src/types.mjs";
import { levelForRatio } from "./governor-config.mjs";

function round4(n) {
  return Math.round(n * 10_000) / 10_000;
}

/**
 * @param {import('../src/types.mjs').FlowState} state
 * @param {object} [opts]
 * @param {object|null} [opts.config] — governor config for saturation ratios
 * @param {number|null} [opts.now]    — clock for wait ages (null = skip ages)
 */
export function collectMetrics(state, { config = null, now = null } = {}) {
  const by_status = {};
  for (const s of STATUSES) by_status[s] = 0;

  const pendingPressures = [];
  let oldestPendingCreated = null;
  let total = 0;

  for (const c of Object.values(state.currents)) {
    total += 1;
    if (by_status[c.status] === undefined) by_status[c.status] = 0;
    by_status[c.status] += 1;
    if (c.status === "pending") {
      pendingPressures.push(c.pressure);
      if (oldestPendingCreated === null || c.created_at < oldestPendingCreated) {
        oldestPendingCreated = c.created_at;
      }
    }
  }
  const open = total - by_status.closed;

  const agents = { total: 0, idle: 0, riding: 0, cooling: 0 };
  for (const a of Object.values(state.agents)) {
    agents.total += 1;
    if (agents[a.state] === undefined) agents[a.state] = 0;
    agents[a.state] += 1;
  }

  let pending_mean = null;
  let pending_max = null;
  if (pendingPressures.length > 0) {
    pending_mean = round4(pendingPressures.reduce((s, p) => s + p, 0) / pendingPressures.length);
    pending_max = round4(Math.max(...pendingPressures));
  }

  let throttle_events_in_buffer = 0;
  let last_throttle_ts = null;
  for (const d of state.deltas) {
    if (d.kind === "governor_throttled") {
      throttle_events_in_buffer += 1;
      if (last_throttle_ts === null || d.ts > last_throttle_ts) last_throttle_ts = d.ts;
    }
  }

  let saturation = null;
  if (config) {
    const concurrency_ratio = round4(by_status.in_progress / config.max_concurrent_currents);
    const open_ratio = round4(open / config.max_open_currents);
    const worst = Math.max(concurrency_ratio, open_ratio);
    saturation = { concurrency_ratio, open_ratio, level: levelForRatio(worst) };
  }

  return {
    tick: state.tick,
    last_tick_at: state.last_tick_at,
    currents: { total, open, by_status },
    agents,
    pressure: { pending_mean, pending_max },
    wait: {
      oldest_pending_ms:
        now !== null && oldestPendingCreated !== null
          ? Math.max(0, now - oldestPendingCreated)
          : null,
    },
    throttle: {
      events_in_buffer: throttle_events_in_buffer,
      last_event_ts: last_throttle_ts,
      buffer_len: state.deltas.length,
    },
    saturation,
  };
}

/** One operator line. Deterministic given the metrics object. */
export function formatMetricsLine(m) {
  const parts = [
    `flow t=${m.tick}`,
    `open=${m.currents.open}`,
    `inprog=${m.currents.by_status.in_progress}`,
    `pending=${m.currents.by_status.pending}`,
    `agents=${m.agents.riding}r/${m.agents.idle}i of ${m.agents.total}`,
    `thr=${m.throttle.events_in_buffer}`,
  ];
  if (m.pressure.pending_max !== null) parts.push(`pmax=${m.pressure.pending_max}`);
  if (m.saturation) parts.push(`sat=${m.saturation.level}`);
  return parts.join(" ");
}
