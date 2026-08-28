// Experiment 65 — Lamport-counter receipts (LOSSY w.r.t. original; LOSSLESS w.r.t. logical content)
// Strip wall-clock fields (ts/created_at/expires_at/at) from corpus.
// Replace with monotonic Lamport counter (1, 2, 3...). Compress with brotli q11.

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
const N = lines.length;

function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }

// Strip wall-clock fields from every receipt and from payload_json.
const TIME_FIELDS = new Set(['ts', 'created_at', 'expires_at', 'at', 'timestamp']);
function stripTimes(obj, lamport) {
  if (Array.isArray(obj)) return obj.map(x => stripTimes(x, lamport));
  if (obj && typeof obj === 'object') {
    const out = {};
    for (const k of Object.keys(obj)) {
      if (TIME_FIELDS.has(k)) continue;
      out[k] = stripTimes(obj[k], lamport);
    }
    return out;
  }
  return obj;
}

let stripped_bytes_in_orig = 0;
const lamportLines = [];
for (let i = 0; i < N; i++) {
  const r = JSON.parse(lines[i]);
  const orig = lines[i].length;
  // strip top-level wall-clock fields
  const stripped = {};
  for (const k of Object.keys(r)) {
    if (TIME_FIELDS.has(k)) continue;
    if (k === 'payload_json' && typeof r[k] === 'string') {
      try {
        const p = JSON.parse(r[k]);
        const ps = stripTimes(p, i + 1);
        stripped[k] = JSON.stringify(ps);
      } catch { stripped[k] = r[k]; }
    } else {
      stripped[k] = r[k];
    }
  }
  // Add monotonic lamport counter
  stripped.t = i + 1;
  const newLine = JSON.stringify(stripped);
  stripped_bytes_in_orig += Math.max(0, orig - newLine.length);
  lamportLines.push(newLine);
}

const stripped_bytes_total = lamportLines.join('\n').length + 1;
const bytes_stripped_delta = detBytes.length - stripped_bytes_total;

const lamportBuf = Buffer.from(lamportLines.join('\n') + '\n', 'utf8');
const t0 = performance.now();
const compressed = brotli11(lamportBuf);
const encode_ms = performance.now() - t0;

const total = compressed.length;
const ratio = detBytes.length / total;

const t1 = performance.now();
const out = zlib.brotliDecompressSync(compressed);
const decode_ms = performance.now() - t1;

// Logical lossless check: decompressed output must equal the lamport-stripped corpus.
const logicalSha = crypto.createHash('sha256').update(out).digest('hex');
const expectedLogicalSha = crypto.createHash('sha256').update(lamportBuf).digest('hex');
const logical_lossless = logicalSha === expectedLogicalSha;

// vs original detSha — by design NOT byte-exact (lossy w.r.t. original).
console.log(`lamport bytes: ${lamportBuf.length}`);
console.log(`bytes stripped delta: ${bytes_stripped_delta}`);
console.log(`brotli q11: ${compressed.length}`);
console.log(`ratio (vs ORIGINAL corpus): ${ratio.toFixed(3)}x`);
console.log(`vs M19 (47.07): ${(ratio - 47.07).toFixed(3)}`);
console.log(`logical roundtrip (lamport-form): ${logical_lossless ? 'OK' : 'BROKEN'}`);
console.log(`LOSSY w.r.t. original wall-clock (by design)`);
console.log(`encode_ms: ${encode_ms.toFixed(1)}  decode_ms: ${decode_ms.toFixed(1)}`);

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify({
  experiment: '65-lamport-counter',
  ratio: Number(ratio.toFixed(3)),
  encode_ms: Number(encode_ms.toFixed(1)),
  decode_ms: Number(decode_ms.toFixed(1)),
  lossless: false, // lossy w.r.t. original corpus (timestamps stripped)
  bytes_stripped_delta,
  logical_lossless,
  notes: `LOSSY: wall-clock fields replaced with monotonic counter; logical roundtrip OK=${logical_lossless}`
}, null, 2));
