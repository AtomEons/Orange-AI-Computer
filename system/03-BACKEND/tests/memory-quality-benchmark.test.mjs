import { afterEach, describe, expect, test } from 'bun:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeMemoryQualityReceipts } from '../memory-quality-benchmark.mjs';

const roots = [];
afterEach(() => { while (roots.length) fs.rmSync(roots.pop(), { recursive: true, force: true }); });
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');

describe('memory quality receipt evidence', () => {
  test('writes both benchmark and contradiction debt into the external receipt chain', () => {
    const receiptRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-memory-quality-receipt-'));
    roots.push(receiptRoot);
    const result = writeMemoryQualityReceipts({
      schema: 'orange5.memory-quality-benchmark.receipt.v1', status: 'MEMORY_QUALITY_GREEN',
      generated_at: '2026-08-27T12:00:00.000Z', contradiction_debt: { recorded: 1, unresolved: 0 }, results: [],
    }, [{ debt_id: 'held-out-conflict', resolved_by: 'fresh receipt' }], { receiptRoot });

    const rows = fs.readFileSync(path.join(receiptRoot, 'json-receipt-chain.jsonl'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    expect(rows).toHaveLength(2);
    expect(rows[0].prior_chain_hash).toBe('GENESIS');
    expect(rows[1].prior_chain_hash).toBe(rows[0].chain_hash);
    expect(rows[1].file_sha256).toBe(sha256(fs.readFileSync(result.receipt_path)));
    expect(result.prior_receipt).toContain('memory-contradiction-debt.json');
    expect(result.contradiction_debt.receipt_sha256).toMatch(/^[a-f0-9]{64}$/);
  });
});
