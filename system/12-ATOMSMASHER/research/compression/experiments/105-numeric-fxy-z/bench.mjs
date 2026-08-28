// Experiment 105 — Numeric f(x,y)=z mining + M19.
// For each action and each numeric field z, find if z is a deterministic function of
// two other numeric fields x,y from the same payload, using +, -, *, /, banker_round,
// percentage, min, max. Strip z on encode; regenerate on decode.

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

const otherIdx = [];
const meshIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// === MINE per-action numeric formulas ===
// For each action, gather numeric fields. For each candidate target z, test functions
// f(x,y) on every (x,y) pair. Need >=99% match across rows where x,y,z all present and numeric.

const OPS = [
  { name: 'div', fn: (x, y) => y !== 0 ? x / y : null },
  { name: 'div_br2', fn: (x, y) => y !== 0 ? bankerRound2(x / y) : null },
  { name: 'mul', fn: (x, y) => x * y },
  { name: 'add', fn: (x, y) => x + y },
  { name: 'sub', fn: (x, y) => x - y },
  { name: 'sub_yx', fn: (x, y) => y - x },
  { name: 'pct', fn: (x, y) => y !== 0 ? bankerRound2((x / y) * 100) : null },
  { name: 'min', fn: (x, y) => Math.min(x, y) },
  { name: 'max', fn: (x, y) => Math.max(x, y) },
  { name: 'savings', fn: (x, y) => y - x }, // alias
];

const actionPayloads = new Map();
const actionRowKeyOrders = new Map();
for (const i of otherIdx) {
  const r = detReceipts[i];
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { continue; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
  if (!actionPayloads.has(r.action)) { actionPayloads.set(r.action, []); actionRowKeyOrders.set(r.action, []); }
  actionPayloads.get(r.action).push(payload);
  actionRowKeyOrders.get(r.action).push(Object.keys(payload));
}

const formulas = {}; // action -> { targetField: {op, x, y, pos} }
let edgesMined = 0;
function num(v) { return typeof v === 'number' && Number.isFinite(v); }

for (const [a, payloads] of actionPayloads.entries()) {
  const numFields = new Set();
  for (const p of payloads) for (const [k, v] of Object.entries(p)) if (num(v)) numFields.add(k);
  const flds = [...numFields];
  if (flds.length < 3) continue;
  const rowOrders = actionRowKeyOrders.get(a) || [];

  for (const z of flds) {
    const vals = payloads.filter(p => num(p[z])).map(p => p[z]);
    if (vals.length === 0) continue;
    if (new Set(vals).size === 1) continue;
    if (payloads.filter(p => num(p[z])).length !== payloads.length) continue;
    // Position stability check
    const pos0 = rowOrders[0]?.indexOf(z);
    let stable = pos0 !== -1;
    for (const ko of rowOrders) { if (ko.indexOf(z) !== pos0) { stable = false; break; } }
    if (!stable) continue;

    let found = false;
    for (const x of flds) {
      if (x === z || found) continue;
      for (const y of flds) {
        if (y === z || y === x || found) continue;
        for (const op of OPS) {
          let match = true;
          for (const p of payloads) {
            if (!num(p[x]) || !num(p[y]) || !num(p[z])) { match = false; break; }
            const pred = op.fn(p[x], p[y]);
            if (pred == null || !Number.isFinite(pred)) { match = false; break; }
            if (Math.abs(pred - p[z]) > 1e-9 * Math.max(1, Math.abs(p[z]))) { match = false; break; }
          }
          if (match) {
            if (!formulas[a]) formulas[a] = {};
            formulas[a][z] = { op: op.name, x, y, pos: pos0 };
            found = true;
            break;
          }
        }
      }
    }
  }
}

// Prune formulas: cannot strip a target if its inputs are themselves stripped (cycles/dependencies).
// Simplest safe rule: only keep formulas where BOTH x and y are NOT formula targets in same action.
for (const a of Object.keys(formulas)) {
  const targets = new Set(Object.keys(formulas[a]));
  for (const t of [...targets]) {
    const f = formulas[a][t];
    if (targets.has(f.x) || targets.has(f.y)) delete formulas[a][t];
  }
  if (Object.keys(formulas[a]).length === 0) delete formulas[a];
}
// Re-count edges mined
for (const a of Object.keys(formulas)) edgesMined += Object.keys(formulas[a]).length;

function applyOp(opName, x, y) {
  if (opName === 'div') return x / y;
  if (opName === 'div_br2') return bankerRound2(x / y);
  if (opName === 'mul') return x * y;
  if (opName === 'add') return x + y;
  if (opName === 'sub') return x - y;
  if (opName === 'sub_yx') return y - x;
  if (opName === 'pct') return bankerRound2((x / y) * 100);
  if (opName === 'min') return Math.min(x, y);
  if (opName === 'max') return Math.max(x, y);
  if (opName === 'savings') return y - x;
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

// Strip target fields on encode
const otherReceipts = otherIdx.map(i => {
  const r = detReceipts[i];
  const obj = { action: r.action, status: r.status, summary: r.summary };
  if (r.payload_json != null) {
    try {
      const p = JSON.parse(r.payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const fmap = formulas[r.action] || {};
        const stripped = {};
        for (const [k, v] of Object.entries(p)) { if (k in fmap) continue; stripped[k] = v; }
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

// Library: per-action formulas (each formula already includes its stable position)
const library = {};
for (const a of actionPayloads.keys()) {
  library[a] = { formulas: formulas[a] || {} };
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
    let payload_json;
    if ('payload' in obj) {
      if (obj.payload === null) payload_json = null;
      else if (typeof obj.payload === 'object' && !Array.isArray(obj.payload)) {
        const lib = libraryDec[a] || { formulas: {} };
        const strippedKeys = Object.keys(obj.payload);
        // Insert formula targets at their stable positions
        const sortedFormulas = Object.entries(lib.formulas).sort((x, y) => x[1].pos - y[1].pos);
        const fullKeys = [...strippedKeys];
        for (const [fk, finfo] of sortedFormulas) fullKeys.splice(finfo.pos, 0, fk);
        const merged = {};
        for (const k of fullKeys) {
          if (k in lib.formulas) {
            const { op, x, y } = lib.formulas[k];
            const xv = (x in merged) ? merged[x] : obj.payload[x];
            const yv = (y in merged) ? merged[y] : obj.payload[y];
            merged[k] = applyOp(op, xv, yv);
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
  experiment: '105-numeric-fxy-z',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  library_size_bytes: libBytes.length,
  edges_mined: edgesMined,
  baseline_m19: 47.071,
  vs_m19: Number((ratio - 47.071).toFixed(3)),
  notes: `Mined ${edgesMined} numeric f(x,y)=z formulas across ${Object.keys(formulas).length} actions using ops [div, div_br2, mul, add, sub, sub_yx, pct, min, max, savings].`,
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
