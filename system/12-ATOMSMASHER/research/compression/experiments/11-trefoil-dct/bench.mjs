// Experiment 11 — Trefoil DCT (sinusoidal-basis spectral decomposition)
//
// Inspired by the 3D parametric trefoil x=sin(t)+2sin(2t), y=cos(t)-2cos(2t),
// z=-sin(3t). Hypothesis: if the action-id sequence has spectral structure,
// a DCT-like decomposition will concentrate energy in few low-frequency
// coefficients, compressing better than raw bytes. Lossless requires storing
// all coefficients with full precision.
//
// Method: integer-friendly Discrete Cosine Transform (DCT-II) on the action-id
// sequence (treated as integers). Quantize residuals exactly (no quantization
// loss). Brotli on the coefficient stream.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const META = JSON.parse(fs.readFileSync(path.resolve(ROOT, '../../data/canonical-corpus.meta.json'), 'utf8'));
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');
const HYP = path.join(ROOT, 'HYPOTHESIS.md');

if (!fs.existsSync(HYP)) {
  fs.writeFileSync(HYP, `# Experiment 11 — Trefoil DCT Spectral Decomposition

## Hypothesis
The 3D parametric trefoil (x=sin(t)+2sin(2t), y=cos(t)-2cos(2t), z=-sin(3t)) shows that a complex weaving curve is determined by ~6 real numbers via sinusoidal basis. If the receipt action-id sequence has spectral structure (a few dominant Fourier modes), DCT decomposition will concentrate energy in low-frequency coefficients and the resulting coefficient stream will compress tighter than the raw sequence.

## Predicted ratio
1.5–5× over Experiment 06's Huffman baseline (32.57× on action col). Bound: real spectral structure of the corpus dictates the win.

## Pass criterion
PASS if DCT-encoded action-id stream + brotli + lossless roundtrip beats Experiment 06's 32.57× on action col.

## Honest caveat
For LOSSLESS reconstruction we cannot drop any coefficient. The win must come from coefficient redundancy (most coefficients near zero → compress to short codes), not from truncation. If the spectrum is flat (white noise), DCT does nothing.
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const actions = receipts.map(r => r.action);
console.log(`Loaded ${actions.length} actions`);

// ─── Map action → integer id ─────────────────────────────────────────────────
const vocab = new Map();
for (const a of actions) if (!vocab.has(a)) vocab.set(a, vocab.size);
const ids = actions.map(a => vocab.get(a));
const N = ids.length;
console.log(`Vocab size: ${vocab.size}, sequence length: ${N}`);

// ─── DCT-II (lossless integer-friendly version using exact rational math) ────
// For LOSSLESS we cannot use floating-point inverse DCT directly. So instead
// we use a permutation-based "discrete cosine ordering": pre-compute the DCT
// basis ranking, store coefficients in DCT-order but as EXACT integer values.
// This is equivalent to storing the sequence in a basis-ordered permutation
// where low-index entries are dominant-frequency components. Brotli then
// compresses the reordering.
//
// Concretely: compute the floating DCT, sort positions by |coefficient|
// magnitude descending. Reorder the SEQUENCE indices to follow that order
// (this is a lossless permutation — invertible).
// Brotli on the permuted integer stream.

// Step 1: DCT-II on the id sequence as floats
function dct2(arr) {
  const n = arr.length;
  const X = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    let s = 0;
    for (let j = 0; j < n; j++) s += arr[j] * Math.cos(Math.PI * k * (j + 0.5) / n);
    X[k] = s;
  }
  return X;
}

// For large N this is O(N²) — chunk into smaller blocks for efficiency
const BLOCK = 256;
const blocks = [];
for (let i = 0; i < N; i += BLOCK) blocks.push(ids.slice(i, Math.min(N, i + BLOCK)));
console.log(`DCT block size: ${BLOCK}, blocks: ${blocks.length}`);

// Step 2: for each block, store the DCT-coefficient magnitude ranking → permutation
// Then encode the block as: permutation + values-in-permuted-order
function permutationFromDCT(block) {
  const X = dct2(block);
  const idx = [...X.keys()].sort((a, b) => Math.abs(X[b]) - Math.abs(X[a]));
  return idx; // a permutation of [0..block.length-1]
}

function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

// Encode: vocab + per-block (block_len, permutation, values-in-perm-order)
const out = [];
out.push(varint(vocab.size));
for (const k of vocab.keys()) out.push(...writeStr(k));
out.push(varint(blocks.length));
out.push(varint(BLOCK));
for (const block of blocks) {
  const perm = permutationFromDCT(block);
  out.push(varint(block.length));
  for (const p of perm) out.push(varint(p));
  for (const p of perm) out.push(varint(block[p]));
}

const stream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const rawActionStream = Buffer.from(actions.join('\n') + '\n');
const ratio = rawActionStream.length / brotli.length;
console.log(`\nDCT-ordered + brotli: ${brotli.length} bytes (${ratio.toFixed(2)}x vs raw)`);

// ─── Lossless roundtrip ──────────────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const vSize = v;
const inv = [];
for (let i = 0; i < vSize; i++) {
  let len; [len, p] = readVarint(dec, p);
  inv.push(dec.slice(p, p + len).toString('utf8'));
  p += len;
}
[v, p] = readVarint(dec, p); const dBlocks = v;
[v, p] = readVarint(dec, p); /* BLOCK */
const reconstructed = [];
for (let b = 0; b < dBlocks; b++) {
  [v, p] = readVarint(dec, p); const blen = v;
  const perm = [];
  for (let i = 0; i < blen; i++) { [v, p] = readVarint(dec, p); perm.push(v); }
  const values = [];
  for (let i = 0; i < blen; i++) { [v, p] = readVarint(dec, p); values.push(v); }
  const restored = new Array(blen);
  for (let i = 0; i < blen; i++) restored[perm[i]] = values[i];
  for (const id of restored) reconstructed.push(inv[id]);
}

const recStream = reconstructed.join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recStream).digest('hex');
const origSha = crypto.createHash('sha256').update(rawActionStream).digest('hex');
const roundtripOk = recSha === origSha;
console.log(`Roundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);

const receipt = {
  experiment: '11-trefoil-dct',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  vocab_size: vocab.size,
  sequence_length: N,
  dct_block_size: BLOCK,
  num_blocks: blocks.length,
  raw_action_stream_bytes: rawActionStream.length,
  dct_stream_bytes: stream.length,
  dct_brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  pass: roundtripOk && ratio > 32.57,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 11 — Trefoil DCT — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Method
Trefoil-inspired sinusoidal basis decomposition. Compute DCT-II per ${BLOCK}-element block of the action-id sequence; rank positions by |coefficient| magnitude; encode each block as (permutation, values-in-permuted-order). Brotli compresses the permutation + value stream.

This is lossless: the permutation is invertible.

## Measured

| Metric | Value |
|---|---|
| Raw action stream | ${rawActionStream.length.toLocaleString()} B |
| DCT stream pre-brotli | ${stream.length.toLocaleString()} B |
| DCT + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Roundtrip lossless | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `DCT-ordered encoding beats Experiment 06's Huffman baseline (32.57×). The action sequence has spectral structure: DCT concentrates energy in low-frequency coefficients, and brotli exploits the resulting repetition.` :
  `DCT-ordered encoding at ${ratio.toFixed(2)}× does NOT beat Experiment 06's Huffman (32.57×). The permutation overhead per block (storing ${BLOCK} indices) exceeds savings; OR the action sequence is too close to white noise for DCT to concentrate energy meaningfully.`}

## Honest caveat

For LOSSLESS reconstruction we cannot truncate coefficients. The compression must come from value redundancy in the permuted order — and the permutation index itself costs bytes. This is fundamentally different from JPEG/MP3-style lossy DCT compression.

## Reproduction
\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/11-trefoil-dct/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
