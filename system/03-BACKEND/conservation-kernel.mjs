import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const CONSERVATION_STATE_SCHEMA = 'orange.conservation-state.v1';
export const CONSERVATION_DECISION_SCHEMA = 'orange.conservation-decision.v1';
export const CONSERVATION_EVENT_SCHEMA = 'orange.conservation-event.v1';

const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
export const DEFAULT_CONSERVATION_LEDGER = process.env.ORANGE5_CONSERVATION_LEDGER
  || path.join(DATA_ROOT, 'control', 'conservation-kernel', 'transitions.jsonl');

const AUTHORITY = Object.freeze({
  tool: 20,
  model: 30,
  agent: 40,
  hermes: 50,
  fixer: 50,
  navigator: 60,
  orangebrain: 70,
  operator: 100,
});

const PHASES = Object.freeze([
  'INTAKE', 'COMPILED', 'ROUTED', 'OFFERED', 'PERSISTED',
  'STARTED', 'OBSERVED', 'VERIFIED', 'TERMINAL',
]);

const sleepArray = new Int32Array(new SharedArrayBuffer(4));
const sha256 = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sorted(value[key])]));
}

export function stableStringify(value) {
  return JSON.stringify(sorted(value));
}

function clamp(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function authorityRank(name) {
  return AUTHORITY[String(name || '').toLowerCase()] ?? -1;
}

function semanticPayload(input = {}) {
  const work = input.work || input;
  const kernel = work.wave3Kernel || work.intelligentKernel || null;
  return {
    objective: work.objective || work.intent || work.action || null,
    commitments: Array.isArray(work.commitments) ? work.commitments : [],
    constraints: Array.isArray(work.constraints) ? work.constraints : [],
    forbidden: Array.isArray(work.forbidden) ? work.forbidden : [],
    acceptance: Array.isArray(work.acceptance) ? work.acceptance : [],
    targetProject: work.targetProject || work.project || null,
    wave3Kernel: kernel ? {
      manifestHash: kernel.manifestHash || null,
      worksetHash: kernel.worksetHash || null,
      activationBitset: kernel.activationBitset || null,
      activeMechanismIds: Array.isArray(kernel.activeMechanismIds) ? kernel.activeMechanismIds : [],
    } : null,
  };
}

export function semanticChecksum(input) {
  return sha256(stableStringify(semanticPayload(input)));
}

function normalizeEvidence(item, index = 0) {
  if (typeof item === 'string') {
    return {
      id: `evidence-${sha256(item).slice(0, 16)}`,
      kind: 'source_pointer',
      source: item,
      hash: sha256(item),
      authority: 'runtime',
    };
  }
  const source = item?.source || item?.uri || item?.path || item?.receiptPath
    || item?.receipt_id || item?.id || item?.kind || `inline:${index}`;
  const hash = item?.hash || item?.sha256 || item?.evidenceHash || sha256(stableStringify(item || source));
  return {
    id: item?.id || `evidence-${String(hash).slice(0, 16)}`,
    kind: item?.kind || 'source_pointer',
    source,
    hash,
    authority: item?.authority || item?.sourceAuthority || 'runtime',
  };
}

function evidenceKey(item) {
  return `${item.id}:${item.hash}`;
}

function mergeEvidence(current = [], additions = []) {
  const merged = new Map(current.map((item) => [evidenceKey(item), item]));
  additions.map(normalizeEvidence).forEach((item) => merged.set(evidenceKey(item), item));
  return [...merged.values()];
}

function stateHash(state) {
  const { stateHash: ignored, ...body } = state;
  return sha256(stableStringify(body));
}

function withStateHash(state) {
  return { ...state, stateHash: stateHash(state) };
}

function phaseAllowed(previous, next) {
  if (previous === next) return true;
  if (previous === 'TERMINAL') return false;
  const from = PHASES.indexOf(previous);
  const to = PHASES.indexOf(next);
  if (from < 0 || to < 0) return false;
  return to === from + 1 || (next === 'TERMINAL' && from >= PHASES.indexOf('PERSISTED'));
}

function ledgerEvents(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function acquireLock(filePath, timeoutMs = 2_000) {
  const lockPath = `${filePath}.lock`;
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const descriptor = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(descriptor, `${process.pid}:${Date.now()}\n`, 'utf8');
      return () => {
        try { fs.closeSync(descriptor); } catch {}
        try { fs.unlinkSync(lockPath); } catch {}
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        if (Date.now() - fs.statSync(lockPath).mtimeMs > 30_000) fs.unlinkSync(lockPath);
      } catch {}
      Atomics.wait(sleepArray, 0, 0, 20);
    }
  }
  throw new Error(`conservation ledger lock timeout: ${lockPath}`);
}

function appendEvent(event, filePath) {
  const release = acquireLock(filePath);
  try {
    const events = ledgerEvents(filePath);
    const previous = events.at(-1) || null;
    const chained = {
      ...event,
      previousEventHash: previous?.eventHash || null,
    };
    chained.eventHash = sha256(stableStringify(chained));
    fs.appendFileSync(filePath, `${JSON.stringify(chained)}\n`, 'utf8');
    return chained;
  } finally {
    release();
  }
}

function decision(accepted, current, proposal, violations, nextState = null) {
  const result = {
    schema: CONSERVATION_DECISION_SCHEMA,
    decisionId: `conservation-decision-${randomUUID()}`,
    workId: current.workId,
    orderId: current.orderId,
    accepted,
    transaction: accepted ? 'COMMITTED' : 'ROLLED_BACK',
    fromPhase: current.phase,
    toPhase: proposal.phase || current.phase,
    actor: proposal.actor || 'unknown',
    violations,
    conserved: {
      authority: !violations.some((item) => item.quantity === 'authority'),
      custody: !violations.some((item) => item.quantity === 'custody'),
      evidence: !violations.some((item) => item.quantity === 'evidence'),
      semantics: !violations.some((item) => item.quantity === 'semantics'),
      uncertainty: !violations.some((item) => item.quantity === 'uncertainty'),
    },
    previousStateHash: current.stateHash,
    nextStateHash: nextState?.stateHash || null,
    decidedAt: new Date().toISOString(),
  };
  result.decisionHash = sha256(stableStringify(result));
  return result;
}

export function beginConservationState(input, {
  owner = 'orangebrain',
  authority = 'operator',
  confidence = 0.5,
  uncertainty = 0.5,
  ledgerPath = DEFAULT_CONSERVATION_LEDGER,
} = {}) {
  const work = input?.work || input || {};
  const orderId = input?.orderId || work.orderId || work.id || null;
  const workId = work.workId || orderId || `work-${randomUUID()}`;
  const initialEvidence = mergeEvidence([], [
    { kind: 'work_object', source: `work:${workId}`, hash: work.compilationHash || semanticChecksum(work), authority },
  ]);
  const state = withStateHash({
    schema: CONSERVATION_STATE_SCHEMA,
    kernelId: `conservation-${randomUUID()}`,
    workId,
    orderId,
    phase: 'INTAKE',
    revision: 0,
    authority: { principal: authority, ceiling: authority, active: owner },
    custody: { owner, epoch: 0, status: 'INTAKE' },
    evidence: initialEvidence,
    semantics: { payload: semanticPayload(work), checksum: semanticChecksum(work), revision: 0 },
    epistemic: { confidence: clamp(confidence, 0.5), uncertainty: clamp(uncertainty, 0.5), debt: 0 },
    terminal: { committed: false, outcomeHash: null, status: null },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  const event = appendEvent({
    schema: CONSERVATION_EVENT_SCHEMA,
    eventId: `conservation-event-${randomUUID()}`,
    type: 'BEGIN',
    state,
    decision: null,
    at: state.createdAt,
  }, ledgerPath);
  return { ok: true, state, event, ledgerPath };
}

export function evaluateConservationTransition(current, proposal = {}) {
  if (!current || current.schema !== CONSERVATION_STATE_SCHEMA) throw new Error('valid conservation state required');
  const violations = [];
  const actor = String(proposal.actor || current.authority.active || 'unknown').toLowerCase();
  const actorRank = authorityRank(actor);
  const ceilingRank = authorityRank(current.authority.ceiling);
  const requestedAuthority = String(proposal.authority || actor).toLowerCase();
  const requestedRank = authorityRank(requestedAuthority);
  const nextPhase = proposal.phase || current.phase;

  if (actorRank < 0 || actorRank > ceilingRank || requestedRank < 0 || requestedRank > actorRank) {
    violations.push({ quantity: 'authority', code: 'AUTHORITY_ESCALATION', detail: `${actor} cannot commit as ${requestedAuthority} under ${current.authority.ceiling}` });
  }
  if (!phaseAllowed(current.phase, nextPhase)) {
    violations.push({ quantity: 'custody', code: 'INVALID_PHASE_TRANSITION', detail: `${current.phase} -> ${nextPhase}` });
  }
  if (current.terminal.committed) {
    violations.push({ quantity: 'custody', code: 'TERMINAL_ALREADY_COMMITTED', detail: current.terminal.outcomeHash });
  }

  let custody = { ...current.custody };
  if (proposal.custodyTransfer) {
    const transfer = proposal.custodyTransfer;
    const valid = transfer.from === current.custody.owner
      && typeof transfer.to === 'string' && transfer.to.length > 0
      && Number(transfer.epoch) === current.custody.epoch + 1;
    if (!valid) {
      violations.push({ quantity: 'custody', code: 'INVALID_CUSTODY_TRANSFER', detail: transfer });
    } else {
      custody = { owner: transfer.to, epoch: Number(transfer.epoch), status: transfer.status || current.custody.status };
    }
  } else if (proposal.owner && proposal.owner !== current.custody.owner) {
    violations.push({ quantity: 'custody', code: 'OWNER_CHANGED_WITHOUT_TRANSFER', detail: `${current.custody.owner} -> ${proposal.owner}` });
  }

  const existingEvidence = new Set(current.evidence.map(evidenceKey));
  const additions = (proposal.evidence || []).map(normalizeEvidence)
    .filter((item) => !existingEvidence.has(evidenceKey(item)));
  const evidence = mergeEvidence(current.evidence, additions);
  const confidence = clamp(proposal.confidence, current.epistemic.confidence);
  const uncertainty = clamp(proposal.uncertainty, current.epistemic.uncertainty);
  if (confidence > current.epistemic.confidence && additions.length === 0) {
    violations.push({ quantity: 'evidence', code: 'CONFIDENCE_WITHOUT_EVIDENCE', detail: `${current.epistemic.confidence} -> ${confidence}` });
  }
  if (uncertainty < current.epistemic.uncertainty && additions.length === 0 && proposal.verifiedOutcome !== true) {
    violations.push({ quantity: 'uncertainty', code: 'UNCERTAINTY_ERASED_WITHOUT_OBSERVATION', detail: `${current.epistemic.uncertainty} -> ${uncertainty}` });
  }

  let semantics = current.semantics;
  if (proposal.work || proposal.semanticPayload) {
    const nextPayload = semanticPayload(proposal.work || proposal.semanticPayload);
    const nextChecksum = sha256(stableStringify(nextPayload));
    if (nextChecksum !== current.semantics.checksum) {
      const amendment = proposal.semanticAmendment;
      const authorized = amendment?.authorizedBy === 'operator'
        && amendment?.previousChecksum === current.semantics.checksum
        && amendment?.source;
      if (!authorized) {
        violations.push({ quantity: 'semantics', code: 'SEMANTIC_DRIFT', detail: `${current.semantics.checksum} -> ${nextChecksum}` });
      } else {
        semantics = { payload: nextPayload, checksum: nextChecksum, revision: current.semantics.revision + 1 };
      }
    }
  }

  const terminalRequested = nextPhase === 'TERMINAL' || proposal.terminal === true;
  const outcomeHash = proposal.outcomeHash || (proposal.outcome ? sha256(stableStringify(proposal.outcome)) : null);
  if (terminalRequested && !outcomeHash) {
    violations.push({ quantity: 'evidence', code: 'TERMINAL_WITHOUT_OUTCOME', detail: 'terminal transition requires outcome or outcomeHash' });
  }
  if (terminalRequested && additions.length === 0 && proposal.verifiedOutcome !== true) {
    violations.push({ quantity: 'evidence', code: 'TERMINAL_WITHOUT_NEW_EVIDENCE', detail: 'terminal transition requires observed evidence' });
  }

  if (violations.length > 0) return { ok: false, state: current, decision: decision(false, current, proposal, violations) };

  const nextState = withStateHash({
    ...current,
    phase: nextPhase,
    revision: current.revision + 1,
    authority: { ...current.authority, active: requestedAuthority },
    custody: { ...custody, status: terminalRequested ? 'TERMINAL' : (proposal.custodyStatus || custody.status) },
    evidence,
    semantics,
    epistemic: {
      confidence,
      uncertainty,
      debt: clamp(proposal.debt, current.epistemic.debt),
    },
    terminal: terminalRequested
      ? { committed: true, outcomeHash, status: proposal.terminalStatus || proposal.outcome?.status || 'completed' }
      : current.terminal,
    updatedAt: new Date().toISOString(),
  });
  return { ok: true, state: nextState, decision: decision(true, current, proposal, [], nextState) };
}

export function commitConservationTransition(current, proposal = {}, { ledgerPath = DEFAULT_CONSERVATION_LEDGER } = {}) {
  const evaluated = evaluateConservationTransition(current, proposal);
  const event = appendEvent({
    schema: CONSERVATION_EVENT_SCHEMA,
    eventId: `conservation-event-${randomUUID()}`,
    type: evaluated.ok ? 'COMMIT' : 'ROLLBACK',
    state: evaluated.state,
    decision: evaluated.decision,
    at: new Date().toISOString(),
  }, ledgerPath);
  return { ...evaluated, event, ledgerPath };
}

export function verifyConservationLedger(filePath = DEFAULT_CONSERVATION_LEDGER) {
  const events = ledgerEvents(filePath);
  const errors = [];
  let previousHash = null;
  for (const [index, event] of events.entries()) {
    if (event.previousEventHash !== previousHash) errors.push({ index, code: 'CHAIN_LINK_MISMATCH' });
    const { eventHash, ...body } = event;
    if (sha256(stableStringify(body)) !== eventHash) errors.push({ index, code: 'EVENT_HASH_MISMATCH' });
    if (event.state && stateHash(event.state) !== event.state.stateHash) errors.push({ index, code: 'STATE_HASH_MISMATCH' });
    previousHash = eventHash;
  }
  return { ok: errors.length === 0, events: events.length, errors, head: previousHash };
}

export function summarizeConservation(state) {
  return {
    kernelId: state.kernelId,
    phase: state.phase,
    revision: state.revision,
    authority: state.authority,
    custody: state.custody,
    evidenceCount: state.evidence.length,
    semanticChecksum: state.semantics.checksum,
    confidence: state.epistemic.confidence,
    uncertainty: state.epistemic.uncertainty,
    terminal: state.terminal,
    stateHash: state.stateHash,
  };
}
