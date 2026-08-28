// Experiment 04 — Triskele / IFS recursive self-similarity
//
// Test 3-fold (triskele), 2-fold, and 4-fold self-similar partitions of the
// receipt sequence. For each N-fold split, hash each part's structural signature
// and measure how similar the parts are. If parts are similar, encode as
// fundamental_part + per-part residual_diff.

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
  fs.writeFileSync(HYP, `# Experiment 04 — Triskele / IFS Recursive Self-Similarity

## Hypothesis
N-fold partition (2, 3, 4) of the receipt action sequence may exhibit self-similarity: each part has the same coarse shape, differing only in residual detail. If parts overlap structurally, encode as (fundamental_part_template, residual_diffs_per_part).

The triskele (3-fold) is the canonical Celtic spiral. If receipts come in 3-phase bursts (e.g. organism stages × repeated work × cooldown), 3-fold IFS may collapse the corpus by ~3×.

## Predicted ratio
2–8× compound with Experiment 01's spike baseline (16.56×). Standalone test measures the self-similarity, not the full corpus encoding.

## Pass criterion
PASS if any N-fold split yields per-part action-distribution similarity ≥ 0.8 (Jaccard) AND the IFS-encoded action stream + brotli ≥ 5× vs raw action stream.
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const actions = receipts.map(r => r.action);
console.log(`Loaded ${receipts.length} receipts`);

// ─── N-fold similarity analysis ─────────────────────────────────────────────
function jaccard(setA, setB) {
  let inter = 0;
  for (const x of setA) if (setB.has(x)) inter++;
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}
function actionDist(arr) {
  const m = new Map();
  for (const a of arr) m.set(a, (m.get(a) || 0) + 1);
  return m;
}
function distSimilarity(a, b) {
  // Cosine-like similarity on action-distribution vectors
  const keys = new Set([...a.keys(), ...b.keys()]);
  let dot = 0, na = 0, nb = 0;
  for (const k of keys) {
    const va = a.get(k) || 0, vb = b.get(k) || 0;
    dot += va * vb;
    na += va * va;
    nb += vb * vb;
  }
  return dot / Math.sqrt(Math.max(1, na * nb));
}

console.log('\nN-fold self-similarity analysis (cosine similarity of action distributions):');
const candidates = [2, 3, 4, 6];
const results = [];
for (const N of candidates) {
  const partSize = Math.floor(actions.length / N);
  const parts = [];
  for (let i = 0; i < N; i++) {
    parts.push(actions.slice(i * partSize, (i + 1) * partSize));
  }
  const dists = parts.map(actionDist);
  let sims = [];
  for (let i = 0; i < N - 1; i++) sims.push(distSimilarity(dists[i], dists[i + 1]));
  const avgSim = sims.reduce((s, x) => s + x, 0) / sims.length;
  const jacSet = parts.map(p => new Set(p));
  const jacAvg = (() => {
    let total = 0, count = 0;
    for (let i = 0; i < N - 1; i++) { total += jaccard(jacSet[i], jacSet[i + 1]); count++; }
    return total / count;
  })();
  results.push({ N, partSize, cosine_sim: avgSim, jaccard_sim: jacAvg });
  console.log(`  N=${N}  partSize=${partSize}  cosine ${avgSim.toFixed(3)}  jaccard ${jacAvg.toFixed(3)}`);
}

const best = [...results].sort((a, b) => b.cosine_sim - a.cosine_sim)[0];
console.log(`\nBest N-fold: N=${best.N} cos=${best.cosine_sim.toFixed(3)}`);

// ─── IFS encoding: store the first part as fundamental, residuals as diffs ─
const N = best.N;
const partSize = Math.floor(actions.length / N);
const fundamental = actions.slice(0, partSize);
const residuals = [];
for (let i = 1; i < N; i++) {
  const part = actions.slice(i * partSize, (i + 1) * partSize);
  const diffs = [];
  for (let j = 0; j < partSize; j++) {
    if (part[j] !== fundamental[j]) diffs.push([j, part[j]]); // [pos, value]
  }
  residuals.push(diffs);
}
const tailOffset = N * partSize;
const tail = actions.slice(tailOffset); // remainder beyond N*partSize

console.log(`\nIFS encoding:`);
console.log(`  fundamental part: ${fundamental.length} items`);
console.log(`  residual diffs per part:`, residuals.map(r => r.length));
console.log(`  tail (unrepresented): ${tail.length} items`);

// Serialize lossless
const vocab = new Map();
for (const a of actions) if (!vocab.has(a)) vocab.set(a, vocab.size);
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

const out = [];
// Header: N, partSize, vocab, fundamental, residuals, tail
out.push(varint(N));
out.push(varint(partSize));
out.push(varint(vocab.size));
for (const k of vocab.keys()) out.push(...writeStr(k));
for (const a of fundamental) out.push(varint(vocab.get(a)));
for (const diffs of residuals) {
  out.push(varint(diffs.length));
  for (const [pos, val] of diffs) out.push(varint(pos), varint(vocab.get(val)));
}
out.push(varint(tail.length));
for (const a of tail) out.push(varint(vocab.get(a)));

const ifsStream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(ifsStream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

const rawActionStream = Buffer.from(actions.join('\n') + '\n');
const ratio = rawActionStream.length / brotli.length;
console.log(`\nIFS+brotli: ${brotli.length} bytes vs raw action stream ${rawActionStream.length} bytes = ${ratio.toFixed(2)}x`);

// ─── Lossless roundtrip ─────────────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const dN = v;
[v, p] = readVarint(dec, p); const dPart = v;
[v, p] = readVarint(dec, p); const vSize = v;
const inv = [];
for (let i = 0; i < vSize; i++) {
  let len; [len, p] = readVarint(dec, p);
  inv.push(dec.slice(p, p + len).toString('utf8'));
  p += len;
}
const dFund = [];
for (let i = 0; i < dPart; i++) { [v, p] = readVarint(dec, p); dFund.push(inv[v]); }
const dRes = [];
for (let i = 1; i < dN; i++) {
  let nDiffs; [nDiffs, p] = readVarint(dec, p);
  const diffs = [];
  for (let j = 0; j < nDiffs; j++) {
    let pos, val;
    [pos, p] = readVarint(dec, p);
    [val, p] = readVarint(dec, p);
    diffs.push([pos, inv[val]]);
  }
  dRes.push(diffs);
}
let tlen; [tlen, p] = readVarint(dec, p);
const dTail = [];
for (let i = 0; i < tlen; i++) { [v, p] = readVarint(dec, p); dTail.push(inv[v]); }

// Reconstruct full actions
const reconstructed = [...dFund];
for (let i = 0; i < dN - 1; i++) {
  const part = [...dFund];
  for (const [pos, val] of dRes[i]) part[pos] = val;
  reconstructed.push(...part);
}
reconstructed.push(...dTail);

const recStream = reconstructed.join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recStream).digest('hex');
const origSha = crypto.createHash('sha256').update(rawActionStream).digest('hex');
const roundtripOk = recSha === origSha;
console.log(`\nRoundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);

const receipt = {
  experiment: '04-triskele-ifs',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  raw_action_stream_bytes: rawActionStream.length,
  ifs_stream_bytes: ifsStream.length,
  ifs_brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  best_N: best.N,
  best_cosine_sim: Number(best.cosine_sim.toFixed(3)),
  best_jaccard_sim: Number(best.jaccard_sim.toFixed(3)),
  all_N_analysis: results.map(r => ({ N: r.N, cosine_sim: Number(r.cosine_sim.toFixed(3)), jaccard_sim: Number(r.jaccard_sim.toFixed(3)) })),
  pass: roundtripOk && ratio > 5 && best.cosine_sim >= 0.8,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 04 — Triskele / IFS Recursive Self-Similarity — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Self-similarity analysis (cosine similarity between consecutive parts)

| N | partSize | cosine | jaccard |
|---|---|---|---|
${results.map(r => `| ${r.N} | ${r.partSize} | ${r.cosine_sim.toFixed(3)} | ${r.jaccard_sim.toFixed(3)} |`).join('\n')}

**Best:** N=${best.N} with cosine similarity ${best.cosine_sim.toFixed(3)}, jaccard ${best.jaccard_sim.toFixed(3)}.

## IFS encoding measurement (on action column only)

| Metric | Value |
|---|---|
| Raw action stream | ${rawActionStream.length.toLocaleString()} B |
| IFS encoded (pre-brotli) | ${ifsStream.length.toLocaleString()} B |
| IFS + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Lossless roundtrip | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `N=${best.N}-fold partition gives cosine similarity ${best.cosine_sim.toFixed(3)}. IFS encoding (fundamental + residual diffs) plus brotli achieves ${ratio.toFixed(2)}× on the action stream.` :
  best.cosine_sim < 0.8 ?
    `Hypothesis falsified: highest N-fold cosine similarity is ${best.cosine_sim.toFixed(3)} (below 0.8 threshold). The receipt action sequence does not partition into N-fold self-similar chunks at any tested N — phases of organism execution have qualitatively different action distributions.` :
    `Cosine similarity adequate (${best.cosine_sim.toFixed(3)}) but compound ratio (${ratio.toFixed(2)}×) below 5× threshold. Encoding overhead exceeds savings on this corpus.`}

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/04-triskele-ifs/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
