// Experiment 122 — Cold-start codec with formula library
//
// Same encoder as Exp 118 (winning injection point: BEFORE SHAPE_VOCAB), but
// run with explicit cold-start semantics: every call starts fresh with no
// preserved state (no warm caches, no shared dictionaries, no prior brotli
// context). Measures the per-call overhead introduced by header writes,
// vocab construction, and brotli init compared to the amortization the
// streaming codec (Exp 121) gets across many windows.
//
// Procedure:
//   1. Run K=5 cold encodes of the full 6,224-receipt corpus.
//   2. Force GC between runs (best-effort: explicit array drops, no warm state).
//   3. Report mean/median encode_ms, decode_ms, and the (constant) ratio.
//   4. Compute "header overhead" as (cold_encode_ms - amortized_streaming) per
//      receipt, exposing the cost of starting fresh vs the W=500 amortization.
//
// Streaming amortization baseline is read from Exp 121's summary.json so the
// comparison is apples-to-apples (same machine, same Bun version, same corpus).

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const EXP121_SUMMARY = path.resolve(ROOT, '../121-streaming-formula/summary.json');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const allReceipts = lines.map(l => JSON.parse(l));
const N = allReceipts.length;
const SEED = 'orange5-receipt-stream-v1';
const K = 5; // cold-start repetition count

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function bankerRound(x) { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); }
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }
const STATUS_OK = 'ok';

function coldEncodeDecode(receipts) {
  // Encode
  const tE0 = performance.now();
  const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
  const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
  const detBytes = Buffer.from(detJsonl, 'utf8');
  const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

  const meshIdx = [], otherIdx = [];
  for (let i = 0; i < N; i++) {
    if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
  }

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

  // Formula injection BEFORE SHAPE_VOCAB
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
        } else { obj.payload = parsed; }
      } else { obj.payload_raw = r.payload_json; }
    } else { obj.payload = null; }
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
  let shapesBlob = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
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

  const positionClass = new Uint8Array(N);
  for (const i of meshIdx) positionClass[i] = 1;
  const posRuns = [];
  { let prev = positionClass[0], count = 1;
    for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
    posRuns.push([prev, count]); }
  const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));

  const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

  const total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length + statusExcBr.length;
  const encodeMs = performance.now() - tE0;

  // Decode (also cold)
  const tD0 = performance.now();
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
      reconstructed.push({
        id, action: shape.action, status,
        summary: shape.summary, payload_json, created_at: shape.created_at
      });
    }
  }
  const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
  const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
  const lossless = recSha === detSha;
  const decodeMs = performance.now() - tD0;

  return { total, encodeMs, decodeMs, lossless, rawBytes: detBytes.length };
}

const runs = [];
for (let k = 0; k < K; k++) {
  // best-effort cold-start: trigger GC suggestion by clearing any stale refs
  if (global.gc) global.gc();
  const out = coldEncodeDecode(allReceipts);
  runs.push(out);
}

const median = (arr) => { const s = [...arr].sort((a,b)=>a-b); return s.length % 2 ? s[(s.length-1)/2] : (s[s.length/2-1] + s[s.length/2])/2; };
const mean = (arr) => arr.reduce((a,b)=>a+b,0)/arr.length;
const encodeMsList = runs.map(r => r.encodeMs);
const decodeMsList = runs.map(r => r.decodeMs);
const ratio = runs[0].rawBytes / runs[0].total;
const meanEnc = mean(encodeMsList);
const medEnc = median(encodeMsList);
const meanDec = mean(decodeMsList);
const medDec = median(decodeMsList);
const allLossless = runs.every(r => r.lossless);

// Streaming amortization baseline (Exp 121)
let streamingEncMsPerReceipt = null;
let streamingRatio = null;
try {
  const s = JSON.parse(fs.readFileSync(EXP121_SUMMARY, 'utf8'));
  streamingEncMsPerReceipt = s.encode_ms_per_receipt;
  streamingRatio = s.ratio;
} catch (e) { /* not yet run */ }

const coldMsPerReceipt = meanEnc / N;
const headerOverheadMs = streamingEncMsPerReceipt != null ? (coldMsPerReceipt - streamingEncMsPerReceipt) * N : null;

console.log(`\n=== EXP 122: Cold-start codec with formula library (K=${K} runs) ===`);
console.log(`encode_ms (mean):   ${meanEnc.toFixed(1)}`);
console.log(`encode_ms (median): ${medEnc.toFixed(1)}`);
console.log(`decode_ms (mean):   ${meanDec.toFixed(1)}`);
console.log(`decode_ms (median): ${medDec.toFixed(1)}`);
console.log(`ratio (constant):   ${ratio.toFixed(3)}x`);
console.log(`encode ms/receipt:  ${coldMsPerReceipt.toFixed(3)}`);
if (streamingEncMsPerReceipt != null) {
  console.log(`streaming ms/receipt (W=500, Exp 121): ${streamingEncMsPerReceipt.toFixed(3)}`);
  console.log(`header overhead (cold - amortized) total: ${headerOverheadMs.toFixed(1)} ms`);
  console.log(`header overhead per receipt: ${(coldMsPerReceipt - streamingEncMsPerReceipt).toFixed(3)} ms`);
}
console.log(`Lossless: ${allLossless}`);
console.log(`vs M19 (47.07x): ${ratio > 47.07 ? `BEATS by +${(ratio-47.07).toFixed(3)}x` : `below by ${(47.07-ratio).toFixed(3)}x`}`);

const summary = {
  experiment: '122-cold-start',
  injection_point: 'BEFORE SHAPE_VOCAB (Exp 118 winning approach, cold per call)',
  formula_library: ['status_ok_default', 'mesh_ratio_derivation'],
  K_runs: K,
  raw_bytes: runs[0].rawBytes,
  total_bytes: runs[0].total,
  ratio: Number(ratio.toFixed(4)),
  vs_m19: Number((ratio - 47.07).toFixed(4)),
  encode_ms_mean: Number(meanEnc.toFixed(2)),
  encode_ms_median: Number(medEnc.toFixed(2)),
  encode_ms_per_receipt: Number(coldMsPerReceipt.toFixed(4)),
  decode_ms_mean: Number(meanDec.toFixed(2)),
  decode_ms_median: Number(medDec.toFixed(2)),
  decode_ms_per_receipt: Number((meanDec / N).toFixed(4)),
  streaming_baseline_ms_per_receipt: streamingEncMsPerReceipt,
  streaming_baseline_ratio: streamingRatio,
  header_overhead_total_ms: headerOverheadMs,
  header_overhead_per_receipt_ms: streamingEncMsPerReceipt != null ? Number((coldMsPerReceipt - streamingEncMsPerReceipt).toFixed(4)) : null,
  lossless_all_runs: allLossless,
  runs: runs.map((r, i) => ({
    k: i, encode_ms: Number(r.encodeMs.toFixed(2)),
    decode_ms: Number(r.decodeMs.toFixed(2)),
    lossless: r.lossless,
  })),
  verdict: allLossless && ratio >= 47.07 ? 'GREEN' : (allLossless ? 'AMBER' : 'RED'),
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
