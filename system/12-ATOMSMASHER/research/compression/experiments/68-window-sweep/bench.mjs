// Experiment 68 — Window-size sweep
// Chunk corpus into N-receipt windows (N in {50, 200, 500, 1000, 2000, all}),
// compress each window independently with brotli q11, concat.
// Report ratio per window size + best.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { performance } from 'node:perf_hooks';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const detJsonl = lines.join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
const N = lines.length;

function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

const sizes = [50, 200, 500, 1000, 2000, N]; // "all" = N
const results = [];

for (const W of sizes) {
  const t0 = performance.now();
  const blobs = [];
  for (let i = 0; i < N; i += W) {
    const chunk = lines.slice(i, Math.min(N, i + W)).join('\n') + '\n';
    blobs.push(brotli11(Buffer.from(chunk, 'utf8')));
  }
  // Length-prefix header + concat.
  const headerParts = [];
  headerParts.push(...varintU(blobs.length));
  for (const b of blobs) headerParts.push(...varintU(b.length));
  const headerBuf = Buffer.from(headerParts);
  const concat = Buffer.concat(blobs);
  const total = headerBuf.length + concat.length;
  const encode_ms = performance.now() - t0;
  const ratio = detBytes.length / total;

  // Roundtrip
  const t1 = performance.now();
  let ofs = 0;
  const [numBlobs, no] = readVarintU(headerBuf, 0); ofs = no;
  const lens = [];
  for (let k = 0; k < numBlobs; k++) { const [v, n2] = readVarintU(headerBuf, ofs); lens.push(v); ofs = n2; }
  let cur = 0;
  const out = [];
  for (const len of lens) {
    const blob = concat.slice(cur, cur + len);
    cur += len;
    out.push(zlib.brotliDecompressSync(blob));
  }
  const restored = Buffer.concat(out);
  const recSha = crypto.createHash('sha256').update(restored).digest('hex');
  const decode_ms = performance.now() - t1;
  const lossless = recSha === detSha;

  results.push({ W, total, ratio: Number(ratio.toFixed(3)), encode_ms: Number(encode_ms.toFixed(1)), decode_ms: Number(decode_ms.toFixed(1)), lossless });
  console.log(`W=${W === N ? 'all' : W}: total=${total} ratio=${ratio.toFixed(3)}x enc=${encode_ms.toFixed(0)}ms dec=${decode_ms.toFixed(0)}ms lossless=${lossless}`);
}

const best = results.reduce((a, b) => b.ratio > a.ratio ? b : a);
console.log(`\nBEST: W=${best.W === N ? 'all' : best.W} ratio=${best.ratio}x`);

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify({
  experiment: '68-window-sweep',
  ratio: best.ratio,
  encode_ms: best.encode_ms,
  decode_ms: best.decode_ms,
  lossless: best.lossless,
  best_window: best.W === N ? 'all' : best.W,
  all_results: results,
  notes: `swept window sizes; best=${best.W === N ? 'all' : best.W}`
}, null, 2));
