// Experiment 76 — Splay-tree dynamic shape registry
// As we encode receipts in order, maintain a splay-like dynamic dict of seen shapes.
// When a shape repeats, emit a short reference code. Splay it to the root so
// frequent shapes get the shortest codes. Compress residual with brotli.
// Hypothesis: amortized cost matches brotli's dict but with online adaptation.
// SIMPLE version: instead of a true splay tree, use a Move-To-Front (MTF) list
// over shape templates — this is the operational core of "splay to root" in a
// linear structure. Emit varint(MTF position). New shapes get appended.

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

// === build shape key: receipt with id field replaced by placeholder so id stream
// can be separated, with payload parsed for structural matching ===
function shapeKey(r) {
  const obj = { action: r.action, status: r.status, summary: r.summary };
  if (r.payload_json != null) {
    try { obj.payload = JSON.parse(r.payload_json); } catch { obj.payload_raw = r.payload_json; }
  } else obj.payload = null;
  obj.created_at = r.created_at;
  return JSON.stringify(obj);
}

const t0 = process.hrtime.bigint();

// === MTF encode ===
// dict: array of shape keys, dict[0] = most recently accessed
// For a new shape, we emit code 0xFFFFFFFF marker + index into a separate "new shapes" stream.
// To keep it really simple: just emit varint position. New shapes get position = dict.length and the literal shape is recorded.
const dict = []; // ordered list, dict[0] = most recent
const positions = []; // per receipt: varint position (or dict.length for new)
const newShapes = []; // shape strings, in order they first appeared

for (let i = 0; i < N; i++) {
  const k = shapeKey(detReceipts[i]);
  const idx = dict.indexOf(k);
  if (idx === -1) {
    // new shape: position = current dict.length (a "sentinel" that means new)
    positions.push(dict.length);
    newShapes.push(k);
    dict.unshift(k);  // becomes most recent
  } else {
    positions.push(idx);
    // splay-to-root: move to front
    dict.splice(idx, 1);
    dict.unshift(k);
  }
}

const positionBytes = Buffer.from(positions.flatMap(varintU));
const positionBr = brotli11(positionBytes);
const newShapesStream = newShapes.join('\n') + '\n';
const newShapesBr = brotli11(Buffer.from(newShapesStream, 'utf8'));

const t1 = process.hrtime.bigint();
const encodeMs = Number(t1 - t0) / 1e6;

const total = positionBr.length + newShapesBr.length;
const ratio = detBytes.length / total;

// === roundtrip ===
const td0 = process.hrtime.bigint();
const posBack = (() => {
  const buf = zlib.brotliDecompressSync(positionBr);
  const out = [];
  let o = 0;
  while (o < buf.length) { const [v, n] = readVarintU(buf, o); out.push(v); o = n; }
  return out;
})();
const newShapesBack = zlib.brotliDecompressSync(newShapesBr).toString('utf8').split('\n').filter(Boolean);

const dict2 = [];
let newIdx = 0;
const recShapes = [];
for (let i = 0; i < N; i++) {
  const p = posBack[i];
  if (p === dict2.length) {
    // new shape
    const k = newShapesBack[newIdx++];
    recShapes.push(k);
    dict2.unshift(k);
  } else {
    const k = dict2[p];
    recShapes.push(k);
    dict2.splice(p, 1);
    dict2.unshift(k);
  }
}

// reconstruct each receipt
const reconstructed = recShapes.map((sk, i) => {
  const shape = JSON.parse(sk);
  const id = detId(SEED, i);
  let payload_json;
  if ('payload' in shape) payload_json = shape.payload === null ? null : JSON.stringify(shape.payload);
  else payload_json = shape.payload_raw;
  return { id, action: shape.action, status: shape.status, summary: shape.summary, payload_json, created_at: shape.created_at };
});
const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const td1 = process.hrtime.bigint();
const decodeMs = Number(td1 - td0) / 1e6;

const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;

console.log(`=== EXP 76: Splay/MTF dynamic shape registry ===`);
console.log(`N receipts:        ${N}`);
console.log(`Unique shapes:     ${newShapes.length}`);
console.log(`Det bytes:         ${detBytes.length}`);
console.log(`Position stream:   ${positionBr.length}`);
console.log(`New shape stream:  ${newShapesBr.length}`);
console.log(`TOTAL:             ${total}`);
console.log(`Ratio:             ${ratio.toFixed(3)}x`);
console.log(`vs M19 47.071:     ${(ratio - 47.071).toFixed(3)}`);
console.log(`encode_ms:         ${encodeMs.toFixed(1)}`);
console.log(`decode_ms:         ${decodeMs.toFixed(1)}`);
console.log(`Roundtrip:         ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);

const summary = {
  experiment: '76-splay-tree-shapes',
  N,
  unique_shapes: newShapes.length,
  det_bytes: detBytes.length,
  position_brotli_bytes: positionBr.length,
  new_shape_brotli_bytes: newShapesBr.length,
  total,
  ratio: Number(ratio.toFixed(3)),
  delta_vs_m19: Number((ratio - 47.071).toFixed(3)),
  encode_ms: Number(encodeMs.toFixed(1)),
  decode_ms: Number(decodeMs.toFixed(1)),
  lossless,
  note: 'MTF-list implementation of "splay to root" — simple linear version of the spec',
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
