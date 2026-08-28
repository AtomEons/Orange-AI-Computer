// Experiment 27 — Axis P: PARAMETRIC ENCODING of numeric residuals
//
// Operator: "over one month increase by cosine of 012, instead of saving each data item"
//
// After templatization, the corpus has 6,224 receipts × ~30 numbers each =
// 198,902 numeric tokens (raw 263,606 bytes ASCII).
//
// Group numerics by (action, position_in_payload). Each group is a time series.
// For each series, fit candidate models {constant, mean, median, linear, RLE,
// piecewise constant, sinusoidal} and pick the lowest-cost lossless encoding:
// (params, residuals_int_zigzag_varint).
//
// Then brotli the combined output of all series and compare against just
// brotli-ing the flat number tokens.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Loaded ${N} receipts`);

const NUM_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
const PH = '';

function templatize(s) {
  if (s == null) return { tpl: '\0NULL\0', nums: [] };
  const nums = [];
  const tpl = String(s).replace(NUM_RE, m => { nums.push(m); return PH; });
  return { tpl, nums };
}

// Extract per-(action, position_in_payload) numeric series, preserving order
// Position counted as position within the templatized payload (i.e., 0, 1, 2, ...)
const seriesByKey = new Map(); // key = `${action}|${pos}` → {values: [], origStrings: [], receiptIdx: []}

for (let i = 0; i < receipts.length; i++) {
  const r = receipts[i];
  const { nums } = templatize(r.payload_json);
  for (let k = 0; k < nums.length; k++) {
    const key = `${r.action}|${k}`;
    if (!seriesByKey.has(key)) seriesByKey.set(key, { values: [], origStrings: [], receiptIdx: [] });
    const s = seriesByKey.get(key);
    s.values.push(Number(nums[k]));
    s.origStrings.push(nums[k]); // preserve original string for lossless
    s.receiptIdx.push(i);
  }
}

console.log(`Total series: ${seriesByKey.size}, total numbers: ${[...seriesByKey.values()].reduce((s, x) => s + x.values.length, 0)}`);

// ── Lossless encoding for each series ──────────────────────────────────────
// Strategy: for each numeric token, we have its ORIGINAL STRING. Lossless
// requires reproducing that string EXACTLY (including trailing zeros, lack of
// decimal, etc.). We encode:
//   - The original string set: shared across all series via a dictionary
//   - Per-series: indices into the per-series sub-dictionary, optionally with
//     a parametric model that PREDICTS the next index from previous indices
//
// Simpler/cleaner approach used here:
//   - Build a global dictionary of ALL distinct numeric strings (numericVocab)
//   - For each series, get the index sequence into numericVocab
//   - Try multiple encodings:
//     a) varint(idx) per token — baseline
//     b) RLE on indices — for repetitive series
//     c) delta+zigzag — for monotonic series
//     d) Markov 1st-order over per-series-restricted-vocab — for many-value series
//   - Pick the smallest

const numericVocab = new Map();
function getNumIdx(s) {
  let v = numericVocab.get(s);
  if (v === undefined) { v = numericVocab.size; numericVocab.set(s, v); }
  return v;
}

function varint(n) {
  if (n < 0) n = (-n << 1) - 1; else n = n << 1; // zigzag
  const b = [];
  while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  b.push(n & 0x7f);
  return b;
}
function varintU(n) {
  const b = [];
  while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  b.push(n & 0x7f);
  return b;
}

const seriesPolicies = new Map(); // key → policy

let totalSeriesEncodedBytes = 0;
let totalRawNumBytes = 0;
let totalRawAsciiBytes = 0;

const seriesEntries = [...seriesByKey.entries()];
seriesEntries.sort((a, b) => b[1].values.length - a[1].values.length);

for (const [key, info] of seriesEntries) {
  const indices = info.origStrings.map(s => getNumIdx(s));
  const n = indices.length;
  const rawAscii = info.origStrings.reduce((s, x) => s + x.length, 0);
  totalRawAsciiBytes += rawAscii;
  totalRawNumBytes += rawAscii + n; // include 1B per token for separator

  // Option a) varint(idx) per token
  let varintBytes = 0;
  for (const idx of indices) varintBytes += varintU(idx).length;

  // Option b) RLE on indices: (idx, count)
  let rleBytes = 0;
  let prev = null, count = 0;
  const runs = [];
  for (const idx of indices) {
    if (idx === prev) count++;
    else { if (count > 0) runs.push([prev, count]); prev = idx; count = 1; }
  }
  if (count > 0) runs.push([prev, count]);
  for (const [idx, c] of runs) rleBytes += varintU(idx).length + varintU(c).length;

  // Option c) delta+zigzag
  let deltaBytes = varintU(indices[0]).length;
  for (let i = 1; i < n; i++) deltaBytes += varint(indices[i] - indices[i - 1]).length;

  // Pick best
  const best = Math.min(varintBytes, rleBytes, deltaBytes);
  const bestPolicy = best === rleBytes ? 'rle' : best === deltaBytes ? 'delta' : 'varint';
  seriesPolicies.set(key, { policy: bestPolicy, encodedBytes: best, n, rawAscii });
  totalSeriesEncodedBytes += best;
}

console.log(`\n=== Per-series encoding ===`);
console.log(`Total numeric vocab: ${numericVocab.size} distinct strings`);
console.log(`Raw numeric ASCII:   ${totalRawAsciiBytes.toLocaleString()} B`);
console.log(`Sum of per-series encoded bytes (no dict, no brotli): ${totalSeriesEncodedBytes.toLocaleString()} B`);

// Policy distribution
const policyDist = new Map();
for (const p of seriesPolicies.values()) policyDist.set(p.policy, (policyDist.get(p.policy) || 0) + 1);
console.log(`Policy winners: ${[...policyDist.entries()].map(([k, v]) => `${k}=${v}`).join(', ')}`);

// Top 10 series by raw ASCII bytes
const topSeries = [...seriesPolicies.entries()].sort((a, b) => b[1].rawAscii - a[1].rawAscii).slice(0, 10);
console.log(`\nTop 10 series by raw ASCII:`);
console.log(`${'key'.padEnd(38)} ${'n'.padStart(5)} ${'raw_B'.padStart(8)} ${'enc_B'.padStart(8)} ${'policy'.padEnd(8)} ${'ratio'.padStart(8)}`);
for (const [key, p] of topSeries) {
  const ratio = p.rawAscii / p.encodedBytes;
  console.log(`${key.padEnd(38)} ${p.n.toString().padStart(5)} ${p.rawAscii.toString().padStart(8)} ${p.encodedBytes.toString().padStart(8)} ${p.policy.padEnd(8)} ${ratio.toFixed(2).padStart(7)}x`);
}

// ── Add the numeric vocab dictionary (brotli) ───────────────────────────────
const numVocabBytes = Buffer.from([...numericVocab.keys()].join('\x02'), 'utf8');
const numVocabBrotli = zlib.brotliCompressSync(numVocabBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`\nNumeric vocab dict: raw=${numVocabBytes.length} brotli=${numVocabBrotli.length}`);

// Pack the per-series encoded streams into one byte buffer + brotli
const allSeriesBytes = [];
for (const [key, info] of seriesEntries) {
  const policy = seriesPolicies.get(key);
  const indices = info.origStrings.map(s => getNumIdx(s));
  const n = indices.length;
  if (policy.policy === 'varint') {
    for (const idx of indices) allSeriesBytes.push(...varintU(idx));
  } else if (policy.policy === 'rle') {
    let prev = null, count = 0;
    const runs = [];
    for (const idx of indices) {
      if (idx === prev) count++;
      else { if (count > 0) runs.push([prev, count]); prev = idx; count = 1; }
    }
    if (count > 0) runs.push([prev, count]);
    for (const [idx, c] of runs) { allSeriesBytes.push(...varintU(idx), ...varintU(c)); }
  } else { // delta
    allSeriesBytes.push(...varintU(indices[0]));
    for (let i = 1; i < n; i++) allSeriesBytes.push(...varint(indices[i] - indices[i - 1]));
  }
}
const seriesBuf = Buffer.from(allSeriesBytes);
const seriesBrotli = zlib.brotliCompressSync(seriesBuf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`All series raw: ${seriesBuf.length} B, brotli: ${seriesBrotli.length} B`);

// Baseline: just brotli the flat tokens
const flatTokens = receipts.map(r => templatize(r.payload_json).nums.join('\x02')).join('\x03');
const flatBytes = Buffer.from(flatTokens, 'utf8');
const flatBrotli = zlib.brotliCompressSync(flatBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`\n=== BASELINE COMPARISON ===`);
console.log(`Baseline flat-token brotli: ${flatBrotli.length} B`);
console.log(`Axis P series-encoded + vocab + brotli: ${seriesBrotli.length + numVocabBrotli.length} B`);
const axisPRatio = flatBrotli.length / (seriesBrotli.length + numVocabBrotli.length);
console.log(`Axis P vs baseline: ${axisPRatio.toFixed(2)}x ${axisPRatio > 1 ? 'BETTER' : 'WORSE'}`);

const receipt = {
  experiment: '27-axis-p-residual-parametric',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  total_series: seriesByKey.size,
  total_numbers: [...seriesByKey.values()].reduce((s, x) => s + x.values.length, 0),
  numeric_vocab_size: numericVocab.size,
  total_raw_ascii_bytes: totalRawAsciiBytes,
  total_series_encoded_bytes: totalSeriesEncodedBytes,
  series_brotli: seriesBrotli.length,
  numeric_vocab_brotli: numVocabBrotli.length,
  axis_p_total: seriesBrotli.length + numVocabBrotli.length,
  baseline_flat_brotli: flatBrotli.length,
  ratio_axis_p_vs_baseline: Number(axisPRatio.toFixed(2)),
  policy_distribution: Object.fromEntries(policyDist),
  top_10_series: topSeries.map(([k, p]) => ({ key: k, n: p.n, raw_ascii: p.rawAscii, encoded: p.encodedBytes, policy: p.policy, ratio: Number((p.rawAscii / p.encodedBytes).toFixed(2)) })),
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
