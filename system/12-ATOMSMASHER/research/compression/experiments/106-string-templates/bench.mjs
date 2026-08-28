// Experiment 106 — String template mining + M19.
// For each (action, payload-string-field) find a common prefix/suffix/middle template.
// If >50% of bytes are templated, strip the template part and store only the variable part.
// Regenerate at decode by reapplying template + numeric replacements.

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

// === MINE per-(action, string-field) templates ===
// Strategy: longest common prefix/suffix across all values of (action,field).
// If lcp + lcs > 50% of average value length, declare template.
// Encode each value as [prefix_len_implicit][variable_middle].

function lcp(strs) {
  if (strs.length === 0) return '';
  let p = strs[0];
  for (const s of strs) {
    let i = 0;
    while (i < p.length && i < s.length && p[i] === s[i]) i++;
    p = p.slice(0, i);
    if (!p) break;
  }
  return p;
}
function lcs(strs) {
  if (strs.length === 0) return '';
  let p = strs[0];
  for (const s of strs) {
    let i = 0;
    while (i < p.length && i < s.length && p[p.length - 1 - i] === s[s.length - 1 - i]) i++;
    p = p.slice(p.length - i);
    if (!p) break;
  }
  return p;
}

const actionPayloads = new Map();
const actionKeyOrder = new Map();
for (const i of otherIdx) {
  const r = detReceipts[i];
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { continue; }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
  if (!actionPayloads.has(r.action)) { actionPayloads.set(r.action, []); actionKeyOrder.set(r.action, Object.keys(payload)); }
  actionPayloads.get(r.action).push(payload);
}

const templates = {}; // action -> { field: { prefix, suffix } }
let edgesMined = 0;

for (const [a, payloads] of actionPayloads.entries()) {
  // Collect string fields with full presence
  const fieldVals = new Map();
  for (const p of payloads) {
    for (const [k, v] of Object.entries(p)) {
      if (typeof v !== 'string') continue;
      if (!fieldVals.has(k)) fieldVals.set(k, []);
      fieldVals.get(k).push(v);
    }
  }
  for (const [f, vals] of fieldVals.entries()) {
    if (vals.length !== payloads.length) continue; // must be present in every row
    if (vals.length < 5) continue;
    if (new Set(vals).size === 1) continue; // constant, handled by 103
    const pfx = lcp(vals);
    const sfx = lcs(vals);
    const avgLen = vals.reduce((s, v) => s + v.length, 0) / vals.length;
    const tplLen = pfx.length + sfx.length;
    // Avoid overlap: if pfx + sfx > shortest value, clamp suffix
    let usableSfxLen = sfx.length;
    for (const v of vals) {
      if (pfx.length + usableSfxLen > v.length) usableSfxLen = Math.max(0, v.length - pfx.length);
    }
    const realTplLen = pfx.length + usableSfxLen;
    if (avgLen > 0 && realTplLen / avgLen > 0.5 && realTplLen >= 3) {
      if (!templates[a]) templates[a] = {};
      templates[a][f] = { prefix: pfx, suffix: sfx.slice(sfx.length - usableSfxLen) };
      edgesMined++;
    }
  }
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

// Strip templates on encode: replace templated string with variable middle only,
// prefixed with a sentinel so we know to restore.
// We store: payload[k] = "" + middle  (sentinel + middle). Decode strips sentinel and reapplies.
// But adding a sentinel byte risks tag collision. Instead, replace string entirely with
// {__t: middle} object — but that changes type. Safer: keep string, but replace with middle.
// On decode, we know the field is in templates[a][k], so we reapply.
const otherReceipts = otherIdx.map(i => {
  const r = detReceipts[i];
  const obj = { action: r.action, status: r.status, summary: r.summary };
  if (r.payload_json != null) {
    try {
      const p = JSON.parse(r.payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        const tmap = templates[r.action] || {};
        const transformed = {};
        for (const [k, v] of Object.entries(p)) {
          if (k in tmap && typeof v === 'string') {
            const { prefix, suffix } = tmap[k];
            // Strip prefix and suffix
            if (v.startsWith(prefix) && v.endsWith(suffix) && v.length >= prefix.length + suffix.length) {
              transformed[k] = v.slice(prefix.length, v.length - suffix.length);
            } else {
              // Doesn't match — keep verbatim (escape via leading \x02)
              transformed[k] = '\x02' + v;
            }
          } else {
            transformed[k] = v;
          }
        }
        obj.payload = transformed;
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

const libBytes = brotli11(Buffer.from(JSON.stringify(templates), 'utf8'));

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
const templatesDec = JSON.parse(zlib.brotliDecompressSync(libBytes).toString('utf8'));

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
        const tmap = templatesDec[a] || {};
        const merged = {};
        for (const [k, v] of Object.entries(obj.payload)) {
          if (k in tmap && typeof v === 'string') {
            if (v.startsWith('\x02')) merged[k] = v.slice(1);
            else merged[k] = tmap[k].prefix + v + tmap[k].suffix;
          } else merged[k] = v;
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
  experiment: '106-string-templates',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  library_size_bytes: libBytes.length,
  edges_mined: edgesMined,
  baseline_m19: 47.071,
  vs_m19: Number((ratio - 47.071).toFixed(3)),
  notes: `Mined ${edgesMined} prefix/suffix templates across ${Object.keys(templates).length} actions. Templated when prefix+suffix > 50% of avg length.`,
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
