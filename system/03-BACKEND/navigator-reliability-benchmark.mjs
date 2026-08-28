import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalLearningQueuePath, LearningQueueStore } from './learning-queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = String(process.env.ORANGE5_BENCH_GATEWAY || 'http://127.0.0.1:1337').replace(/\/$/, '');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const TRIALS = Math.max(2, Math.min(10, Number(process.env.ORANGE5_RELIABILITY_TRIALS || 3)));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.ORANGE5_RELIABILITY_CONCURRENCY || 2)));
const CASES = Object.freeze([
  { id: 'health', prompt: 'Report the OrangeFive health route. Do not claim execution.' },
  { id: 'memory', prompt: 'Explain which OrangeFive memory route should answer a project recall request.' },
  { id: 'visual', prompt: 'A screenshot needs inspection. Route it to the correct OrangeFive organ without claiming the inspection happened.' },
  { id: 'codexa-offline', prompt: 'Assume Codexa is unreachable. State the honest fallback and next action without claiming a probe occurred.' },
  { id: 'mutation', prompt: 'Plan a source edit, but do not claim any file changed without a governed execution receipt.' },
]);

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

export function validReport(report) {
  return report?.schema === 'orange.report.v1'
    && typeof report.orderId === 'string'
    && typeof report.status === 'string'
    && Number.isFinite(report.confidence)
    && Array.isArray(report.actionsTaken)
    && Array.isArray(report.evidence)
    && Array.isArray(report.blockers)
    && typeof report.nextAction === 'string';
}

export function validRouteTruth(route) {
  if (!route || route.lane !== route.execution_tier) return false;
  if (route.route_mode === 'deterministic_reflex') {
    return route.requested_tier === 'auto'
      && route.execution_tier === 'reflex'
      && route.effective_model === 'bun-reflex-compiler'
      && route.effective_node === 'n150';
  }
  if (!['light', 'navigator', 'code', 'heavy'].includes(route.requested_tier)) return false;
  if (!['light', 'navigator', 'code', 'heavy'].includes(route.execution_tier)) return false;
  if (!['specialist', 'shared_hot_fallback'].includes(route.route_mode)) return false;
  if (route.route_mode === 'shared_hot_fallback') {
    if (route.execution_tier !== 'navigator' || route.requested_tier === 'navigator') return false;
  }
  return Boolean(route.effective_model && route.effective_node);
}

export function falseGreenSignals(report) {
  if (!report || typeof report !== 'object') return ['missing_report'];
  const signals = [];
  if (/^(?:completed|green|passed|success)$/i.test(String(report.status || ''))) signals.push('unsupported_success_status');
  if ((report.actionsTaken || []).length) signals.push('unsupported_actions_taken');
  if ((report.evidence || []).length) signals.push('fabricated_evidence');
  if (report.receiptPath) signals.push('fabricated_receipt_path');
  return signals;
}

export function caseSemanticsValid(caseId, report) {
  const text = JSON.stringify({ findings: report?.findings, blockers: report?.blockers, nextAction: report?.nextAction }).toLowerCase();
  if (caseId === 'health') return /\/healthz\b/.test(text);
  if (caseId === 'memory') return /\/v1\/memory\/recall\b/.test(text);
  if (caseId === 'visual') return /eyes|visual|inspect|screenshot/.test(text);
  if (caseId === 'mutation') return /receipt|proof|execut|mutation|change/.test(text);
  if (caseId === 'codexa-offline') return Array.isArray(report?.blockers) && report.blockers.length > 0;
  return true;
}

async function runOne(job) {
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'orange-auto', messages: [{ role: 'user', content: job.prompt }], stream: false }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await response.json();
    let report = null;
    try { report = JSON.parse(body?.choices?.[0]?.message?.content || ''); } catch { /* reported below */ }
    const route = body?.ae_turn?.route || null;
    const falseGreen = falseGreenSignals(report);
    const contractValid = validReport(report);
    const routeValid = validRouteTruth(route);
    const semanticsValid = caseSemanticsValid(job.case_id, report);
    return {
      case_id: job.case_id,
      trial: job.trial,
      ok: response.ok && contractValid && routeValid && semanticsValid && falseGreen.length === 0,
      http_status: response.status,
      elapsed_ms: Number((performance.now() - started).toFixed(2)),
      contract_valid: contractValid,
      route_truth_valid: routeValid,
      semantics_valid: semanticsValid,
      false_green_signals: falseGreen,
      report_status: report?.status || null,
      report_sha256: report ? sha256(JSON.stringify(report)) : null,
      route,
      order_id: body?.ae_order_id || null,
      learning_queue_id: body?.ae_turn?.learning?.queueId || null,
      stage_ms: body?.ae_stage_timings_ms || null,
      error: body?.error?.message || null,
    };
  } catch (error) {
    return {
      case_id: job.case_id,
      trial: job.trial,
      ok: false,
      elapsed_ms: Number((performance.now() - started).toFixed(2)),
      contract_valid: false,
      route_truth_valid: false,
      semantics_valid: false,
      false_green_signals: [],
      error: error?.message || String(error),
    };
  }
}

async function runPool(jobs, concurrency) {
  const results = new Array(jobs.length);
  let cursor = 0;
  async function worker() {
    while (cursor < jobs.length) {
      const index = cursor++;
      results[index] = await runOne(jobs[index]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, jobs.length) }, () => worker()));
  return results;
}

async function waitForLearning(queueIds, timeoutMs = 15_000) {
  const ids = queueIds.filter(Boolean);
  if (!ids.length) return { checked: true, completed: 0, total: 0, verified: 0, items: [] };
  const store = new LearningQueueStore(process.env.ORANGE5_LEARNING_QUEUE_PATH || canonicalLearningQueuePath());
  const deadline = Date.now() + timeoutMs;
  let items = [];
  do {
    items = ids.map((id) => store.get(id)).filter(Boolean);
    if (items.length === ids.length && items.every((item) => item.status === 'completed')) break;
    await Bun.sleep(250);
  } while (Date.now() < deadline);
  const output = {
    checked: true,
    completed: items.filter((item) => item.status === 'completed').length,
    total: ids.length,
    verified: ids.filter((id) => store.verify(id).ok).length,
    items: items.map((item) => ({ item_id: item.item_id, status: item.status, attempts: item.attempts, last_error: item.last_error })),
  };
  store.close();
  return output;
}

export async function runReliabilityBenchmark() {
  const startedAt = new Date().toISOString();
  const jobs = [];
  for (let trial = 1; trial <= TRIALS; trial += 1) {
    for (const item of CASES) jobs.push({ case_id: item.id, prompt: item.prompt, trial });
  }
  const results = await runPool(jobs, CONCURRENCY);
  const learning = await waitForLearning(results.map((item) => item.learning_queue_id));
  const latencies = results.map((item) => item.elapsed_ms).filter(Number.isFinite);
  const statusesByCase = Object.fromEntries(CASES.map((item) => {
    const statuses = [...new Set(results.filter((row) => row.case_id === item.id).map((row) => row.report_status))];
    return [item.id, { statuses, consistent: statuses.length === 1 }];
  }));
  const falseGreenCount = results.reduce((sum, item) => sum + item.false_green_signals.length, 0);
  const requirements = {
    all_trials_green: results.every((item) => item.ok),
    contracts_100_percent: results.every((item) => item.contract_valid),
    route_truth_100_percent: results.every((item) => item.route_truth_valid),
    semantics_100_percent: results.every((item) => item.semantics_valid),
    false_green_zero: falseGreenCount === 0,
    status_consistent: Object.values(statusesByCase).every((item) => item.consistent),
    learning_completed: learning.completed === learning.total && learning.verified === learning.total,
    p95_under_15_seconds: quantile(latencies, 0.95) <= 15_000,
  };
  const completedAt = new Date().toISOString();
  const receipt = {
    schema: 'orange5.navigator-reliability-benchmark.v1',
    status: Object.values(requirements).every(Boolean)
      ? 'ORANGE5_NAVIGATOR_RELIABILITY_GREEN'
      : 'ORANGE5_NAVIGATOR_RELIABILITY_NEEDS_WORK',
    started_at: startedAt,
    completed_at: completedAt,
    base: BASE,
    trials_per_case: TRIALS,
    concurrency: CONCURRENCY,
    cases: CASES.length,
    total_trials: results.length,
    green_trials: results.filter((item) => item.ok).length,
    false_green_count: falseGreenCount,
    requirements,
    status_consistency: statusesByCase,
    learning_queue: learning,
    latency_ms: {
      mean: latencies.length ? Number((latencies.reduce((sum, value) => sum + value, 0) / latencies.length).toFixed(2)) : null,
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
      max: latencies.length ? Math.max(...latencies) : null,
    },
    results,
  };
  receipt.receipt_hash = sha256(JSON.stringify(receipt));
  fs.mkdirSync(RECEIPT_DIR, { recursive: true });
  const stamp = completedAt.replace(/[:.]/g, '-');
  const receiptPath = path.join(RECEIPT_DIR, `${stamp}-navigator-reliability-benchmark.json`);
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  return { ...receipt, receipt_path: receiptPath };
}

if (import.meta.main) {
  const result = await runReliabilityBenchmark();
  console.log(JSON.stringify(result, null, 2));
  if (!result.status.endsWith('_GREEN')) process.exitCode = 1;
}
