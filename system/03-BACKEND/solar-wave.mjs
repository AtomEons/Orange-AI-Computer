import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compileProblem } from './problem-compiler.mjs';
import {
  beginConservationState,
  commitConservationTransition,
  summarizeConservation,
} from './conservation-kernel.mjs';

export const SOLAR_WAVE_SCHEMA = 'orange.solar-wave.v1';
export const SOLAR_TRANSITION_SCHEMA = 'orange.solar-wave.transition.v1';
export const SOLAR_STATES = Object.freeze(['INTAKE', 'COMPILED', 'ROUTED', 'OFFERED', 'PERSISTED', 'STARTED', 'OBSERVED', 'VERIFIED', 'TERMINAL']);

const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const DEFAULT_LEDGER = process.env.ORANGE5_SOLAR_WAVE_LEDGER || path.join(DATA_ROOT, 'control', 'solar-wave', 'transitions.jsonl');
const sha256 = (value) => createHash('sha256').update(String(value ?? '')).digest('hex');

function events(filePath = DEFAULT_LEDGER) {
  try {
    return fs.readFileSync(filePath, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function append(event, filePath = DEFAULT_LEDGER) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(event)}\n`, 'utf8');
}

function currentFor(waveId, filePath = DEFAULT_LEDGER) {
  return events(filePath).filter((event) => event.waveId === waveId).at(-1) || null;
}

function allowedTransition(previous, next) {
  if (!previous) return next === 'INTAKE';
  if (previous.state === 'TERMINAL') return false;
  const from = SOLAR_STATES.indexOf(previous.state);
  const to = SOLAR_STATES.indexOf(next);
  return to === from + 1 || (next === 'TERMINAL' && from >= SOLAR_STATES.indexOf('PERSISTED'));
}

export function beginSolarWave(order, { ledgerPath = DEFAULT_LEDGER } = {}) {
  const work = compileProblem(order, { project: order.targetProject || 'orange5', authority: 'operator', owner: 'orangebrain' });
  const wave3Kernel = work.wave3Kernel || work.intelligentKernel || null;
  const waveId = `solar-${randomUUID()}`;
  const conservationLedgerPath = `${ledgerPath}.conservation.jsonl`;
  const conservation = beginConservationState({ work, orderId: order.orderId || order.id || work.workId }, {
    owner: 'orangebrain',
    authority: 'operator',
    ledgerPath: conservationLedgerPath,
  });
  const event = {
    schema: SOLAR_TRANSITION_SCHEMA,
    eventId: `solar-event-${randomUUID()}`,
    waveId,
    orderId: order.orderId || order.id || work.workId,
    state: 'INTAKE',
    previousState: null,
    at: new Date().toISOString(),
    authority: 'operator',
    work,
    wave3Kernel: wave3Kernel ? {
      manifestHash: wave3Kernel.manifestHash,
      worksetHash: wave3Kernel.worksetHash,
      activationBitset: wave3Kernel.activationBitset,
      activeMechanismIds: wave3Kernel.activeMechanismIds,
    } : null,
    prediction: null,
    observation: null,
    residual: null,
    semanticChecksum: sha256(JSON.stringify({
      objective: work.objective,
      constraints: work.constraints,
      forbidden: work.forbidden,
      acceptance: work.acceptance,
      wave3KernelManifestHash: wave3Kernel?.manifestHash || null,
      wave3KernelWorksetHash: wave3Kernel?.worksetHash || null,
      wave3KernelActivationBitset: wave3Kernel?.activationBitset || null,
    })),
    conservation: summarizeConservation(conservation.state),
    previousHash: null,
  };
  event.eventHash = sha256(JSON.stringify(event));
  append(event, ledgerPath);
  return {
    schema: SOLAR_WAVE_SCHEMA,
    waveId,
    orderId: event.orderId,
    work,
    semanticChecksum: event.semanticChecksum,
    ledgerPath,
    conservationLedgerPath,
    conservationState: conservation.state,
  };
}

export function transitionSolarWave(wave, state, patch = {}) {
  const previous = currentFor(wave.waveId, wave.ledgerPath);
  if (!allowedTransition(previous, state)) throw new Error(`invalid Solar Wave transition ${previous?.state || 'NONE'} -> ${state}`);
  if (patch.semanticChecksum && patch.semanticChecksum !== wave.semanticChecksum) throw new Error('semantic checksum mismatch');
  const evidence = patch.evidence || [];
  const conserved = commitConservationTransition(wave.conservationState, {
    phase: state,
    actor: patch.authority || 'orangebrain',
    authority: patch.authority || 'orangebrain',
    work: patch.work || previous?.work || wave.work,
    evidence,
    confidence: patch.confidence,
    uncertainty: patch.uncertainty,
    verifiedOutcome: patch.verifiedOutcome === true,
    terminal: state === 'TERMINAL',
    terminalStatus: patch.terminalStatus,
    outcome: state === 'TERMINAL' ? (patch.outcome || patch.observation || { status: patch.terminalStatus || 'completed' }) : undefined,
    custodyStatus: state,
    custodyTransfer: patch.custodyTransfer,
    semanticAmendment: patch.semanticAmendment,
  }, { ledgerPath: wave.conservationLedgerPath });
  if (!conserved.ok) {
    const details = conserved.decision.violations.map((item) => `${item.code}:${item.detail}`).join('; ');
    throw new Error(`Conservation Kernel rejected ${previous?.state || 'NONE'} -> ${state}: ${details}`);
  }
  wave.conservationState = conserved.state;
  const event = {
    schema: SOLAR_TRANSITION_SCHEMA,
    eventId: `solar-event-${randomUUID()}`,
    waveId: wave.waveId,
    orderId: wave.orderId,
    state,
    previousState: previous?.state || null,
    at: new Date().toISOString(),
    authority: patch.authority || 'orangebrain',
    work: patch.work || previous?.work || wave.work,
    prediction: patch.prediction ?? previous?.prediction ?? null,
    observation: patch.observation ?? previous?.observation ?? null,
    residual: patch.residual ?? previous?.residual ?? null,
    evidence,
    blockers: patch.blockers || [],
    semanticChecksum: wave.semanticChecksum,
    conservation: {
      decision: conserved.decision,
      state: summarizeConservation(conserved.state),
    },
    previousHash: previous?.eventHash || null,
  };
  event.eventHash = sha256(JSON.stringify(event));
  append(event, wave.ledgerPath);
  return event;
}

export function routeSolarWave(wave, route) {
  transitionSolarWave(wave, 'COMPILED', { evidence: [{ kind: 'work_object', hash: wave.work.compilationHash }] });
  return transitionSolarWave(wave, 'ROUTED', {
    prediction: {
      lane: route?.lane || route?.modelLane || null,
      model: route?.model || null,
      cost: route?.cost || route?.energy_score || null,
      latencyMs: route?.latencyMs || null,
      quality: route?.quality || null,
    },
  });
}

export function settleSolarWave(wave, result = {}) {
  const previous = currentFor(wave.waveId, wave.ledgerPath);
  const required = ['OFFERED', 'PERSISTED', 'STARTED'];
  let current = previous;
  for (const state of required) {
    if (SOLAR_STATES.indexOf(current.state) < SOLAR_STATES.indexOf(state)) current = transitionSolarWave(wave, state);
  }
  const observation = {
    status: result.status || result.report?.status || 'unknown',
    lane: result.lane || result.report?.lane || null,
    model: result.model || result.report?.model || null,
    latencyMs: result.latencyMs || null,
    evidenceCount: Array.isArray(result.report?.evidence || result.evidence) ? (result.report?.evidence || result.evidence).length : 0,
  };
  const resultEvidence = Array.isArray(result.report?.evidence || result.evidence)
    ? (result.report?.evidence || result.evidence)
    : [];
  const observedEvidence = [
    ...resultEvidence,
    {
      kind: 'runtime_observation',
      source: `solar:${wave.waveId}:observed`,
      hash: sha256(JSON.stringify(observation)),
      authority: 'runtime',
    },
  ];
  current = transitionSolarWave(wave, 'OBSERVED', {
    observation,
    evidence: observedEvidence,
    confidence: observation.status === 'completed' || observation.status === 'ok' ? 0.72 : 0.5,
  });
  const prediction = current.prediction || {};
  const residual = {
    laneChanged: Boolean(prediction.lane && observation.lane && prediction.lane !== observation.lane),
    modelChanged: Boolean(prediction.model && observation.model && prediction.model !== observation.model),
    latencyDeltaMs: prediction.latencyMs == null || observation.latencyMs == null ? null : observation.latencyMs - prediction.latencyMs,
    qualityDelta: null,
  };
  const verificationEvidence = [{
    kind: 'verification',
    source: `solar:${wave.waveId}:verification`,
    hash: sha256(JSON.stringify({ observation, residual, blockers: result.report?.blockers || result.blockers || [] })),
    authority: 'runtime',
  }];
  transitionSolarWave(wave, 'VERIFIED', {
    observation,
    residual,
    evidence: verificationEvidence,
    verifiedOutcome: true,
    confidence: observation.status === 'completed' || observation.status === 'ok' ? 0.82 : 0.55,
    uncertainty: observation.status === 'completed' || observation.status === 'ok' ? 0.18 : 0.45,
  });
  const terminalEvidence = [{
    kind: 'terminal_outcome',
    source: result.receipt?.receipt_id || result.receipt?.hash || `solar:${wave.waveId}:terminal`,
    hash: result.receipt?.hash || sha256(JSON.stringify({ observation, residual })),
    authority: result.receipt ? 'receipt' : 'runtime',
  }];
  return transitionSolarWave(wave, 'TERMINAL', {
    observation,
    residual,
    evidence: terminalEvidence,
    blockers: result.report?.blockers || result.blockers || [],
    verifiedOutcome: true,
    terminalStatus: observation.status,
    outcome: { observation, residual, receipt: result.receipt?.hash || null },
  });
}

export function readSolarWave(waveId, filePath = DEFAULT_LEDGER) {
  return events(filePath).filter((event) => event.waveId === waveId);
}
