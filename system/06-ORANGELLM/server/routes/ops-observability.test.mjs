import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';
import { LearningQueueStore } from '../../../03-BACKEND/learning-queue.mjs';
import { TraceStore } from '../../../03-BACKEND/trace-store.mjs';
import { handleOpsLearning, handleOpsTraces } from './ops-observability.mjs';

function tempPath(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-ops-'));
  return path.join(root, name);
}

describe('Orange operator observability routes', () => {
  test('lists learning state without exposing raw payload content', () => {
    const dbPath = tempPath('learning.sqlite');
    const store = new LearningQueueStore(dbPath);
    const item = store.enqueue({ action: 'query.chat', targetProject: 'orange5', summary: 'SECRET RAW SUMMARY' });
    store.complete(item.item_id, { accepted: true, transport: 'test' });
    store.close();
    const result = handleOpsLearning(new URL('http://orange/v1/ops/learning?limit=10'), { dbPath });
    expect(result.status).toBe(200);
    expect(result.body.items[0]).toMatchObject({ action: 'query.chat', target_project: 'orange5', status: 'completed' });
    expect(JSON.stringify(result.body)).not.toContain('SECRET RAW SUMMARY');
  });

  test('returns verified trace topology without raw result bodies', () => {
    const dbPath = tempPath('traces.sqlite');
    const store = new TraceStore(dbPath);
    store.openTrace({ traceId: 'trace_0123456789abcdef0123456789abcdef', name: 'mission', attributes: { orderId: 'order-1', secret: 'DROP' } });
    const span = store.startSpan({ traceId: 'trace_0123456789abcdef0123456789abcdef', name: 'model', kind: 'model', attributes: { model: 'navigator', prompt: 'DROP' } });
    store.endSpan(span, { result: { raw: 'SECRET MODEL OUTPUT' } });
    store.close();
    const result = handleOpsTraces(new URL('http://orange/v1/ops/traces?trace_id=trace_0123456789abcdef0123456789abcdef'), { dbPath });
    expect(result.status).toBe(200);
    expect(result.body.trace.verification.ok).toBe(true);
    expect(result.body.trace.spans[0].result_hash).toHaveLength(64);
    expect(JSON.stringify(result.body)).not.toContain('SECRET MODEL OUTPUT');
    expect(JSON.stringify(result.body)).not.toContain('DROP');
  });

  test('exports a verified sanitized trace as standard OTLP JSON', () => {
    const dbPath = tempPath('traces.sqlite');
    const store = new TraceStore(dbPath);
    const traceId = 'trace_abcdef0123456789abcdef0123456789';
    store.openTrace({ traceId, name: 'mission', attributes: { orderId: 'order-2' } });
    const span = store.startSpan({ traceId, name: 'model', kind: 'model', attributes: { model: 'navigator', prompt: 'NEVER EXPORT' } });
    store.endSpan(span, { result: { raw: 'NEVER EXPORT RESULT' } });
    store.close();
    const result = handleOpsTraces(new URL(`http://orange/v1/ops/traces?trace_id=${traceId}&format=otlp`), { dbPath });
    expect(result.status).toBe(200);
    expect(result.body.schema).toBe('orange.ops.trace-otlp.v1');
    expect(result.body.otlp.resourceSpans[0].scopeSpans[0].spans[0].traceId).toBe('abcdef0123456789abcdef0123456789');
    expect(JSON.stringify(result.body)).not.toContain('NEVER EXPORT');
    expect(JSON.stringify(result.body)).toContain('gen_ai.operation.name');
  });
});
