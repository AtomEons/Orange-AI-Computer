#!/usr/bin/env bun
// OrangeFive cross-organ conductor: one order through the live brain, memory,
// policy, execution, compression, and receipt organs. No organ may fake green.

import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { runOrder } from './orange5-spine.mjs';
import { runGatewayAdversarialPass } from './adversarial-pass.mjs';
import { DurableRunStore } from './durable-run-store.mjs';
import { TraceStore } from './trace-store.mjs';
import { compileOrangeReport, validateOrangeReport } from '../06-ORANGELLM/contracts/orange-report.mjs';
import { canonicalFluxRoot } from '../06-ORANGELLM/memory/ae-cobra/paths.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const SPINE_CHAIN = path.join(ROOT, '10-RECEIPTS', 'spine-chain.jsonl');
const MISSION_CHAIN = path.join(RECEIPT_DIR, 'cross-organ-mission-chain.jsonl');

const DEFAULTS = Object.freeze({
  brain: 'http://127.0.0.1:1337',
  cobra: 'http://127.0.0.1:7419',
  hermes: 'http://127.0.0.1:7430',
  atomsmasher: 'http://127.0.0.1:8901',
});

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readJsonl(file) {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function requestJson(url, init = {}, timeoutMs = 30_000) {
  const started = performance.now();
  let response;
  try {
    response = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new Error(`${url} transport failure: ${error?.message ?? error}`);
  }
  const text = await response.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch { body = { raw: text.slice(0, 1000) }; }
  const result = { http: response.status, ok: response.ok, latency_ms: Math.round((performance.now() - started) * 100) / 100, body };
  if (!response.ok) throw new Error(`${url} returned ${response.status}: ${JSON.stringify(body)}`);
  return result;
}

export function createMissionOrder(intent = 'Prove the OrangeFive live cross-organ operational spine') {
  const orderId = `orange5-mission-${randomUUID()}`;
  return {
    schema: 'orange.order.v1',
    orderId,
    action: 'query_only',
    intent,
    scope: 'OrangeFive operational proof',
    allowedActions: ['query_only'],
    forbiddenActions: ['destructive_write', 'production_deploy', 'scope_expansion', 'egress_unbounded'],
    targetProject: 'orange5',
    riskLevel: 'read_only',
    requiresReceipt: true,
    payload: { proof: 'brain-memory-policy-execution-compression-receipt' },
  };
}

export { compileOrangeReport, validateOrangeReport } from '../06-ORANGELLM/contracts/orange-report.mjs';

function nextMissionReceipt(body) {
  const chain = readJsonl(MISSION_CHAIN);
  const existing = chain.find((item) => item.receipt_id === body.receipt_id);
  if (existing) return existing;
  const prev_hash = chain.length ? chain.at(-1).hash : sha256('orangefive-cross-organ-genesis');
  const unsigned = { ...body, seq: chain.length, prev_hash };
  const receipt = { ...unsigned, hash: sha256(`${prev_hash}|${stableJson(unsigned)}`) };
  fs.appendFileSync(MISSION_CHAIN, `${JSON.stringify(receipt)}\n`);
  return receipt;
}

export async function runCrossOrganMission(options = {}) {
  const endpoints = { ...DEFAULTS, ...(options.endpoints ?? {}) };
  const order = options.order ?? createMissionOrder(options.intent);
  const receiptPath = options.receiptPath ?? path.join(RECEIPT_DIR, `${order.orderId}.json`);
  const evidence = {};
  const startedAt = new Date().toISOString();
  const durable = new DurableRunStore(options.durableDbPath);
  const traces = new TraceStore(options.traceDbPath);
  const traceId = `trace_${sha256(order.orderId).slice(0, 32)}`;
  traces.openTrace({ traceId, name: 'orangefive.cross-organ-mission', attributes: { orderId: order.orderId, action: order.action } });
  const rootSpanId = traces.startSpan({ traceId, name: 'cross-organ-mission.run', kind: 'orchestrator', attributes: { orderId: order.orderId } });
  let rootSpanClosed = false;
  durable.openRun({
    runId: order.orderId,
    orderId: order.orderId,
    runType: 'orangefive.cross-organ-mission.v1',
    input: { order, endpoints },
  });
  const runStep = async (stepName, stepIndex, input, execute) => {
    const spanId = traces.startSpan({
      traceId,
      parentSpanId: rootSpanId,
      name: stepName,
      kind: traceKind(stepName),
      attributes: { step_index: stepIndex, input_hash: sha256(stableJson(input)) },
    });
    try {
      const result = await durable.step({ runId: order.orderId, stepName, stepIndex, input, execute });
      traces.endSpan(spanId, {
        status: 'ok',
        attributes: { resumed: result.resumed, attempt: result.attempt },
        result: { output_hash: sha256(stableJson(result.output)) },
      });
      return result.output;
    } catch (error) {
      traces.endSpan(spanId, { status: 'error', error });
      throw error;
    }
  };

  try {

  // The provisional receipt is real evidence for Hermes gate 3. It is replaced
  // atomically in-place by the final receipt after every organ has answered.
  writeJson(receiptPath, {
    schema: 'orange5.receipt.v0', receipt_type: 'orange5.cross-organ-mission.v1',
    receipt_id: order.orderId, generated_at: startedAt,
    actor: 'orangefive-cross-organ-conductor', orderId: order.orderId,
    status: 'running', confidence: 0, hash_chain: 1, started_at: startedAt,
  });

  const intake = await runStep('cobra_intake', 1, { endpoint: endpoints.cobra, order }, () => requestJson(`${endpoints.cobra}/event`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: 'terminal', event: { order_id: order.orderId, action: order.action, intent: order.intent, status: 'received' } }),
  }));
  if (!intake.body?.accepted || intake.body?.lane !== 'reality') throw new Error(`Cobra rejected mission intake: ${JSON.stringify(intake.body)}`);
  evidence.cobra_intake = { event_id: intake.body.id, lane: intake.body.lane, score: intake.body.score, latency_ms: intake.latency_ms };

  const recalled = await runStep('cobra_recall', 2, { endpoint: endpoints.cobra, intake_id: intake.body.id }, () => requestJson(`${endpoints.cobra}/state-brief`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: '', time_range_ms: 3_600_000, max_records: 100 }),
  }));
  const recallRows = [...(recalled.body?.reality ?? []), ...(recalled.body?.thought ?? []), ...(recalled.body?.merge ?? [])];
  const recalledIntake = recallRows.some((row) => row?.id === intake.body.id);
  if (!recalledIntake) throw new Error('Cobra state brief did not recall the mission intake');
  evidence.cobra_recall = { recalled: true, records_considered: recallRows.length, latency_ms: recalled.latency_ms };

  const brain = await runStep('orangebrain_report', 3, { endpoint: endpoints.brain, order }, () => requestJson(`${endpoints.brain}/v1/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'orange-navigator', reasoning_effort: 'none', temperature: 0, max_tokens: 512,
      ae_response_contract: 'orange.report.v1', ae_order_id: order.orderId,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: 'Return only orange.report.v1 JSON. Never claim work without evidence.' }, { role: 'user', content: JSON.stringify(order) }],
    }),
  }, 180_000));
  const rawContent = brain.body?.choices?.[0]?.message?.content;
  let brainReport;
  try { brainReport = typeof rawContent === 'string' ? JSON.parse(rawContent) : rawContent; }
  catch { throw new Error('OrangeBrain returned non-JSON content'); }
  const gatewayRepairApplied = Boolean(brain.body?.ae_report_repair_applied);
  const compiled = compileOrangeReport(brainReport, order.orderId);
  brainReport = compiled.report;
  evidence.orangebrain = {
    valid_report: true, model: brain.body?.model ?? null, lane: brain.body?.ae_lane ?? null,
    host: brain.body?.ae_host ?? null, latency_ms: brain.latency_ms,
    execution_performed: brain.body?.ae_execution_performed === true,
    evidence_authority: brain.body?.ae_evidence_authority ?? null,
    evidence_policy: brain.body?.ae_evidence_policy ?? null,
    evidence_fidelity: brain.body?.ae_evidence_fidelity ?? null,
    supplied_evidence_count: brain.body?.ae_supplied_evidence_count ?? 0,
    supplied_evidence_sha256: brain.body?.ae_supplied_evidence_sha256 ?? null,
    model_evidence_sha256: brain.body?.ae_model_evidence_sha256 ?? null,
    receipt_authority: brain.body?.ae_receipt_authority ?? null,
    repair_applied: gatewayRepairApplied || compiled.repair_applied,
    repair_layer: gatewayRepairApplied ? 'gateway' : (compiled.repair_applied ? 'conductor-fallback' : null),
    validation_error: brain.body?.ae_report_validation_error ?? compiled.validation_error,
  };

  const leaseResponse = await runStep('hermes_lease', 4, { endpoint: endpoints.hermes, order }, () => requestJson(`${endpoints.hermes}/lease`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actor: 'orangefive-cross-organ-conductor', allowed: [order.action], forbidden: order.forbiddenActions, targetProject: 'orange5', riskLevel: 'read_only', ttl_ms: 120_000, requires_approval: false, meta: { orderId: order.orderId } }),
  }));
  const lease = leaseResponse.body?.data?.lease;
  if (!lease?.id) throw new Error(`Hermes did not mint a lease: ${JSON.stringify(leaseResponse.body)}`);

  const hermesReport = {
    schema: 'orange.report.v1', orderId: order.orderId, status: 'ready', confidence: 1,
    actionsTaken: ['received order', 'recalled mission intake', 'compiled OrangeBrain report'],
    evidence: [{ type: 'receipt', path: receiptPath }], blockers: [],
    nextAction: 'execute read-only health observation', receiptPath,
  };
  const authorized = await runStep('hermes_authorize', 5, { endpoint: endpoints.hermes, lease_id: lease.id, order, report: hermesReport }, () => requestJson(`${endpoints.hermes}/action`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      lease_id: lease.id, actor: lease.actor, action_verb: order.action,
      order: { ...order, receipt_path: receiptPath }, report: hermesReport,
      action: { kind: 'tool_call', verb: order.action, status: 'ready', via_gateway: true, mcp_handshake: true, tool: 'orangefive-conductor', card: 'system.health', surface: 'gateway', risk_level: 'read_only' },
      receipt_path: receiptPath,
    }),
  }, 60_000));
  const gateResults = authorized.body?.data?.results;
  if (!authorized.body?.data?.pass || !Array.isArray(gateResults) || gateResults.length !== 8 || gateResults.some((gate) => gate.pass !== true)) {
    throw new Error(`Hermes did not pass all eight gates: ${JSON.stringify(authorized.body)}`);
  }
  evidence.hermes = { lease_id: lease.id, misfit: authorized.body.data.misfit?.decision ?? null, gates: gateResults.map((gate) => gate.id), latency_ms: authorized.latency_ms };

  const healthTargets = [
    ['orangebrain', `${endpoints.brain}/healthz`], ['cobra', `${endpoints.cobra}/healthz`],
    ['hermes', `${endpoints.hermes}/healthz`], ['atomsmasher', `${endpoints.atomsmasher}/health`],
  ];
  const health = await runStep('live_health', 6, { targets: healthTargets }, async () => Object.fromEntries(await Promise.all(healthTargets.map(async ([name, url]) => {
    const result = await requestJson(url);
    return [name, { http: result.http, latency_ms: result.latency_ms, service: result.body?.service ?? name }];
  }))));
  evidence.execution = { action: 'query_only', health };

  const adversarial = await runStep('independent_refuter', 7, { endpoint: endpoints.brain, order, health }, () => runGatewayAdversarialPass({
    url: endpoints.brain,
    order: { ...order, evidence: { n: Object.keys(evidence).length, sources: Object.keys(evidence) } },
    primaryResult: {
      summary: `The supplied records show order action ${order.action} with risk ${order.riskLevel}, Hermes authorization passing ${evidence.hermes.gates.length} of 8 gates, and HTTP 200 health responses from ${Object.keys(health).join(', ')}.`,
      output: {
        evidence: [
          {
            probe: 'authorized_read_only_order',
            order_id: order.orderId,
            action: order.action,
            allowed_actions: order.allowedActions,
            forbidden_actions: order.forbiddenActions,
            risk_level: order.riskLevel,
            hermes_authorized: true,
            hermes_gate_count: evidence.hermes.gates.length,
          },
          {
            probe: 'live_service_health',
            method: 'GET',
            observed_at: new Date().toISOString(),
            result: Object.fromEntries(Object.entries(health).map(([name, value]) => [name, value.http])),
            pass: Object.values(health).every((value) => value.http === 200),
          },
          {
            probe: 'governed_organs',
            orange_report_schema: brainReport.schema,
            cobra_intake_recalled: evidence.cobra_recall.recalled,
            hermes_gate_count: evidence.hermes.gates.length,
            hermes_all_gates_passed: evidence.hermes.gates.length === 8,
          },
        ],
      },
    },
  }));
  evidence.adversarial = {
    completed: adversarial.completed === true,
    pre_execution: adversarial.preExecution === true,
    refuted: adversarial.refuted === true,
    status: adversarial.status,
    reason: adversarial.reason,
    model: adversarial.model,
    lane: adversarial.lane,
  };
  if (!adversarial.completed || adversarial.refuted) {
    throw new Error(`independent refuter did not clear the mission: ${JSON.stringify({
      status: adversarial.status,
      reason: adversarial.reason,
      blockers: adversarial.blockers,
      report: adversarial.report,
    })}`);
  }

  const spineResult = await runStep('governed_spine', 8, {
    order,
    lease_id: lease.id,
    adversarial_status: adversarial.status,
    evidence_sources: Object.keys(evidence),
  }, async () => {
    const chain = readJsonl(SPINE_CHAIN);
    const prior = chain.find((entry) => entry.campaign_id === order.orderId && entry.status === 'ok');
    if (prior) {
      return {
        status: 'ok',
        report: compileOrangeReport({
          schema: 'orange.report.v1', orderId: order.orderId, status: 'ready', confidence: 1,
          actionsTaken: ['recovered existing governed spine checkpoint'],
          evidence: [{ type: 'receipt', path: receiptPath }], blockers: [],
          nextAction: 'continue the durable mission', receiptPath,
        }, order.orderId).report,
        receipt: prior,
        lane: prior.lane,
        compression: { completed: true, result_type: 'RecoveredSpineReceipt' },
      };
    }
    const result = runOrder({ ...order, evidence: { n: Object.keys(evidence).length, sources: Object.keys(evidence) } }, {
      receiptChain: chain,
      fluxRoot: canonicalFluxRoot(),
      receiptPath,
      lease: { id: lease.id, allowed: [order.action], forbidden: order.forbiddenActions, requires_approval: false },
      adversarialEvidence: adversarial,
      executor: () => ({ ok: true, summary: 'live cross-organ mission executed with receipt-backed evidence', output: { brain_report: brainReport, health }, lane: brain.body?.ae_lane ?? 'navigator', model: brain.body?.model ?? null, host: brain.body?.ae_host ?? null, evidence: { n: Object.keys(evidence).length, sources: Object.keys(evidence) } }),
      expertId: 'orange-navigator', campaignId: order.orderId,
    });
    if (result.status !== 'ok') throw new Error(`OrangeFive spine returned ${result.status}: ${result.report?.summary}`);
    fs.writeFileSync(SPINE_CHAIN, chain.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
    const compressed = await result.compressionDone;
    return {
      status: result.status,
      report: result.report,
      receipt: result.receipt,
      lane: result.lane,
      compression: { completed: compressed != null, result_type: compressed?.constructor?.name ?? typeof compressed },
    };
  });
  evidence.spine = { receipt_id: spineResult.receipt.receipt_id, hash: spineResult.receipt.hash, lane: spineResult.lane, epistemic_score: spineResult.receipt.epistemic_score ?? null };
  evidence.compression = spineResult.compression;

  const smashed = await runStep('atomsmasher_receipt', 9, { endpoint: endpoints.atomsmasher, order_id: order.orderId, spine_receipt: spineResult.receipt.receipt_id }, () => requestJson(`${endpoints.atomsmasher}/receipt`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'orangefive.cross-organ-mission', status: 'ok', summary: spineResult.report.summary, featureId: 'orangefive-live-conductor', payload: { orderId: order.orderId, spine_receipt: spineResult.receipt.receipt_id, evidence } }),
  }));
  if (!smashed.body?.ok || !smashed.body?.id) throw new Error(`AtomSmasher rejected receipt: ${JSON.stringify(smashed.body)}`);
  const smashedLookup = await runStep('atomsmasher_verify', 10, { endpoint: endpoints.atomsmasher, receipt_id: smashed.body.id }, () => requestJson(`${endpoints.atomsmasher}/receipts?action=orangefive.cross-organ-mission&limit=10`));
  if (!(smashedLookup.body?.rows ?? []).some((row) => String(row.id) === String(smashed.body.id))) throw new Error('AtomSmasher could not retrieve the receipt it inserted');
  evidence.atomsmasher = { receipt_id: smashed.body.id, retrieved: true, latency_ms: smashed.latency_ms };

  const completionBundle = await runStep('cobra_completion', 11, {
    endpoint: endpoints.cobra,
    order_id: order.orderId,
    spine_receipt: spineResult.receipt.receipt_id,
    atomsmasher_receipt: smashed.body.id,
  }, async () => {
    const completed = await requestJson(`${endpoints.cobra}/event`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ origin: 'terminal', event: { order_id: order.orderId, action: order.action, status: 'completed', spine_receipt: spineResult.receipt.receipt_id, atomsmasher_receipt: smashed.body.id } }),
    });
    const chainProof = await requestJson(`${endpoints.cobra}/verify-chain`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lane: 'reality' }),
    });
    return { completed, chainProof };
  });
  const { completed, chainProof } = completionBundle;
  if (!completed.body?.accepted || completed.body?.lane !== 'reality') throw new Error(`Cobra rejected completion: ${JSON.stringify(completed.body)}`);
  if (!chainProof.body?.ok) throw new Error(`Cobra reality chain failed: ${JSON.stringify(chainProof.body)}`);
  evidence.cobra_completion = { event_id: completed.body.id, chain_count: chainProof.body.count, chain_valid: true };
  const durableBeforeFinal = durable.verifyRun(order.orderId);
  evidence.durable_execution = {
    run_id: order.orderId,
    checkpoint_store: durable.path,
    integrity_ok: durableBeforeFinal.ok,
    required_checkpoints_before_final: 11,
    completed_checkpoints_before_final: Math.min(durableBeforeFinal.completed, 11),
    resumable: true,
  };
  evidence.observability = {
    trace_id: traceId,
    trace_store: traces.path,
    hierarchical_spans: true,
    checkpoint_correlated: true,
  };

  const receipt = await runStep('final_receipt', 12, { order_id: order.orderId, evidence_hash: sha256(stableJson(evidence)) }, async () => {
    const finalReceipt = nextMissionReceipt({
    schema: 'orange5.receipt.v0', receipt_type: 'orange5.cross-organ-mission.v1',
    receipt_id: order.orderId, generated_at: new Date().toISOString(),
    actor: 'orangefive-cross-organ-conductor', orderId: order.orderId,
    status: 'GREEN', confidence: 1, hash_chain: 1,
    started_at: startedAt, completed_at: new Date().toISOString(),
    order, report: spineResult.report, evidence, blockers: [],
    });
    writeJson(receiptPath, finalReceipt);
    return finalReceipt;
  });
  // A resumed run rewrites the canonical final receipt after the provisional
  // running marker, without appending another mission-chain entry.
  writeJson(receiptPath, receipt);
  durable.completeRun(order.orderId, { receiptPath, receipt_hash: receipt.hash });
  const durableProof = durable.verifyRun(order.orderId);
  traces.endSpan(rootSpanId, { status: 'ok', result: { receipt_hash: receipt.hash, durable_integrity: durableProof.ok } });
  rootSpanClosed = true;
  const traceProof = traces.verifyTrace(traceId);
  return { ok: true, status: receipt.status, receiptPath, receipt, brainReport, durableProof, traceProof };
  } catch (error) {
    durable.failRun(order.orderId, error);
    if (!rootSpanClosed) {
      traces.endSpan(rootSpanId, { status: 'error', error });
      rootSpanClosed = true;
    }
    throw error;
  } finally {
    durable.close();
    traces.close();
  }
}

function traceKind(stepName) {
  if (stepName === 'orangebrain_report' || stepName === 'independent_refuter') return 'model';
  if (stepName.startsWith('cobra_')) return 'memory';
  if (stepName.startsWith('hermes_')) return 'policy';
  if (stepName.startsWith('atomsmasher_')) return 'compression';
  if (stepName === 'governed_spine') return 'orchestrator';
  if (stepName === 'final_receipt') return 'receipt';
  return 'tool';
}
