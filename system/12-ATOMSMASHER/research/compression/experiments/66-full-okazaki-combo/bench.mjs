// Experiment 66 — Full Okazaki combo
// Layer: 63 (per-class buckets) + B8-style sort within each class + Method 18 nested payload
// + Method 19 strip-empty-id. Kitchen-sink of all winners.
//
// Strategy:
//   1. Deterministic IDs (Method 19): id = sha256(seed||i).slice(0,16). Strip id field.
//   2. Per-receipt: parse payload_json into nested `payload` (Method 18).
//   3. Group all receipts by action (Okazaki per-class).
//   4. For each bucket: sort shapes (B8) by (length, lexicographic) — output stays original-order
//      via index stream so we can re-sort.
//   5. Within each bucket, dedupe shapes -> vocab. Compress vocab with brotli q11.
//   6. Plus position class run-lengths (mesh vs other) for ordering recovery.

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
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function bankerRound(x) { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); }
function meshRatio(raw, comp) { return bankerRound((raw / comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

// Step 1: deterministic IDs
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const t0 = performance.now();

// Step 2: split mesh vs other (mesh has special template handling, as in Method 19)
const meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// Mesh decomposition (Method 14 carry-over)
const meshSumTpls = new Set();
const meshCAs = new Map();
const meshRecData = [];
for (const i of meshIdx) {
  const r = detReceipts[i];
  const sT = templatize(r.summary);
  meshSumTpls.add(sT.tpl);
  if (!meshCAs.has(r.created_at)) meshCAs.set(r.created_at, meshCAs.size);
  const packetMatch = r.summary?.match(/^packet #(\d+):/);
  const packet_id = packetMatch ? Number(packetMatch[1]) : 0;
  let raw = 0, comp = 0;
  try { const p = JSON.parse(r.payload_json); raw = p.raw_bytes; comp = p.compressed_bytes; } catch {}
  meshRecData.push({ sTpl: sT.tpl, packet_id, raw, comp, caIdx: meshCAs.get(r.created_at) });
}
const meshSumTplList = [...meshSumTpls];
const meshSumTplMap = new Map(meshSumTplList.map((t, i) => [t, i]));
const meshTemplate = { status: detReceipts[meshIdx[0]].status, sumTpls: meshSumTplList, cas: [...meshCAs.keys()] };
const meshTplBr = brotli11(Buffer.from(JSON.stringify(meshTemplate), 'utf8'));
const meshDataBytes = [];
for (const d of meshRecData) {
  meshDataBytes.push(...varintU(meshSumTplMap.get(d.sTpl)));
  meshDataBytes.push(...varintU(d.packet_id));
  meshDataBytes.push(...varintU(d.raw));
  meshDataBytes.push(...varintU(d.comp));
  meshDataBytes.push(...varintU(d.caIdx));
}
const meshDataBr = brotli11(Buffer.from(meshDataBytes));

// Step 3-5: For non-mesh receipts — strip id, nest payload, group by action, B8-sort dedupe within each.
const otherReceipts = otherIdx.map(i => {
  const r = detReceipts[i];
  const obj = { action: r.action, status: r.status, summary: r.summary };
  if (r.payload_json != null) {
    try { obj.payload = JSON.parse(r.payload_json); } catch { obj.payload_raw = r.payload_json; }
  } else obj.payload = null;
  obj.created_at = r.created_at;
  return obj;
});

// Bucket otherReceipts by action.
const buckets = new Map();
for (let pos = 0; pos < otherReceipts.length; pos++) {
  const r = otherReceipts[pos];
  if (!buckets.has(r.action)) buckets.set(r.action, []);
  buckets.get(r.action).push({ r, pos });
}
const actionList = [...buckets.keys()].sort();
const actionToBucketId = new Map(actionList.map((a, i) => [a, i]));

// For each bucket: dedupe shapes (sans `action`, since bucketed), B8-sort by length+lex, build vocab.
// Then per receipt emit varint(shapeIdx within bucket).
const perBucketVocabBlobs = []; // brotli per bucket
const perBucketIdxBlobs = [];   // brotli per bucket
const bucketOrderInfo = [];     // per bucket: {count}
const otherShapeStream = [];    // per-position: varint(bucketId)
for (let i = 0; i < otherReceipts.length; i++) otherShapeStream.push(...varintU(actionToBucketId.get(otherReceipts[i].action)));

for (const a of actionList) {
  const entries = buckets.get(a);
  // shape = receipt without `action` (carried at bucket level)
  const shapeKey = r => { const { action, ...rest } = r; return JSON.stringify(rest); };
  // dedupe + B8 sort
  const seen = new Map();
  const shapes = [];
  for (const { r } of entries) {
    const k = shapeKey(r);
    if (!seen.has(k)) { seen.set(k, shapes.length); shapes.push(k); }
  }
  // B8: sort by (length, lex) — preserves order via remap
  const indexed = shapes.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => a.s.length - b.s.length || a.s.localeCompare(b.s));
  const sortedShapes = indexed.map(x => x.s);
  const remap = new Map();
  indexed.forEach((x, newIdx) => remap.set(x.i, newIdx));
  // Per-entry idx (post-remap)
  const idxBytes = [];
  for (const { r } of entries) idxBytes.push(...varintU(remap.get(seen.get(shapeKey(r)))));

  perBucketVocabBlobs.push(brotli11(Buffer.from(sortedShapes.join('\n') + '\n', 'utf8')));
  perBucketIdxBlobs.push(brotli11(Buffer.from(idxBytes)));
  bucketOrderInfo.push({ a, count: entries.length });
}

// Position class run-length (mesh vs other).
const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
const posRuns = [];
{ let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
  posRuns.push([prev, count]); }
const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));

// Encode bucket id stream + action vocab (alphabetical) + per-bucket data.
const actionVocabBr = brotli11(Buffer.from(actionList.join('\x02'), 'utf8'));
const otherBucketStreamBr = brotli11(Buffer.from(otherShapeStream));

const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

// Header: numBuckets + per-bucket vocab+idx lengths
const headerParts = [];
headerParts.push(...varintU(perBucketVocabBlobs.length));
for (let k = 0; k < perBucketVocabBlobs.length; k++) {
  headerParts.push(...varintU(perBucketVocabBlobs[k].length));
  headerParts.push(...varintU(perBucketIdxBlobs[k].length));
}
const headerBuf = Buffer.from(headerParts);
const bucketsConcat = Buffer.concat([...perBucketVocabBlobs, ...perBucketIdxBlobs]);

const total = meshTplBr.length + meshDataBr.length + actionVocabBr.length + otherBucketStreamBr.length
  + headerBuf.length + bucketsConcat.length + posBr.length + seedR.length;

const encode_ms = performance.now() - t0;
const ratio = detBytes.length / total;

// Decode for roundtrip.
const t1 = performance.now();
const meshTplDec = JSON.parse(zlib.brotliDecompressSync(meshTplBr).toString('utf8'));
const meshDataDec = zlib.brotliDecompressSync(meshDataBr);
const meshRecv = [];
{ let ofs = 0;
  while (ofs < meshDataDec.length) {
    const [sti, n1] = readVarintU(meshDataDec, ofs); ofs = n1;
    const [packet_id, n2] = readVarintU(meshDataDec, ofs); ofs = n2;
    const [raw, n3] = readVarintU(meshDataDec, ofs); ofs = n3;
    const [comp, n4] = readVarintU(meshDataDec, ofs); ofs = n4;
    const [ci, n5] = readVarintU(meshDataDec, ofs); ofs = n5;
    meshRecv.push({ sti, packet_id, raw, comp, ci });
  } }

const aVocab = zlib.brotliDecompressSync(actionVocabBr).toString('utf8').split('\x02');
const bucketStream = zlib.brotliDecompressSync(otherBucketStreamBr);
const otherBucketIds = []; { let o = 0; while (o < bucketStream.length) { const [v, n] = readVarintU(bucketStream, o); otherBucketIds.push(v); o = n; } }

// Decode per-bucket vocab/idx
const numBuckets = aVocab.length;
const bucketVocabs = []; // array of shape arrays
const bucketIdxs = [];   // array of idx arrays
{
  let ofs = 0;
  const [nb, no] = readVarintU(headerBuf, 0); ofs = no;
  const lens = [];
  for (let k = 0; k < nb; k++) {
    const [vl, n1] = readVarintU(headerBuf, ofs); ofs = n1;
    const [il, n2] = readVarintU(headerBuf, ofs); ofs = n2;
    lens.push({ vl, il });
  }
  let cur = 0;
  for (const { vl } of lens) {
    const blob = bucketsConcat.slice(cur, cur + vl); cur += vl;
    const v = zlib.brotliDecompressSync(blob).toString('utf8').split('\n').filter(Boolean);
    bucketVocabs.push(v);
  }
  for (const { il } of lens) {
    const blob = bucketsConcat.slice(cur, cur + il); cur += il;
    const buf = zlib.brotliDecompressSync(blob);
    const arr = []; let o = 0; while (o < buf.length) { const [val, n] = readVarintU(buf, o); arr.push(val); o = n; }
    bucketIdxs.push(arr);
  }
}

// Walk each non-mesh position: bucket id -> shape from that bucket's vocab.
const bucketCursors = new Array(numBuckets).fill(0);
const otherRestored = [];
for (let i = 0; i < otherBucketIds.length; i++) {
  const bid = otherBucketIds[i];
  const shapeIdx = bucketIdxs[bid][bucketCursors[bid]++];
  const shapeStr = bucketVocabs[bid][shapeIdx];
  const action = aVocab[bid];
  // Reconstitute with action prepended
  const obj = JSON.parse(shapeStr);
  const ordered = { action, ...obj };
  otherRestored.push(ordered);
}

const posBytes = zlib.brotliDecompressSync(posBr);
const posClass = new Uint8Array(N);
{ let o = 0, idx = 0;
  while (o < posBytes.length) { const cls = posBytes[o++]; const [cnt, no] = readVarintU(posBytes, o); o = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

const reconstructed = [];
let meshCur = 0, otherCur = 0;
for (let i = 0; i < N; i++) {
  if (posClass[i] === 1) {
    const m = meshRecv[meshCur++];
    const sumTpl = meshTplDec.sumTpls[m.sti];
    let ni = 0;
    const nums = [String(m.packet_id), String(m.raw), String(m.comp)];
    const summary = sumTpl == null || sumTpl === '\0NULL\0' ? null : sumTpl.replace(/\x01/g, () => nums[ni++]);
    const r2 = meshRatio(m.raw, m.comp);
    reconstructed.push({
      id: detId(seedDec.seed, i),
      action: 'mesh.compress',
      status: meshTplDec.status,
      summary,
      payload_json: JSON.stringify({ raw_bytes: m.raw, compressed_bytes: m.comp, ratio: r2 }),
      created_at: meshTplDec.cas[m.ci],
    });
  } else {
    const shape = otherRestored[otherCur++];
    const id = detId(seedDec.seed, i);
    let payload_json;
    if ('payload' in shape) payload_json = shape.payload === null ? null : JSON.stringify(shape.payload);
    else payload_json = shape.payload_raw;
    const ordered = {
      id, action: shape.action, status: shape.status,
      summary: shape.summary, payload_json, created_at: shape.created_at
    };
    reconstructed.push(ordered);
  }
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const decode_ms = performance.now() - t1;
const lossless = recSha === detSha;

console.log(`mesh template:   ${meshTplBr.length}`);
console.log(`mesh data:       ${meshDataBr.length}`);
console.log(`action vocab:    ${actionVocabBr.length}`);
console.log(`bucket id stream:${otherBucketStreamBr.length}`);
console.log(`header:          ${headerBuf.length}`);
console.log(`buckets concat:  ${bucketsConcat.length}`);
console.log(`pos runs:        ${posBr.length}`);
console.log(`seed:            ${seedR.length}`);
console.log(`TOTAL:           ${total}`);
console.log(`ratio: ${ratio.toFixed(3)}x`);
console.log(`vs M19 (47.07): ${(ratio - 47.07).toFixed(3)}`);
console.log(`roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
console.log(`encode_ms: ${encode_ms.toFixed(1)}  decode_ms: ${decode_ms.toFixed(1)}`);

if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`first diff byte ${i}:`);
      console.log(`  det: ${det.slice(Math.max(0,i-60), i+60)}`);
      console.log(`  rec: ${recJsonl.slice(Math.max(0,i-60), i+60)}`);
      break;
    }
  }
}

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify({
  experiment: '66-full-okazaki-combo',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  notes: `${actionList.length} action buckets, B8-sort within, nested payload, strip-id, dedupe vocab per class`
}, null, 2));
