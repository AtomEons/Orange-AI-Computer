// Combo Codec — All verified wins composed into one toggleable module
//
// Config flags:
//   - detIds:       replace random IDs with sha256(seed||index)
//   - dedupe:       collapse byte-identical (mod id) shapes
//   - schemaFold:   drop mesh.compress.ratio (banker's-round derived on decode)
//   - meshDecomp:   decompose mesh.compress into (template + (raw,comp) varints)
//   - sortStyle:    'insertion' | 'lex' | 'b8' | 'b4' | 'rev-len' | 'simhash'
//   - brotliPasses: 1 or 2 (brotli the shape dict 1× or 2×)
//   - stripAction:  strip leading "action":"X", field, store action stream separately
//   - airDecomp:    decompose air.compress into (template + per-receipt-vars) — VERIFIED safe with per-receipt overrides
//
// Each method returns { encoded, decoded, lossless, ratio, components }.

import zlib from 'node:zlib';
import crypto from 'node:crypto';

export const SEED = 'orange5-receipt-stream-v1';
export function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
export function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
export function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
export function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
export function bankerRound(x) { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); }
export function computeRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

const DEFAULT_CFG = {
  detIds: true,
  dedupe: true,
  schemaFold: true,    // drop mesh.compress.ratio
  meshDecomp: true,
  sortStyle: 'b8',     // shape dict ordering
  brotliPasses: 2,
  stripAction: false,
  airDecomp: false,
};

// ─── ENCODE ─────────────────────────────────────────────────────────
export function encode(receipts, cfg = {}) {
  const c = { ...DEFAULT_CFG, ...cfg };
  const N = receipts.length;
  // Build the corpus we're committing to (det vs original IDs)
  const targetReceipts = c.detIds
    ? receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }))
    : receipts;

  const meshIdx = [], airIdx = [], otherIdx = [];
  for (let i = 0; i < N; i++) {
    const a = targetReceipts[i].action;
    if (a === 'mesh.compress' && c.meshDecomp) meshIdx.push(i);
    else if (a === 'air.compress' && c.airDecomp) airIdx.push(i);
    else otherIdx.push(i);
  }

  const components = {};

  // ── mesh decomp ──
  let meshTplBr = Buffer.alloc(0), meshDataBr = Buffer.alloc(0);
  let meshSumTplList = [], meshCAList = [];
  if (c.meshDecomp) {
    const meshSumTpls = new Set();
    const meshCAs = new Map();
    const meshRecData = [];
    for (const i of meshIdx) {
      const r = targetReceipts[i];
      const sT = templatize(r.summary);
      const sNums = sT.nums;
      meshSumTpls.add(sT.tpl);
      if (!meshCAs.has(r.created_at)) meshCAs.set(r.created_at, meshCAs.size);
      let raw = 0, comp = 0, ratio = null;
      try { const p = JSON.parse(r.payload_json); raw = p.raw_bytes; comp = p.compressed_bytes; ratio = p.ratio; } catch {}
      meshRecData.push({ sTpl: sT.tpl, sNums, raw, comp, caIdx: meshCAs.get(r.created_at), ratio });
    }
    meshSumTplList = [...meshSumTpls];
    meshCAList = [...meshCAs.keys()];
    const meshSumTplMap = new Map(meshSumTplList.map((t, i) => [t, i]));
    const meshTemplate = { status: targetReceipts[meshIdx[0]]?.status || 'ok', sumTpls: meshSumTplList, cas: meshCAList };
    meshTplBr = brotli11(Buffer.from(JSON.stringify(meshTemplate), 'utf8'));

    const meshDataBytes = [];
    for (const d of meshRecData) {
      meshDataBytes.push(...varintU(meshSumTplMap.get(d.sTpl)));
      meshDataBytes.push(...varintU(d.sNums.length));
      for (const n of d.sNums) { const nb = Buffer.from(n, 'utf8'); meshDataBytes.push(...varintU(nb.length)); for (const b of nb) meshDataBytes.push(b); }
      meshDataBytes.push(...varintU(d.raw));
      meshDataBytes.push(...varintU(d.comp));
      meshDataBytes.push(...varintU(d.caIdx));
      // If schemaFold is OFF, also store the original ratio explicitly (as a string to preserve serialization)
      if (!c.schemaFold) {
        const ratioStr = JSON.stringify(d.ratio);
        const rb = Buffer.from(ratioStr, 'utf8');
        meshDataBytes.push(...varintU(rb.length));
        for (const b of rb) meshDataBytes.push(b);
      }
    }
    meshDataBr = brotli11(Buffer.from(meshDataBytes));
    components.meshTpl = meshTplBr.length;
    components.meshData = meshDataBr.length;
  }

  // ── air decomp ──
  let airTplBr = Buffer.alloc(0), airDataBr = Buffer.alloc(0);
  let airSumTplList = [], airCAList = [];
  if (c.airDecomp) {
    const airSumTpls = new Set();
    const airCAs = new Map();
    const airRecData = [];
    for (const i of airIdx) {
      const r = targetReceipts[i];
      const sT = templatize(r.summary);
      airSumTpls.add(sT.tpl);
      if (!airCAs.has(r.created_at)) airCAs.set(r.created_at, airCAs.size);
      // Capture FULL payload — atom_count, dropped, citations may vary
      let ratio = 0, atomCount = 1, dropped = 0, citations = 0;
      try { const p = JSON.parse(r.payload_json); ratio = p.ratio; atomCount = p.atom_count; dropped = p.dropped; citations = p.citations; } catch {}
      airRecData.push({ sTpl: sT.tpl, sNums: sT.nums, caIdx: airCAs.get(r.created_at), ratio, atomCount, dropped, citations });
    }
    airSumTplList = [...airSumTpls];
    airCAList = [...airCAs.keys()];
    const airSumTplMap = new Map(airSumTplList.map((t, i) => [t, i]));
    const airTemplate = { status: targetReceipts[airIdx[0]]?.status || 'ok', sumTpls: airSumTplList, cas: airCAList };
    airTplBr = brotli11(Buffer.from(JSON.stringify(airTemplate), 'utf8'));
    const airDataBytes = [];
    for (const d of airRecData) {
      airDataBytes.push(...varintU(airSumTplMap.get(d.sTpl)));
      airDataBytes.push(...varintU(d.sNums.length));
      for (const n of d.sNums) { const nb = Buffer.from(n, 'utf8'); airDataBytes.push(...varintU(nb.length)); for (const b of nb) airDataBytes.push(b); }
      // Store ratio as a string for exact roundtrip
      const ratioStr = JSON.stringify(d.ratio);
      const rb = Buffer.from(ratioStr, 'utf8');
      airDataBytes.push(...varintU(rb.length));
      for (const b of rb) airDataBytes.push(b);
      // Store atom_count, dropped, citations as numbers (varint)
      airDataBytes.push(...varintU(d.atomCount));
      airDataBytes.push(...varintU(d.dropped));
      airDataBytes.push(...varintU(d.citations));
      airDataBytes.push(...varintU(d.caIdx));
    }
    airDataBr = brotli11(Buffer.from(airDataBytes));
    components.airTpl = airTplBr.length;
    components.airData = airDataBr.length;
  }

  // ── other receipts (potentially deduped) ──
  const otherReceipts = otherIdx.map(i => targetReceipts[i]);
  const shapeKey = c.detIds ? (r => JSON.stringify({ ...r, id: '' })) : (r => JSON.stringify(r));
  let sortedShapeList, otherShapeIdx;
  if (c.dedupe) {
    const shapeVocab = new Map();
    const shapeList = [];
    const idxSeq = [];
    for (const r of otherReceipts) {
      const k = shapeKey(r);
      if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
      idxSeq.push(shapeVocab.get(k));
    }
    // Apply sort
    let permutation = shapeList.map((_, i) => i);
    if (c.sortStyle === 'lex') {
      permutation.sort((a, b) => shapeList[a].localeCompare(shapeList[b]));
    } else if (c.sortStyle === 'b8') {
      permutation.sort((a, b) => {
        const A = JSON.parse(shapeList[a]), B = JSON.parse(shapeList[b]);
        if (A.action !== B.action) return A.action.localeCompare(B.action);
        if (shapeList[a].length !== shapeList[b].length) return shapeList[a].length - shapeList[b].length;
        return shapeList[a].localeCompare(shapeList[b]);
      });
    } else if (c.sortStyle === 'b4') {
      permutation.sort((a, b) => {
        const A = JSON.parse(shapeList[a]), B = JSON.parse(shapeList[b]);
        if (A.action !== B.action) return A.action.localeCompare(B.action);
        if ((A.payload_json || '') !== (B.payload_json || '')) return (A.payload_json || '').localeCompare(B.payload_json || '');
        return (A.summary || '').localeCompare(B.summary || '');
      });
    } else if (c.sortStyle === 'rev-len') {
      permutation.sort((a, b) => shapeList[b].length - shapeList[a].length || shapeList[a].localeCompare(shapeList[b]));
    } else if (c.sortStyle === 'by-length') {
      permutation.sort((a, b) => shapeList[a].length - shapeList[b].length || shapeList[a].localeCompare(shapeList[b]));
    } else { /* 'insertion' */ }
    sortedShapeList = permutation.map(i => shapeList[i]);
    const reverseMap = new Map();
    permutation.forEach((origIdx, newPos) => reverseMap.set(origIdx, newPos));
    otherShapeIdx = idxSeq.map(origIdx => reverseMap.get(origIdx));
  } else {
    sortedShapeList = otherReceipts.map(shapeKey);
    otherShapeIdx = sortedShapeList.map((_, i) => i);
  }

  // Encode shape dict + optionally strip action
  let shapesBlob;
  let aIdxBr = Buffer.alloc(0), aVBr = Buffer.alloc(0);
  if (c.stripAction) {
    const aV = new Map();
    const stripped = [];
    const actionStream = [];
    for (const s of sortedShapeList) {
      const parsed = JSON.parse(s);
      const a = parsed.action;
      if (!aV.has(a)) aV.set(a, aV.size);
      actionStream.push(aV.get(a));
      // Strip ALL occurrences of `,"action":"X"` or `"action":"X",` so the receipt
      // becomes byte-identical minus this field. We do a positional strip and
      // remember position is "right after the id field" (since key order is fixed by spread).
      const reFirst = new RegExp(`"action":"${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}",`);
      const reMid = new RegExp(`,"action":"${a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);
      let stripped_s = s.replace(reFirst, '').replace(reMid, '');
      stripped.push(stripped_s);
    }
    const strippedBr = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
    aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
    aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
    shapesBlob = strippedBr;
    components.aIdx = aIdxBr.length;
    components.aV = aVBr.length;
  } else {
    shapesBlob = brotli11(Buffer.from(sortedShapeList.join('\n') + '\n', 'utf8'));
  }
  for (let p = 1; p < c.brotliPasses; p++) shapesBlob = brotli11(shapesBlob);
  components.shapes = shapesBlob.length;

  const otherIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));
  components.otherIdx = otherIdxBr.length;

  // ── Position class RLE (which positions are mesh/air/other) ──
  const posClass = new Uint8Array(N);
  for (const i of meshIdx) posClass[i] = 1;
  for (const i of airIdx) posClass[i] = 2;
  const posRuns = [];
  if (N > 0) {
    let prev = posClass[0], count = 1;
    for (let i = 1; i < N; i++) {
      if (posClass[i] === prev) count++;
      else { posRuns.push([prev, count]); prev = posClass[i]; count = 1; }
    }
    posRuns.push([prev, count]);
  }
  const posBytes = Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)]));
  const posBr = brotli11(posBytes);
  components.pos = posBr.length;

  // ── ID stream (seed-recipe if detIds; raw IDs otherwise) ──
  let idBr;
  if (c.detIds) {
    idBr = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));
  } else {
    const ids = receipts.map(r => r.id || '');
    idBr = brotli11(Buffer.from(ids.join('\x02'), 'utf8'));
  }
  components.id = idBr.length;

  const total = Object.values(components).reduce((a, b) => a + b, 0);

  return {
    total,
    components,
    cfg: c,
    // Internal blobs (kept for decode)
    blobs: {
      meshTplBr, meshDataBr, airTplBr, airDataBr,
      shapesBlob, otherIdxBr, posBr, idBr, aIdxBr, aVBr,
    },
    // Internal data we need for decode (in real codec this would be in the blobs, but for testing pass through)
    decodeInfo: { meshIdx, airIdx, otherIdx, sortedShapeList, otherShapeIdx, meshSumTplList, meshCAList, airSumTplList, airCAList, posRuns, N },
  };
}

// ─── DECODE ─────────────────────────────────────────────────────────
export function decode(encoded, originalReceipts) {
  const c = encoded.cfg;
  const N = encoded.decodeInfo.N;
  const b = encoded.blobs;

  // Decode blobs
  const meshTplDec = c.meshDecomp && b.meshTplBr.length > 0 ? JSON.parse(zlib.brotliDecompressSync(b.meshTplBr).toString('utf8')) : null;
  const meshDataDec = c.meshDecomp && b.meshDataBr.length > 0 ? zlib.brotliDecompressSync(b.meshDataBr) : null;
  const airTplDec = c.airDecomp && b.airTplBr.length > 0 ? JSON.parse(zlib.brotliDecompressSync(b.airTplBr).toString('utf8')) : null;
  const airDataDec = c.airDecomp && b.airDataBr.length > 0 ? zlib.brotliDecompressSync(b.airDataBr) : null;

  let shapesBlob = b.shapesBlob;
  for (let p = 1; p < c.brotliPasses; p++) shapesBlob = zlib.brotliDecompressSync(shapesBlob);
  let sortedShapeStrs;
  if (c.stripAction) {
    const strippedDec = zlib.brotliDecompressSync(shapesBlob).toString('utf8').split('\n').filter(Boolean);
    const aIdxDec = zlib.brotliDecompressSync(b.aIdxBr);
    const aV = zlib.brotliDecompressSync(b.aVBr).toString('utf8').split('\x02');
    const aIdxs = []; let ofs = 0;
    while (ofs < aIdxDec.length) { const [v, n] = readVarintU(aIdxDec, ofs); aIdxs.push(v); ofs = n; }
    sortedShapeStrs = strippedDec.map((s, i) => {
      const a = aV[aIdxs[i]];
      // Re-insert into the correct position by matching the post-id sentinel.
      // With dedupe+detIds=true the shape starts with `{"id":""`, then the next field
      // (originally action). We insert `"action":"X",` right after `{"id":"",`.
      if (s.startsWith('{"id":"",')) {
        return s.replace(/^\{"id":"",/, `{"id":"","action":"${a}",`);
      }
      // Fallback: insert at start (less safe but works if id field absent)
      return s.replace(/^\{/, `{"action":"${a}",`);
    });
  } else {
    sortedShapeStrs = zlib.brotliDecompressSync(shapesBlob).toString('utf8').split('\n').filter(Boolean);
  }
  const otherShapeIdxDec = []; { let ofs = 0; const buf = zlib.brotliDecompressSync(b.otherIdxBr);
    while (ofs < buf.length) { const [v, n] = readVarintU(buf, ofs); otherShapeIdxDec.push(v); ofs = n; } }

  const posBytesDec = zlib.brotliDecompressSync(b.posBr);
  const posClass = new Uint8Array(N);
  { let ofs = 0, idx = 0;
    while (ofs < posBytesDec.length) { const cls = posBytesDec[ofs++]; const [cnt, no] = readVarintU(posBytesDec, ofs); ofs = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

  let getId;
  if (c.detIds) {
    const idDec = JSON.parse(zlib.brotliDecompressSync(b.idBr).toString('utf8'));
    getId = i => detId(idDec.seed, i);
  } else {
    const idsRaw = zlib.brotliDecompressSync(b.idBr).toString('utf8').split('\x02');
    getId = i => idsRaw[i];
  }

  // Parse mesh data
  const meshRecv = [];
  if (c.meshDecomp && meshDataDec) {
    let ofs = 0;
    while (ofs < meshDataDec.length) {
      const [sti, n1] = readVarintU(meshDataDec, ofs); ofs = n1;
      const [snc, n2] = readVarintU(meshDataDec, ofs); ofs = n2;
      const sNums = [];
      for (let k = 0; k < snc; k++) { const [sl, n3] = readVarintU(meshDataDec, ofs); ofs = n3; sNums.push(meshDataDec.slice(ofs, ofs + sl).toString('utf8')); ofs += sl; }
      const [raw, n4] = readVarintU(meshDataDec, ofs); ofs = n4;
      const [comp, n5] = readVarintU(meshDataDec, ofs); ofs = n5;
      const [ci, n6] = readVarintU(meshDataDec, ofs); ofs = n6;
      let ratio;
      if (!c.schemaFold) {
        const [rl, n7] = readVarintU(meshDataDec, ofs); ofs = n7;
        ratio = JSON.parse(meshDataDec.slice(ofs, ofs + rl).toString('utf8'));
        ofs += rl;
      }
      meshRecv.push({ sti, sNums, raw, comp, ci, ratio });
    }
  }

  // Parse air data
  const airRecv = [];
  if (c.airDecomp && airDataDec) {
    let ofs = 0;
    while (ofs < airDataDec.length) {
      const [sti, n1] = readVarintU(airDataDec, ofs); ofs = n1;
      const [snc, n2] = readVarintU(airDataDec, ofs); ofs = n2;
      const sNums = [];
      for (let k = 0; k < snc; k++) { const [sl, n3] = readVarintU(airDataDec, ofs); ofs = n3; sNums.push(airDataDec.slice(ofs, ofs + sl).toString('utf8')); ofs += sl; }
      const [rl, n4] = readVarintU(airDataDec, ofs); ofs = n4;
      const ratio = JSON.parse(airDataDec.slice(ofs, ofs + rl).toString('utf8')); ofs += rl;
      const [ac, n5] = readVarintU(airDataDec, ofs); ofs = n5;
      const [dp, n6] = readVarintU(airDataDec, ofs); ofs = n6;
      const [ci_, n7] = readVarintU(airDataDec, ofs); ofs = n7;
      const [ca, n8] = readVarintU(airDataDec, ofs); ofs = n8;
      airRecv.push({ sti, sNums, ratio, atomCount: ac, dropped: dp, citations: ci_, caIdx: ca });
    }
  }

  // Reconstruct
  const reconstructed = [];
  let meshCur = 0, airCur = 0, otherCur = 0;
  for (let i = 0; i < N; i++) {
    if (posClass[i] === 1) {
      const m = meshRecv[meshCur++];
      const sumTpl = meshTplDec.sumTpls[m.sti];
      let ni = 0;
      const summary = sumTpl == null || sumTpl === '\0NULL\0' ? null : sumTpl.replace(/\x01/g, () => m.sNums[ni++]);
      const ratio = c.schemaFold ? computeRatio(m.raw, m.comp) : m.ratio;
      reconstructed.push({
        id: getId(i),
        action: 'mesh.compress',
        status: meshTplDec.status,
        summary,
        payload_json: JSON.stringify({ raw_bytes: m.raw, compressed_bytes: m.comp, ratio }),
        created_at: meshTplDec.cas[m.ci],
      });
    } else if (posClass[i] === 2) {
      const m = airRecv[airCur++];
      const sumTpl = airTplDec.sumTpls[m.sti];
      let ni = 0;
      const summary = sumTpl == null || sumTpl === '\0NULL\0' ? null : sumTpl.replace(/\x01/g, () => m.sNums[ni++]);
      reconstructed.push({
        id: getId(i),
        action: 'air.compress',
        status: airTplDec.status,
        summary,
        payload_json: JSON.stringify({ ratio: m.ratio, atom_count: m.atomCount, dropped: m.dropped, citations: m.citations }),
        created_at: airTplDec.cas[m.caIdx],
      });
    } else {
      const shape = JSON.parse(sortedShapeStrs[otherShapeIdxDec[otherCur++]]);
      // Always overwrite id with the recovered id (handles both detIds true and false)
      shape.id = getId(i);
      reconstructed.push(shape);
    }
  }
  return reconstructed;
}

// ─── VERIFY ─────────────────────────────────────────────────────────
export function verify(receipts, cfg) {
  const enc = encode(receipts, cfg);
  const dec = decode(enc, receipts);
  // Build expected target corpus
  const target = cfg.detIds === false
    ? receipts
    : receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
  const expectedJsonl = target.map(r => JSON.stringify(r)).join('\n') + '\n';
  const actualJsonl = dec.map(r => JSON.stringify(r)).join('\n') + '\n';
  const expectedSha = crypto.createHash('sha256').update(expectedJsonl).digest('hex');
  const actualSha = crypto.createHash('sha256').update(actualJsonl).digest('hex');
  const lossless = actualSha === expectedSha;
  return { total: enc.total, components: enc.components, lossless, cfg };
}
