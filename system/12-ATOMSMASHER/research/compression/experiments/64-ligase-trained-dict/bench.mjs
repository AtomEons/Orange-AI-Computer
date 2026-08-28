// Experiment 64 — Ligase trained-dictionary
// Train a "dictionary" from first 80% of corpus shapes (sorted, deduped).
// Compress remaining 20% with that dict via prefix-concat trick (prepend dict bytes,
// compress concat, measure only marginal).

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

// 80/20 split by index (deterministic).
const split = Math.floor(N * 0.8);
const trainLines = lines.slice(0, split);
const testLines = lines.slice(split);

// Build "dict" = sorted+deduped shapes from train (replace volatile bits to maximize template overlap)
// For honest "dictionary" semantics, use raw train lines deduped & sorted.
const trainDedup = [...new Set(trainLines)].sort();
const dictBuf = Buffer.from(trainDedup.join('\n') + '\n', 'utf8');

const t0 = performance.now();

// Strategy: brotli-encode (dict || train_actual || test_actual), but we'll measure two ways:
//   A) Marginal cost: compress(dict||corpus) - compress(dict) = bytes added by corpus given dict prefix
//   B) Naive sum: brotli(train) + brotli(test_with_dict_prefix_trick) — closer to honest stream
// Pick the more honest version: ship dict + corpus together as one brotli stream,
// then on decode trim the dict prefix off. Total ship cost = brotli(dict||corpus).

const dictPlusCorpus = Buffer.concat([dictBuf, detBytes]);
const compressedFull = brotli11(dictPlusCorpus);

// For decompress we need to know dict length to skip — store as 4-byte big-endian header.
const dictLenHeader = Buffer.alloc(4);
dictLenHeader.writeUInt32BE(dictBuf.length, 0);
const total = compressedFull.length + dictLenHeader.length;
const encode_ms = performance.now() - t0;

const ratio = detBytes.length / total;

const t1 = performance.now();
const restored = zlib.brotliDecompressSync(compressedFull);
const skipLen = dictLenHeader.readUInt32BE(0);
const corpusOut = restored.slice(skipLen);
const recSha = crypto.createHash('sha256').update(corpusOut).digest('hex');
const decode_ms = performance.now() - t1;
const lossless = recSha === detSha;

console.log(`dict bytes: ${dictBuf.length}`);
console.log(`dict+corpus brotli: ${compressedFull.length}`);
console.log(`TOTAL ship: ${total}`);
console.log(`ratio: ${ratio.toFixed(3)}x`);
console.log(`vs M19 (47.07): ${(ratio - 47.07).toFixed(3)}`);
console.log(`roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
console.log(`encode_ms: ${encode_ms.toFixed(1)}  decode_ms: ${decode_ms.toFixed(1)}`);

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify({
  experiment: '64-ligase-trained-dict',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless,
  notes: `dict from 80% sorted-dedup shapes (${dictBuf.length}B), shipped via brotli prefix-concat`
}, null, 2));
