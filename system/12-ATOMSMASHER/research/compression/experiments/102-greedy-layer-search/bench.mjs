// Experiment 102 — Greedy combinatorial M19 layer search.
// M19 has 5 conceptual layers on top of base seed/pos/aV:
//   L1 mesh:    mesh-receipt separation & template/data split (vs leaving mesh in shape vocab)
//   L2 shape:   shape vocab dedup + sort + index
//   L3 action:  strip action key from object, encode action stream + vocab separately
//   L4 B8:      stripEmptyId — drop empty "id":"" placeholder (M19's add over M18)
//   L5 brotli2: second brotli pass on shapesBlob
//
// Without L2 the shape index degenerates; we still produce a valid encoder by emitting
// the raw concatenated shapes blob and skipping the index. All 31 non-empty subsets tested.

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

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const LAYERS = ['mesh', 'shape', 'action', 'B8', 'brotli2'];
// flags: each subset = bitmask 0..31, 0 excluded since "non-empty"
// L1 mesh: separate mesh.compress receipts into template/data streams
// L2 shape: dedup shapes + sorted index
// L3 action: strip action key from shape objects + separate action stream + vocab
// L4 B8: omit empty id placeholder when building shape object (drop id if r.id === '')
// L5 brotli2: second brotli pass on shapesBlob

// All other receipts share these helpers regardless of subset:
function buildEncoded(layerSet) {
  const useMesh = layerSet.has('mesh');
  const useShape = layerSet.has('shape');
  const useAction = layerSet.has('action');
  const useB8 = layerSet.has('B8');
  const useBrotli2 = layerSet.has('brotli2');

  const tEnc0 = performance.now();

  let meshIdx = [], otherIdx = [];
  if (useMesh) {
    for (let i = 0; i < N; i++) {
      if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
    }
  } else {
    // all receipts go through 'other' pipe — including mesh.compress
    for (let i = 0; i < N; i++) otherIdx.push(i);
  }

  let meshTplBr = Buffer.alloc(0), meshDataBr = Buffer.alloc(0);
  let meshTemplate = null, meshSumTplMap = null, meshRecData = [];
  if (useMesh && meshIdx.length > 0) {
    const meshSumTpls = new Set();
    const meshCAs = new Map();
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
    meshSumTplMap = new Map(meshSumTplList.map((t, i) => [t, i]));
    meshTemplate = { status: detReceipts[meshIdx[0]].status, sumTpls: meshSumTplList, cas: [...meshCAs.keys()] };
    meshTplBr = brotli11(Buffer.from(JSON.stringify(meshTemplate), 'utf8'));
    const meshDataBytes = [];
    for (const d of meshRecData) {
      meshDataBytes.push(...varintU(meshSumTplMap.get(d.sTpl)));
      meshDataBytes.push(...varintU(d.packet_id));
      meshDataBytes.push(...varintU(d.raw));
      meshDataBytes.push(...varintU(d.comp));
      meshDataBytes.push(...varintU(d.caIdx));
    }
    meshDataBr = brotli11(Buffer.from(meshDataBytes));
  }

  // Build "other" shapes. If !useB8, keep the id field literally in the shape (with empty value when present).
  // If useB8, drop the id from the shape key entirely (M19's behavior).
  const otherReceipts = otherIdx.map(i => {
    const r = detReceipts[i];
    const obj = {};
    if (!useB8) obj.id = r.id; // keep id explicitly => big vocab, M16-style
    obj.action = r.action;
    obj.status = r.status;
    obj.summary = r.summary;
    if (r.payload_json != null) {
      try { obj.payload = JSON.parse(r.payload_json); } catch { obj.payload_raw = r.payload_json; }
    } else obj.payload = null;
    obj.created_at = r.created_at;
    return obj;
  });

  const shapeKey = r => JSON.stringify(r);

  let shapesBlob = Buffer.alloc(0);
  let aIdxBr = Buffer.alloc(0), aVBr = Buffer.alloc(0);
  let otherIdxBr = Buffer.alloc(0);
  let sortedShapeList = null;
  let aV = null;

  if (useShape) {
    // dedup + sort
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
    sortedShapeList = indexed.map(x => x.s);
    const sortedShapeIdx = new Map();
    sortedShapeList.forEach((s, i) => sortedShapeIdx.set(s, i));
    const otherShapeIdx = otherReceipts.map(r => sortedShapeIdx.get(shapeKey(r)));

    let stripped;
    if (useAction) {
      aV = new Map();
      stripped = [];
      const actionStream = [];
      for (const s of sortedShapeList) {
        const parsed = JSON.parse(s);
        const a = parsed.action;
        if (!aV.has(a)) aV.set(a, aV.size);
        actionStream.push(aV.get(a));
        const { action, ...rest } = parsed;
        stripped.push(JSON.stringify(rest));
      }
      aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
      aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
    } else {
      stripped = sortedShapeList;
    }
    shapesBlob = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
    if (useBrotli2) shapesBlob = brotli11(shapesBlob);
    otherIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));
  } else {
    // No shape dedup — emit one shape per receipt directly. Action strip still possible.
    let stripped;
    if (useAction) {
      aV = new Map();
      stripped = [];
      const actionStream = [];
      for (const r of otherReceipts) {
        const a = r.action;
        if (!aV.has(a)) aV.set(a, aV.size);
        actionStream.push(aV.get(a));
        const { action, ...rest } = r;
        stripped.push(JSON.stringify(rest));
      }
      aIdxBr = brotli11(Buffer.from(actionStream.flatMap(varintU)));
      aVBr = brotli11(Buffer.from([...aV.keys()].join('\x02'), 'utf8'));
    } else {
      stripped = otherReceipts.map(r => JSON.stringify(r));
    }
    shapesBlob = brotli11(Buffer.from(stripped.join('\n') + '\n', 'utf8'));
    if (useBrotli2) shapesBlob = brotli11(shapesBlob);
  }

  // position class is needed whenever useMesh (to interleave mesh + other)
  let posBr = Buffer.alloc(0);
  if (useMesh) {
    const positionClass = new Uint8Array(N);
    for (const i of meshIdx) positionClass[i] = 1;
    const posRuns = [];
    { let prev = positionClass[0], count = 1;
      for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
      posRuns.push([prev, count]); }
    posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));
  }

  const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

  const total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length;
  const ratio = detBytes.length / total;
  const encMs = performance.now() - tEnc0;

  return {
    layerSet,
    ratio,
    total,
    encMs,
    parts: { meshTplBr, meshDataBr, shapesBlob, aIdxBr, aVBr, otherIdxBr, posBr, seedR },
    meta: {
      useMesh, useShape, useAction, useB8, useBrotli2,
      meshIdx, otherIdx,
      meshTemplate, meshSumTplMap, meshRecData,
      sortedShapeList, aV,
    },
  };
}

function decode(encoded) {
  const { parts, meta } = encoded;
  const { useMesh, useShape, useAction, useB8, useBrotli2 } = meta;
  const tDec0 = performance.now();

  // mesh side
  let meshRecv = [];
  let meshTplDec = null;
  if (useMesh) {
    meshTplDec = JSON.parse(zlib.brotliDecompressSync(parts.meshTplBr).toString('utf8'));
    const meshDataDec = zlib.brotliDecompressSync(parts.meshDataBr);
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

  // shapes
  let shapesText;
  if (useBrotli2) {
    shapesText = zlib.brotliDecompressSync(zlib.brotliDecompressSync(parts.shapesBlob)).toString('utf8');
  } else {
    shapesText = zlib.brotliDecompressSync(parts.shapesBlob).toString('utf8');
  }
  const strippedDec = shapesText.split('\n').filter(Boolean);
  let restoredShapes;
  if (useAction) {
    const aIdxBuf = zlib.brotliDecompressSync(parts.aIdxBr);
    const aIdxs = []; { let o = 0; while (o < aIdxBuf.length) { const [v, n] = readVarintU(aIdxBuf, o); aIdxs.push(v); o = n; } }
    const aVarr = zlib.brotliDecompressSync(parts.aVBr).toString('utf8').split('\x02');
    restoredShapes = strippedDec.map((s, i) => {
      const a = aVarr[aIdxs[i]];
      const obj = JSON.parse(s);
      const ordered = { action: a, ...obj };
      return JSON.stringify(ordered);
    });
  } else {
    restoredShapes = strippedDec;
  }

  let otherIdxDec;
  if (useShape) {
    const otherIdxBuf = zlib.brotliDecompressSync(parts.otherIdxBr);
    otherIdxDec = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec.push(v); o = n; } }
  } else {
    // identity mapping: each shape is its own record
    otherIdxDec = restoredShapes.map((_, i) => i);
  }

  // position class
  let posClass;
  if (useMesh) {
    const posBytes = zlib.brotliDecompressSync(parts.posBr);
    posClass = new Uint8Array(N);
    { let o = 0, idx = 0;
      while (o < posBytes.length) { const cls = posBytes[o++]; const [cnt, no] = readVarintU(posBytes, o); o = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }
  } else {
    posClass = new Uint8Array(N); // all 0
  }

  const seedDec = JSON.parse(zlib.brotliDecompressSync(parts.seedR).toString('utf8'));

  const reconstructed = [];
  let meshCur = 0, otherCur = 0;
  for (let i = 0; i < N; i++) {
    if (useMesh && posClass[i] === 1) {
      const m = meshRecv[meshCur++];
      const sumTpl = meshTplDec.sumTpls[m.sti];
      let ni = 0;
      const nums = [String(m.packet_id), String(m.raw), String(m.comp)];
      const summary = sumTpl == null || sumTpl === '\0NULL\0' ? null : sumTpl.replace(/\x01/g, () => nums[ni++]);
      const ratio2 = meshRatio(m.raw, m.comp);
      reconstructed.push({
        id: detId(seedDec.seed, i),
        action: 'mesh.compress',
        status: meshTplDec.status,
        summary,
        payload_json: JSON.stringify({ raw_bytes: m.raw, compressed_bytes: m.comp, ratio: ratio2 }),
        created_at: meshTplDec.cas[m.ci],
      });
    } else {
      const shapeIdx = otherIdxDec[otherCur++];
      const shape = JSON.parse(restoredShapes[shapeIdx]);
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
  const decMs = performance.now() - tDec0;
  return { sha: recSha, decMs };
}

// Run all 31 non-empty subsets
const results = [];
for (let mask = 1; mask < 32; mask++) {
  const set = new Set();
  if (mask & 1) set.add('mesh');
  if (mask & 2) set.add('shape');
  if (mask & 4) set.add('action');
  if (mask & 8) set.add('B8');
  if (mask & 16) set.add('brotli2');
  const label = LAYERS.filter(l => set.has(l)).join('+');
  try {
    const enc = buildEncoded(set);
    let lossless = false, decMs = 0;
    try {
      const dec = decode(enc);
      lossless = (dec.sha === detSha);
      decMs = dec.decMs;
    } catch (e) {
      lossless = false;
    }
    results.push({
      mask,
      layers: [...set],
      label,
      total_bytes: enc.total,
      ratio: Number(enc.ratio.toFixed(3)),
      enc_ms: Math.round(enc.encMs),
      dec_ms: Math.round(decMs),
      lossless,
    });
    console.log(`subset ${String(mask).padStart(2)} [${label.padEnd(30)}] ratio=${enc.ratio.toFixed(3).padStart(7)} enc=${Math.round(enc.encMs).toString().padStart(4)}ms lossless=${lossless}`);
  } catch (e) {
    results.push({ mask, layers: [...set], label, error: e.message, lossless: false });
    console.log(`subset ${mask} [${label}] ERROR: ${e.message}`);
  }
}

// Rank lossless results by ratio
const lossless = results.filter(r => r.lossless).sort((a, b) => b.ratio - a.ratio);
const top5 = lossless.slice(0, 5);
console.log('\n=== TOP 5 LOSSLESS SUBSETS ===');
for (const r of top5) {
  console.log(`{${r.label}}  ratio=${r.ratio}x  enc=${r.enc_ms}ms dec=${r.dec_ms}ms`);
}

const m19_ratio = 47.07;
const best = top5[0];
console.log(`\nBest subset: {${best.label}} at ${best.ratio}x (delta vs M19: ${(best.ratio - m19_ratio).toFixed(3)})`);

// Find the smallest subset achieving >= 99% of M19's ratio
const threshold = m19_ratio * 0.99;
const cheaperSubsets = lossless.filter(r => r.ratio >= threshold).sort((a, b) => a.layers.length - b.layers.length || b.ratio - a.ratio);
if (cheaperSubsets.length > 0) {
  const c = cheaperSubsets[0];
  console.log(`Smallest subset ≥99% of M19 (${threshold.toFixed(2)}x): {${c.label}} at ${c.ratio}x (${c.layers.length} layers)`);
}

const summary = {
  experiment: '102-greedy-layer-search',
  layers: LAYERS,
  m19_reference_ratio: m19_ratio,
  all_subsets: results,
  top_5_lossless: top5,
  best: best ? { label: best.label, ratio: best.ratio, layers: best.layers, enc_ms: best.enc_ms, dec_ms: best.dec_ms, delta_vs_m19: Number((best.ratio - m19_ratio).toFixed(3)) } : null,
  smallest_at_99pct_of_m19: cheaperSubsets[0] || null,
  verdict: best && best.ratio >= m19_ratio - 0.5 ? 'GREEN' : (best && best.ratio >= m19_ratio - 2 ? 'AMBER' : 'RED'),
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log('\nWrote summary.json');
