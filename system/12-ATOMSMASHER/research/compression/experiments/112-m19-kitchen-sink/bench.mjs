// Experiment 112 — M19 KITCHEN SINK: 108 + 109 + 110 stacked together.
// Non-mesh shapes get all three augmentations applied before vocabulary dedup:
//   108: payload.ratio stripped when derivable (and key-order-restorable at decode).
//   109: summary stripped for actions with a single constant summary; restored from action->summary map.
//   110: status field elided entirely; restored as "ok" except via exception side table.
// sha256 verify against the original detBytes.

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
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

const t0 = performance.now();
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// === 109 prep: constant-summary action classes (non-mesh) ===
const actionSummaries = new Map();
for (const i of otherIdx) {
  const r = detReceipts[i];
  if (!actionSummaries.has(r.action)) actionSummaries.set(r.action, new Set());
  actionSummaries.get(r.action).add(r.summary);
}
const constantSummary = new Map();
for (const [a, set] of actionSummaries) {
  if (set.size === 1) constantSummary.set(a, [...set][0]);
}

// === 110 prep: status exceptions (status !== 'ok' for non-mesh) ===
const DEFAULT_STATUS = 'ok';
const statusExceptions = [];
otherIdx.forEach((globalI, slotI) => {
  const s = detReceipts[globalI].status;
  if (s !== DEFAULT_STATUS) statusExceptions.push([slotI, s]);
});

// Mesh path (unchanged)
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

// === Build non-mesh shapes with 108 + 109 + 110 applied ===
let ratioStripCount = 0, summaryStripCount = 0;
const otherReceipts = otherIdx.map(i => {
  const r = detReceipts[i];
  const obj = { action: r.action };  // status always elided (110)
  // 109: summary
  if (!constantSummary.has(r.action)) {
    obj.summary = r.summary;
  } else {
    summaryStripCount++;
  }
  // 108: payload ratio derivation
  if (r.payload_json != null) {
    try {
      const p = JSON.parse(r.payload_json);
      if (typeof p === 'object' && p !== null
          && 'ratio' in p && typeof p.ratio === 'number'
          && typeof p.raw_bytes === 'number' && typeof p.compressed_bytes === 'number'
          && p.compressed_bytes > 0) {
        const derived = meshRatio(p.raw_bytes, p.compressed_bytes);
        if (JSON.stringify(derived) === JSON.stringify(p.ratio)) {
          const { ratio, ...rest } = p;
          obj.payload = rest;
          obj.ratio_derived = 1;
          ratioStripCount++;
        } else {
          obj.payload = p;
        }
      } else {
        obj.payload = p;
      }
    } catch { obj.payload_raw = r.payload_json; }
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
console.log(`Other unique shapes (kitchen sink): ${unsortedShapeList.length}`);

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

// Side tables (109, 110)
const sumTplArr = [...constantSummary.entries()].map(([a, s]) => [a, s]);
const sumTplBr = brotli11(Buffer.from(JSON.stringify(sumTplArr), 'utf8'));
const statusExBr = brotli11(Buffer.from(JSON.stringify(statusExceptions), 'utf8'));

const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
const posRuns = [];
{ let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
  posRuns.push([prev, count]); }
const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));

const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length + sumTplBr.length + statusExBr.length;
const ratio = detBytes.length / total;
const encMs = performance.now() - t0;

// ── ROUNDTRIP ──
const d0 = performance.now();
const sumTplArrDec = JSON.parse(zlib.brotliDecompressSync(sumTplBr).toString('utf8'));
const sumTplMap = new Map(sumTplArrDec);
const statusExDec = JSON.parse(zlib.brotliDecompressSync(statusExBr).toString('utf8'));
const statusExMap = new Map(statusExDec);

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
  return JSON.stringify({ action: a, ...obj });
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
    const slotI = otherCur;
    const shape = JSON.parse(restoredShapes[otherIdxDec[otherCur++]]);
    const id = detId(seedDec.seed, i);
    // 110: status restoration
    const status = statusExMap.has(slotI) ? statusExMap.get(slotI) : DEFAULT_STATUS;
    // 109: summary restoration
    let summary;
    if ('summary' in shape) summary = shape.summary;
    else summary = sumTplMap.get(shape.action);
    // 108: payload ratio restoration with original key order (raw, comp, ratio, ...)
    let payload_json;
    if ('ratio_derived' in shape && shape.payload && typeof shape.payload === 'object') {
      const p = shape.payload;
      const ratio = meshRatio(p.raw_bytes, p.compressed_bytes);
      const out = {};
      for (const k of Object.keys(p)) {
        out[k] = p[k];
        if (k === 'compressed_bytes') out.ratio = ratio;
      }
      if (!('ratio' in out)) out.ratio = ratio;
      payload_json = JSON.stringify(out);
    } else if ('payload' in shape) {
      payload_json = shape.payload === null ? null : JSON.stringify(shape.payload);
    } else payload_json = shape.payload_raw;
    reconstructed.push({
      id, action: shape.action, status,
      summary, payload_json, created_at: shape.created_at
    });
  }
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const decMs = performance.now() - d0;
const lossless = recSha === detSha;

const M19 = 47.071;
const summary = {
  experiment: '112-m19-kitchen-sink',
  total_bytes: total,
  ratio: Number(ratio.toFixed(3)),
  delta_vs_m19: Number((ratio - M19).toFixed(3)),
  enc_ms: Math.round(encMs),
  dec_ms: Math.round(decMs),
  lossless,
  det_sha: detSha.slice(0, 16),
  rec_sha: recSha.slice(0, 16),
  ratio_strip_count: ratioStripCount,
  summary_strip_count: summaryStripCount,
  status_exceptions: statusExceptions.length,
  notes: `108+109+110 stacked. Ratio strips=${ratioStripCount}, summary strips=${summaryStripCount}, status exceptions=${statusExceptions.length}.`,
};
console.log(JSON.stringify(summary, null, 2));
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
