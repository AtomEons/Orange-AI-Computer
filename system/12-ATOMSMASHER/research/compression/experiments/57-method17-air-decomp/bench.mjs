// Experiment 57 — Method 17: Method 14 + air.compress decomposition
//
// air.compress summary "compressed XB → YB (Zx) — N atoms, M sentences dropped"
// air.compress payload  {"ratio":Z, "atom_count":N, "dropped":M, "citations":?}
//
// Variables: X (input), Y (output), ratio Z (derivable from X/Y), N, M, citations
// Note: ratio = banker_round(X/Y, 3) — verify this; then we only store (X, Y, N, M, citations)

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
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// ── Verify air.compress ratio derivation formula ──
const airRecs = receipts.filter(r => r.action === 'air.compress');
let ratioMatchesBanker3 = 0, ratioMatchesBanker2 = 0, ratioMatchesRound3 = 0;
const ratioFormulaResults = [];
for (const r of airRecs.slice(0, 100)) {
  const sumNums = (r.summary || '').match(NUM_RE) || [];
  const p = JSON.parse(r.payload_json);
  if (sumNums.length < 5) continue;
  const X = Number(sumNums[0]); // input
  const Y = Number(sumNums[1]); // output
  const Z = Number(sumNums[2]); // ratio from summary
  const pZ = p.ratio;
  if (X && Y) {
    const exact = X / Y;
    const banker3 = bankerRound(exact * 1000) / 1000;
    const banker2 = bankerRound(exact * 100) / 100;
    const round3 = Math.round(exact * 1000) / 1000;
    if (Math.abs(banker3 - pZ) < 1e-9) ratioMatchesBanker3++;
    if (Math.abs(banker2 - pZ) < 1e-9) ratioMatchesBanker2++;
    if (Math.abs(round3 - pZ) < 1e-9) ratioMatchesRound3++;
    ratioFormulaResults.push({ X, Y, Z, pZ, exact: exact.toFixed(6), banker3, banker2, round3 });
  }
}
console.log(`=== Air.compress ratio formula check (first 100) ===`);
console.log(`  banker_round(X/Y, 3): matches ${ratioMatchesBanker3}/100`);
console.log(`  banker_round(X/Y, 2): matches ${ratioMatchesBanker2}/100`);
console.log(`  round(X/Y, 3):        matches ${ratioMatchesRound3}/100`);
console.log(`Sample mismatches if any:`);
ratioFormulaResults.slice(0, 3).forEach(r => console.log(`  X=${r.X} Y=${r.Y} stored=${r.pZ} banker3=${r.banker3} exact=${r.exact}`));

// IF banker3 matches, we can drop ratio from payload (it's derivable from X, Y)

// ── Method 17 build ──
const meshIdx = [], airIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  const a = detReceipts[i].action;
  if (a === 'mesh.compress') meshIdx.push(i);
  else if (a === 'air.compress') airIdx.push(i);
  else otherIdx.push(i);
}
console.log(`\nmesh: ${meshIdx.length}, air: ${airIdx.length}, other: ${otherIdx.length}`);

// Mesh decomp (same as Method 14)
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

// Air decomp — store (X, Y, atom_count, dropped, citations, caIdx) per receipt
// Ratio derived from X/Y. Summary template fixed.
const airSumTpls = new Set();
const airCAs = new Map();
const airRecData = [];
for (const i of airIdx) {
  const r = detReceipts[i];
  const sT = templatize(r.summary);
  airSumTpls.add(sT.tpl);
  if (!airCAs.has(r.created_at)) airCAs.set(r.created_at, airCAs.size);
  const sumNums = (r.summary || '').match(NUM_RE) || [];
  let X = 0, Y = 0;
  if (sumNums.length >= 2) { X = Number(sumNums[0]); Y = Number(sumNums[1]); }
  let atomCount = 1, dropped = 0, citations = 0;
  try { const p = JSON.parse(r.payload_json); atomCount = p.atom_count ?? 1; dropped = p.dropped ?? 0; citations = p.citations ?? 0; } catch {}
  airRecData.push({ sTpl: sT.tpl, X, Y, atomCount, dropped, citations, caIdx: airCAs.get(r.created_at) });
}
const airSumTplList = [...airSumTpls];
const airSumTplMap = new Map(airSumTplList.map((t, i) => [t, i]));
const airTemplate = { status: detReceipts[airIdx[0]].status, sumTpls: airSumTplList, cas: [...airCAs.keys()] };
const airTplBr = brotli11(Buffer.from(JSON.stringify(airTemplate), 'utf8'));
const airDataBytes = [];
for (const d of airRecData) {
  airDataBytes.push(...varintU(airSumTplMap.get(d.sTpl)));
  airDataBytes.push(...varintU(d.X));
  airDataBytes.push(...varintU(d.Y));
  airDataBytes.push(...varintU(d.atomCount));
  airDataBytes.push(...varintU(d.dropped));
  airDataBytes.push(...varintU(d.citations));
  airDataBytes.push(...varintU(d.caIdx));
}
const airDataBr = brotli11(Buffer.from(airDataBytes));
console.log(`\nair decomp: template=${airTplBr.length} B, data=${airDataBr.length} B`);

// Other receipts
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

const aV = new Map();
const stripped = [];
const actionStream = [];
for (const s of sortedShapeList) {
  const parsed = JSON.parse(s);
  const a = parsed.action;
  if (!aV.has(a)) aV.set(a, aV.size);
  actionStream.push(aV.get(a));
  const re1 = new RegExp(`"action":"${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",`);
  const re2 = new RegExp(`,"action":"${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
  stripped.push(s.replace(re1, '').replace(re2, ''));
}
let shapesBlob = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
shapesBlob = brotli11(shapesBlob);
const aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
const aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
const otherIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));

// Position class RLE — 0=other, 1=mesh, 2=air
const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
for (const i of airIdx) positionClass[i] = 2;
const posRuns = [];
{ let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
  posRuns.push([prev, count]); }
const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));

const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + airTplBr.length + airDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length;
const ratio = detBytes.length / total;
console.log(`\n=== METHOD 17: Method 14 + air.compress decomposition ===`);
console.log(`mesh template:   ${meshTplBr.length}`);
console.log(`mesh data:       ${meshDataBr.length}`);
console.log(`air template:    ${airTplBr.length}`);
console.log(`air data:        ${airDataBr.length}`);
console.log(`shapes (br2):    ${shapesBlob.length}`);
console.log(`aIdx:            ${aIdxBr.length}`);
console.log(`aV:              ${aVBr.length}`);
console.log(`other shape idx: ${otherIdxBr.length}`);
console.log(`pos runs:        ${posBr.length}`);
console.log(`seed:            ${seedR.length}`);
console.log(`TOTAL:           ${total}`);
console.log(`Ratio:           ${ratio.toFixed(3)}x`);
console.log(`vs Method 14 (46.431x): ${ratio > 46.431 ? `BEATS by +${(ratio-46.431).toFixed(3)}x` : `below by ${(46.431-ratio).toFixed(3)}x`}`);

// ── ROUNDTRIP ──
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

const airTplDec = JSON.parse(zlib.brotliDecompressSync(airTplBr).toString('utf8'));
const airDataDec = zlib.brotliDecompressSync(airDataBr);
const airRecv = [];
{ let ofs = 0;
  while (ofs < airDataDec.length) {
    const [sti, n1] = readVarintU(airDataDec, ofs); ofs = n1;
    const [X, n2] = readVarintU(airDataDec, ofs); ofs = n2;
    const [Y, n3] = readVarintU(airDataDec, ofs); ofs = n3;
    const [atomCount, n4] = readVarintU(airDataDec, ofs); ofs = n4;
    const [dropped, n5] = readVarintU(airDataDec, ofs); ofs = n5;
    const [citations, n6] = readVarintU(airDataDec, ofs); ofs = n6;
    const [ci, n7] = readVarintU(airDataDec, ofs); ofs = n7;
    airRecv.push({ sti, X, Y, atomCount, dropped, citations, ci });
  } }

const strippedDec = zlib.brotliDecompressSync(zlib.brotliDecompressSync(shapesBlob)).toString('utf8').split('\n').filter(Boolean);
const aIdxBuf = zlib.brotliDecompressSync(aIdxBr);
const aIdxs = []; { let o = 0; while (o < aIdxBuf.length) { const [v, n] = readVarintU(aIdxBuf, o); aIdxs.push(v); o = n; } }
const aVarr = zlib.brotliDecompressSync(aVBr).toString('utf8').split('\x02');
const restoredShapes = strippedDec.map((s, i) => {
  const a = aVarr[aIdxs[i]];
  if (s.startsWith('{"id":"",')) return s.replace(/^\{"id":"",/, `{"id":"","action":"${a}",`);
  return s.replace(/^\{/, `{"action":"${a}",`);
});

const otherIdxBuf = zlib.brotliDecompressSync(otherIdxBr);
const otherIdxDec = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec.push(v); o = n; } }

const posBytes = zlib.brotliDecompressSync(posBr);
const posClass = new Uint8Array(N);
{ let o = 0, idx = 0;
  while (o < posBytes.length) { const cls = posBytes[o++]; const [cnt, no] = readVarintU(posBytes, o); o = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

const reconstructed = [];
let meshCur = 0, airCur = 0, otherCur = 0;
for (let i = 0; i < N; i++) {
  if (posClass[i] === 1) {
    const m = meshRecv[meshCur++];
    const sumTpl = meshTplDec.sumTpls[m.sti];
    let ni = 0;
    const nums = [String(m.packet_id), String(m.raw), String(m.comp)];
    const summary = sumTpl == null || sumTpl === '\0NULL\0' ? null : sumTpl.replace(/\x01/g, () => nums[ni++]);
    const ratio = meshRatio(m.raw, m.comp);
    reconstructed.push({
      id: detId(seedDec.seed, i),
      action: 'mesh.compress',
      status: meshTplDec.status,
      summary,
      payload_json: JSON.stringify({ raw_bytes: m.raw, compressed_bytes: m.comp, ratio }),
      created_at: meshTplDec.cas[m.ci],
    });
  } else if (posClass[i] === 2) {
    const m = airRecv[airCur++];
    const sumTpl = airTplDec.sumTpls[m.sti];
    // Derive ratio from X/Y using banker_round
    const exact = m.X / m.Y;
    const ratio = bankerRound(exact * 1000) / 1000;
    let ni = 0;
    const nums = [String(m.X), String(m.Y), String(ratio), String(m.atomCount), String(m.dropped)];
    const summary = sumTpl == null || sumTpl === '\0NULL\0' ? null : sumTpl.replace(/\x01/g, () => nums[ni++]);
    reconstructed.push({
      id: detId(seedDec.seed, i),
      action: 'air.compress',
      status: airTplDec.status,
      summary,
      payload_json: JSON.stringify({ ratio, atom_count: m.atomCount, dropped: m.dropped, citations: m.citations }),
      created_at: airTplDec.cas[m.ci],
    });
  } else {
    const shape = JSON.parse(restoredShapes[otherIdxDec[otherCur++]]);
    shape.id = detId(seedDec.seed, i);
    reconstructed.push(shape);
  }
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  det: ...${det.slice(Math.max(0, i-80), i+80)}...`);
      console.log(`  rec: ...${recJsonl.slice(Math.max(0, i-80), i+80)}...`);
      break;
    }
  }
}

fs.writeFileSync(RECEIPT_FILE, JSON.stringify({ experiment: '57-method17-air-decomp', total, ratio: Number(ratio.toFixed(3)), lossless }, null, 2));
