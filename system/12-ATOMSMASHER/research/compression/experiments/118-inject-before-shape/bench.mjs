// Experiment 118 — Formula injection BEFORE SHAPE_VOCAB
//
// M19 pipeline: MESH_DECOMP → SHAPE_VOCAB → ACTION_STRIP → B8_SORT → BROTLI×2
// This experiment injects two high-confidence derivation formulas at the
// EARLIEST possible point — strip them from the receipt shape BEFORE the
// shape vocabulary is built.
//
// Formula library:
//   F1 (status):  if status === "ok", drop status field; restore "ok" at decode.
//                 Exception list (sparse) captures the 1 outlier (status="error").
//   F2 (ratio):   for mesh.compress, ratio = bankerRound(raw/comp, 2). M19 mesh
//                 path already derives this. For "other" path receipts where the
//                 payload contains {raw_bytes, compressed_bytes, ratio} as a
//                 self-consistent trio, drop ratio at encode; restore at decode.
//                 (corpus probe: only 1 such non-mesh receipt; included for
//                 generality but the win comes overwhelmingly from F1.)
//
// Hypothesis: stripping derivables earliest yields cleaner shapes → more
// vocabulary dedup wins downstream (smaller shape blob, smaller vocab index).

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

// ─────────────── MESH PATH (unchanged from M19; ratio already derived) ───────────────
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

// ─────────────── OTHER PATH — FORMULA INJECTION BEFORE SHAPE_VOCAB ───────────────
//
// Build the shape WITHOUT the derivable fields. Capture exceptions sparsely.
//
// F1: status field is dropped from object; status_exception[i] = actual status
//     iff status !== "ok". Sparse list keyed by otherIdx position.
// F2: nested payload.ratio is dropped iff payload has raw_bytes + compressed_bytes
//     AND payload.ratio === bankerRound(raw/comp, 2). Tracked per-shape by a
//     boolean flag inside the shape (since shape vocab is structural).

const STATUS_OK = 'ok';
const statusExceptions = []; // [(otherPos, statusString)...]

const otherReceipts = otherIdx.map((srcI, otherPos) => {
  const r = detReceipts[srcI];
  const obj = { action: r.action };
  // F1 status injection
  if (r.status !== STATUS_OK) {
    statusExceptions.push([otherPos, r.status]);
    obj.status = r.status;
  }
  // (we DROP status from the shape entirely when it's "ok" — derived as default)
  obj.summary = r.summary;
  if (r.payload_json != null) {
    let parsed;
    try { parsed = JSON.parse(r.payload_json); }
    catch { parsed = null; }
    if (parsed !== null) {
      // F2 ratio injection: only strip if the trio is internally consistent
      if (parsed && typeof parsed === 'object'
          && 'raw_bytes' in parsed && 'compressed_bytes' in parsed
          && 'ratio' in parsed
          && Math.abs(parsed.ratio - meshRatio(parsed.raw_bytes, parsed.compressed_bytes)) < 1e-9) {
        const { ratio, ...rest } = parsed;
        // Mark with a sentinel field so decoder knows to recompute
        obj.payload = { ...rest, __r: 1 };
      } else {
        obj.payload = parsed;
      }
    } else {
      obj.payload_raw = r.payload_json;
    }
  } else {
    obj.payload = null;
  }
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
const otherShapeIdx = otherReceipts.map(r => sortedShapeIdx.get(shapeKey(r)));

// stripAction
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
const otherIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));

// Sparse status exceptions: encode as [(varintU otherPos), len, bytes...] sequence
const statusExcBytes = [];
for (const [pos, s] of statusExceptions) {
  statusExcBytes.push(...varintU(pos));
  const sb = Buffer.from(s, 'utf8');
  statusExcBytes.push(...varintU(sb.length));
  for (const b of sb) statusExcBytes.push(b);
}
statusExcBytes.push(...varintU(0xFFFFFF)); // sentinel terminator (impossible position)
const statusExcBr = brotli11(Buffer.from(statusExcBytes));

const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
const posRuns = [];
{ let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
  posRuns.push([prev, count]); }
const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));

const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length + statusExcBr.length;
const ratio = detBytes.length / total;
const encodeMs = performance.now() - tEncStart;

console.log(`\n=== EXP 118: Formula injection BEFORE SHAPE_VOCAB ===`);
console.log(`mesh template:   ${meshTplBr.length}`);
console.log(`mesh data:       ${meshDataBr.length}`);
console.log(`shapes (br2):    ${shapesBlob.length}`);
console.log(`aIdx:            ${aIdxBr.length}`);
console.log(`aV:              ${aVBr.length}`);
console.log(`other shape idx: ${otherIdxBr.length}`);
console.log(`status exc:      ${statusExcBr.length}  (${statusExceptions.length} exceptions)`);
console.log(`pos runs:        ${posBr.length}`);
console.log(`seed:            ${seedR.length}`);
console.log(`TOTAL:           ${total}`);
console.log(`Unique shapes:   ${sortedShapeList.length}`);
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

const restoredShapes = strippedDec.map((s, i) => {
  const a = aVarr[aIdxs[i]];
  const obj = JSON.parse(s);
  const ordered = { action: a, ...obj };
  return JSON.stringify(ordered);
});

const otherIdxBuf = zlib.brotliDecompressSync(otherIdxBr);
const otherIdxDec = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec.push(v); o = n; } }

const posBytes = zlib.brotliDecompressSync(posBr);
const posClass = new Uint8Array(N);
{ let o = 0, idx = 0;
  while (o < posBytes.length) { const cls = posBytes[o++]; const [cnt, no] = readVarintU(posBytes, o); o = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

// status exceptions: decode sparse list
const statusExcBuf = zlib.brotliDecompressSync(statusExcBr);
const statusExcMap = new Map();
{ let o = 0;
  while (o < statusExcBuf.length) {
    const [pos, n1] = readVarintU(statusExcBuf, o); o = n1;
    if (pos === 0xFFFFFF) break;
    const [len, n2] = readVarintU(statusExcBuf, o); o = n2;
    const s = statusExcBuf.slice(o, o + len).toString('utf8'); o += len;
    statusExcMap.set(pos, s);
  } }

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
    const otherPos = otherCur++;
    const shape = JSON.parse(restoredShapes[otherIdxDec[otherPos]]);
    const id = detId(seedDec.seed, i);
    // F1 status restore
    const status = ('status' in shape) ? shape.status : (statusExcMap.has(otherPos) ? statusExcMap.get(otherPos) : STATUS_OK);
    // F2 ratio restore
    let payload_json;
    if ('payload' in shape) {
      if (shape.payload === null) {
        payload_json = null;
      } else if (shape.payload && typeof shape.payload === 'object' && shape.payload.__r === 1) {
        const { __r, ...rest } = shape.payload;
        const restored = { ...rest, ratio: meshRatio(rest.raw_bytes, rest.compressed_bytes) };
        payload_json = JSON.stringify(restored);
      } else {
        payload_json = JSON.stringify(shape.payload);
      }
    } else {
      payload_json = shape.payload_raw;
    }
    const ordered = {
      id, action: shape.action, status,
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
  experiment: '118-inject-before-shape',
  injection_point: 'BEFORE SHAPE_VOCAB',
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
    status_exceptions: statusExcBr.length,
    pos_runs: posBr.length,
    seed: seedR.length,
  },
  unique_shapes_other: sortedShapeList.length,
  status_exceptions_count: statusExceptions.length,
  verdict: lossless && ratio >= 47.07 ? 'GREEN' : (lossless && ratio >= 47.07 * 0.99 ? 'AMBER' : 'RED'),
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
