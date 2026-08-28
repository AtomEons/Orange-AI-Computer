import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendPartyLineEvent,
  hydratePartyLine,
  readPartyLine,
  validatePartyLineEvent,
} from './ledger.mjs';

const roots = [];
const fixture = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-party-line-'));
  roots.push(root);
  return path.join(root, 'events.jsonl');
};

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Orange Party Line disk ledger', () => {
  test('appends validated events and projects detail without loading a cache', async () => {
    const filePath = fixture();
    const first = await appendPartyLineEvent({
      projectId: 'alpha',
      actor: { id: 'operator', kind: 'operator', displayName: 'Operator' },
      eventType: 'message',
      summary: 'Build the memory benchmark',
      body: 'Build the memory benchmark and prove recall.',
      sourceRefs: [{ uri: 'receipt://alpha/1', hash: 'abc' }],
    }, { filePath, now: '2026-08-27T12:00:00.000Z' });
    expect(validatePartyLineEvent(first.event).ok).toBe(true);

    const quiet = await readPartyLine({ filePath, detail: 'quiet' });
    expect(quiet.events).toHaveLength(1);
    expect(quiet.events[0].body).toBeUndefined();
    expect(quiet.cursor).toBeGreaterThan(0);

    const wire = await readPartyLine({ filePath, detail: 'wire' });
    expect(wire.events[0].body).toContain('prove recall');
    expect(wire.events[0].sourceRefs[0].uri).toBe('receipt://alpha/1');
  });

  test('cursor returns only new disk events', async () => {
    const filePath = fixture();
    await appendPartyLineEvent({ actor: { id: 'a', kind: 'agent' }, eventType: 'status', summary: 'first' }, { filePath });
    const initial = await readPartyLine({ filePath, detail: 'normal' });
    await appendPartyLineEvent({ actor: { id: 'b', kind: 'agent' }, eventType: 'repair', summary: 'second' }, { filePath });
    const delta = await readPartyLine({ filePath, cursor: initial.cursor, tail: false, detail: 'normal' });
    expect(delta.events.map((event) => event.summary)).toEqual(['second']);
  });

  test('hydrates a relevant source-addressed workbench instead of replaying history', async () => {
    const filePath = fixture();
    await appendPartyLineEvent({ actor: { id: 'eyes', kind: 'agent' }, eventType: 'status', summary: 'AE Eyes visual queue is idle' }, { filePath });
    await appendPartyLineEvent({ actor: { id: 'memory', kind: 'agent' }, eventType: 'decision', summary: 'Memory recall uses hybrid reranking', body: 'Lexical plus dense candidates are reranked.' }, { filePath });
    const hydration = await hydratePartyLine({ query: 'How does memory recall reranking work?', filePath, limit: 1 });
    expect(hydration.selected).toHaveLength(1);
    expect(hydration.selected[0].summary).toContain('Memory recall');
    expect(hydration.context).toContain(`[party:${hydration.selected[0].id}]`);
    expect(hydration.context).not.toContain('visual queue');
    expect(hydration.context).not.toContain('Lexical plus dense candidates are reranked.');
  });

  test('ranks an exact operational record above echoed chat without hot-storing the transcript', async () => {
    const filePath = fixture();
    const proofId = 'party-proof-12345678-aaaa-bbbb-cccc-1234567890ab';
    await appendPartyLineEvent({
      projectId: 'orange5',
      actor: { id: 'proof', kind: 'agent', displayName: 'Proof' },
      eventType: 'status',
      summary: `Party Line live proof ${proofId}`,
      body: 'Large proof body stays cold on disk.',
    }, { filePath });
    await appendPartyLineEvent({
      projectId: 'atomic-orange',
      actor: { id: 'operator', kind: 'operator', displayName: 'Operator' },
      eventType: 'message',
      summary: `Explain ${proofId}`,
      body: `Explain ${proofId}`,
    }, { filePath });
    const hydration = await hydratePartyLine({
      query: `Explain ${proofId}.`,
      projectId: 'atomic-orange',
      limit: 2,
      filePath,
    });
    expect(hydration.selected[0].eventType).toBe('status');
    expect(hydration.selected[0].summary).toContain(proofId);
    expect(hydration.context).toContain('authority=operational-record');
    expect(hydration.context).not.toContain('Large proof body stays cold on disk.');
  });
});
