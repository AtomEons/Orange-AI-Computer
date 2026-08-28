import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const roots = [];
afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Orange Party Line gateway handlers', () => {
  test('validates writes, reads detail views, and hydrates by query', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-party-route-'));
    roots.push(root);
    const filePath = path.join(root, 'events.jsonl');
    const module = await import('./party-line.mjs');

    const bad = await module.handlePartyLinePost({ eventType: 'message', summary: '' }, { filePath });
    expect(bad.status).toBe(400);

    const written = await module.handlePartyLinePost({
      projectId: 'orange5',
      actor: { id: 'navigator', kind: 'model', displayName: 'Navigator' },
      eventType: 'decision',
      summary: 'Route code changes through Hermes',
      body: 'Use a bounded lease and preserve the receipt.',
    }, { filePath });
    expect(written.status).toBe(201);

    const page = await module.handlePartyLineGet(new URL('http://127.0.0.1/v1/party-line?detail=quiet'), { filePath });
    expect(page.body.events).toHaveLength(1);
    expect(page.body.events[0].body).toBeUndefined();

    const hydration = await module.handlePartyLineHydrate({ query: 'How should code changes be routed?', limit: 3 }, { filePath });
    expect(hydration.status).toBe(200);
    expect(hydration.body.context).toContain('Hermes');
  });
});
