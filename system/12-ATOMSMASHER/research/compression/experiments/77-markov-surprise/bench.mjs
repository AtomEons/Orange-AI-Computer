// Experiment 77 — Markov field-predictor + surprise-encoding
// For each field position, build a first-order Markov predictor: "the next value at
// position F is most likely the same as the previous receipt's value at position F".
// (Simplest first-order chain: previous-value-prediction.) Encode only the SURPRISE
// (a bit per field for "was predicted vs not", plus the literal value when wrong).
// Brotli the surprise stream. Hypothesis: brotli already does this via LZ77 — but
// explicit structural modeling might outperform on this corpus.

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
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// Fields in canonical order
const FIELDS = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];

const t0 = process.hrtime.bigint();

// per-field surprise streams: each stream is a sequence of "MATCH" or "LITERAL value\n"
// We pack them as 1 bit per receipt for the mask, then literals in a side stream.
// 1 bit per receipt × 6 fields × N = 6*6224 = 37344 bits = ~4670 bytes (uncomp).
const maskBits = []; // length = N*6
const literalsByField = FIELDS.map(() => []);

const prev = {};
for (let i = 0; i < N; i++) {
  const r = detReceipts[i];
  for (let f = 0; f < FIELDS.length; f++) {
    const field = FIELDS[f];
    const v = r[field] == null ? '\0NULL\0' : String(r[field]);
    if (i > 0 && prev[field] === v) {
      maskBits.push(1);
    } else {
      maskBits.push(0);
      literalsByField[f].push(v);
    }
    prev[field] = v;
  }
}

// Pack mask into bytes
const maskBytes = Buffer.alloc(Math.ceil(maskBits.length / 8));
for (let i = 0; i < maskBits.length; i++) {
  if (maskBits[i]) maskBytes[i >>> 3] |= 1 << (i & 7);
}
const maskBr = brotli11(maskBytes);

// Literal streams per field
const literalBrPerField = literalsByField.map(arr => brotli11(Buffer.from(arr.join('\x01') + '\x01', 'utf8')));
const totalLiteralBr = literalBrPerField.reduce((s, b) => s + b.length, 0);

// Header: how many literals per field (for parsing)
const headerObj = { fields: FIELDS, N, literalCounts: literalsByField.map(a => a.length) };
const headerBr = brotli11(Buffer.from(JSON.stringify(headerObj), 'utf8'));

const t1 = process.hrtime.bigint();
const encodeMs = Number(t1 - t0) / 1e6;

const total = maskBr.length + totalLiteralBr + headerBr.length;
const ratio = detBytes.length / total;

// === roundtrip ===
const td0 = process.hrtime.bigint();
const headerBack = JSON.parse(zlib.brotliDecompressSync(headerBr).toString('utf8'));
const maskBytesBack = zlib.brotliDecompressSync(maskBr);
const maskBitsBack = [];
for (let i = 0; i < headerBack.N * 6; i++) {
  maskBitsBack.push((maskBytesBack[i >>> 3] >> (i & 7)) & 1);
}
const literalsBack = literalBrPerField.map(b => {
  const s = zlib.brotliDecompressSync(b).toString('utf8');
  // trim trailing separator
  const parts = s.split('\x01');
  if (parts[parts.length - 1] === '') parts.pop();
  return parts;
});

const literalCursor = [0, 0, 0, 0, 0, 0];
const prev2 = {};
const reconstructed = [];
for (let i = 0; i < N; i++) {
  const r = {};
  for (let f = 0; f < FIELDS.length; f++) {
    const field = FIELDS[f];
    const bit = maskBitsBack[i * 6 + f];
    let v;
    if (bit === 1) v = prev2[field];
    else { v = literalsBack[f][literalCursor[f]++]; }
    if (v === '\0NULL\0') r[field] = null;
    else r[field] = v;
    prev2[field] = v;
  }
  reconstructed.push(r);
}
const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const td1 = process.hrtime.bigint();
const decodeMs = Number(td1 - td0) / 1e6;

const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;

// Stats: hit rate per field
const hitRates = FIELDS.map((_, f) => {
  const hits = literalsByField[f].length;  // misses (literals stored)
  const total_f = N;
  return ((total_f - hits) / total_f * 100).toFixed(1);
});

console.log(`=== EXP 77: Markov field-predictor + surprise-encoding ===`);
console.log(`N receipts:    ${N}`);
console.log(`Det bytes:     ${detBytes.length}`);
console.log(`Hit rates:`);
for (let f = 0; f < FIELDS.length; f++) {
  console.log(`  ${FIELDS[f].padEnd(14)} ${hitRates[f]}%  (literals: ${literalsByField[f].length})`);
}
console.log(`Mask br11:     ${maskBr.length}`);
console.log(`Literals br11: ${totalLiteralBr}  (per field: ${literalBrPerField.map(b => b.length).join(', ')})`);
console.log(`Header br11:   ${headerBr.length}`);
console.log(`TOTAL:         ${total}`);
console.log(`Ratio:         ${ratio.toFixed(3)}x`);
console.log(`vs M19 47.071: ${(ratio - 47.071).toFixed(3)}`);
console.log(`encode_ms:     ${encodeMs.toFixed(1)}`);
console.log(`decode_ms:     ${decodeMs.toFixed(1)}`);
console.log(`Roundtrip:     ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);

const summary = {
  experiment: '77-markov-surprise',
  N,
  det_bytes: detBytes.length,
  hit_rates_pct: Object.fromEntries(FIELDS.map((f, i) => [f, Number(hitRates[i])])),
  mask_brotli_bytes: maskBr.length,
  literals_brotli_bytes: totalLiteralBr,
  per_field_brotli_bytes: Object.fromEntries(FIELDS.map((f, i) => [f, literalBrPerField[i].length])),
  header_brotli_bytes: headerBr.length,
  total,
  ratio: Number(ratio.toFixed(3)),
  delta_vs_m19: Number((ratio - 47.071).toFixed(3)),
  encode_ms: Number(encodeMs.toFixed(1)),
  decode_ms: Number(decodeMs.toFixed(1)),
  lossless,
  note: 'first-order Markov: predict v[i] == v[i-1] per field; encode mismatches as literals; the most random of the five',
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
