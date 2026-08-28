// Experiment E1 — VS Emoji Wire+Token Cost
// Question: does encoding bytes as variation selectors after a base emoji
// ever WIN over raw ASCII at the UTF-8, brotli, or token layer?
//
// Encoding (stable):
//   base = 🟢 (U+1F7E2)
//   byte 0..15   -> U+FE00 + byte
//   byte 16..255 -> U+E0100 + (byte - 16)
//
// Three measurement layers per payload size (200B, 2000B):
//   1. UTF-8 byte count of the wire string
//   2. brotli quality=11 compressed bytes of the wire bytes
//   3. cl100k_base token count (gpt-tokenizer)
// Plus: lossless round-trip sha256 check.

import zlib from 'node:zlib';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { encode as encodeCl100k } from 'gpt-tokenizer/encoding/cl100k_base';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

const BASE_EMOJI = String.fromCodePoint(0x1F7E2); // 🟢

// Encode one byte to its variation-selector codepoint.
function byteToVS(b) {
  if (b < 0 || b > 255) throw new Error(`byte out of range: ${b}`);
  if (b < 16) return String.fromCodePoint(0xFE00 + b);      // VS1..VS16
  return String.fromCodePoint(0xE0100 + (b - 16));          // VS17..VS256
}

// Decode a string of (base emoji + VS run) back to bytes.
function vsStringToBytes(s) {
  // Strip the base emoji code point (could be 1 or more UTF-16 units; use code points).
  const cps = [...s].map(ch => ch.codePointAt(0));
  if (cps.length === 0 || cps[0] !== 0x1F7E2) throw new Error('missing base emoji');
  const bytes = new Uint8Array(cps.length - 1);
  for (let i = 1; i < cps.length; i++) {
    const cp = cps[i];
    if (cp >= 0xFE00 && cp <= 0xFE0F) bytes[i - 1] = cp - 0xFE00;
    else if (cp >= 0xE0100 && cp <= 0xE01EF) bytes[i - 1] = (cp - 0xE0100) + 16;
    else throw new Error(`unexpected codepoint at index ${i}: U+${cp.toString(16)}`);
  }
  return Buffer.from(bytes);
}

// Encode a byte array as base emoji + variation selectors.
function bytesToVsString(buf) {
  let out = BASE_EMOJI;
  for (const b of buf) out += byteToVS(b);
  return out;
}

function brotli11(buf) {
  return zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

// Deterministic pseudo-random ASCII (printable, 0x20..0x7E).
// Seed -> SHA256 stream -> map each byte into ASCII printable range.
function makePayload(nBytes, seed) {
  const out = Buffer.alloc(nBytes);
  let counter = 0;
  let pos = 0;
  while (pos < nBytes) {
    const block = crypto.createHash('sha256').update(`${seed}|${counter}`).digest();
    for (let i = 0; i < block.length && pos < nBytes; i++) {
      // Map 0..255 -> 0x20..0x7E (95 printable chars)
      out[pos++] = 0x20 + (block[i] % 95);
    }
    counter++;
  }
  return out;
}

function tokenCount(s) {
  return encodeCl100k(s).length;
}

function ratio(a, b) {
  return Math.round((a / b) * 10000) / 10000;
}

function runOne(sizeBytes, seed) {
  // Raw payload
  const raw = makePayload(sizeBytes, seed);
  const rawStr = raw.toString('utf8'); // all printable ASCII, 1 byte each in UTF-8
  const rawUtf8Bytes = Buffer.byteLength(rawStr, 'utf8');
  const rawBrotliBytes = brotli11(Buffer.from(rawStr, 'utf8')).length;
  const rawTokens = tokenCount(rawStr);
  const rawSha = sha256(raw);

  // VS-encoded
  const vsStr = bytesToVsString(raw);
  const vsUtf8Bytes = Buffer.byteLength(vsStr, 'utf8');
  const vsBrotliBytes = brotli11(Buffer.from(vsStr, 'utf8')).length;
  const vsTokens = tokenCount(vsStr);

  // Round-trip
  const decoded = vsStringToBytes(vsStr);
  const decodedSha = sha256(decoded);
  const roundtrip = (decodedSha === rawSha) ? 'MATCH' : 'FAIL';

  return {
    size: sizeBytes,
    raw_utf8_bytes: rawUtf8Bytes,
    raw_brotli_bytes: rawBrotliBytes,
    raw_token_count: rawTokens,
    raw_sha256: rawSha,
    vs_utf8_bytes: vsUtf8Bytes,
    vs_brotli_bytes: vsBrotliBytes,
    vs_token_count: vsTokens,
    decoded_sha256: decodedSha,
    roundtrip,
    ratio_utf8: ratio(vsUtf8Bytes, rawUtf8Bytes),
    ratio_brotli: ratio(vsBrotliBytes, rawBrotliBytes),
    ratio_tokens: ratio(vsTokens, rawTokens),
  };
}

const r200  = runOne(200,  'E1-emoji-vs-cost-200');
const r2000 = runOne(2000, 'E1-emoji-vs-cost-2000');

function fmtRow(r) {
  return `Payload ${r.size.toLocaleString()} bytes:
  raw_utf8_bytes:        ${r.raw_utf8_bytes}
  raw_brotli_bytes:      ${r.raw_brotli_bytes}
  raw_token_count:       ${r.raw_token_count}
  vs_utf8_bytes:         ${r.vs_utf8_bytes}  (base emoji 4B + ${r.size} variation selectors)
  vs_brotli_bytes:       ${r.vs_brotli_bytes}
  vs_token_count:        ${r.vs_token_count}
  ratio_utf8:            ${r.ratio_utf8.toFixed(2)}  (vs/raw; <1 = WIN)
  ratio_brotli:          ${r.ratio_brotli.toFixed(2)}
  ratio_tokens:          ${r.ratio_tokens.toFixed(2)}
  roundtrip_sha256:      ${r.roundtrip}`;
}

const wins = [];
for (const r of [r200, r2000]) {
  if (r.ratio_utf8   < 1) wins.push(`utf8@${r.size}`);
  if (r.ratio_brotli < 1) wins.push(`brotli@${r.size}`);
  if (r.ratio_tokens < 1) wins.push(`tokens@${r.size}`);
}
const verdict = wins.length === 0
  ? 'No layer wins. VS encoding inflates UTF-8, brotli, and tokens at both sizes.'
  : `WINS at: ${wins.join(', ')}`;

const table =
`=== Exp E1 — VS Emoji Wire+Token Cost ===

${fmtRow(r200)}

${fmtRow(r2000)}

Verdict: ${verdict}`;

console.log(table);

// Persist summary
const summary = {
  experiment: 'E1-emoji-vs-cost',
  ts: new Date().toISOString(),
  bun: process.versions.bun ?? null,
  tokenizer: 'gpt-tokenizer cl100k_base',
  tokenizer_version: '3.4.0',
  encoding: {
    base_emoji: '\u{1F7E2}',
    base_emoji_codepoint: 'U+1F7E2',
    vs_low: 'U+FE00..U+FE0F (bytes 0..15)',
    vs_high: 'U+E0100..U+E01EF (bytes 16..255)',
  },
  results: { p200: r200, p2000: r2000 },
  verdict,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));

console.log(`\nsummary.json written: ${path.join(ROOT, 'summary.json')}`);
