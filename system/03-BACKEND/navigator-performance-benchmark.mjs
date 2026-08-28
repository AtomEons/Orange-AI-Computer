import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalLearningQueuePath, LearningQueueStore } from './learning-queue.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = String(process.env.ORANGE5_BENCH_GATEWAY || 'http://127.0.0.1:1337').replace(/\/$/, '');
const RECEIPT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const CASES = [
  ['health', 'Report the OrangeFive health route. Do not claim execution.'],
  ['memory', 'Explain which OrangeFive memory route should answer a project recall request.'],
  ['visual', 'A screenshot needs inspection. Route it to the correct OrangeFive organ without claiming the inspection happened.'],
  ['codexa-offline', 'Codexa is unreachable. State the honest fallback and next action.'],
  ['mutation', 'Plan a source edit, but do not claim any file changed without a governed execution receipt.'],
];

function quantile(values, q) {
  const sorted = [...values].sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))];
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function validReport(report) {
  return report?.schema === 'orange.report.v1'
    && typeof report.orderId === 'string'
    && typeof report.status === 'string'
    && Number.isFinite(report.confidence)
    && Array.isArray(report.actionsTaken)
    && Array.isArray(report.evidence)
    && Array.isArray(report.blockers)
    && typeof report.nextAction === 'string';
}

function validRouteTruth(route) {
  if (!route || typeof route.requested_tier !== 'string' || typeof route.execution_tier !== 'string') return false;
  if (route.lane !== route.execution_tier) return false;
  if (route.route_mode === 'deterministic_reflex') {
    return route.requested_tier === 'auto'
      && route.execution_tier === 'reflex'
      && route.effective_model === 'bun-reflex-compiler'
      && route.effective_node === 'n150';
  }
  if (route.route_mode === 'shared_hot_fallback' && route.execution_tier !== 'navigator') return false;
  if (route.route_mode === 'shared_hot_fallback' && route.requested_tier === route.execution_tier) return false;
  return typeof route.effective_model === 'string' && route.effective_model.length > 0
    && typeof route.effective_node === 'string' && route.effective_node.length > 0;
}

function caseSemanticsValid(caseId, report) {
  const text = JSON.stringify({ findings: report?.findings, blockers: report?.blockers, nextAction: report?.nextAction }).toLowerCase();
  if (caseId === 'health') return /\/healthz\b/.test(text);
  if (caseId === 'memory') return /\/v1\/memory\/recall\b/.test(text);
  if (caseId === 'visual') return /eyes|visual|inspect|screenshot/.test(text);
  if (caseId === 'mutation') return /receipt|proof|execut|mutation|change/.test(text);
  if (caseId === 'codexa-offline') return Array.isArray(report?.blockers) && report.blockers.length > 0;
  return true;
}

async function runCase([caseId, prompt]) {
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'orange-auto', messages: [{ role: 'user', content: prompt }], stream: false }),
      signal: AbortSignal.timeout(180_000),
    });
    const body = await response.json();
    let report = null;
    try { report = JSON.parse(body?.choices?.[0]?.message?.content || ''); } catch { /* invalid below */ }
    const elapsed = Number((performance.now() - started).toFixed(2));
    const route = body?.ae_turn?.route || null;
    const routeTruthValid = validRouteTruth(route);
    const semanticsValid = caseSemanticsValid(caseId, report);
    return {
      case_id: caseId,
      ok: response.ok && validReport(report) && routeTruthValid && semanticsValid,
      http_status: response.status,
      elapsed_ms: elapsed,
      report_valid: validReport(report),
      report_status: report?.status || null,
      route_truth_valid: routeTruthValid,
      semantics_valid: semanticsValid,
      requested_tier: route?.requested_tier || null,
      execution_tier: route?.execution_tier || null,
      route_mode: route?.route_mode || null,
      requested_model: route?.requested_model || null,
      effective_model: route?.effective_model || route?.model || null,
      requested_node: route?.requested_node || null,
      effective_node: route?.effective_node || null,
      governance: body?.ae_turn?.governance || null,
      learning: body?.ae_turn?.learning || null,
      stage_ms: body?.ae_stage_timings_ms || null,
      inference_optimization: body?.ae_inference_optimization || null,
      order_id: body?.ae_order_id || null,
      report,
      error: body?.error?.message || null,
    };
  } catch (error) {
    return { case_id: caseId, ok: false, elapsed_ms: Number((performance.now() - started).toFixed(2)), error: error?.message || String(error) };
  }
}

fs.mkdirSync(RECEIPT_DIR, { recursive: true });
const startedAt = new Date().toISOString();
const results = [];
for (const testCase of CASES) results.push(await runCase(testCase));

await Bun.sleep(2_500);
const queueIds = results.map((item) => item.learning?.queueId).filter(Boolean);
let queue = { checked: false, completed: 0, total: queueIds.length, items: [] };
try {
  const store = new LearningQueueStore(process.env.ORANGE5_LEARNING_QUEUE_PATH || canonicalLearningQueuePath());
  const items = queueIds.map((id) => store.get(id)).filter(Boolean);
  queue = {
    checked: true,
    completed: items.filter((item) => item.status === 'completed').length,
    total: queueIds.length,
    items: items.map((item) => ({ item_id: item.item_id, status: item.status, attempts: item.attempts, verify: store.verify(item.item_id) })),
  };
  store.close();
} catch (error) {
  queue.error = error?.message || String(error);
}

const latencies = results.map((item) => item.elapsed_ms).filter(Number.isFinite);
const finalize = results.map((item) => item.stage_ms?.finalize).filter(Number.isFinite);
const inference = results.map((item) => item.stage_ms?.inference).filter(Number.isFinite);
const cacheRatios = results.map((item) => item.inference_optimization?.cache_ratio).filter(Number.isFinite);
const receipt = {
  schema: 'orange5.navigator-performance-benchmark.v1',
  status: results.every((item) => item.ok && item.governance?.status === 'completed') && queue.completed === queue.total
    ? 'ORANGE5_NAVIGATOR_PERFORMANCE_GREEN'
    : 'ORANGE5_NAVIGATOR_PERFORMANCE_NEEDS_WORK',
  base: BASE,
  started_at: startedAt,
  completed_at: new Date().toISOString(),
  cases_green: results.filter((item) => item.ok).length,
  cases_total: results.length,
  learning_queue: queue,
  latency_ms: {
    mean: latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : null,
    p50: quantile(latencies, 0.5),
    p95: quantile(latencies, 0.95),
    max: latencies.length ? Math.max(...latencies) : null,
    inference_mean: inference.length ? Number((inference.reduce((a, b) => a + b, 0) / inference.length).toFixed(2)) : null,
    finalize_mean: finalize.length ? Number((finalize.reduce((a, b) => a + b, 0) / finalize.length).toFixed(2)) : null,
  },
  cache: {
    measured_cases: cacheRatios.length,
    mean_ratio: cacheRatios.length ? Number((cacheRatios.reduce((a, b) => a + b, 0) / cacheRatios.length).toFixed(4)) : null,
  },
  results,
};
receipt.receipt_hash = sha256(JSON.stringify(receipt));
const stamp = receipt.completed_at.replace(/[:.]/g, '-');
const output = path.join(RECEIPT_DIR, `${stamp}-navigator-performance-benchmark.json`);
fs.writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
console.log(JSON.stringify({ ...receipt, receipt_path: output }, null, 2));
if (!receipt.status.endsWith('_GREEN')) process.exitCode = 1;
