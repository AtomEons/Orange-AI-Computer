import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backfillReceiptIndex, writeChainedJsonReceipt } from '../json-receipt-chain.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orange5-receipt-chain-'));
try {
  const firstPath = path.join(root, 'first.json');
  const secondPath = path.join(root, 'second.json');
  writeChainedJsonReceipt(firstPath, { status: 'VERIFIED' });
  const second = writeChainedJsonReceipt(secondPath, { status: 'VERIFIED' });
  assert.match(second.prior_sha256, /^[a-f0-9]{64}$/);
  const rows = fs.readFileSync(path.join(root, 'json-receipt-chain.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 2);
  assert.equal(rows[1].prior_chain_hash, rows[0].chain_hash);
  const backfill = backfillReceiptIndex(root);
  assert.equal(backfill.added, 0);
  console.log('PASS - chained JSON receipts and idempotent external index');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
