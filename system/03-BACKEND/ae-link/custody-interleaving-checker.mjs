const EMPTY = 'empty';
const OFFERED = 'offered';
const PERSISTED = 'persisted';
const STARTED = 'started';
const CANCEL_REQUESTED = 'cancel-requested';
const TERMINAL = 'terminal';

export const CUSTODY_MODEL_OPERATIONS = Object.freeze([
  'offer',
  'persist',
  'start',
  'cancel',
  'effect',
  'terminal',
  'handoff',
  'recovery',
]);

const OPERATION_SET = new Set(CUSTODY_MODEL_OPERATIONS);
const TERMINAL_OUTCOMES = new Set(['completed', 'failed', 'cancelled']);
const DEFAULT_BOUNDS = Object.freeze({
  maxDepth: 10,
  maxJournalEntries: 5,
  maxPending: 2,
  maxStates: 250_000,
});

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function modelSnapshot(work) {
  return {
    phase: work.phase,
    revision: work.revision,
    owner: work.owner,
    ownerEpoch: work.ownerEpoch,
  };
}

function sameSnapshot(left, right) {
  return left.phase === right.phase
    && left.revision === right.revision
    && left.owner === right.owner
    && left.ownerEpoch === right.ownerEpoch;
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validOwner(value) {
  return typeof value === 'string' && value.length > 0;
}

function normalizeCommand(command) {
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    throw new TypeError('custody model command must be an object');
  }
  if (!OPERATION_SET.has(command.operation)) {
    throw new TypeError(`unknown custody model operation: ${command.operation}`);
  }
  if (typeof command.writer !== 'string' || command.writer.length === 0) {
    throw new TypeError('custody model command requires a writer');
  }
  return clone(command);
}

function reject(state, record, reason) {
  state.pendingEvidenceIds = state.pendingEvidenceIds.filter((id) => id !== record.id);
  state.rejectedEvidence.push({
    evidenceId: record.id,
    operation: record.operation,
    reason,
  });
  return {
    state,
    decision: 'rejected',
    evidenceId: record.id,
    operation: record.operation,
    reason,
  };
}

function requireCurrentOwner(work, command) {
  return command.owner === work.owner && command.ownerEpoch === work.ownerEpoch;
}

function applySmallSpecification(work, command) {
  const next = clone(work);
  const operation = command.operation;

  if (operation === 'offer') {
    if (work.phase !== EMPTY) return { ok: false, reason: 'work-already-offered' };
    if (!validOwner(command.owner) || !isPositiveInteger(command.ownerEpoch)) {
      return { ok: false, reason: 'invalid-initial-owner' };
    }
    next.phase = OFFERED;
    next.owner = command.owner;
    next.ownerEpoch = command.ownerEpoch;
    return { ok: true, work: next, metadata: {} };
  }

  if (!requireCurrentOwner(work, command)) return { ok: false, reason: 'stale-owner-epoch' };

  if (operation === 'persist') {
    if (work.phase !== OFFERED) return { ok: false, reason: 'persist-not-enabled' };
    next.phase = PERSISTED;
    return { ok: true, work: next, metadata: {} };
  }

  if (operation === 'start') {
    if (work.phase !== PERSISTED) return { ok: false, reason: 'start-not-enabled' };
    if (work.preStartCancelEvidenceId !== null) {
      return { ok: false, reason: 'pre-start-cancel-confirmed' };
    }
    next.phase = STARTED;
    return { ok: true, work: next, metadata: {} };
  }

  if (operation === 'cancel') {
    if (work.phase === OFFERED || work.phase === PERSISTED) {
      next.phase = TERMINAL;
      next.preStartCancelEvidenceId = command.evidenceId;
      next.terminalOutcomes.push('cancelled');
      return {
        ok: true,
        work: next,
        metadata: { cancelMode: 'pre-start', terminalOutcome: 'cancelled' },
      };
    }
    if (work.phase === STARTED) {
      next.phase = CANCEL_REQUESTED;
      return { ok: true, work: next, metadata: { cancelMode: 'post-start' } };
    }
    return { ok: false, reason: 'cancel-not-enabled' };
  }

  if (operation === 'effect') {
    if (work.phase !== STARTED) return { ok: false, reason: 'effect-not-enabled' };
    if (typeof command.effectId !== 'string' || command.effectId.length === 0) {
      return { ok: false, reason: 'effect-id-required' };
    }
    if (work.effectIds.includes(command.effectId)) return { ok: false, reason: 'duplicate-effect' };
    next.effectIds.push(command.effectId);
    return { ok: true, work: next, metadata: { effectId: command.effectId } };
  }

  if (operation === 'terminal') {
    if (!TERMINAL_OUTCOMES.has(command.outcome)) return { ok: false, reason: 'invalid-terminal-outcome' };
    if (work.phase === TERMINAL) return { ok: false, reason: 'terminal-already-set' };
    if (work.phase !== STARTED && work.phase !== CANCEL_REQUESTED) {
      return { ok: false, reason: 'terminal-not-enabled' };
    }
    if (work.phase === CANCEL_REQUESTED && command.outcome !== 'cancelled') {
      return { ok: false, reason: 'cancel-must-terminalize-cancelled' };
    }
    next.phase = TERMINAL;
    next.terminalOutcomes.push(command.outcome);
    return { ok: true, work: next, metadata: { terminalOutcome: command.outcome } };
  }

  if (operation === 'handoff') {
    if (work.phase !== PERSISTED) return { ok: false, reason: 'handoff-not-enabled' };
    if (!validOwner(command.toOwner) || !isPositiveInteger(command.toEpoch)) {
      return { ok: false, reason: 'invalid-handoff-owner' };
    }
    if (command.toEpoch <= work.ownerEpoch) return { ok: false, reason: 'non-monotonic-owner-epoch' };
    next.owner = command.toOwner;
    next.ownerEpoch = command.toEpoch;
    return { ok: true, work: next, metadata: {} };
  }

  if (operation === 'recovery') {
    if (work.phase !== STARTED && work.phase !== CANCEL_REQUESTED) {
      return { ok: false, reason: 'recovery-not-enabled' };
    }
    if (command.orphanEvidence !== 'lease-expired') {
      return { ok: false, reason: 'orphan-evidence-required' };
    }
    if (!validOwner(command.toOwner) || !isPositiveInteger(command.toEpoch)) {
      return { ok: false, reason: 'invalid-recovery-owner' };
    }
    if (command.toEpoch <= work.ownerEpoch) return { ok: false, reason: 'non-monotonic-owner-epoch' };
    next.owner = command.toOwner;
    next.ownerEpoch = command.toEpoch;
    next.phase = work.phase === CANCEL_REQUESTED ? CANCEL_REQUESTED : PERSISTED;
    return {
      ok: true,
      work: next,
      metadata: { recoveryMode: work.phase === CANCEL_REQUESTED ? 'cancel-drain' : 'resume' },
    };
  }

  return { ok: false, reason: 'operation-not-modeled' };
}

export function createCustodyModelState() {
  return {
    schema: 'ae-link.custody-small-spec.v1',
    work: {
      phase: EMPTY,
      revision: 0,
      owner: null,
      ownerEpoch: 0,
      effectIds: [],
      terminalOutcomes: [],
      preStartCancelEvidenceId: null,
    },
    journal: [],
    pendingEvidenceIds: [],
    rejectedEvidence: [],
    acceptedTransitions: [],
    nextEvidenceSequence: 1,
  };
}

export function stepCustodyModel(sourceState, action) {
  if (!sourceState || typeof sourceState !== 'object') throw new TypeError('custody model state is required');
  if (!action || typeof action !== 'object') throw new TypeError('custody model action is required');
  const state = clone(sourceState);

  if (action.kind === 'record') {
    const command = normalizeCommand(action.command);
    const sequence = state.nextEvidenceSequence;
    const evidenceId = action.evidenceId || `journal-${sequence}`;
    if (state.journal.some((record) => record.id === evidenceId)) {
      throw new TypeError(`duplicate custody evidence id: ${evidenceId}`);
    }
    const previous = state.journal.at(-1) || null;
    const record = {
      id: evidenceId,
      sequence,
      previousEvidenceId: previous?.id || null,
      durable: action.durable !== false,
      operation: command.operation,
      writer: command.writer,
      command,
      observed: modelSnapshot(state.work),
    };
    state.journal.push(record);
    state.pendingEvidenceIds.push(evidenceId);
    state.nextEvidenceSequence += 1;
    return {
      state,
      decision: 'journaled',
      evidenceId,
      operation: command.operation,
    };
  }

  if (action.kind !== 'apply') throw new TypeError(`unknown custody model action: ${action.kind}`);
  const record = state.journal.find(({ id }) => id === action.evidenceId);
  if (!record) {
    return {
      state,
      decision: 'rejected',
      evidenceId: action.evidenceId,
      operation: null,
      reason: 'missing-journal-evidence',
    };
  }
  if (!state.pendingEvidenceIds.includes(record.id)) {
    return {
      state,
      decision: 'rejected',
      evidenceId: record.id,
      operation: record.operation,
      reason: 'evidence-already-resolved',
    };
  }
  if (record.durable !== true) return reject(state, record, 'journal-evidence-not-durable');

  const current = modelSnapshot(state.work);
  if (!sameSnapshot(record.observed, current)) {
    const ownerChanged = record.observed.owner !== current.owner
      || record.observed.ownerEpoch !== current.ownerEpoch;
    return reject(state, record, ownerChanged ? 'stale-owner-epoch' : 'stale-observation');
  }

  const command = { ...record.command, evidenceId: record.id };
  const before = modelSnapshot(state.work);
  const applied = applySmallSpecification(state.work, command);
  if (!applied.ok) return reject(state, record, applied.reason);

  applied.work.revision = state.work.revision + 1;
  state.work = applied.work;
  state.pendingEvidenceIds = state.pendingEvidenceIds.filter((id) => id !== record.id);
  const after = modelSnapshot(state.work);
  const event = {
    sequence: state.acceptedTransitions.length + 1,
    operation: record.operation,
    evidenceId: record.id,
    writer: record.writer,
    beforePhase: before.phase,
    afterPhase: after.phase,
    beforeRevision: before.revision,
    afterRevision: after.revision,
    beforeOwner: before.owner,
    afterOwner: after.owner,
    beforeEpoch: before.ownerEpoch,
    afterEpoch: after.ownerEpoch,
    ...applied.metadata,
  };
  state.acceptedTransitions.push(event);
  return {
    state,
    decision: 'accepted',
    evidenceId: record.id,
    operation: record.operation,
    event: clone(event),
  };
}

function addViolation(violations, code, message, evidenceId = null) {
  violations.push({ code, message, evidenceId });
}

export function auditCustodyInvariants(state) {
  const violations = [];
  const evidenceById = new Map();
  let previousEvidenceId = null;

  for (let index = 0; index < state.journal.length; index += 1) {
    const record = state.journal[index];
    if (evidenceById.has(record.id)) {
      addViolation(violations, 'duplicate_journal_evidence', `journal evidence ${record.id} appears more than once`, record.id);
    }
    evidenceById.set(record.id, record);
    if (record.sequence !== index + 1 || record.previousEvidenceId !== previousEvidenceId) {
      addViolation(violations, 'broken_journal_order', `journal evidence ${record.id} is not in its durable append position`, record.id);
    }
    previousEvidenceId = record.id;
  }

  const usedEvidence = new Set();
  const effectIds = new Set();
  let prior = { phase: EMPTY, revision: 0, owner: null, ownerEpoch: 0 };
  let preStartCancelSeen = false;
  let terminalSeen = false;
  let terminalEventCount = 0;

  for (let index = 0; index < state.acceptedTransitions.length; index += 1) {
    const event = state.acceptedTransitions[index];
    const evidence = evidenceById.get(event.evidenceId);
    if (!evidence || evidence.durable !== true) {
      addViolation(violations, 'accepted_without_durable_journal', `accepted ${event.operation} has no durable journal evidence`, event.evidenceId);
    } else if (evidence.operation !== event.operation || evidence.writer !== event.writer) {
      addViolation(violations, 'accepted_journal_mismatch', `accepted ${event.operation} does not match journal evidence`, event.evidenceId);
    }
    if (usedEvidence.has(event.evidenceId)) {
      addViolation(violations, 'journal_evidence_reused', `journal evidence ${event.evidenceId} accepted more than once`, event.evidenceId);
    }
    usedEvidence.add(event.evidenceId);

    if (event.sequence !== index + 1
      || event.beforePhase !== prior.phase
      || event.beforeRevision !== prior.revision
      || event.beforeOwner !== prior.owner
      || event.beforeEpoch !== prior.ownerEpoch
      || event.afterRevision !== event.beforeRevision + 1) {
      addViolation(violations, 'broken_accepted_transition_chain', `accepted transition ${index + 1} is not contiguous`, event.evidenceId);
    }

    if (event.afterEpoch < event.beforeEpoch) {
      addViolation(violations, 'owner_epoch_regressed', `owner epoch regressed at ${event.operation}`, event.evidenceId);
    }
    if (event.afterOwner !== event.beforeOwner && event.afterEpoch <= event.beforeEpoch) {
      addViolation(violations, 'owner_changed_without_epoch_advance', `owner changed without a larger epoch at ${event.operation}`, event.evidenceId);
    }

    if (terminalSeen) {
      addViolation(violations, 'accepted_after_terminal', `${event.operation} was accepted after a terminal outcome`, event.evidenceId);
    }
    if (preStartCancelSeen && (event.operation === 'start' || event.operation === 'effect')) {
      addViolation(violations, 'execution_after_prestart_cancel', `${event.operation} followed a confirmed pre-start cancellation`, event.evidenceId);
    }
    if (event.cancelMode === 'pre-start') preStartCancelSeen = true;

    if (event.operation === 'effect') {
      if (!event.effectId || effectIds.has(event.effectId)) {
        addViolation(violations, 'duplicate_effect', `effect ${event.effectId || '<missing>'} committed more than once`, event.evidenceId);
      }
      effectIds.add(event.effectId);
    }
    if (event.terminalOutcome !== undefined) {
      terminalEventCount += 1;
      terminalSeen = true;
      if (!TERMINAL_OUTCOMES.has(event.terminalOutcome)) {
        addViolation(violations, 'invalid_terminal_outcome', `unsupported terminal outcome ${event.terminalOutcome}`, event.evidenceId);
      }
    }

    prior = {
      phase: event.afterPhase,
      revision: event.afterRevision,
      owner: event.afterOwner,
      ownerEpoch: event.afterEpoch,
    };
  }

  if (new Set(state.work.effectIds).size !== state.work.effectIds.length) {
    addViolation(violations, 'duplicate_effect', 'work state contains a duplicate effect id');
  }
  if (state.work.terminalOutcomes.length > 1 || terminalEventCount > 1) {
    addViolation(violations, 'multiple_terminal_outcomes', 'work has more than one terminal outcome');
  }
  if (state.work.phase === TERMINAL && state.work.terminalOutcomes.length !== 1) {
    addViolation(violations, 'terminal_without_exactly_one_outcome', 'terminal work must have exactly one outcome');
  }
  if (state.work.phase !== TERMINAL && state.work.terminalOutcomes.length !== 0) {
    addViolation(violations, 'outcome_before_terminal', 'non-terminal work carries a terminal outcome');
  }
  if (terminalEventCount !== state.work.terminalOutcomes.length) {
    addViolation(violations, 'terminal_journal_state_mismatch', 'terminal event count differs from work state');
  }
  if (state.acceptedTransitions.length !== state.work.revision
    || prior.phase !== state.work.phase
    || prior.owner !== state.work.owner
    || prior.ownerEpoch !== state.work.ownerEpoch) {
    addViolation(violations, 'accepted_chain_state_mismatch', 'accepted transition chain does not reconstruct work state');
  }

  return { ok: violations.length === 0, violations };
}

function nextOwner(owner) {
  return owner === 'node-b' ? 'node-a' : 'node-b';
}

function ownedCommand(work, operation, writer, extra = {}) {
  return {
    operation,
    writer,
    owner: work.owner,
    ownerEpoch: work.ownerEpoch,
    ...extra,
  };
}

function candidateCommands(state) {
  const work = state.work;
  if (work.phase === EMPTY) {
    return [
      { operation: 'offer', writer: 'writer-a', owner: 'node-a', ownerEpoch: 1 },
      { operation: 'offer', writer: 'writer-b', owner: 'node-b', ownerEpoch: 1 },
    ];
  }
  if (work.phase === OFFERED) {
    return [
      ownedCommand(work, 'persist', 'writer-a'),
      ownedCommand(work, 'persist', 'writer-b'),
      ownedCommand(work, 'cancel', 'writer-b'),
    ];
  }
  if (work.phase === PERSISTED) {
    return [
      ownedCommand(work, 'start', 'writer-a'),
      ownedCommand(work, 'start', 'writer-b'),
      ownedCommand(work, 'cancel', 'writer-b'),
      ownedCommand(work, 'handoff', 'writer-b', {
        toOwner: nextOwner(work.owner),
        toEpoch: work.ownerEpoch + 1,
      }),
    ];
  }
  if (work.phase === STARTED) {
    return [
      ownedCommand(work, 'effect', 'writer-a', { effectId: 'primary-effect' }),
      ownedCommand(work, 'effect', 'writer-b', { effectId: 'primary-effect' }),
      ownedCommand(work, 'cancel', 'writer-b'),
      ownedCommand(work, 'terminal', 'writer-a', { outcome: 'completed' }),
      ownedCommand(work, 'terminal', 'writer-b', { outcome: 'failed' }),
      ownedCommand(work, 'terminal', 'writer-b', { outcome: 'cancelled' }),
      ownedCommand(work, 'recovery', 'writer-b', {
        toOwner: nextOwner(work.owner),
        toEpoch: work.ownerEpoch + 1,
        orphanEvidence: 'lease-expired',
      }),
    ];
  }
  if (work.phase === CANCEL_REQUESTED) {
    return [
      ownedCommand(work, 'effect', 'writer-a', { effectId: 'primary-effect' }),
      ownedCommand(work, 'terminal', 'writer-a', { outcome: 'cancelled' }),
      ownedCommand(work, 'terminal', 'writer-b', { outcome: 'cancelled' }),
      ownedCommand(work, 'recovery', 'writer-b', {
        toOwner: nextOwner(work.owner),
        toEpoch: work.ownerEpoch + 1,
        orphanEvidence: 'lease-expired',
      }),
    ];
  }
  return [
    ownedCommand(work, 'start', 'writer-b'),
    ownedCommand(work, 'effect', 'writer-b', { effectId: 'primary-effect' }),
    ownedCommand(work, 'terminal', 'writer-b', { outcome: 'failed' }),
    ownedCommand(work, 'recovery', 'writer-b', {
      toOwner: nextOwner(work.owner),
      toEpoch: work.ownerEpoch + 1,
      orphanEvidence: 'lease-expired',
    }),
  ];
}

function commandKey(command) {
  return JSON.stringify(command);
}

function nextAtomicActions(state, bounds) {
  const actions = [];
  if (state.journal.length < bounds.maxJournalEntries
    && state.pendingEvidenceIds.length < bounds.maxPending) {
    const pendingCommands = new Set(state.pendingEvidenceIds.map((id) => {
      const record = state.journal.find((candidate) => candidate.id === id);
      return commandKey(record.command);
    }));
    for (const command of candidateCommands(state)) {
      if (!pendingCommands.has(commandKey(command))) actions.push({ kind: 'record', command });
    }
  }
  for (const evidenceId of state.pendingEvidenceIds) actions.push({ kind: 'apply', evidenceId });
  return actions;
}

function boundedInteger(value, fallback, { minimum, maximum, label }) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isSafeInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} through ${maximum}`);
  }
  return candidate;
}

function normalizeBounds(options) {
  return {
    maxDepth: boundedInteger(options.maxDepth, DEFAULT_BOUNDS.maxDepth, {
      minimum: 1, maximum: 20, label: 'maxDepth',
    }),
    maxJournalEntries: boundedInteger(options.maxJournalEntries, DEFAULT_BOUNDS.maxJournalEntries, {
      minimum: 1, maximum: 10, label: 'maxJournalEntries',
    }),
    maxPending: boundedInteger(options.maxPending, DEFAULT_BOUNDS.maxPending, {
      minimum: 1, maximum: 3, label: 'maxPending',
    }),
    maxStates: boundedInteger(options.maxStates, DEFAULT_BOUNDS.maxStates, {
      minimum: 100, maximum: 1_000_000, label: 'maxStates',
    }),
  };
}

function ordered(values, reference = CUSTODY_MODEL_OPERATIONS) {
  const rank = new Map(reference.map((value, index) => [value, index]));
  return [...values].sort((left, right) => {
    const leftRank = rank.has(left) ? rank.get(left) : Number.MAX_SAFE_INTEGER;
    const rightRank = rank.has(right) ? rank.get(right) : Number.MAX_SAFE_INTEGER;
    return leftRank - rightRank || String(left).localeCompare(String(right));
  });
}

function stateKey(state) {
  // Rejected history and resolved evidence cannot affect future transitions.
  // Every concrete state is audited before this projection is used, so the
  // checker can merge equivalent futures without hiding a chain violation.
  const recordsById = new Map(state.journal.map((record) => [record.id, record]));
  const pending = state.pendingEvidenceIds.map((id) => {
    const record = recordsById.get(id);
    return {
      durable: record.durable,
      operation: record.operation,
      writer: record.writer,
      command: record.command,
      observed: record.observed,
    };
  });
  return JSON.stringify({
    work: {
      ...state.work,
      preStartCancelEvidenceId: state.work.preStartCancelEvidenceId === null ? null : 'confirmed',
    },
    journalEntries: state.journal.length,
    pending,
  });
}

function stepLabel(action, result) {
  if (action.kind === 'record') {
    return `journal ${action.command.operation} by ${action.command.writer} as ${result.evidenceId}`;
  }
  return `apply ${result.operation || '<unknown>'} from ${action.evidenceId}: ${result.decision}${result.reason ? ` (${result.reason})` : ''}`;
}

function reconstructTrace(nodes, nodeIndex, finalStep = null) {
  const trace = finalStep ? [finalStep] : [];
  let cursor = nodeIndex;
  while (cursor > 0) {
    trace.push(nodes[cursor].step);
    cursor = nodes[cursor].parent;
  }
  return trace.reverse();
}

export function checkCustodyInterleavings(options = {}) {
  const bounds = normalizeBounds(options);
  const initial = createCustodyModelState();
  const nodes = [{ state: initial, depth: 0, parent: -1, step: null }];
  const discovered = new Set([stateKey(initial)]);
  const journaledOperations = new Set();
  const acceptedOperations = new Set();
  const rejectedOperations = new Set();
  const rejectionReasons = new Set();
  const cancelModes = new Set();
  const writers = new Set();
  const phases = new Set();
  const witnesses = {};
  const violations = [];
  let cursor = 0;
  let transitionsExplored = 0;
  let duplicateStatesPruned = 0;
  let raceWindows = 0;
  let terminalStates = 0;
  let duplicateEffectAttemptsBlocked = 0;
  let executionAfterPreStartCancelBlocked = 0;
  let terminalConflictsBlocked = 0;
  let staleOwnerEpochBlocked = 0;
  let truncated = false;

  while (cursor < nodes.length && !truncated) {
    const nodeIndex = cursor;
    const node = nodes[cursor++];
    phases.add(node.state.work.phase);
    if (node.state.pendingEvidenceIds.length >= 2) raceWindows += 1;
    if (node.state.work.phase === TERMINAL) terminalStates += 1;

    const currentAudit = auditCustodyInvariants(node.state);
    if (!currentAudit.ok) {
      violations.push({
        violations: currentAudit.violations,
        trace: reconstructTrace(nodes, nodeIndex),
      });
      continue;
    }
    if (node.depth === bounds.maxDepth) continue;

    for (const action of nextAtomicActions(node.state, bounds)) {
      transitionsExplored += 1;
      const result = stepCustodyModel(node.state, action);
      const label = stepLabel(action, result);

      if (result.decision === 'journaled') {
        journaledOperations.add(result.operation);
        writers.add(action.command.writer);
      } else if (result.decision === 'accepted') {
        acceptedOperations.add(result.operation);
        if (result.event.cancelMode) cancelModes.add(result.event.cancelMode);
        if (!witnesses[result.operation]) {
          witnesses[result.operation] = reconstructTrace(nodes, nodeIndex, label);
        }
      } else {
        if (result.operation) rejectedOperations.add(result.operation);
        rejectionReasons.add(result.reason);
        if (result.operation === 'effect' && result.reason === 'duplicate-effect') {
          duplicateEffectAttemptsBlocked += 1;
        }
        if (result.operation === 'start' && node.state.work.preStartCancelEvidenceId !== null) {
          executionAfterPreStartCancelBlocked += 1;
        }
        if (result.operation === 'terminal' && result.reason === 'terminal-already-set') {
          terminalConflictsBlocked += 1;
        }
        if (result.reason === 'stale-owner-epoch' || result.reason === 'non-monotonic-owner-epoch') {
          staleOwnerEpochBlocked += 1;
        }
      }

      const nextAudit = auditCustodyInvariants(result.state);
      if (!nextAudit.ok) {
        violations.push({
          violations: nextAudit.violations,
          trace: reconstructTrace(nodes, nodeIndex, label),
        });
        if (violations.length >= 50) break;
      }

      const key = stateKey(result.state);
      if (discovered.has(key)) {
        duplicateStatesPruned += 1;
        continue;
      }
      if (nodes.length >= bounds.maxStates) {
        truncated = true;
        break;
      }
      discovered.add(key);
      nodes.push({
        state: result.state,
        depth: node.depth + 1,
        parent: nodeIndex,
        step: label,
      });
    }
  }

  const missingCoverage = [];
  for (const operation of CUSTODY_MODEL_OPERATIONS) {
    if (!acceptedOperations.has(operation)) missingCoverage.push(`accepted:${operation}`);
  }
  for (const mode of ['pre-start', 'post-start']) {
    if (!cancelModes.has(mode)) missingCoverage.push(`cancel-mode:${mode}`);
  }
  if (raceWindows === 0) missingCoverage.push('two-writer-race-window');
  if (duplicateEffectAttemptsBlocked === 0) missingCoverage.push('blocked:duplicate-effect');
  if (executionAfterPreStartCancelBlocked === 0) missingCoverage.push('blocked:execution-after-prestart-cancel');
  if (terminalConflictsBlocked === 0) missingCoverage.push('blocked:conflicting-terminal');
  if (staleOwnerEpochBlocked === 0) missingCoverage.push('blocked:stale-owner-epoch');

  return {
    schema: 'ae-link.custody-interleaving-check.v1',
    ok: violations.length === 0 && missingCoverage.length === 0 && !truncated,
    independentSpecification: true,
    reachabilityProjection: 'current-work+pending-evidence+journal-budget',
    bounds,
    statesExplored: cursor,
    statesDiscovered: nodes.length,
    transitionsExplored,
    duplicateStatesPruned,
    raceWindows,
    terminalStates,
    truncated,
    coverage: {
      requiredOperations: [...CUSTODY_MODEL_OPERATIONS],
      journaledOperations: ordered(journaledOperations),
      acceptedOperations: ordered(acceptedOperations),
      rejectedOperations: ordered(rejectedOperations),
      cancelModes: ordered(cancelModes, ['pre-start', 'post-start']),
      writers: ordered(writers, ['writer-a', 'writer-b']),
      phases: ordered(phases, [EMPTY, OFFERED, PERSISTED, STARTED, CANCEL_REQUESTED, TERMINAL]),
      duplicateEffectAttemptsBlocked,
      executionAfterPreStartCancelBlocked,
      terminalConflictsBlocked,
      staleOwnerEpochBlocked,
      witnesses,
    },
    missingCoverage,
    violations,
  };
}

if (import.meta.main) {
  const report = checkCustodyInterleavings();
  console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}
