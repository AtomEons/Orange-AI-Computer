import path from 'node:path';
import { BuildRunStore } from '../04-CONTROL-PLANE/build-runs/store.mjs';
import { appendPartyLineEvent } from '../04-CONTROL-PLANE/party-line/ledger.mjs';

const SUCCESS = new Set(['ok', 'completed', 'ready', 'planned']);

const clean = (value, max = 2_000) => String(value ?? '').replace(/\u0000/g, '').trim().slice(0, max);
const list = (value) => Array.isArray(value) ? value.filter(Boolean) : (value ? [value] : []);

function actionOf(order = {}) {
  return clean(order.action || order.intent || order.type || 'orange.order', 256);
}

function orderIdOf(order = {}) {
  return clean(order.orderId || order.order_id || order.id || '', 256) || null;
}

function modeOf(order = {}) {
  const action = actionOf(order).toLowerCase();
  if (/repair|fix|recover/.test(action)) return 'repair';
  if (/verify|test|audit|check|inspect|health/.test(action)) return 'verify';
  if (/release|deploy|publish|ship/.test(action)) return 'release';
  if (order.dryRun === true || order.mode === 'plan') return 'plan';
  return 'execute';
}

function finalStatus(result = {}) {
  const status = clean(result.status || result.report?.status || 'failed', 128).toLowerCase();
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  if (SUCCESS.has(status)) return 'completed';
  if (/block|halt|denied|approval/.test(status)) return 'blocked';
  return 'failed';
}

function sourceRefs(result = {}) {
  const refs = [];
  const receipt = result.receipt || {};
  const receiptPath = receipt.receiptPath || receipt.receipt_path || result.report?.receiptPath;
  if (receiptPath) refs.push({ uri: clean(receiptPath, 2_048), hash: receipt.hash || null, label: 'outcome receipt' });
  for (const evidence of list(result.report?.evidence || result.evidence)) {
    if (typeof evidence === 'string' && (/^[a-z]+:\/\//i.test(evidence) || path.isAbsolute(evidence))) {
      refs.push({ uri: clean(evidence, 2_048), label: 'execution evidence' });
    } else if (evidence?.path || evidence?.uri || evidence?.receiptPath) {
      refs.push(evidence);
    }
  }
  return refs.slice(0, 32);
}

function blockersOf(result = {}) {
  return list(result.report?.blockers || result.blockers || result.mistakes)
    .map((item) => typeof item === 'string' ? item : item?.message || item?.reason || item?.code || JSON.stringify(item))
    .map((item) => clean(item, 2_000))
    .filter(Boolean)
    .slice(0, 128);
}

function evidenceOf(result = {}) {
  return list(result.report?.evidence || result.evidence)
    .map((item) => typeof item === 'string' ? item : item)
    .slice(0, 512);
}

function receiptOf(result = {}) {
  if (!result.receipt) return [];
  return [{
    receiptId: result.receipt.receipt_id || result.receipt.receiptId || null,
    hash: result.receipt.hash || null,
    seq: result.receipt.seq ?? null,
    path: result.receipt.receiptPath || result.receipt.receipt_path || null,
  }];
}

async function partyLine(raw) {
  try {
    const event = await appendPartyLineEvent(raw);
    return { ok: true, eventId: event.id, seq: event.seq, hash: event.entryHash };
  } catch (error) {
    return { ok: false, error: clean(error?.message || error, 4_000) };
  }
}

export async function beginOperationalContinuum(order = {}, {
  projectRoot = process.cwd(),
  workspaceRoots = [process.cwd()],
  threadId = null,
  store = new BuildRunStore(),
} = {}) {
  const action = actionOf(order);
  const orderId = orderIdOf(order);
  const correlationId = orderId || threadId || null;
  const ensured = await store.ensureForThread({
    threadId: threadId || order.threadId || order.payload?.threadId || orderId,
    goal: clean(order.intent || order.goal || action, 16_000),
    projectRoot,
    workspaceRoots,
    mode: modeOf(order),
  });
  const updated = await store.update(ensured.run.runId, {
    order,
    stage: 'route',
    status: 'working',
    nextAction: `Route and execute ${action}`,
  }, 'order_persisted');
  const line = await partyLine({
    projectId: clean(order.targetProject || order.projectId || 'orange5', 256),
    topic: 'operations',
    actor: { id: 'orangebrain', kind: 'system', displayName: 'OrangeBrain' },
    eventType: 'order',
    status: 'working',
    summary: `Accepted governed order: ${action}`,
    detail: { orderId, runId: updated.run.runId, order },
    correlationId,
    importance: Number(order.riskLevel || order.risk_level || 0) >= 0.7 ? 0.9 : 0.65,
    tags: ['orange-order', 'build-run', modeOf(order)],
  });
  return { store, run: updated.run, partyLine: line };
}

export async function settleOperationalContinuum(context, result = {}) {
  if (!context?.run || !context?.store) return { ok: false, error: 'continuum context missing' };
  const status = finalStatus(result);
  const route = result.route || result.plan?.route || result.receipt?.route || null;
  const modelLane = result.lane || result.report?.lane || result.receipt?.lane || null;
  const blockers = blockersOf(result);
  const nextAction = clean(result.report?.nextAction || result.nextAction || (status === 'completed' ? 'Await the next governed order.' : 'Inspect blockers and repair the exact failed path.'), 4_000);
  let runUpdate;
  try {
    runUpdate = await context.store.update(context.run.runId, {
      stage: 'settle',
      status,
      route,
      modelLane,
      evidence: evidenceOf(result),
      receipts: receiptOf(result),
      blockers,
      nextAction,
    }, 'terminal_outcome');
  } catch (error) {
    return { ok: false, runId: context.run.runId, error: clean(error?.message || error, 4_000), partyLine: context.partyLine };
  }

  const orderId = orderIdOf(runUpdate.run.order || {});
  const summary = status === 'completed'
    ? `Order completed: ${actionOf(runUpdate.run.order)}`
    : `Order ${status}: ${actionOf(runUpdate.run.order)}`;
  const reportLine = await partyLine({
    projectId: clean(runUpdate.run.order?.targetProject || runUpdate.run.order?.projectId || 'orange5', 256),
    topic: 'operations',
    actor: { id: modelLane || 'orange-runtime', kind: modelLane ? 'model' : 'system', displayName: modelLane || 'Orange Runtime' },
    eventType: status === 'blocked' || status === 'failed' ? 'blocker' : 'report',
    status,
    summary,
    body: clean(result.report?.summary || result.report?.message || result.report?.result || '', 64_000) || null,
    detail: {
      orderId,
      runId: runUpdate.run.runId,
      route,
      lane: modelLane,
      blockers,
      nextAction,
      receipt: receiptOf(result)[0] || null,
    },
    sourceRefs: sourceRefs(result),
    correlationId: orderId || runUpdate.run.threadId || runUpdate.run.runId,
    importance: status === 'completed' ? 0.7 : 0.95,
    tags: ['orange-report', 'build-run', status],
  });
  return {
    ok: reportLine.ok,
    runId: runUpdate.run.runId,
    status: runUpdate.run.status,
    stage: runUpdate.run.stage,
    partyLine: reportLine,
  };
}
