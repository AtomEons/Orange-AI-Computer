import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DurableRunStore } from '../durable-run-store.mjs';

const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-durable-run-'));
  roots.push(root);
  return { root, dbPath: path.join(root, 'runs.sqlite') };
}

afterEach(async () => {
  while (roots.length) {
    const root = roots.pop();
    let lastError = null;
    for (let attempt = 0; attempt < 20; attempt++) {
      try {
        fs.rmSync(root, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;
        Bun.gc(true);
        await Bun.sleep(25);
      }
    }
    if (lastError) throw lastError;
  }
});

describe('OrangeFive durable run store', () => {
  test('persists a completed checkpoint and reuses it without repeating effects', async () => {
    const { dbPath } = fixture();
    const store = new DurableRunStore(dbPath);
    store.openRun({ runId: 'run-1', orderId: 'order-1', runType: 'proof', input: { intent: 'test' } });
    let calls = 0;
    const first = await store.step({
      runId: 'run-1', stepName: 'probe', stepIndex: 1, input: { url: 'local' },
      execute: async () => { calls++; return { ok: true, value: 7 }; },
    });
    const second = await store.step({
      runId: 'run-1', stepName: 'probe', stepIndex: 1, input: { url: 'local' },
      execute: async () => { calls++; return { ok: false }; },
    });
    expect(first.resumed).toBe(false);
    expect(second.resumed).toBe(true);
    expect(second.output).toEqual({ ok: true, value: 7 });
    expect(calls).toBe(1);
    expect(store.verifyRun('run-1').ok).toBe(true);
    store.close();
  });

  test('retries a failed checkpoint and records the attempt count', async () => {
    const { dbPath } = fixture();
    const store = new DurableRunStore(dbPath);
    store.openRun({ runId: 'run-2', orderId: 'order-2', runType: 'proof', input: {} });
    await expect(store.step({
      runId: 'run-2', stepName: 'unstable', stepIndex: 1,
      execute: async () => { throw new Error('controlled failure'); },
    })).rejects.toThrow('controlled failure');
    expect(store.getCheckpoint('run-2', 'unstable').status).toBe('failed');
    store.openRun({ runId: 'run-2', orderId: 'order-2', runType: 'proof', input: {} });
    const recovered = await store.step({
      runId: 'run-2', stepName: 'unstable', stepIndex: 1,
      execute: async () => ({ ok: true }),
    });
    expect(recovered.attempt).toBe(2);
    expect(recovered.output.ok).toBe(true);
    store.close();
  });

  test('reruns a checkpoint when its declared input changes', async () => {
    const { dbPath } = fixture();
    const store = new DurableRunStore(dbPath);
    store.openRun({ runId: 'run-3', orderId: 'order-3', runType: 'proof', input: {} });
    let calls = 0;
    await store.step({ runId: 'run-3', stepName: 'query', stepIndex: 1, input: { q: 1 }, execute: async () => ({ n: ++calls }) });
    const changed = await store.step({ runId: 'run-3', stepName: 'query', stepIndex: 1, input: { q: 2 }, execute: async () => ({ n: ++calls }) });
    expect(changed.resumed).toBe(false);
    expect(changed.attempt).toBe(2);
    expect(changed.output.n).toBe(2);
    store.close();
  });

  test('survives process-style close and reopen with intact hashes', async () => {
    const { dbPath } = fixture();
    let store = new DurableRunStore(dbPath);
    store.openRun({ runId: 'run-4', orderId: 'order-4', runType: 'proof', input: { stable: true } });
    await store.step({ runId: 'run-4', stepName: 'persist', stepIndex: 1, execute: async () => ({ proof: 'kept' }) });
    store.close();
    store = new DurableRunStore(dbPath);
    const resumed = await store.step({ runId: 'run-4', stepName: 'persist', stepIndex: 1, execute: async () => ({ proof: 'wrong' }) });
    expect(resumed.resumed).toBe(true);
    expect(resumed.output.proof).toBe('kept');
    expect(store.verifyRun('run-4')).toMatchObject({ ok: true, completed: 1 });
    store.close();
  });

  test('completes a run with a verifiable final output', async () => {
    const { dbPath } = fixture();
    const store = new DurableRunStore(dbPath);
    store.openRun({ runId: 'run-5', orderId: 'order-5', runType: 'proof', input: {} });
    await store.step({ runId: 'run-5', stepName: 'done', stepIndex: 1, execute: async () => ({ ok: true }) });
    const run = store.completeRun('run-5', { receipt: 'r-5' });
    expect(run.status).toBe('completed');
    expect(run.output).toEqual({ receipt: 'r-5' });
    expect(store.verifyRun('run-5')).toMatchObject({ ok: true, status: 'completed' });
    store.close();
  });

  test('refuses to reuse a run id for different mission input', () => {
    const { dbPath } = fixture();
    const store = new DurableRunStore(dbPath);
    store.openRun({ runId: 'run-6', orderId: 'order-6', runType: 'proof', input: { intent: 'a' } });
    expect(() => store.openRun({ runId: 'run-6', orderId: 'order-6', runType: 'proof', input: { intent: 'b' } }))
      .toThrow('durable run input changed');
    store.close();
  });
});
