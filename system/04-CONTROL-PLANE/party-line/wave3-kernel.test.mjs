import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  appendPartyLineEvent,
  normalizeWave3KernelSummary,
  readPartyLine,
} from './ledger.mjs';

const roots = [];

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-party-line-wave3-'));
  roots.push(root);
  return path.join(root, 'events.jsonl');
}

function activationBitset(activeMechanismIds) {
  const active = new Set(activeMechanismIds);
  const bits = Array.from({ length: 100 }, (_, index) => (
    active.has(`W3K-${String(index + 1).padStart(3, '0')}`) ? '1' : '0'
  )).join('');
  return bits.match(/.{4}/g)
    .map((nibble) => Number.parseInt(nibble, 2).toString(16))
    .join('');
}

const activeMechanismIds = Object.freeze([
  'W3K-001',
  'W3K-061',
  'W3K-077',
  'W3K-087',
  'W3K-100',
]);
const wave3Kernel = Object.freeze({
  activationBitset: activationBitset(activeMechanismIds),
  manifestHash: '1'.repeat(64),
  worksetHash: '2'.repeat(64),
  activeMechanismIds,
});

afterEach(() => {
  while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true });
});

describe('Party Line Wave 3 kernel propagation', () => {
  test('carries a nested order summary through the hash-chained disk event and every projection', async () => {
    const filePath = fixture();
    const written = await appendPartyLineEvent({
      actor: { id: 'orangebrain', kind: 'system' },
      eventType: 'order',
      summary: 'Accepted Wave 3 governed order',
      correlationId: 'order:wave3-propagation',
      detail: { order: { wave3Kernel } },
    }, { filePath, now: '2026-08-28T12:00:00.000Z' });

    expect(written.event.wave3Kernel).toEqual(wave3Kernel);
    for (const detail of ['quiet', 'normal', 'deep', 'wire']) {
      const page = await readPartyLine({ filePath, detail });
      expect(page.chain).toEqual({ ok: true, checked: 1, errors: [] });
      expect(page.events[0].wave3Kernel).toEqual(wave3Kernel);
    }
  });

  test('canonicalizes aliases and refuses an active-ID/bitset mismatch', () => {
    expect(normalizeWave3KernelSummary({
      activation_bitset: wave3Kernel.activationBitset.toUpperCase(),
      manifest_hash: wave3Kernel.manifestHash.toUpperCase(),
      workset_hash: wave3Kernel.worksetHash.toUpperCase(),
      active_ids: [...activeMechanismIds].reverse(),
    })).toEqual(wave3Kernel);

    expect(() => normalizeWave3KernelSummary({
      ...wave3Kernel,
      activeMechanismIds: activeMechanismIds.slice(0, -1),
    })).toThrow('activationBitset does not match activeMechanismIds');
  });
});
