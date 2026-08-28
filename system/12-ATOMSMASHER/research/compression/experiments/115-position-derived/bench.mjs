// Experiment 115 — Position-derived linear formulas.
// y = a*i + b where i is the receipt's global index.

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
function sha256(b) { return crypto.createHash('sha256').update(b).digest('hex'); }

const t0 = performance.now();

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = sha256(detBytes);

const payloadKeyOrders = detReceipts.map(r => {
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) return Object.keys(p);
  } catch {}
  return null;
});

const numericFields = new Set();
for (let i = 0; i < N; i++) {
  try {
    const p = JSON.parse(detReceipts[i].payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const [k, v] of Object.entries(p)) if (typeof v === 'number') numericFields.add(`payload.${k}`);
    }
  } catch {}
}
const NUM_FIELDS = [...numericFields];

function getValAt(i, field) {
  if (!field.startsWith('payload.')) return undefined;
  try {
    const p = JSON.parse(detReceipts[i].payload_json);
    const k = field.slice(8);
    if (p && typeof p === 'object' && !Array.isArray(p) && k in p && typeof p[k] === 'number') return p[k];
  } catch {}
  return undefined;
}

const linearFormulas = [];
for (const f of NUM_FIELDS) {
  const points = [];
  for (let i = 0; i < N; i++) {
    const v = getValAt(i, f);
    if (v !== undefined) points.push({ i, v });
  }
  if (points.length < 10) continue;
  const p0 = points[0], p1 = points[1];
  if (p0.i === p1.i) continue;
  const a = (p1.v - p0.v) / (p1.i - p0.i);
  const b = p0.v - a * p0.i;
  const ok = points.every(pt => Math.abs(pt.v - (a * pt.i + b)) < 1e-9);
  if (ok && Number.isInteger(a) && Number.isInteger(b)) {
    linearFormulas.push({ field: f, a, b, support: points.length });
  }
}

console.log(`Position-derived linear formulas found: ${linearFormulas.length}`);

const formulasByField = new Map();
for (const f of linearFormulas) formulasByField.set(f.field.slice(8), f);

// Per-receipt elision: only elide when value is numeric AND equals a*i + b
const records = detReceipts.map((r, i) => {
  const obj = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at };
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { obj._praw = r.payload_json; return obj; }
  if (payload === null) { obj._pnull = 1; return obj; }
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    const kept = {};
    for (const [k, v] of Object.entries(payload)) {
      const f = formulasByField.get(k);
      if (f && typeof v === 'number') {
        const predicted = f.a * i + f.b;
        if (predicted === v) continue; // elide
      }
      kept[k] = v;
    }
    obj._p = kept;
  } else {
    obj._praw = r.payload_json;
  }
  return obj;
});

const recBlob = brotli11(Buffer.from(records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8'));
const formulaBlob = brotli11(Buffer.from(JSON.stringify(linearFormulas.map(f => ({ field: f.field, a: f.a, b: f.b }))), 'utf8'));
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const orderStream = payloadKeyOrders.map(ko => ko ? ko.join('\x1f') : '').join('\x1e');
const orderBlob = brotli11(Buffer.from(orderStream, 'utf8'));

const presenceBlobs = [];
for (const f of linearFormulas) {
  const k = f.field.slice(8);
  const bits = new Uint8Array(Math.ceil(N / 8));
  for (let i = 0; i < N; i++) {
    try {
      const p = JSON.parse(detReceipts[i].payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p) && k in p && typeof p[k] === 'number') {
        const predicted = f.a * i + f.b;
        if (predicted === p[k]) bits[i >> 3] |= (1 << (i & 7));
      }
    } catch {}
  }
  presenceBlobs.push(brotli11(Buffer.from(bits)));
}
const presenceTotal = presenceBlobs.reduce((a, b) => a + b.length, 0);

const total = recBlob.length + formulaBlob.length + seedR.length + orderBlob.length + presenceTotal;
const ratio = detBytes.length / total;
console.log(`Total: ${total}B, ratio: ${ratio.toFixed(3)}x`);

function decode() {
  const recs = zlib.brotliDecompressSync(recBlob).toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
  const fms = JSON.parse(zlib.brotliDecompressSync(formulaBlob).toString('utf8'));
  const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));
  const orderStr = zlib.brotliDecompressSync(orderBlob).toString('utf8');
  const orderArr = orderStr.split('\x1e').map(s => s === '' ? null : s.split('\x1f'));
  const presences = presenceBlobs.map(b => zlib.brotliDecompressSync(b));

  const reconstructed = recs.map(m => ({ ...m, _payload: { ...(m._p || {}) } }));
  for (let fi = 0; fi < fms.length; fi++) {
    const f = fms[fi];
    const k = f.field.slice(8);
    const bits = presences[fi];
    for (let i = 0; i < N; i++) {
      const present = (bits[i >> 3] >> (i & 7)) & 1;
      if (!present) continue;
      reconstructed[i]._payload[k] = f.a * i + f.b;
    }
  }

  const out = reconstructed.map((m, i) => {
    const obj = {
      id: detId(seedDec.seed, i),
      action: m.action,
      status: m.status,
      summary: m.summary,
    };
    if (m._praw !== undefined) obj.payload_json = m._praw;
    else if (m._pnull) obj.payload_json = null;
    else {
      const ko = orderArr[i];
      if (ko === null) obj.payload_json = null;
      else {
        const fullP = {};
        for (const k of ko) fullP[k] = m._payload[k];
        obj.payload_json = JSON.stringify(fullP);
      }
    }
    obj.created_at = m.created_at;
    return obj;
  });
  const recJsonl = out.map(r => JSON.stringify(r)).join('\n') + '\n';
  return sha256(Buffer.from(recJsonl, 'utf8'));
}

let lossless = false;
let recSha = '';
try { recSha = decode(); lossless = recSha === detSha; } catch (e) { lossless = false; console.log('Decode error:', e.message); }

const encode_ms = performance.now() - t0;
const netBytes = detBytes.length - total;
const summary = {
  experiment: '115-position-derived',
  ratio: Number(ratio.toFixed(3)),
  edges_used: linearFormulas.length,
  net_bytes_saved: netBytes,
  total: total,
  lossless: lossless,
  baseline_m19_ratio: 47.071,
  vs_m19_delta: Number((ratio - 47.071).toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  formulas_sample: linearFormulas.slice(0, 5),
  notes: `Mined ${linearFormulas.length} position-derived linear formulas (y = a*i + b). Side-channel key-order stream preserves byte-exact JSON.`,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
