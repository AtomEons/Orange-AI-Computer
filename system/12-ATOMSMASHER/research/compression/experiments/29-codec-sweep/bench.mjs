// Experiment 29 — Codec Sweep: find the absolute monolithic-codec ceiling
//
// Compare every common codec at max settings on the canonical corpus, with
// and without a pre-trained dictionary. The question: can any codec beat
// plait+brotli (18.05×) or two-stream lossless full (17.99×)?

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
console.log(`Corpus: ${corpusBytes.length} B, sha256 ${corpusSha.slice(0,16)}...`);

function time(fn) {
  const t0 = performance.now();
  const r = fn();
  return { ms: performance.now() - t0, r };
}

const results = [];

// ── Native Bun codecs ──────────────────────────────────────────────────────
function tryCodec(name, encodeFn, decodeFn) {
  try {
    const { ms: encMs, r: encoded } = time(() => encodeFn(corpusBytes));
    const { ms: decMs, r: decoded } = time(() => decodeFn(encoded));
    const matches = decoded.length === corpusBytes.length &&
      crypto.createHash('sha256').update(decoded).digest('hex') === corpusSha;
    const ratio = corpusBytes.length / encoded.length;
    results.push({ name, encoded: encoded.length, ratio, lossless: matches, enc_ms: encMs, dec_ms: decMs });
    console.log(`${name.padEnd(40)} ${encoded.length.toString().padStart(8)} B  ${ratio.toFixed(2).padStart(6)}x  ${matches ? '✓' : '✗'}  enc ${encMs.toFixed(0)}ms / dec ${decMs.toFixed(0)}ms`);
  } catch (e) {
    console.log(`${name.padEnd(40)} ERROR: ${e.message}`);
    results.push({ name, error: e.message });
  }
}

console.log(`\n${'codec'.padEnd(40)} ${'size'.padStart(8)}    ${'ratio'.padStart(6)}     lossless    timing`);
console.log('─'.repeat(95));

// gzip
tryCodec('gzip L1', b => zlib.gzipSync(b, { level: 1 }), b => zlib.gunzipSync(b));
tryCodec('gzip L6 (default)', b => zlib.gzipSync(b, { level: 6 }), b => zlib.gunzipSync(b));
tryCodec('gzip L9', b => zlib.gzipSync(b, { level: 9 }), b => zlib.gunzipSync(b));

// deflate
tryCodec('deflateRaw L9', b => zlib.deflateRawSync(b, { level: 9 }), b => zlib.inflateRawSync(b));

// brotli text quality 4/6/9/11
for (const q of [4, 6, 9, 11]) {
  tryCodec(`brotli q${q} (text mode)`,
    b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } }),
    b => zlib.brotliDecompressSync(b));
}
// brotli generic mode q11
tryCodec('brotli q11 (generic)',
  b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_GENERIC } }),
  b => zlib.brotliDecompressSync(b));
// brotli with explicit window
tryCodec('brotli q11 window=24',
  b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 } }),
  b => zlib.brotliDecompressSync(b));

// Bun.gunzipSync exists; try Bun-native if available
// Actually Bun supports zstd via bun:zstd? Not sure. Try if available.

// External codecs via CLI (zstd, xz, lzma, etc.) — try if installed
function tryCli(name, encCmd, decCmd, encFile = '/tmp/corpus.bin', encOut = '/tmp/corpus.out', decOut = '/tmp/corpus.dec') {
  try {
    fs.writeFileSync(encFile, corpusBytes);
    // Sanitize: run on Windows so /tmp may not exist
    if (process.platform === 'win32') {
      encFile = path.join(process.env.TEMP || 'C:\\Temp', 'corpus.bin');
      encOut = path.join(process.env.TEMP || 'C:\\Temp', 'corpus.out');
      decOut = path.join(process.env.TEMP || 'C:\\Temp', 'corpus.dec');
      fs.writeFileSync(encFile, corpusBytes);
    }
    const realEncCmd = encCmd.replace('IN', encFile).replace('OUT', encOut);
    const realDecCmd = decCmd.replace('IN', encOut).replace('OUT', decOut);
    const t0 = performance.now();
    execSync(realEncCmd, { stdio: 'pipe' });
    const encMs = performance.now() - t0;
    const encodedSize = fs.statSync(encOut).size;
    const t1 = performance.now();
    execSync(realDecCmd, { stdio: 'pipe' });
    const decMs = performance.now() - t1;
    const decoded = fs.readFileSync(decOut);
    const matches = decoded.length === corpusBytes.length &&
      crypto.createHash('sha256').update(decoded).digest('hex') === corpusSha;
    const ratio = corpusBytes.length / encodedSize;
    results.push({ name, encoded: encodedSize, ratio, lossless: matches, enc_ms: encMs, dec_ms: decMs });
    console.log(`${name.padEnd(40)} ${encodedSize.toString().padStart(8)} B  ${ratio.toFixed(2).padStart(6)}x  ${matches ? '✓' : '✗'}  enc ${encMs.toFixed(0)}ms / dec ${decMs.toFixed(0)}ms`);
    fs.unlinkSync(encOut); fs.unlinkSync(decOut);
  } catch (e) {
    console.log(`${name.padEnd(40)} CLI not available (${(e.message || '').split('\n')[0].slice(0, 60)})`);
  }
}

// Test zstd if installed
tryCli('zstd -22 --ultra', 'zstd -22 --ultra -q -o OUT IN', 'zstd -d -q -o OUT IN');
tryCli('zstd -19 (max basic)', 'zstd -19 -q -o OUT IN', 'zstd -d -q -o OUT IN');
tryCli('xz -9 -e', 'xz -9 -e -k -f IN -c > OUT', 'xz -d -c IN > OUT');
tryCli('7z LZMA2 -mx9', '7z a -mx9 -y OUT.7z IN >NUL && type OUT.7z > OUT', 'echo not-implemented');

// ── Brotli with pre-trained dictionary (the corpus itself as the dict) ─────
// Brotli supports SetParameter(BROTLI_PARAM_LARGE_WINDOW) but not raw dict input via Node API.
// We can use brotli's "shared dictionary" approach: compress with the dict prefix prepended,
// then strip the dict on decode. zlib doesn't expose this directly in Node, but we can simulate:
// effectively, brotli's LGWIN parameter at max already searches the largest window.

// Try a HUFFMAN-only mode — explicit text + minimum quality (still LZ77 + huffman)
tryCodec('brotli q11 text large win',
  b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_LGWIN]: 24, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT } }),
  b => zlib.brotliDecompressSync(b));

// ── Print sorted results ───────────────────────────────────────────────────
console.log('\n=== Sorted by ratio (lossless only) ===');
const lossless = results.filter(r => r.lossless).sort((a, b) => b.ratio - a.ratio);
for (const r of lossless) {
  console.log(`${r.ratio.toFixed(2).padStart(6)}x  ${r.encoded.toString().padStart(8)} B  ${r.name}`);
}

const best = lossless[0];
console.log(`\nBest monolithic codec: ${best?.name} at ${best?.ratio.toFixed(2)}x`);
console.log(`vs plait+brotli (18.05x): ${best?.ratio > 18.05 ? `BEATS by +${(best.ratio - 18.05).toFixed(2)}x` : `not beaten`}`);
console.log(`vs two-stream (17.99x): ${best?.ratio > 17.99 ? `BEATS by +${(best.ratio - 17.99).toFixed(2)}x` : `not beaten`}`);

const receipt = {
  experiment: '29-codec-sweep',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  results,
  best_lossless: best ? { name: best.name, ratio: best.ratio, size: best.encoded } : null,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
