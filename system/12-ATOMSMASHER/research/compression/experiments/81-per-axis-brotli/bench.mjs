// Experiment 81 — Per-axis tensor stream codec
// Hypothesis: the receipt corpus is a 4-tensor T[i action × j field × k sequence × l instance].
// Brotli walks a 1D byte stream and misses axis-specific redundancy.
// Test: split the corpus into per-axis projection streams, brotli q11 each
// INDEPENDENTLY, then concat with a header. Report compressed bytes vs
// raw->brotli and vs the M19 champion (47.07×).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

// ── helpers ───────────────────────────────────────────────────────────────
const SEED = 'orange5-receipt-stream-v1';
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

// ── load corpus, build deterministic baseline (same as M19) ───────────────
const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const BYTES_RAW = detBytes.length;
const detSha = sha256(detBytes);

// ── BASELINE 1: raw -> brotli q11 (the dumb baseline) ─────────────────────
const t0_baseB = process.hrtime.bigint();
const baselineBrotli = brotli11(detBytes);
const t1_baseB = process.hrtime.bigint();
const t0_baseD = process.hrtime.bigint();
const baselineBrotliDec = zlib.brotliDecompressSync(baselineBrotli);
const t1_baseD = process.hrtime.bigint();
const baselineRoundtrip = sha256(baselineBrotliDec) === detSha;
const baselineBytes = baselineBrotli.length;
const baselineRatio = BYTES_RAW / baselineBytes;

// ── EXPERIMENT: per-axis projection streams ───────────────────────────────
// Top-level receipt schema is fixed: { id, action, status, summary, payload_json, created_at }.
// `payload_json` is itself nested JSON whose keys vary by action. To get true
// per-FIELD streams we parse payload_json and flatten its keys into the
// projection. That gives F = (5 top-level fields excluding action which is its
// own axis) + (union of inner payload keys).

const TOP_FIELDS = ['id', 'status', 'summary', 'payload', 'created_at']; // action is its own axis
// payload is parsed from payload_json; we'll project its inner keys flatly.

const t0_encE = process.hrtime.bigint();

// 1) Action axis: 1 byte per receipt (we have ≤256 actions — verify)
const actionVocab = new Map();
const actionStream = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const a = detReceipts[i].action;
  if (!actionVocab.has(a)) actionVocab.set(a, actionVocab.size);
  actionStream[i] = actionVocab.get(a);
}
const A = actionVocab.size;
if (A > 256) throw new Error('action axis exceeds 256');

// 2) Parse payloads & discover inner-key universe
const parsedPayloads = new Array(N);
const payloadRawFallback = new Array(N); // for non-JSON payload_json
const payloadIsNull = new Uint8Array(N);
const innerKeySet = new Set();
for (let i = 0; i < N; i++) {
  const r = detReceipts[i];
  if (r.payload_json == null) { payloadIsNull[i] = 1; continue; }
  try {
    const p = JSON.parse(r.payload_json);
    if (p === null) { payloadIsNull[i] = 1; continue; }
    if (typeof p === 'object' && !Array.isArray(p)) {
      parsedPayloads[i] = p;
      for (const k of Object.keys(p)) innerKeySet.add(k);
    } else {
      // payload was JSON but not an object (number/string/array)
      payloadRawFallback[i] = r.payload_json;
    }
  } catch {
    payloadRawFallback[i] = r.payload_json;
  }
}
const innerKeys = [...innerKeySet].sort();

// All projected field names (top-level + inner) — action is excluded (its own axis)
// We keep `payload_raw` and `payload_null` as meta-fields so we can lossless-rebuild.
const FIELD_NAMES = [
  'id', 'status', 'summary', 'created_at',
  '__payload_null__', '__payload_raw__',
  ...innerKeys.map(k => 'p.' + k),
];
const F = FIELD_NAMES.length;

// 3) Field-presence bitmap: F bits per receipt, packed
const bitmapBytes = Math.ceil(F / 8);
const bitmap = new Uint8Array(N * bitmapBytes);

// 4) Field-value streams: one per field
//    For each field we accumulate "present" values in receipt order, joined by \n.
//    The bitmap tells the decoder which receipts contributed.
const fieldStreams = FIELD_NAMES.map(() => []);

function fieldIdx(name) { return FIELD_NAMES.indexOf(name); }
const F_ID = fieldIdx('id');
const F_STATUS = fieldIdx('status');
const F_SUMMARY = fieldIdx('summary');
const F_CREATED = fieldIdx('created_at');
const F_PNULL = fieldIdx('__payload_null__');
const F_PRAW = fieldIdx('__payload_raw__');
const innerFieldIdx = innerKeys.map(k => fieldIdx('p.' + k));

function setBit(rcptIdx, fieldIdxNum) {
  const ofs = rcptIdx * bitmapBytes + (fieldIdxNum >> 3);
  bitmap[ofs] |= (1 << (fieldIdxNum & 7));
}
function getBit(bm, rcptIdx, fieldIdxNum) {
  const ofs = rcptIdx * bitmapBytes + (fieldIdxNum >> 3);
  return (bm[ofs] >> (fieldIdxNum & 7)) & 1;
}

for (let i = 0; i < N; i++) {
  const r = detReceipts[i];
  // id is always present
  setBit(i, F_ID); fieldStreams[F_ID].push(r.id);
  setBit(i, F_STATUS); fieldStreams[F_STATUS].push(r.status);
  setBit(i, F_SUMMARY); fieldStreams[F_SUMMARY].push(r.summary == null ? '\0NULL\0' : r.summary);
  setBit(i, F_CREATED); fieldStreams[F_CREATED].push(r.created_at);

  if (payloadIsNull[i]) {
    setBit(i, F_PNULL); // marker: payload_json was null OR JSON null
    // distinguish "payload_json === null" vs "payload_json === 'null'" — record raw
    fieldStreams[F_PNULL].push(r.payload_json === null ? 'NULL' : 'JSONNULL');
  } else if (payloadRawFallback[i] != null) {
    setBit(i, F_PRAW); fieldStreams[F_PRAW].push(payloadRawFallback[i]);
  } else {
    const p = parsedPayloads[i];
    // record inner-key ORDER for this receipt by encoding the key-permutation
    // We need the original property order to round-trip JSON.stringify byte-exactly.
    // Strategy: per-receipt key-order stream (varint sequence of innerKey indices).
    // We store that as a separate side channel (one more brotli stream).
    for (const k of Object.keys(p)) {
      const fi = innerFieldIdx[innerKeys.indexOf(k)];
      setBit(i, fi);
      // Value must round-trip JSON.stringify exactly. We store the value as a
      // serialized JSON token (so numbers, bools, nested objects all work).
      fieldStreams[fi].push(JSON.stringify(p[k]));
    }
  }
}

// 5) Key-order side channel: for each receipt that had a parsed payload, store
//    the sequence of innerKey indices in the order they appeared. This is
//    required for byte-exact roundtrip because JSON.stringify is order-sensitive.
const keyOrderStream = [];
const hasParsed = new Uint8Array(N);
for (let i = 0; i < N; i++) {
  const p = parsedPayloads[i];
  if (p == null) continue;
  hasParsed[i] = 1;
  const keys = Object.keys(p);
  keyOrderStream.push(...varintU(keys.length));
  for (const k of keys) keyOrderStream.push(...varintU(innerKeys.indexOf(k)));
}
const keyOrderBytes = Buffer.from(keyOrderStream);

// 6) Brotli-compress each stream INDEPENDENTLY
const actionStreamBytes = Buffer.from(actionStream);
const bitmapBuf = Buffer.from(bitmap);

const actionBr = brotli11(actionStreamBytes);
const bitmapBr = brotli11(bitmapBuf);
const keyOrderBr = brotli11(keyOrderBytes);

// vocab strings (action names, inner-key names)
const actionVocabStr = [...actionVocab.keys()].join('\x02');
const innerKeysStr = innerKeys.join('\x02');
const actionVocabBr = brotli11(Buffer.from(actionVocabStr, 'utf8'));
const innerKeysBr = brotli11(Buffer.from(innerKeysStr, 'utf8'));

// Per-field value streams
const fieldStreamBytes = fieldStreams.map(s => Buffer.from(s.join('\n') + (s.length ? '\n' : ''), 'utf8'));
const fieldStreamBr = fieldStreamBytes.map(brotli11);

// 7) Header: small int array with the length of each compressed stream
//    Layout:
//      N, F, A, bitmapBytes,
//      |actionBr|, |bitmapBr|, |keyOrderBr|, |actionVocabBr|, |innerKeysBr|,
//      for each field i in 0..F-1: |fieldStreamBr[i]|
const headerInts = [
  N, F, A, bitmapBytes,
  actionBr.length, bitmapBr.length, keyOrderBr.length, actionVocabBr.length, innerKeysBr.length,
  ...fieldStreamBr.map(b => b.length),
];
const headerVarint = [];
for (const n of headerInts) headerVarint.push(...varintU(n));
const headerBuf = Buffer.from(headerVarint);

const totalBuf = Buffer.concat([
  headerBuf,
  actionBr,
  bitmapBr,
  keyOrderBr,
  actionVocabBr,
  innerKeysBr,
  ...fieldStreamBr,
]);

const t1_encE = process.hrtime.bigint();
const perAxisBytes = totalBuf.length;
const perAxisRatio = BYTES_RAW / perAxisBytes;

// ── DECODE & ROUNDTRIP ────────────────────────────────────────────────────
const t0_decE = process.hrtime.bigint();

// parse header
let ofs = 0;
function readV() { const [v, n] = readVarintU(totalBuf, ofs); ofs = n; return v; }
const dN = readV(), dF = readV(), dA = readV(), dBitmapBytes = readV();
const lenAction = readV(), lenBitmap = readV(), lenKeyOrder = readV(), lenAVocab = readV(), lenIKeys = readV();
const lenFields = [];
for (let i = 0; i < dF; i++) lenFields.push(readV());

function slice(len) { const b = totalBuf.subarray(ofs, ofs + len); ofs += len; return b; }
const actionBrDec = slice(lenAction);
const bitmapBrDec = slice(lenBitmap);
const keyOrderBrDec = slice(lenKeyOrder);
const aVocabBrDec = slice(lenAVocab);
const iKeysBrDec = slice(lenIKeys);
const fieldBrDec = lenFields.map(slice);

const actionStreamDec = zlib.brotliDecompressSync(actionBrDec);
const bitmapDec = zlib.brotliDecompressSync(bitmapBrDec);
const keyOrderDec = zlib.brotliDecompressSync(keyOrderBrDec);
const actionVocabDec = zlib.brotliDecompressSync(aVocabBrDec).toString('utf8').split('\x02');
const innerKeysDec = zlib.brotliDecompressSync(iKeysBrDec).toString('utf8').split('\x02');
const fieldStreamsDec = fieldBrDec.map(b => {
  if (b.length === 0) return [];
  const s = zlib.brotliDecompressSync(b).toString('utf8');
  if (s === '') return [];
  // strip trailing \n then split
  const trimmed = s.endsWith('\n') ? s.slice(0, -1) : s;
  return trimmed.split('\n');
});

// reconstruct
const fieldCursors = new Array(dF).fill(0);
let keyOrderOfs = 0;
function readKO() { const [v, n] = readVarintU(keyOrderDec, keyOrderOfs); keyOrderOfs = n; return v; }

const FIELD_NAMES_DEC = [
  'id', 'status', 'summary', 'created_at',
  '__payload_null__', '__payload_raw__',
  ...innerKeysDec.map(k => 'p.' + k),
];
const F_ID_D = FIELD_NAMES_DEC.indexOf('id');
const F_STATUS_D = FIELD_NAMES_DEC.indexOf('status');
const F_SUMMARY_D = FIELD_NAMES_DEC.indexOf('summary');
const F_CREATED_D = FIELD_NAMES_DEC.indexOf('created_at');
const F_PNULL_D = FIELD_NAMES_DEC.indexOf('__payload_null__');
const F_PRAW_D = FIELD_NAMES_DEC.indexOf('__payload_raw__');

function getBitDec(rcptIdx, fieldIdxNum) {
  const ofs = rcptIdx * dBitmapBytes + (fieldIdxNum >> 3);
  return (bitmapDec[ofs] >> (fieldIdxNum & 7)) & 1;
}

const reconstructed = [];
for (let i = 0; i < dN; i++) {
  const action = actionVocabDec[actionStreamDec[i]];
  const id = fieldStreamsDec[F_ID_D][fieldCursors[F_ID_D]++];
  const status = fieldStreamsDec[F_STATUS_D][fieldCursors[F_STATUS_D]++];
  const summaryRaw = fieldStreamsDec[F_SUMMARY_D][fieldCursors[F_SUMMARY_D]++];
  const summary = summaryRaw === '\0NULL\0' ? null : summaryRaw;
  const created_at = fieldStreamsDec[F_CREATED_D][fieldCursors[F_CREATED_D]++];

  let payload_json;
  if (getBitDec(i, F_PNULL_D)) {
    const marker = fieldStreamsDec[F_PNULL_D][fieldCursors[F_PNULL_D]++];
    payload_json = marker === 'NULL' ? null : 'null'; // JSON-null string vs absent
  } else if (getBitDec(i, F_PRAW_D)) {
    payload_json = fieldStreamsDec[F_PRAW_D][fieldCursors[F_PRAW_D]++];
  } else {
    // reconstruct object using key-order side channel
    const keyCount = readKO();
    const obj = {};
    for (let kk = 0; kk < keyCount; kk++) {
      const ki = readKO();
      const fname = 'p.' + innerKeysDec[ki];
      const fi = FIELD_NAMES_DEC.indexOf(fname);
      const valStr = fieldStreamsDec[fi][fieldCursors[fi]++];
      obj[innerKeysDec[ki]] = JSON.parse(valStr);
    }
    payload_json = JSON.stringify(obj);
  }

  reconstructed.push({ id, action, status, summary, payload_json, created_at });
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = sha256(Buffer.from(recJsonl, 'utf8'));
const lossless = recSha === detSha;
const t1_decE = process.hrtime.bigint();

// ── Largest axis attribution ──────────────────────────────────────────────
// Sum compressed bytes attributed to each "axis" of the encoding:
//   action, bitmap, key-order, action-vocab, inner-keys-vocab,
//   then each field stream.
const axes = [];
axes.push({ name: 'action', bytes: actionBr.length });
axes.push({ name: 'bitmap', bytes: bitmapBr.length });
axes.push({ name: 'key_order', bytes: keyOrderBr.length });
axes.push({ name: 'action_vocab', bytes: actionVocabBr.length });
axes.push({ name: 'inner_keys_vocab', bytes: innerKeysBr.length });
for (let i = 0; i < F; i++) {
  axes.push({ name: 'field:' + FIELD_NAMES[i], bytes: fieldStreamBr[i].length, raw_bytes: fieldStreamBytes[i].length, count: fieldStreams[i].length });
}
axes.sort((a, b) => b.bytes - a.bytes);
const biggest = axes[0];
const biggestPct = (biggest.bytes / perAxisBytes) * 100;

// ── M19 reference number (from prompt + summary.json on disk) ─────────────
const M19_BYTES = 44072;
const M19_RATIO = 47.07;

// ── timings ──
const ms = (a, b) => Number(b - a) / 1e6;
const encBaseMs = ms(t0_baseB, t1_baseB);
const decBaseMs = ms(t0_baseD, t1_baseD);
const encPerAxisMs = ms(t0_encE, t1_encE);
const decPerAxisMs = ms(t0_decE, t1_decE);

// ── print results ────────────────────────────────────────────────────────
console.log(`\n=== Experiment 81: Per-axis tensor stream codec ===`);
console.log(`Corpus: ${N} receipts, ${BYTES_RAW} raw bytes`);
console.log(`F=${F} fields (${TOP_FIELDS.length-1} top-level + 2 payload-meta + ${innerKeys.length} inner-keys)`);
console.log(`A=${A} actions`);
console.log(``);
console.log(`| Approach                       | Compressed bytes | Ratio   | vs M19   | Encode ms | Decode ms | Roundtrip |`);
console.log(`|--------------------------------|-----------------:|--------:|---------:|----------:|----------:|-----------|`);
console.log(`| Raw -> brotli (baseline)       | ${String(baselineBytes).padStart(16)} | ${baselineRatio.toFixed(2).padStart(6)}x | ${(baselineRatio - M19_RATIO).toFixed(2).padStart(7)} | ${encBaseMs.toFixed(0).padStart(9)} | ${decBaseMs.toFixed(0).padStart(9)} | ${baselineRoundtrip ? 'yes' : 'no'}`);
console.log(`| M19 (reference)                | ${String(M19_BYTES).padStart(16)} | ${M19_RATIO.toFixed(2).padStart(6)}x |    0.00 |       -   |       -   | yes`);
console.log(`| Per-axis streams (this)        | ${String(perAxisBytes).padStart(16)} | ${perAxisRatio.toFixed(2).padStart(6)}x | ${(perAxisRatio - M19_RATIO).toFixed(2).padStart(7)} | ${encPerAxisMs.toFixed(0).padStart(9)} | ${decPerAxisMs.toFixed(0).padStart(9)} | ${lossless ? 'yes' : 'no'}`);
console.log(``);
console.log(`biggest axis = ${biggest.name} (${biggest.bytes} bytes, ${biggestPct.toFixed(1)}% of compressed total)`);

// top 10 axes for richer picture in summary.json (not printed in table)
const top10 = axes.slice(0, 10);

// ── write summary.json ────────────────────────────────────────────────────
const summary = {
  experiment: '81-per-axis-brotli',
  corpus_bytes_raw: BYTES_RAW,
  corpus_receipts: N,
  corpus_sha256: detSha,
  baselines: {
    raw_brotli: { bytes: baselineBytes, ratio: Number(baselineRatio.toFixed(2)), encode_ms: Number(encBaseMs.toFixed(1)), decode_ms: Number(decBaseMs.toFixed(1)), roundtrip: baselineRoundtrip },
    m19_reference: { bytes: M19_BYTES, ratio: M19_RATIO, source: 'experiment 59' },
  },
  per_axis: {
    bytes: perAxisBytes,
    ratio: Number(perAxisRatio.toFixed(2)),
    delta_vs_m19: Number((perAxisRatio - M19_RATIO).toFixed(2)),
    encode_ms: Number(encPerAxisMs.toFixed(1)),
    decode_ms: Number(decPerAxisMs.toFixed(1)),
    roundtrip: lossless,
    F, A, inner_keys_count: innerKeys.length,
    bitmap_bytes_uncompressed: bitmap.length,
    bitmap_bytes_compressed: bitmapBr.length,
    header_bytes: headerBuf.length,
    biggest_axis: { name: biggest.name, bytes: biggest.bytes, pct_of_total: Number(biggestPct.toFixed(1)) },
    top_10_axes: top10,
  },
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
