import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BuildRunStore } from './store.mjs';

describe('BuildRunStore', () => {
  test('persists and restores a thread run from an append-only verified chain', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-build-run-'));
    const file = path.join(dir, 'events.jsonl');
    const store = new BuildRunStore(file);
    const created = await store.ensureForThread({ threadId: 'thread-1', goal: 'Build the proof', projectRoot: 'C:/work' });
    await store.update(created.run.runId, {
      stage: 'observe', status: 'working', route: { tier: 'navigator' }, receipts: [{ id: 'rcpt-1' }], nextAction: 'verify',
    }, 'turn_settled');

    const restored = new BuildRunStore(file).list({ threadId: 'thread-1' });
    expect(restored.chain.ok).toBe(true);
    expect(restored.runs).toHaveLength(1);
    expect(restored.runs[0]).toMatchObject({ threadId: 'thread-1', goal: 'Build the proof', stage: 'observe', status: 'working' });
    expect(restored.runs[0].receipts).toEqual([{ id: 'rcpt-1' }]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reuses an active thread run and starts a new run after completion', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-build-run-'));
    const store = new BuildRunStore(path.join(dir, 'events.jsonl'));
    const first = await store.ensureForThread({ threadId: 'thread-2', goal: 'First goal' });
    const reused = await store.ensureForThread({ threadId: 'thread-2', goal: 'Ignored replacement' });
    expect(reused.run.runId).toBe(first.run.runId);
    await store.update(first.run.runId, { stage: 'settle', status: 'completed' }, 'closed');
    const second = await store.ensureForThread({ threadId: 'thread-2', goal: 'Second goal' });
    expect(second.run.runId).not.toBe(first.run.runId);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('reports malformed JSONL as a chain failure and refuses to append to it', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-build-run-'));
    const file = path.join(dir, 'events.jsonl');
    const store = new BuildRunStore(file);
    const created = await store.create({ goal: 'Preserve chain integrity' });
    fs.appendFileSync(file, '{"schema":\n', 'utf8');

    const page = store.list();
    expect(page.chain.ok).toBe(false);
    expect(page.chain.errors).toContainEqual(expect.objectContaining({ line: 2, code: 'malformed_jsonl' }));
    await expect(store.update(created.run.runId, { status: 'working' })).rejects.toThrow('build run event chain verification failed: malformed_jsonl at line 2');
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
