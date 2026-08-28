// Experiment 107 — Hash regeneration sweep + M19.
// For each hex-pattern field (len 16/32/40/64), test if it is a sha256/sha1/sha512 prefix
// of any concatenation of other top-level fields or payload fields. Strip if derivable.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const SEED = 'orange5-receipt-stream-v1';

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function bankerRound(x) { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); }
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }
function sha256hex(s) { return crypto.createHash('sha256').update(s).digest('hex'); }
function sha1hex(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function sha512hex(s) { return crypto.createHash('sha512').update(s).digest('hex'); }
const HEX_RE = /^[0-9a-f]+$/;

const t0 = performance.now();
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const otherIdx = [];
const meshIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// === MINE per-action hash formulas ===
// For each payload string field with hex pattern, test candidates against constructed inputs:
//   sha256(field_a + field_b + ... + str_const).slice(0, len)
// We bound the candidate inputs: try each individual other field, and the concatenation
// of all other top-level fields (id, action, status, summary, created_at, payload_json).

const ALGOS = [
  { name: 'sha256', fn: sha256hex },
  { name: 'sha1', fn: sha1hex },
  { name: 'sha512', fn: sha512hex },
];

const actionPayloads = new Map(); // action -> [{receipt, payload}]
const actionRowKeyOrders = new Map();
for (const i of otherIdx) {
  const r = detReceipts[i];
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { continue; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
  if (!actionPayloads.has(r.action)) { actionPayloads.set(r.action, []); actionRowKeyOrders.set(r.action, []); }
  actionPayloads.get(r.action).push({ receipt: r, payload });
  actionRowKeyOrders.get(r.action).push(Object.keys(payload));
}

// Discover hex string fields with consistent length per (action,field)
const hashFormulas = {}; // action -> { field: { algo, input_source, len } }
// input_source examples: 'top.id', 'top.summary', 'pay.foo', 'concat:top.id|top.action', etc.
let edgesMined = 0;

// Candidate input sources: every other top-level scalar + every other payload scalar
function buildSources(receipt, payload, excludeField) {
  const sources = [];
  // Top-level
  sources.push({ id: 'top.id', val: receipt.id });
  sources.push({ id: 'top.action', val: receipt.action });
  sources.push({ id: 'top.status', val: receipt.status });
  sources.push({ id: 'top.summary', val: receipt.summary });
  sources.push({ id: 'top.created_at', val: receipt.created_at });
  for (const [k, v] of Object.entries(payload)) {
    if (k === excludeField) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
      sources.push({ id: `pay.${k}`, val: String(v) });
    }
  }
  return sources;
}

for (const [a, rows] of actionPayloads.entries()) {
  // Step 1: identify hex-pattern fields
  const fieldHexLens = new Map(); // field -> consistent length or null
  const fieldPresence = new Map();
  for (const { payload } of rows) {
    for (const [k, v] of Object.entries(payload)) {
      if (typeof v !== 'string') continue;
      fieldPresence.set(k, (fieldPresence.get(k) || 0) + 1);
      if (!HEX_RE.test(v)) { fieldHexLens.set(k, -1); continue; }
      if (fieldHexLens.get(k) === -1) continue;
      const existing = fieldHexLens.get(k);
      if (existing === undefined) fieldHexLens.set(k, v.length);
      else if (existing !== v.length) fieldHexLens.set(k, -1);
    }
  }
  for (const [f, len] of fieldHexLens.entries()) {
    if (len === -1 || ![16, 32, 40, 64, 128].includes(len)) continue;
    if (fieldPresence.get(f) !== rows.length) continue; // must always be present
    // Test on first row to find candidate
    const { receipt: r0, payload: p0 } = rows[0];
    const target0 = p0[f];
    const sources = buildSources(r0, p0, f);
    let foundAlgo = null;
    let foundSource = null;
    // Try single-field sources
    for (const algo of ALGOS) {
      if (foundAlgo) break;
      for (const src of sources) {
        const candidate = algo.fn(src.val).slice(0, len);
        if (candidate === target0) {
          // Verify across all rows
          let allMatch = true;
          for (const { receipt: r, payload: p } of rows) {
            const rSources = buildSources(r, p, f);
            const match = rSources.find(s => s.id === src.id);
            if (!match) { allMatch = false; break; }
            const cand = algo.fn(match.val).slice(0, len);
            if (cand !== p[f]) { allMatch = false; break; }
          }
          if (allMatch) {
            foundAlgo = algo.name;
            foundSource = src.id;
            break;
          }
        }
      }
    }
    // Try concat of id + sep + index? skipping per spec — id is already deterministic.
    // The M19 id is built from `detId(SEED, i)` = 'rcpt_' + sha256(SEED + '||' + i).slice(0,16).
    // For payload hashes we try id-style: sha256(SEED + '||' + i).slice(0,L)
    if (!foundAlgo) {
      // Try sha256(seed||i)[:len] pattern
      const idx0 = otherIdx[rows.indexOf(rows[0])];
      // Actually, we can't easily get i back here; we'd need to track. Skip for now.
    }
    if (foundAlgo) {
      // Position stability
      const rowOrders = actionRowKeyOrders.get(a) || [];
      const pos0 = rowOrders[0]?.indexOf(f);
      let stable = pos0 !== -1;
      for (const ko of rowOrders) { if (ko.indexOf(f) !== pos0) { stable = false; break; } }
      if (!stable) continue;
      if (!hashFormulas[a]) hashFormulas[a] = {};
      hashFormulas[a][f] = { algo: foundAlgo, source: foundSource, len, pos: pos0 };
      edgesMined++;
    }
  }
}

function applyHash(algo, val, len) {
  if (algo === 'sha256') return sha256hex(val).slice(0, len);
  if (algo === 'sha1') return sha1hex(val).slice(0, len);
  if (algo === 'sha512') return sha512hex(val).slice(0, len);
  return null;
}
function getSourceVal(srcId, receipt, payload) {
  if (srcId.startsWith('top.')) {
    const k = srcId.slice(4);
    return String(receipt[k]);
  }
  if (srcId.startsWith('pay.')) {
    const k = srcId.slice(4);
    return String(payload[k]);
  }
  return null;
}

// === BUILD M19 PIPELINE ===
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

// Strip hash fields on encode
const otherReceipts = otherIdx.map(i => {
  const r = detReceipts[i];
  const obj = { action: r.action, status: r.status, summary: r.summary };
  if (r.payload_json != null) {
    try {
      const p = JSON.parse(r.payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const hmap = hashFormulas[r.action] || {};
        const stripped = {};
        for (const [k, v] of Object.entries(p)) { if (k in hmap) continue; stripped[k] = v; }
        obj.payload = stripped;
      } else { obj.payload = p; }
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

const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
const posRuns = [];
{ let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
  posRuns.push([prev, count]); }
const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

// Library: per-action hashes (each carries its stable position)
const library = {};
for (const a of actionPayloads.keys()) {
  library[a] = { hashes: hashFormulas[a] || {} };
}
const libBytes = brotli11(Buffer.from(JSON.stringify(library), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length + libBytes.length;
const ratio = detBytes.length / total;
const encode_ms = performance.now() - t0;

// === ROUNDTRIP ===
const t1 = performance.now();
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
const otherIdxBuf = zlib.brotliDecompressSync(otherIdxBr);
const otherIdxDec = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec.push(v); o = n; } }
const posBytes = zlib.brotliDecompressSync(posBr);
const posClass = new Uint8Array(N);
{ let o = 0, idx = 0;
  while (o < posBytes.length) { const cls = posBytes[o++]; const [cnt, no] = readVarintU(posBytes, o); o = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));
const libraryDec = JSON.parse(zlib.brotliDecompressSync(libBytes).toString('utf8'));

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
    const idx = otherIdxDec[otherCur++];
    const a = aVarr[aIdxs[idx]];
    const obj = JSON.parse(strippedDec[idx]);
    const id = detId(seedDec.seed, i);
    // Pre-compute pseudo receipt for source lookup
    const pseudoReceipt = { id, action: obj.action, status: obj.status, summary: obj.summary, created_at: obj.created_at };
    let payload_json;
    if ('payload' in obj) {
      if (obj.payload === null) payload_json = null;
      else if (typeof obj.payload === 'object' && !Array.isArray(obj.payload)) {
        const lib = libraryDec[a] || { hashes: {} };
        const strippedKeys = Object.keys(obj.payload);
        const sortedHashes = Object.entries(lib.hashes).sort((x, y) => x[1].pos - y[1].pos);
        const fullKeys = [...strippedKeys];
        for (const [hk, hinfo] of sortedHashes) fullKeys.splice(hinfo.pos, 0, hk);
        const merged = {};
        for (const k of fullKeys) {
          if (k in lib.hashes) {
            const { algo, source, len } = lib.hashes[k];
            let srcVal = null;
            if (source.startsWith('top.')) srcVal = String(pseudoReceipt[source.slice(4)]);
            else if (source.startsWith('pay.')) {
              const pk = source.slice(4);
              if (pk in merged) srcVal = String(merged[pk]);
              else if (pk in obj.payload) srcVal = String(obj.payload[pk]);
            }
            merged[k] = applyHash(algo, srcVal, len);
          } else merged[k] = obj.payload[k];
        }
        payload_json = JSON.stringify(merged);
      } else payload_json = JSON.stringify(obj.payload);
    } else payload_json = obj.payload_raw;
    reconstructed.push({
      id, action: a, status: obj.status,
      summary: obj.summary, payload_json, created_at: obj.created_at
    });
  }
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
const decode_ms = performance.now() - t1;

const summary = {
  experiment: '107-hash-regen-sweep',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  library_size_bytes: libBytes.length,
  edges_mined: edgesMined,
  baseline_m19: 47.071,
  vs_m19: Number((ratio - 47.071).toFixed(3)),
  notes: `Tested hex fields (lengths 16/32/40/64/128) against sha256/sha1/sha512 of each other field. Mined ${edgesMined} hash formulas.`,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}: det=${det.slice(Math.max(0,i-80),i+80)} ||| rec=${recJsonl.slice(Math.max(0,i-80),i+80)}`);
      break;
    }
  }
}
