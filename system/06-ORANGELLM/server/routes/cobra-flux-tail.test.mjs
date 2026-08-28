import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import { tailLane } from './cobra.mjs';

const roots = [];

afterEach(() => {
  while (roots.length) rmSync(roots.pop(), { recursive: true, force: true });
});

function makeRoot() {
  const root = mkdtempSync(join(tmpdir(), 'orange-cobra-tail-'));
  roots.push(root);
  return root;
}

describe('Cobra Flux tail', () => {
  test('tails current daily ledgers across file boundaries and verifies prev_hash', async () => {
    const root = makeRoot();
    const lane = join(root, 'events', 'reality');
    mkdirSync(lane, { recursive: true });
    const records = [
      { ts: 1, hash: 'a', prev_hash: 'root' },
      { ts: 2, hash: 'b', prev_hash: 'a' },
      { ts: 3, hash: 'c', prev_hash: 'b' },
      { ts: 4, hash: 'd', prev_hash: 'c' },
    ];
    writeFileSync(join(lane, '2026-08-27.jsonl'), `${records.slice(0, 2).map(JSON.stringify).join('\n')}\n`);
    writeFileSync(join(lane, '2026-08-28.jsonl'), `${records.slice(2).map(JSON.stringify).join('\n')}\n`);

    const result = await tailLane(lane, 3, 'reality');

    expect(result).toMatchObject({
      present: true,
      source_type: 'daily-directory',
      returned: 3,
      chain_unbroken: true,
    });
    expect(result.files_read).toHaveLength(2);
    expect(result.entries.map((entry) => entry.parsed.ts)).toEqual([2, 3, 4]);
  });

  test('supports a legacy single-file override and prior_sha256 chain', async () => {
    const root = makeRoot();
    const file = join(root, 'thought.jsonl');
    const first = JSON.stringify({ ts: 1, value: 'first' });
    const second = JSON.stringify({
      ts: 2,
      value: 'second',
      prior_sha256: createHash('sha256').update(first).digest('hex'),
    });
    writeFileSync(file, `${first}\n${second}\n`);

    const result = await tailLane(file, 2, 'thought');

    expect(result).toMatchObject({
      present: true,
      source_type: 'file',
      returned: 2,
      chain_unbroken: true,
    });
  });

  test('surfaces malformed ledger records instead of dropping them', async () => {
    const root = makeRoot();
    const lane = join(root, 'events', 'thought');
    mkdirSync(lane, { recursive: true });
    writeFileSync(join(lane, '2026-08-28.jsonl'), '{"ts":1,"hash":"a"}\nnot-json\n');

    const result = await tailLane(lane, 2, 'thought');

    expect(result.returned).toBe(2);
    expect(result.chain_unbroken).toBe(false);
    expect(result.entries[1].error).toBe('json_parse_failed');
  });
});
