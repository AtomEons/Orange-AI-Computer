import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { evidenceIntegrity, latestAccepted, sha256, validateSelfHash } from '../orangefive-blue-bench.mjs';

describe('OrangeFive Blue Bench evidence selection', () => {
  test('validates and rejects a tampered receipt hash', () => {
    const receipt = { schema: 'test.v1', status: 'GREEN' };
    receipt.receipt_sha256 = sha256(JSON.stringify(receipt));
    expect(validateSelfHash(receipt).valid).toBe(true);
    expect(validateSelfHash({ ...receipt, status: 'NEEDS_WORK' }).valid).toBe(false);
  });

  test('selects the latest receipt satisfying the exact predicate', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orange-blue-bench-'));
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ status: 'GREEN', cases: 5 }));
    fs.writeFileSync(path.join(dir, 'new.json'), JSON.stringify({ status: 'GREEN', cases: 1 }));
    const old = path.join(dir, 'old.json');
    fs.utimesSync(old, new Date(Date.now() - 10_000), new Date(Date.now() - 10_000));
    const selected = latestAccepted(dir, (receipt) => receipt.status === 'GREEN' && receipt.cases >= 5);
    expect(path.basename(selected.file)).toBe('old.json');
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('accepts hashless evidence but rejects an invalid applicable receipt hash', () => {
    const hashless = { receipt: { schema: 'test.v1', status: 'GREEN' } };
    const valid = structuredClone(hashless);
    valid.receipt.receipt_sha256 = sha256(JSON.stringify(valid.receipt));
    const tampered = structuredClone(valid);
    tampered.receipt.status = 'NEEDS_WORK';

    expect(evidenceIntegrity(hashless)).toBe(true);
    expect(evidenceIntegrity(valid)).toBe(true);
    expect(evidenceIntegrity(tampered)).toBe(false);
  });
});
