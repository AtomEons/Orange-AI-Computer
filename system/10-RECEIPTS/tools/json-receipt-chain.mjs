import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const CHAIN_FILE = 'json-receipt-chain.jsonl';

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function readIndex(receiptDir) {
  const indexPath = path.join(receiptDir, CHAIN_FILE);
  if (!fs.existsSync(indexPath)) return [];
  return fs.readFileSync(indexPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

function appendIndex(receiptDir, fileName, fileSha256) {
  const rows = readIndex(receiptDir);
  if (rows.some((row) => row.file === fileName && row.file_sha256 === fileSha256)) return false;
  const prior = rows.at(-1)?.chain_hash ?? 'GENESIS';
  const payload = {
    schema: 'orange5.receipt.external-chain.v1',
    file: fileName,
    file_sha256: fileSha256,
    prior_chain_hash: prior,
    recorded_at: new Date().toISOString(),
  };
  const row = { ...payload, chain_hash: sha256(canonical(payload)) };
  fs.appendFileSync(path.join(receiptDir, CHAIN_FILE), `${JSON.stringify(row)}\n`);
  return true;
}

function latestReceipt(receiptDir, targetPath) {
  if (!fs.existsSync(receiptDir)) return null;
  return fs.readdirSync(receiptDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(json|md)$/i.test(entry.name))
    .map((entry) => {
      const full = path.join(receiptDir, entry.name);
      return { full, name: entry.name, mtime: fs.statSync(full).mtimeMs };
    })
    .filter((entry) => path.resolve(entry.full) !== path.resolve(targetPath))
    .sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))[0] ?? null;
}

export function writeChainedJsonReceipt(targetPath, receipt) {
  const receiptDir = path.dirname(targetPath);
  fs.mkdirSync(receiptDir, { recursive: true });
  const prior = latestReceipt(receiptDir, targetPath);
  const chained = {
    ...receipt,
    prior_receipt: prior?.name ?? null,
    prior_sha256: prior ? sha256(fs.readFileSync(prior.full)) : 'GENESIS',
  };
  chained.receipt_sha256 = sha256(JSON.stringify(chained));
  const temp = `${targetPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(chained, null, 2)}\n`);
  fs.renameSync(temp, targetPath);
  appendIndex(receiptDir, path.basename(targetPath), sha256(fs.readFileSync(targetPath)));
  return chained;
}

export function backfillReceiptIndex(receiptDir) {
  fs.mkdirSync(receiptDir, { recursive: true });
  const files = fs.readdirSync(receiptDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(json|md)$/i.test(entry.name))
    .map((entry) => {
      const full = path.join(receiptDir, entry.name);
      return { name: entry.name, full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => a.mtime - b.mtime || a.name.localeCompare(b.name));
  let added = 0;
  for (const file of files) {
    if (appendIndex(receiptDir, file.name, sha256(fs.readFileSync(file.full)))) added += 1;
  }
  return { files: files.length, added, indexPath: path.join(receiptDir, CHAIN_FILE) };
}
