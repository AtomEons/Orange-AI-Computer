// Experiment 38 — Method 5: receipt-dedupe + schema-fold (banker's rounding)
//
// Drop mesh.compress.ratio (derivable as banker's-round(raw_bytes/comp*100)/100,
// then JSON-serialized with toString which strips trailing zeros).
// Combine with receipt-dedupe (Method 1) for byte-exact lossless test.

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
console.log(`Original corpus: ${corpusBytes.length} B`);

const SEED = 'orange5-receipt-stream-v1';
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
console.log(`Det-ID corpus:   ${detBytes.length} B, sha ${detSha.slice(0,16)}...`);

// ── Banker's rounding (round-half-to-even) ───────────────────────────────
function bankerRound(x) {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (Math.abs(frac - 0.5) < 1e-9) {
    // Exactly halfway: round to even
    return floor + (floor % 2);
  }
  return Math.round(x);
}
function computeRatio(raw, comp) {
  // ratio = bankerRound(raw/comp * 100) / 100
  const x = (raw / comp) * 100;
  return bankerRound(x) / 100;
}

// Verify formula on all 1565 mesh.compress receipts
let formulaOK = 0, formulaFail = 0;
for (const r of detReceipts) {
  if (r.action !== 'mesh.compress' || r.payload_json == null) continue;
  try {
    const p = JSON.parse(r.payload_json);
    if (p.raw_bytes && p.compressed_bytes && p.ratio != null) {
      const computed = computeRatio(p.raw_bytes, p.compressed_bytes);
      if (Math.abs(computed - p.ratio) < 1e-9) formulaOK++;
      else { formulaFail++; if (formulaFail <= 3) console.log(`  Formula fail: raw=${p.raw_bytes} comp=${p.compressed_bytes} computed=${computed} stored=${p.ratio}`); }
    }
  } catch {}
}
console.log(`Banker's-round formula: ${formulaOK} OK, ${formulaFail} FAIL`);

// ── Method 5: dedupe shapes with ratio dropped + det-ID + brotli ─────────
const foldedDet = detReceipts.map(r => {
  if (r.action !== 'mesh.compress' || r.payload_json == null) return r;
  try {
    const p = JSON.parse(r.payload_json);
    const cleaned = { ...p };
    delete cleaned.ratio;
    return { ...r, payload_json: JSON.stringify(cleaned) };
  } catch { return r; }
});

const shapeKey = r => JSON.stringify({ ...r, id: '' });
const shapeVocab = new Map();
const shapeList = [];
const indexSeq = [];
for (const r of foldedDet) {
  const k = shapeKey(r);
  if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
  indexSeq.push(shapeVocab.get(k));
}
console.log(`\nFolded unique shapes: ${shapeList.length}`);

const shapesBrotli = brotli11(Buffer.from(shapeList.join('\n') + '\n', 'utf8'));
const idxBrotli = brotli11(Buffer.from(indexSeq.flatMap(varintU)));
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N }), 'utf8'));

const total = shapesBrotli.length + idxBrotli.length + seedR.length;
const ratio = detBytes.length / total;
console.log(`\n=== METHOD 5: dedupe + ratio-fold + det-ID + brotli ===`);
console.log(`Shapes brotli:    ${shapesBrotli.length.toString().padStart(7)} B`);
console.log(`Index brotli:     ${idxBrotli.length.toString().padStart(7)} B`);
console.log(`Seed:             ${seedR.length.toString().padStart(7)} B`);
console.log(`Total:            ${total.toString().padStart(7)} B`);
console.log(`Ratio:            ${ratio.toFixed(2)}x`);
console.log(`vs Method 1 (Exp 36, 34.20x): ${ratio > 34.20 ? `BEATS by +${(ratio-34.20).toFixed(2)}x` : `below by ${(34.20-ratio).toFixed(2)}x`}`);

// ── ROUNDTRIP ──────────────────────────────────────────────────────────
const shapesDec = zlib.brotliDecompressSync(shapesBrotli).toString('utf8').split('\n').filter(Boolean);
const idxBuf = Buffer.from(indexSeq.flatMap(varintU));
let idxDec = []; { let ofs = 0; while (ofs < idxBuf.length) { const [v, n] = readVarintU(idxBuf, ofs); idxDec.push(v); ofs = n; } }
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

const reconst = idxDec.map((idx, i) => {
  const shape = JSON.parse(shapesDec[idx]);
  shape.id = detId(seedDec.seed, i);
  // Restore mesh.compress.ratio if needed
  if (shape.action === 'mesh.compress' && shape.payload_json) {
    try {
      const p = JSON.parse(shape.payload_json);
      if (p.raw_bytes && p.compressed_bytes) {
        const computed = computeRatio(p.raw_bytes, p.compressed_bytes);
        // Re-insert ratio in original key order — original is "raw_bytes", "compressed_bytes", "ratio"
        const reordered = { raw_bytes: p.raw_bytes, compressed_bytes: p.compressed_bytes, ratio: computed };
        for (const k of Object.keys(p)) if (!(k in reordered)) reordered[k] = p[k];
        shape.payload_json = JSON.stringify(reordered);
      }
    } catch {}
  }
  return shape;
});

const recJsonl = reconst.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT vs det' : '✗ MISMATCH'}`);
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`  First diff at byte ${i}:`);
      console.log(`    det: ...${det.slice(Math.max(0, i-60), i+60)}...`);
      console.log(`    rec: ...${recJsonl.slice(Math.max(0, i-60), i+60)}...`);
      break;
    }
  }
}

const out = {
  experiment: '38-method5-schema-fold',
  generated_at: new Date().toISOString(),
  formula_check: { ok: formulaOK, fail: formulaFail },
  unique_shapes_folded: shapeList.length,
  shapes_brotli: shapesBrotli.length,
  idx_brotli: idxBrotli.length,
  seed: seedR.length,
  total,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: lossless,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(out, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
