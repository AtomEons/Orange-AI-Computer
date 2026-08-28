// AE Flow runtime — pressure-field orchestration.
// Per Master Plan §7: high-pressure currents win attention.

import { loadState, saveState, emptyState } from "./store.mjs";
import { STATUSES } from "./types.mjs";

let counter = 0;
function newId(prefix) {
  counter += 1;
  return `${prefix}_${Date.now()}_${counter}`;
}

function emit(state, kind, subject_id, payload = {}) {
  state.deltas.push({
    id: newId("delta"),
    ts: Date.now(),
    kind,
    subject_id,
    payload,
  });
}

/**
 * Push a new current into the field. Returns the current.
 * @param {import('./types.mjs').FlowState} state
 */
export function pushCurrent(state, {
  title,
  description = "",
  pressure = 0.5,
  owner_department = "AE0",
  acceptance = { receipt_required: true, approval_required: false, validator: null },
}) {
  const id = newId("current");
  const now = Date.now();
  const current = {
    id,
    title,
    description,
    pressure: clamp(pressure, 0, 1),
    owner_department,
    status: "pending",
    assigned_agent: null,
    acceptance,
    created_at: now,
    updated_at: now,
    closed_at: null,
    closed_receipt: null,
  };
  state.currents[id] = current;
  emit(state, "current_pressure_change", id, { pressure: current.pressure, status: "pending" });
  return current;
}

/** Register an agent ready to ride currents. */
export function registerAgent(state, { role, capability = { lane: "reflex" } }) {
  const id = newId("agent");
  const agent = {
    id,
    role,
    state: "idle",
    current_id: null,
    last_tick: state.tick,
    capability,
  };
  state.agents[id] = agent;
  return agent;
}

/**
 * Assign idle agents to highest-pressure pending currents matching their capability lane.
 */
function assignAgents(state) {
  const idleAgents = Object.values(state.agents).filter(a => a.state === "idle");
  if (idleAgents.length === 0) return;

  // Sort pending currents by pressure desc
  const pending = Object.values(state.currents)
    .filter(c => c.status === "pending" && !c.assigned_agent)
    .sort((a, b) => b.pressure - a.pressure);

  for (const current of pending) {
    if (idleAgents.length === 0) break;
    const agent = idleAgents.shift();
    agent.state = "riding";
    agent.current_id = current.id;
    agent.last_tick = state.tick;
    current.assigned_agent = agent.id;
    current.status = "in_progress";
    current.updated_at = Date.now();
    emit(state, "agent_assigned", agent.id, { current_id: current.id, role: agent.role });
  }
}

/**
 * Mark a current closed. Writes the closing receipt path; releases the agent.
 */
export function closeCurrent(state, current_id, { receipt_path }) {
  const current = state.currents[current_id];
  if (!current) throw new Error(`current not found: ${current_id}`);
  if (current.acceptance.receipt_required && !receipt_path) {
    throw new Error(`current ${current_id} requires receipt to close`);
  }
  current.status = "closed";
  current.closed_at = Date.now();
  current.closed_receipt = receipt_path || null;
  current.updated_at = current.closed_at;
  emit(state, "current_closed", current_id, { receipt_path });

  // Release any agent riding it
  if (current.assigned_agent) {
    const agent = state.agents[current.assigned_agent];
    if (agent) {
      agent.state = "idle";
      agent.current_id = null;
      emit(state, "agent_released", agent.id, { current_id });
    }
    current.assigned_agent = null;
  }
  return current;
}

export function blockCurrent(state, current_id, reason) {
  const current = state.currents[current_id];
  if (!current) throw new Error(`current not found: ${current_id}`);
  current.status = "blocked";
  current.updated_at = Date.now();
  emit(state, "current_blocked", current_id, { reason });
}

/**
 * Built-in governors.
 * Concurrency cap: if too many in_progress currents, throttle lowest-pressure ones.
 */
function governorConcurrencyCap(state, { cap = 3 } = {}) {
  const actions = [];
  const inProg = Object.values(state.currents).filter(c => c.status === "in_progress");
  if (inProg.length <= cap) return actions;
  const overflow = inProg.sort((a, b) => a.pressure - b.pressure).slice(0, inProg.length - cap);
  for (const c of overflow) {
    actions.push({ action: "throttle", target_id: c.id, reason: `concurrency cap ${cap} exceeded` });
  }
  return actions;
}

function applyGovernor(state, actions) {
  for (const a of actions) {
    if (a.action === "throttle") {
      const c = state.currents[a.target_id];
      if (!c) continue;
      // Throttle = release agent back to idle and mark pending again (won't reassign this tick if cap still hit)
      if (c.assigned_agent) {
        const agent = state.agents[c.assigned_agent];
        if (agent) {
          agent.state = "idle";
          agent.current_id = null;
          emit(state, "agent_released", agent.id, { current_id: c.id, governor_throttled: true });
        }
        c.assigned_agent = null;
      }
      c.status = "pending";
      c.updated_at = Date.now();
      emit(state, "governor_throttled", c.id, { reason: a.reason });
    } else if (a.action === "escalate") {
      const c = state.currents[a.target_id];
      if (c) { c.status = "escalated"; c.updated_at = Date.now(); }
    } else if (a.action === "block") {
      blockCurrent(state, a.target_id, a.reason);
    }
  }
}

/**
 * Run one tick: assign agents, evaluate governors, persist.
 *
 * @param {FlowState} state
 * @param {object} [opts]
 * @param {number} [opts.concurrency_cap=3]
 * @param {{shouldPersist():{persist:boolean,reason:string}, markSaved(reason?):void, markSkipped():void}} [opts.persistGate]
 *        Optional. When provided, the gate decides whether saveState runs.
 *        When omitted, save-every-tick (legacy behavior, used by tests).
 */
export function tick(state, { concurrency_cap = 3, persistGate = null } = {}) {
  state.tick += 1;
  state.last_tick_at = Date.now();
  assignAgents(state);
  const govActions = governorConcurrencyCap(state, { cap: concurrency_cap });
  applyGovernor(state, govActions);

  if (persistGate) {
    const decision = persistGate.shouldPersist();
    if (decision.persist) {
      saveState(state);
      persistGate.markSaved(decision.reason);
    } else {
      persistGate.markSkipped();
    }
  } else {
    saveState(state);
  }
  return state;
}

export function createFlow({ persist = true } = {}) {
  const state = persist ? loadState() : emptyState();
  return state;
}

function clamp(n, lo, hi) {
  return Math.max(lo, Math.min(hi, n));
}
