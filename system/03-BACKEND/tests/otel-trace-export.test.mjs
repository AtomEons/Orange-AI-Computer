import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TraceStore } from '../trace-store.mjs';
import { exportTrace, toOtlpJson } from '../otel-trace-export.mjs';

const roots = [];

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    for (let attempt = 0; attempt < 20; attempt += 1) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        break;
      } catch {
        Bun.gc(true);
        await Bun.sleep(25);
      }
    }
  }
});

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-otlp-'));
  roots.push(root);
  const store = new TraceStore(path.join(root, 'traces.sqlite'));
  store.openTrace({ traceId: 'trace_0123456789abcdef0123456789abcdef', name: 'orangefive.test', attributes: { orderId: 'order-1' } });
  const rootSpan = store.startSpan({ traceId: 'trace_0123456789abcdef0123456789abcdef', name: 'workflow', kind: 'orchestrator' });
  store.endSpan(rootSpan, { status: 'ok', result: { secret_output: 'never exported' } });
  return { root, store };
}

describe('OrangeFive OTLP trace export', () => {
  test('maps a verified local trace to standard OTLP JSON without raw result content', () => {
    const { store } = fixture();
    const trace = store.getTrace('trace_0123456789abcdef0123456789abcdef');
    const otlp = toOtlpJson(trace);
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/);
    expect(span.status.code).toBe(1);
    expect(JSON.stringify(otlp)).not.toContain('never exported');
    expect(JSON.stringify(otlp)).toContain('gen_ai.operation.name');
    store.close();
  });

  test('writes the latest trace with a stable file hash', () => {
    const { root, store } = fixture();
    const outputPath = path.join(root, 'trace.otlp.json');
    const result = exportTrace({ store, outputPath });
    expect(result.spans).toBe(1);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.existsSync(outputPath)).toBe(true);
    expect(store.listTraces(1)[0].trace_id).toBe(result.trace_id);
    store.close();
  });
});
