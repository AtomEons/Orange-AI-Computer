import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { LearningQueueStore, drainLearningQueue } from '../learning-queue.mjs';

const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-learning-queue-'));
  roots.push(root);
  return { root, dbPath: path.join(root, 'learning.sqlite') };
}

function receipt(overrides = {}) {
  return {
    action: 'query.chat',
    status: 'completed',
    summary: 'governed answer completed',
    hash: 'a'.repeat(64),
    receipt_id: 'receipt-1',
    ...overrides,
  };
}

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

describe('OrangeFive durable learning queue', () => {
  test('enqueues idempotently from a stable receipt', () => {
    const { dbPath } = fixture();
    const store = new LearningQueueStore(dbPath);
    const first = store.enqueue(receipt());
    const second = store.enqueue(receipt());
    expect(first.item_id).toBe(second.item_id);
    expect(store.stats()).toMatchObject({
      total: 1,
      by_status: { pending: 1 },
      open: 1,
      failed: 0,
      oldest_open_at: first.created_at,
    });
    expect(store.verify(first.item_id).ok).toBe(true);
    expect(store.db.query('PRAGMA journal_mode;').get()?.journal_mode).toBe('wal');
    expect(Number(store.db.query('PRAGMA synchronous;').get()?.synchronous)).toBe(1);
    expect(Number(store.db.query('PRAGMA foreign_keys;').get()?.foreign_keys)).toBe(1);
    store.close();
  });

  test('rejects an idempotency-key collision with a changed payload', () => {
    const { dbPath } = fixture();
    const store = new LearningQueueStore(dbPath);
    store.enqueue(receipt());
    expect(() => store.enqueue(receipt({ summary: 'different governed result' })))
      .toThrow('learning queue payload changed');
    expect(store.stats().total).toBe(1);
    store.close();
  });

  test('persists and completes accepted Cobra ingestion', async () => {
    const { dbPath } = fixture();
    let store = new LearningQueueStore(dbPath);
    const queued = store.enqueue(receipt());
    store.close();
    store = new LearningQueueStore(dbPath);
    const result = await drainLearningQueue({
      store,
      ingest: async () => ({ ok: true, accepted: true, id: 'memory-1', transport: 'test-cobra' }),
    });
    expect(result.processed).toBe(1);
    expect(store.get(queued.item_id)).toMatchObject({ status: 'completed', attempts: 1 });
    expect(store.verify(queued.item_id).ok).toBe(true);
    store.close();
  });

  test('retries a rejected item without claiming it was learned', async () => {
    const { dbPath } = fixture();
    const store = new LearningQueueStore(dbPath);
    const queued = store.enqueue(receipt());
    await drainLearningQueue({ store, ingest: async () => { throw new Error('cobra offline'); } });
    const item = store.get(queued.item_id);
    expect(item.status).toBe('retry');
    expect(item.attempts).toBe(1);
    expect(item.result).toBeNull();
    expect(item.last_error).toContain('cobra offline');
    store.close();
  });

  test('recovers an expired processing lease after restart', () => {
    const { dbPath } = fixture();
    let store = new LearningQueueStore(dbPath);
    const queued = store.enqueue(receipt());
    const leased = store.leaseNext({ owner: 'dead-worker', leaseMs: 1_000 });
    expect(leased.status).toBe('processing');
    store.db.prepare('UPDATE learning_queue SET lease_expires_at = ? WHERE item_id = ?')
      .run('2000-01-01T00:00:00.000Z', queued.item_id);
    store.close();
    store = new LearningQueueStore(dbPath);
    const recovered = store.leaseNext({ owner: 'new-worker' });
    expect(recovered.item_id).toBe(queued.item_id);
    expect(recovered.attempts).toBe(2);
    expect(recovered.lease_owner).toBe('new-worker');
    store.close();
  });

  test('stops after the bounded retry budget', async () => {
    const { dbPath } = fixture();
    const store = new LearningQueueStore(dbPath);
    const queued = store.enqueue(receipt(), { maxAttempts: 2 });
    await drainLearningQueue({ store, ingest: async () => { throw new Error('still offline'); } });
    store.db.prepare('UPDATE learning_queue SET next_attempt_at = ? WHERE item_id = ?')
      .run('2000-01-01T00:00:00.000Z', queued.item_id);
    await drainLearningQueue({ store, ingest: async () => { throw new Error('still offline'); } });
    expect(store.get(queued.item_id)).toMatchObject({ status: 'failed', attempts: 2 });
    store.close();
  });

  test('parallel process startup initializes one WAL queue without lock failures', async () => {
    const { dbPath } = fixture();
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, '..', 'learning-queue.mjs')).href;
    const workers = Array.from({ length: 6 }, (_, index) => {
      const code = [
        `import { LearningQueueStore } from ${JSON.stringify(moduleUrl)};`,
        `const store = new LearningQueueStore(${JSON.stringify(dbPath)});`,
        `store.enqueue({ action: 'query.chat', status: 'completed', hash: '${String(index).padStart(64, '0')}', receipt_id: 'parallel-${index}' });`,
        'store.close();',
      ].join(' ');
      return Bun.spawn([process.execPath, '--eval', code], { stdout: 'pipe', stderr: 'pipe' });
    });
    const exits = await Promise.all(workers.map((worker) => worker.exited));
    const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
    expect(exits).toEqual(Array(6).fill(0));
    expect(errors.join('')).toBe('');
    const store = new LearningQueueStore(dbPath);
    expect(store.stats().total).toBe(6);
    store.close();
  });

  test('leases unique items across concurrent processes', async () => {
    const { dbPath } = fixture();
    const moduleUrl = pathToFileURL(path.resolve(import.meta.dir, '..', 'learning-queue.mjs')).href;
    const store = new LearningQueueStore(dbPath);
    for (let index = 0; index < 6; index += 1) {
      store.enqueue(receipt({ hash: String(index).padStart(64, '0'), receipt_id: `lease-${index}` }));
    }
    store.close();
    const workers = Array.from({ length: 6 }, (_, index) => {
      const code = [
        `import { LearningQueueStore } from ${JSON.stringify(moduleUrl)};`,
        `const store = new LearningQueueStore(${JSON.stringify(dbPath)});`,
        `const item = store.leaseNext({ owner: 'worker-${index}' });`,
        `console.log(item?.item_id || 'NONE');`,
        'store.close();',
      ].join(' ');
      return Bun.spawn([process.execPath, '--eval', code], { stdout: 'pipe', stderr: 'pipe' });
    });
    const exits = await Promise.all(workers.map((worker) => worker.exited));
    const outputs = await Promise.all(workers.map((worker) => new Response(worker.stdout).text()));
    const errors = await Promise.all(workers.map((worker) => new Response(worker.stderr).text()));
    const leasedIds = outputs.map((output) => output.trim());
    expect(exits).toEqual(Array(6).fill(0));
    expect(errors.join('')).toBe('');
    expect(leasedIds).not.toContain('NONE');
    expect(new Set(leasedIds).size).toBe(6);
  });
});
