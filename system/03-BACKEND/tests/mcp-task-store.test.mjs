import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { McpTaskStore } from '../mcp-task-store.mjs';

const cleanup = [];

function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-mcp-tasks-'));
  cleanup.push(dir);
  return new McpTaskStore(path.join(dir, 'tasks.sqlite'));
}

afterEach(async () => {
  for (const dir of cleanup.splice(0)) {
    for (let attempt = 0; attempt < 10; attempt += 1) {
      try { fs.rmSync(dir, { recursive: true, force: true }); break; }
      catch { await Bun.sleep(25); }
    }
  }
});

describe('MCP Tasks extension durable store', () => {
  test('durably creates, claims, completes, and reopens a task', () => {
    const first = store();
    const created = first.create({ toolName: 'orange5_delegate', arguments: { execute: false } });
    expect(created.resultType).toBe('task');
    expect(first.claim(created.taskId, 'worker-a')).toBe(true);
    first.complete(created.taskId, { content: [{ type: 'text', text: 'done' }], isError: false });
    const dbPath = first.path;
    first.close();

    const reopened = new McpTaskStore(dbPath);
    const task = reopened.get(created.taskId);
    expect(task.status).toBe('completed');
    expect(task.result.content[0].text).toBe('done');
    reopened.close();
  });

  test('leases prevent duplicate workers and permit expired recovery', () => {
    const tasks = store();
    const created = tasks.create({ toolName: 'orange5_order' });
    expect(tasks.claim(created.taskId, 'worker-a', 30_000)).toBe(true);
    expect(tasks.claim(created.taskId, 'worker-b', 30_000)).toBe(false);
    tasks.db.prepare('UPDATE mcp_tasks SET lease_until_ms = 0 WHERE task_id = ?').run(created.taskId);
    expect(tasks.shouldRecover(created.taskId)).toBe(true);
    expect(tasks.claim(created.taskId, 'worker-b', 30_000)).toBe(true);
    tasks.close();
  });

  test('cancellation is terminal and cannot be repeated', () => {
    const tasks = store();
    const created = tasks.create({ toolName: 'orange5_browser' });
    expect(tasks.cancel(created.taskId)).toBe(true);
    expect(tasks.get(created.taskId).status).toBe('cancelled');
    expect(() => tasks.cancel(created.taskId)).toThrow('already cancelled');
    tasks.close();
  });

  test('uses unguessable bearer handles and bounds resource controls', () => {
    const tasks = store();
    const created = tasks.create({ toolName: 'orange5_chat', ttlMs: 1, pollIntervalMs: 1 });
    expect(created.taskId.length).toBeGreaterThan(30);
    expect(created.ttlMs).toBe(60_000);
    expect(created.pollIntervalMs).toBe(100);
    tasks.close();
  });
});
