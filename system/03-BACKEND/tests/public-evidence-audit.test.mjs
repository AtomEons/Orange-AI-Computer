import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  auditEvidenceDocuments,
  extractEvidenceReferences,
} from '../public-evidence-audit.mjs';

const temporaryRoots = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'orange-public-evidence-'));
  temporaryRoots.push(root);
  return root;
}

describe('public evidence audit', () => {
  test('extracts local evidence links and code literals without URLs', () => {
    const references = extractEvidenceReferences([
      '[receipt](proof/run.json)',
      '`10-RECEIPTS/orange5-build/run.json`',
      '[external](https://example.test/run.json)',
    ].join('\n'));

    expect(references).toEqual([
      '10-RECEIPTS/orange5-build/run.json',
      'proof/run.json',
    ]);
  });

  test('fails closed when a cited receipt is missing', () => {
    const root = fixture();
    const ledger = join(root, 'LEDGER.md');
    writeFileSync(ledger, '[missing](missing.json)\n', 'utf8');

    const report = auditEvidenceDocuments([ledger]);
    expect(report.ok).toBe(false);
    expect(report.checkedReferences).toBe(1);
    expect(report.missing).toHaveLength(1);
  });

  test('passes when every cited evidence file exists', () => {
    const root = fixture();
    const ledger = join(root, 'LEDGER.md');
    const receipt = join(root, 'receipt.json');
    writeFileSync(receipt, '{}\n', 'utf8');
    writeFileSync(ledger, '[receipt](receipt.json)\n', 'utf8');

    const report = auditEvidenceDocuments([ledger]);
    expect(report.ok).toBe(true);
    expect(report.checkedReferences).toBe(1);
    expect(report.missing).toHaveLength(0);
  });
});
