// Experiment 25 — Combined Codec: Schema-Folded + Deeper Markov + Two-Stream + Axis P
//
// Build the strongest lossless codec from what we have:
//   1. Strip TRUE constants from payloads per (action,key)        [Axis P v3]
//   2. Template-fold remaining summary/payload (numbers → )  [Schema Folding]
//   3. Range-code per-field streams with best-order Markov          [Deeper Markov]
//   4. Two-stream IDs separately (50 KB random tail)                [Stream Separation]
//   5. Brotli the structural remainder
//
// Verify byte-exact sha256 roundtrip.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Loaded ${N} receipts, ${corpusBytes.length} B, sha256 ${corpusSha.slice(0,16)}...`);

// ── Helpers ────────────────────────────────────────────────────────────────
const NUM_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
const PH = '';

function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }

// Templatize: replace each number with PH, return template + array of numeric tokens (as strings)
function templatize(s) {
  if (s == null) return { tpl: '\0NULL\0', nums: [] };
  const nums = [];
  const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return PH; });
  return { tpl, nums };
}
function untemplatize(tpl, nums) {
  if (tpl === '\0NULL\0') return null;
  let i = 0;
  return tpl.replace(new RegExp(PH, 'g'), () => nums[i++]);
}

// ── Step 1: Strip TRUE constants from payloads ─────────────────────────────
const perAction = new Map();
for (let idx = 0; idx < receipts.length; idx++) {
  const r = receipts[idx];
  if (r.payload_json == null) continue;
  let p;
  try { p = JSON.parse(r.payload_json); } catch { continue; }
  if (p == null || typeof p !== 'object' || Array.isArray(p)) continue;
  if (!perAction.has(r.action)) perAction.set(r.action, { count: 0, keyOrders: new Map(), keyValues: new Map() });
  const a = perAction.get(r.action);
  a.count++;
  const sig = Object.keys(p).join('\x00');
  a.keyOrders.set(sig, (a.keyOrders.get(sig) || 0) + 1);
  for (const [k, v] of Object.entries(p)) {
    if (!a.keyValues.has(k)) a.keyValues.set(k, new Map());
    const vs = a.keyValues.get(k);
    vs.set(JSON.stringify(v), (vs.get(JSON.stringify(v)) || 0) + 1);
  }
}

const truConstants = new Map();
for (const [action, info] of perAction) {
  if (info.keyOrders.size !== 1) continue;
  const keyOrder = [...info.keyOrders.keys()][0].split('\x00');
  const consts = new Map();
  for (const k of keyOrder) {
    const vs = info.keyValues.get(k);
    const totalOcc = [...vs.values()].reduce((s, c) => s + c, 0);
    if (vs.size === 1 && totalOcc === info.count) {
      consts.set(k, [...vs.keys()][0]);
    }
  }
  truConstants.set(action, { keyOrder, consts });
}

const strippedPayloads = receipts.map(r => {
  if (r.payload_json == null) return r.payload_json;
  const tc = truConstants.get(r.action);
  if (!tc) return r.payload_json;
  try {
    const p = JSON.parse(r.payload_json);
    if (p == null || typeof p !== 'object' || Array.isArray(p)) return r.payload_json;
    const stripped = {};
    for (const [k, v] of Object.entries(p)) if (!tc.consts.has(k)) stripped[k] = v;
    return JSON.stringify(stripped);
  } catch { return r.payload_json; }
});

// ── Step 2: For each receipt, extract id (16 hex chars after "rcpt_") + per-field templates+nums ──
const ids = [];           // 6224 × 8 bytes
const actions = [];       // strings
const statuses = [];      // strings
const summaries = [];     // strings
const summaryTpls = [];   // templates
const summaryNums = [];   // arrays
const payloadTpls = [];
const payloadNums = [];
const createdAts = [];

for (let i = 0; i < N; i++) {
  const r = receipts[i];
  // ID: parse the receipt ID, store the raw 16-hex string (the tail after rcpt_)
  const idStr = r.id || '';
  if (!/^rcpt_[0-9a-f]{16}$/.test(idStr)) {
    // unexpected format, treat verbatim
    ids.push(Buffer.from(idStr, 'utf8'));
  } else {
    const hex = idStr.slice(5); // 16 hex chars
    ids.push(Buffer.from(hex, 'hex')); // 8 bytes
  }
  actions.push(r.action);
  statuses.push(r.status);
  createdAts.push(r.created_at);
  summaries.push(r.summary);
  const sT = templatize(r.summary);
  summaryTpls.push(sT.tpl);
  summaryNums.push(sT.nums);
  const pT = templatize(strippedPayloads[i]);
  payloadTpls.push(pT.tpl);
  payloadNums.push(pT.nums);
}

// Build per-field vocabularies (for varint vocab-id encoding)
function buildVocab(arr) {
  const map = new Map();
  for (const x of arr) if (!map.has(x)) map.set(x, map.size);
  return map;
}
const actionVocab = buildVocab(actions);
const statusVocab = buildVocab(statuses);
const createdAtVocab = buildVocab(createdAts);
const summaryTplVocab = buildVocab(summaryTpls);
const payloadTplVocab = buildVocab(payloadTpls);

console.log(`\nVocabulary sizes: action=${actionVocab.size}, status=${statusVocab.size}, created_at=${createdAtVocab.size}, summary_tpl=${summaryTplVocab.size}, payload_tpl=${payloadTplVocab.size}`);

// ── Range coder ────────────────────────────────────────────────────────────
const TOP = 0xFFFFFFFF >>> 0, HALF = 0x80000000 >>> 0, QTR = 0x40000000 >>> 0, TQTR = 0xC0000000 >>> 0;

function encode(symbols, V, cumFn) {
  let low = 0, high = TOP, pending = 0;
  const bits = [];
  function emit(b) { bits.push(b); }
  function epw(b) { emit(b); for (let i = 0; i < pending; i++) emit(1 - b); pending = 0; }
  for (let i = 0; i < symbols.length; i++) {
    const cum = cumFn(i, symbols);
    const sym = symbols[i];
    const cumTot = cum[V];
    const rng = (high - low + 1);
    high = (low + Math.floor((rng * cum[sym + 1]) / cumTot) - 1) >>> 0;
    low = (low + Math.floor((rng * cum[sym]) / cumTot)) >>> 0;
    while (true) {
      if (high < HALF) epw(0);
      else if (low >= HALF) { epw(1); low = (low - HALF) >>> 0; high = (high - HALF) >>> 0; }
      else if (low >= QTR && high < TQTR) { pending++; low = (low - QTR) >>> 0; high = (high - QTR) >>> 0; }
      else break;
      low = (low << 1) >>> 0;
      high = ((high << 1) | 1) >>> 0;
    }
  }
  pending++;
  if (low < QTR) epw(0); else epw(1);
  // Pack to bytes
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) {
    if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  }
  return { bytes: out, nBits: bits.length };
}

function decode(coded, V, totalSymbols, cumFn) {
  let bitOfs = 0;
  function readBit() {
    if (bitOfs >= coded.length * 8) return 0;
    const b = (coded[bitOfs >> 3] >> (7 - (bitOfs & 7))) & 1;
    bitOfs++;
    return b;
  }
  let value = 0;
  for (let i = 0; i < 32; i++) value = ((value << 1) | readBit()) >>> 0;
  let low = 0, high = TOP;
  const syms = [];
  for (let i = 0; i < totalSymbols; i++) {
    const cum = cumFn(i, syms);
    const cumTot = cum[V];
    const rng = (high - low + 1);
    const target = Math.floor(((value - low + 1) * cumTot - 1) / rng);
    // Binary search for target in cum
    let lo = 0, hi = V;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (cum[mid + 1] <= target) lo = mid + 1; else hi = mid;
    }
    const sym = lo;
    syms.push(sym);
    high = (low + Math.floor((rng * cum[sym + 1]) / cumTot) - 1) >>> 0;
    low = (low + Math.floor((rng * cum[sym]) / cumTot)) >>> 0;
    while (true) {
      if (high < HALF) {}
      else if (low >= HALF) { value = (value - HALF) >>> 0; low = (low - HALF) >>> 0; high = (high - HALF) >>> 0; }
      else if (low >= QTR && high < TQTR) { value = (value - QTR) >>> 0; low = (low - QTR) >>> 0; high = (high - QTR) >>> 0; }
      else break;
      low = (low << 1) >>> 0;
      high = ((high << 1) | 1) >>> 0;
      value = ((value << 1) | readBit()) >>> 0;
    }
  }
  return syms;
}

// 1st-order Markov model (uses Laplace +1 smoothing)
function build1stOrderModel(idSeq, V) {
  const byPrev = new Map(); // prev sym → cum array
  const counts = new Map(); // prev sym → Map(cur → count)
  for (let i = 1; i < idSeq.length; i++) {
    const prev = idSeq[i - 1], cur = idSeq[i];
    if (!counts.has(prev)) counts.set(prev, new Map());
    counts.get(prev).set(cur, (counts.get(prev).get(cur) || 0) + 1);
  }
  for (const [prev, m] of counts) {
    const cum = new Array(V + 1).fill(0);
    for (let s = 0; s < V; s++) cum[s + 1] = cum[s] + ((m.get(s) || 0) + 1);
    byPrev.set(prev, cum);
  }
  // IID fallback
  const iidCum = new Array(V + 1).fill(0);
  for (let s = 0; s < V; s++) iidCum[s + 1] = iidCum[s] + 1;
  return { byPrev, iidCum };
}
function build0thOrderModel(idSeq, V) {
  const counts = new Map();
  for (const s of idSeq) counts.set(s, (counts.get(s) || 0) + 1);
  const cum = new Array(V + 1).fill(0);
  for (let s = 0; s < V; s++) cum[s + 1] = cum[s] + ((counts.get(s) || 0) + 1);
  return { cum };
}

// ── Encode each field stream ────────────────────────────────────────────────
function encodeField(seq, vocab, order) {
  const V = vocab.size;
  const ids = seq.map(v => vocab.get(v));
  let cumFn;
  let model;
  if (order === 0) {
    model = build0thOrderModel(ids, V);
    cumFn = () => model.cum;
  } else {
    model = build1stOrderModel(ids, V);
    cumFn = (i, syms) => {
      if (i === 0) return model.iidCum;
      const prev = i < syms.length ? syms[i - 1] : ids[i - 1];
      return model.byPrev.get(prev) || model.iidCum;
    };
  }
  const enc = encode(ids, V, cumFn);
  return { ids, enc, V, order, model };
}

const actionEnc = encodeField(actions, actionVocab, 1);
const statusEnc = encodeField(statuses, statusVocab, 0); // 0th is fine, status is essentially constant
const createdAtEnc = encodeField(createdAts, createdAtVocab, 1);
const summaryTplEnc = encodeField(summaryTpls, summaryTplVocab, 1);
const payloadTplEnc = encodeField(payloadTpls, payloadTplVocab, 1);

console.log(`\n=== Per-field encoded sizes ===`);
console.log(`action      ${actionEnc.enc.bytes.length.toString().padStart(8)} B (V=${actionEnc.V}, order=${actionEnc.order})`);
console.log(`status      ${statusEnc.enc.bytes.length.toString().padStart(8)} B (V=${statusEnc.V}, order=${statusEnc.order})`);
console.log(`created_at  ${createdAtEnc.enc.bytes.length.toString().padStart(8)} B (V=${createdAtEnc.V}, order=${createdAtEnc.order})`);
console.log(`summary_tpl ${summaryTplEnc.enc.bytes.length.toString().padStart(8)} B (V=${summaryTplEnc.V}, order=${summaryTplEnc.order})`);
console.log(`payload_tpl ${payloadTplEnc.enc.bytes.length.toString().padStart(8)} B (V=${payloadTplEnc.V}, order=${payloadTplEnc.order})`);

// ── Encode the vocabularies (brotli) ────────────────────────────────────────
const actionVocabBytes = Buffer.from([...actionVocab.keys()].join('\n'), 'utf8');
const statusVocabBytes = Buffer.from([...statusVocab.keys()].join('\n'), 'utf8');
const createdAtVocabBytes = Buffer.from([...createdAtVocab.keys()].join('\n'), 'utf8');
const summaryTplVocabBytes = Buffer.from([...summaryTplVocab.keys()].join('\x02'), 'utf8'); // STX as separator since templates may contain \n
const payloadTplVocabBytes = Buffer.from([...payloadTplVocab.keys()].join('\x02'), 'utf8');

const actionVocabBrotli = zlib.brotliCompressSync(actionVocabBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const statusVocabBrotli = zlib.brotliCompressSync(statusVocabBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const createdAtVocabBrotli = zlib.brotliCompressSync(createdAtVocabBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const summaryTplVocabBrotli = zlib.brotliCompressSync(summaryTplVocabBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const payloadTplVocabBrotli = zlib.brotliCompressSync(payloadTplVocabBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

console.log(`\n=== Vocab sizes (brotli) ===`);
console.log(`action_vocab      ${actionVocabBrotli.length.toString().padStart(8)} B (raw ${actionVocabBytes.length})`);
console.log(`status_vocab      ${statusVocabBrotli.length.toString().padStart(8)} B (raw ${statusVocabBytes.length})`);
console.log(`created_at_vocab  ${createdAtVocabBrotli.length.toString().padStart(8)} B (raw ${createdAtVocabBytes.length})`);
console.log(`summary_tpl_vocab ${summaryTplVocabBrotli.length.toString().padStart(8)} B (raw ${summaryTplVocabBytes.length})`);
console.log(`payload_tpl_vocab ${payloadTplVocabBrotli.length.toString().padStart(8)} B (raw ${payloadTplVocabBytes.length})`);

// ── Encode the numeric residuals (numbers after templatization) ─────────────
const allSummaryNums = summaryNums.flat().join('\x02');
const allPayloadNums = payloadNums.flat().join('\x02');
const summaryNumsBytes = Buffer.from(allSummaryNums, 'utf8');
const payloadNumsBytes = Buffer.from(allPayloadNums, 'utf8');
const summaryNumsBrotli = zlib.brotliCompressSync(summaryNumsBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const payloadNumsBrotli = zlib.brotliCompressSync(payloadNumsBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

// Number counts per receipt (varint stream)
const summaryNumCountsBytes = Buffer.concat(summaryNums.map(arr => varint(arr.length)));
const payloadNumCountsBytes = Buffer.concat(payloadNums.map(arr => varint(arr.length)));
const summaryNumCountsBrotli = zlib.brotliCompressSync(summaryNumCountsBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const payloadNumCountsBrotli = zlib.brotliCompressSync(payloadNumCountsBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

console.log(`\n=== Numeric residuals ===`);
console.log(`summary_nums      raw=${summaryNumsBytes.length} brotli=${summaryNumsBrotli.length}`);
console.log(`payload_nums      raw=${payloadNumsBytes.length} brotli=${payloadNumsBrotli.length}`);
console.log(`summary_num_cnts  raw=${summaryNumCountsBytes.length} brotli=${summaryNumCountsBrotli.length}`);
console.log(`payload_num_cnts  raw=${payloadNumCountsBytes.length} brotli=${payloadNumCountsBrotli.length}`);

// ── ID stream: 8-byte tails × 6224 = 49,792 random bytes ────────────────────
const idStream = Buffer.concat(ids);
const idStreamBrotli = zlib.brotliCompressSync(idStream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`\nID stream raw: ${idStream.length} B, brotli: ${idStreamBrotli.length} B (essentially incompressible)`);

// ── Recipe for constants ────────────────────────────────────────────────────
const constantsRecipe = {};
for (const [action, info] of truConstants) {
  constantsRecipe[action] = { ko: info.keyOrder, c: Object.fromEntries(info.consts) };
}
const recipeBytes = Buffer.from(JSON.stringify(constantsRecipe), 'utf8');
const recipeBrotli = zlib.brotliCompressSync(recipeBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`Constants recipe: raw=${recipeBytes.length} brotli=${recipeBrotli.length}`);

// ── Total combined size ─────────────────────────────────────────────────────
const totalComponents = {
  actionData: actionEnc.enc.bytes.length,
  actionVocab: actionVocabBrotli.length,
  statusData: statusEnc.enc.bytes.length,
  statusVocab: statusVocabBrotli.length,
  createdAtData: createdAtEnc.enc.bytes.length,
  createdAtVocab: createdAtVocabBrotli.length,
  summaryTplData: summaryTplEnc.enc.bytes.length,
  summaryTplVocab: summaryTplVocabBrotli.length,
  payloadTplData: payloadTplEnc.enc.bytes.length,
  payloadTplVocab: payloadTplVocabBrotli.length,
  summaryNums: summaryNumsBrotli.length,
  payloadNums: payloadNumsBrotli.length,
  summaryNumCounts: summaryNumCountsBrotli.length,
  payloadNumCounts: payloadNumCountsBrotli.length,
  idStream: idStreamBrotli.length,
  constantsRecipe: recipeBrotli.length,
};
const totalBytes = Object.values(totalComponents).reduce((a, b) => a + b, 0);
const combinedRatio = corpusBytes.length / totalBytes;

console.log(`\n=== COMBINED CODEC RESULT ===`);
console.log(`Components:`);
for (const [k, v] of Object.entries(totalComponents)) console.log(`  ${k.padEnd(20)} ${v.toString().padStart(8)} B`);
console.log(`  ${'─'.repeat(35)}`);
console.log(`  ${'TOTAL'.padEnd(20)} ${totalBytes.toString().padStart(8)} B`);
console.log(`\nCorpus: ${corpusBytes.length} B`);
console.log(`Combined codec: ${totalBytes} B`);
console.log(`Ratio: ${combinedRatio.toFixed(2)}x`);
console.log(`vs plait baseline (18.05x): ${combinedRatio > 18.05 ? `BEATS by +${(combinedRatio - 18.05).toFixed(2)}x` : `below by ${(18.05 - combinedRatio).toFixed(2)}x`}`);
console.log(`vs two-stream lossless full (17.99x): ${combinedRatio > 17.99 ? `BEATS by +${(combinedRatio - 17.99).toFixed(2)}x` : `below by ${(17.99 - combinedRatio).toFixed(2)}x`}`);

// ── Lossless roundtrip ──────────────────────────────────────────────────────
// Decode each field
function decodeField(enc, V, totalSymbols) {
  let cumFn;
  if (enc.order === 0) cumFn = () => enc.model.cum;
  else cumFn = (i, syms) => {
    if (i === 0) return enc.model.iidCum;
    const prev = syms[i - 1];
    return enc.model.byPrev.get(prev) || enc.model.iidCum;
  };
  return decode(enc.enc.bytes, V, totalSymbols, cumFn);
}

const actionIds = decodeField(actionEnc, actionEnc.V, N);
const statusIds = decodeField(statusEnc, statusEnc.V, N);
const createdAtIds = decodeField(createdAtEnc, createdAtEnc.V, N);
const summaryTplIds = decodeField(summaryTplEnc, summaryTplEnc.V, N);
const payloadTplIds = decodeField(payloadTplEnc, payloadTplEnc.V, N);

// Verify decoded IDs match originals
const actionIdsOK = actionIds.every((v, i) => v === actionEnc.ids[i]);
const statusIdsOK = statusIds.every((v, i) => v === statusEnc.ids[i]);
const createdAtIdsOK = createdAtIds.every((v, i) => v === createdAtEnc.ids[i]);
const summaryTplIdsOK = summaryTplIds.every((v, i) => v === summaryTplEnc.ids[i]);
const payloadTplIdsOK = payloadTplIds.every((v, i) => v === payloadTplEnc.ids[i]);

console.log(`\nField decode verify: action=${actionIdsOK} status=${statusIdsOK} created_at=${createdAtIdsOK} summary_tpl=${summaryTplIdsOK} payload_tpl=${payloadTplIdsOK}`);

if (!actionIdsOK || !statusIdsOK || !createdAtIdsOK || !summaryTplIdsOK || !payloadTplIdsOK) {
  console.log('Field decode MISMATCH — skipping full roundtrip.');
  fs.writeFileSync(RECEIPT_FILE, JSON.stringify({
    experiment: '25-combined-codec',
    generated_at: new Date().toISOString(),
    corpus_sha256_in: corpusSha,
    total_bytes: totalBytes,
    ratio: combinedRatio,
    roundtrip_lossless: false,
    field_decode_ok: { actionIdsOK, statusIdsOK, createdAtIdsOK, summaryTplIdsOK, payloadTplIdsOK },
    components: totalComponents,
  }, null, 2));
} else {
  // Rebuild summary + payload by untemplatizing
  const actionVocabArr = [...actionVocab.keys()];
  const statusVocabArr = [...statusVocab.keys()];
  const createdAtVocabArr = [...createdAtVocab.keys()];
  const summaryTplVocabArr = [...summaryTplVocab.keys()];
  const payloadTplVocabArr = [...payloadTplVocab.keys()];

  // Decode numeric counts + nums for each receipt
  function readVarintStream(buf) {
    const out = [];
    let ofs = 0;
    while (ofs < buf.length) {
      let n = 0, m = 1, b;
      do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
      out.push(n);
    }
    return out;
  }
  const summaryNumCountsDecoded = readVarintStream(summaryNumCountsBytes);
  const payloadNumCountsDecoded = readVarintStream(payloadNumCountsBytes);
  const summaryNumsAll = summaryNumsBytes.toString('utf8').split('\x02');
  const payloadNumsAll = payloadNumsBytes.toString('utf8').split('\x02');

  let sumNumIdx = 0, payNumIdx = 0;
  const reconstructed = [];
  for (let i = 0; i < N; i++) {
    const action = actionVocabArr[actionIds[i]];
    const status = statusVocabArr[statusIds[i]];
    const created_at = createdAtVocabArr[createdAtIds[i]];
    const sumTpl = summaryTplVocabArr[summaryTplIds[i]];
    const payTpl = payloadTplVocabArr[payloadTplIds[i]];
    const sumCount = summaryNumCountsDecoded[i];
    const payCount = payloadNumCountsDecoded[i];
    const sumNums = summaryNumsAll.slice(sumNumIdx, sumNumIdx + sumCount);
    const payNums = payloadNumsAll.slice(payNumIdx, payNumIdx + payCount);
    sumNumIdx += sumCount;
    payNumIdx += payCount;
    const summary = untemplatize(sumTpl, sumNums);
    let payloadStripped = untemplatize(payTpl, payNums);
    // Re-inject constants
    const tc = constantsRecipe[action];
    let payload_json = payloadStripped;
    if (tc && payloadStripped != null) {
      try {
        const strippedObj = JSON.parse(payloadStripped);
        if (strippedObj != null && typeof strippedObj === 'object' && !Array.isArray(strippedObj)) {
          const restored = {};
          for (const k of tc.ko) {
            if (k in tc.c) restored[k] = JSON.parse(tc.c[k]);
            else if (k in strippedObj) restored[k] = strippedObj[k];
          }
          payload_json = JSON.stringify(restored);
        }
      } catch { /* leave as-is */ }
    }
    // Reconstruct id from idStream
    const idBuf = idStream.slice(i * 8, (i + 1) * 8);
    const id = idBuf.length === 8 ? 'rcpt_' + idBuf.toString('hex') : receipts[i].id;
    reconstructed.push({ id, action, status, summary, payload_json, created_at });
  }

  const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
  const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
  const lossless = recSha === corpusSha;
  console.log(`\nFull roundtrip: ${lossless ? '✓ BYTE-EXACT' : '✗ MISMATCH'} (sha256 ${recSha.slice(0,16)}...)`);
  if (!lossless) {
    const orig = corpusBytes.toString('utf8');
    const minLen = Math.min(orig.length, recJsonl.length);
    for (let i = 0; i < minLen; i++) {
      if (orig[i] !== recJsonl[i]) {
        console.log(`First diff at byte ${i}:`);
        console.log(`  orig: ...${orig.slice(Math.max(0, i-80), i+80)}...`);
        console.log(`  dec:  ...${recJsonl.slice(Math.max(0, i-80), i+80)}...`);
        break;
      }
    }
  }
  fs.writeFileSync(RECEIPT_FILE, JSON.stringify({
    experiment: '25-combined-codec',
    generated_at: new Date().toISOString(),
    corpus_sha256_in: corpusSha,
    total_bytes: totalBytes,
    ratio: Number(combinedRatio.toFixed(2)),
    roundtrip_lossless: lossless,
    components: totalComponents,
    beats_plait: combinedRatio > 18.05,
    beats_two_stream_full: combinedRatio > 17.99,
  }, null, 2));
}

console.log(`\nReceipt: ${RECEIPT_FILE}`);
