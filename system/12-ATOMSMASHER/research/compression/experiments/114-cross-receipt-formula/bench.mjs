// Experiment 114 — Cross-receipt formula mining.
// Find fields where value at receipt[i] depends on prior receipts.
// Patterns: constant step (X[i+1] = X[i] + k), cumulative sum.

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

// Original payload key orders (side channel)
const payloadKeyOrders = detReceipts.map(r => {
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) return Object.keys(p);
  } catch {}
  return null;
});

const flat = detReceipts.map(r => {
  const o = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at };
  try {
    const p = JSON.parse(r.payload_json);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      for (const [k, v] of Object.entries(p)) if (typeof v === 'number') o[`payload.${k}`] = v;
    }
  } catch {}
  return o;
});

const numericFields = new Set();
for (const r of flat) for (const [k, v] of Object.entries(r)) if (typeof v === 'number') numericFields.add(k);
const NUM_FIELDS = [...numericFields];

function bySequence(fieldName) {
  const seq = [];
  for (let i = 0; i < N; i++) if (fieldName in flat[i]) seq.push({ i, v: flat[i][fieldName] });
  return seq;
}

const crossFormulas = [];

// Constant-step pattern across the corpus sequence of the field
for (const f of NUM_FIELDS) {
  const seq = bySequence(f);
  if (seq.length < 50) continue;
  const diffs = [];
  for (let j = 1; j < seq.length; j++) diffs.push(seq[j].v - seq[j-1].v);
  if (diffs.length === 0) continue;
  const first = diffs[0];
  const allSame = diffs.every(d => d === first);
  if (allSame && Number.isInteger(first)) {
    crossFormulas.push({ type: 'step', field: f, step: first, base: seq[0].v, support: seq.length });
  }
}

console.log(`Cross-receipt formulas found: ${crossFormulas.length}`);

const stepFormulas = crossFormulas.filter(f => f.type === 'step');
const formulasByField = new Map();
for (const f of stepFormulas) {
  if (f.field.startsWith('payload.')) formulasByField.set(f.field.slice(8), f);
}

// Encode — per-receipt: precompute the kth-position-of-formula for each formula
// We need to know at encode the formula's k-th occurrence value for each receipt.
// kthMap[fieldKey] = array indexed by global receipt index → k-th occurrence (or -1 if not present-as-number)
const kthMap = new Map();
for (const [k, f] of formulasByField) {
  const arr = new Array(N).fill(-1);
  let kth = 0;
  for (let i = 0; i < N; i++) {
    try {
      const p = JSON.parse(detReceipts[i].payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p) && k in p && typeof p[k] === 'number') {
        arr[i] = kth++;
      }
    } catch {}
  }
  kthMap.set(k, arr);
}

const records = detReceipts.map((r, i) => {
  const obj = { action: r.action, status: r.status, summary: r.summary, created_at: r.created_at };
  let payload = null;
  try { payload = JSON.parse(r.payload_json); } catch { obj._praw = r.payload_json; return obj; }
  if (payload === null) { obj._pnull = 1; return obj; }
  if (typeof payload === 'object' && !Array.isArray(payload)) {
    const kept = {};
    for (const [k, v] of Object.entries(payload)) {
      const f = formulasByField.get(k);
      if (f && typeof v === 'number' && kthMap.get(k)[i] >= 0) {
        const predicted = f.base + kthMap.get(k)[i] * f.step;
        if (predicted === v) {
          // safe to elide
          continue;
        }
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
const formulaBlob = brotli11(Buffer.from(JSON.stringify(stepFormulas), 'utf8'));
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

// Key-order side channel
const orderStream = payloadKeyOrders.map(ko => ko ? ko.join('\x1f') : '').join('\x1e');
const orderBlob = brotli11(Buffer.from(orderStream, 'utf8'));

// Per-formula presence bitmap: mark only receipts where elision actually occurred (numeric value matching prediction)
const presenceBlobs = [];
for (const f of stepFormulas) {
  const k = f.field.startsWith('payload.') ? f.field.slice(8) : f.field;
  const kthArr = kthMap.get(k);
  const bits = new Uint8Array(Math.ceil(N / 8));
  for (let i = 0; i < N; i++) {
    try {
      const p = JSON.parse(detReceipts[i].payload_json);
      if (p && typeof p === 'object' && !Array.isArray(p) && k in p && typeof p[k] === 'number' && kthArr[i] >= 0) {
        const predicted = f.base + kthArr[i] * f.step;
        if (predicted === p[k]) {
          bits[i >> 3] |= (1 << (i & 7));
        }
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
    const bits = presences[fi];
    const k = f.field.startsWith('payload.') ? f.field.slice(8) : f.field;
    let kth = 0;
    for (let i = 0; i < N; i++) {
      const present = (bits[i >> 3] >> (i & 7)) & 1;
      if (!present) continue;
      const val = f.base + kth * f.step;
      kth++;
      reconstructed[i]._payload[k] = val;
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
  experiment: '114-cross-receipt-formula',
  ratio: Number(ratio.toFixed(3)),
  edges_used: stepFormulas.length,
  cross_formulas_total: crossFormulas.length,
  net_bytes_saved: netBytes,
  total: total,
  lossless: lossless,
  baseline_m19_ratio: 47.071,
  vs_m19_delta: Number((ratio - 47.071).toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  formulas_sample: stepFormulas.slice(0, 5),
  notes: `Mined ${crossFormulas.length} cross-receipt constant-step formulas. Applied ${stepFormulas.length} to elide derivable payload fields. Stores base+step + per-formula presence bitmap + side-channel key order.`,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
