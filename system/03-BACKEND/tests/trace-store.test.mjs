import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceStore } from '../trace-store.mjs';

const cleanup = [];

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; } catch { await Bun.sleep(25); }
    }
  }
});

function makeStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-traces-'));
  cleanup.push(dir);
  return new TraceStore(path.join(dir, 'traces.sqlite'));
}

describe('OrangeFive hierarchical trace store', () => {
  test('records parent-child spans with verified result hashes', () => {
    const traces = makeStore();
    traces.openTrace({ traceId: 'trace-a', name: 'mission', attributes: { orderId: 'order-a' } });
    const root = traces.startSpan({ traceId: 'trace-a', name: 'mission.run', kind: 'orchestrator' });
    const child = traces.startSpan({ traceId: 'trace-a', parentSpanId: root, name: 'brain.call', kind: 'model' });
    traces.endSpan(child, { result: { model: 'navigator', ok: true } });
    traces.endSpan(root, { result: { status: 'GREEN' } });
    const proof = traces.verifyTrace('trace-a');
    expect(proof.ok).toBe(true);
    expect(proof.spans).toBe(2);
    expect(traces.getTrace('trace-a').spans[1].parent_span_id).toBe(root);
    traces.close();
  });

  test('tracks repeated invocations and resumed spans', () => {
    const traces = makeStore();
    traces.openTrace({ traceId: 'trace-b', name: 'mission' });
    traces.openTrace({ traceId: 'trace-b', name: 'mission' });
    const span = traces.startSpan({ traceId: 'trace-b', name: 'checkpoint', attributes: { resumed: true } });
    traces.endSpan(span);
    const proof = traces.verifyTrace('trace-b');
    expect(proof.invocation_count).toBe(2);
    expect(proof.resumed).toBe(1);
    traces.close();
  });

  test('detects stored-result tampering', () => {
    const traces = makeStore();
    traces.openTrace({ traceId: 'trace-c', name: 'mission' });
    const span = traces.startSpan({ traceId: 'trace-c', name: 'tool' });
    traces.endSpan(span, { result: { value: 1 } });
    traces.db.prepare("UPDATE trace_spans SET result_json = '{\"value\":2}' WHERE span_id = ?").run(span);
    expect(traces.verifyTrace('trace-c').broken).toContain(`${span}:result`);
    traces.close();
  });
});
