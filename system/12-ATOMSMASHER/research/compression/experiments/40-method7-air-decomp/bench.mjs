// Experiment 40 — Method 7: extend hybrid to decompose air.compress too
//
// air.compress: 3126 receipts, 64 distinct ratios, atom_count=1, dropped=0,
// citations=0 always. Each receipt is: action+status+summary+payload+created_at.
// Decompose to: 1 template + ratio_idx_seq + sum_nums_seq + ca_idx_seq.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
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
console.log(`Det-ID corpus: ${detBytes.length} B`);

// Group by category
const airIdx = [], meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'air.compress') airIdx.push(i);
  else if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i);
  else otherIdx.push(i);
}
console.log(`air.compress: ${airIdx.length}, mesh.compress: ${meshIdx.length}, other: ${otherIdx.length}`);

// ── air.compress decomposition ─────────────────────────────────────────
const airSumTpls = new Set();
const airRatios = new Map();
const airCAs = new Map();
const airRecData = []; // [sumTplIdx, sumNums, ratioIdx, caIdx]
for (const i of airIdx) {
  const r = detReceipts[i];
  const sTpl = (r.summary || '').replace(NUM_RE, '\x01');
  const sNums = r.summary ? (r.summary.match(NUM_RE) || []) : [];
  airSumTpls.add(sTpl);
  let ratio = null;
  try { ratio = JSON.parse(r.payload_json).ratio; } catch {}
  if (!airRatios.has(ratio)) airRatios.set(ratio, airRatios.size);
  if (!airCAs.has(r.created_at)) airCAs.set(r.created_at, airCAs.size);
  airRecData.push({
    sTpl, sNums,
    ratioIdx: airRatios.get(ratio),
    caIdx: airCAs.get(r.created_at),
  });
}
const airSumTplList = [...airSumTpls];
const airSumTplMap = new Map(airSumTplList.map((t, i) => [t, i]));

console.log(`\nair.compress: ${airSumTpls.size} sum tpls, ${airRatios.size} ratios, ${airCAs.size} created_ats`);

// Verify air.compress payload constants
let airOk = 0;
for (const i of airIdx) {
  try {
    const p = JSON.parse(detReceipts[i].payload_json);
    if (p.atom_count === 1 && p.dropped === 0 && p.citations === 0) airOk++;
  } catch {}
}
console.log(`air.compress with (atom_count=1, dropped=0, citations=0): ${airOk}/${airIdx.length}`);

const airTemplate = {
  status: detReceipts[airIdx[0]].status,
  sumTpls: airSumTplList,
  ratios: [...airRatios.keys()],
  cas: [...airCAs.keys()],
  payloadTpl: '{"ratio":\x01,"atom_count":1,"dropped":0,"citations":0}',
};
const airTplBytes = Buffer.from(JSON.stringify(airTemplate), 'utf8');

// Air data: per receipt, [sumTplIdx, sumNums..., ratioIdx, caIdx]
const airDataBytes = [];
for (const d of airRecData) {
  airDataBytes.push(...varintU(airSumTplMap.get(d.sTpl)));
  airDataBytes.push(...varintU(d.sNums.length));
  for (const n of d.sNums) {
    const nb = Buffer.from(n, 'utf8');
    airDataBytes.push(...varintU(nb.length));
    for (const c of nb) airDataBytes.push(c);
  }
  airDataBytes.push(...varintU(d.ratioIdx));
  airDataBytes.push(...varintU(d.caIdx));
}
const airTplBr = brotli11(airTplBytes);
const airDataBr = brotli11(Buffer.from(airDataBytes));
console.log(`\nair.compress encoded: template=${airTplBr.length}B, data=${airDataBr.length}B`);

// ── mesh.compress decomposition (same as Method 6) ────────────────────
const meshRecData = [];
const meshSumTpls = new Set();
const meshCAs = new Map();
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
console.log(`mesh.compress: ${meshSumTpls.size} sum tpls, ${meshCAs.size} created_ats`);

const meshTemplate = {
  status: detReceipts[meshIdx[0]].status,
  sumTpls: meshSumTplList,
  cas: [...meshCAs.keys()],
  payloadKeys: ['raw_bytes', 'compressed_bytes', 'ratio'],
};
const meshTplBytes = Buffer.from(JSON.stringify(meshTemplate), 'utf8');

const meshDataBytes = [];
for (const d of meshRecData) {
  meshDataBytes.push(...varintU(meshSumTplMap.get(d.sTpl)));
  meshDataBytes.push(...varintU(d.sNums.length));
  for (const n of d.sNums) {
    const nb = Buffer.from(n, 'utf8');
    meshDataBytes.push(...varintU(nb.length));
    for (const c of nb) meshDataBytes.push(c);
  }
  meshDataBytes.push(...varintU(d.raw));
  meshDataBytes.push(...varintU(d.comp));
  meshDataBytes.push(...varintU(d.caIdx));
}
const meshTplBr = brotli11(meshTplBytes);
const meshDataBr = brotli11(Buffer.from(meshDataBytes));
console.log(`mesh.compress encoded: template=${meshTplBr.length}B, data=${meshDataBr.length}B`);

// ── Other receipts: full shape-dedupe ─────────────────────────────────
const otherReceipts = otherIdx.map(i => detReceipts[i]);
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const shapeVocab = new Map();
const shapeList = [];
const otherShapeIdx = [];
for (const r of otherReceipts) {
  const k = shapeKey(r);
  if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
  otherShapeIdx.push(shapeVocab.get(k));
}
console.log(`Other unique shapes: ${shapeList.length}`);
const otherShapesBr = brotli11(Buffer.from(shapeList.join('\n') + '\n', 'utf8'));
const otherIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));

// ── Position class stream: 2 bits per position (00=other, 01=air, 10=mesh) ─
// Use a varint-encoded run-length sequence instead for compactness
const positionClass = new Uint8Array(N);
for (const i of airIdx) positionClass[i] = 1;
for (const i of meshIdx) positionClass[i] = 2;
// Encode as RLE
const posRuns = [];
let prev = positionClass[0], count = 1;
for (let i = 1; i < N; i++) {
  if (positionClass[i] === prev) count++;
  else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; }
}
posRuns.push([prev, count]);
const posBytes = Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)]));
const posBr = brotli11(posBytes);
console.log(`Position runs: ${posRuns.length}, brotli ${posBr.length} B`);

// Seed
const seedR = brotli11(Buffer.from(JSON.stringify({seed: SEED, n: N}), 'utf8'));

const total = airTplBr.length + airDataBr.length + meshTplBr.length + meshDataBr.length + otherShapesBr.length + otherIdxBr.length + posBr.length + seedR.length;
const ratio = detBytes.length / total;
console.log(`\n=== METHOD 7: air-decomp + mesh-decomp + other-dedupe ===`);
console.log(`air template:    ${airTplBr.length}`);
console.log(`air data:        ${airDataBr.length}`);
console.log(`mesh template:   ${meshTplBr.length}`);
console.log(`mesh data:       ${meshDataBr.length}`);
console.log(`other shapes:    ${otherShapesBr.length}`);
console.log(`other shape idx: ${otherIdxBr.length}`);
console.log(`position runs:   ${posBr.length}`);
console.log(`seed:            ${seedR.length}`);
console.log(`TOTAL:           ${total} B`);
console.log(`Ratio:           ${ratio.toFixed(2)}x`);
console.log(`vs Method 6 (38.72x): ${ratio > 38.72 ? `BEATS by +${(ratio-38.72).toFixed(2)}x` : `below by ${(38.72-ratio).toFixed(2)}x`}`);

// ── ROUNDTRIP ──────────────────────────────────────────────────────────
const airTplDec = JSON.parse(zlib.brotliDecompressSync(airTplBr).toString('utf8'));
const meshTplDec = JSON.parse(zlib.brotliDecompressSync(meshTplBr).toString('utf8'));
const airDataDec = zlib.brotliDecompressSync(airDataBr);
const meshDataDec = zlib.brotliDecompressSync(meshDataBr);
const shapesDec = zlib.brotliDecompressSync(otherShapesBr).toString('utf8').split('\n').filter(Boolean);
const otherIdxBuf = Buffer.from(otherShapeIdx.flatMap(varintU));
const otherIdxDec = (() => { const r = []; let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); r.push(v); o = n; } return r; })();
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

// Reconstruct position classes from RLE
const posBytesDec = zlib.brotliDecompressSync(posBr);
const posClass = new Uint8Array(N);
{
  let ofs = 0, idx = 0;
  while (ofs < posBytesDec.length) {
    const cls = posBytesDec[ofs++];
    const [cnt, no] = readVarintU(posBytesDec, ofs); ofs = no;
    for (let j = 0; j < cnt; j++) posClass[idx++] = cls;
  }
}

// Parse air data
const airRecv = [];
{
  let ofs = 0;
  for (let j = 0; j < airIdx.length; j++) {
    const [sti, n1] = readVarintU(airDataDec, ofs); ofs = n1;
    const [snc, n2] = readVarintU(airDataDec, ofs); ofs = n2;
    const sNums = [];
    for (let k = 0; k < snc; k++) {
      const [sl, n3] = readVarintU(airDataDec, ofs); ofs = n3;
      sNums.push(airDataDec.slice(ofs, ofs + sl).toString('utf8'));
      ofs += sl;
    }
    const [ri, n4] = readVarintU(airDataDec, ofs); ofs = n4;
    const [ci, n5] = readVarintU(airDataDec, ofs); ofs = n5;
    airRecv.push({ sti, sNums, ri, ci });
  }
}

// Parse mesh data
const meshRecv = [];
{
  let ofs = 0;
  for (let j = 0; j < meshIdx.length; j++) {
    const [sti, n1] = readVarintU(meshDataDec, ofs); ofs = n1;
    const [snc, n2] = readVarintU(meshDataDec, ofs); ofs = n2;
    const sNums = [];
    for (let k = 0; k < snc; k++) {
      const [sl, n3] = readVarintU(meshDataDec, ofs); ofs = n3;
      sNums.push(meshDataDec.slice(ofs, ofs + sl).toString('utf8'));
      ofs += sl;
    }
    const [raw, n4] = readVarintU(meshDataDec, ofs); ofs = n4;
    const [comp, n5] = readVarintU(meshDataDec, ofs); ofs = n5;
    const [ci, n6] = readVarintU(meshDataDec, ofs); ofs = n6;
    meshRecv.push({ sti, sNums, raw, comp, ci });
  }
}

// Reconstruct receipts in order
const reconstructed = [];
let airCur = 0, meshCur = 0, otherCur = 0;
for (let i = 0; i < N; i++) {
  const cls = posClass[i];
  if (cls === 1) {
    // air.compress
    const m = airRecv[airCur++];
    const sumTpl = airTplDec.sumTpls[m.sti];
    let ni = 0;
    const summary = sumTpl == null ? null : sumTpl.replace(/\x01/g, () => m.sNums[ni++]);
    const ratio = airTplDec.ratios[m.ri];
    const ca = airTplDec.cas[m.ci];
    const payload = { ratio, atom_count: 1, dropped: 0, citations: 0 };
    reconstructed.push({
      id: detId(seedDec.seed, i),
      action: 'air.compress',
      status: airTplDec.status,
      summary,
      payload_json: JSON.stringify(payload),
      created_at: ca,
    });
  } else if (cls === 2) {
    const m = meshRecv[meshCur++];
    const sumTpl = meshTplDec.sumTpls[m.sti];
    let ni = 0;
    const summary = sumTpl == null ? null : sumTpl.replace(/\x01/g, () => m.sNums[ni++]);
    const ratio = computeRatio(m.raw, m.comp);
    const ca = meshTplDec.cas[m.ci];
    const payload = { raw_bytes: m.raw, compressed_bytes: m.comp, ratio };
    reconstructed.push({
      id: detId(seedDec.seed, i),
      action: 'mesh.compress',
      status: meshTplDec.status,
      summary,
      payload_json: JSON.stringify(payload),
      created_at: ca,
    });
  } else {
    const shape = JSON.parse(shapesDec[otherIdxDec[otherCur++]]);
    shape.id = detId(seedDec.seed, i);
    reconstructed.push(shape);
  }
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT vs det' : '✗ MISMATCH'}`);
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`  First diff at byte ${i}:`);
      console.log(`    det: ...${det.slice(Math.max(0, i-80), i+80)}...`);
      console.log(`    rec: ...${recJsonl.slice(Math.max(0, i-80), i+80)}...`);
      break;
    }
  }
}

const out = {
  experiment: '40-method7-air-decomp',
  generated_at: new Date().toISOString(),
  air_count: airIdx.length,
  mesh_count: meshIdx.length,
  other_count: otherIdx.length,
  components: {
    air_template: airTplBr.length,
    air_data: airDataBr.length,
    mesh_template: meshTplBr.length,
    mesh_data: meshDataBr.length,
    other_shapes: otherShapesBr.length,
    other_idx: otherIdxBr.length,
    position_runs: posBr.length,
    seed: seedR.length,
  },
  total,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: lossless,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(out, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
