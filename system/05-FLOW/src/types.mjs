// AE Flow types — JSDoc shapes. Used by store + runtime.

/**
 * @typedef {Object} Current
 * @property {string} id                    — unique current id
 * @property {string} title                 — short label
 * @property {string} description           — what this current carries
 * @property {number} pressure              — current pressure (0..1 normalized)
 * @property {string} owner_department      — AE0..AE14
 * @property {'pending'|'in_progress'|'awaiting_approval'|'closed'|'blocked'|'escalated'} status
 * @property {string|null} assigned_agent
 * @property {Object} acceptance            — { receipt_required, approval_required, validator }
 * @property {number} created_at
 * @property {number} updated_at
 * @property {string|null} closed_at
 * @property {string|null} closed_receipt   — path to closing receipt
 */

/**
 * @typedef {Object} Agent
 * @property {string} id
 * @property {string} role                  — 'orangellm-light'|'orangellm-heavy'|'codexa-rail'|...
 * @property {'idle'|'riding'|'cooling'} state
 * @property {string|null} current_id       — current this agent is riding
 * @property {number} last_tick
 * @property {Object} capability            — { lane: 'reflex'|'heavy'|'visual'|'agentic'|... }
 */

/**
 * @typedef {Object} Delta
 * @property {string} id
 * @property {number} ts
 * @property {'current_pressure_change'|'agent_assigned'|'agent_released'|'current_closed'|'current_blocked'|'governor_throttled'} kind
 * @property {string} subject_id            — current or agent id
 * @property {Object} payload
 */

/**
 * @typedef {Object} Governor
 * @property {string} id
 * @property {string} description
 * @property {(state: FlowState) => GovernorAction[]} evaluate
 */

/**
 * @typedef {Object} GovernorAction
 * @property {'throttle'|'release'|'escalate'|'block'} action
 * @property {string} target_id
 * @property {string} reason
 */

/**
 * @typedef {Object} FlowState
 * @property {Object<string, Current>} currents
 * @property {Object<string, Agent>} agents
 * @property {Delta[]} deltas                — most recent N kept
 * @property {number} tick
 * @property {number} last_tick_at
 */

export const STATUSES = ["pending", "in_progress", "awaiting_approval", "closed", "blocked", "escalated"];
export const DELTA_KINDS = [
  "current_pressure_change",
  "agent_assigned",
  "agent_released",
  "current_closed",
  "current_blocked",
  "governor_throttled",
];
