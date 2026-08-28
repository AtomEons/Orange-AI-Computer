// Experiment 120 — Formula injection AFTER B8_SORT (just before brotli×2)
//
// M19 pipeline: MESH_DECOMP → SHAPE_VOCAB → ACTION_STRIP → B8_SORT → [HERE] → BROTLI×2
// Latest possible injection. Operates on shapes already sorted by (action,
// length, lex). Hypothesis: post-sort layout exposes more cross-receipt
// redundancy because adjacent shapes share more structure, so formula trims
// concentrate dictionary hits inside the brotli window.

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
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

const tEncStart = performance.now();

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// MESH path
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

// OTHER PATH — full M19 through to sort, THEN apply formula
const STATUS_OK = 'ok';
const otherReceipts = otherIdx.map(i => {
  const r = detReceipts[i];
  const obj = { action: r.action, status: r.status, summary: r.summary };
  if (r.payload_json != null) {
    try { obj.payload = JSON.parse(r.payload_json); } catch { obj.payload_raw = r.payload_json; }
  } else obj.payload = null;
  obj.created_at = r.created_at;
  return obj;
});

const shapeKey = r => JSON.stringify(r);
const unsortedShapeVocab = new Map();
const unsortedShapeList = [];
for (const r of otherReceipts) {
  const k = shapeKey(r);
  if (!unsortedShapeVocab.has(k)) { unsortedShapeVocab.set(k, unsortedShapeList.length); unsortedShapeList.push(k); }
}

// B8_SORT (action, length, lex)
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

// ACTION_STRIP (M19 behaviour)
const aV = new Map();
const actionStream = [];
const actionStripped = [];
for (const s of sortedShapeList) {
  const parsed = JSON.parse(s);
  const a = parsed.action;
  if (!aV.has(a)) aV.set(a, aV.size);
  actionStream.push(aV.get(a));
  const { action, ...rest } = parsed;
  actionStripped.push(rest);
}

// FORMULA INJECTION (now, just before brotli)
const formulaStripped = [];
const shapeStatusFormula = [];
const shapeRatioFormula = [];
for (const rest of actionStripped) {
  const out = {};
  if (rest.status === STATUS_OK) {
    shapeStatusFormula.push(1);
  } else {
    shapeStatusFormula.push(0);
    out.status = rest.status;
  }
  out.summary = rest.summary;
  let ratioStripped = 0;
  if ('payload' in rest) {
    const p = rest.payload;
    if (p && typeof p === 'object' && 'raw_bytes' in p && 'compressed_bytes' in p
        && 'ratio' in p
        && Math.abs(p.ratio - meshRatio(p.raw_bytes, p.compressed_bytes)) < 1e-9) {
      const { ratio, ...prest } = p;
      out.payload = prest;
      ratioStripped = 1;
    } else {
      out.payload = p;
    }
  } else {
    out.payload_raw = rest.payload_raw;
  }
  shapeRatioFormula.push(ratioStripped);
  out.created_at = rest.created_at;
  formulaStripped.push(JSON.stringify(out));
}

let shapesBlob = brotli11(Buffer.from(formulaStripped.join('\n') + '\n', 'utf8'));
shapesBlob = brotli11(shapesBlob);
const aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
const aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
const otherIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));

// formula flags: bit-packed per shape (2 bits per shape)
const flagsBytes = [];
for (let i = 0; i < formulaStripped.length; i += 4) {
  let byte = 0;
  for (let j = 0; j < 4 && (i + j) < formulaStripped.length; j++) {
    if (shapeStatusFormula[i + j]) byte |= (1 << (j * 2));
    if (shapeRatioFormula[i + j])  byte |= (1 << (j * 2 + 1));
  }
  flagsBytes.push(byte);
}
const flagsBr = brotli11(Buffer.from(flagsBytes));

const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
const posRuns = [];
{ let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
  posRuns.push([prev, count]); }
const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));

const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length + flagsBr.length;
const ratio = detBytes.length / total;
const encodeMs = performance.now() - tEncStart;

console.log(`\n=== EXP 120: Formula injection AFTER B8_SORT ===`);
console.log(`mesh template:   ${meshTplBr.length}`);
console.log(`mesh data:       ${meshDataBr.length}`);
console.log(`shapes (br2):    ${shapesBlob.length}`);
console.log(`aIdx:            ${aIdxBr.length}`);
console.log(`aV:              ${aVBr.length}`);
console.log(`other shape idx: ${otherIdxBr.length}`);
console.log(`formula flags:   ${flagsBr.length}`);
console.log(`pos runs:        ${posBr.length}`);
console.log(`seed:            ${seedR.length}`);
console.log(`TOTAL:           ${total}`);
console.log(`Ratio:           ${ratio.toFixed(3)}x`);
console.log(`vs M19 (47.07x): ${ratio > 47.07 ? `BEATS by +${(ratio-47.07).toFixed(3)}x` : `below by ${(47.07-ratio).toFixed(3)}x`}`);

// ── ROUNDTRIP ──
const tDecStart = performance.now();
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

const strippedDec = zlib.brotliDecompressSync(zlib.brotliDecompressSync(shapesBlob)).toString('utf8').split('\n').filter(Boolean);
const aIdxBuf = zlib.brotliDecompressSync(aIdxBr);
const aIdxs = []; { let o = 0; while (o < aIdxBuf.length) { const [v, n] = readVarintU(aIdxBuf, o); aIdxs.push(v); o = n; } }
const aVarr = zlib.brotliDecompressSync(aVBr).toString('utf8').split('\x02');

// flags
const flagsBuf = zlib.brotliDecompressSync(flagsBr);
const statusFormulaDec = [];
const ratioFormulaDec = [];
for (let bi = 0; bi < flagsBuf.length; bi++) {
  const byte = flagsBuf[bi];
  for (let j = 0; j < 4; j++) {
    if (statusFormulaDec.length < strippedDec.length) {
      statusFormulaDec.push((byte >> (j * 2)) & 1);
      ratioFormulaDec.push((byte >> (j * 2 + 1)) & 1);
    }
  }
}

// rebuild full sorted shapes by un-stripping action + restoring formulas
const restoredShapes = strippedDec.map((s, i) => {
  const a = aVarr[aIdxs[i]];
  const residual = JSON.parse(s);
  if (statusFormulaDec[i] === 1 && !('status' in residual)) residual.status = STATUS_OK;
  if (ratioFormulaDec[i] === 1 && residual.payload && typeof residual.payload === 'object') {
    residual.payload.ratio = meshRatio(residual.payload.raw_bytes, residual.payload.compressed_bytes);
  }
  const ordered = { action: a, status: residual.status, summary: residual.summary };
  if ('payload' in residual) ordered.payload = residual.payload;
  else if ('payload_raw' in residual) ordered.payload_raw = residual.payload_raw;
  ordered.created_at = residual.created_at;
  return JSON.stringify(ordered);
});

const otherIdxBuf = zlib.brotliDecompressSync(otherIdxBr);
const otherIdxDec = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec.push(v); o = n; } }

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
    const ratio = meshRatio(m.raw, m.comp);
    reconstructed.push({
      id: detId(seedDec.seed, i),
      action: 'mesh.compress',
      status: meshTplDec.status,
      summary,
      payload_json: JSON.stringify({ raw_bytes: m.raw, compressed_bytes: m.comp, ratio }),
      created_at: meshTplDec.cas[m.ci],
    });
  } else {
    const shape = JSON.parse(restoredShapes[otherIdxDec[otherCur++]]);
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
const lossless = recSha === detSha;
const decodeMs = performance.now() - tDecStart;
console.log(`\nRoundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
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
console.log(`encode_ms: ${encodeMs.toFixed(1)}  decode_ms: ${decodeMs.toFixed(1)}`);

const summary = {
  experiment: '120-inject-after-sort',
  injection_point: 'AFTER B8_SORT (immediately before brotli x2)',
  formula_library: ['status_ok_default', 'mesh_ratio_derivation'],
  corpus_sha256: detSha,
  raw_bytes: detBytes.length,
  total_bytes: total,
  ratio: Number(ratio.toFixed(4)),
  vs_m19: Number((ratio - 47.07).toFixed(4)),
  encode_ms: Number(encodeMs.toFixed(2)),
  decode_ms: Number(decodeMs.toFixed(2)),
  lossless,
  components: {
    mesh_tpl: meshTplBr.length,
    mesh_data: meshDataBr.length,
    shapes_br2: shapesBlob.length,
    a_idx: aIdxBr.length,
    a_v: aVBr.length,
    other_idx: otherIdxBr.length,
    formula_flags: flagsBr.length,
    pos_runs: posBr.length,
    seed: seedR.length,
  },
  unique_shapes_other: formulaStripped.length,
  verdict: lossless && ratio >= 47.07 ? 'GREEN' : (lossless && ratio >= 47.07 * 0.99 ? 'AMBER' : 'RED'),
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
