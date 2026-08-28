// Experiment 63 — Okazaki per-class brotli streams
// Group receipts by `action` field, brotli q11 each bucket independently,
// concat with length-prefix header. Hypothesis: per-class LZ77 windows stay warm.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const detJsonl = lines.join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
const N = receipts.length;

function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

// Group by action; preserve original index so we can restore order.
const buckets = new Map(); // action -> {idx[], lines[]}
for (let i = 0; i < N; i++) {
  const a = receipts[i].action;
  if (!buckets.has(a)) buckets.set(a, { idx: [], lines: [] });
  const b = buckets.get(a);
  b.idx.push(i);
  b.lines.push(lines[i]);
}

// Build a stable ordering of actions (alphabetical) so encode/decode agree.
const actionList = [...buckets.keys()].sort();
const actionToId = new Map(actionList.map((a, i) => [a, i]));

// Stream: for each receipt in original order, emit varint(bucketId).
// Encoder also writes bucket data: for each bucket in actionList order: brotli(lines joined by \n).
const orderStream = [];
for (let i = 0; i < N; i++) orderStream.push(...varintU(actionToId.get(receipts[i].action)));

const t0 = performance.now();
const bucketBlobs = [];
for (const a of actionList) {
  const b = buckets.get(a);
  const blob = brotli11(Buffer.from(b.lines.join('\n') + '\n', 'utf8'));
  bucketBlobs.push(blob);
}
const actionVocabBr = brotli11(Buffer.from(actionList.join('\x02'), 'utf8'));
const orderBr = brotli11(Buffer.from(orderStream));

// Length-prefix header: numBuckets varint, then per-bucket length varint, then concat.
const headerParts = [];
headerParts.push(...varintU(actionList.length));
for (const blob of bucketBlobs) headerParts.push(...varintU(blob.length));
const headerBuf = Buffer.from(headerParts);
const bucketsConcat = Buffer.concat(bucketBlobs);
const total = headerBuf.length + actionVocabBr.length + orderBr.length + bucketsConcat.length + 4 + 4 + 4;
// reserve 4 bytes each for actionVocabBr.length / orderBr.length / headerBuf.length
const encode_ms = performance.now() - t0;

const ratio = detBytes.length / total;

// Decode for roundtrip
const t1 = performance.now();
const aVocab = zlib.brotliDecompressSync(actionVocabBr).toString('utf8').split('\x02');
const aIdxBuf = zlib.brotliDecompressSync(orderBr);
const aIdxs = []; { let o = 0; while (o < aIdxBuf.length) { const [v, n] = readVarintU(aIdxBuf, o); aIdxs.push(v); o = n; } }
// Decode bucket blobs back to line arrays.
const bucketLineQueues = bucketBlobs.map(blob => {
  return zlib.brotliDecompressSync(blob).toString('utf8').split('\n').filter(Boolean);
});
const bucketCursor = bucketBlobs.map(() => 0);
const rec = [];
for (let i = 0; i < N; i++) {
  const bid = aIdxs[i];
  rec.push(bucketLineQueues[bid][bucketCursor[bid]++]);
}
const recJsonl = rec.join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const decode_ms = performance.now() - t1;
const lossless = recSha === detSha;

console.log(`buckets: ${actionList.length}`);
console.log(`bucket blob sum: ${bucketsConcat.length}`);
console.log(`actionVocab: ${actionVocabBr.length}`);
console.log(`order stream: ${orderBr.length}`);
console.log(`header: ${headerBuf.length}`);
console.log(`TOTAL: ${total}`);
console.log(`ratio: ${ratio.toFixed(3)}x`);
console.log(`vs M19 (47.07): ${(ratio - 47.07).toFixed(3)}`);
console.log(`roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
console.log(`encode_ms: ${encode_ms.toFixed(1)}  decode_ms: ${decode_ms.toFixed(1)}`);

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify({
  experiment: '63-okazaki-per-class',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  notes: `${actionList.length} classes, brotli q11 per bucket`
}, null, 2));
