// Experiment 72 — Token-merge field-name compaction
// Build a global field-name table from the corpus, rewrite every receipt with short
// names, compress with brotli q11, store the table in a header. Hypothesis: brotli
// already finds this via LZ77, so the gain may be small or negative.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// === gather field names by frequency ===
const fieldCounts = new Map();
function walk(obj) {
  if (obj === null || typeof obj !== 'object') return;
  for (const k of Object.keys(obj)) {
    fieldCounts.set(k, (fieldCounts.get(k) || 0) + 1);
    walk(obj[k]);
  }
}
for (const r of detReceipts) {
  walk(r);
  if (r.payload_json != null) {
    try { walk(JSON.parse(r.payload_json)); } catch {}
  }
}

// Sort by descending freq, assign short codes (1-2 chars max). Reserve single ASCII
// letters first (a..z), then aa..zz. Use only chars that won't collide with JSON syntax.
const sorted = [...fieldCounts.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k);
const codeAlphabet = 'abcdefghijklmnopqrstuvwxyz';
function codeFor(i) {
  if (i < 26) return codeAlphabet[i];
  const a = Math.floor(i / 26) - 1;
  const b = i % 26;
  return codeAlphabet[a] + codeAlphabet[b];
}
const fieldToCode = new Map();
sorted.forEach((k, i) => fieldToCode.set(k, codeFor(i)));
const codeToField = new Map([...fieldToCode].map(([k, v]) => [v, k]));

function remapKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(remapKeys);
  const out = {};
  for (const k of Object.keys(obj)) out[fieldToCode.get(k)] = remapKeys(obj[k]);
  return out;
}

// Rewrite every receipt, also re-encode payload_json (still as a string field, but
// with remapped keys inside).
const remapped = detReceipts.map(r => {
  const obj = {};
  for (const k of Object.keys(r)) {
    if (k === 'payload_json' && r[k] != null) {
      try {
        const inner = JSON.parse(r[k]);
        obj[fieldToCode.get(k)] = JSON.stringify(remapKeys(inner));
      } catch {
        obj[fieldToCode.get(k)] = r[k];
      }
    } else {
      obj[fieldToCode.get(k)] = r[k];
    }
  }
  return obj;
});
const remappedJsonl = remapped.map(r => JSON.stringify(r)).join('\n') + '\n';
const remappedBytes = Buffer.from(remappedJsonl, 'utf8');

// === header: list field names in code order, separated by \x02 ===
const headerStr = sorted.join('\x02');
const headerBytes = Buffer.from(headerStr, 'utf8');
const headerLen = Buffer.alloc(2);
headerLen.writeUInt16BE(headerBytes.length, 0);

// Compress remapped stream + uncompressed header
const t0 = process.hrtime.bigint();
const dataBr = brotli11(remappedBytes);
const t1 = process.hrtime.bigint();
const encodeMs = Number(t1 - t0) / 1e6;

const total = headerLen.length + headerBytes.length + dataBr.length;
const ratio = detBytes.length / total;

// === roundtrip ===
const td0 = process.hrtime.bigint();
const dataBack = zlib.brotliDecompressSync(dataBr).toString('utf8');
// header is uncompressed, so it's "free" — we just need to use it to reverse the keys
const remappedReceipts = dataBack.split('\n').filter(Boolean).map(l => JSON.parse(l));
function unmapKeys(obj) {
  if (obj === null || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(unmapKeys);
  const out = {};
  for (const k of Object.keys(obj)) out[codeToField.get(k)] = unmapKeys(obj[k]);
  return out;
}
const reconstructed = remappedReceipts.map(r => {
  const obj = {};
  for (const k of Object.keys(r)) {
    const longK = codeToField.get(k);
    if (longK === 'payload_json' && r[k] != null) {
      try {
        const inner = JSON.parse(r[k]);
        obj[longK] = JSON.stringify(unmapKeys(inner));
      } catch { obj[longK] = r[k]; }
    } else obj[longK] = r[k];
  }
  // canonical key order: id, action, status, summary, payload_json, created_at
  return { id: obj.id, action: obj.action, status: obj.status, summary: obj.summary, payload_json: obj.payload_json, created_at: obj.created_at };
});
const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const td1 = process.hrtime.bigint();
const decodeMs = Number(td1 - td0) / 1e6;

const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;

console.log(`=== EXP 72: Token-merge field-name compaction ===`);
console.log(`N receipts:    ${N}`);
console.log(`Unique fields: ${sorted.length}`);
console.log(`Top fields:    ${sorted.slice(0, 10).join(', ')}`);
console.log(`Det bytes:     ${detBytes.length}`);
console.log(`Remapped raw:  ${remappedBytes.length}  (delta ${remappedBytes.length - detBytes.length})`);
console.log(`Header:        ${headerLen.length + headerBytes.length}`);
console.log(`Data (br11):   ${dataBr.length}`);
console.log(`TOTAL:         ${total}`);
console.log(`Ratio:         ${ratio.toFixed(3)}x`);
console.log(`vs M19 47.071: ${(ratio - 47.071).toFixed(3)}`);
console.log(`encode_ms:     ${encodeMs.toFixed(1)}`);
console.log(`decode_ms:     ${decodeMs.toFixed(1)}`);
console.log(`Roundtrip:     ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);

const summary = {
  experiment: '72-token-merge',
  N,
  unique_fields: sorted.length,
  det_bytes: detBytes.length,
  total,
  ratio: Number(ratio.toFixed(3)),
  delta_vs_m19: Number((ratio - 47.071).toFixed(3)),
  encode_ms: Number(encodeMs.toFixed(1)),
  decode_ms: Number(decodeMs.toFixed(1)),
  lossless,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
