// Experiment 93 — Float-quantization stream extraction.
// Extract all numeric fields (from summary + payload_json) into a separate float-stream.
// Quantize to fixed precision (4 decimal places). Encode as deltas. Brotli the result.
// Reinsert at decode. Lossless because we record the exact original string when needed.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const M19_BASELINE = 47.07;

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
// Safe varint for values up to ~2^53 (uses modulo, not bitwise).
function varintU(n) { const b = []; while (n >= 128) { b.push((n % 128) | 0x80); n = Math.floor(n / 128); } b.push(n % 128); return b; }
function varintS(n) { return varintU(n < 0 ? -2 * n - 1 : 2 * n); }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function readVarintS(buf, ofs) { const [u, no] = readVarintU(buf, ofs); const sign = u % 2 === 1; const mag = sign ? (u + 1) / 2 : u / 2; return [sign ? -mag : mag, no]; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const tStart = Date.now();

const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return '\0NULL\0'; return String(s).replace(NUM_RE, '\x01'); }
function extractNums(s) { if (s == null) return []; const ms = String(s).match(NUM_RE); return ms ? [...ms] : []; }

// For each receipt: template summary + template payload_json. Pull out numbers as strings.
// Each number string n -> categorize: integer? Or k decimals?
// Quantize: store as (decimals_count, int_value_at_that_precision). Store ORIGINAL string IFF it doesn't reconstruct.

const shapes = detReceipts.map(r => ({
  action: r.action,
  status: r.status,
  sumTpl: templatize(r.summary),
  payTpl: r.payload_json == null ? null : r.payload_json.replace(NUM_RE, '\x01'),
  created_at: r.created_at,
}));

const allNumStrings = [];
const numCountPerReceipt = [];
for (const r of detReceipts) {
  const sumN = extractNums(r.summary);
  const payN = r.payload_json ? extractNums(r.payload_json) : [];
  numCountPerReceipt.push([sumN.length, payN.length]);
  for (const x of sumN) allNumStrings.push(x);
  for (const x of payN) allNumStrings.push(x);
}

// Encode numbers as: [decimals_byte, varintS(intVal)] OR [255, raw_string_with_terminator] if won't reconstruct.
// decimals: 0..15 → use 4 bits; reserve high nibble for flags.
// Try faithful reconstruction; if it doesn't match (e.g. "1.50" vs "1.5", scientific notation), fall back to raw.

const numStream = []; // bytes
const intVals = []; // for delta-coding (varintS deltas WHEN decimals match prev)
let rawFallback = 0;
let fullReconstructed = 0;
for (const s of allNumStrings) {
  const negative = s.startsWith('-');
  const abs = negative ? s.slice(1) : s;
  const dot = abs.indexOf('.');
  let decimals;
  let canonical;
  if (dot === -1) { decimals = 0; canonical = (negative ? '-' : '') + abs; }
  else {
    decimals = abs.length - dot - 1;
    canonical = (negative ? '-' : '') + abs;
  }
  // Quantize: parse to BigInt-safe int
  // If decimals > 15, fall back
  let useRaw = decimals > 15;
  let intVal = 0;
  if (!useRaw) {
    const intStr = (negative ? '-' : '') + (dot === -1 ? abs : abs.slice(0, dot) + abs.slice(dot + 1));
    intVal = Number(intStr);
    // The zig-zag encoded value is 2*|intVal|+1 (or 2*intVal). Both encoder and decoder must stay
    // within Number.MAX_SAFE_INTEGER (2^53 - 1) to roundtrip exactly.
    const zz = intVal < 0 ? -2 * intVal - 1 : 2 * intVal;
    if (!Number.isSafeInteger(intVal) || !Number.isSafeInteger(zz)) useRaw = true;
    else {
      // Reconstruct & check
      let recStr;
      if (decimals === 0) recStr = String(intVal);
      else {
        const aabs = Math.abs(intVal).toString().padStart(decimals + 1, '0');
        const intPart = aabs.slice(0, aabs.length - decimals);
        const fracPart = aabs.slice(aabs.length - decimals);
        recStr = (intVal < 0 ? '-' : '') + intPart + '.' + fracPart;
      }
      if (recStr !== s) useRaw = true;
      else fullReconstructed++;
    }
  }
  if (useRaw) {
    rawFallback++;
    // 0xFF marker + length-prefixed raw string
    numStream.push(0xff);
    const sb = Buffer.from(s, 'utf8');
    for (const b of varintU(sb.length)) numStream.push(b);
    for (const b of sb) numStream.push(b);
  } else {
    numStream.push(decimals & 0x0f);
    for (const b of varintS(intVal)) numStream.push(b);
  }
}

// Shape vocab — dedupe shape templates (action+status+sumTpl+payTpl+created_at).
const shapeKeys = shapes.map(s => JSON.stringify(s));
const shapeVocab = new Map();
const shapeList = [];
const shapeIdxArr = [];
for (const k of shapeKeys) {
  if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
  shapeIdxArr.push(shapeVocab.get(k));
}
// Sort by string for compression
const indexed = shapeList.map((s, i) => ({ s, i }));
indexed.sort((a, b) => a.s.localeCompare(b.s));
const sortedShapes = indexed.map(x => x.s);
const remap = new Map(); indexed.forEach((x, ni) => remap.set(x.i, ni));
const newIdx = shapeIdxArr.map(i => remap.get(i));

const numCountBytes = Buffer.from(numCountPerReceipt.flat().flatMap(varintU));
const shapesBr = brotli11(brotli11(Buffer.from(sortedShapes.join('\n') + '\n', 'utf8')));
const shapeIdxBr = brotli11(Buffer.from(newIdx.flatMap(varintU)));
const numsBr = brotli11(Buffer.from(numStream));
const numCountBr = brotli11(numCountBytes);
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const encMs = Date.now() - tStart;
const total = shapesBr.length + shapeIdxBr.length + numsBr.length + numCountBr.length + seedR.length;
const ratio = detBytes.length / total;

console.log(`=== EXP 93: Float-Quantize ===`);
console.log(`Numbers total:        ${allNumStrings.length}`);
console.log(`Fully reconstructed:  ${fullReconstructed}`);
console.log(`Raw fallback:         ${rawFallback}`);
console.log(`shapes:               ${shapesBr.length}`);
console.log(`shape idx:            ${shapeIdxBr.length}`);
console.log(`nums:                 ${numsBr.length}`);
console.log(`num counts:           ${numCountBr.length}`);
console.log(`seed:                 ${seedR.length}`);
console.log(`TOTAL:                ${total}`);
console.log(`Ratio:                ${ratio.toFixed(3)}x`);
console.log(`vs M19 (${M19_BASELINE}x): ${(ratio - M19_BASELINE).toFixed(3)}x`);

// ── Roundtrip ──
const tDecStart = Date.now();
const shapesDec = zlib.brotliDecompressSync(zlib.brotliDecompressSync(shapesBr)).toString('utf8').split('\n').filter(Boolean);
const shapeIdxBuf = zlib.brotliDecompressSync(shapeIdxBr);
const numsDec = zlib.brotliDecompressSync(numsBr);
const numCountBuf = zlib.brotliDecompressSync(numCountBr);
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

const shapeIdxDec = []; { let o = 0; while (o < shapeIdxBuf.length) { const [v, n] = readVarintU(shapeIdxBuf, o); shapeIdxDec.push(v); o = n; } }
const numCountDec = []; { let o = 0; while (o < numCountBuf.length) { const [v, n] = readVarintU(numCountBuf, o); numCountDec.push(v); o = n; } }

// Walk numStream and rebuild num strings
const numsRebuilt = [];
{
  let o = 0;
  while (o < numsDec.length) {
    const tag = numsDec[o++];
    if (tag === 0xff) {
      const [len, no] = readVarintU(numsDec, o); o = no;
      const sb = numsDec.slice(o, o + len); o += len;
      numsRebuilt.push(sb.toString('utf8'));
    } else {
      const decimals = tag & 0x0f;
      const [intVal, no] = readVarintS(numsDec, o); o = no;
      let s;
      if (decimals === 0) s = String(intVal);
      else {
        const aabs = Math.abs(intVal).toString().padStart(decimals + 1, '0');
        const intPart = aabs.slice(0, aabs.length - decimals);
        const fracPart = aabs.slice(aabs.length - decimals);
        s = (intVal < 0 ? '-' : '') + intPart + '.' + fracPart;
      }
      numsRebuilt.push(s);
    }
  }
}

const reconstructed = [];
let numI = 0;
for (let i = 0; i < N; i++) {
  const sumNcount = numCountDec[i * 2];
  const payNcount = numCountDec[i * 2 + 1];
  const sumNums = numsRebuilt.slice(numI, numI + sumNcount); numI += sumNcount;
  const payNums = numsRebuilt.slice(numI, numI + payNcount); numI += payNcount;

  const shape = JSON.parse(shapesDec[shapeIdxDec[i]]);
  let summary;
  if (shape.sumTpl === '\0NULL\0') summary = null;
  else { let k = 0; summary = shape.sumTpl.replace(/\x01/g, () => sumNums[k++]); }
  let payload_json;
  if (shape.payTpl === null) payload_json = null;
  else { let k = 0; payload_json = shape.payTpl.replace(/\x01/g, () => payNums[k++]); }

  reconstructed.push({
    id: detId(seedDec.seed, i),
    action: shape.action,
    status: shape.status,
    summary,
    payload_json,
    created_at: shape.created_at,
  });
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
const decMs = Date.now() - tDecStart;

console.log(`Enc ms: ${encMs}, Dec ms: ${decMs}`);
console.log(`Roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  det: ...${det.slice(Math.max(0, i - 80), i + 80)}...`);
      console.log(`  rec: ...${recJsonl.slice(Math.max(0, i - 80), i + 80)}...`);
      break;
    }
  }
}

const summary = {
  experiment: '93-float-quantize',
  N,
  numbers_total: allNumStrings.length,
  numbers_fully_reconstructed: fullReconstructed,
  numbers_raw_fallback: rawFallback,
  total_bytes: total,
  ratio: Number(ratio.toFixed(4)),
  vs_m19: Number((ratio - M19_BASELINE).toFixed(4)),
  enc_ms: encMs,
  dec_ms: decMs,
  lossless,
  raw_jsonl_bytes: detBytes.length,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
