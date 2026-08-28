// Flowstate ext — current lifecycle: open / ride / close with acceptance.
// Path: 05-FLOW/ext/current-lifecycle.mjs
//
// The core runtime exposes pushCurrent/closeCurrent but leaves gaps this
// module closes, without touching src:
//   - openCurrent: validated open (bad specs fail loudly at the door)
//   - rideCurrent: explicit manual assignment (spine pins an agent)
//   - checkAcceptance: pure acceptance-criteria evaluation
//   - closeWithReceipt: acceptance-gated close that emits a receipt record
//   - approveCurrent: completes the awaiting_approval loop that types.mjs
//     declares but nothing in src ever used
//
// Delta note: moving to awaiting_approval emits kind
// "current_awaiting_approval" — an ext-namespaced kind beyond DELTA_KINDS
// (the runtime does not validate kinds; consumers filtering on known kinds
// simply ignore it).

import { pushCurrent, closeCurrent } from "../src/flow.mjs";

const DEPT_RE = /^AE(\d|1[0-4])$/; // AE0..AE14

let lcounter = 0;
function lid() {
  lcounter += 1;
  return `ldelta_${Date.now()}_${lcounter}`;
}

function emit(state, kind, subject_id, payload = {}) {
  state.deltas.push({ id: lid(), ts: Date.now(), kind, subject_id, payload });
}

/**
 * Validated open. Throws TypeError listing every problem; on success
 * delegates to core pushCurrent and returns the current.
 */
export function openCurrent(state, spec = {}) {
  const errors = [];
  if (typeof spec.title !== "string" || spec.title.trim().length === 0) {
    errors.push("title must be a non-empty string");
  }
  if (spec.pressure !== undefined &&
      (typeof spec.pressure !== "number" || !Number.isFinite(spec.pressure) ||
       spec.pressure < 0 || spec.pressure > 1)) {
    errors.push(`pressure must be a number in [0..1], got ${spec.pressure}`);
  }
  if (spec.owner_department !== undefined && !DEPT_RE.test(spec.owner_department)) {
    errors.push(`owner_department must match AE0..AE14, got ${spec.owner_department}`);
  }
  if (spec.acceptance !== undefined) {
    const a = spec.acceptance;
    if (a === null || typeof a !== "object" || Array.isArray(a)) {
      errors.push("acceptance must be an object");
    } else {
      for (const k of ["receipt_required", "approval_required"]) {
        if (a[k] !== undefined && typeof a[k] !== "boolean") {
          errors.push(`acceptance.${k} must be boolean`);
        }
      }
      if (a.validator !== undefined && a.validator !== null &&
          typeof a.validator !== "string" && typeof a.validator !== "function") {
        errors.push("acceptance.validator must be null, a name string, or a function");
      }
    }
  }
  if (errors.length > 0) throw new TypeError(`openCurrent rejected: ${errors.join("; ")}`);
  return pushCurrent(state, spec);
}

/**
 * Explicit assignment: pin an idle agent onto a pending current.
 * Mirrors the core scheduler's field writes exactly, plus an
 * agent_assigned delta with manual:true so the operator can tell
 * pinned rides from scheduled ones.
 */
export function rideCurrent(state, current_id, agent_id) {
  const current = state.currents[current_id];
  if (!current) throw new Error(`current not found: ${current_id}`);
  if (current.status !== "pending" || current.assigned_agent) {
    throw new Error(`current ${current_id} not ridable (status=${current.status}, assigned=${current.assigned_agent})`);
  }
  const agent = state.agents[agent_id];
  if (!agent) throw new Error(`agent not found: ${agent_id}`);
  if (agent.state !== "idle") {
    throw new Error(`agent ${agent_id} not idle (state=${agent.state})`);
  }
  agent.state = "riding";
  agent.current_id = current.id;
  agent.last_tick = state.tick;
  current.assigned_agent = agent.id;
  current.status = "in_progress";
  current.updated_at = Date.now();
  emit(state, "agent_assigned", agent.id, { current_id: current.id, role: agent.role, manual: true });
  return { current, agent };
}

/**
 * Pure acceptance check. Evidence: { receipt_path, approved,
 * validator_passed, ... } (extra keys pass through to function validators).
 * @returns {{ ok: boolean, failures: string[] }}
 */
export function checkAcceptance(current, evidence = {}) {
  const acc = current.acceptance || {};
  const failures = [];
  if (acc.receipt_required && !evidence.receipt_path) failures.push("receipt_missing");
  if (acc.approval_required && evidence.approved !== true) failures.push("approval_missing");
  if (typeof acc.validator === "function") {
    let passed = false;
    let threw = null;
    try {
      passed = !!acc.validator(current, evidence);
    } catch (e) {
      threw = e;
    }
    if (threw) failures.push(`validator_threw:${threw.message}`);
    else if (!passed) failures.push("validator_failed");
  } else if (acc.validator) {
    // Named validator we cannot execute here: require explicit attestation.
    if (evidence.validator_passed !== true) failures.push(`validator_unverified:${acc.validator}`);
  }
  return { ok: failures.length === 0, failures };
}

function buildReceipt(current, evidence) {
  return {
    current_id: current.id,
    title: current.title,
    owner_department: current.owner_department,
    opened_at: current.created_at,
    closed_at: current.closed_at,
    wait_ms: Math.max(0, current.closed_at - current.created_at),
    receipt_path: current.closed_receipt,
    approver: evidence.approver ?? null,
  };
}

/**
 * Acceptance-gated close.
 *  - all criteria met  -> core closeCurrent + lifecycle receipt record
 *  - only approval missing -> park at awaiting_approval, release the agent
 *  - anything else missing -> no state change, failures reported
 * @returns {{closed: boolean, status: string, failures: string[], receipt: object|null}}
 */
export function closeWithReceipt(state, current_id, evidence = {}) {
  const current = state.currents[current_id];
  if (!current) throw new Error(`current not found: ${current_id}`);
  if (current.status === "closed") throw new Error(`current ${current_id} already closed`);

  const { ok, failures } = checkAcceptance(current, evidence);
  if (ok) {
    closeCurrent(state, current_id, { receipt_path: evidence.receipt_path ?? null });
    return { closed: true, status: "closed", failures: [], receipt: buildReceipt(current, evidence) };
  }

  const onlyApproval = failures.length === 1 && failures[0] === "approval_missing";
  if (onlyApproval && current.status !== "awaiting_approval") {
    current.status = "awaiting_approval";
    current.updated_at = Date.now();
    // Work is done; free the agent while the operator reviews.
    if (current.assigned_agent) {
      const agent = state.agents[current.assigned_agent];
      if (agent) {
        agent.state = "idle";
        agent.current_id = null;
        emit(state, "agent_released", agent.id, { current_id, awaiting_approval: true });
      }
      current.assigned_agent = null;
    }
    emit(state, "current_awaiting_approval", current_id, { evidence_receipt: evidence.receipt_path ?? null });
    return { closed: false, status: "awaiting_approval", failures };
  }
  return { closed: false, status: current.status, failures, receipt: null };
}

/**
 * Operator sign-off on an awaiting_approval current. Re-runs the full
 * acceptance check with approved:true — approval does NOT bypass receipt
 * or validator requirements.
 */
export function approveCurrent(state, current_id, evidence = {}) {
  const current = state.currents[current_id];
  if (!current) throw new Error(`current not found: ${current_id}`);
  if (current.status !== "awaiting_approval") {
    throw new Error(`current ${current_id} is not awaiting approval (status=${current.status})`);
  }
  return closeWithReceipt(state, current_id, { ...evidence, approved: true });
}
