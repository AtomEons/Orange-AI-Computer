// Experiment 91 — Action-transition Markov chain prediction.
// Build P(next_action | current_action) from corpus.
// Encode each receipt's action as predict-or-surprise:
//   - 1 bit = "predicted correctly" if next action == argmax P(·|prev)
//   - else: action-id varint
// Brotli the residual + the rest (M19-style: shapes, ids, payloads).
// sha256 verify.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const M19_BASELINE = 47.07;

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

const tStart = Date.now();

// ── Build action vocab ──
const aV = new Map();
const actions = detReceipts.map(r => r.action);
for (const a of actions) if (!aV.has(a)) aV.set(a, aV.size);
const aList = [...aV.keys()];

// ── Build Markov transition table P(next | curr) ──
// Use first half of corpus to train, but for max compression, train on full corpus (still lossless, table is sent).
const trans = new Map();  // prev_id -> Map(next_id -> count)
const startCounts = new Map();  // first action distribution
for (let i = 0; i < N; i++) {
  const cur = aV.get(actions[i]);
  if (i === 0) {
    startCounts.set(cur, (startCounts.get(cur) || 0) + 1);
  } else {
    const prev = aV.get(actions[i - 1]);
    if (!trans.has(prev)) trans.set(prev, new Map());
    const m = trans.get(prev);
    m.set(cur, (m.get(cur) || 0) + 1);
  }
}

// argmax(P(·|prev)) per prev
const predicted = new Map();  // prev_id -> argmax next_id
for (const [prev, m] of trans) {
  let best = -1, bestCount = -1;
  for (const [next, c] of m) {
    if (c > bestCount) { bestCount = c; best = next; }
  }
  predicted.set(prev, best);
}
// For position 0, predict argmax of startCounts
let startBest = -1, startBestC = -1;
for (const [a, c] of startCounts) { if (c > startBestC) { startBestC = c; startBest = a; } }

// ── Encode action stream: bit per position + surprises ──
const bitFlags = []; // 1 bit each — packed below
const surprises = []; // varint of action_id when surprise
for (let i = 0; i < N; i++) {
  const cur = aV.get(actions[i]);
  const pred = i === 0 ? startBest : (predicted.get(aV.get(actions[i - 1])) ?? -1);
  if (pred === cur) bitFlags.push(1);
  else { bitFlags.push(0); surprises.push(cur); }
}
// Pack flags into bytes
const flagBytes = new Uint8Array(Math.ceil(N / 8));
for (let i = 0; i < N; i++) {
  if (bitFlags[i]) flagBytes[i >> 3] |= (1 << (i & 7));
}
const surpriseBytes = Buffer.from(surprises.flatMap(varintU));

// ── Encode actions table (vocabulary + predicted-table) ──
// We need decoder to know predicted[prev] and startBest.
// Predicted table: small (66 entries × small ids). Encode as varint stream.
const predTableList = [];
for (let p = 0; p < aList.length; p++) {
  predTableList.push(predicted.get(p) ?? 0xff);  // sentinel for unseen prev
}
const predTableBytes = Buffer.from([startBest, ...predTableList.flatMap(varintU)]);

// ── For the remaining fields (id, status, summary, payload_json, created_at): M19-style ──
// Reuse M19 logic but drop action since we've encoded it separately.
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

const otherShapes = detReceipts.map((r, i) => {
  const obj = { status: r.status, summary: r.summary };
  if (r.payload_json != null) {
    try { obj.payload = JSON.parse(r.payload_json); } catch { obj.payload_raw = r.payload_json; }
  } else obj.payload = null;
  obj.created_at = r.created_at;
  return obj;
});

const shapeVocab = new Map();
const shapeList = [];
const shapeIdx = [];
for (const r of otherShapes) {
  const k = JSON.stringify(r);
  if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
  shapeIdx.push(shapeVocab.get(k));
}

const indexed = shapeList.map((s, i) => ({ s, i }));
indexed.sort((a, b) => a.s.localeCompare(b.s));
const sortedList = indexed.map(x => x.s);
const remap = new Map();
indexed.forEach((x, ni) => remap.set(x.i, ni));
const newIdx = shapeIdx.map(i => remap.get(i));

const shapesBlob = brotli11(brotli11(Buffer.from(sortedList.join('\n') + '\n', 'utf8')));
const shapeIdxBr = brotli11(Buffer.from(newIdx.flatMap(varintU)));
const aVBr = brotli11(Buffer.from(aList.join('\x02'), 'utf8'));
const flagsBr = brotli11(Buffer.from(flagBytes));
const surpriseBr = brotli11(surpriseBytes);
const predTableBr = brotli11(predTableBytes);
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const encMs = Date.now() - tStart;
const total = shapesBlob.length + shapeIdxBr.length + aVBr.length + flagsBr.length + surpriseBr.length + predTableBr.length + seedR.length;
const ratio = detBytes.length / total;

// Track prediction accuracy
const hits = bitFlags.reduce((s, b) => s + b, 0);
const acc = hits / N;

console.log(`=== EXP 91: Action-Markov ===`);
console.log(`Actions vocab:     ${aList.length}`);
console.log(`Prediction acc:    ${(acc * 100).toFixed(2)}%`);
console.log(`flag bits:         ${flagsBr.length}`);
console.log(`surprises:         ${surpriseBr.length}`);
console.log(`pred table:        ${predTableBr.length}`);
console.log(`shapes:            ${shapesBlob.length}`);
console.log(`shape idx:         ${shapeIdxBr.length}`);
console.log(`aV:                ${aVBr.length}`);
console.log(`seed:              ${seedR.length}`);
console.log(`TOTAL:             ${total}`);
console.log(`Ratio:             ${ratio.toFixed(3)}x`);
console.log(`vs M19 (${M19_BASELINE}x): ${(ratio - M19_BASELINE).toFixed(3)}x`);

// ── Roundtrip ──
const tDecStart = Date.now();
const flagsDec = zlib.brotliDecompressSync(flagsBr);
const surpriseDec = zlib.brotliDecompressSync(surpriseBr);
const predTableDec = zlib.brotliDecompressSync(predTableBr);
const aVdec = zlib.brotliDecompressSync(aVBr).toString('utf8').split('\x02');
const shapesDec = zlib.brotliDecompressSync(zlib.brotliDecompressSync(shapesBlob)).toString('utf8').split('\n').filter(Boolean);
const shapeIdxDec = []; { const buf = zlib.brotliDecompressSync(shapeIdxBr); let o = 0; while (o < buf.length) { const [v, n] = readVarintU(buf, o); shapeIdxDec.push(v); o = n; } }
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

// Rebuild predicted table
const startBestDec = predTableDec[0];
const predDec = new Map();
{ let o = 1, p = 0; while (o < predTableDec.length) { const [v, n] = readVarintU(predTableDec, o); predDec.set(p, v); p++; o = n; } }

// Rebuild surprises
const surprisesDec = []; { let o = 0; while (o < surpriseDec.length) { const [v, n] = readVarintU(surpriseDec, o); surprisesDec.push(v); o = n; } }

// Rebuild actions
let surpriseI = 0;
const actionsDec = [];
for (let i = 0; i < N; i++) {
  const bit = (flagsDec[i >> 3] >> (i & 7)) & 1;
  let aid;
  if (bit) {
    aid = i === 0 ? startBestDec : predDec.get(aV.get(actionsDec[i - 1]));  // use prev decoded
    // wait — we need to map back to id, and we have aVdec
    aid = i === 0 ? startBestDec : predDec.get(aVdec.indexOf(actionsDec[i - 1]));
  } else {
    aid = surprisesDec[surpriseI++];
  }
  actionsDec.push(aVdec[aid]);
}

// Rebuild receipts
const reconstructed = [];
for (let i = 0; i < N; i++) {
  const shape = JSON.parse(shapesDec[shapeIdxDec[i]]);
  const id = detId(seedDec.seed, i);
  const action = actionsDec[i];
  let payload_json;
  if ('payload' in shape) payload_json = shape.payload === null ? null : JSON.stringify(shape.payload);
  else payload_json = shape.payload_raw;
  reconstructed.push({
    id, action, status: shape.status,
    summary: shape.summary, payload_json, created_at: shape.created_at
  });
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
const decMs = Date.now() - tDecStart;

console.log(`Enc ms: ${encMs}, Dec ms: ${decMs}`);
console.log(`Roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);

if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  det: ...${det.slice(Math.max(0, i - 80), i + 80)}...`);
      console.log(`  rec: ...${recJsonl.slice(Math.max(0, i - 80), i + 80)}...`);
      break;
    }
  }
}

const summary = {
  experiment: '91-action-markov',
  N,
  actions_vocab: aList.length,
  prediction_accuracy: acc,
  total_bytes: total,
  ratio: Number(ratio.toFixed(4)),
  vs_m19: Number((ratio - M19_BASELINE).toFixed(4)),
  enc_ms: encMs,
  dec_ms: decMs,
  lossless,
  raw_jsonl_bytes: detBytes.length,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
