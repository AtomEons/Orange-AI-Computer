#!/usr/bin/env bun

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { executeGovernedTool } from './hermes-effector.mjs';
import { FixerStore } from './fixer.mjs';
import { readPartyLine } from '../04-CONTROL-PLANE/party-line/ledger.mjs';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(import.meta.dir, '..');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const DATA_ROOT = process.env.ORANGE5_DATA_ROOT || path.join(os.homedir(), 'OrangeBox-Data', 'orange5');
const FIXER_DB = path.join(DATA_ROOT, 'control', 'fixer.sqlite');
const SERVICES = path.join(ROOT, 'scripts', 'orange5-runtime-services.mjs');
const TARGET = 'brain-mcp';
const HEALTH_URL = 'http://127.0.0.1:7431/health';
const generatedAt = new Date().toISOString();
const stamp = generatedAt.replace(/[:.]/g, '-');
const runId = `fixer-live-${stamp}`;
const defectId = `${runId}-brain-mcp-down`;
const receiptPath = path.join(RECEIPT_DIR, `${stamp}-fixer-live-recovery-proof.json`);
const regressionPaths = [
  '03-BACKEND/tests/fixer.test.mjs',
  'scripts/tests/runtime-service-pid-ownership.test.mjs',
];

const runServices = (action, serviceName = null) => {
  const command = [process.execPath, SERVICES, action, ...(serviceName ? [serviceName] : [])];
  const result = Bun.spawnSync(command, {
    cwd: ROOT,
    env: process.env,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    timeout: 180_000,
  });
  let report = null;
  try { report = JSON.parse(result.stdout.toString().trim()); } catch {}
  return {
    ok: result.exitCode === 0 && report?.ok === true,
    exitCode: result.exitCode,
    report,
    stderr: result.stderr.toString().trim().slice(-2_000),
    command,
  };
};

const serviceMap = (result) => Object.fromEntries((result.report?.services || []).map((service) => [service.name, service]));
const probe = async () => {
  try {
    const response = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2_500), cache: 'no-store' });
    const text = await response.text();
    let body = null;
    try { body = JSON.parse(text); } catch { body = text; }
    return { ok: response.ok, status: response.status, body };
  } catch (error) {
    return { ok: false, status: 0, error: error?.message || String(error) };
  }
};

const runRegressions = () => {
  const result = Bun.spawnSync([process.execPath, 'test', ...regressionPaths], {
    cwd: ROOT,
    stdout: 'pipe',
    stderr: 'pipe',
    windowsHide: true,
    timeout: 120_000,
  });
  return {
    ok: result.exitCode === 0,
    exitCode: result.exitCode,
    stdout: result.stdout.toString().trim().slice(-4_000),
    stderr: result.stderr.toString().trim().slice(-4_000),
  };
};

const store = new FixerStore(FIXER_DB);
let baseline = null;
let stopped = null;
let after = null;
let faultProbe = null;
let repairReport = null;
let regressions = null;
let fallbackRecoveryUsed = false;
let error = null;
const startedMs = Date.now();
let stoppedMs = null;
let recoveredMs = null;

try {
  baseline = runServices('status');
  if (!baseline.ok) throw new Error(`baseline runtime service status failed: ${baseline.stderr || JSON.stringify(baseline.report)}`);
  const before = serviceMap(baseline);
  if (!Number.isInteger(before[TARGET]?.pid)) throw new Error('Brain MCP does not have a proven owned PID');

  await store.createCase({
    defectId,
    runId,
    source: 'controlled-live-health-fault',
    severity: 'high',
    evidence: [{ type: 'baseline_runtime_status', ok: true, services: Object.fromEntries(Object.entries(before).map(([name, service]) => [name, { pid: service.pid, ok: service.ok }])) }],
  });

  stopped = runServices('stop', TARGET);
  stoppedMs = Date.now();
  if (!stopped.ok) throw new Error(`controlled fault injection failed: ${stopped.stderr || JSON.stringify(stopped.report)}`);
  faultProbe = await probe();
  if (faultProbe.ok) throw new Error('Brain MCP remained healthy after owned-process fault injection');

  await store.transition(defectId, 'reproduced', {
    reproducer: { command: [process.execPath, SERVICES, 'stop', TARGET], expected: 'health endpoint unavailable', observed: faultProbe },
    evidence: [{ type: 'fault_injection', ok: true, target: TARGET, stoppedPid: before[TARGET].pid }],
  });
  await store.transition(defectId, 'isolated', {
    suspectedBoundary: 'Brain MCP owned Bun service on loopback port 7431',
    evidence: [{ type: 'isolation', ok: true, neighboringServicesExpectedUnchanged: ['memory', 'hermes', 'link-sentinel', 'orangellm'] }],
  });

  const repairOrder = {
    schema: 'orange.order.v1',
    orderId: `${runId}-repair`,
    action: 'process.run',
    intent: 'restore the owned Brain MCP service without restarting neighboring Orange services',
    scope: ROOT,
    allowedActions: ['process.run'],
    forbiddenActions: ['filesystem.delete', 'service.restart.all'],
    targetProject: ROOT,
    riskLevel: 'high',
    requiresReceipt: true,
    operatorApproved: true,
  };
  await store.transition(defectId, 'repair_planned', {
    repairOrder,
    rollback: {
      command: [process.execPath, SERVICES, 'stop', TARGET],
      recovery: [process.execPath, SERVICES, 'start', TARGET],
      scope: 'Brain MCP only',
    },
    evidence: [{ type: 'repair_scope', ok: true, target: TARGET }],
  });

  repairReport = await executeGovernedTool({
    action: 'process.run',
    orderId: repairOrder.orderId,
    actor: 'orange-fixer',
    projectRoot: '.',
    path: '.',
    command: [process.execPath, SERVICES, 'start', TARGET],
    timeoutMs: 60_000,
    operatorApproved: true,
  }, {
    projectRoot: ROOT,
    trustInlineApproval: true,
    onLease: async ({ lease }) => {
      await store.transition(defectId, 'leased', {
        hermesLease: { id: lease.id, actor: lease.actor, allowed: lease.allowed, expires_at: lease.expires_at },
        evidence: [{ type: 'hermes_lease', ok: true, leaseId: lease.id }],
      });
    },
  });
  store.recordAttempt(defectId, {
    cause: 'owned Brain MCP process unavailable',
    method: 'Hermès-authorized exact-service start',
    succeeded: repairReport.ok === true,
    evidence: { receiptPath: repairReport.receiptPath },
  });
  await store.transition(defectId, 'patched', {
    evidence: [{ type: 'governed_repair_execution', ok: repairReport.ok === true, report: repairReport }],
  });

  after = runServices('status');
  const afterServices = serviceMap(after);
  const healthAfter = await probe();
  recoveredMs = Date.now();
  const neighborsUnchanged = ['memory', 'hermes', 'link-sentinel', 'orangellm'].every((name) => before[name]?.pid === afterServices[name]?.pid && afterServices[name]?.ok === true);
  const targetRecovered = after.ok && healthAfter.ok && afterServices[TARGET]?.ok === true && Number.isInteger(afterServices[TARGET]?.pid);
  if (!targetRecovered || !neighborsUnchanged) {
    throw new Error(`exact-path verification failed: targetRecovered=${targetRecovered} neighborsUnchanged=${neighborsUnchanged}`);
  }
  await store.transition(defectId, 'exact_path_verified', {
    evidence: [{
      type: 'exact_path_verification',
      ok: true,
      health: healthAfter,
      target: { beforePid: before[TARGET].pid, afterPid: afterServices[TARGET].pid },
      neighboringPids: Object.fromEntries(['memory', 'hermes', 'link-sentinel', 'orangellm'].map((name) => [name, { before: before[name].pid, after: afterServices[name].pid }])),
      recoveryMs: recoveredMs - stoppedMs,
    }],
  });

  regressions = runRegressions();
  if (!regressions.ok) throw new Error(`Fixer regression suite failed: ${regressions.stderr || regressions.stdout}`);
  await store.transition(defectId, 'regression_encoded', {
    regression: { path: path.join(ROOT, regressionPaths[0]), paths: regressionPaths, passed: true, exitCode: regressions.exitCode },
    evidence: [{ type: 'regression_suite', ok: true, paths: regressionPaths }],
  });

  await store.transition(defectId, 'closed', { receiptPath: repairReport.receiptPath });
} catch (caught) {
  error = caught?.stack || caught?.message || String(caught);
} finally {
  const health = await probe();
  if (!health.ok) {
    fallbackRecoveryUsed = true;
    runServices('start', TARGET);
  }
}

const finalStatus = runServices('status');
const finalServices = serviceMap(finalStatus);
const fixerCase = store.getCase(defectId);
const caseVerification = fixerCase ? store.verifyCase(defectId) : { ok: false, errors: ['case_not_created'] };
const party = await readPartyLine({ limit: 500, detail: 'deep', tail: true });
const lifecycleEvents = party.events.filter((event) => event.correlationId === runId && event.actor?.id === 'orange-fixer');
const beforeServices = serviceMap(baseline || { report: { services: [] } });
const governedGates = repairReport?.evidence?.find((item) => item.type === 'hermes_gate_chain')?.gates || [];
const checks = {
  baseline_all_owned_services_green: baseline?.ok === true,
  target_owned_pid_proven: Number.isInteger(beforeServices[TARGET]?.pid),
  controlled_fault_stopped_target: stopped?.ok === true && faultProbe?.ok === false,
  defect_reproduced_and_isolated: Boolean(fixerCase?.reproducer && fixerCase?.suspectedBoundary),
  hermes_authorized_repair: governedGates.length === 8 && governedGates.every((gate) => gate.pass === true),
  governed_repair_receipt_exists: Boolean(repairReport?.receiptPath && fs.existsSync(repairReport.receiptPath)),
  target_recovered: finalStatus.ok === true && finalServices[TARGET]?.ok === true && Number.isInteger(finalServices[TARGET]?.pid),
  target_process_replaced: Number.isInteger(beforeServices[TARGET]?.pid) && beforeServices[TARGET].pid !== finalServices[TARGET]?.pid,
  neighboring_services_not_restarted: ['memory', 'hermes', 'link-sentinel', 'orangellm'].every((name) => beforeServices[name]?.pid === finalServices[name]?.pid),
  regression_suite_green: regressions?.ok === true,
  fixer_case_closed: fixerCase?.state === 'closed',
  fixer_case_hash_chain_valid: caseVerification.ok === true && caseVerification.events === 9,
  party_line_lifecycle_complete: lifecycleEvents.length === 9 && lifecycleEvents.at(-1)?.status === 'closed',
  no_fallback_recovery: fallbackRecoveryUsed === false,
};
const green = Object.values(checks).every(Boolean) && !error;
const proof = {
  schema: 'orangefive.fixer-live-recovery-proof.v1',
  status: green ? 'ORANGEFIVE_FIXER_LIVE_RECOVERY_GREEN' : 'ORANGEFIVE_FIXER_LIVE_RECOVERY_NEEDS_WORK',
  generated_at: new Date().toISOString(),
  product: 'Orange',
  release: 'OrangeFive',
  runId,
  defectId,
  target: TARGET,
  recovery_ms: stoppedMs && recoveredMs ? recoveredMs - stoppedMs : null,
  total_ms: Date.now() - startedMs,
  checks,
  baseline: Object.fromEntries(Object.entries(beforeServices).map(([name, service]) => [name, { ok: service.ok, pid: service.pid }])),
  final: Object.fromEntries(Object.entries(finalServices).map(([name, service]) => [name, { ok: service.ok, pid: service.pid }])),
  fixerCase,
  caseVerification,
  lifecycle_event_ids: lifecycleEvents.map((event) => event.id),
  governed_repair_receipt: repairReport?.receiptPath || null,
  fallbackRecoveryUsed,
  error,
};
const written = writeChainedJsonReceipt(receiptPath, proof);
store.close();

process.stdout.write(`${JSON.stringify({
  status: written.status,
  checks: written.checks,
  recovery_ms: written.recovery_ms,
  target_pid: { before: written.baseline?.[TARGET]?.pid, after: written.final?.[TARGET]?.pid },
  case_events: written.caseVerification?.events,
  receipt_sha256: written.receipt_sha256,
  receipt_path: receiptPath,
  error: written.error,
}, null, 2)}\n`);
if (!green) process.exitCode = 1;
