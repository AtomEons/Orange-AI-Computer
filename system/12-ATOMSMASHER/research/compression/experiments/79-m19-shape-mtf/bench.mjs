// Experiment 79 — Splice shape-MTF into Method 19
// Hypothesis: M19's `otherShapeIdx` stream is a sequence of indices into a static
// sorted shape vocab. Replace that static-index stream with MTF (move-to-front)
// codes: maintain an ordered list of shapes seen so far; on encode, emit current
// position; promote to position 0. Decode rebuilds the same MTF state in lockstep.
// The MTF code stream should be Zipf-distributed (small values dominate), letting
// brotli over a varint stream compress better than brotli over the original
// uniformly-distributed sorted-vocab indices.
// All other M19 streams (mesh template/data, sorted shape list w/ action-strip,
// position runs, seed) remain UNCHANGED.

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
function bankerRound(x) { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); }
function meshRatio(raw, comp) { return bankerRound((raw / comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// ── Mesh decomp (identical to M19) ──
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

// ── Other receipts — parse payload, drop id field entirely from shape ──
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

const indexed = unsortedShapeList.map((s, i) => ({ s, i, p: JSON.parse(s) }));
indexed.sort((a, b) => {
  if (a.p.action !== b.p.action) return a.p.action.localeCompare(b.p.action);
  if (a.s.length !== b.s.length) return a.s.length - b.s.length;
  return a.s.localeCompare(b.s);
});
const sortedShapeList = indexed.map(x => x.s);
const sortedShapeIdx = new Map();
sortedShapeList.forEach((s, i) => sortedShapeIdx.set(s, i));
// Sort-index stream (M19 baseline)
const otherShapeIdx = otherReceipts.map(r => sortedShapeIdx.get(shapeKey(r)));

// stripAction at object level (same as M19)
const aV = new Map();
const stripped = [];
const actionStream = [];
for (const s of sortedShapeList) {
  const parsed = JSON.parse(s);
  const a = parsed.action;
  if (!aV.has(a)) aV.set(a, aV.size);
  actionStream.push(aV.get(a));
  const { action, ...rest } = parsed;
  stripped.push(JSON.stringify(rest));
}
let shapesBlob = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
shapesBlob = brotli11(shapesBlob);
const aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
const aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));

// position run-length stream (same as M19)
const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
const posRuns = [];
{ let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
  posRuns.push([prev, count]); }
const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

// ===================================================================
// BASELINE M19: brotli the static sort-index stream as-is
// ===================================================================
const tB0 = process.hrtime.bigint();
const otherIdxBr_baseline = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));
const tB1 = process.hrtime.bigint();
const m19EncodeMs = Number(tB1 - tB0) / 1e6;

const m19Total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr_baseline.length + posBr.length + seedR.length;
const m19Ratio = detBytes.length / m19Total;

// ===================================================================
// VARIANT: MTF over the receipt-by-receipt shape stream
// ===================================================================
// Walk receipts in order. MTF list holds shape SORT-INDICES (small ints) so the
// "literal new shape" case has a tiny representation (just the sorted-vocab idx).
// Encoder protocol:
//   - For each receipt, look up its shape's sort-index s = sortedShapeIdx[shape].
//   - If s is already in mtf list: emit code = position_in_mtf (varint).
//       Move that entry to mtf[0].
//   - If s is NEW: emit code = mtf.length (a "new" sentinel that equals current
//       size; valid positions are 0..mtf.length-1), then emit varint(s) as the
//       sort-index of the new shape. Push s to mtf[0].
// Decoder rebuilds the same mtf state by symmetric operations.

const tE0 = process.hrtime.bigint();
const mtfList = [];        // entries are sort-indices (numbers)
const mtfSeen = new Set(); // for O(1) "is this already in mtf?"
const codeStream = [];     // varint codes (position OR new-sentinel)
const newSortIdxStream = []; // varint sort-indices for new shapes only

for (let i = 0; i < otherReceipts.length; i++) {
  const s = otherShapeIdx[i]; // sort-index
  if (mtfSeen.has(s)) {
    const pos = mtfList.indexOf(s);
    codeStream.push(pos);
    if (pos !== 0) {
      mtfList.splice(pos, 1);
      mtfList.unshift(s);
    }
  } else {
    // emit the "new" sentinel: current mtfList.length (one past last valid pos)
    codeStream.push(mtfList.length);
    newSortIdxStream.push(s);
    mtfSeen.add(s);
    mtfList.unshift(s);
  }
}

const codeBytes = Buffer.from(codeStream.flatMap(varintU));
const codeBr = brotli11(codeBytes);
const newSortIdxBytes = Buffer.from(newSortIdxStream.flatMap(varintU));
const newSortIdxBr = brotli11(newSortIdxBytes);
const tE1 = process.hrtime.bigint();
const mtfEncodeMs = Number(tE1 - tE0) / 1e6;

const mtfTotal = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + codeBr.length + newSortIdxBr.length + posBr.length + seedR.length;
const mtfRatio = detBytes.length / mtfTotal;

// ===================================================================
// MTF DECODE & ROUNDTRIP
// ===================================================================
const tD0 = process.hrtime.bigint();

// decode M19-shared streams
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

const restoredShapes = strippedDec.map((s, i) => {
  const a = aVarr[aIdxs[i]];
  const obj = JSON.parse(s);
  const ordered = { action: a, ...obj };
  return JSON.stringify(ordered);
});

// decode MTF code + new-shape streams
const codeBuf = zlib.brotliDecompressSync(codeBr);
const codesDec = []; { let o = 0; while (o < codeBuf.length) { const [v, n] = readVarintU(codeBuf, o); codesDec.push(v); o = n; } }
const newSortBuf = zlib.brotliDecompressSync(newSortIdxBr);
const newSortDec = []; { let o = 0; while (o < newSortBuf.length) { const [v, n] = readVarintU(newSortBuf, o); newSortDec.push(v); o = n; } }

// Replay MTF to recover per-receipt sort-index
const mtfReplay = [];
const recoveredSortIdx = [];
let newCur = 0;
for (let i = 0; i < codesDec.length; i++) {
  const code = codesDec[i];
  if (code === mtfReplay.length) {
    // new shape
    const s = newSortDec[newCur++];
    recoveredSortIdx.push(s);
    mtfReplay.unshift(s);
  } else {
    const s = mtfReplay[code];
    recoveredSortIdx.push(s);
    if (code !== 0) {
      mtfReplay.splice(code, 1);
      mtfReplay.unshift(s);
    }
  }
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
    const shape = JSON.parse(restoredShapes[recoveredSortIdx[otherCur++]]);
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
const tD1 = process.hrtime.bigint();
const mtfDecodeMs = Number(tD1 - tD0) / 1e6;

// ── M19 baseline decode timing (independent measurement; reconstruct under M19 path)
const tBD0 = process.hrtime.bigint();
const otherIdxBuf = zlib.brotliDecompressSync(otherIdxBr_baseline);
const otherIdxDec_baseline = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec_baseline.push(v); o = n; } }
const tBD1 = process.hrtime.bigint();
const m19DecodeMs = Number(tBD1 - tBD0) / 1e6;

// sanity: baseline indices must match the encoded source (lossless by construction)
let m19RoundtripOk = true;
for (let i = 0; i < otherShapeIdx.length; i++) {
  if (otherShapeIdx[i] !== otherIdxDec_baseline[i]) { m19RoundtripOk = false; break; }
}

const delta = mtfRatio - m19Ratio;
const verdict = lossless && delta > 0.5 ? 'GREEN' : lossless && delta > -0.5 ? 'AMBER' : 'RED';
const reason = !lossless ? 'roundtrip failed'
  : delta > 0.5 ? `MTF beats M19 by +${delta.toFixed(2)}x`
  : delta > -0.5 ? `MTF within noise of M19 (delta ${delta.toFixed(2)}x)`
  : `MTF loses ${(-delta).toFixed(2)}x — code/new-shape overhead exceeds Zipf win`;

console.log(`=== EXP 79: M19 + shape-MTF index stream ===`);
console.log(`N receipts:                  ${N}`);
console.log(`Other (non-mesh) receipts:   ${otherReceipts.length}`);
console.log(`Unique non-mesh shapes:      ${sortedShapeList.length}`);
console.log(`New shapes inserted (MTF):   ${newSortIdxStream.length}`);
console.log(`Det bytes:                   ${detBytes.length}`);
console.log(`\n--- M19 baseline (reproduced) ---`);
console.log(`otherIdxBr (static):         ${otherIdxBr_baseline.length}`);
console.log(`Total:                       ${m19Total}`);
console.log(`Ratio:                       ${m19Ratio.toFixed(3)}x`);
console.log(`Baseline-stream roundtrip:   ${m19RoundtripOk ? 'OK' : 'FAIL'}`);
console.log(`\n--- M19 + shape-MTF ---`);
console.log(`codeBr (MTF positions):      ${codeBr.length}`);
console.log(`newSortIdxBr (new shapes):   ${newSortIdxBr.length}`);
console.log(`Total:                       ${mtfTotal}`);
console.log(`Ratio:                       ${mtfRatio.toFixed(3)}x`);
console.log(`Delta vs M19:                ${delta >= 0 ? '+' : ''}${delta.toFixed(3)}x`);
console.log(`Roundtrip:                   ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
console.log(`Verdict:                     ${verdict} — ${reason}`);

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
  experiment: '79-m19-shape-mtf',
  N,
  other_receipts: otherReceipts.length,
  unique_non_mesh_shapes: sortedShapeList.length,
  new_shapes_inserted: newSortIdxStream.length,
  det_bytes: detBytes.length,
  m19_baseline: {
    other_idx_br_bytes: otherIdxBr_baseline.length,
    total: m19Total,
    ratio: Number(m19Ratio.toFixed(3)),
    encode_ms: Number(m19EncodeMs.toFixed(1)),
    decode_ms: Number(m19DecodeMs.toFixed(1)),
    roundtrip_ok: m19RoundtripOk,
  },
  mtf_variant: {
    code_br_bytes: codeBr.length,
    new_sort_idx_br_bytes: newSortIdxBr.length,
    total: mtfTotal,
    ratio: Number(mtfRatio.toFixed(3)),
    delta_vs_m19: Number(delta.toFixed(3)),
    encode_ms: Number(mtfEncodeMs.toFixed(1)),
    decode_ms: Number(mtfDecodeMs.toFixed(1)),
    roundtrip_ok: lossless,
    verdict,
    reason,
  },
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
