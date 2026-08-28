#!/usr/bin/env bun

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveAutoRoute } from '../06-ORANGELLM/server/auto-route.mjs';
import { querySemanticMemory } from '../06-ORANGELLM/memory/ae-cobra/semantic-index.mjs';
import { readCurrentAwareness } from './current-awareness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const RUNS = Math.max(3, Number(process.env.ORANGE5_BENCH_RUNS || 5));

const ENDPOINTS = Object.freeze({
  gateway: 'http://127.0.0.1:1337/healthz',
  cobra: 'http://127.0.0.1:7419/healthz',
  hermes: 'http://127.0.0.1:7430/healthz',
  atomsmasher: 'http://127.0.0.1:8901/health',
  eyes: 'http://127.0.0.1:7440/health',
  qdrant: 'http://127.0.0.1:6333/collections',
  codexa_ollama: 'http://127.0.0.1:11437/api/ps',
  navigator: 'http://127.0.0.1:11436/health',
});

function sha256(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function percentile(values, ratio) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1))];
}

function stats(values) {
  return {
    runs: values.length,
    min_ms: Math.round(Math.min(...values) * 100) / 100,
    p50_ms: Math.round(percentile(values, 0.5) * 100) / 100,
    p95_ms: Math.round(percentile(values, 0.95) * 100) / 100,
    max_ms: Math.round(Math.max(...values) * 100) / 100,
    mean_ms: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
  };
}

async function timed(fn) {
  const started = performance.now();
  const value = await fn();
  return { latency: performance.now() - started, value };
}

async function fetchJson(url, options = {}, timeoutMs = 15_000) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return { http: response.status, body };
}

async function benchmarkEndpoint(url) {
  const latencies = [];
  let sample = null;
  for (let run = 0; run < RUNS; run += 1) {
    const measured = await timed(() => fetchJson(url));
    latencies.push(measured.latency);
    sample = measured.value;
  }
  return { ok: true, ...stats(latencies), sample_http: sample.http };
}

async function benchmarkSemanticRecall() {
  const query = 'markerless refuter explicit verification action';
  const latencies = [];
  let sample = null;
  for (let run = 0; run < 3; run += 1) {
    const measured = await timed(() => querySemanticMemory(query, { limit: 5 }));
    latencies.push(measured.latency);
    sample = measured.value;
  }
  const topSummary = sample?.hits?.[0]?.payload?.summary ?? '';
  return {
    ok: /markerless refuter/i.test(String(topSummary)),
    ...stats(latencies),
    query,
    top_summary: topSummary,
    result_count: sample?.hits?.length ?? 0,
  };
}

function benchmarkRouting(iterations = 50_000) {
  const cases = [
    { ae_order_id: 'bench-chat', messages: [{ role: 'user', content: 'hello' }] },
    { ae_order_id: 'bench-code', messages: [{ role: 'user', content: 'refactor this TypeScript repository and run tests' }] },
    { ae_order_id: 'bench-heavy', messages: [{ role: 'user', content: 'architect a high-risk migration plan' }] },
  ];
  const started = performance.now();
  let fingerprint = '';
  for (let index = 0; index < iterations; index += 1) {
    const result = resolveAutoRoute(cases[index % cases.length]);
    fingerprint = result.decision.decision_id;
  }
  const elapsed = performance.now() - started;
  return {
    ok: fingerprint.length === 64,
    iterations,
    elapsed_ms: Math.round(elapsed * 100) / 100,
    routes_per_second: Math.round((iterations / elapsed) * 1_000),
  };
}

const serviceResults = {};
for (const [name, url] of Object.entries(ENDPOINTS)) {
  try { serviceResults[name] = await benchmarkEndpoint(url); }
  catch (error) { serviceResults[name] = { ok: false, error: error?.message || String(error) }; }
}

let semanticRecall;
try { semanticRecall = await benchmarkSemanticRecall(); }
catch (error) { semanticRecall = { ok: false, error: error?.message || String(error) }; }

const routing = benchmarkRouting();
const awareness = readCurrentAwareness();
const thresholds = {
  gateway_health_p95_ms: 1_500,
  local_health_p95_ms: 750,
  semantic_recall_p95_ms: 5_000,
  routing_min_per_second: 5_000,
};
const checks = {
  all_services_live: Object.values(serviceResults).every((item) => item.ok === true),
  gateway_health_qualified: serviceResults.gateway?.p95_ms <= thresholds.gateway_health_p95_ms,
  local_health_qualified: ['cobra', 'hermes', 'atomsmasher', 'eyes', 'qdrant']
    .every((name) => serviceResults[name]?.p95_ms <= thresholds.local_health_p95_ms),
  semantic_recall_qualified: semanticRecall.ok === true && semanticRecall.p95_ms <= thresholds.semantic_recall_p95_ms,
  routing_qualified: routing.ok === true && routing.routes_per_second >= thresholds.routing_min_per_second,
  awareness_present: awareness?.ready === true && Boolean(awareness.latest?.status && awareness.latest?.generatedAt),
};
const receipt = {
  schema: 'orange5.system-performance-benchmark.v1',
  generated_at: new Date().toISOString(),
  status: Object.values(checks).every(Boolean) ? 'PERFORMANCE_TARGETS_MET' : 'PERFORMANCE_OPTIMIZATION_REQUIRED',
  runs_per_health_endpoint: RUNS,
  thresholds,
  checks,
  services: serviceResults,
  semantic_recall: semanticRecall,
  deterministic_routing: routing,
  current_awareness: {
    status: awareness?.latest?.status ?? 'MISSING',
    generated_at: awareness?.latest?.generatedAt ?? null,
    expires_at: awareness?.latest?.expiresAt ?? null,
    source_count: awareness?.latest?.sourceCount ?? 0,
    candidate_count: awareness?.candidateCount ?? 0,
    sha256: awareness?.latest?.sha256 ?? null,
  },
};
receipt.receipt_sha256 = sha256(JSON.stringify(receipt));
fs.mkdirSync(OUT_DIR, { recursive: true });
const receiptPath = path.join(OUT_DIR, `${receipt.generated_at.replace(/[:.]/g, '-')}-system-performance-benchmark.json`);
fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`);
console.log(JSON.stringify({ ...receipt, receiptPath }, null, 2));
if (receipt.status !== 'PERFORMANCE_TARGETS_MET') process.exitCode = 1;
