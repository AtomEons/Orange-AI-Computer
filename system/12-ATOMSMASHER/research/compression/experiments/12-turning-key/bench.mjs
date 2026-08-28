// Experiment 12 — Turning Key (N-fold ring closure)
//
// Inspired by Adam Tetlow's "Turning Keys": ring-shaped Celtic key patterns
// require the unit-count to be an integer multiple of the key-unit, else
// units won't meet up. Sample N values from the source: 4½, 7½, 42, 72, 6, 12.
//
// Applied to receipts: scan every divisor d of the sequence length N. For each
// d, partition the sequence into d "rings" of length N/d. Score per-d the
// similarity of the rings. Best d = the Turning Key. Encode as:
//   key_d + fundamental_ring + per-ring diffs + tail
// Brotli on the result.

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
  fs.writeFileSync(HYP, `# Experiment 12 — Turning Key (N-fold ring closure)

## Hypothesis
Tetlow's Turning Key theorem: ring-shaped Celtic key patterns require the unit count to be an integer multiple of the key-unit, else units won't meet up. Apply to receipts: find a divisor d of the sequence length N such that the d rings of length N/d are maximally similar (mod the dominant-action mass). Encode as (d, fundamental_ring, per-ring diffs).

This is a generalization of Triskele (fixed N=3) to all divisors of the sequence length.

## Predicted ratio
3–15× on action column. Pass if it beats Experiment 04's 16.86× IFS baseline.

## Reference
Photographed page from Adam Tetlow, "Celtic Pattern" — TURNING KEYS chapter (loomz/10271.jpg).
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const actions = receipts.map(r => r.action);
const N = actions.length;
console.log(`Loaded ${N} actions`);

// ─── Find divisors of N ──────────────────────────────────────────────────────
function divisors(n) {
  const out = [];
  for (let d = 2; d * d <= n; d++) {
    if (n % d === 0) {
      out.push(d);
      if (d !== n / d) out.push(n / d);
    }
  }
  out.sort((a, b) => a - b);
  return out;
}

const divs = divisors(N);
console.log(`\nN=${N} divisors: ${divs.length}`);
console.log(`  (first 10: ${divs.slice(0, 10).join(', ')})`);
console.log(`  (last 5: ${divs.slice(-5).join(', ')})`);

// ─── For each divisor d, compute per-ring similarity ─────────────────────────
function ringSimilarity(arr, d) {
  const ringSize = arr.length / d;
  // Reference ring = first ring
  const ref = arr.slice(0, ringSize);
  let totalMatches = 0;
  let totalPositions = 0;
  for (let i = 1; i < d; i++) {
    const ring = arr.slice(i * ringSize, (i + 1) * ringSize);
    for (let j = 0; j < ringSize; j++) {
      totalPositions++;
      if (ring[j] === ref[j]) totalMatches++;
    }
  }
  return totalPositions > 0 ? totalMatches / totalPositions : 0;
}

// Filter to divisors where d gives a sensible ring size (between 50 and 5000)
const candidates = divs.filter(d => {
  const ringSize = N / d;
  return ringSize >= 50 && ringSize <= 5000 && d >= 2 && d <= 100;
});
console.log(`\n${candidates.length} candidate divisors for ring analysis:`);

let bestD = null;
let bestSim = -1;
const allRingSims = [];
for (const d of candidates) {
  const sim = ringSimilarity(actions, d);
  allRingSims.push({ d, ringSize: N / d, similarity: sim });
  if (sim > bestSim) { bestSim = sim; bestD = d; }
}
allRingSims.sort((a, b) => b.similarity - a.similarity);
console.log('Top 5 candidate (d, ringSize, similarity):');
for (const r of allRingSims.slice(0, 5)) console.log(`  d=${r.d.toString().padStart(4)}  ringSize=${r.ringSize.toString().padStart(5)}  sim=${r.similarity.toFixed(3)}`);

const d = bestD;
const ringSize = N / d;
console.log(`\nBest Turning Key: d=${d} rings of size ${ringSize} (similarity ${bestSim.toFixed(3)})`);

// ─── Encode: vocab + d + fundamental_ring + per-ring diffs ──────────────────
const vocab = new Map();
for (const a of actions) if (!vocab.has(a)) vocab.set(a, vocab.size);
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

const out = [];
out.push(varint(d), varint(ringSize), varint(vocab.size));
for (const k of vocab.keys()) out.push(...writeStr(k));
const fundamental = actions.slice(0, ringSize);
for (const a of fundamental) out.push(varint(vocab.get(a)));
for (let i = 1; i < d; i++) {
  const ring = actions.slice(i * ringSize, (i + 1) * ringSize);
  const diffs = [];
  for (let j = 0; j < ringSize; j++) if (ring[j] !== fundamental[j]) diffs.push([j, vocab.get(ring[j])]);
  out.push(varint(diffs.length));
  for (const [pos, val] of diffs) out.push(varint(pos), varint(val));
}
const tail = actions.slice(d * ringSize);
out.push(varint(tail.length));
for (const a of tail) out.push(varint(vocab.get(a)));

const stream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const rawActionStream = Buffer.from(actions.join('\n') + '\n');
const ratio = rawActionStream.length / brotli.length;
console.log(`\nTurning Key + brotli: ${brotli.length} bytes (${ratio.toFixed(2)}x vs raw)`);

// ─── Roundtrip ──────────────────────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const dD = v;
[v, p] = readVarint(dec, p); const dRingSize = v;
[v, p] = readVarint(dec, p); const vSize = v;
const inv = [];
for (let i = 0; i < vSize; i++) {
  let len; [len, p] = readVarint(dec, p);
  inv.push(dec.slice(p, p + len).toString('utf8'));
  p += len;
}
const dFund = [];
for (let i = 0; i < dRingSize; i++) { [v, p] = readVarint(dec, p); dFund.push(inv[v]); }
const reconstructed = [...dFund];
for (let i = 1; i < dD; i++) {
  const ring = [...dFund];
  let nDiffs; [nDiffs, p] = readVarint(dec, p);
  for (let j = 0; j < nDiffs; j++) {
    let pos, val;
    [pos, p] = readVarint(dec, p);
    [val, p] = readVarint(dec, p);
    ring[pos] = inv[val];
  }
  reconstructed.push(...ring);
}
let tlen; [tlen, p] = readVarint(dec, p);
for (let i = 0; i < tlen; i++) { [v, p] = readVarint(dec, p); reconstructed.push(inv[v]); }

const recStream = reconstructed.join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recStream).digest('hex');
const origSha = crypto.createHash('sha256').update(rawActionStream).digest('hex');
const roundtripOk = recSha === origSha;
console.log(`Roundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);

const receipt = {
  experiment: '12-turning-key',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  sequence_length: N,
  best_d: d,
  ring_size: ringSize,
  ring_similarity: Number(bestSim.toFixed(3)),
  candidates_analyzed: candidates.length,
  top_5_candidates: allRingSims.slice(0, 5).map(r => ({ d: r.d, ringSize: r.ringSize, similarity: Number(r.similarity.toFixed(3)) })),
  raw_action_stream_bytes: rawActionStream.length,
  turning_key_stream_bytes: stream.length,
  turning_key_brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  pass: roundtripOk && ratio > 16.86,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 12 — Turning Key (N-fold ring closure) — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Method
Find all divisors d of N=${N}. For each d, partition the action sequence into d rings of length N/d. Compute per-ring similarity to the first ring (positional-match rate). Pick the d maximizing similarity = the Turning Key. Encode as (d, ring_size, fundamental_ring, per-ring diffs, tail). Brotli.

## Top 5 candidate Turning Keys

| d | ring size | positional similarity |
|---|---|---|
${allRingSims.slice(0, 5).map(r => `| ${r.d} | ${r.ringSize} | ${r.similarity.toFixed(3)} |`).join('\n')}

## Best key

| Metric | Value |
|---|---|
| Best d | ${d} |
| Ring size | ${ringSize} |
| Positional similarity | ${bestSim.toFixed(3)} |

## Compression measurement (action column)

| Metric | Value |
|---|---|
| Raw action stream | ${rawActionStream.length.toLocaleString()} B |
| Turning Key pre-brotli | ${stream.length.toLocaleString()} B |
| Turning Key + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Lossless roundtrip | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `Turning Key d=${d} beats Experiment 04's 16.86× IFS baseline. The corpus has a natural ring structure at this divisor.` :
  bestSim < 0.4 ?
    `Tetlow's Turning Key hypothesis falsified for this corpus: best positional similarity ${bestSim.toFixed(3)} is too low — the corpus does not partition cleanly into N self-similar rings at any divisor of length. Receipt sequences are temporal causal streams, not ornamental rings.` :
    `Best key d=${d} gives ${bestSim.toFixed(3)} similarity but encoding overhead exceeds savings (ratio ${ratio.toFixed(2)}× ≤ 16.86× IFS baseline).`}

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/12-turning-key/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
