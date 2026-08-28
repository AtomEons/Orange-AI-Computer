// Experiment 121 — Streaming M19 + formula library at W=500
//
// Combines Exp 80's Okazaki windowing (W=500) with Exp 118's winning
// formula injection point (BEFORE SHAPE_VOCAB). Each window is a
// self-contained compaction unit carrying its own mesh vocab, shape
// vocab, formula exception list, and seed metadata.
//
// Measures:
//   - aggregate ratio across all windows
//   - mean encode_ms per receipt
//   - mean decode_ms per receipt
//   - per-window roundtrip + concatenation sha256 verification
//
// Validates whether the formula approach survives the hot-path latency
// constraint that motivates streaming in the first place.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const allReceipts = lines.map(l => JSON.parse(l));
const N_TOTAL = allReceipts.length;
const SEED = 'orange5-receipt-stream-v1';
const W = 500;

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function bankerRound(x) { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); }
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }
const STATUS_OK = 'ok';

function encodeWindow(rawWindow, globalStart) {
  const tEnc0 = performance.now();
  const detReceipts = rawWindow.map((r, i) => ({ ...r, id: detId(SEED, globalStart + i) }));
  const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
  const detBytes = Buffer.from(detJsonl, 'utf8');
  const Nw = detReceipts.length;

  const meshIdx = [], otherIdx = [];
  for (let i = 0; i < Nw; i++) {
    if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
  }

  const meshSumTpls = new Set();
  const meshCAs = new Map();
  const meshRecData = [];
  let meshStatus = null;
  for (const i of meshIdx) {
    const r = detReceipts[i];
    if (meshStatus == null) meshStatus = r.status;
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
  const meshTemplate = { status: meshStatus, sumTpls: meshSumTplList, cas: [...meshCAs.keys()] };
  const meshTplBr = meshIdx.length > 0
    ? brotli11(Buffer.from(JSON.stringify(meshTemplate), 'utf8'))
    : brotli11(Buffer.from('{}', 'utf8'));
  const meshDataBytes = [];
  for (const d of meshRecData) {
    meshDataBytes.push(...varintU(meshSumTplMap.get(d.sTpl)));
    meshDataBytes.push(...varintU(d.packet_id));
    meshDataBytes.push(...varintU(d.raw));
    meshDataBytes.push(...varintU(d.comp));
    meshDataBytes.push(...varintU(d.caIdx));
  }
  const meshDataBr = brotli11(Buffer.from(meshDataBytes));

  // OTHER PATH — formula injection BEFORE SHAPE_VOCAB (Exp 118 winning approach)
  const statusExceptions = [];
  const otherReceipts = otherIdx.map((srcI, otherPos) => {
    const r = detReceipts[srcI];
    const obj = { action: r.action };
    if (r.status !== STATUS_OK) {
      statusExceptions.push([otherPos, r.status]);
      obj.status = r.status;
    }
    obj.summary = r.summary;
    if (r.payload_json != null) {
      let parsed;
      try { parsed = JSON.parse(r.payload_json); } catch { parsed = null; }
      if (parsed !== null) {
        if (parsed && typeof parsed === 'object'
            && 'raw_bytes' in parsed && 'compressed_bytes' in parsed
            && 'ratio' in parsed
            && Math.abs(parsed.ratio - meshRatio(parsed.raw_bytes, parsed.compressed_bytes)) < 1e-9) {
          const { ratio, ...rest } = parsed;
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
  let shapesBlob = otherReceipts.length > 0
    ? brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'))
    : brotli11(Buffer.from(''));
  shapesBlob = brotli11(shapesBlob);
  const aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
  const aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
  const otherIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));

  const statusExcBytes = [];
  for (const [pos, s] of statusExceptions) {
    statusExcBytes.push(...varintU(pos));
    const sb = Buffer.from(s, 'utf8');
    statusExcBytes.push(...varintU(sb.length));
    for (const b of sb) statusExcBytes.push(b);
  }
  statusExcBytes.push(...varintU(0xFFFFFF));
  const statusExcBr = brotli11(Buffer.from(statusExcBytes));

  const positionClass = new Uint8Array(Nw);
  for (const i of meshIdx) positionClass[i] = 1;
  const posRuns = [];
  if (Nw > 0) {
    let prev = positionClass[0], count = 1;
    for (let i = 1; i < Nw; i++) {
      if (positionClass[i] === prev) count++;
      else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; }
    }
    posRuns.push([prev, count]);
  }
  const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));

  const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: Nw, start: globalStart }), 'utf8'));

  const totalBytes = meshTplBr.length + meshDataBr.length + shapesBlob.length
                   + aIdxBr.length + aVBr.length + otherIdxBr.length
                   + posBr.length + seedR.length + statusExcBr.length;
  const encodeMs = performance.now() - tEnc0;

  // ── DECODE for roundtrip ──
  const tDec0 = performance.now();
  const meshTplDec = meshIdx.length > 0
    ? JSON.parse(zlib.brotliDecompressSync(meshTplBr).toString('utf8'))
    : { status: null, sumTpls: [], cas: [] };
  const meshDataDec = zlib.brotliDecompressSync(meshDataBr);
  const meshRecv = [];
  {
    let ofs = 0;
    while (ofs < meshDataDec.length) {
      const [sti, n1] = readVarintU(meshDataDec, ofs); ofs = n1;
      const [packet_id, n2] = readVarintU(meshDataDec, ofs); ofs = n2;
      const [raw, n3] = readVarintU(meshDataDec, ofs); ofs = n3;
      const [comp, n4] = readVarintU(meshDataDec, ofs); ofs = n4;
      const [ci, n5] = readVarintU(meshDataDec, ofs); ofs = n5;
      meshRecv.push({ sti, packet_id, raw, comp, ci });
    }
  }
  const strippedDec = otherReceipts.length > 0
    ? zlib.brotliDecompressSync(zlib.brotliDecompressSync(shapesBlob)).toString('utf8').split('\n').filter(Boolean)
    : [];
  const aIdxBuf = zlib.brotliDecompressSync(aIdxBr);
  const aIdxs = []; { let o = 0; while (o < aIdxBuf.length) { const [v, n] = readVarintU(aIdxBuf, o); aIdxs.push(v); o = n; } }
  const aVbuf = zlib.brotliDecompressSync(aVBr);
  const aVarr = aVbuf.length === 0 ? [] : aVbuf.toString('utf8').split('\x02');

  const restoredShapes = strippedDec.map((s, i) => {
    const a = aVarr[aIdxs[i]];
    const obj = JSON.parse(s);
    const ordered = { action: a, ...obj };
    return JSON.stringify(ordered);
  });

  const otherIdxBuf = zlib.brotliDecompressSync(otherIdxBr);
  const otherIdxDec = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec.push(v); o = n; } }

  const posBytes = zlib.brotliDecompressSync(posBr);
  const posClass = new Uint8Array(Nw);
  { let o = 0, idx = 0;
    while (o < posBytes.length) { const cls = posBytes[o++]; const [cnt, no] = readVarintU(posBytes, o); o = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

  const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

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
  for (let i = 0; i < Nw; i++) {
    if (posClass[i] === 1) {
      const m = meshRecv[meshCur++];
      const sumTpl = meshTplDec.sumTpls[m.sti];
      let ni = 0;
      const nums = [String(m.packet_id), String(m.raw), String(m.comp)];
      const summary = sumTpl == null || sumTpl === '\0NULL\0' ? null : sumTpl.replace(/\x01/g, () => nums[ni++]);
      const ratio = meshRatio(m.raw, m.comp);
      reconstructed.push({
        id: detId(seedDec.seed, seedDec.start + i),
        action: 'mesh.compress',
        status: meshTplDec.status,
        summary,
        payload_json: JSON.stringify({ raw_bytes: m.raw, compressed_bytes: m.comp, ratio }),
        created_at: meshTplDec.cas[m.ci],
      });
    } else {
      const otherPos = otherCur++;
      const shape = JSON.parse(restoredShapes[otherIdxDec[otherPos]]);
      const id = detId(seedDec.seed, seedDec.start + i);
      const status = ('status' in shape) ? shape.status : (statusExcMap.has(otherPos) ? statusExcMap.get(otherPos) : STATUS_OK);
      let payload_json;
      if ('payload' in shape) {
        if (shape.payload === null) payload_json = null;
        else if (shape.payload && typeof shape.payload === 'object' && shape.payload.__r === 1) {
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
        summary: shape.summary, payload_json, created_at: shape.created_at,
      };
      reconstructed.push(ordered);
    }
  }
  const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
  const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
  const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
  const lossless = recSha === detSha;
  const decodeMs = performance.now() - tDec0;

  return { totalBytes, encodeMs, decodeMs, rawBytes: detBytes.length, lossless, recJsonl };
}

// Build det-corpus reference
const detReceiptsAll = allReceipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detAllJsonl = detReceiptsAll.map(r => JSON.stringify(r)).join('\n') + '\n';
const detAllSha = crypto.createHash('sha256').update(detAllJsonl).digest('hex');

// Stream sweep at W=500
let totalEncoded = 0, totalEncMs = 0, totalDecMs = 0, totalRaw = 0;
let allLossless = true;
const concatPieces = [];
const nWindows = Math.ceil(N_TOTAL / W);
for (let start = 0; start < N_TOTAL; start += W) {
  const window = allReceipts.slice(start, start + W);
  const out = encodeWindow(window, start);
  totalEncoded += out.totalBytes;
  totalEncMs += out.encodeMs;
  totalDecMs += out.decodeMs;
  totalRaw += out.rawBytes;
  if (!out.lossless) allLossless = false;
  concatPieces.push(out.recJsonl);
}
const concat = concatPieces.join('');
const concatSha = crypto.createHash('sha256').update(concat).digest('hex');
const concatMatches = concatSha === detAllSha;
const ratio = totalRaw / totalEncoded;
const msPerReceiptEnc = totalEncMs / N_TOTAL;
const msPerReceiptDec = totalDecMs / N_TOTAL;
const lossless = allLossless && concatMatches;

console.log(`\n=== EXP 121: Streaming M19 + formula library at W=${W} ===`);
console.log(`windows:           ${nWindows}`);
console.log(`total encoded:     ${totalEncoded}`);
console.log(`raw bytes:         ${totalRaw}`);
console.log(`ratio @ W=${W}:    ${ratio.toFixed(3)}x`);
console.log(`encode_ms total:   ${totalEncMs.toFixed(1)}`);
console.log(`encode ms/receipt: ${msPerReceiptEnc.toFixed(3)}`);
console.log(`decode_ms total:   ${totalDecMs.toFixed(1)}`);
console.log(`decode ms/receipt: ${msPerReceiptDec.toFixed(3)}`);
console.log(`per-window lossless: ${allLossless}`);
console.log(`concat sha matches:  ${concatMatches}`);
console.log(`Lossless overall:    ${lossless}`);
console.log(`vs M19 (47.07x):     ${ratio > 47.07 ? `BEATS by +${(ratio-47.07).toFixed(3)}x` : `below by ${(47.07-ratio).toFixed(3)}x`}`);

const summary = {
  experiment: '121-streaming-formula',
  injection_point: 'BEFORE SHAPE_VOCAB (Exp 118 winning approach)',
  window: W,
  n_windows: nWindows,
  formula_library: ['status_ok_default', 'mesh_ratio_derivation'],
  corpus_sha256: detAllSha,
  raw_bytes: totalRaw,
  total_bytes: totalEncoded,
  ratio: Number(ratio.toFixed(4)),
  vs_m19: Number((ratio - 47.07).toFixed(4)),
  encode_ms_total: Number(totalEncMs.toFixed(2)),
  encode_ms_per_receipt: Number(msPerReceiptEnc.toFixed(4)),
  decode_ms_total: Number(totalDecMs.toFixed(2)),
  decode_ms_per_receipt: Number(msPerReceiptDec.toFixed(4)),
  per_window_lossless: allLossless,
  concat_matches_full_sha: concatMatches,
  lossless,
  verdict: lossless && msPerReceiptEnc < 1.0 ? 'GREEN' : (lossless ? 'AMBER' : 'RED'),
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
