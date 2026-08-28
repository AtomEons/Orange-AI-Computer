// Experiment 07 — Plait / Braid encoding (multi-strand interleave)
//
// Treat the receipt stream as N parallel strands, one per engine family.
// Encode as (strand_id sequence, per-strand payload stream).
// Inspired by Celtic plaitwork: many strands woven over/under, the strand
// identity at each position + per-strand content reconstructs the full weave.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');
const HYP = path.join(ROOT, 'HYPOTHESIS.md');

if (!fs.existsSync(HYP)) {
  fs.writeFileSync(HYP, `# Experiment 07 — Plait / Braid Encoding (multi-strand interleave)

## Hypothesis
Receipts come from multiple "engines" (action prefix is the strand identifier: mesh.*, air.*, crystal.*, equation.*, etc.). Each engine produces an independent sub-stream that is highly compressible on its own. Reassembling the full corpus requires the per-position strand-identifier sequence + each per-strand stream. Splitting + compressing separately may beat joint compression.

This is plait / braid encoding: each strand is its own thread; the receipts log is the interleave.

## Predicted ratio
3–15× compared to joint encoding. Per-strand streams have very high internal redundancy (mesh.* all look like {raw_bytes, compressed_bytes, ratio}, air.* all look like {ratio, atom_count, ...}).

## Pass criterion
PASS if plait encoding (strand-id seq + per-strand streams, all brotli'd) + lossless roundtrip beats Experiment 01's full-corpus 16.56×.
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts`);

// ─── Split into strands by action prefix (before the dot) ───────────────────
function strandOf(action) {
  const i = action.indexOf('.');
  return i >= 0 ? action.slice(0, i) : action;
}
const strandSeq = receipts.map(r => strandOf(r.action));
const strandVocab = new Map();
for (const s of strandSeq) if (!strandVocab.has(s)) strandVocab.set(s, strandVocab.size);
const strandNames = [...strandVocab.keys()];
console.log(`\nStrands found: ${strandNames.length}`);
for (const s of strandNames) {
  const count = strandSeq.filter(x => x === s).length;
  console.log(`  strand "${s}": ${count} receipts (${(count / receipts.length * 100).toFixed(1)}%)`);
}

// ─── Per-strand receipt lists ───────────────────────────────────────────────
const strandStreams = new Map();
for (const s of strandNames) strandStreams.set(s, []);
for (let i = 0; i < receipts.length; i++) {
  strandStreams.get(strandSeq[i]).push(receipts[i]);
}

function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

// ─── Encode: strand-id sequence + per-strand JSONL streams ──────────────────
const out = [];
// Header: receipts.length, strands.length, strand-vocab, then per-strand stream
out.push(varint(receipts.length));
out.push(varint(strandNames.length));
for (const s of strandNames) out.push(...writeStr(s));
// Strand-id sequence (varint per receipt)
for (let i = 0; i < receipts.length; i++) out.push(varint(strandVocab.get(strandSeq[i])));
// Per-strand JSONL streams
for (const s of strandNames) {
  const stream = strandStreams.get(s);
  const jsonl = stream.map(r => JSON.stringify(r)).join('\n') + (stream.length ? '\n' : '');
  const bytes = Buffer.from(jsonl, 'utf8');
  out.push(varint(bytes.length));
  out.push(bytes);
}
const plaitStream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(plaitStream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
console.log(`\nPlait stream pre-brotli: ${plaitStream.length} bytes`);
console.log(`Plait + brotli q11:      ${brotli.length} bytes`);
const ratio = corpusBytes.length / brotli.length;
console.log(`Compression ratio:        ${ratio.toFixed(2)}x  (vs raw corpus ${corpusBytes.length} bytes)`);

// Per-strand brotli sizes (analysis only)
console.log(`\nPer-strand brotli analysis:`);
for (const s of strandNames) {
  const jsonl = strandStreams.get(s).map(r => JSON.stringify(r)).join('\n') + (strandStreams.get(s).length ? '\n' : '');
  const rawBytes = Buffer.byteLength(jsonl);
  const stBr = zlib.brotliCompressSync(Buffer.from(jsonl), { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }).length;
  const stRatio = rawBytes / stBr;
  console.log(`  ${s.padEnd(16)} raw=${String(rawBytes).padStart(7)} brotli=${String(stBr).padStart(6)} = ${stRatio.toFixed(2)}x`);
}

// ─── Lossless roundtrip ─────────────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let pp = 0;
let v;
[v, pp] = readVarint(dec, pp); const dRec = v;
[v, pp] = readVarint(dec, pp); const dNStrands = v;
const dStrandNames = [];
for (let i = 0; i < dNStrands; i++) {
  let len; [len, pp] = readVarint(dec, pp);
  dStrandNames.push(dec.slice(pp, pp + len).toString('utf8'));
  pp += len;
}
const dStrandSeq = [];
for (let i = 0; i < dRec; i++) { [v, pp] = readVarint(dec, pp); dStrandSeq.push(dStrandNames[v]); }
const dStrandQueues = new Map();
for (const s of dStrandNames) {
  let len; [len, pp] = readVarint(dec, pp);
  const txt = dec.slice(pp, pp + len).toString('utf8');
  pp += len;
  dStrandQueues.set(s, txt.split('\n').filter(Boolean).map(l => JSON.parse(l)));
}
const reconstructed = [];
const cursors = new Map(dStrandNames.map(s => [s, 0]));
for (let i = 0; i < dRec; i++) {
  const sName = dStrandSeq[i];
  const q = dStrandQueues.get(sName);
  reconstructed.push(q[cursors.get(sName)]);
  cursors.set(sName, cursors.get(sName) + 1);
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const roundtripOk = recSha === corpusSha;
console.log(`\nRoundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);

const receipt = {
  experiment: '07-plait-braid',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  corpus_bytes_in: corpusBytes.length,
  strand_count: strandNames.length,
  strand_distribution: Object.fromEntries(strandNames.map(s => [s, strandStreams.get(s).length])),
  plait_stream_bytes: plaitStream.length,
  plait_brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  pass: roundtripOk && ratio > 16.56,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 07 — Plait / Braid Encoding — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Strand decomposition

${strandNames.length} distinct strands (engines):

${strandNames.map(s => `- \`${s}\` × ${strandStreams.get(s).length.toLocaleString()} receipts (${(strandStreams.get(s).length / receipts.length * 100).toFixed(1)}%)`).join('\n')}

## Compression measurement

| Metric | Value |
|---|---|
| Raw corpus bytes | ${corpusBytes.length.toLocaleString()} |
| Plait stream pre-brotli | ${plaitStream.length.toLocaleString()} |
| Plait + Brotli q11 | ${brotli.length.toLocaleString()} |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Lossless roundtrip | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `Plait encoding beats Experiment 01's 16.56× full-corpus spike baseline. Splitting by strand (engine family) lets brotli find massive redundancy within each strand — mesh.* receipts all share the same JSON shape, air.* receipts share theirs, etc. The strand-id index sequence is itself small (varint per receipt).` :
  `Plait encoding at ${ratio.toFixed(2)}× does NOT beat Experiment 01's 16.56×. The strand-id index sequence + per-strand JSONL overhead may exceed savings from per-strand homogeneity; brotli already finds the same cross-strand redundancy in the joint stream when LZ77 windows are large enough.`}

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/07-plait-braid/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
