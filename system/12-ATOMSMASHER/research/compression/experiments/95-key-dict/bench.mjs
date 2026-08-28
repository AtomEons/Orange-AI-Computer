// Experiment 95 — JSON-key global dict substitution + brotli q11.
// Build a global dict of frequent JSON keys and inline literals across the corpus,
// replace each with a 1-byte ESC token from a reserved control-byte range that
// is guaranteed not to appear in JSON text (JSON forbids raw 0x00-0x1F inside
// strings), then brotli q11 on the substituted stream.
//
// Tests whether explicit *symbolic* key substitution helps brotli — i.e. is
// brotli's LZ77 already capturing these key repeats fully, or does a 1-byte
// token reduce its LZ77 distance/length overhead enough to win net bytes?
//
// Lossless: full byte-exact roundtrip with sha256 verification.
//
// Codec class: dictionary-coder preprocessor + LZ77/Huffman (brotli).
// vs M19 (47.07x) which is shape-deduplication + per-field varint + brotli q11.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const N = corpusBytes.length;

function brotli11(b) {
  return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}

// ── Dictionary: tokens chosen to be single bytes in 0x01..0x1F that JSON cannot
//    contain inside a string and are not used as JSON structural chars. We avoid
//    0x00 (terminator confusion), 0x09 (\t), 0x0A (\n), 0x0D (\r). The remaining
//    pool is plenty for the ~24 frequent keys/literals we want to encode.
//
// Strategy: pick the highest-frequency *literal byte sequences* (keys and stable
// punctuation like `","`) so each replacement saves max bytes per occurrence.

const TOKENS = [
  0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
  0x0B, 0x0C, 0x0E, 0x0F,
  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17,
  0x18, 0x19, 0x1A, 0x1B, 0x1C, 0x1D, 0x1E, 0x1F,
];

// Order matters: longest patterns first to avoid a shorter pattern eating a
// substring of a longer one. We pick patterns that are (a) high frequency,
// (b) long enough that a 1-byte token saves >=2 bytes.
const PATTERNS = [
  '","payload_json":',         // appears once per non-mesh receipt header
  '","compressed_bytes":',
  '","created_at":',
  '","summary":"',
  '","status":',
  '","action":"',
  '"compressed_bytes":',
  '"payload_json":',
  '"raw_bytes":',
  '"created_at":',
  '"summary":',
  '"status":',
  '"action":',
  '"ratio":',
  '"id":"',
  '"mesh.compress"',
  '"rcpt_',
  'packet #',
  '","id":"',
  '"OK"',
  '"ok"',
  '","raw_bytes":',
  '{"id":"',
  '"}\n{',
];

// Confirm all patterns exist in corpus.
const corpusText = corpusBytes.toString('binary');
const usedPatterns = [];
const usedTokens = [];
let countTotal = 0;
for (let i = 0; i < PATTERNS.length && i < TOKENS.length; i++) {
  const p = PATTERNS[i];
  // count non-overlapping occurrences
  let count = 0;
  let pos = 0;
  while ((pos = corpusText.indexOf(p, pos)) !== -1) { count++; pos += p.length; }
  if (count === 0) continue;
  usedPatterns.push({ pattern: p, count, savedBytes: count * (p.length - 1), token: TOKENS[usedPatterns.length] });
  countTotal += count;
}
// Reassign tokens compactly to whatever patterns actually matched.
for (let i = 0; i < usedPatterns.length; i++) usedPatterns[i].token = TOKENS[i];
for (const u of usedPatterns) usedTokens.push(u.token);

// Pre-flight: verify no chosen token byte appears in the corpus as a raw byte
// (it shouldn't because JSON forbids unescaped control bytes in strings, but
// be paranoid).
const tokenSet = new Set(usedTokens);
for (let i = 0; i < corpusBytes.length; i++) {
  if (tokenSet.has(corpusBytes[i])) {
    throw new Error(`Token byte 0x${corpusBytes[i].toString(16)} found in corpus at offset ${i}`);
  }
}

// ── Encode: stream-replace each pattern with its single-byte token.
//    We do longest-first because that's how usedPatterns is ordered.
function encode(buf) {
  let s = buf.toString('binary');
  for (const u of usedPatterns) {
    // Use split/join with a single byte to avoid escape issues. The token char
    // is built from a single binary code point.
    const tok = String.fromCharCode(u.token);
    s = s.split(u.pattern).join(tok);
  }
  return Buffer.from(s, 'binary');
}

function decode(buf) {
  let s = buf.toString('binary');
  // Reverse: substitute longer patterns first too (they were applied first, so
  // their tokens are unique and won't collide with shorter pattern tokens).
  for (const u of usedPatterns) {
    const tok = String.fromCharCode(u.token);
    s = s.split(tok).join(u.pattern);
  }
  return Buffer.from(s, 'binary');
}

const encT0 = process.hrtime.bigint();
const substituted = encode(corpusBytes);
const compressed = brotli11(substituted);
const encT1 = process.hrtime.bigint();
const encMs = Number(encT1 - encT0) / 1e6;

// ── Decode + roundtrip
const decT0 = process.hrtime.bigint();
const decompressed = zlib.brotliDecompressSync(compressed);
const restored = decode(decompressed);
const decT1 = process.hrtime.bigint();
const decMs = Number(decT1 - decT0) / 1e6;

const restoredSha = crypto.createHash('sha256').update(restored).digest('hex');
const lossless = restoredSha === corpusSha;

// ── Honest baseline: plain brotli11 on raw corpus (no preprocessing)
const baseT0 = process.hrtime.bigint();
const plainBr = brotli11(corpusBytes);
const baseT1 = process.hrtime.bigint();
const baseMs = Number(baseT1 - baseT0) / 1e6;
const plainRatio = N / plainBr.length;

const ratio = N / compressed.length;
const M19 = 47.071;
const M19_TOTAL = 44095;

const summary = {
  experiment: '95-key-dict-substitution',
  corpus_bytes: N,
  corpus_sha256: corpusSha,
  patterns_used: usedPatterns.length,
  total_pattern_hits: countTotal,
  bytes_saved_by_substitution: usedPatterns.reduce((a, u) => a + u.savedBytes, 0),
  substituted_bytes: substituted.length,
  compressed_bytes: compressed.length,
  ratio_vs_raw: Number(ratio.toFixed(3)),
  vs_M19: Number((ratio - M19).toFixed(3)),
  vs_M19_pct: Number(((ratio - M19) / M19 * 100).toFixed(2)),
  plain_brotli11_bytes: plainBr.length,
  plain_brotli11_ratio: Number(plainRatio.toFixed(3)),
  vs_plain_brotli: Number((ratio - plainRatio).toFixed(3)),
  enc_ms: Number(encMs.toFixed(2)),
  dec_ms: Number(decMs.toFixed(2)),
  baseline_brotli_ms: Number(baseMs.toFixed(2)),
  lossless,
  restored_sha256: restoredSha,
  verdict:
    !lossless ? 'RED-not-lossless'
    : ratio >= M19 ? 'GREEN-beats-M19'
    : ratio >= plainRatio * 1.05 ? 'AMBER-beats-plain-brotli'
    : 'RED-below-plain-brotli',
  notes:
    'Key/literal dictionary substitution with reserved control-byte tokens, then brotli q11. ' +
    'Tests whether explicit symbolic key replacement helps brotli net bytes vs its native LZ77 over the same repeats.',
  patterns: usedPatterns.map(u => ({ pattern: u.pattern, count: u.count, token_hex: '0x' + u.token.toString(16).padStart(2, '0') })),
};

fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary, null, 2));
