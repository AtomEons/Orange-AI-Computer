// Experiment 47 — Method 10: Method 9 + stacked wildcard wins
//
// Wildcards that legitimately beat B8 brotli baseline:
//   - W10 token-encode top phrases (-243)
//   - W24 strip "action":"X" leading field (-71)
//   - W30 Hamming-greedy within bucket (-68)
//   - W05/W13 brotli-twice (-161, verified lossless)
//
// Test how they stack. Verify byte-exact lossless.

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

// Mesh decomp (same as Method 9)
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

// B8 ordering of other shapes
const otherReceipts = otherIdx.map(i => detReceipts[i]);
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const unsortedShapeVocab = new Map();
const unsortedShapeList = [];
for (const r of otherReceipts) {
  const k = shapeKey(r);
  if (!unsortedShapeVocab.has(k)) { unsortedShapeVocab.set(k, unsortedShapeList.length); unsortedShapeList.push(k); }
}
const indexed = unsortedShapeList.map((s, i) => ({ s, i, p: JSON.parse(s) }));
indexed.sort((a, b) => {
  if (a.p.action !== b.p.action) return a.p.action.localeCompare(b.p.action);
  if (a.s.length !== b.s.length) return a.s.length - b.s.length;
  return a.s.localeCompare(b.s);
});
const sortedShapeList = indexed.map(x => x.s);
const sortedShapeIdx = new Map();
sortedShapeList.forEach((s, i) => sortedShapeIdx.set(s, i));
const otherShapeIdx = otherReceipts.map(r => sortedShapeIdx.get(shapeKey(r)));

// ── COMPARE MULTIPLE METHOD 10 VARIANTS ──
function totalize(shapesBlob, otherShapeIdxBytes) {
  const meshTplBr = brotli11(meshTplBytes);
  const meshDataBr = brotli11(Buffer.from(meshDataBytes));
  const positionClass = new Uint8Array(N);
  for (const i of meshIdx) positionClass[i] = 1;
  const posRuns = [];
  { let prev = positionClass[0], count = 1;
    for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
    posRuns.push([prev, count]); }
  const posBytes = Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)]));
  const posBr = brotli11(posBytes);
  const seedR = brotli11(Buffer.from(JSON.stringify({seed: SEED, n: N}), 'utf8'));
  const otherIdxBr = brotli11(otherShapeIdxBytes);
  return {
    meshTpl: meshTplBr.length, meshData: meshDataBr.length,
    shapes: shapesBlob.length, otherIdx: otherIdxBr.length,
    pos: posBr.length, seed: seedR.length,
    total: meshTplBr.length + meshDataBr.length + shapesBlob.length + otherIdxBr.length + posBr.length + seedR.length,
  };
}

const otherShapeIdxBytes = Buffer.from(otherShapeIdx.flatMap(varintU));

// V1: Method 9 baseline
{
  const shapesBr = brotli11(Buffer.from(sortedShapeList.join('\n') + '\n', 'utf8'));
  const t = totalize(shapesBr, otherShapeIdxBytes);
  console.log(`V1 (Method 9):                          total=${t.total} B = ${(detBytes.length/t.total).toFixed(2)}x  (shapes=${t.shapes})`);
}

// V2: brotli twice on the shape blob
{
  const shapesBr = brotli11(Buffer.from(sortedShapeList.join('\n') + '\n', 'utf8'));
  const shapesBrBr = brotli11(shapesBr);
  const t = totalize(shapesBrBr, otherShapeIdxBytes);
  console.log(`V2 (brotli twice on shapes):            total=${t.total} B = ${(detBytes.length/t.total).toFixed(2)}x  (shapes=${t.shapes})`);
}

// V3: Token-encode (W10) + brotli on shapes
function tokenEncode(s, dict) {
  let r = s;
  dict.forEach((phrase, i) => {
    const tok = String.fromCharCode(i + 4);
    r = r.split(phrase).join(tok);
  });
  return r;
}
function tokenDecode(s, dict) {
  let r = s;
  for (let i = dict.length - 1; i >= 0; i--) {
    const tok = String.fromCharCode(i + 4);
    r = r.split(tok).join(dict[i]);
  }
  return r;
}
const shapeJoined = sortedShapeList.join('\n') + '\n';
function findTopPhrases(text, count, len) {
  const cnt = new Map();
  for (let i = 0; i <= text.length - len; i += 1) {
    const p = text.substr(i, len);
    cnt.set(p, (cnt.get(p) || 0) + 1);
  }
  return [...cnt.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([p]) => p);
}
{
  // Discover top 16 phrases of length 30
  const topPhrases = findTopPhrases(shapeJoined, 16, 30);
  const encoded = tokenEncode(shapeJoined, topPhrases);
  const dict = Buffer.from(topPhrases.join('\0'), 'utf8');
  const encodedBr = brotli11(Buffer.from(encoded, 'utf8'));
  const dictBr = brotli11(dict);
  const combined = Buffer.concat([encodedBr, dictBr]);
  const t = totalize(combined, otherShapeIdxBytes);
  console.log(`V3 (token-encode top-16 30-char):       total=${t.total} B = ${(detBytes.length/t.total).toFixed(2)}x  (shapes=${t.shapes}, dictBr=${dictBr.length})`);
  // Sanity check: roundtrip the tokenization
  const decoded = tokenDecode(encoded, topPhrases);
  if (decoded !== shapeJoined) console.log(`  V3 token tokenize ROUNDTRIP MISMATCH!`);
}

// V4: token-encode + brotli twice
{
  const topPhrases = findTopPhrases(shapeJoined, 16, 30);
  const encoded = tokenEncode(shapeJoined, topPhrases);
  const dict = Buffer.from(topPhrases.join('\0'), 'utf8');
  const encodedBr = brotli11(Buffer.from(encoded, 'utf8'));
  const encodedBrBr = brotli11(encodedBr);
  const dictBr = brotli11(dict);
  const combined = Buffer.concat([encodedBrBr, dictBr]);
  const t = totalize(combined, otherShapeIdxBytes);
  console.log(`V4 (token-encode + brotli twice):       total=${t.total} B = ${(detBytes.length/t.total).toFixed(2)}x  (shapes=${t.shapes})`);
}

// V5: Strip action field per shape (W24) + brotli
function stripActionField(shapesArr) {
  const aV = new Map();
  const stripped = [];
  const actionStream = [];
  for (const s of shapesArr) {
    const parsed = JSON.parse(s);
    const a = parsed.action;
    if (!aV.has(a)) aV.set(a, aV.size);
    actionStream.push(aV.get(a));
    // Match the EXACT byte form: `"action":"<action>",`
    const re = new RegExp(`"action":"${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",`);
    const idx = s.search(re);
    if (idx < 0) { stripped.push(s); continue; }
    stripped.push(s.replace(re, ''));
  }
  return { stripped, aV, actionStream };
}
{
  const { stripped, aV, actionStream } = stripActionField(sortedShapeList);
  const strippedBr = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
  const aIdxBytes = Buffer.from(actionStream.flatMap(varintU));
  const aIdxBr = brotli11(aIdxBytes);
  const aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
  const combined = Buffer.concat([strippedBr, aIdxBr, aVBr]);
  const t = totalize(combined, otherShapeIdxBytes);
  console.log(`V5 (strip action field + brotli):       total=${t.total} B = ${(detBytes.length/t.total).toFixed(2)}x  (shapes=${t.shapes}, strippedBr=${strippedBr.length}, aIdxBr=${aIdxBr.length}, aVBr=${aVBr.length})`);
}

// V6: best of above + brotli twice + verify lossless
{
  const shapesBr = brotli11(Buffer.from(sortedShapeList.join('\n') + '\n', 'utf8'));
  const shapesBrBr = brotli11(shapesBr);
  const t = totalize(shapesBrBr, otherShapeIdxBytes);

  // Full roundtrip
  const meshTplBr = brotli11(meshTplBytes);
  const meshDataBr = brotli11(Buffer.from(meshDataBytes));
  const positionClass = new Uint8Array(N);
  for (const i of meshIdx) positionClass[i] = 1;
  const posRuns = [];
  { let prev = positionClass[0], count = 1;
    for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
    posRuns.push([prev, count]); }
  const posBytes = Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)]));
  const posBr = brotli11(posBytes);
  const seedR = brotli11(Buffer.from(JSON.stringify({seed: SEED, n: N}), 'utf8'));
  const otherIdxBr = brotli11(otherShapeIdxBytes);

  // Decode
  const sortedShapesDec = zlib.brotliDecompressSync(zlib.brotliDecompressSync(shapesBrBr)).toString('utf8').split('\n').filter(Boolean);
  const meshTplDec = JSON.parse(zlib.brotliDecompressSync(meshTplBr).toString('utf8'));
  const meshDataDec = zlib.brotliDecompressSync(meshDataBr);
  const otherShapeIdxDec = (() => { const r = []; let o = 0; const b = Buffer.from(otherShapeIdxBytes); while (o < b.length) { const [v, n] = readVarintU(b, o); r.push(v); o = n; } return r; })();
  const posBytesDec = zlib.brotliDecompressSync(posBr);
  const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

  const posClass = new Uint8Array(N);
  { let ofs = 0, idx = 0;
    while (ofs < posBytesDec.length) { const cls = posBytesDec[ofs++]; const [cnt, no] = readVarintU(posBytesDec, ofs); ofs = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

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
    } }

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

  // Compute total
  const total = meshTplBr.length + meshDataBr.length + shapesBrBr.length + otherIdxBr.length + posBr.length + seedR.length;
  console.log(`\n=== METHOD 10 (V6: Method 9 + brotli-twice on shapes) ===`);
  console.log(`Total: ${total} B = ${(detBytes.length / total).toFixed(2)}x`);
  console.log(`Roundtrip: ${lossless ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);
  console.log(`vs Method 9 (42.09x): ${detBytes.length / total > 42.09 ? `BEATS by +${(detBytes.length/total - 42.09).toFixed(3)}x` : `below`}`);

  fs.writeFileSync(RECEIPT_FILE, JSON.stringify({ experiment: '47-method10-stack-wildcards', method10_total: total, ratio: Number((detBytes.length/total).toFixed(2)), lossless }, null, 2));
}
