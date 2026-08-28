// Experiment 11 v2 — 3D Parametric Fourier Descriptor (lossless integer FFT)
//
// Operator note 2026-06-26: the v1 permutation-trick fake was wrong. Real test:
// proper integer FFT of the action-id sequence, store ALL complex coefficients
// at exact precision, verify lossless via inverse FFT. Brotli on the result.
//
// The 3D Parametric Fourier Descriptor decomposes a curve into harmonic
// coefficients (a_n, b_n). For lossless compression we cannot truncate; the
// win must come from coefficient sparsity → brotli catches zero-runs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT-v2.json');
const RESULT_FILE = path.join(ROOT, 'RESULT-v2.md');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const actions = receipts.map(r => r.action);
console.log(`Loaded ${actions.length} actions`);

const vocab = new Map();
for (const a of actions) if (!vocab.has(a)) vocab.set(a, vocab.size);
const ids = actions.map(a => vocab.get(a));
const N = ids.length;
console.log(`Vocab=${vocab.size}, N=${N}`);

// ─── Real lossless approach: scaled integer FFT ─────────────────────────────
// Compute FFT in double precision; store as scaled int32 (real_part, imag_part)
// pairs. Use a scale factor large enough to preserve all info; inverse FFT
// must reproduce the original integers exactly.
//
// We pad to power of 2 for radix-2 FFT, then chunk.
function nextPow2(n) { let p = 1; while (p < n) p *= 2; return p; }

function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  // Bit-reverse permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  // Cooley-Tukey iterative
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wlenRe = Math.cos(ang), wlenIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let wRe = 1, wIm = 0;
      for (let j = 0; j < len / 2; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + len / 2] * wRe - im[i + j + len / 2] * wIm;
        const vIm = re[i + j + len / 2] * wIm + im[i + j + len / 2] * wRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[i + j + len / 2] = uRe - vRe; im[i + j + len / 2] = uIm - vIm;
        const nwRe = wRe * wlenRe - wIm * wlenIm;
        wIm = wRe * wlenIm + wIm * wlenRe;
        wRe = nwRe;
      }
    }
  }
}

function ifft(re, im) {
  const n = re.length;
  // Conjugate, FFT, conjugate, divide by n
  for (let i = 0; i < n; i++) im[i] = -im[i];
  fft(re, im);
  for (let i = 0; i < n; i++) { re[i] /= n; im[i] = -im[i] / n; }
}

// Block-FFT in blocks of size 1024 (chunked to keep memory + roundtrip stable)
const BLOCK = 1024;
const blockReal = [], blockImag = [];
let pos = 0;
while (pos < N) {
  const slice = ids.slice(pos, pos + BLOCK);
  // Pad to next power of 2 (zero-padding extends DFT)
  const padded = nextPow2(slice.length);
  const re = new Float64Array(padded);
  const im = new Float64Array(padded);
  for (let i = 0; i < slice.length; i++) re[i] = slice[i];
  fft(re, im);
  blockReal.push(re);
  blockImag.push(im);
  pos += BLOCK;
}
console.log(`Forward FFT over ${blockReal.length} blocks of ${BLOCK}`);

// ─── Scaled int32 quantization ──────────────────────────────────────────────
// Scale by 2^16 and round. For inputs in [0, vocab) with vocab=66, the FFT
// output magnitudes are bounded by N*vocab ≈ 70K, so scale=2^14 keeps in int32.
// Verify roundtrip by inverse-FFT'ing the quantized coefficients.
const SCALE = 1 << 14;
const quantized = [];
for (let b = 0; b < blockReal.length; b++) {
  const re = blockReal[b], im = blockImag[b];
  const qRe = new Int32Array(re.length), qIm = new Int32Array(im.length);
  for (let i = 0; i < re.length; i++) {
    qRe[i] = Math.round(re[i] * SCALE);
    qIm[i] = Math.round(im[i] * SCALE);
  }
  quantized.push({ qRe, qIm, originalLen: Math.min(N - b * BLOCK, BLOCK) });
}

// Encode quantized: varint-zigzag the int32 values + brotli
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function zigzag(n) { return n < 0 ? -2 * n - 1 : 2 * n; }
function unzigzag(n) { return n & 1 ? -(n + 1) / 2 : n / 2; }

const out = [];
// Header: vocab, BLOCK, num_blocks, scale
out.push(varint(vocab.size));
for (const k of vocab.keys()) {
  const bb = Buffer.from(k, 'utf8');
  out.push(varint(bb.length), bb);
}
out.push(varint(BLOCK));
out.push(varint(quantized.length));
out.push(varint(SCALE));
for (const q of quantized) {
  out.push(varint(q.originalLen));
  out.push(varint(q.qRe.length));
  for (const v of q.qRe) out.push(varint(zigzag(v)));
  for (const v of q.qIm) out.push(varint(zigzag(v)));
}

const stream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const rawActionStream = Buffer.from(actions.join('\n') + '\n');
const ratio = rawActionStream.length / brotli.length;
console.log(`\nFourier-Descriptor stream pre-brotli: ${stream.length} bytes`);
console.log(`Fourier-Descriptor + brotli q11:      ${brotli.length} bytes`);
console.log(`vs raw action stream:                 ${rawActionStream.length} bytes`);
console.log(`Compression ratio:                    ${ratio.toFixed(2)}x`);

// ─── Lossless roundtrip via inverse FFT ─────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const vSize = v;
const inv = [];
for (let i = 0; i < vSize; i++) {
  let len; [len, p] = readVarint(dec, p);
  inv.push(dec.slice(p, p + len).toString('utf8')); p += len;
}
[v, p] = readVarint(dec, p); const dBlock = v;
[v, p] = readVarint(dec, p); const dNumBlocks = v;
[v, p] = readVarint(dec, p); const dScale = v;
const decoded = [];
for (let b = 0; b < dNumBlocks; b++) {
  let origLen, qLen;
  [origLen, p] = readVarint(dec, p);
  [qLen, p] = readVarint(dec, p);
  const re = new Float64Array(qLen), im = new Float64Array(qLen);
  for (let i = 0; i < qLen; i++) { [v, p] = readVarint(dec, p); re[i] = unzigzag(v) / dScale; }
  for (let i = 0; i < qLen; i++) { [v, p] = readVarint(dec, p); im[i] = unzigzag(v) / dScale; }
  ifft(re, im);
  for (let i = 0; i < origLen; i++) decoded.push(inv[Math.round(re[i])]);
}

const recStream = decoded.join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recStream).digest('hex');
const origSha = crypto.createHash('sha256').update(rawActionStream).digest('hex');
const roundtripOk = recSha === origSha;
console.log(`Roundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH (lossy — REJECT)'}`);

const receipt = {
  experiment: '11-trefoil-dct',
  version: 'v2-real-integer-fft',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  vocab_size: vocab.size,
  sequence_length: N,
  block_size: BLOCK,
  num_blocks: quantized.length,
  scale_factor: SCALE,
  raw_action_stream_bytes: rawActionStream.length,
  fourier_stream_bytes: stream.length,
  fourier_brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  pass: roundtripOk && ratio > 1,
  beats_huffman_baseline: ratio > 32.57,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 11 v2 — 3D Parametric Fourier Descriptor (real integer FFT) — RESULT

**Status:** ${receipt.pass ? (receipt.beats_huffman_baseline ? '✅ PASS + beats Huffman' : '✅ LOSSLESS, but below Huffman baseline') : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Method (corrected from v1)

1. Map actions to integer ids
2. Block-FFT the id sequence in ${BLOCK}-element blocks (zero-padded to next power of 2)
3. Quantize complex coefficients to int32 at scale 2^14
4. Zigzag-varint encode all coefficients, brotli q11
5. Roundtrip: inverse FFT → round → lookup → sha256 verify byte-exact

## Measured

| Metric | Value |
|---|---|
| Raw action stream | ${rawActionStream.length.toLocaleString()} B |
| Fourier stream pre-brotli | ${stream.length.toLocaleString()} B |
| Fourier + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Roundtrip lossless | ${roundtripOk ? '✓ sha256 match' : '✗ MISMATCH'} |

## Analysis

${roundtripOk ?
  (receipt.beats_huffman_baseline ?
    `Beats Huffman (32.57×) — the action sequence has spectral structure exploitable via FFT coefficient sparsity.` :
    ratio > 1 ?
      `Lossless FFT works at ${ratio.toFixed(2)}× but below Huffman baseline (32.57×). The action sequence is too close to white noise for FFT to concentrate energy meaningfully — Huffman exploits frequency skew directly and wins. The Fourier Descriptor is the right tool for SMOOTH signals; receipt streams aren't smooth.` :
      `Lossless but ratio ≤ 1× — FFT coefficient stream is bigger than raw sequence on this corpus.`) :
  `LOSSY — quantization error prevents byte-exact roundtrip. Need higher SCALE or different quantization approach.`}

## Honest reflection

The 3D Parametric Trefoil compresses ARTIFICIALLY GENERATED SMOOTH CURVES (sin+cos with low-order frequencies). For receipts — which are sparse event streams, not smooth signals — FFT cannot beat domain-aware encoding (Huffman, dict-based).

The Fourier Descriptor *would* compress beautifully if our data were:
- Smooth periodic signals
- Closed curves (loops in some embedding)
- Audio/image waveforms

For temporal causal event streams, frequency-domain compression has no inherent advantage.
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
