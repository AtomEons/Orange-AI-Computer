// Experiment 36 — Verified dedupe + det-ID + receipt-Markov codec
//
// Exp 35 finding: 49.7% of receipts are byte-duplicates modulo id. Build
// a lossless codec that:
//   1. Det-IDs (regen from seed)
//   2. Dedupe receipts: store unique-receipt-set + per-position index into it
//   3. Range-code the index sequence using receipt-Markov (1st-order)
//   4. Verify byte-exact roundtrip against det-corpus

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
console.log(`Original corpus: ${corpusBytes.length} B, ${N} receipts`);

const SEED = 'orange5-receipt-stream-v1';
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }

// Build det-corpus
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
console.log(`Det-ID corpus:   ${detBytes.length} B, sha ${detSha.slice(0,16)}...`);

function brotli11(b) {
  return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}

function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

// ── METHOD 1: Receipt-dedupe (keep det-IDs separate) ──────────────────────
// Each receipt minus id is the "shape"; we dedupe shapes and store an index sequence
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const shapeVocab = new Map();
const shapeList = [];
const indexSeq = [];
for (const r of detReceipts) {
  const k = shapeKey(r);
  if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
  indexSeq.push(shapeVocab.get(k));
}
console.log(`\nUnique shapes (mod id): ${shapeList.length}`);
console.log(`Index sequence length: ${indexSeq.length}`);

// Shapes: serialize as JSONL
const shapesJsonl = shapeList.join('\n') + '\n';
const shapesBytes = Buffer.from(shapesJsonl, 'utf8');
const shapesBrotli = brotli11(shapesBytes);

// Index sequence: varint encode
const idxBytes = Buffer.from(indexSeq.flatMap(varintU));
const idxBrotli = brotli11(idxBytes);

// Seed recipe
const seedR = Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8');
const seedBrotli = brotli11(seedR);

const m1Total = shapesBrotli.length + idxBrotli.length + seedBrotli.length;
const m1Ratio = detBytes.length / m1Total;
console.log(`\n=== METHOD 1: dedupe + det-IDs + brotli on each ===`);
console.log(`Shapes brotli:    ${shapesBrotli.length.toString().padStart(7)} B`);
console.log(`Index brotli:     ${idxBrotli.length.toString().padStart(7)} B`);
console.log(`Seed recipe:      ${seedBrotli.length.toString().padStart(7)} B`);
console.log(`Total:            ${m1Total.toString().padStart(7)} B`);
console.log(`Ratio vs det:     ${m1Ratio.toFixed(2)}x`);
console.log(`Ratio vs orig:    ${(corpusBytes.length / m1Total).toFixed(2)}x`);

// Verify roundtrip
const shapesDec = zlib.brotliDecompressSync(shapesBrotli).toString('utf8').split('\n').filter(Boolean);
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedBrotli).toString('utf8'));
let idxDec = []; { let ofs = 0; while (ofs < idxBytes.length) { const [v, n] = readVarintU(idxBytes, ofs); idxDec.push(v); ofs = n; } }
const reconst = idxDec.map((idx, i) => {
  const shape = JSON.parse(shapesDec[idx]);
  shape.id = detId(seedDec.seed, i);
  return shape;
});
const recJsonl = reconst.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const m1Lossless = recSha === detSha;
console.log(`Method 1 roundtrip: ${m1Lossless ? '✓ BYTE-EXACT vs det' : '✗ MISMATCH'}`);

// ── METHOD 2: Same as Method 1 BUT use receipt-Markov range coder for index sequence ──
// Conditional H(idx | prev_idx) — should be much less than IID
function arithEncode(symbols, V, cumFn) {
  const TOP = 0xFFFFFFFF >>> 0, HALF = 0x80000000 >>> 0, QTR = 0x40000000 >>> 0, TQTR = 0xC0000000 >>> 0;
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
  const out = Buffer.alloc(Math.ceil(bits.length / 8));
  for (let i = 0; i < bits.length; i++) if (bits[i]) out[i >> 3] |= 1 << (7 - (i & 7));
  return { bytes: out, nBits: bits.length };
}
function arithDecode(coded, V, totalSyms, cumFn) {
  const TOP = 0xFFFFFFFF >>> 0, HALF = 0x80000000 >>> 0, QTR = 0x40000000 >>> 0, TQTR = 0xC0000000 >>> 0;
  let bitOfs = 0;
  function readBit() { if (bitOfs >= coded.length * 8) return 0; const b = (coded[bitOfs >> 3] >> (7 - (bitOfs & 7))) & 1; bitOfs++; return b; }
  let value = 0;
  for (let i = 0; i < 32; i++) value = ((value << 1) | readBit()) >>> 0;
  let low = 0, high = TOP;
  const syms = [];
  for (let i = 0; i < totalSyms; i++) {
    const cum = cumFn(i, syms);
    const cumTot = cum[V];
    const rng = (high - low + 1);
    const target = Math.floor(((value - low + 1) * cumTot - 1) / rng);
    let lo = 0, hi = V;
    while (lo < hi) { const mid = (lo + hi) >>> 1; if (cum[mid + 1] <= target) lo = mid + 1; else hi = mid; }
    const sym = lo;
    syms.push(sym);
    high = (low + Math.floor((rng * cum[sym + 1]) / cumTot) - 1) >>> 0;
    low = (low + Math.floor((rng * cum[sym]) / cumTot)) >>> 0;
    while (true) {
      if (high < HALF) {}
      else if (low >= HALF) { value = (value - HALF) >>> 0; low = (low - HALF) >>> 0; high = (high - HALF) >>> 0; }
      else if (low >= QTR && high < TQTR) { value = (value - QTR) >>> 0; low = (low - QTR) >>> 0; high = (high - QTR) >>> 0; }
      else break;
      low = (low << 1) >>> 0; high = ((high << 1) | 1) >>> 0; value = ((value << 1) | readBit()) >>> 0;
    }
  }
  return syms;
}

const V = shapeList.length;
// Build 1st-order Markov model
const ctxCounts = new Map();
for (let i = 1; i < indexSeq.length; i++) {
  const prev = indexSeq[i-1];
  if (!ctxCounts.has(prev)) ctxCounts.set(prev, new Map());
  ctxCounts.get(prev).set(indexSeq[i], (ctxCounts.get(prev).get(indexSeq[i]) || 0) + 1);
}
const cumByCtx = new Map();
for (const [prev, m] of ctxCounts) {
  const cum = new Array(V + 1).fill(0);
  for (let s = 0; s < V; s++) cum[s + 1] = cum[s] + ((m.get(s) || 0) + 1);
  cumByCtx.set(prev, cum);
}
const iidCum = new Array(V + 1).fill(0);
for (let s = 0; s < V; s++) iidCum[s + 1] = iidCum[s] + 1;

const cumFn = (i, syms) => {
  if (i === 0) return iidCum;
  const prev = syms[i - 1];
  return cumByCtx.get(prev) || iidCum;
};
const encoded = arithEncode(indexSeq, V, cumFn);
console.log(`\nReceipt-Markov range coder: ${encoded.bytes.length} B, ${encoded.nBits} bits = ${(encoded.nBits / indexSeq.length).toFixed(3)} bps`);

// Method 2 total: shapesBrotli + arith-coded indices + seed
const m2Total = shapesBrotli.length + encoded.bytes.length + seedBrotli.length;
const m2Ratio = detBytes.length / m2Total;
console.log(`Method 2 total (shapes + Markov idx + seed): ${m2Total} B = ${m2Ratio.toFixed(2)}x`);

// Verify Method 2 roundtrip
const m2IdxDec = arithDecode(encoded.bytes, V, N, cumFn);
const m2Match = m2IdxDec.every((v, i) => v === indexSeq[i]);
console.log(`Method 2 index decode match: ${m2Match ? '✓' : '✗'}`);
const m2Reconst = m2IdxDec.map((idx, i) => {
  const shape = JSON.parse(shapesDec[idx]);
  shape.id = detId(seedDec.seed, i);
  return shape;
});
const m2Jsonl = m2Reconst.map(r => JSON.stringify(r)).join('\n') + '\n';
const m2Sha = crypto.createHash('sha256').update(m2Jsonl).digest('hex');
const m2Lossless = m2Sha === detSha;
console.log(`Method 2 roundtrip: ${m2Lossless ? '✓ BYTE-EXACT vs det' : '✗ MISMATCH'}`);

// ── METHOD 3: Drop mesh.compress.ratio (schema fold) + dedupe + Markov ─────
const folded = detReceipts.map(r => {
  if (r.action !== 'mesh.compress' || r.payload_json == null) return r;
  try {
    const p = JSON.parse(r.payload_json);
    delete p.ratio;
    return { ...r, payload_json: JSON.stringify(p) };
  } catch { return r; }
});
const foldedShapeVocab = new Map();
const foldedShapeList = [];
const foldedIndexSeq = [];
for (const r of folded) {
  const k = shapeKey(r);
  if (!foldedShapeVocab.has(k)) { foldedShapeVocab.set(k, foldedShapeList.length); foldedShapeList.push(k); }
  foldedIndexSeq.push(foldedShapeVocab.get(k));
}
console.log(`\nWith mesh.compress.ratio dropped: ${foldedShapeList.length} unique shapes`);
const foldedShapesJsonl = foldedShapeList.join('\n') + '\n';
const foldedShapesBrotli = brotli11(Buffer.from(foldedShapesJsonl, 'utf8'));

// Build folded model
const foldedCtxCounts = new Map();
for (let i = 1; i < foldedIndexSeq.length; i++) {
  const prev = foldedIndexSeq[i-1];
  if (!foldedCtxCounts.has(prev)) foldedCtxCounts.set(prev, new Map());
  foldedCtxCounts.get(prev).set(foldedIndexSeq[i], (foldedCtxCounts.get(prev).get(foldedIndexSeq[i]) || 0) + 1);
}
const foldedV = foldedShapeList.length;
const foldedCumByCtx = new Map();
for (const [prev, m] of foldedCtxCounts) {
  const cum = new Array(foldedV + 1).fill(0);
  for (let s = 0; s < foldedV; s++) cum[s + 1] = cum[s] + ((m.get(s) || 0) + 1);
  foldedCumByCtx.set(prev, cum);
}
const foldedIidCum = new Array(foldedV + 1).fill(0);
for (let s = 0; s < foldedV; s++) foldedIidCum[s + 1] = foldedIidCum[s] + 1;
const foldedCumFn = (i, syms) => {
  if (i === 0) return foldedIidCum;
  const prev = syms[i - 1];
  return foldedCumByCtx.get(prev) || foldedIidCum;
};
const foldedEncoded = arithEncode(foldedIndexSeq, foldedV, foldedCumFn);

const m3Total = foldedShapesBrotli.length + foldedEncoded.bytes.length + seedBrotli.length;
const m3Ratio = detBytes.length / m3Total;
console.log(`Method 3 (schema-fold + dedupe + Markov): ${m3Total} B = ${m3Ratio.toFixed(2)}x`);

// Method 3 verification: decode, restore ratios
const m3Shapes = zlib.brotliDecompressSync(foldedShapesBrotli).toString('utf8').split('\n').filter(Boolean);
const m3IdxDec = arithDecode(foldedEncoded.bytes, foldedV, N, foldedCumFn);
const m3Reconst = m3IdxDec.map((idx, i) => {
  const shape = JSON.parse(m3Shapes[idx]);
  shape.id = detId(seedDec.seed, i);
  // Restore ratio for mesh.compress
  if (shape.action === 'mesh.compress' && shape.payload_json) {
    try {
      const p = JSON.parse(shape.payload_json);
      if (p.raw_bytes && p.compressed_bytes) {
        p.ratio = Math.round((p.raw_bytes / p.compressed_bytes) * 100) / 100;
        // Re-insert into payload_json in original key order
        // Need to know the original key order — store it in the shape? Or just JSON.stringify with consistent ordering
        // For our payloads: raw_bytes comes first, compressed_bytes second, ratio third
        const orderedKeys = ['raw_bytes', 'compressed_bytes', 'ratio'];
        const reordered = {};
        for (const k of orderedKeys) if (k in p) reordered[k] = p[k];
        for (const k of Object.keys(p)) if (!(k in reordered)) reordered[k] = p[k];
        shape.payload_json = JSON.stringify(reordered);
      }
    } catch {}
  }
  return shape;
});
const m3Jsonl = m3Reconst.map(r => JSON.stringify(r)).join('\n') + '\n';
const m3Sha = crypto.createHash('sha256').update(m3Jsonl).digest('hex');
const m3Lossless = m3Sha === detSha;
console.log(`Method 3 roundtrip: ${m3Lossless ? '✓ BYTE-EXACT vs det' : '✗ MISMATCH'}`);
if (!m3Lossless) {
  // Find first diff
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, m3Jsonl.length); i++) {
    if (det[i] !== m3Jsonl[i]) {
      console.log(`  First diff at byte ${i}:`);
      console.log(`    det: ...${det.slice(Math.max(0, i-80), i+80)}...`);
      console.log(`    rec: ...${m3Jsonl.slice(Math.max(0, i-80), i+80)}...`);
      break;
    }
  }
}

// ── SUMMARY ─────────────────────────────────────────────────────────────
console.log(`\n=== FINAL SUMMARY ===`);
console.log(`Method 1: dedupe + det-ID + brotli       ${m1Total.toString().padStart(7)} B = ${m1Ratio.toFixed(2)}x  ${m1Lossless ? '✓' : '✗'}`);
console.log(`Method 2: dedupe + Markov + det-ID       ${m2Total.toString().padStart(7)} B = ${m2Ratio.toFixed(2)}x  ${m2Lossless ? '✓' : '✗'}`);
console.log(`Method 3: schema-fold + dedupe + Markov  ${m3Total.toString().padStart(7)} B = ${m3Ratio.toFixed(2)}x  ${m3Lossless ? '✓' : '✗'}`);
console.log(``);
console.log(`Prior best (Exp 31 det-regen):           ~66,122 B = 31.39x`);

const out = {
  experiment: '36-dedupe-verified',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  det_corpus_sha256: detSha,
  unique_shapes: shapeList.length,
  method_1: { total: m1Total, ratio: Number(m1Ratio.toFixed(2)), lossless: m1Lossless, shapes_brotli: shapesBrotli.length, idx_brotli: idxBrotli.length, seed: seedBrotli.length },
  method_2: { total: m2Total, ratio: Number(m2Ratio.toFixed(2)), lossless: m2Lossless, markov_data: encoded.bytes.length, bits_per_sym: encoded.nBits / indexSeq.length },
  method_3: { total: m3Total, ratio: Number(m3Ratio.toFixed(2)), lossless: m3Lossless, schema_folded: true },
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(out, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
