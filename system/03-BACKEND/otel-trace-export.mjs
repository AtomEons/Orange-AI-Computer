import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TraceStore } from './trace-store.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function traceId(value) {
  const clean = String(value || '').replace(/^trace_/, '');
  return /^[0-9a-f]{32}$/i.test(clean) ? clean.toLowerCase() : sha256(value).slice(0, 32);
}

function spanId(value) {
  return sha256(value).slice(0, 16);
}

function unixNano(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) throw new Error(`invalid trace timestamp: ${iso}`);
  return (BigInt(ms) * 1_000_000n).toString();
}

function anyValue(value) {
  if (typeof value === 'boolean') return { boolValue: value };
  if (typeof value === 'number' && Number.isInteger(value)) return { intValue: String(value) };
  if (typeof value === 'number') return { doubleValue: value };
  if (typeof value === 'string') return { stringValue: value };
  return { stringValue: JSON.stringify(value) };
}

function attributes(record = {}) {
  return Object.entries(record)
    .filter(([, value]) => value !== undefined && value !== null)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => ({ key, value: anyValue(value) }));
}

function operationName(kind) {
  if (kind === 'model') return 'chat';
  if (kind === 'memory') return 'retrieval';
  if (kind === 'tool') return 'execute_tool';
  if (kind === 'orchestrator') return 'invoke_workflow';
  return 'invoke_agent';
}

function otelKind(kind) {
  return kind === 'model' || kind === 'memory' || kind === 'tool' ? 3 : 1;
}

export function toOtlpJson(trace, {
  serviceName = 'orangefive',
  serviceVersion = 'OrangeFive',
  environment = 'local',
} = {}) {
  if (!trace?.trace_id || !Array.isArray(trace.spans)) throw new Error('OTLP export requires a complete Orange trace');
  const exportedTraceId = traceId(trace.trace_id);
  const spans = trace.spans.map((span) => {
    if (!span.ended_at) throw new Error(`cannot export running span: ${span.span_id}`);
    const semantic = {
      ...span.attributes,
      'gen_ai.operation.name': operationName(span.kind),
      'gen_ai.provider.name': 'orange.local',
      'gen_ai.workflow.name': trace.name,
      'orange5.span.kind': span.kind,
      'orange5.span.sha256': span.span_hash,
      'orange5.result.sha256': span.result_hash,
    };
    const out = {
      traceId: exportedTraceId,
      spanId: spanId(span.span_id),
      name: span.name,
      kind: otelKind(span.kind),
      startTimeUnixNano: unixNano(span.started_at),
      endTimeUnixNano: unixNano(span.ended_at),
      attributes: attributes(semantic),
      status: { code: span.status === 'ok' ? 1 : 2, message: span.error || '' },
    };
    if (span.parent_span_id) out.parentSpanId = spanId(span.parent_span_id);
    return out;
  });
  return {
    resourceSpans: [{
      resource: { attributes: attributes({
        'service.name': serviceName,
        'service.version': serviceVersion,
        'deployment.environment.name': environment,
        'orange5.trace.sha256': sha256(JSON.stringify(trace)),
      }) },
      scopeSpans: [{
        scope: { name: 'atomeons.orangefive.trace-store', version: '1.0.0' },
        spans,
      }],
    }],
  };
}

export function exportTrace({ store = null, traceId: requestedTraceId, outputPath } = {}) {
  let ownsStore = false;
  if (!store) {
    store = new TraceStore();
    ownsStore = true;
  }
  try {
    const selected = requestedTraceId || store.listTraces(1)[0]?.trace_id;
    if (!selected) throw new Error('no Orange trace is available to export');
    const trace = store.getTrace(selected);
    if (!trace) throw new Error(`trace not found: ${selected}`);
    const payload = toOtlpJson(trace);
    const target = path.resolve(outputPath || path.join(ROOT, '10-RECEIPTS', 'orange5-build', `${selected}-otlp.json`));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const json = `${JSON.stringify(payload, null, 2)}\n`;
    fs.writeFileSync(target, json, 'utf8');
    return { trace_id: selected, spans: trace.spans.length, output_path: target, sha256: sha256(json) };
  } finally {
    if (ownsStore) store.close();
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const get = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };
  const store = new TraceStore();
  try {
    console.log(JSON.stringify(exportTrace({
      store,
      traceId: get('--trace-id'),
      outputPath: get('--out'),
    }), null, 2));
  } finally {
    store.close();
  }
}

export const __otelInternals = Object.freeze({ traceId, spanId, unixNano, anyValue, operationName, otelKind });
