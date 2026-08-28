// Experiment 123 — Arithmetic coding over P(value | field, action)
// Build a per-(field,action) value vocabulary, then range-encode the value-id stream.
// This is fundamentally different from brotli (LZ77+ANS over raw bytes): we are
// encoding *structured token ids* where the distribution conditioned on (field,action)
// is dramatically more skewed than raw byte entropy.
//
// Pipeline:
//   1. Canonicalize receipts (det ids), parse each, tokenize per-field.
//   2. For every (action, field) bucket, build a frequency table of distinct
//      string-values seen.
//   3. Encode each receipt as a sequence of value-ids using a per-(action,field)
//      range coder driven by those frequencies.
//   4. Serialize: action stream, field-order header (constant per-action), and
//      per-(action,field) cumulative-frequency tables + the coded body.
//   5. sha256 roundtrip the entire reconstruction.

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

// --- corpus prep
const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

// --- field schema: 6 fields per receipt, in canonical order
const FIELDS = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];

// --- per-(action,field) vocabulary build
// Use action as the conditioning context. id field is excluded from arith coding
// (always derivable from seed+index) — store only the seed.
const ARITH_FIELDS = ['action', 'status', 'summary', 'payload_json', 'created_at'];

const vocab = new Map(); // key = action||field -> { values: [], idxOf: Map }
function getBucket(action, field) {
  const key = action + '\x01' + field;
  let v = vocab.get(key);
  if (!v) { v = { values: [], idxOf: new Map() }; vocab.set(key, v); }
  return v;
}

const tokenStream = []; // [ [bucketKey, valueId], ... ] across all receipts in canonical order
for (const r of detReceipts) {
  const action = r.action;
  for (const f of ARITH_FIELDS) {
    const val = f === 'payload_json' && r[f] === null ? '\0NULL\0' : (r[f] == null ? '\0NULL\0' : String(r[f]));
    const b = getBucket(action, f);
    let idx = b.idxOf.get(val);
    if (idx === undefined) { idx = b.values.length; b.values.push(val); b.idxOf.set(val, idx); }
    tokenStream.push([action, f, idx]);
  }
}

// --- frequency tables per bucket
const freqs = new Map(); // key -> Uint32Array
for (const r of detReceipts) {
  for (const f of ARITH_FIELDS) {
    const action = r.action;
    const val = f === 'payload_json' && r[f] === null ? '\0NULL\0' : (r[f] == null ? '\0NULL\0' : String(r[f]));
    const b = getBucket(action, f);
    const key = action + '\x01' + f;
    let fr = freqs.get(key);
    if (!fr || fr.length < b.values.length) {
      const nfr = new Uint32Array(b.values.length);
      if (fr) nfr.set(fr);
      fr = nfr; freqs.set(key, fr);
    }
    fr[b.idxOf.get(val)]++;
  }
}

// Build cumulative-frequency tables. Use 16-bit precision.
const PREC = 16;
const TOTAL_BITS = 1 << PREC; // 65536
const cumTables = new Map(); // key -> { cum: Uint32Array, total: number }
for (const [key, fr] of freqs.entries()) {
  const n = fr.length;
  const sumRaw = fr.reduce((a, b) => a + b, 0);
  // Scale freqs into PREC, ensuring every nonzero stays >= 1.
  const scaled = new Uint32Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    if (fr[i] === 0) continue;
    scaled[i] = Math.max(1, Math.floor((fr[i] / sumRaw) * (TOTAL_BITS - n)));
    acc += scaled[i];
  }
  // Top up to TOTAL_BITS by giving the largest bucket extra.
  let largest = 0;
  for (let i = 1; i < n; i++) if (scaled[i] > scaled[largest]) largest = i;
  scaled[largest] += (TOTAL_BITS - acc);
  // cumulative
  const cum = new Uint32Array(n + 1);
  for (let i = 0; i < n; i++) cum[i + 1] = cum[i] + scaled[i];
  cumTables.set(key, { cum, total: cum[n] });
}

// --- Range coder (32-bit, carry-free, byte-oriented) ---
class RangeEncoder {
  constructor() {
    this.low = 0n; this.range = 0xFFFFFFFFn;
    this.out = []; this.cache = 0; this.cacheSize = 0;
  }
  encode(cumStart, cumEnd, total) {
    const r = this.range / BigInt(total);
    this.low += BigInt(cumStart) * r;
    this.range = BigInt(cumEnd - cumStart) * r;
    // Renormalize: shift out bytes when top byte stable.
    while ((this.low ^ (this.low + this.range)) < (1n << 24n) || (this.range < (1n << 16n) && (() => { this.range = ((~this.low) & 0xFFFFFFn); return true; })())) {
      this.out.push(Number((this.low >> 24n) & 0xFFn));
      this.low = (this.low << 8n) & 0xFFFFFFFFn;
      this.range = (this.range << 8n) & 0xFFFFFFFFn;
    }
  }
  finish() {
    for (let i = 0; i < 5; i++) {
      this.out.push(Number((this.low >> 24n) & 0xFFn));
      this.low = (this.low << 8n) & 0xFFFFFFFFn;
    }
    return Buffer.from(this.out);
  }
}
class RangeDecoder {
  constructor(buf) {
    this.buf = buf; this.pos = 0;
    this.code = 0n; this.low = 0n; this.range = 0xFFFFFFFFn;
    for (let i = 0; i < 4; i++) this.code = (this.code << 8n) | BigInt(this.buf[this.pos++] || 0);
  }
  decode(cum, total) {
    const r = this.range / BigInt(total);
    const target = Number((this.code - this.low) / r);
    // binary search for cum[i] <= target < cum[i+1]
    let lo = 0, hi = cum.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] <= target) lo = mid; else hi = mid;
    }
    const sym = lo;
    this.low += BigInt(cum[sym]) * r;
    this.range = BigInt(cum[sym + 1] - cum[sym]) * r;
    while ((this.low ^ (this.low + this.range)) < (1n << 24n) || (this.range < (1n << 16n) && (() => { this.range = ((~this.low) & 0xFFFFFFn); return true; })())) {
      this.code = ((this.code << 8n) | BigInt(this.buf[this.pos++] || 0)) & 0xFFFFFFFFn;
      this.low = (this.low << 8n) & 0xFFFFFFFFn;
      this.range = (this.range << 8n) & 0xFFFFFFFFn;
    }
    return sym;
  }
}

// --- Encode token stream
// We need to know which (action,field) bucket each symbol belongs to. Since
// fields cycle in fixed order, the decoder reconstructs by knowing action up front.
// But action itself is one of the encoded fields. So we encode action FIRST per receipt
// using a global action-distribution, then condition the rest on action.
const globalActionFreq = new Map();
for (const r of detReceipts) globalActionFreq.set(r.action, (globalActionFreq.get(r.action) || 0) + 1);
const actionList = [...globalActionFreq.keys()].sort();
const actionIdx = new Map(actionList.map((a, i) => [a, i]));
const aRaw = actionList.map(a => globalActionFreq.get(a));
const aSum = aRaw.reduce((a, b) => a + b, 0);
const aScaled = new Uint32Array(actionList.length);
let aAcc = 0;
for (let i = 0; i < actionList.length; i++) {
  aScaled[i] = Math.max(1, Math.floor((aRaw[i] / aSum) * (TOTAL_BITS - actionList.length)));
  aAcc += aScaled[i];
}
let aLargest = 0; for (let i = 1; i < aScaled.length; i++) if (aScaled[i] > aScaled[aLargest]) aLargest = i;
aScaled[aLargest] += (TOTAL_BITS - aAcc);
const aCum = new Uint32Array(actionList.length + 1);
for (let i = 0; i < actionList.length; i++) aCum[i + 1] = aCum[i] + aScaled[i];

const encStart = performance.now();
const enc = new RangeEncoder();
for (const r of detReceipts) {
  const a = r.action;
  const ai = actionIdx.get(a);
  enc.encode(aCum[ai], aCum[ai + 1], TOTAL_BITS);
  for (const f of ARITH_FIELDS) {
    if (f === 'action') continue; // already coded above
    const val = f === 'payload_json' && r[f] === null ? '\0NULL\0' : (r[f] == null ? '\0NULL\0' : String(r[f]));
    const key = a + '\x01' + f;
    const b = vocab.get(key);
    const vi = b.idxOf.get(val);
    const ct = cumTables.get(key);
    enc.encode(ct.cum[vi], ct.cum[vi + 1], TOTAL_BITS);
  }
}
const coded = enc.finish();
const encMs = performance.now() - encStart;

// --- Serialize side info
// vocabs per (action,field) — brotli-compressed JSON
const sideObj = {
  seed: SEED, n: N,
  actions: actionList,
  buckets: {},
};
for (const [key, b] of vocab.entries()) {
  sideObj.buckets[key] = b.values;
}
const sideBr = brotli11(Buffer.from(JSON.stringify(sideObj), 'utf8'));

const total = coded.length + sideBr.length;
const ratio = detBytes.length / total;

// --- Roundtrip
const decStart = performance.now();
const sideDec = JSON.parse(zlib.brotliDecompressSync(sideBr).toString('utf8'));
const aListD = sideDec.actions;
const bucketsD = sideDec.buckets;
// rebuild cum tables from buckets — but we don't have freqs back! That's a flaw:
// for true decode we need to ship cum tables, not just vocabs. Re-derive freqs from
// the buckets+the receipts? No — decoder has no receipts. We must ship freqs.
// Patch: include scaled freqs in side info.
const sideObj2 = {
  seed: SEED, n: N,
  actions: actionList,
  actionScaled: Array.from(aScaled),
  buckets: {},
  scaled: {},
};
for (const [key, b] of vocab.entries()) {
  sideObj2.buckets[key] = b.values;
  const ct = cumTables.get(key);
  // recover scaled = diff(cum)
  const sc = new Array(b.values.length);
  for (let i = 0; i < b.values.length; i++) sc[i] = ct.cum[i + 1] - ct.cum[i];
  sideObj2.scaled[key] = sc;
}
const sideBr2 = brotli11(Buffer.from(JSON.stringify(sideObj2), 'utf8'));
const total2 = coded.length + sideBr2.length;
const ratio2 = detBytes.length / total2;

// Now actually decode
const dec = new RangeDecoder(coded);
const aCumD = new Uint32Array(aListD.length + 1);
for (let i = 0; i < aListD.length; i++) aCumD[i + 1] = aCumD[i] + sideObj2.actionScaled[i];
const cumD = new Map();
for (const [key, sc] of Object.entries(sideObj2.scaled)) {
  const cum = new Uint32Array(sc.length + 1);
  for (let i = 0; i < sc.length; i++) cum[i + 1] = cum[i] + sc[i];
  cumD.set(key, cum);
}
const reconstructed = [];
for (let i = 0; i < N; i++) {
  const ai = dec.decode(aCumD, TOTAL_BITS);
  const action = aListD[ai];
  const obj = { id: detId(SEED, i), action };
  for (const f of ARITH_FIELDS) {
    if (f === 'action') continue;
    const key = action + '\x01' + f;
    const cum = cumD.get(key);
    const vi = dec.decode(cum, TOTAL_BITS);
    let val = bucketsD[key][vi];
    if (val === '\0NULL\0') val = null;
    if (f === 'payload_json') obj[f] = val;
    else obj[f] = val;
  }
  reconstructed.push(obj);
}
const decMs = performance.now() - decStart;

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;

console.log(`Corpus: ${detBytes.length} bytes, ${N} receipts`);
console.log(`Coded body: ${coded.length} bytes`);
console.log(`Side info (brotli11 over vocabs+freqs): ${sideBr2.length} bytes`);
console.log(`TOTAL: ${total2} bytes`);
console.log(`Ratio: ${ratio2.toFixed(2)}x`);
console.log(`vs M19 (47.07x): ${ratio2 > 47.07 ? `+${(ratio2 - 47.07).toFixed(2)}x` : `-${(47.07 - ratio2).toFixed(2)}x`}`);
console.log(`Roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}: det "${det.slice(Math.max(0,i-40),i+40)}" rec "${recJsonl.slice(Math.max(0,i-40),i+40)}"`);
      break;
    }
  }
}

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify({
  experiment: '123-arithmetic-coding',
  corpus_sha256: '5be5f1b4c6d742e3bbf8d498bc6835590123e9f2242c99a923b82c2b1c6480d4',
  raw_bytes: detBytes.length,
  coded_bytes: coded.length,
  side_bytes: sideBr2.length,
  total_bytes: total2,
  ratio: Number(ratio2.toFixed(4)),
  m19_ratio: 47.07,
  delta_vs_m19: Number((ratio2 - 47.07).toFixed(4)),
  enc_ms: Number(encMs.toFixed(1)),
  dec_ms: Number(decMs.toFixed(1)),
  lossless,
  verdict: lossless && ratio2 >= 47.07 ? 'GREEN' : lossless ? 'AMBER' : 'RED',
}, null, 2));
