// Experiment 44 — Method 9: Method 6 with action-bucket+length-sort dictionary

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

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
function computeRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// Mesh decomp (same as Method 6)
const meshSumTpls = new Set();
const meshCAs = new Map();
const meshRecData = [];
for (const i of meshIdx) {
  const r = detReceipts[i];
  const sTpl = (r.summary || '').replace(NUM_RE, '\x01');
  const sNums = r.summary ? (r.summary.match(NUM_RE) || []) : [];
  meshSumTpls.add(sTpl);
  if (!meshCAs.has(r.created_at)) meshCAs.set(r.created_at, meshCAs.size);
  let raw = 0, comp = 0;
  try { const p = JSON.parse(r.payload_json); raw = p.raw_bytes; comp = p.compressed_bytes; } catch {}
  meshRecData.push({ sTpl, sNums, raw, comp, caIdx: meshCAs.get(r.created_at) });
}
const meshSumTplList = [...meshSumTpls];
const meshSumTplMap = new Map(meshSumTplList.map((t, i) => [t, i]));
const meshTemplate = { status: detReceipts[meshIdx[0]].status, sumTpls: meshSumTplList, cas: [...meshCAs.keys()], payloadKeys: ['raw_bytes', 'compressed_bytes', 'ratio'] };
const meshTplBytes = Buffer.from(JSON.stringify(meshTemplate), 'utf8');
const meshDataBytes = [];
for (const d of meshRecData) {
  meshDataBytes.push(...varintU(meshSumTplMap.get(d.sTpl)));
  meshDataBytes.push(...varintU(d.sNums.length));
  for (const n of d.sNums) { const nb = Buffer.from(n, 'utf8'); meshDataBytes.push(...varintU(nb.length)); for (const c of nb) meshDataBytes.push(c); }
  meshDataBytes.push(...varintU(d.raw));
  meshDataBytes.push(...varintU(d.comp));
  meshDataBytes.push(...varintU(d.caIdx));
}
const meshTplBr = brotli11(meshTplBytes);
const meshDataBr = brotli11(Buffer.from(meshDataBytes));

// Other shapes with B8 ordering: action-bucket → by-length-within
const otherReceipts = otherIdx.map(i => detReceipts[i]);
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const unsortedShapeVocab = new Map();
const unsortedShapeList = [];
for (const r of otherReceipts) {
  const k = shapeKey(r);
  if (!unsortedShapeVocab.has(k)) { unsortedShapeVocab.set(k, unsortedShapeList.length); unsortedShapeList.push(k); }
}

// B8: action-bucket → by-length-within → lex tiebreak
const indexedShapes = unsortedShapeList.map((s, i) => ({ s, i, parsed: JSON.parse(s) }));
indexedShapes.sort((a, b) => {
  if (a.parsed.action !== b.parsed.action) return a.parsed.action.localeCompare(b.parsed.action);
  if (a.s.length !== b.s.length) return a.s.length - b.s.length;
  return a.s.localeCompare(b.s);
});
const sortedShapeList = indexedShapes.map(x => x.s);
const sortedShapeIdx = new Map();
sortedShapeList.forEach((s, i) => sortedShapeIdx.set(s, i));

// Receipt indices in B8 order
const otherShapeIdx = otherReceipts.map(r => sortedShapeIdx.get(shapeKey(r)));

const sortedShapesBr = brotli11(Buffer.from(sortedShapeList.join('\n') + '\n', 'utf8'));
const otherShapeIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));
console.log(`Sorted shapes (B8): ${sortedShapesBr.length} B`);
console.log(`Other shape idx:    ${otherShapeIdxBr.length} B`);

// Position class RLE
const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
const posRuns = [];
{
  let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) {
    if (positionClass[i] === prev) count++;
    else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; }
  }
  posRuns.push([prev, count]);
}
const posBytes = Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)]));
const posBr = brotli11(posBytes);

const seedR = brotli11(Buffer.from(JSON.stringify({seed: SEED, n: N}), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + sortedShapesBr.length + otherShapeIdxBr.length + posBr.length + seedR.length;
const ratio = detBytes.length / total;
console.log(`\n=== METHOD 9: action-bucket+length sort ===`);
console.log(`mesh template:        ${meshTplBr.length}`);
console.log(`mesh data:            ${meshDataBr.length}`);
console.log(`B8-sorted shapes:     ${sortedShapesBr.length}`);
console.log(`other shape idx:      ${otherShapeIdxBr.length}`);
console.log(`position runs:        ${posBr.length}`);
console.log(`seed:                 ${seedR.length}`);
console.log(`TOTAL:                ${total} B`);
console.log(`Ratio:                ${ratio.toFixed(2)}x`);
console.log(`vs Method 8 (41.43x): ${ratio > 41.43 ? `BEATS by +${(ratio-41.43).toFixed(2)}x` : `below by ${(41.43-ratio).toFixed(2)}x`}`);

// ── ROUNDTRIP ──
const meshTplDec = JSON.parse(zlib.brotliDecompressSync(meshTplBr).toString('utf8'));
const meshDataDec = zlib.brotliDecompressSync(meshDataBr);
const sortedShapesDec = zlib.brotliDecompressSync(sortedShapesBr).toString('utf8').split('\n').filter(Boolean);
const otherShapeIdxBuf = Buffer.from(otherShapeIdx.flatMap(varintU));
const otherShapeIdxDec = (() => { const r = []; let o = 0; while (o < otherShapeIdxBuf.length) { const [v, n] = readVarintU(otherShapeIdxBuf, o); r.push(v); o = n; } return r; })();
const posBytesDec = zlib.brotliDecompressSync(posBr);
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

const posClass = new Uint8Array(N);
{ let ofs = 0, idx = 0; while (ofs < posBytesDec.length) { const cls = posBytesDec[ofs++]; const [cnt, no] = readVarintU(posBytesDec, ofs); ofs = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

const meshRecv = [];
{ let ofs = 0;
  for (let j = 0; j < meshIdx.length; j++) {
    const [sti, n1] = readVarintU(meshDataDec, ofs); ofs = n1;
    const [snc, n2] = readVarintU(meshDataDec, ofs); ofs = n2;
    const sNums = [];
    for (let k = 0; k < snc; k++) { const [sl, n3] = readVarintU(meshDataDec, ofs); ofs = n3; sNums.push(meshDataDec.slice(ofs, ofs + sl).toString('utf8')); ofs += sl; }
    const [raw, n4] = readVarintU(meshDataDec, ofs); ofs = n4;
    const [comp, n5] = readVarintU(meshDataDec, ofs); ofs = n5;
    const [ci, n6] = readVarintU(meshDataDec, ofs); ofs = n6;
    meshRecv.push({ sti, sNums, raw, comp, ci });
  }
}

const reconstructed = [];
let meshCur = 0, otherCur = 0;
for (let i = 0; i < N; i++) {
  if (posClass[i] === 1) {
    const m = meshRecv[meshCur++];
    const sumTpl = meshTplDec.sumTpls[m.sti];
    let ni = 0;
    const summary = sumTpl == null ? null : sumTpl.replace(/\x01/g, () => m.sNums[ni++]);
    const ratio = computeRatio(m.raw, m.comp);
    reconstructed.push({ id: detId(seedDec.seed, i), action: 'mesh.compress', status: meshTplDec.status, summary, payload_json: JSON.stringify({ raw_bytes: m.raw, compressed_bytes: m.comp, ratio }), created_at: meshTplDec.cas[m.ci] });
  } else {
    const shape = JSON.parse(sortedShapesDec[otherShapeIdxDec[otherCur++]]);
    shape.id = detId(seedDec.seed, i);
    reconstructed.push(shape);
  }
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT vs det' : '✗ MISMATCH'}`);

fs.writeFileSync(RECEIPT_FILE, JSON.stringify({ experiment: '44-method9-action-length-sort', total, ratio: Number(ratio.toFixed(2)), roundtrip_lossless: lossless }, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
