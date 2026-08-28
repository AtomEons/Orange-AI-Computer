// Experiment 03 — Knot Signature Segment Collapse
//
// Topological equivalence via knot-polynomial-style fingerprints on sliding windows.
// Identifies structurally equivalent receipt windows and collapses them.
// Brotli q11 on the dedupe-encoded stream.
// Lossless verify via sha256 roundtrip on the FULL canonical corpus.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const META = JSON.parse(fs.readFileSync(path.resolve(ROOT, '../../data/canonical-corpus.meta.json'), 'utf8'));
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts, ${corpusBytes.length} bytes`);

// ── Per-receipt structural signature (small, ordered tuple of identifiers) ─
function recSig(r) {
  // Hash on action + status + payload_pattern hash (structural, not bytewise)
  const pHash = crypto.createHash('sha256').update(r.payload_json || '').digest('hex').slice(0, 12);
  return `${r.action}|${r.status}|${pHash}`;
}
const sigs = receipts.map(recSig);
console.log(`Distinct per-receipt sigs: ${new Set(sigs).size}`);

// ── Sliding-window knot-signature analysis (try W = 2,3,5,8,13) ────────────
function windowFingerprint(arr, start, w) {
  const slice = arr.slice(start, start + w).join('||');
  return crypto.createHash('sha256').update(slice).digest('hex').slice(0, 16);
}
const candidates = [2, 3, 5, 8, 13];
const analysis = candidates.map(w => {
  const fps = [];
  for (let i = 0; i + w <= sigs.length; i++) fps.push(windowFingerprint(sigs, i, w));
  const distinct = new Set(fps).size;
  return { w, total: fps.length, distinct, dedup_factor: fps.length / Math.max(1, distinct) };
});
console.log('\nWindow analysis (knot-signature dedup):');
console.log('  W  |   total |  distinct | dedup_factor');
for (const a of analysis) {
  console.log(`  ${String(a.w).padStart(2)} | ${String(a.total).padStart(7)} | ${String(a.distinct).padStart(9)} | ${a.dedup_factor.toFixed(2)}x`);
}

// ── Honest lossless encoding strategy ──────────────────────────────────────
// We cannot ACTUALLY collapse windows for lossless storage unless we keep the
// distinct payload/summary/id strings underneath. So the encoding becomes:
//   per-receipt structural signature ID  +  per-receipt "unique residual" (the bits
//   the signature did NOT capture: full payload_json, full summary, full id, ts).
// Then we measure: (signature-ID stream) + (unique-residual dictionary). Brotli on both.
//
// The win: if the per-receipt signature ID has small entropy (many receipts share a sig),
// the sig-ID stream compresses to near nothing.

const sigVocab = new Map();
function lookup(map, key) { let v = map.get(key); if (v === undefined) { v = map.size; map.set(key, v); } return v; }
for (const s of sigs) lookup(sigVocab, s);
const sigIds = sigs.map(s => sigVocab.get(s));
console.log(`\nDistinct per-receipt sigs: ${sigVocab.size}  (entropy floor: log2 = ${Math.log2(sigVocab.size).toFixed(2)} bits/receipt)`);

// Residual data per receipt: the bits NOT captured in the signature (full id, summary, payload, ts)
const fields = ['id', 'summary', 'payload_json', 'created_at'];
const fieldVocabs = Object.fromEntries(fields.map(f => [f, new Map()]));
for (const r of receipts) for (const f of fields) lookup(fieldVocabs[f], r[f] == null ? '\0NULL\0' : String(r[f]));

function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

const out = [];
// Header: sig vocab + field vocabs
out.push(varint(receipts.length));
out.push(varint(sigVocab.size));
for (const s of sigVocab.keys()) out.push(...writeStr(s));
out.push(varint(fields.length));
for (const f of fields) {
  out.push(...writeStr(f));
  out.push(varint(fieldVocabs[f].size));
  for (const v of fieldVocabs[f].keys()) out.push(...writeStr(v));
}
// Per-receipt: sig_id, then field vocab indices for residuals
for (const r of receipts) {
  out.push(varint(sigVocab.get(recSig(r))));
  for (const f of fields) {
    const val = r[f] == null ? '\0NULL\0' : String(r[f]);
    out.push(varint(fieldVocabs[f].get(val)));
  }
}

const knotStream = Buffer.concat(out);
const knotBrotli = zlib.brotliCompressSync(knotStream, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
});
console.log(`\nKnot-sig stream pre-brotli: ${knotStream.length} bytes`);
console.log(`Knot-sig + brotli q11:      ${knotBrotli.length} bytes`);
const ratio = corpusBytes.length / knotBrotli.length;
console.log(`Ratio vs raw corpus:        ${ratio.toFixed(2)}x`);

// ── Lossless roundtrip verification ────────────────────────────────────────
const dec = zlib.brotliDecompressSync(knotBrotli);
let p = 0;
let n;
[n, p] = readVarint(dec, p); const recCount = n;
[n, p] = readVarint(dec, p); const sigVSize = n;
const decSigInv = [];
for (let i = 0; i < sigVSize; i++) {
  let len; [len, p] = readVarint(dec, p);
  decSigInv.push(dec.slice(p, p + len).toString('utf8'));
  p += len;
}
[n, p] = readVarint(dec, p); const fCount = n;
const decFields = [];
const decFieldVocabs = {};
for (let i = 0; i < fCount; i++) {
  let f; let len;
  [len, p] = readVarint(dec, p);
  f = dec.slice(p, p + len).toString('utf8'); p += len;
  decFields.push(f);
  [n, p] = readVarint(dec, p); const vSize = n;
  const inv = [];
  for (let j = 0; j < vSize; j++) {
    [len, p] = readVarint(dec, p);
    inv.push(dec.slice(p, p + len).toString('utf8'));
    p += len;
  }
  decFieldVocabs[f] = inv;
}

const decoded = [];
for (let i = 0; i < recCount; i++) {
  let sigId; [sigId, p] = readVarint(dec, p);
  const sig = decSigInv[sigId];
  const [action, status, _payHash] = sig.split('|');
  const r = { action, status };
  for (const f of decFields) {
    let idx; [idx, p] = readVarint(dec, p);
    const v = decFieldVocabs[f][idx];
    r[f] = v === '\0NULL\0' ? null : v;
  }
  // Reorder to match original
  decoded.push({
    id: r.id,
    action: r.action,
    status: r.status,
    summary: r.summary,
    payload_json: r.payload_json,
    created_at: r.created_at,
  });
}

const decodedJsonl = decoded.map(r => JSON.stringify(r)).join('\n') + '\n';
const decodedSha = crypto.createHash('sha256').update(decodedJsonl).digest('hex');
const roundtripOk = decodedSha === corpusSha;
console.log(`\nRoundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH (lossy — REJECT)'}`);

const receipt = {
  experiment: '03-knot-signature',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  corpus_bytes_in: corpusBytes.length,
  knot_stream_bytes: knotStream.length,
  knot_brotli_bytes: knotBrotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  distinct_sigs: sigVocab.size,
  signature_entropy_bits: Number(Math.log2(sigVocab.size).toFixed(2)),
  window_analysis: analysis.map(a => ({ ...a, dedup_factor: Number(a.dedup_factor.toFixed(2)) })),
  pass: roundtripOk && ratio > 16.56,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 03 — Knot Signature Segment Collapse — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Measured

| Metric | Value |
|---|---|
| Raw corpus bytes | ${corpusBytes.length.toLocaleString()} |
| Knot-sig stream pre-brotli | ${knotStream.length.toLocaleString()} |
| Knot-sig + brotli q11 | ${knotBrotli.length.toLocaleString()} |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Roundtrip lossless | ${roundtripOk ? '✓' : '✗'} |
| Distinct per-receipt sigs | ${sigVocab.size} (entropy ${receipt.signature_entropy_bits} bits/receipt) |

## Sliding-window dedup analysis

| W | total windows | distinct | dedup factor |
|---|---|---|---|
${analysis.map(a => `| ${a.w} | ${a.total.toLocaleString()} | ${a.distinct.toLocaleString()} | ${a.dedup_factor.toFixed(2)}× |`).join('\n')}

## Analysis

${receipt.pass ?
  `Knot-signature dedup beats Experiment 01's 16.56× spike encoding. The structural sig (action|status|payload_hash) compresses the receipt stream's *topological identity* separately from the residual byte data, then brotli catches the remaining redundancy in both streams.` :
  `Knot-signature dedup at ${ratio.toFixed(2)}× did NOT beat Experiment 01's 16.56× spike encoding. The structural signature space (${sigVocab.size} distinct sigs over ${receipts.length} receipts) didn't collapse enough to offset the per-receipt residual overhead. Honest finding: structural fingerprinting doesn't yield more compression than direct per-field vocab indexing when most receipts have unique payloads.`}

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/03-knot-signature/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
