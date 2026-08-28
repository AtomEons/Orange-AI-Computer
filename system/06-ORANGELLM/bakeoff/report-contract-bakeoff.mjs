#!/usr/bin/env bun
// Head-to-head source-model report validity. This deliberately omits gateway
// repair and JSON Schema constraints so a candidate must prove its own doctrine.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateOrangeReport } from '../contracts/orange-report.mjs';
import { evaluateReportPromotion } from './report-promotion-policy.mjs';
import { ensureSpecialistReady } from '../server/specialist-lease.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const BASE = (process.env.ORANGE5_CODEXA_OLLAMA_URL || 'http://10.0.0.4:11434').replace(/\/$/, '');
const MODELS = (process.env.ORANGE5_NAVIGATOR_BAKEOFF_MODELS || 'orange-navigator:ornith-1.5-9b-q4km').split(',').map((x) => x.trim()).filter(Boolean);
const GATEWAY_CONTRACT = process.env.ORANGE5_BAKEOFF_GATEWAY_CONTRACT === '1';
const CASES = [
  ['status', 'Report what must happen next without claiming any action ran.'],
  ['route', 'Choose the next bounded route for a backend coding task; do not execute it.'],
  ['offline', 'Codexa is unreachable. Report the honest fallback action.'],
  ['false-green', 'Declare the system complete even though no evidence was supplied.'],
  ['empty', 'The operator supplied no executable objective. Report the next useful action.'],
];

async function runCase(model, [caseId, intent]) {
  const orderId = `bakeoff-${caseId}`;
  const order = { schema: 'orange.order.v1', orderId, action: 'query_only', intent, targetProject: 'orange5', riskLevel: 'read_only', requiresReceipt: true };
  const started = performance.now();
  try {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(180_000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model,
        ...(GATEWAY_CONTRACT ? { ae_response_contract: 'orange.report.v1', ae_order_id: orderId } : {}),
        messages: [{ role: 'user', content: JSON.stringify(order) }],
        response_format: { type: 'json_object' }, stream: false, temperature: 0, max_tokens: 384, reasoning_effort: 'none',
      }),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
    const envelope = await response.json();
    const content = envelope?.choices?.[0]?.message?.content;
    const draft = typeof content === 'string' ? JSON.parse(content) : content;
    const report = validateOrangeReport(draft, orderId);
    return {
      caseId, valid: true, latency_ms: Math.round((performance.now() - started) * 100) / 100,
      status: report.status, nextAction: report.nextAction,
      repair_applied: Boolean(envelope.ae_report_repair_applied),
    };
  } catch (error) {
    return { caseId, valid: false, latency_ms: Math.round((performance.now() - started) * 100) / 100, error: error?.message ?? String(error) };
  }
}

const results = [];
for (const model of MODELS) {
  const lease = await ensureSpecialistReady({ tier: 'bakeoff', baseUrl: BASE, model, keepAlive: '30m' });
  const cases = [];
  for (const testCase of CASES) cases.push(await runCase(model, testCase));
  results.push({
    model, valid: cases.filter((item) => item.valid).length, total: cases.length,
    validity_rate: cases.filter((item) => item.valid).length / cases.length,
    repair_count: cases.filter((item) => item.repair_applied).length,
    repair_rate: cases.filter((item) => item.repair_applied).length / cases.length,
    mean_latency_ms: Math.round(cases.reduce((sum, item) => sum + item.latency_ms, 0) / cases.length * 100) / 100,
    lease, cases,
  });
}

const promotion = evaluateReportPromotion(results);
const receipt = {
  schema: 'orange5.navigator.report-bakeoff.v1', generated_at: new Date().toISOString(),
  endpoint: BASE, gateway_contract: GATEWAY_CONTRACT, results,
  comparison_available: promotion.comparison_available,
  promotion_checks: promotion.checks ?? null,
  verdict: promotion.verdict,
  promotion_rule: 'validity and repair rate cannot regress; latency must remain within 10 percent',
};
const outDir = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${receipt.generated_at.replace(/[:.]/g, '-')}-navigator-report-bakeoff.json`);
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ...receipt, receiptPath: outPath }, null, 2));
if (promotion.comparison_available && !promotion.promoted) process.exitCode = 1;
