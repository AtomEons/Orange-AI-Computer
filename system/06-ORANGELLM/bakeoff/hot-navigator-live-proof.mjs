#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveAutoRoute } from '../server/auto-route.mjs';
import { validateOrangeReport } from '../contracts/orange-report.mjs';

const LANE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = (process.env.ORANGE5_ORANGEBRAIN_URL || 'http://127.0.0.1:1337').replace(/\/$/, '');
const EXPECTED_NAVIGATOR_MODEL = 'orange-navigator:ornith-1.5-9b-q4km';
const PROOF_PROMPT = 'Summarize why an Orange report must not claim operational success without governed evidence. Return one bounded finding and next action.';

async function request(pathname, options) {
  const response = await fetch(`${BASE}${pathname}`, { ...options, signal: AbortSignal.timeout(240_000) });
  if (!response.ok) throw new Error(`${pathname} returned HTTP ${response.status}: ${(await response.text()).slice(0, 300)}`);
  return response.json();
}

const models = await request('/v1/models');
const runs = [];
for (let index = 1; index <= 3; index += 1) {
  const started = performance.now();
  const orderId = `hot-proof-${index}`;
  let result;
  try {
    result = await request('/v1/chat/completions', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'orange-auto',
        ae_response_contract: 'orange.report.v1',
        ae_order_id: orderId,
        ae_evidence_policy: 'none',
        messages: [{ role: 'user', content: PROOF_PROMPT }],
        temperature: 0,
        max_tokens: 128,
      }),
    });
  } catch (error) {
    const failedRun = {
      run: index,
      latency_ms: Math.round(performance.now() - started),
      report_valid: false,
      error: error?.message || String(error),
    };
    runs.push(failedRun);
    console.error(JSON.stringify(failedRun));
    continue;
  }
  let report = null;
  let reportValid = false;
  try {
    const content = result.choices?.[0]?.message?.content;
    report = validateOrangeReport(typeof content === 'string' ? JSON.parse(content) : content, orderId);
    reportValid = report.status !== 'completed' && report.evidence.length === 0;
  } catch {}
  runs.push({
    run: index,
    latency_ms: Math.round(performance.now() - started),
    report_valid: reportValid,
    status: report?.status ?? null,
    blockers: report?.blockers ?? [],
    route: result.ae_auto_route ?? null,
    turn_action: result.ae_turn?.action ?? null,
    route_mode: result.ae_route_mode ?? null,
    execution_tier: result.ae_execution_tier ?? null,
    effective_model: result.ae_effective_model ?? null,
    specialist_lease: result.ae_specialist_lease ?? null,
    specialist_context: result.ae_specialist_context ?? null,
    response_contract: result.ae_response_contract ?? null,
    report_repair_applied: result.ae_report_repair_applied ?? null,
    report_repair_free: result.ae_report_repair_applied === false,
    report_validation_error: result.ae_report_validation_error ?? null,
    reflex: result.ae_reflex ?? null,
  });
  console.error(JSON.stringify(runs.at(-1)));
}

const codeDecision = resolveAutoRoute({
  ae_order_id: 'hot-proof-code',
  messages: [{ role: 'user', content: 'Refactor this TypeScript repository and run its tests.' }],
});
const routeIds = new Set(runs.map((item) => item.route?.decision_id).filter(Boolean));
const navigatorDiscovery = models.data?.find((item) => item.id === 'orange-navigator');
const codeDiscovery = models.data?.find((item) => item.id === 'orange-code');
const heavyDiscovery = models.data?.find((item) => item.id === 'orangellm-heavy');
const leaseOnDemandDiscovery = [codeDiscovery, heavyDiscovery].every((item) => item?.ae_state === 'available'
  && item?.ae_capability_mode === 'lease_on_demand'
  && item?.ae_upstream?.live === true
  && ['hot_navigator', 'direct_ollama'].includes(item?.ae_upstream?.preferred_route));
const functional = models.data?.some((item) => item.id === 'orange-auto')
  && navigatorDiscovery?.parent === EXPECTED_NAVIGATOR_MODEL
  && leaseOnDemandDiscovery
  && runs.every((item) => item.report_valid
    && item.turn_action === 'query.chat'
    && item.route?.lane === 'local-fast'
    && item.route?.tier === 'navigator'
    && item.route?.model === EXPECTED_NAVIGATOR_MODEL
    && item.route_mode === 'specialist'
    && item.execution_tier === 'navigator'
    && item.effective_model === EXPECTED_NAVIGATOR_MODEL
    && item.specialist_lease?.status === 'ready'
    && item.specialist_lease?.model === EXPECTED_NAVIGATOR_MODEL
    && item.response_contract === 'orange.report.v1'
    && item.report_repair_free === true
    && item.reflex === null)
  && routeIds.size === 1
  && codeDecision.decision.lane === 'local-code'
  && codeDecision.tier === 'code';
const meanLatencyMs = Math.round(runs.reduce((sum, item) => sum + item.latency_ms, 0) / runs.length);
const maxLatencyMs = Math.max(...runs.map((item) => item.latency_ms));
const warmRuns = runs.slice(1);
const warmMeanLatencyMs = Math.round(warmRuns.reduce((sum, item) => sum + item.latency_ms, 0) / warmRuns.length);
const warmMaxLatencyMs = Math.max(...warmRuns.map((item) => item.latency_ms));
const performanceQualified = functional && warmMeanLatencyMs <= 10_000 && warmMaxLatencyMs <= 15_000;
const receipt = {
  schema: 'orange5.hot-navigator-live-proof.v1',
  generated_at: new Date().toISOString(),
  endpoint: BASE,
  status: performanceQualified ? 'HOT_NAVIGATOR_LIVE_QUALIFIED' : 'HOT_NAVIGATOR_LIVE_NEEDS_WORK',
  model_discovery: {
    orange_auto_present: models.data?.some((item) => item.id === 'orange-auto') ?? false,
    navigator_model: navigatorDiscovery?.parent ?? null,
    expected_navigator_model: EXPECTED_NAVIGATOR_MODEL,
    code: {
      model: codeDiscovery?.parent ?? null,
      state: codeDiscovery?.ae_state ?? null,
      capability_mode: codeDiscovery?.ae_capability_mode ?? null,
      live: codeDiscovery?.ae_upstream?.live ?? false,
      preferred_route: codeDiscovery?.ae_upstream?.preferred_route ?? null,
    },
    heavy: {
      model: heavyDiscovery?.parent ?? null,
      state: heavyDiscovery?.ae_state ?? null,
      capability_mode: heavyDiscovery?.ae_capability_mode ?? null,
      live: heavyDiscovery?.ae_upstream?.live ?? false,
      preferred_route: heavyDiscovery?.ae_upstream?.preferred_route ?? null,
    },
  },
  query_chat_runs: runs,
  deterministic_route_id: routeIds.size === 1 ? [...routeIds][0] : null,
  performance: {
    cold_latency_ms: runs[0].latency_ms,
    all_mean_latency_ms: meanLatencyMs,
    all_max_latency_ms: maxLatencyMs,
    warm_mean_latency_ms: warmMeanLatencyMs,
    warm_max_latency_ms: warmMaxLatencyMs,
    target_warm_mean_ms: 10_000,
    target_warm_max_ms: 15_000,
    qualified: performanceQualified,
  },
  contract: {
    repair_free: runs.every((item) => item.report_repair_free === true),
    strict_report_required: true,
    promotion_allowed: performanceQualified,
  },
  code_route: { lane: codeDecision.decision.lane, tier: codeDecision.tier, model: codeDecision.decision.model, decision_id: codeDecision.decision.decision_id },
  limits: ['N150 performs deterministic control only; generated reports run on the Codexa Navigator.'],
};
const outDir = path.join(LANE_ROOT, 'receipts', 'hot-navigator');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, `${receipt.generated_at.replace(/[:.]/g, '-')}-hot-navigator-live-proof.json`);
fs.writeFileSync(outPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ...receipt, receiptPath: outPath }, null, 2));
if (!performanceQualified) process.exitCode = 1;
