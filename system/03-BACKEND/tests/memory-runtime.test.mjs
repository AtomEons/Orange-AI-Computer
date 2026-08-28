import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFluxTail, verifyChainStream } from '../../06-ORANGELLM/memory/ae-cobra/flux/reader.mjs';
import { persistMemoryRecord, recordContradictionDebt } from '../memory-runtime.mjs';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-memory-runtime-'));
  roots.push(root);
  return root;
}

describe('OrangeFive canonical memory runtime', () => {
  test('persists source citations in the compact projected summary', () => {
    const root = fixture();
    const written = persistMemoryRecord({
      lane: 'reality', kind: 'decision_receipt', memory_id: 'citation-case',
      summary: 'operator chose the measured route',
      source_pointers: [{
        kind: 'receipt', path: '10-RECEIPTS/orange5-build/proof.json', sha256: 'a'.repeat(64), offset: 17, line: 24, end_line: 26,
      }],
    }, { fluxRoot: root });
    expect(written.body.summary).toContain('source_path=10-RECEIPTS/orange5-build/proof.json');
    expect(written.body.summary).toContain(`source_sha256=${'a'.repeat(64)}`);
    expect(written.body.summary).toContain('source_offset=17');
    expect(readFluxTail({ fluxRoot: root, maxRecords: 10 })[0].body.source_pointers[0]).toMatchObject({ line: 24, end_line: 26 });
    expect(verifyChainStream({ fluxRoot: root, lane: 'reality' }).ok).toBe(true);
  });

  test('appends a contradiction resolution while deduping the same lifecycle revision', () => {
    const root = fixture();
    const open = recordContradictionDebt({
      debt_id: 'route-conflict', reason: 'old prose conflicts with a current receipt',
    }, { fluxRoot: root });
    const repeatedOpen = recordContradictionDebt({
      debt_id: 'route-conflict', reason: 'old prose conflicts with a current receipt',
    }, { fluxRoot: root });
    const resolved = recordContradictionDebt({
      debt_id: 'route-conflict', status: 'resolved', reason: 'old prose conflicts with a current receipt',
      resolution: 'fresh receipt wins',
    }, { fluxRoot: root });

    expect(open.lane).toBe('thought');
    expect(repeatedOpen.deduped).toBe(true);
    expect(resolved.deduped).toBe(false);
    expect(resolved.lane).toBe('reality');
    expect(resolved.body.summary).toContain('debt_status=resolved');
    expect(resolved.memory_id).not.toBe(open.memory_id);
    expect(readFluxTail({ fluxRoot: root, maxRecords: 10 })).toHaveLength(2);
  });

  test('a resolution implies resolved state even for a maximum-length debt id', () => {
    const root = fixture();
    const debtId = `debt-${'x'.repeat(155)}`;
    const open = recordContradictionDebt({ debt_id: debtId, debt_type: 'execution_failure', reason: 'claims disagree' }, { fluxRoot: root });
    const resolved = recordContradictionDebt({ debt_id: debtId, reason: 'claims disagree', resolution: 'new receipt wins' }, { fluxRoot: root });
    expect(open.body.debts[0].debt_type).toBe('memory_contradiction');
    expect(resolved.body.debts[0].status).toBe('resolved');
    expect(resolved.memory_id).not.toBe(open.memory_id);
    expect(resolved.memory_id.length).toBeLessThanOrEqual(160);
  });
});
