import fs from 'node:fs';
import path from 'node:path';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const root = path.resolve(import.meta.dir, '..');
const receiptDir = path.join(root, '10-RECEIPTS', 'orange5-build');
const endpoints = {
  ollama: 'http://127.0.0.1:11434/api/tags',
  navigator_kernel: 'http://127.0.0.1:1337/v1/models',
  orangebrain: 'http://127.0.0.1:1337/healthz',
  ae_cobra: 'http://127.0.0.1:7419/healthz',
  hermes: 'http://127.0.0.1:7430/healthz',
  ae_eyes: 'http://127.0.0.1:7440/health',
  atomsmasher2: 'http://127.0.0.1:8901/health',
  codexa_rail: 'http://10.0.0.4:8097/health',
};

async function probe(name, url) {
  const started = performance.now();
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    let body = null;
    try { body = await response.json(); } catch {}
    return {
      name,
      url,
      ok: response.ok,
      http_status: response.status,
      latency_ms: Math.round(performance.now() - started),
      reported_status: body?.status ?? body?.state ?? 'ok',
    };
  } catch (error) {
    return {
      name,
      url,
      ok: false,
      latency_ms: Math.round(performance.now() - started),
      error: error.message,
    };
  }
}

const probes = await Promise.all(Object.entries(endpoints).map(([name, url]) => probe(name, url)));
const runtimePath = path.join(receiptDir, 'runtime-logs', 'orange5-runtime-start-latest.json');
const runtime = fs.existsSync(runtimePath) ? JSON.parse(fs.readFileSync(runtimePath, 'utf8').replace(/^\uFEFF/, '')) : null;
const allLive = probes.every((probe) => probe.ok);
const bootGreen = runtime?.status === 'ORANGE5_RUNTIME_GREEN';
const generatedAt = new Date().toISOString();
const target = path.join(receiptDir, `${generatedAt.replaceAll(':', '-').replaceAll('.', '-')}-operational-snapshot.json`);

const receipt = writeChainedJsonReceipt(target, {
  schema: 'orange5.operational-snapshot.v1',
  status: allLive && bootGreen ? 'VERIFIED' : 'NEEDS_ATTENTION',
  generated_at: generatedAt,
  product: 'Orange',
  release: 'OrangeFive',
  probes,
  runtime_start: {
    path: runtimePath,
    status: runtime?.status ?? 'MISSING',
    timestamp_utc: runtime?.timestamp_utc ?? null,
  },
  proof_summary: {
    endpoints_green: probes.filter((probe) => probe.ok).length,
    endpoints_total: probes.length,
    boot_receipt_green: bootGreen,
  },
  open_optimization: {
    id: 'colqwen2-openvino',
    status: 'OPTIMIZATION_BLOCKED',
    operational_fallback: 'transformers:xpu',
    blocker: 'Optimum-Intel stock exporter has no ColQwen2 custom architecture configuration',
  },
});

console.log(JSON.stringify({ path: target, ...receipt }, null, 2));
