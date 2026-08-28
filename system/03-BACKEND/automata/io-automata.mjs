import crypto from 'node:crypto';

export const IO_AUTOMATON_SCHEMA = 'orange.io-automaton.v1';
export const IO_AUTOMATON_STATE_SCHEMA = 'orange.io-automaton.state.v1';
export const IO_AUTOMATON_TRACE_SCHEMA = 'orange.io-automaton.trace.v1';

const ACTION_KINDS = new Set(['input', 'output', 'internal']);
const SUCCESS = new Set(['green', 'passed', 'complete', 'completed', 'ok', 'ready', 'success', 'succeeded']);

function stable(value) {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function timestamp(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error('automaton event requires a valid timestamp');
  return date.toISOString();
}

function uniqueStrings(values, label) {
  if (!Array.isArray(values) || values.length === 0) throw new Error(`${label} must be a non-empty array`);
  const clean = values.map((value) => String(value).trim());
  if (clean.some((value) => !value)) throw new Error(`${label} contains an empty value`);
  if (new Set(clean).size !== clean.length) throw new Error(`${label} contains duplicates`);
  return clean;
}

function normalizeAction(action, states) {
  const name = String(action?.name || '').trim();
  const kind = String(action?.kind || '').trim();
  if (!name) throw new Error('automaton action name is required');
  if (!ACTION_KINDS.has(kind)) throw new Error(`invalid action kind for ${name}: ${kind || '<empty>'}`);
  const transitions = Object.fromEntries(Object.entries(action.transitions || {}).map(([from, to]) => [String(from), String(to)]));
  for (const [from, to] of Object.entries(transitions)) {
    if (!states.includes(from)) throw new Error(`${name} has unknown source state: ${from}`);
    if (!states.includes(to)) throw new Error(`${name} has unknown target state: ${to}`);
  }
  if (kind === 'input') {
    const missing = states.filter((state) => !(state in transitions));
    if (missing.length) throw new Error(`input action ${name} is not enabled in: ${missing.join(', ')}`);
  }
  const evidence = action.evidence || 'none';
  if (!['none', 'always', 'success'].includes(evidence)) throw new Error(`invalid evidence policy for ${name}: ${evidence}`);
  return Object.freeze({ name, kind, transitions: Object.freeze(transitions), evidence });
}

export function defineIoAutomaton(input) {
  const id = String(input?.id || '').trim();
  if (!id) throw new Error('automaton id is required');
  const states = uniqueStrings(input.states, `${id}.states`);
  const initialState = String(input.initialState || '').trim();
  if (!states.includes(initialState)) throw new Error(`${id}.initialState is not declared`);
  const actions = (input.actions || []).map((action) => normalizeAction(action, states));
  if (actions.length === 0) throw new Error(`${id} requires at least one action`);
  if (new Set(actions.map((action) => action.name)).size !== actions.length) {
    throw new Error(`${id} action names must be unique`);
  }
  const fairness = (input.fairness || []).map((task) => {
    const name = String(task?.name || '').trim();
    const waitingStates = uniqueStrings(task?.waitingStates, `${id}.fairness.${name || '<unnamed>'}.waitingStates`);
    if (waitingStates.some((state) => !states.includes(state))) throw new Error(`${id}.${name} fairness task uses an unknown state`);
    const maxWaitMs = Number(task.maxWaitMs);
    if (!Number.isFinite(maxWaitMs) || maxWaitMs <= 0) throw new Error(`${id}.${name} maxWaitMs must be positive`);
    return Object.freeze({ name, waitingStates: Object.freeze(waitingStates), maxWaitMs });
  });
  return Object.freeze({
    schema: IO_AUTOMATON_SCHEMA,
    id,
    initialState,
    states: Object.freeze(states),
    actions: Object.freeze(actions),
    fairness: Object.freeze(fairness),
  });
}

export function createIoState(spec, at = 0) {
  if (spec?.schema !== IO_AUTOMATON_SCHEMA) throw new Error('valid I/O automaton required');
  return {
    schema: IO_AUTOMATON_STATE_SCHEMA,
    automatonId: spec.id,
    state: spec.initialState,
    seq: 0,
    enteredAt: timestamp(at),
    updatedAt: timestamp(at),
    headHash: null,
  };
}

function evidencePresent(evidence) {
  return Array.isArray(evidence) && evidence.some((item) => {
    if (typeof item === 'string') return item.trim().length > 0;
    return item && typeof item === 'object' && Object.keys(item).length > 0;
  });
}

function requiresEvidence(action, payload) {
  if (action.evidence === 'always') return true;
  if (action.evidence !== 'success') return false;
  return SUCCESS.has(String(payload?.status || '').trim().toLowerCase());
}

export function stepIoAutomaton(spec, current, event) {
  if (spec?.schema !== IO_AUTOMATON_SCHEMA) throw new Error('valid I/O automaton required');
  if (current?.schema !== IO_AUTOMATON_STATE_SCHEMA || current.automatonId !== spec.id) {
    throw new Error(`state does not belong to ${spec.id}`);
  }
  const action = spec.actions.find((candidate) => candidate.name === event?.action);
  if (!action) throw new Error(`unknown ${spec.id} action: ${event?.action || '<empty>'}`);
  const toState = action.transitions[current.state];
  if (!toState) throw new Error(`${action.name} is not enabled while ${spec.id} is ${current.state}`);
  const evidence = Array.isArray(event.evidence) ? structuredClone(event.evidence) : [];
  const payload = event.payload && typeof event.payload === 'object' ? structuredClone(event.payload) : {};
  if (requiresEvidence(action, payload) && !evidencePresent(evidence)) {
    throw new Error(`${action.name} requires governed evidence`);
  }
  const at = timestamp(event.at);
  const base = {
    schema: IO_AUTOMATON_TRACE_SCHEMA,
    automatonId: spec.id,
    seq: current.seq + 1,
    action: action.name,
    kind: action.kind,
    fromState: current.state,
    toState,
    actor: String(event.actor || 'orange-runtime'),
    payload,
    payloadHash: sha256(stable(payload)),
    evidence,
    evidenceHash: sha256(stable(evidence)),
    at,
    prevHash: current.headHash,
  };
  const trace = { ...base, eventHash: sha256(stable(base)) };
  return {
    state: {
      ...current,
      state: toState,
      seq: trace.seq,
      enteredAt: toState === current.state ? current.enteredAt : at,
      updatedAt: at,
      headHash: trace.eventHash,
    },
    trace,
  };
}

export function validateIoTrace(spec, events, { startedAt = 0 } = {}) {
  const errors = [];
  let state = createIoState(spec, startedAt);
  for (let index = 0; index < (events || []).length; index += 1) {
    const observed = events[index];
    try {
      const replay = stepIoAutomaton(spec, state, observed);
      for (const field of ['seq', 'kind', 'fromState', 'toState', 'payloadHash', 'evidenceHash', 'prevHash', 'eventHash']) {
        if (stable(replay.trace[field]) !== stable(observed[field])) errors.push(`event_${index + 1}_${field}`);
      }
      state = replay.state;
    } catch (error) {
      errors.push(`event_${index + 1}_illegal:${error.message}`);
      break;
    }
  }
  return { ok: errors.length === 0, automatonId: spec.id, events: events?.length || 0, finalState: state.state, headHash: state.headHash, errors };
}

export function auditIoFairness(spec, current, now = Date.now()) {
  const at = new Date(now);
  if (!Number.isFinite(at.getTime())) throw new Error('fairness audit requires a valid timestamp');
  const waitedMs = Math.max(0, at.getTime() - new Date(current.enteredAt).getTime());
  const violations = spec.fairness
    .filter((task) => task.waitingStates.includes(current.state) && waitedMs > task.maxWaitMs)
    .map((task) => ({
      task: task.name,
      state: current.state,
      waitedMs,
      maxWaitMs: task.maxWaitMs,
      debt: 'enabled_work_did_not_receive_a_turn',
    }));
  return { ok: violations.length === 0, automatonId: spec.id, state: current.state, waitedMs, violations };
}

export function validateIoComposition(specs) {
  const errors = [];
  const ids = new Set();
  const outputs = new Map();
  const internals = new Map();
  for (const spec of specs || []) {
    if (spec?.schema !== IO_AUTOMATON_SCHEMA) {
      errors.push('invalid_automaton');
      continue;
    }
    if (ids.has(spec.id)) errors.push(`duplicate_automaton:${spec.id}`);
    ids.add(spec.id);
    for (const action of spec.actions) {
      if (action.kind === 'output') {
        if (outputs.has(action.name)) errors.push(`output_collision:${action.name}:${outputs.get(action.name)}:${spec.id}`);
        else outputs.set(action.name, spec.id);
      }
      if (action.kind === 'internal') {
        if (internals.has(action.name)) errors.push(`internal_collision:${action.name}:${internals.get(action.name)}:${spec.id}`);
        else internals.set(action.name, spec.id);
      }
    }
  }
  return { ok: errors.length === 0, automata: ids.size, outputs: outputs.size, errors };
}

const allStates = ['idle', 'accepted', 'routed', 'leased', 'executing', 'reported', 'receipted', 'failed', 'cancelled'];
const self = Object.fromEntries(allStates.map((state) => [state, state]));

export function createOrangeOrderAutomaton({ fairnessMs = 30_000 } = {}) {
  return defineIoAutomaton({
    id: 'orange-order-lifecycle',
    initialState: 'idle',
    states: allStates,
    actions: [
      { name: 'order.accept', kind: 'input', transitions: { ...self, idle: 'accepted' } },
      { name: 'operator.cancel', kind: 'input', transitions: {
        ...self,
        idle: 'cancelled', accepted: 'cancelled', routed: 'cancelled', leased: 'cancelled', executing: 'cancelled',
      } },
      { name: 'route.select', kind: 'internal', transitions: { accepted: 'routed' } },
      { name: 'lease.authorize', kind: 'internal', transitions: { routed: 'leased' } },
      { name: 'execution.reflex', kind: 'internal', transitions: { routed: 'executing' } },
      { name: 'execution.start', kind: 'internal', transitions: { leased: 'executing' } },
      { name: 'execution.fail', kind: 'internal', transitions: { routed: 'failed', leased: 'failed', executing: 'failed' } },
      { name: 'report.emit', kind: 'output', evidence: 'success', transitions: { executing: 'reported', failed: 'reported' } },
      { name: 'receipt.bind', kind: 'output', evidence: 'always', transitions: { reported: 'receipted' } },
    ],
    fairness: [
      { name: 'route-accepted-order', waitingStates: ['accepted'], maxWaitMs: fairnessMs },
      { name: 'execute-routed-order', waitingStates: ['routed', 'leased'], maxWaitMs: fairnessMs },
      { name: 'report-execution', waitingStates: ['executing', 'failed'], maxWaitMs: fairnessMs },
      { name: 'bind-report-receipt', waitingStates: ['reported'], maxWaitMs: fairnessMs },
    ],
  });
}

export const __ioAutomataInternals = Object.freeze({ stable, sha256, requiresEvidence });
