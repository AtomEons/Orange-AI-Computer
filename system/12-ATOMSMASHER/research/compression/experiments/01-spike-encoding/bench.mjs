// Experiment 01 — Spike Encoding (lossless v2 — exact string preservation)
//
// Encodes each receipt as a frame of varint indices into per-field vocabularies.
// Brotli q11 on the resulting binary stream.
// Verifies byte-exact lossless roundtrip via sha256 match.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const META_FILE = path.resolve(ROOT, '../../data/canonical-corpus.meta.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const meta = JSON.parse(fs.readFileSync(META_FILE, 'utf8'));
const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
if (corpusSha !== meta.corpus_sha256) {
  console.error('FATAL: corpus sha mismatch with meta');
  process.exit(1);
}
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts, ${corpusBytes.length} bytes`);

// ─── Pass 1: build per-field vocabularies (exact string preservation) ──────
const fields = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
const vocabs = Object.fromEntries(fields.map(f => [f, new Map()]));
function lookup(map, key) {
  let v = map.get(key);
  if (v === undefined) { v = map.size; map.set(key, v); }
  return v;
}
for (const r of receipts) {
  for (const f of fields) {
    const val = r[f] == null ? '\0NULL\0' : String(r[f]); // sentinel for null
    lookup(vocabs[f], val);
  }
}
console.log('  vocab sizes:', Object.fromEntries(fields.map(f => [f, vocabs[f].size])));

// ─── Pass 2: emit binary spike stream ───────────────────────────────────────
function varint(n) {
  const bytes = [];
  while (n >= 128) { bytes.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}
function writeStr(s) {
  const b = Buffer.from(s, 'utf8');
  return [varint(b.length), b];
}

const out = [];
// Header
out.push(varint(receipts.length));
out.push(varint(fields.length));
for (const f of fields) {
  out.push(...writeStr(f));
  const inv = [...vocabs[f].keys()];
  out.push(varint(inv.length));
  for (const v of inv) out.push(...writeStr(v));
}

// Per-receipt: one varint per field (vocab index)
for (const r of receipts) {
  for (const f of fields) {
    const val = r[f] == null ? '\0NULL\0' : String(r[f]);
    out.push(varint(vocabs[f].get(val)));
  }
}

const spikeStream = Buffer.concat(out);
const compressed = zlib.brotliCompressSync(spikeStream, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
});
console.log();
console.log(`Spike stream raw:     ${spikeStream.length} bytes`);
console.log(`Spike stream brotli:  ${compressed.length} bytes`);
console.log(`Raw corpus:           ${corpusBytes.length} bytes`);
const ratio = corpusBytes.length / compressed.length;
console.log(`Compression ratio:    ${ratio.toFixed(2)}x`);

// ─── Pass 3: decode + roundtrip verify ──────────────────────────────────────
function readVarint(buf, ofs) {
  let n = 0, mult = 1, b;
  do {
    b = buf[ofs++];
    n += (b & 0x7f) * mult;
    mult *= 128;
  } while (b & 0x80);
  return [n, ofs];
}
function readStr(buf, ofs) {
  let len; [len, ofs] = readVarint(buf, ofs);
  return [buf.slice(ofs, ofs + len).toString('utf8'), ofs + len];
}

const dec = zlib.brotliDecompressSync(compressed);
let p = 0;
let n;
[n, p] = readVarint(dec, p);
const recCount = n;
[n, p] = readVarint(dec, p);
const fieldCount = n;
const decFields = [];
const decVocabs = {};
for (let fi = 0; fi < fieldCount; fi++) {
  let f; [f, p] = readStr(dec, p);
  decFields.push(f);
  let vSize; [vSize, p] = readVarint(dec, p);
  const vArr = [];
  for (let i = 0; i < vSize; i++) {
    let s; [s, p] = readStr(dec, p);
    vArr.push(s);
  }
  decVocabs[f] = vArr;
}

const decoded = [];
for (let i = 0; i < recCount; i++) {
  const r = {};
  for (const f of decFields) {
    let idx; [idx, p] = readVarint(dec, p);
    const v = decVocabs[f][idx];
    r[f] = v === '\0NULL\0' ? null : v;
  }
  decoded.push(r);
}

const decodedJsonl = decoded.map(r => JSON.stringify(r)).join('\n') + '\n';
const decodedSha = crypto.createHash('sha256').update(decodedJsonl).digest('hex');
const decodedBytes = Buffer.byteLength(decodedJsonl);
const roundtripOk = decodedSha === corpusSha;
console.log();
console.log(`Roundtrip:            ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);
console.log(`Original sha256:      ${corpusSha}`);
console.log(`Decoded  sha256:      ${decodedSha}`);
console.log(`Original bytes:       ${corpusBytes.length}`);
console.log(`Decoded  bytes:       ${decodedBytes}`);

// If still mismatched, show first byte diff for debugging
if (!roundtripOk) {
  const minLen = Math.min(corpusBytes.length, decodedBytes);
  for (let i = 0; i < minLen; i++) {
    if (corpusBytes[i] !== Buffer.from(decodedJsonl)[i]) {
      const ctx = 50;
      console.log(`\nFirst diff at byte ${i}:`);
      console.log(`  orig: ...${corpusBytes.slice(Math.max(0, i-ctx), i+ctx).toString('utf8')}...`);
      console.log(`  out:  ...${Buffer.from(decodedJsonl).slice(Math.max(0, i-ctx), i+ctx).toString('utf8')}...`);
      break;
    }
  }
}

// ─── Write RECEIPT + RESULT ─────────────────────────────────────────────────
const receipt = {
  experiment: '01-spike-encoding',
  version: 'v2-lossless-vocab',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  corpus_bytes_in: corpusBytes.length,
  spike_stream_bytes: spikeStream.length,
  brotli_q11_bytes: compressed.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  decoded_sha256_out: decodedSha,
  vocab_sizes: Object.fromEntries(fields.map(f => [f, vocabs[f].size])),
  pass: roundtripOk && ratio > 1,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 01 — Spike Encoding (v2 lossless) — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Measured numbers

| Metric | Value |
|---|---|
| Raw corpus bytes | ${corpusBytes.length.toLocaleString()} |
| Spike stream bytes (pre-brotli) | ${spikeStream.length.toLocaleString()} |
| Spike + Brotli q11 bytes | ${compressed.length.toLocaleString()} |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Roundtrip lossless | ${roundtripOk ? '✓ YES (sha256 match)' : '✗ NO (REJECT)'} |
${fields.map(f => `| Vocab — ${f} | ${vocabs[f].size.toLocaleString()} distinct |`).join('\n')}

## Method (v2)

1. Build per-field vocabularies (id, action, status, summary, payload_json, created_at) preserving exact string bytes including null sentinels.
2. Emit binary stream: \`<header: receipts_count, field_count, [(field_name, vocab_size, [strings])]>\` then \`<per-receipt: varint(vocab_index_per_field)>\`.
3. Brotli q11 on the binary stream.
4. Decode pass: reconstruct receipts by indexing back into the vocab, sha256-compare to original corpus.

## Versus baseline

| Method | Ratio |
|---|---|
| 4-weave compound (this corpus) | ${meta.baseline_4weave_ratio}× |
| Regeneration mode (lossless) | ${meta.baseline_regen_ratio}× |
| **Spike + Brotli (v2 lossless)** | **${ratio.toFixed(2)}×** |

${ratio > meta.baseline_4weave_ratio ? '🎯 **Spike encoding BEATS the 4-weave baseline.**' : ratio > meta.baseline_regen_ratio ? '✓ Beats regeneration but below 4-weave compound.' : 'Below both prior baselines — but lossless and single-pass.'}

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/01-spike-encoding/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
