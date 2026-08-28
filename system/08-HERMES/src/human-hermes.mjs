import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { compileProblem } from '../../03-BACKEND/problem-compiler.mjs';
import { createWave3HandoffCapsule } from '../../03-BACKEND/wave3-handoff-capsule.mjs';
import {
  key as desktopKey,
  left_click as desktopLeftClick,
  right_click as desktopRightClick,
  screenshot as desktopScreenshot,
  scroll as desktopScroll,
  type as desktopType,
} from '../adapters/computer-use.mjs';

export const HUMAN_HERMES_SCHEMA = 'orange.human-hermes-run.v1';
export const HUMAN_HERMES_PHASES = Object.freeze([
  'OBSERVE',
  'FORM_WORK_OBJECT',
  'PROPOSE',
  'ACQUIRE_LEASE',
  'ACT',
  'VERIFY',
  'REPORT',
]);

const DEFAULT_GATEWAY = 'http://127.0.0.1:1337';
const GENESIS_HASH = '0'.repeat(64);
const MUTATING_VERBS = new Set(['desktop.left_click', 'desktop.right_click', 'desktop.type', 'desktop.key']);
const ACTIONS = Object.freeze({
  'desktop.screenshot': desktopScreenshot,
  'desktop.left_click': desktopLeftClick,
  'desktop.right_click': desktopRightClick,
  'desktop.type': desktopType,
  'desktop.key': desktopKey,
  'desktop.scroll': desktopScroll,
});

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' || typeof value === 'number') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256(value) {
  return createHash('sha256').update(typeof value === 'string' ? value : canonicalJson(value)).digest('hex');
}

function requireOrder(order) {
  if (!order || order.schema !== 'orange.order.v1') throw new Error('Human Hermes requires orange.order.v1');
  if (!String(order.orderId ?? '').trim()) throw new Error('Human Hermes orderId is required');
  if (!String(order.intent ?? '').trim()) throw new Error('Human Hermes intent is required');
  const humanAction = order.payload?.humanAction;
  if (!humanAction || !ACTIONS[humanAction.verb]) {
    throw new Error(`Human Hermes requires a supported payload.humanAction.verb: ${Object.keys(ACTIONS).join(', ')}`);
  }
  const allowed = Array.isArray(order.allowedActions) ? order.allowedActions : [];
  if (!allowed.includes(humanAction.verb)) throw new Error(`${humanAction.verb} is not present in order.allowedActions`);
  const forbidden = Array.isArray(order.forbiddenActions) ? order.forbiddenActions : [];
  if (forbidden.includes(humanAction.verb)) throw new Error(`${humanAction.verb} is forbidden by the order`);
  return humanAction;
}

function phaseEvent(trace, phase, status, detail = {}) {
  const previousHash = trace.at(-1)?.eventHash ?? GENESIS_HASH;
  const payload = {
    schema: 'orange.human-hermes-phase.v1',
    sequence: trace.length + 1,
    phase,
    status,
    detail,
    previousHash,
  };
  const event = Object.freeze({ ...payload, eventHash: sha256(payload) });
  trace.push(event);
  return event;
}

async function postJson(fetchFn, baseUrl, endpoint, body) {
  const response = await fetchFn(`${baseUrl.replace(/\/+$/, '')}${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
  if (!response.ok || parsed?.ok === false) throw new Error(`${endpoint} returned ${response.status}: ${JSON.stringify(parsed)}`);
  return parsed;
}

export function createHumanHermesLeaseBroker({
  gatewayUrl = process.env.ORANGE5_ORANGEBRAIN_URL || DEFAULT_GATEWAY,
  fetchFn = globalThis.fetch,
} = {}) {
  return Object.freeze({
    async mint({ order, action, riskLevel }) {
      const response = await postJson(fetchFn, gatewayUrl, '/v1/hermes/lease', {
        actor: 'human-hermes',
        allowed: [action],
        forbidden: order.forbiddenActions ?? [],
        targetProject: order.targetProject ?? order.scope,
        riskLevel,
        ttl_ms: 120_000,
        requires_approval: MUTATING_VERBS.has(action),
        meta: { orderId: order.orderId, source: HUMAN_HERMES_SCHEMA },
      });
      const lease = response?.data?.lease;
      if (!lease?.id) throw new Error('Human Hermes lease mint returned no lease');
      return lease;
    },
    async revoke(lease, reason = 'Human Hermes reached terminal state') {
      await postJson(fetchFn, gatewayUrl, `/v1/hermes/lease/${encodeURIComponent(lease.id)}/revoke`, {
        actor: 'human-hermes', reason,
      });
      return true;
    },
  });
}

function defaultObservation(order, humanAction) {
  return Object.freeze({
    source: 'governed_order',
    orderId: order.orderId,
    declaredAction: humanAction.verb,
    targetProject: order.targetProject ?? order.scope ?? null,
    evidence: Object.freeze([...(Array.isArray(order.evidence) ? order.evidence : [])]),
  });
}

function defaultVerification(actionResult) {
  const receipt = actionResult?.receipt_path ?? actionResult?.receiptPath ?? actionResult?.receipt ?? null;
  const resultStatus = String(actionResult?.status ?? '').toLowerCase();
  const pass = actionResult?.ok === true || ['ok', 'completed', 'success', 'pass'].includes(resultStatus);
  return Object.freeze({
    pass,
    resultHash: sha256(actionResult ?? null),
    receipt,
    reason: pass ? 'action_result_reports_success' : 'action_result_not_successful',
  });
}

function persistReport(report, receiptPath) {
  if (!receiptPath) return null;
  const absolute = path.resolve(receiptPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return absolute;
}

export async function runHumanHermes({
  order,
  execute = false,
  operatorApproved = false,
  receiptPath = null,
} = {}, deps = {}) {
  const humanAction = requireOrder(order);
  const trace = [];
  const leaseBroker = deps.leaseBroker ?? createHumanHermesLeaseBroker(deps);
  const actionAdapters = { ...ACTIONS, ...(deps.actionAdapters ?? {}) };
  let lease = null;
  let revoked = false;
  let actionResult = null;
  let verification = null;
  let workObject = null;
  let handoffCapsule = null;
  let terminalStatus = 'blocked';
  let failure = null;

  try {
    const observation = deps.observe
      ? await deps.observe({ order, humanAction })
      : defaultObservation(order, humanAction);
    phaseEvent(trace, 'OBSERVE', 'completed', { observationHash: sha256(observation), source: observation.source ?? 'custom' });

    workObject = deps.compileProblem
      ? await deps.compileProblem(order)
      : compileProblem(order, {
          project: order.targetProject ?? order.scope ?? 'orange',
          authority: 'operator',
          owner: 'human-hermes',
        });
    phaseEvent(trace, 'FORM_WORK_OBJECT', 'completed', {
      workId: workObject.workId,
      compilationHash: workObject.compilationHash,
    });

    handoffCapsule = createWave3HandoffCapsule({
      workObject,
      order,
      route: order.route ?? { lane: 'human-hermes', model: null, decisionId: null },
      evidencePointers: observation.evidence ?? [],
    });
    phaseEvent(trace, 'PROPOSE', 'completed', {
      verb: humanAction.verb,
      capsuleId: handoffCapsule.capsuleId,
      mutating: MUTATING_VERBS.has(humanAction.verb),
    });

    if (!execute) {
      phaseEvent(trace, 'ACQUIRE_LEASE', 'not_started', { reason: 'proposal_only' });
      phaseEvent(trace, 'ACT', 'not_started', { reason: 'proposal_only' });
      phaseEvent(trace, 'VERIFY', 'not_started', { reason: 'proposal_only' });
      terminalStatus = 'awaiting_approval';
    } else {
      if (MUTATING_VERBS.has(humanAction.verb) && operatorApproved !== true) {
        throw new Error(`${humanAction.verb} requires explicit operator approval`);
      }
      const riskLevel = MUTATING_VERBS.has(humanAction.verb) ? 'medium' : 'low';
      lease = await leaseBroker.mint({ order, action: humanAction.verb, riskLevel });
      phaseEvent(trace, 'ACQUIRE_LEASE', 'completed', { leaseId: lease.id, riskLevel });

      const adapter = actionAdapters[humanAction.verb];
      if (typeof adapter !== 'function') throw new Error(`no action adapter for ${humanAction.verb}`);
      actionResult = await adapter({
        ...(humanAction.args ?? {}),
        lease,
        actor: 'human-hermes',
        targetProject: order.targetProject ?? order.scope,
        operatorApproved,
      });
      phaseEvent(trace, 'ACT', 'completed', { verb: humanAction.verb, resultHash: sha256(actionResult) });

      verification = deps.verify
        ? await deps.verify({ order, humanAction, actionResult, handoffCapsule })
        : defaultVerification(actionResult);
      phaseEvent(trace, 'VERIFY', verification.pass ? 'completed' : 'failed', verification);
      terminalStatus = verification.pass ? 'completed' : 'failed';
    }
  } catch (error) {
    failure = error?.message ?? String(error);
    const reached = new Set(trace.map(({ phase }) => phase));
    const nextPhase = HUMAN_HERMES_PHASES.find((phase) => !reached.has(phase) && phase !== 'REPORT');
    if (nextPhase) phaseEvent(trace, nextPhase, 'failed', { error: failure });
    terminalStatus = 'failed';
  } finally {
    if (lease) {
      try { revoked = await leaseBroker.revoke(lease) === true; }
      catch (error) {
        revoked = false;
        failure = failure ?? `lease revoke failed: ${error?.message ?? error}`;
        terminalStatus = 'failed';
      }
    }
  }

  const reportPayload = {
    schema: 'orange.report.v1',
    reportType: HUMAN_HERMES_SCHEMA,
    orderId: order.orderId,
    status: terminalStatus,
    confidence: terminalStatus === 'completed' ? 1 : terminalStatus === 'awaiting_approval' ? 0.8 : 0,
    actionsTaken: trace.filter(({ status }) => status === 'completed').map(({ phase }) => phase),
    evidence: [
      ...(actionResult ? [{ type: 'human_action_result', verb: humanAction.verb, resultHash: sha256(actionResult) }] : []),
      ...(verification ? [{ type: 'human_action_verification', ...verification }] : []),
      { type: 'human_hermes_trace', eventHashes: trace.map(({ eventHash }) => eventHash) },
      { type: 'wave3_handoff_capsule', capsuleId: handoffCapsule?.capsuleId ?? null, capsuleHash: handoffCapsule?.capsuleHash ?? null },
    ],
    blockers: failure ? [failure] : terminalStatus === 'awaiting_approval' ? ['execution not requested'] : [],
    nextAction: terminalStatus === 'completed'
      ? 'return verified result to OrangeBrain'
      : terminalStatus === 'awaiting_approval'
        ? 'operator may approve governed execution'
        : 'inspect failed phase and do not retry unchanged',
    receiptPath: receiptPath ? path.resolve(receiptPath) : null,
    custody: {
      leaseId: lease?.id ?? null,
      leaseRevoked: lease ? revoked : null,
      exactlyOneTerminalOutcome: true,
    },
    workObject: workObject ? { workId: workObject.workId, compilationHash: workObject.compilationHash } : null,
    handoffCapsule,
    phaseTrace: trace,
  };
  phaseEvent(trace, 'REPORT', 'completed', { status: terminalStatus });
  const report = { ...reportPayload, phaseTrace: trace };
  report.reportHash = sha256(report);
  persistReport(report, receiptPath);
  return Object.freeze(report);
}

export const HUMAN_HERMES_ACTIONS = Object.freeze(Object.keys(ACTIONS));
