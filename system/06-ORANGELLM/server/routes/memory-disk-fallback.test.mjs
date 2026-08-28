import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { __memoryHandlers, createMemoryRouteConfig } from './memory.mjs';

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orange-memory-disk-'));
  roots.push(root);
  const events = join(root, 'events');
  const day = new Date().toISOString().slice(0, 10);
  for (const lane of ['reality', 'thought']) mkdirSync(join(events, lane), { recursive: true });
  const reality = {
    id: 'reality-1', ts: Date.now(), lane: 'reality', kind: 'decision',
    summary: 'Orange route uses authenticated AE Phase', source_pointer: { hash: 'a'.repeat(64) },
  };
  const thought = {
    id: 'thought-1', ts: Date.now() - 1, lane: 'thought', kind: 'task',
    summary: 'Verify the Orange route', next_action: 'run the live route', source_pointer: { hash: 'b'.repeat(64) },
  };
  writeFileSync(join(events, 'reality', `${day}.jsonl`), `${JSON.stringify(reality)}\n`);
  writeFileSync(join(events, 'thought', `${day}.jsonl`), `${JSON.stringify(thought)}\n`);
  return { root, events };
}

describe('Orange memory canonical-disk fallback', () => {
  test('returns raw source-backed records when the Cobra process is unavailable', async () => {
    const { root, events } = fixture();
    const cfg = createMemoryRouteConfig({
      cobraUrl: 'http://127.0.0.1:9',
      cobraTimeoutMs: 50,
      cacheDir: join(root, 'unused-shadow'),
      eventsDir: events,
      log: () => {},
    });

    const result = await __memoryHandlers.handleStateBrief({ query: 'Orange route', max_records: 4 }, cfg);

    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      schema: 'orange5.state-brief.disk-fallback.v1',
      served_by: 'canonical_disk_fallback',
      degraded: true,
    });
    expect(result.body.reality[0].source_pointer.hash).toHaveLength(64);
    expect(result.body.thought[0].next_action).toBe('run the live route');
    expect(result.body.retrieval.source).toBe('canonical-cobra-disk');
  });

  test('health reports canonical disk as the honest degraded serving path', async () => {
    const { root, events } = fixture();
    const cfg = createMemoryRouteConfig({
      cobraUrl: 'http://127.0.0.1:9',
      cobraTimeoutMs: 50,
      cacheDir: join(root, 'unused-shadow'),
      eventsDir: events,
      log: () => {},
    });

    const result = await __memoryHandlers.handleMemoryHealth(cfg);

    expect(result.status).toBe('degraded');
    expect(result.serving).toBe('canonical_disk_fallback');
    expect(result.canonical_disk.live).toBe(true);
  });
});
