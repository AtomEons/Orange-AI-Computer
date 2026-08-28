// AE Flow persist gate.
// Path: 05-FLOW/src/persist-gate.mjs
//
// Doctrine: the original tick() snapshotted state/flow.json on EVERY call.
// At active cadence (1s), idle ticks burned 86,400 disk writes per day for
// zero semantic change. This gate replaces "snapshot every tick" with
// "snapshot when state changed OR heartbeat lapsed".
//
// Dirty signal:
//   - deltas length changed since last save (an event happened), OR
//   - any current's status changed, OR
//   - any agent's state/assignment changed
//
// Heartbeat:
//   - even when not dirty, save once per heartbeatMs. The cockpit polls
//     state/flow.json mtime to decide "scheduler alive"; without a heartbeat
//     the mtime would freeze during long idle stretches and operators would
//     mis-read it as a hung process.
//
// Single-writer rule: one gate per state handle. The scheduler creates one
// at boot and passes it to every tick(). Tests can omit it; tick() then
// falls back to the legacy save-every-tick behavior so the gate stays
// strictly additive.

export const DEFAULT_HEARTBEAT_MS = 30_000;

/**
 * Build a gate for a state handle. Snapshots the "as loaded from disk"
 * fingerprint so the first dirty check after boot reflects whether the
 * caller has mutated state since load.
 *
 * @param {object} state — the FlowState handle returned by createFlow()
 * @param {object} [opts]
 * @param {number} [opts.heartbeatMs] — max ms between forced saves (default 30s)
 * @param {() => number} [opts.now] — clock injector for tests
 */
export function createPersistGate(state, opts = {}) {
  const heartbeatMs = Number.isFinite(opts.heartbeatMs)
    ? Math.max(0, opts.heartbeatMs)
    : DEFAULT_HEARTBEAT_MS;
  const now = typeof opts.now === "function" ? opts.now : () => Date.now();

  let savedDeltaCount = state.deltas.length;
  let savedStatusFp = fingerprintStatuses(state);
  let savedAgentFp = fingerprintAgents(state);
  let lastSavedAt = now();

  // Telemetry — scheduler reads these for heartbeat logs.
  let totalSaves = 0;
  let totalSkips = 0;
  let totalDirty = 0;
  let totalHeartbeat = 0;

  function shouldPersist() {
    if (state.deltas.length !== savedDeltaCount) return { persist: true, reason: "deltas" };
    if (fingerprintStatuses(state) !== savedStatusFp) return { persist: true, reason: "current_status" };
    if (fingerprintAgents(state) !== savedAgentFp) return { persist: true, reason: "agent_state" };
    if (heartbeatMs > 0 && now() - lastSavedAt >= heartbeatMs) {
      return { persist: true, reason: "heartbeat" };
    }
    return { persist: false, reason: "clean" };
  }

  function markSaved(reason = null) {
    savedDeltaCount = state.deltas.length;
    savedStatusFp = fingerprintStatuses(state);
    savedAgentFp = fingerprintAgents(state);
    lastSavedAt = now();
    totalSaves += 1;
    if (reason === "heartbeat") totalHeartbeat += 1;
    else if (reason && reason !== "clean") totalDirty += 1;
  }

  function markSkipped() {
    totalSkips += 1;
  }

  function snapshot() {
    return {
      savedDeltaCount,
      lastSavedAt,
      heartbeatMs,
      totalSaves,
      totalSkips,
      totalDirty,
      totalHeartbeat,
      savePct: totalSaves + totalSkips === 0
        ? 0
        : Math.round((totalSaves / (totalSaves + totalSkips)) * 1000) / 10,
    };
  }

  return { shouldPersist, markSaved, markSkipped, snapshot };
}

/**
 * Deterministic, order-independent fingerprint of all current statuses.
 * Format: id:status separated by '|', sorted by id. O(n log n) per call;
 * n is bounded by active currents which is small (typical < 50).
 */
function fingerprintStatuses(state) {
  const parts = [];
  for (const id of Object.keys(state.currents)) {
    parts.push(`${id}:${state.currents[id].status}`);
  }
  parts.sort();
  return parts.join("|");
}

/** Agent fingerprint: id:state:current_id, sorted. */
function fingerprintAgents(state) {
  const parts = [];
  for (const id of Object.keys(state.agents)) {
    const a = state.agents[id];
    parts.push(`${id}:${a.state}:${a.current_id ?? ""}`);
  }
  parts.sort();
  return parts.join("|");
}

// Exported for test introspection only.
export const _internal = { fingerprintStatuses, fingerprintAgents };
