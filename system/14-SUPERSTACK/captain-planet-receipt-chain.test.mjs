import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, test } from 'bun:test';

const receiptRoot = path.join(import.meta.dirname, 'receipts');
const indexPath = path.join(receiptRoot, 'json-receipt-chain.jsonl');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

describe('Captain Planet local receipt chain', () => {
  test('every indexed board receipt retains chain and file-hash continuity', () => {
    const rows = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    expect(rows.length).toBeGreaterThan(0);
    let prior = 'GENESIS';
    for (const row of rows) {
      const payload = {
        schema: row.schema,
        file: row.file,
        file_sha256: row.file_sha256,
        prior_chain_hash: row.prior_chain_hash,
        recorded_at: row.recorded_at,
      };
      expect(row.prior_chain_hash).toBe(prior);
      expect(row.chain_hash).toBe(sha256(canonical(payload)));
      const receiptPath = path.join(receiptRoot, row.file);
      expect(fs.existsSync(receiptPath)).toBe(true);
      expect(sha256(fs.readFileSync(receiptPath))).toBe(row.file_sha256);
      prior = row.chain_hash;
    }
  });
});
