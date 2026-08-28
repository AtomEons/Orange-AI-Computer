#!/usr/bin/env bun

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { writeChainedJsonReceipt } from '../10-RECEIPTS/tools/json-receipt-chain.mjs';

const ROOT = path.resolve(import.meta.dirname, '..');
const RECEIPT_ROOT = path.join(ROOT, '10-RECEIPTS', 'orange5-build', 'captain-planet');
const INDEX_NAME = 'json-receipt-chain.jsonl';
const OUTPUT = path.join(RECEIPT_ROOT, 'captain-planet-receipt-chain-proof.json');
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function chainDirectories() {
  const directories = [];
  const pending = [RECEIPT_ROOT];
  while (pending.length) {
    const current = pending.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === INDEX_NAME)) directories.push(current);
    for (const entry of entries) {
      if (entry.isDirectory()) pending.push(path.join(current, entry.name));
    }
  }
  return directories.sort();
}

export function verifyReceiptChains() {
  const findings = [];
  const directories = [];
  for (const directory of chainDirectories()) {
    const indexPath = path.join(directory, INDEX_NAME);
    const rows = fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const latestByFile = new Map();
    let prior = 'GENESIS';
    for (const [index, row] of rows.entries()) {
      const payload = {
        schema: row.schema,
        file: row.file,
        file_sha256: row.file_sha256,
        prior_chain_hash: row.prior_chain_hash,
        recorded_at: row.recorded_at,
      };
      if (row.prior_chain_hash !== prior) findings.push({ directory, row: index + 1, finding: 'prior_chain_hash_mismatch' });
      if (row.chain_hash !== sha256(canonical(payload))) findings.push({ directory, row: index + 1, finding: 'chain_hash_mismatch' });
      prior = row.chain_hash;
      latestByFile.set(row.file, row);
    }
    for (const row of latestByFile.values()) {
      const filePath = path.join(directory, row.file);
      if (!fs.existsSync(filePath)) {
        findings.push({ directory, file: row.file, finding: 'indexed_file_missing' });
      } else if (sha256(fs.readFileSync(filePath)) !== row.file_sha256) {
        findings.push({ directory, file: row.file, finding: 'current_file_hash_mismatch' });
      }
    }
    directories.push({ directory, rows: rows.length, current_files: latestByFile.size });
  }
  return { directories, findings };
}

if (import.meta.main) {
  const result = verifyReceiptChains();
  const green = result.directories.length > 0 && result.findings.length === 0;
  const receipt = {
    schema: 'orange5.captain-planet.receipt-chain-proof.v1',
    status: green ? 'CAPTAIN_PLANET_RECEIPT_CHAINS_GREEN' : 'CAPTAIN_PLANET_RECEIPT_CHAINS_NEED_WORK',
    generated_at: new Date().toISOString(),
    receipt_root: RECEIPT_ROOT,
    checked_directory_count: result.directories.length,
    checked_row_count: result.directories.reduce((sum, item) => sum + item.rows, 0),
    checked_current_file_count: result.directories.reduce((sum, item) => sum + item.current_files, 0),
    directories: result.directories,
    findings: result.findings,
  };
  const written = writeChainedJsonReceipt(OUTPUT, receipt);
  process.stdout.write(`${JSON.stringify({
    status: written.status,
    checked_directory_count: written.checked_directory_count,
    checked_row_count: written.checked_row_count,
    findings: written.findings,
    receipt_path: OUTPUT,
  }, null, 2)}\n`);
  if (!green) process.exitCode = 1;
}
