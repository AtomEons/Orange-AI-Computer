import { LearningQueueStore, canonicalLearningQueuePath } from '../../../03-BACKEND/learning-queue.mjs';
import { TraceStore, canonicalTracePath } from '../../../03-BACKEND/trace-store.mjs';
import { toOtlpJson } from '../../../03-BACKEND/otel-trace-export.mjs';

export const OPS_LEARNING_PATH = '/v1/ops/learning';
export const OPS_TRACES_PATH = '/v1/ops/traces';

function boundedLimit(url, fallback = 25) {
  return Math.max(1, Math.min(100, Number(url.searchParams.get('limit')) || fallback));
}

function safeAttributes(attributes = {}) {
  const output = {};
  for (const [key, value] of Object.entries(attributes || {})) {
    if (!/^(?:order|action|project|route|lane|model|host|status|resumed|checkpoint|tool|risk|iteration|gen_ai\.)/i.test(key)) continue;
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) output[key] = value;
  }
  return output;
}

function safeTrace(trace, proof) {
  return {
    trace_id: trace.trace_id,
    name: trace.name,
    attributes: safeAttributes(trace.attributes),
    created_at: trace.created_at,
    updated_at: trace.updated_at,
    invocation_count: trace.invocation_count,
    verification: proof,
    spans: trace.spans.map((span) => ({
      span_id: span.span_id,
      parent_span_id: span.parent_span_id,
      name: span.name,
      kind: span.kind,
      status: span.status,
      started_at: span.started_at,
      ended_at: span.ended_at,
      duration_ms: span.duration_ms,
      attributes: safeAttributes(span.attributes),
      result_hash: span.result_hash,
      span_hash: span.span_hash,
      error: span.error ? String(span.error).slice(0, 500) : null,
    })),
  };
}

export function handleOpsLearning(url, { dbPath = canonicalLearningQueuePath() } = {}) {
  const store = new LearningQueueStore(dbPath);
  try {
    const itemId = String(url.searchParams.get('item_id') || '').trim();
    if (itemId) {
      const item = store.list({ limit: 200 }).find((row) => row.item_id === itemId);
      if (!item) return { status: 404, body: { error: 'learning_item_not_found', item_id: itemId } };
      return { status: 200, body: { schema: 'orange.ops.learning.v1', stats: store.stats(), item, verification: store.verify(itemId) } };
    }
    const status = String(url.searchParams.get('status') || '').trim() || null;
    return {
      status: 200,
      body: {
        schema: 'orange.ops.learning.v1',
        stats: store.stats(),
        items: store.list({ limit: boundedLimit(url), status }),
        payload_policy: 'hashes and bounded operational metadata only; raw learning payloads are not exposed',
      },
    };
  } finally {
    store.close();
  }
}

export function handleOpsTraces(url, { dbPath = canonicalTracePath() } = {}) {
  const store = new TraceStore(dbPath);
  try {
    const traceId = String(url.searchParams.get('trace_id') || '').trim();
    if (traceId) {
      const trace = store.getTrace(traceId);
      if (!trace) return { status: 404, body: { error: 'trace_not_found', trace_id: traceId } };
      const proof = store.verifyTrace(traceId);
      const safe = safeTrace(trace, proof);
      if (String(url.searchParams.get('format') || '').toLowerCase() === 'otlp') {
        return {
          status: 200,
          body: {
            schema: 'orange.ops.trace-otlp.v1',
            trace_id: traceId,
            verification: proof,
            otlp: toOtlpJson(safe),
            content_policy: 'standard OTLP JSON with bounded attributes and hashes; raw result bodies omitted',
          },
        };
      }
      return { status: 200, body: { schema: 'orange.ops.trace.v1', trace: safe, content_policy: 'result bodies omitted; hashes retained' } };
    }
    const traces = store.listTraces(boundedLimit(url)).map((trace) => ({
      ...trace,
      attributes: safeAttributes(trace.attributes),
      verification: store.verifyTrace(trace.trace_id),
    }));
    return { status: 200, body: { schema: 'orange.ops.traces.v1', traces, content_policy: 'bounded metadata only; raw model and tool output omitted' } };
  } finally {
    store.close();
  }
}

export const __opsObservabilityInternals = Object.freeze({ boundedLimit, safeAttributes, safeTrace });
