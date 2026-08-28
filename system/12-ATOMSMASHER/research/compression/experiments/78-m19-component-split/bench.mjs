// Experiment 78 — M19 component-split ablation
// Leave-one-out attribution of byte savings across the 5 components of Method 19.

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

// Deterministic baseline JSONL (target of all roundtrips)
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
const BYTES_RAW = detBytes.length;

const meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

/* ============================================================
 * Parameterized M19 pipeline.
 * Flags select which component to disable (false = disabled).
 * ============================================================ */
function runM19({ MESH_DECOMP=true, SHAPE_VOCAB=true, ACTION_STRIP=true, B8_SORT=true, BROTLI_X2=true } = {}) {
  const out = { parts: {}, total: 0, ratio: 0, lossless: false };

  // === position-class run-length stream (always present, no ablation flag) ===
  const positionClass = new Uint8Array(N);
  // we still classify mesh.compress vs other for position, because reconstruction depends on it
  // (when MESH_DECOMP is OFF we still classify, but mesh receipts ride the shape path)
  if (MESH_DECOMP) {
    for (const i of meshIdx) positionClass[i] = 1;
  }
  const posRuns = [];
  { let prev = positionClass[0], count = 1;
    for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
    posRuns.push([prev, count]); }
  const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));
  out.parts.pos = posBr.length;

  // === seed (always present) ===
  const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));
  out.parts.seed = seedR.length;

  let meshRecvCarrier = null;        // for roundtrip
  let meshTplDec = null;

  // === MESH path ===
  if (MESH_DECOMP) {
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
    out.parts.meshTpl = meshTplBr.length;
    out.parts.meshData = meshDataBr.length;

    // pre-stage decoded mesh records for roundtrip
    meshTplDec = meshTemplate;
    meshRecvCarrier = meshRecData.map(d => ({ sti: meshSumTplMap.get(d.sTpl), packet_id: d.packet_id, raw: d.raw, comp: d.comp, ci: d.caIdx }));
  }

  // === Shape path (carries mesh receipts too when MESH_DECOMP=false) ===
  const shapeIdx = MESH_DECOMP ? otherIdx : Array.from({ length: N }, (_, i) => i);
  const shapeReceipts = shapeIdx.map(i => {
    const r = detReceipts[i];
    const obj = { action: r.action, status: r.status, summary: r.summary };
    if (r.payload_json != null) {
      try { obj.payload = JSON.parse(r.payload_json); } catch { obj.payload_raw = r.payload_json; }
    } else obj.payload = null;
    obj.created_at = r.created_at;
    return obj;
  });
  const shapeKey = r => JSON.stringify(r);
  const allShapeKeys = shapeReceipts.map(shapeKey);

  let stripped, actionStream, aV, aVBr, aIdxBr;
  let shapesBlob;
  let shapeListForDecode;       // sorted/unsorted shape list (post-action-strip if applied)
  let perReceiptShapeIdx;       // shape-idx stream

  if (SHAPE_VOCAB) {
    // Dedupe -> vocab + per-receipt index
    const unsortedShapeVocab = new Map();
    const unsortedShapeList = [];
    for (const k of allShapeKeys) {
      if (!unsortedShapeVocab.has(k)) { unsortedShapeVocab.set(k, unsortedShapeList.length); unsortedShapeList.push(k); }
    }

    let shapeListOrdered;
    if (B8_SORT) {
      const indexed = unsortedShapeList.map((s, i) => ({ s, i, p: JSON.parse(s) }));
      indexed.sort((a, b) => {
        if (a.p.action !== b.p.action) return a.p.action.localeCompare(b.p.action);
        if (a.s.length !== b.s.length) return a.s.length - b.s.length;
        return a.s.localeCompare(b.s);
      });
      shapeListOrdered = indexed.map(x => x.s);
    } else {
      shapeListOrdered = unsortedShapeList;
    }
    const sortedShapeIdx = new Map();
    shapeListOrdered.forEach((s, i) => sortedShapeIdx.set(s, i));
    perReceiptShapeIdx = allShapeKeys.map(k => sortedShapeIdx.get(k));

    if (ACTION_STRIP) {
      aV = new Map();
      stripped = [];
      actionStream = [];
      for (const s of shapeListOrdered) {
        const parsed = JSON.parse(s);
        const a = parsed.action;
        if (!aV.has(a)) aV.set(a, aV.size);
        actionStream.push(aV.get(a));
        const { action, ...rest } = parsed;
        stripped.push(JSON.stringify(rest));
      }
      shapesBlob = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
      if (BROTLI_X2) shapesBlob = brotli11(shapesBlob);
      aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
      aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
      out.parts.shapes = shapesBlob.length;
      out.parts.aIdx = aIdxBr.length;
      out.parts.aV = aVBr.length;
    } else {
      // no action strip: keep shapes intact in the blob
      const joined = shapeListOrdered.join('\n') + '\n';
      shapesBlob = brotli11(Buffer.from(joined, 'utf8'));
      if (BROTLI_X2) shapesBlob = brotli11(shapesBlob);
      out.parts.shapes = shapesBlob.length;
    }
    const otherIdxBr = brotli11(Buffer.from(perReceiptShapeIdx.flatMap(varintU)));
    out.parts.shapeIdx = otherIdxBr.length;
    shapeListForDecode = shapeListOrdered;
  } else {
    // SHAPE_VOCAB OFF: no dedupe, no index. Concatenate per-receipt shapes.
    let joined;
    if (ACTION_STRIP) {
      aV = new Map();
      stripped = [];
      actionStream = [];
      for (const k of allShapeKeys) {
        const parsed = JSON.parse(k);
        const a = parsed.action;
        if (!aV.has(a)) aV.set(a, aV.size);
        actionStream.push(aV.get(a));
        const { action, ...rest } = parsed;
        stripped.push(JSON.stringify(rest));
      }
      shapesBlob = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
      if (BROTLI_X2) shapesBlob = brotli11(shapesBlob);
      aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
      aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
      out.parts.shapes = shapesBlob.length;
      out.parts.aIdx = aIdxBr.length;
      out.parts.aV = aVBr.length;
    } else {
      joined = allShapeKeys.join('\n') + '\n';
      shapesBlob = brotli11(Buffer.from(joined, 'utf8'));
      if (BROTLI_X2) shapesBlob = brotli11(shapesBlob);
      out.parts.shapes = shapesBlob.length;
    }
    // no shapeIdx (no dedupe table to index into)
  }

  // === Total ===
  let total = 0;
  for (const k of Object.keys(out.parts)) total += out.parts[k];
  out.total = total;
  out.ratio = BYTES_RAW / total;

  /* === ROUNDTRIP ===
   * Only attempt when full pipeline so we can confirm lossless on baseline.
   * For ablations we just check whether the decode would, in principle, still
   * yield the exact bytes. We perform full decode for every variant.
   */
  try {
    // mesh decode
    let meshRecv = [], meshTpl = meshTplDec;
    if (MESH_DECOMP) {
      meshRecv = meshRecvCarrier;
    }

    // shapes decode
    let shapeListDec = [];
    if (BROTLI_X2) {
      shapeListDec = zlib.brotliDecompressSync(zlib.brotliDecompressSync(shapesBlob)).toString('utf8').split('\n').filter(Boolean);
    } else {
      shapeListDec = zlib.brotliDecompressSync(shapesBlob).toString('utf8').split('\n').filter(Boolean);
    }

    let restoredShapes;
    if (ACTION_STRIP) {
      const aIdxBuf = zlib.brotliDecompressSync(aIdxBr);
      const aIdxs = []; { let o = 0; while (o < aIdxBuf.length) { const [v, n] = readVarintU(aIdxBuf, o); aIdxs.push(v); o = n; } }
      const aVarr = zlib.brotliDecompressSync(aVBr).toString('utf8').split('\x02');
      restoredShapes = shapeListDec.map((s, i) => {
        const a = aVarr[aIdxs[i]];
        const obj = JSON.parse(s);
        const ordered = { action: a, ...obj };
        return JSON.stringify(ordered);
      });
    } else {
      restoredShapes = shapeListDec.slice();
    }

    let perReceiptIdxDec = null;
    if (SHAPE_VOCAB) {
      const otherIdxBuf = zlib.brotliDecompressSync(brotli11(Buffer.from(perReceiptShapeIdx.flatMap(varintU))));
      perReceiptIdxDec = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); perReceiptIdxDec.push(v); o = n; } }
    }

    const posBytes = zlib.brotliDecompressSync(posBr);
    const posClass = new Uint8Array(N);
    { let o = 0, idx = 0;
      while (o < posBytes.length) { const cls = posBytes[o++]; const [cnt, no] = readVarintU(posBytes, o); o = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

    const reconstructed = [];
    let meshCur = 0, otherCur = 0;
    for (let i = 0; i < N; i++) {
      if (MESH_DECOMP && posClass[i] === 1) {
        const m = meshRecv[meshCur++];
        const sumTpl = meshTpl.sumTpls[m.sti];
        let ni = 0;
        const nums = [String(m.packet_id), String(m.raw), String(m.comp)];
        const summary = sumTpl == null || sumTpl === '\0NULL\0' ? null : sumTpl.replace(/\x01/g, () => nums[ni++]);
        const ratio = meshRatio(m.raw, m.comp);
        reconstructed.push({
          id: detId(SEED, i),
          action: 'mesh.compress',
          status: meshTpl.status,
          summary,
          payload_json: JSON.stringify({ raw_bytes: m.raw, compressed_bytes: m.comp, ratio }),
          created_at: meshTpl.cas[m.ci],
        });
      } else {
        const shapeStr = SHAPE_VOCAB ? restoredShapes[perReceiptIdxDec[otherCur++]] : restoredShapes[otherCur++];
        const shape = JSON.parse(shapeStr);
        const id = detId(SEED, i);
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
    out.lossless = recSha === detSha;
  } catch (e) {
    out.lossless = false;
    out.error = e.message;
  }

  return out;
}

/* ============================================================
 * Run baseline + 5 leave-one-out ablations
 * ============================================================ */
const baseline = runM19({});
console.log(`\n=== BASELINE (full M19) ===`);
console.log(`bytes: ${baseline.total}  ratio: ${baseline.ratio.toFixed(3)}x  lossless: ${baseline.lossless}`);
console.log(`parts:`, baseline.parts);

const variants = [
  { name: 'MESH_DECOMP',   flags: { MESH_DECOMP: false } },
  { name: 'SHAPE_VOCAB',   flags: { SHAPE_VOCAB: false } },
  { name: 'ACTION_STRIP',  flags: { ACTION_STRIP: false } },
  { name: 'B8_SORT',       flags: { B8_SORT: false } },
  { name: 'BROTLI_X2',     flags: { BROTLI_X2: false } },
];

const rows = [];
const totalSaving = BYTES_RAW - baseline.total;
for (const v of variants) {
  const r = runM19(v.flags);
  const bytesSaved = r.total - baseline.total; // disabling => grows => positive = the component saved that many bytes
  const pctOfTotal = (bytesSaved / totalSaving) * 100;
  console.log(`\n--- without ${v.name} ---`);
  console.log(`bytes: ${r.total}  ratio: ${r.ratio.toFixed(3)}x  lossless: ${r.lossless}`);
  console.log(`bytes_saved_by_${v.name}: ${bytesSaved}  (${pctOfTotal.toFixed(1)}% of total saving)`);
  rows.push({ component: v.name, bytes_without: r.total, ratio_without: Number(r.ratio.toFixed(3)), bytes_saved: bytesSaved, pct_of_total: Number(pctOfTotal.toFixed(1)), roundtrip: r.lossless, error: r.error });
}

const summary = {
  experiment: '78-m19-component-split',
  corpus_bytes_raw: BYTES_RAW,
  corpus_receipts: N,
  corpus_sha256_prefix: '5be5f1b4',
  baseline: { bytes: baseline.total, ratio: Number(baseline.ratio.toFixed(3)), lossless: baseline.lossless, parts: baseline.parts },
  total_saving_bytes: totalSaving,
  components: rows,
};

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));

/* === Print the attribution table === */
console.log(`\n\n=== COMPONENT ATTRIBUTION TABLE ===`);
console.log(`Raw bytes: ${BYTES_RAW}   Baseline M19 bytes: ${baseline.total}   Total saving: ${totalSaving}`);
console.log(`| Component    | Bytes saved | % of total | Roundtrip |`);
console.log(`|--------------|------------:|-----------:|-----------|`);
for (const r of rows) {
  console.log(`| ${r.component.padEnd(12)} | ${String(r.bytes_saved).padStart(11)} | ${(r.pct_of_total.toFixed(1)+'%').padStart(10)} | ${r.roundtrip ? 'yes' : 'no'}`);
}
