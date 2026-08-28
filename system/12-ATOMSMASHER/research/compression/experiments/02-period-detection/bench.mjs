// Experiment 02 — Period Detection (frieze-group RLE on action sequence)
//
// Detect periodic structure in the action column. Encode via run-length pairs.
// Compare against per-byte brotli baseline.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const META = JSON.parse(fs.readFileSync(path.resolve(ROOT, '../../data/canonical-corpus.meta.json'), 'utf8'));
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');

const lines = fs.readFileSync(CORPUS, 'utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const actions = receipts.map(r => r.action);
console.log(`Loaded ${receipts.length} receipts; ${actions.length} actions`);

// Raw action column as a byte stream
const rawActionStream = actions.join('\n') + '\n';
const rawActionBytes = Buffer.from(rawActionStream);
console.log(`Raw action stream: ${rawActionBytes.length} bytes`);

// Per-byte brotli baseline on the action column
const baselineBrotli = zlib.brotliCompressSync(rawActionBytes, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
});
console.log(`Baseline brotli q11 on action stream: ${baselineBrotli.length} bytes (${(rawActionBytes.length / baselineBrotli.length).toFixed(2)}x)`);

// ── Autocorrelation for period detection ─────────────────────────────────────
function autocorrelation(seq, maxLag) {
  const out = [];
  for (let k = 1; k <= maxLag; k++) {
    let matches = 0;
    for (let i = 0; i + k < seq.length; i++) {
      if (seq[i] === seq[i + k]) matches++;
    }
    const rate = matches / Math.max(1, seq.length - k);
    out.push({ k, rate });
  }
  return out;
}
const autocorr = autocorrelation(actions, 50);
const best = [...autocorr].sort((a, b) => b.rate - a.rate)[0];
console.log(`Best autocorrelation period: k=${best.k} with match rate ${(best.rate * 100).toFixed(1)}%`);
// Show top 5
console.log('Top 5 periods:');
[...autocorr].sort((a, b) => b.rate - a.rate).slice(0, 5).forEach(({ k, rate }) =>
  console.log(`  k=${k.toString().padStart(2)}  rate=${(rate * 100).toFixed(1)}%`)
);

// ── RLE encoding of the action sequence ────────────────────────────────────
const vocab = new Map();
for (const a of actions) if (!vocab.has(a)) vocab.set(a, vocab.size);
const invVocab = [...vocab.keys()];

function varint(n) {
  const bytes = [];
  while (n >= 128) { bytes.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  bytes.push(n & 0x7f);
  return Buffer.from(bytes);
}
function readVarint(buf, ofs) {
  let n = 0, mult = 1, b;
  do { b = buf[ofs++]; n += (b & 0x7f) * mult; mult *= 128; } while (b & 0x80);
  return [n, ofs];
}

// Header: vocab + RLE pairs
const out = [];
out.push(varint(vocab.size));
for (const v of invVocab) {
  const b = Buffer.from(v, 'utf8');
  out.push(varint(b.length), b);
}
// RLE
let runId = vocab.get(actions[0]);
let runLen = 1;
let pairCount = 0;
const rlePairs = [];
for (let i = 1; i < actions.length; i++) {
  const id = vocab.get(actions[i]);
  if (id === runId) {
    runLen++;
  } else {
    rlePairs.push([runId, runLen]);
    pairCount++;
    runId = id;
    runLen = 1;
  }
}
rlePairs.push([runId, runLen]);
pairCount++;
out.push(varint(pairCount));
for (const [id, len] of rlePairs) {
  out.push(varint(id), varint(len));
}

const rleStream = Buffer.concat(out);
console.log(`\nRLE pairs: ${pairCount} (avg run length ${(actions.length / pairCount).toFixed(2)})`);
console.log(`RLE stream raw:        ${rleStream.length} bytes`);

const rleBrotli = zlib.brotliCompressSync(rleStream, {
  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
});
console.log(`RLE + brotli q11:      ${rleBrotli.length} bytes`);
const rleRatio = rawActionBytes.length / rleBrotli.length;
console.log(`RLE+brotli ratio:      ${rleRatio.toFixed(2)}x  vs raw action stream`);

// ── Roundtrip verify ─────────────────────────────────────────────────────────
function decodeRLE(buf) {
  let p = 0;
  let v;
  [v, p] = readVarint(buf, p); const vsize = v;
  const inv = [];
  for (let i = 0; i < vsize; i++) {
    let len; [len, p] = readVarint(buf, p);
    inv.push(buf.slice(p, p + len).toString('utf8'));
    p += len;
  }
  [v, p] = readVarint(buf, p); const pc = v;
  const out = [];
  for (let i = 0; i < pc; i++) {
    let id, len;
    [id, p] = readVarint(buf, p);
    [len, p] = readVarint(buf, p);
    for (let j = 0; j < len; j++) out.push(inv[id]);
  }
  return out;
}

const decoded = decodeRLE(zlib.brotliDecompressSync(rleBrotli));
const decodedStream = decoded.join('\n') + '\n';
const origSha = crypto.createHash('sha256').update(rawActionStream).digest('hex');
const decSha = crypto.createHash('sha256').update(decodedStream).digest('hex');
const roundtripOk = origSha === decSha;
console.log(`\nRoundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);

const receipt = {
  experiment: '02-period-detection',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: META.corpus_sha256,
  action_stream_bytes: rawActionBytes.length,
  baseline_brotli_bytes: baselineBrotli.length,
  baseline_brotli_ratio: Number((rawActionBytes.length / baselineBrotli.length).toFixed(2)),
  rle_pairs: pairCount,
  avg_run_length: Number((actions.length / pairCount).toFixed(2)),
  rle_stream_bytes: rleStream.length,
  rle_brotli_bytes: rleBrotli.length,
  rle_brotli_ratio: Number(rleRatio.toFixed(2)),
  best_autocorr_period: best.k,
  best_autocorr_rate: Number(best.rate.toFixed(3)),
  roundtrip_lossless: roundtripOk,
  pass: roundtripOk && rleRatio > 5,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 02 — Period Detection (RLE on action column) — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Measured

| Metric | Value |
|---|---|
| Raw action stream | ${rawActionBytes.length.toLocaleString()} B |
| Baseline brotli q11 | ${baselineBrotli.length.toLocaleString()} B (${receipt.baseline_brotli_ratio}×) |
| RLE pairs | ${pairCount.toLocaleString()} |
| Avg run length | ${receipt.avg_run_length} |
| RLE stream pre-brotli | ${rleStream.length.toLocaleString()} B |
| **RLE + brotli q11** | **${rleBrotli.length.toLocaleString()} B (${receipt.rle_brotli_ratio}×)** |
| Best autocorrelation period | k=${best.k} (match rate ${(best.rate * 100).toFixed(1)}%) |
| Roundtrip lossless | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `RLE encoding on the action column achieves **${receipt.rle_brotli_ratio}× vs raw action stream**, beating per-byte brotli (${receipt.baseline_brotli_ratio}×) by ${((receipt.rle_brotli_ratio / receipt.baseline_brotli_ratio - 1) * 100).toFixed(0)}%. Average run length of ${receipt.avg_run_length} confirms strong periodic structure — most consecutive receipts share their action. This is the frieze-group p1 structure (pure translation) showing up in the data.` :
  `RLE achieved only ${receipt.rle_brotli_ratio}× — below the 5× pass threshold. The action sequence is less periodic than predicted, or RLE's per-pair overhead (varint+varint) negates the savings on short runs.`}

## Versus baseline

This experiment measures the **action column alone**, not the whole corpus. The action column is ${(rawActionBytes.length / META.corpus_bytes * 100).toFixed(1)}% of total corpus bytes. Whole-corpus impact when chained with spike encoding is measured at experiment 10.

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/02-period-detection/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
