// G10 — Receipts are hash-chained.
//
// Walk 10-RECEIPTS/orange5-build for the most-recent 10 receipts and verify
// each (except the first) declares a prior_sha256 / prev_sha256 / chain_prev
// field. Markdown receipts may include the chain in YAML frontmatter or in a
// "Prior: <sha>" line.

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { RECEIPTS_DIR } from "../lib/paths.mjs";

const SCAN = resolve(RECEIPTS_DIR, "orange5-build");
const INDEX = join(SCAN, 'json-receipt-chain.jsonl');
const PRIOR_PATTERNS = [
  /prior_sha256\s*[:=]\s*["']?([a-f0-9]{6,64})/i,
  /prev_sha256\s*[:=]\s*["']?([a-f0-9]{6,64})/i,
  /chain_prev\s*[:=]\s*["']?([a-f0-9]{6,64})/i,
  /^Prior:\s*([a-f0-9]{6,64})/im,
  /^Prev:\s*([a-f0-9]{6,64})/im,
];

export async function run() {
  if (!existsSync(SCAN)) {
    return {
      pass: true,
      details: { note: "no receipts dir yet — chain trivially holds", path: SCAN },
    };
  }
  const files = readdirSync(SCAN)
    .filter((f) => /\.md$/i.test(f) || /\.json$/i.test(f))
    .map((f) => ({ f, full: join(SCAN, f), mtime: statSync(join(SCAN, f)).mtimeMs }))
    .sort((a, b) => a.mtime - b.mtime);
  if (files.length === 0) {
    return { pass: true, details: { note: "no receipts yet", path: SCAN } };
  }
  const last10 = files.slice(-10);
  const indexed = new Map();
  let priorChain = 'GENESIS';
  if (existsSync(INDEX)) {
    for (const line of readFileSync(INDEX, 'utf8').split(/\r?\n/).filter(Boolean)) {
      const row = JSON.parse(line);
      const payload = {
        schema: row.schema,
        file: row.file,
        file_sha256: row.file_sha256,
        prior_chain_hash: row.prior_chain_hash,
        recorded_at: row.recorded_at,
      };
      const canonical = (value) => Array.isArray(value)
        ? `[${value.map(canonical).join(',')}]`
        : value && typeof value === 'object'
          ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`
          : JSON.stringify(value);
      const expected = createHash('sha256').update(canonical(payload)).digest('hex');
      if (row.prior_chain_hash !== priorChain || row.chain_hash !== expected) {
        return { pass: false, details: { reason: 'external receipt chain broken', file: row.file } };
      }
      priorChain = row.chain_hash;
      indexed.set(row.file, row.file_sha256);
    }
  }
  const offenders = [];
  for (let i = 1; i < last10.length; i++) {
    const body = readFileSync(last10[i].full, "utf8");
    const fileHash = createHash('sha256').update(body).digest('hex');
    const externallyChained = indexed.get(last10[i].f) === fileHash;
    if (!externallyChained && !PRIOR_PATTERNS.some((re) => re.test(body))) {
      offenders.push(last10[i].full);
    }
  }
  if (offenders.length > 0) {
    return {
      pass: false,
      details: {
        reason: "receipt(s) without prior_sha256 chain",
        offenders: offenders.slice(0, 5),
        receipts_examined: last10.length,
      },
    };
  }
  return { pass: true, details: { receipts_examined: last10.length, external_chain_rows: indexed.size } };
}
