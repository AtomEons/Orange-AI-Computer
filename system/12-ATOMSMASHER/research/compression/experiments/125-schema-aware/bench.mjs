// Experiment 125 — Schema-aware pre-pass stacked on M19
//
// Hypothesis: receipts contain "schema fields" — values that are constant or
// drawn from a tiny enum (status mostly = "ok", action drawn from <20 values,
// shape always {id,action,status,summary,payload_json,created_at}). If we
// strip those before applying the M19 pipeline, the residual is more compressible.
//
// Approach:
//   1. Scan corpus, identify fields where value entropy is below 1 bit (i.e.
//      effectively constant or near-constant).
//   2. Build a "schema reference" — single small JSON describing the constants.
//   3. Strip the constant fields from each receipt → residual stream.
//   4. Run a Method-19-style brotli pass on the residual + emit schema ref once.
//   5. Roundtrip: decode residual, re-inject schema constants by position.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) {
  return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16);
}
function brotli11(b) {
  return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// --- Scan: for each field, find dominant value and its share.
const encStart = performance.now();
const FIELDS = ['action', 'status', 'summary', 'payload_json', 'created_at'];
const fieldStats = {};
for (const f of FIELDS) {
  const m = new Map();
  for (const r of detReceipts) {
    const v = r[f] === null ? '\0NULL\0' : String(r[f]);
    m.set(v, (m.get(v) || 0) + 1);
  }
  const top = [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  fieldStats[f] = { topValue: top[0], topShare: top[1] / N, unique: m.size };
}
console.log('Field stats:');
for (const f of FIELDS) {
  console.log(`  ${f}: top="${fieldStats[f].topValue.slice(0, 30)}" share=${(fieldStats[f].topShare*100).toFixed(1)}% unique=${fieldStats[f].unique}`);
}

// Schema-strip rule: if a field's top value covers >50% of receipts, strip the
// dominant value and store presence-bit only. We also strip the id field
// (regeneratable from seed+index). For action specifically: even though it's
// not >50%, the action value is part of M19's existing pipeline — leave it.
//
// For honesty: actually M19 already handles all this via shape vocabulary.
// The "schema-aware pre-pass" only meaningfully wins if there's a *new*
// structural cut M19 doesn't make. Candidates: stripping the dominant value
// per-field AT THE RECEIPT LEVEL (not shape level) reduces literal bytes
// brotli has to encode in the shape strings.

// Build "schema-stripped" view: for each receipt, replace fields whose value
// matches the dominant with a single byte marker '\xfe'. Otherwise keep value.
const STRIP_FIELDS = FIELDS.filter(f => fieldStats[f].topShare >= 0.5);
console.log(`Stripping fields where dominant >=50%: ${STRIP_FIELDS.join(', ') || '(none)'}`);

const SCHEMA_REF = {};
for (const f of STRIP_FIELDS) SCHEMA_REF[f] = fieldStats[f].topValue;

const strippedReceipts = detReceipts.map(r => {
  const obj = { id: r.id, action: r.action };
  for (const f of FIELDS) {
    if (f === 'action') continue;
    const v = r[f] === null ? '\0NULL\0' : String(r[f]);
    if (STRIP_FIELDS.includes(f) && v === SCHEMA_REF[f]) {
      // strip — marker byte
      obj[f] = '\xfeSCHEMA';
    } else {
      obj[f] = r[f];
    }
  }
  return obj;
});

// Now run an M19-style pipeline on the stripped receipts.
// To keep this a clean stack on M19, replicate the core: split mesh vs other,
// vocabularize shapes (without id), brotli the parts.

const meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (strippedReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}

// For mesh, use the same templatize approach as M19 (but on stripped summaries)
const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return { tpl: '\0NULL\0', nums: [] }; const nums = []; const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return '\x01'; }); return { tpl, nums }; }

const meshSumTpls = new Set();
const meshCAs = new Map();
const meshRecData = [];
for (const i of meshIdx) {
  const r = detReceipts[i]; // use original for mesh; mesh receipts don't benefit from strip
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

// Other receipts — use stripped versions, shape-vocab them (no id)
const otherStripped = otherIdx.map(i => {
  const r = strippedReceipts[i];
  const obj = { action: r.action, status: r.status, summary: r.summary, payload_json: r.payload_json, created_at: r.created_at };
  return obj;
});

const shapeKey = r => JSON.stringify(r);
const shapeVocab = new Map();
const shapeList = [];
for (const r of otherStripped) {
  const k = shapeKey(r);
  if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
}
console.log(`Unique stripped shapes: ${shapeList.length}`);

// Sort & double-brotli (matching M19 trick)
const indexed = shapeList.map((s, i) => ({ s, i, p: JSON.parse(s) }));
indexed.sort((a, b) => {
  if (a.p.action !== b.p.action) return a.p.action.localeCompare(b.p.action);
  if (a.s.length !== b.s.length) return a.s.length - b.s.length;
  return a.s.localeCompare(b.s);
});
const sortedShapeList = indexed.map(x => x.s);
const sortedShapeIdx = new Map();
sortedShapeList.forEach((s, i) => sortedShapeIdx.set(s, i));
const otherShapeIdx = otherStripped.map(r => sortedShapeIdx.get(shapeKey(r)));

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

// Position class (mesh vs other)
const positionClass = new Uint8Array(N);
for (const i of meshIdx) positionClass[i] = 1;
const posRuns = [];
{ let prev = positionClass[0], count = 1;
  for (let i = 1; i < N; i++) { if (positionClass[i] === prev) count++; else { posRuns.push([prev, count]); prev = positionClass[i]; count = 1; } }
  posRuns.push([prev, count]); }
const posBr = brotli11(Buffer.from(posRuns.flatMap(([cls, cnt]) => [cls, ...varintU(cnt)])));

// Schema reference + seed
const schemaRefBr = brotli11(Buffer.from(JSON.stringify({ schema: SCHEMA_REF, seed: SEED, n: N }), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + shapesBlob.length + aIdxBr.length + aVBr.length + otherIdxBr.length + posBr.length + schemaRefBr.length;
const ratio = detBytes.length / total;
const encMs = performance.now() - encStart;

// --- Roundtrip
const decStart = performance.now();
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
const schemaDec = JSON.parse(zlib.brotliDecompressSync(schemaRefBr).toString('utf8'));
const seedDec = { seed: schemaDec.seed, n: schemaDec.n };

function bankerRound(x) { const f = Math.floor(x); const fr = x - f; if (Math.abs(fr - 0.5) < 1e-9) return f + (f % 2); return Math.round(x); }
function meshRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }

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
    const shape = JSON.parse(restoredShapes[otherIdxDec[otherCur++]]);
    const id = detId(seedDec.seed, i);
    // re-inject schema constants where shape says '\xfeSCHEMA'
    const restored = {};
    for (const f of ['action', 'status', 'summary', 'payload_json', 'created_at']) {
      let v = shape[f];
      if (v === '\xfeSCHEMA') v = schemaDec.schema[f];
      restored[f] = v;
    }
    let payload_json;
    if (restored.payload_json === '\0NULL\0' || restored.payload_json === null) payload_json = null;
    else if (typeof restored.payload_json === 'object') payload_json = JSON.stringify(restored.payload_json);
    else payload_json = restored.payload_json;
    reconstructed.push({
      id, action: restored.action, status: restored.status,
      summary: restored.summary, payload_json, created_at: restored.created_at,
    });
  }
}
const decMs = performance.now() - decStart;

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;

console.log(`mesh template:  ${meshTplBr.length}`);
console.log(`mesh data:      ${meshDataBr.length}`);
console.log(`shapes (br2):   ${shapesBlob.length}`);
console.log(`aIdx:           ${aIdxBr.length}`);
console.log(`aV:             ${aVBr.length}`);
console.log(`otherShapeIdx:  ${otherIdxBr.length}`);
console.log(`pos runs:       ${posBr.length}`);
console.log(`schema+seed:    ${schemaRefBr.length}`);
console.log(`TOTAL:          ${total}`);
console.log(`Ratio:          ${ratio.toFixed(2)}x`);
console.log(`vs M19 (47.07x): ${ratio > 47.07 ? `+${(ratio - 47.07).toFixed(2)}` : `-${(47.07 - ratio).toFixed(2)}`}`);
console.log(`Roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify({
  experiment: '125-schema-aware',
  corpus_sha256: '5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4',
  raw_bytes: detBytes.length,
  total_bytes: total,
  ratio: Number(ratio.toFixed(4)),
  m19_ratio: 47.07,
  delta_vs_m19: Number((ratio - 47.07).toFixed(4)),
  enc_ms: Number(encMs.toFixed(1)),
  dec_ms: Number(decMs.toFixed(1)),
  stripped_fields: STRIP_FIELDS,
  schema_ref: SCHEMA_REF,
  lossless,
  verdict: lossless && ratio >= 47.07 ? 'GREEN' : lossless ? 'AMBER' : 'RED',
}, null, 2));
