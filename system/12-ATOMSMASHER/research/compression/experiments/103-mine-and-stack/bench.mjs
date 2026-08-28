// Experiment 103 — Auto-mine derivations + stack on M19.
// Mine global per-(action,field) deterministic formulas. Strip derivable fields on encode,
// regenerate on decode. Inject between SHAPE_VOCAB and B8_SORT.
// sha256 byte-exact verify.

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
function bankerRound2(x) { return bankerRound(x * 100) / 100; }
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

const t0 = performance.now();
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// === FORMULA MINING (global, per-(action,field)) ===
// For each (action, field) pair, test if field is deterministic constant across same action.
// This is a simple "constant per action" model — strip the constants from per-row data.

// Parse payloads, track action-field-value distributions for non-mesh receipts.
const otherIdx = [];
const meshIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// Mine: for each action, which payload.* fields are CONSTANT across all rows of that action?
const actionFieldValues = new Map(); // action -> field -> Set of stringified values
for (const i of otherIdx) {
  const r = detReceipts[i];
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { continue; }
  if (!payload || typeof payload !== 'object') continue;
  if (!actionFieldValues.has(r.action)) actionFieldValues.set(r.action, new Map());
  const fm = actionFieldValues.get(r.action);
  for (const [k, v] of Object.entries(payload)) {
    const sv = JSON.stringify(v);
    if (!fm.has(k)) fm.set(k, new Set());
    fm.get(k).add(sv);
  }
}

// Constants per action: fields where the set is size 1 (every row of action X has same value).
// Also include "missing must be missing" — track which fields appear.
const actionRowCount = new Map();
for (const i of otherIdx) actionRowCount.set(detReceipts[i].action, (actionRowCount.get(detReceipts[i].action) || 0) + 1);
const actionFieldPresence = new Map();
for (const i of otherIdx) {
  const r = detReceipts[i];
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { continue; }
  if (!payload || typeof payload !== 'object') continue;
  if (!actionFieldPresence.has(r.action)) actionFieldPresence.set(r.action, new Map());
  const fp = actionFieldPresence.get(r.action);
  for (const k of Object.keys(payload)) fp.set(k, (fp.get(k) || 0) + 1);
}

// Per-receipt key orders: only strip a field if its position is identical across all rows
const actionRowKeyOrders = new Map(); // action -> [keyOrderArrays per row]
for (const i of otherIdx) {
  const r = detReceipts[i];
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { continue; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
  if (!actionRowKeyOrders.has(r.action)) actionRowKeyOrders.set(r.action, []);
  actionRowKeyOrders.get(r.action).push(Object.keys(payload));
}

const constants = {}; // action -> { field: value-as-json-string }
let edgesMined = 0;
for (const [a, fields] of actionFieldValues.entries()) {
  const rowCount = actionRowCount.get(a);
  const presence = actionFieldPresence.get(a);
  const rowOrders = actionRowKeyOrders.get(a) || [];
  // For each field, check if its position is identical across all rows.
  constants[a] = {};
  for (const [f, vSet] of fields.entries()) {
    if (vSet.size !== 1 || presence.get(f) !== rowCount) continue;
    // Check position consistency
    let pos0 = rowOrders[0]?.indexOf(f);
    let stable = pos0 !== -1;
    for (const ko of rowOrders) { if (ko.indexOf(f) !== pos0) { stable = false; break; } }
    if (!stable) continue;
    constants[a][f] = [...vSet][0];
    edgesMined++;
  }
}

// === BUILD M19-COMPATIBLE WITH STRIP-DERIVABLE ===
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

// === OTHER RECEIPTS WITH FIELD STRIPPING ===
const otherReceipts = otherIdx.map(i => {
  const r = detReceipts[i];
  const obj = { action: r.action, status: r.status, summary: r.summary };
  if (r.payload_json != null) {
    try {
      const p = JSON.parse(r.payload_json);
      if (p && typeof p === 'object') {
        // Strip constant fields per action — they regenerate at decode
        const stripped = {};
        const consts = constants[r.action] || {};
        // Preserve key order from original payload
        for (const [k, v] of Object.entries(p)) {
          if (k in consts) continue; // strip
          stripped[k] = v;
        }
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

// === FORMULA LIBRARY (must ship with payload) ===
const libBytes = brotli11(Buffer.from(JSON.stringify(constants), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length + libBytes.length;
const ratio = detBytes.length / total;
const encode_ms = performance.now() - t0;

// === ROUNDTRIP ===
const t1 = performance.now();
const constantsDec = JSON.parse(zlib.brotliDecompressSync(libBytes).toString('utf8'));

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

// Restore shape + RE-INJECT CONSTANTS
const restoredShapes = strippedDec.map((s, i) => {
  const a = aVarr[aIdxs[i]];
  const obj = JSON.parse(s);
  const ordered = { action: a, ...obj };
  // Re-inject constants into payload
  if (ordered.payload && typeof ordered.payload === 'object' && !Array.isArray(ordered.payload)) {
    const consts = constantsDec[a] || {};
    // Determine original key order: read from corpus — but we need order info!
    // The constants were stripped, so we need to remember where to insert them.
    // For simplicity we re-construct via the original receipts' first occurrence per action.
    // BUT this requires the order to be known. Track payload key order in library.
  }
  return JSON.stringify(ordered);
});

// === CRITICAL: we need original key order to roundtrip exactly ===
// Track key order per action. Store as part of the library.
// Rewrite: library = { action -> { __order: [k1,k2,...], k: constVal } }
// For correctness, re-mine with order capture.

// Library: per-action constants with their stable positions
const library = {};
for (const a of actionFieldValues.keys()) {
  const rowOrders = actionRowKeyOrders.get(a) || [];
  const consts = constants[a] || {};
  // Record each constant's position
  const positions = {};
  if (rowOrders.length > 0) {
    for (const f of Object.keys(consts)) {
      positions[f] = rowOrders[0].indexOf(f);
    }
  }
  library[a] = { consts, positions };
}
const libBytes2 = brotli11(Buffer.from(JSON.stringify(library), 'utf8'));

// Re-do roundtrip with order
const otherIdxBuf = zlib.brotliDecompressSync(otherIdxBr);
const otherIdxDec = []; { let o = 0; while (o < otherIdxBuf.length) { const [v, n] = readVarintU(otherIdxBuf, o); otherIdxDec.push(v); o = n; } }

const posBytes = zlib.brotliDecompressSync(posBr);
const posClass = new Uint8Array(N);
{ let o = 0, idx = 0;
  while (o < posBytes.length) { const cls = posBytes[o++]; const [cnt, no] = readVarintU(posBytes, o); o = no; for (let j = 0; j < cnt; j++) posClass[idx++] = cls; } }

const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));
const libraryDec = JSON.parse(zlib.brotliDecompressSync(libBytes2).toString('utf8'));

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
    // We need to merge the stripped payload with constants in the right key order
    const strippedKv = strippedDec[otherIdxDec[otherCur]];
    const a = aVarr[aIdxs[otherIdxDec[otherCur]]];
    otherCur++;
    const obj = JSON.parse(strippedKv);
    const id = detId(seedDec.seed, i);
    let payload_json;
    if ('payload' in obj) {
      if (obj.payload === null) payload_json = null;
      else if (typeof obj.payload === 'object' && !Array.isArray(obj.payload)) {
        // Re-insert constants at their stable positions in the original key sequence
        const lib = libraryDec[a] || { consts: {}, positions: {} };
        const strippedKeys = Object.keys(obj.payload);
        // Build full key list by inserting each constant at its position
        // (positions are 0-based indices in the ORIGINAL key list)
        const sortedConsts = Object.entries(lib.positions).sort((x, y) => x[1] - y[1]);
        const fullKeys = [...strippedKeys];
        for (const [ck, cpos] of sortedConsts) fullKeys.splice(cpos, 0, ck);
        const merged = {};
        for (const k of fullKeys) {
          if (k in lib.consts) merged[k] = JSON.parse(lib.consts[k]);
          else merged[k] = obj.payload[k];
        }
        payload_json = JSON.stringify(merged);
      } else payload_json = JSON.stringify(obj.payload);
    } else payload_json = obj.payload_raw;
    const ordered = {
      id, action: a, status: obj.status,
      summary: obj.summary, payload_json, created_at: obj.created_at
    };
    reconstructed.push(ordered);
  }
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
const decode_ms = performance.now() - t1;

// Final total with library that has order
const totalFinal = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + seedR.length + libBytes2.length;
const ratioFinal = detBytes.length / totalFinal;

const summary = {
  experiment: '103-mine-and-stack',
  ratio: Number(ratioFinal.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  library_size_bytes: libBytes2.length,
  edges_mined: edgesMined,
  baseline_m19: 47.071,
  vs_m19: Number((ratioFinal - 47.071).toFixed(3)),
  notes: `Mined ${edgesMined} per-(action,field) deterministic constants across ${Object.keys(library).length} actions. Stripped constants from payload, regenerated at decode. Library is JSON {action: {__order, consts}} brotli-compressed.`,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
if (!lossless) {
  // Diagnostic
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  det: ...${det.slice(Math.max(0, i-100), i+100)}...`);
      console.log(`  rec: ...${recJsonl.slice(Math.max(0, i-100), i+100)}...`);
      break;
    }
  }
}
