// Experiment 80 — M19 Okazaki window-size latency curve
//
// Architectural question: in a trifurcated codec (hot append-log + minute-batched
// Okazaki compactor), can the full M19 pipeline run on small windows fast enough
// that compression is invisible behind real-time writes?
//
// Procedure:
//   1. Encode the full 6,224-receipt corpus with M19 (baseline reference).
//   2. For each window W in {50, 100, 200, 500, 1000, all}:
//        chunk corpus → encode each chunk with the same M19 pipeline as one
//        independent compaction unit → sum bytes, sum encode_ms, sha-verify
//        roundtrip on every window.
//   3. Compute ratio_W, ms/receipt, vs-full delta, knee location.

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

// ── shared codec primitives (identical to M19 bench.mjs) ──
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function bankerRound(x) { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); }
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

/**
 * Run the full M19 codec on a window of receipts.
 *
 * @param {Array}  rawWindow  - the original receipt objects for this window
 * @param {number} globalStart - index of rawWindow[0] in the full corpus (for id derivation)
 * @returns {{ totalBytes, encodeMs, rawBytes, lossless }}
 *
 * The codec is identical in structure to experiment 59 (M19). Each window
 * carries its own mesh vocab, shape vocab, and position-class run-list; nothing
 * is shared across windows. That is what the Okazaki compactor model requires:
 * each minute-batched chunk must be self-contained so it can be sealed and
 * indexed independently.
 */
function encodeWindowM19(rawWindow, globalStart) {
  const t0 = performance.now();

  // ── deterministic ids derived from global position (matches M19) ──
  const detReceipts = rawWindow.map((r, i) => ({ ...r, id: detId(SEED, globalStart + i) }));
  const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
  const detBytes = Buffer.from(detJsonl, 'utf8');
  const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
  const Nw = detReceipts.length;

  // ── split mesh.compress vs other ──
  const meshIdx = [], otherIdx = [];
  for (let i = 0; i < Nw; i++) {
    if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
  }

  // ── mesh decomp (Method 14 form) ──
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

  // empty mesh window → still emit a tiny template stub so the decoder shape is uniform
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

  // ── other receipts (strip id) ──
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
  const otherShapeIdx = otherReceipts.map(r => sortedShapeIdx.get(shapeKey(r)));

  // stripAction (object-level)
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

  // ── position class run-list ──
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

  // ── seed metadata (carries global offset so ids reconstruct) ──
  const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: Nw, start: globalStart }), 'utf8'));

  const totalBytes = meshTplBr.length + meshDataBr.length + shapesBlob.length
                   + aIdxBr.length + aVBr.length + otherIdxBr.length
                   + posBr.length + seedR.length;

  const encodeMs = performance.now() - t0;

  // ── ROUNDTRIP (decoder mirrors M19 exactly) ──
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
  const aIdxs = [];
  { let o = 0; while (o < aIdxBuf.length) { const [v, n] = readVarintU(aIdxBuf, o); aIdxs.push(v); o = n; } }
  const aVbuf = zlib.brotliDecompressSync(aVBr);
  const aVarr = aVbuf.length === 0 ? [] : aVbuf.toString('utf8').split('\x02');

  const restoredShapes = strippedDec.map((s, i) => {
    const a = aVarr[aIdxs[i]];
    const obj = JSON.parse(s);
    const ordered = { action: a, ...obj };
    return JSON.stringify(ordered);
  });
  const otherIdxBuf = zlib.brotliDecompressSync(otherIdxBr);
  const otherIdxDec = [];
  { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec.push(v); o = n; } }

  const posBytes = zlib.brotliDecompressSync(posBr);
  const posClass = new Uint8Array(Nw);
  {
    let o = 0, idx = 0;
    while (o < posBytes.length) {
      const cls = posBytes[o++];
      const [cnt, no] = readVarintU(posBytes, o); o = no;
      for (let j = 0; j < cnt; j++) posClass[idx++] = cls;
    }
  }
  const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

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
      const shape = JSON.parse(restoredShapes[otherIdxDec[otherCur++]]);
      const id = detId(seedDec.seed, seedDec.start + i);
      let payload_json;
      if ('payload' in shape) payload_json = shape.payload === null ? null : JSON.stringify(shape.payload);
      else payload_json = shape.payload_raw;
      const ordered = {
        id, action: shape.action, status: shape.status,
        summary: shape.summary, payload_json, created_at: shape.created_at,
      };
      reconstructed.push(ordered);
    }
  }
  const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
  const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
  const lossless = recSha === detSha;

  return {
    totalBytes,
    encodeMs,
    rawBytes: detBytes.length,
    lossless,
    reconstructedJsonl: recJsonl,
  };
}

// ── 1. baseline: full corpus as a single "window" ──
const baseline = encodeWindowM19(allReceipts, 0);
const ratioFull = baseline.rawBytes / baseline.totalBytes;
const msPerReceiptFull = baseline.encodeMs / N_TOTAL;

// Build the canonical det-corpus jsonl + sha so window roundtrips can chain back to it
const detReceiptsAll = allReceipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detAllJsonl = detReceiptsAll.map(r => JSON.stringify(r)).join('\n') + '\n';
const detAllSha = crypto.createHash('sha256').update(detAllJsonl).digest('hex');

// ── 2. window sweep ──
const WINDOWS = [50, 100, 200, 500, 1000];
const results = [];

for (const W of WINDOWS) {
  let totalEncoded = 0;
  let totalMs = 0;
  let totalRaw = 0;
  let allLossless = true;
  const concatPieces = [];

  for (let start = 0; start < N_TOTAL; start += W) {
    const window = allReceipts.slice(start, start + W);
    const out = encodeWindowM19(window, start);
    totalEncoded += out.totalBytes;
    totalMs += out.encodeMs;
    totalRaw += out.rawBytes;
    if (!out.lossless) allLossless = false;
    concatPieces.push(out.reconstructedJsonl);
  }

  // verify concatenation matches the full det corpus byte-exactly
  const concat = concatPieces.join('');
  const concatSha = crypto.createHash('sha256').update(concat).digest('hex');
  const concatMatches = concatSha === detAllSha;

  const ratioW = totalRaw / totalEncoded;
  results.push({
    W,
    nWindows: Math.ceil(N_TOTAL / W),
    receiptsPerWindow: W,
    encodedBytes: totalEncoded,
    rawBytes: totalRaw,
    ratio: ratioW,
    vsFullRatioDelta: ratioW - ratioFull,
    encodeMsTotal: totalMs,
    msPerReceipt: totalMs / N_TOTAL,
    perWindowLossless: allLossless,
    concatMatchesFullSha: concatMatches,
    roundtrip: allLossless && concatMatches,
  });
}

// ── 3. assemble + emit table ──
const rows = [];
for (const r of results) {
  rows.push({
    W: String(r.W),
    receipts: String(r.receiptsPerWindow),
    ratio: r.ratio.toFixed(2) + 'x',
    vsFull: (r.vsFullRatioDelta >= 0 ? '+' : '') + r.vsFullRatioDelta.toFixed(2),
    encodeMs: r.encodeMsTotal.toFixed(0),
    msPerReceipt: r.msPerReceipt.toFixed(3) + ' ms',
    roundtrip: r.roundtrip ? 'yes' : 'NO',
  });
}
rows.push({
  W: 'all',
  receipts: String(N_TOTAL),
  ratio: ratioFull.toFixed(2) + 'x',
  vsFull: '0.00',
  encodeMs: baseline.encodeMs.toFixed(0) + ' (ref)',
  msPerReceipt: msPerReceiptFull.toFixed(3) + ' ms (ref)',
  roundtrip: baseline.lossless ? 'yes' : 'NO',
});

console.log('');
console.log('| Window W | Receipts/window | Ratio | vs M19 full | encode_ms total | ms/receipt | Roundtrip |');
console.log('|---:|---:|---:|---:|---:|---:|---|');
for (const r of rows) {
  console.log(`| ${r.W} | ${r.receipts} | ${r.ratio} | ${r.vsFull} | ${r.encodeMs} | ${r.msPerReceipt} | ${r.roundtrip} |`);
}

// ── 4. knee detection: smallest W where ratio loss <5% AND ms/receipt <1.0 ──
const RATIO_LOSS_PCT = 5.0;
const MS_PER_RECEIPT_CAP = 1.0;
const ratioCap = ratioFull * (1 - RATIO_LOSS_PCT / 100);
let knee = null;
for (const r of results) {
  const passRatio = r.ratio >= ratioCap;
  const passLatency = r.msPerReceipt < MS_PER_RECEIPT_CAP;
  if (passRatio && passLatency) { knee = r; break; }
}
if (knee) {
  const lossPct = ((ratioFull - knee.ratio) / ratioFull) * 100;
  console.log(`\nknee at W=${knee.W} (ratio loss ${lossPct.toFixed(2)}% < ${RATIO_LOSS_PCT}% AND ms/receipt ${knee.msPerReceipt.toFixed(3)} < ${MS_PER_RECEIPT_CAP})`);
} else {
  // pick smallest W meeting just the latency cap, report the ratio loss it imposes
  let fallback = null;
  for (const r of results) {
    if (r.msPerReceipt < MS_PER_RECEIPT_CAP) { fallback = r; break; }
  }
  if (fallback) {
    const lossPct = ((ratioFull - fallback.ratio) / ratioFull) * 100;
    console.log(`\nknee at W=${fallback.W} (ratio loss ${lossPct.toFixed(2)}% AND ms/receipt ${fallback.msPerReceipt.toFixed(3)} < ${MS_PER_RECEIPT_CAP})`);
  } else {
    console.log(`\nknee: none of the swept windows meet ms/receipt < ${MS_PER_RECEIPT_CAP}; smallest W needs a faster codec.`);
  }
}

// ── 5. summary.json ──
const summary = {
  experiment: '80-m19-okazaki-latency',
  corpus: {
    path: CORPUS,
    receipts: N_TOTAL,
    rawDetBytes: detAllJsonl.length,
    sha256: detAllSha,
  },
  baseline: {
    method: 'M19 (experiment 59)',
    ratio: Number(ratioFull.toFixed(4)),
    encodeMsTotal: Number(baseline.encodeMs.toFixed(2)),
    msPerReceipt: Number(msPerReceiptFull.toFixed(4)),
    lossless: baseline.lossless,
  },
  sweep: results.map(r => ({
    W: r.W,
    nWindows: r.nWindows,
    ratio: Number(r.ratio.toFixed(4)),
    vsFullRatioDelta: Number(r.vsFullRatioDelta.toFixed(4)),
    encodeMsTotal: Number(r.encodeMsTotal.toFixed(2)),
    msPerReceipt: Number(r.msPerReceipt.toFixed(4)),
    encodedBytes: r.encodedBytes,
    perWindowLossless: r.perWindowLossless,
    concatMatchesFullSha: r.concatMatchesFullSha,
    roundtrip: r.roundtrip,
  })),
  knee: knee ? { W: knee.W, ratioLossPct: Number(((ratioFull - knee.ratio) / ratioFull * 100).toFixed(2)), msPerReceipt: Number(knee.msPerReceipt.toFixed(4)) } : null,
  kneeCriteria: { ratioLossPct: RATIO_LOSS_PCT, msPerReceiptCap: MS_PER_RECEIPT_CAP },
  generated_at: new Date().toISOString(),
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
