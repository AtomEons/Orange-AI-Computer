#!/usr/bin/env bun
// Repairs only the known partition-order failure: a suffix appended to an
// earlier day after a later day already existed. Record bytes/hashes are moved,
// never regenerated; originals are backed up before either file is changed.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { canonicalFluxRoot } from './paths.mjs';
import { verifyChain, _internal } from './flux/writer.mjs';
import { writeChainedJsonReceipt } from '../../../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const fluxRoot = canonicalFluxRoot();
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const receiptDir = path.join(ROOT, '10-RECEIPTS', 'orange5-build');
const backupDir = path.join(receiptDir, 'ledger-repair-backups', stamp);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function readFileRecords(file) {
  const raw = fs.readFileSync(file, 'utf8');
  if (raw && !raw.endsWith('\n')) throw new Error(`torn file refused: ${file}`);
  return raw.split(/\r?\n/).filter(Boolean).map((line) => ({ line, record: JSON.parse(line) }));
}

function verifySequence(records, expected) {
  let tail = expected;
  for (const { record } of records) {
    if (record.prev_hash !== tail || !_internal.recordHashValid(record)) return { ok: false, tail };
    tail = record.hash;
  }
  return { ok: true, tail };
}

function repairLane(lane) {
  const dir = path.join(fluxRoot, 'events', lane);
  if (!fs.existsSync(dir)) return { lane, moved: 0, status: 'EMPTY' };
  const files = fs.readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name)).sort();
  let expected = 'GENESIS';
  for (let fileIndex = 0; fileIndex < files.length; fileIndex++) {
    const file = path.join(dir, files[fileIndex]);
    const rows = readFileRecords(file);
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
      const rec = rows[rowIndex].record;
      if (rec.prev_hash === expected && _internal.recordHashValid(rec)) {
        expected = rec.hash;
        continue;
      }
      if (fileIndex >= files.length - 1) throw new Error(`${lane}: non-partition corruption in latest file`);

      const laterRows = files.slice(fileIndex + 1).flatMap((name) => readFileRecords(path.join(dir, name)));
      const later = verifySequence(laterRows, expected);
      if (!later.ok) throw new Error(`${lane}: later partition is not a valid continuation`);
      const suffix = rows.slice(rowIndex);
      const suffixCheck = verifySequence(suffix, later.tail);
      if (!suffixCheck.ok) throw new Error(`${lane}: misplaced suffix is not a valid continuation of later partitions`);

      const destination = path.join(dir, files.at(-1));
      fs.mkdirSync(path.join(backupDir, lane), { recursive: true });
      const sourceBefore = fs.readFileSync(file);
      const destinationBefore = fs.readFileSync(destination);
      fs.copyFileSync(file, path.join(backupDir, lane, path.basename(file)));
      fs.copyFileSync(destination, path.join(backupDir, lane, path.basename(destination)));
      fs.writeFileSync(file, rows.slice(0, rowIndex).map((row) => row.line).join('\n') + (rowIndex ? '\n' : ''));
      fs.appendFileSync(destination, suffix.map((row) => row.line).join('\n') + '\n');

      return {
        lane,
        status: 'REPAIRED',
        moved: suffix.length,
        source: file,
        destination,
        moved_hashes: suffix.map((row) => row.record.hash),
        source_before_sha256: sha256(sourceBefore),
        destination_before_sha256: sha256(destinationBefore),
        source_after_sha256: sha256(fs.readFileSync(file)),
        destination_after_sha256: sha256(fs.readFileSync(destination)),
      };
    }
  }
  return { lane, moved: 0, status: 'ALREADY_ORDERED' };
}

const repairs = ['reality', 'thought', 'merge'].map(repairLane);
const chains = Object.fromEntries(['reality', 'thought', 'merge'].map((lane) => [lane, verifyChain({ lane, fluxRoot })]));
const ok = Object.values(chains).every((chain) => chain.ok);
const receipt = {
  schema: 'orange5.cobra.partition-order-repair.v1',
  status: ok ? 'VERIFIED' : 'NEEDS_ATTENTION',
  generated_at: new Date().toISOString(),
  flux_root: fluxRoot,
  repair_reason: 'UTC and America/New_York partition writers overlapped after a later UTC partition existed',
  record_content_preserved: true,
  backups: backupDir,
  repairs,
  chains,
};
fs.mkdirSync(receiptDir, { recursive: true });
const receiptPath = path.join(receiptDir, `${stamp}-cobra-partition-order-repair.json`);
const chainedReceipt = writeChainedJsonReceipt(receiptPath, receipt);
console.log(JSON.stringify({ ...chainedReceipt, receiptPath }, null, 2));
if (!ok) process.exitCode = 1;
