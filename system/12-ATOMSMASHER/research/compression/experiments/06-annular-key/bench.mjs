// Experiment 06 — Annular Key (frequency-ring Huffman entropy code)
//
// Celtic annular keys nest concentric rings of decreasing detail outward.
// Apply to actions: sort distinct actions by frequency, assign shortest codes
// to most-frequent (inner ring), longest to rare (outer ring). This is exactly
// canonical Huffman coding but framed as the annular-key construction.

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
  fs.writeFileSync(HYP, `# Experiment 06 — Annular Key (frequency-ring Huffman code)

## Hypothesis
Celtic annular key patterns place high-frequency motifs at the center and rare motifs at the periphery. Information-theoretically this is Huffman coding: assign shortest codes to most-frequent symbols. Apply directly to the action vocabulary.

## Predicted ratio
4–15× on the action stream. Huffman approaches the Shannon entropy of the distribution.

## Pass criterion
PASS if Huffman-coded action stream + roundtrip lossless beats per-byte brotli on the same column.
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const actions = receipts.map(r => r.action);
console.log(`Loaded ${actions.length} actions`);

// ─── Frequency ring analysis ────────────────────────────────────────────────
const freq = new Map();
for (const a of actions) freq.set(a, (freq.get(a) || 0) + 1);
const sorted = [...freq.entries()].sort((a, b) => b[1] - a[1]);
console.log(`\nFrequency rings (top 10):`);
for (let i = 0; i < Math.min(10, sorted.length); i++) {
  console.log(`  ring ${i+1}: ${sorted[i][0]} → ${sorted[i][1]} (${(sorted[i][1] / actions.length * 100).toFixed(1)}%)`);
}
const distinct = sorted.length;
// Shannon entropy bound
let H = 0;
for (const [, c] of sorted) {
  const p = c / actions.length;
  H -= p * Math.log2(p);
}
console.log(`\nShannon entropy: ${H.toFixed(3)} bits/symbol  (corpus floor = ${(H * actions.length / 8).toFixed(0)} bytes)`);

// ─── Build canonical Huffman codes ──────────────────────────────────────────
class Node { constructor(s, f, l, r) { this.s = s; this.f = f; this.l = l; this.r = r; } }
const heap = sorted.map(([s, f]) => new Node(s, f));
heap.sort((a, b) => a.f - b.f);
while (heap.length > 1) {
  const a = heap.shift(), b = heap.shift();
  const n = new Node(null, a.f + b.f, a, b);
  // insert in sorted order
  let i = 0;
  while (i < heap.length && heap[i].f < n.f) i++;
  heap.splice(i, 0, n);
}
const root = heap[0];
const codes = new Map();
function walk(n, code) {
  if (n.s !== null) { codes.set(n.s, code || '0'); return; }
  walk(n.l, code + '0');
  walk(n.r, code + '1');
}
walk(root, '');
const avgCodeLen = [...codes.entries()].reduce((s, [k, v]) => s + v.length * freq.get(k), 0) / actions.length;
console.log(`Average Huffman code length: ${avgCodeLen.toFixed(3)} bits/symbol`);

// ─── Encode the action stream as a bit-packed Huffman code ──────────────────
let bits = '';
for (const a of actions) bits += codes.get(a);
// Pad to byte boundary
const padBits = (8 - (bits.length % 8)) % 8;
bits += '0'.repeat(padBits);
const huffBytes = new Uint8Array(bits.length / 8);
for (let i = 0; i < bits.length; i += 8) {
  huffBytes[i / 8] = parseInt(bits.slice(i, i + 8), 2);
}
const huffBuffer = Buffer.from(huffBytes);
console.log(`Huffman-coded actions: ${huffBuffer.length} bytes (raw bits ${bits.length - padBits})`);

// ─── Pack code table for storage ────────────────────────────────────────────
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

const tableOut = [];
tableOut.push(varint(actions.length));
tableOut.push(varint(codes.size));
for (const [sym, code] of codes.entries()) {
  tableOut.push(...writeStr(sym));
  tableOut.push(...writeStr(code));
}
tableOut.push(varint(padBits));
tableOut.push(varint(huffBuffer.length));
tableOut.push(huffBuffer);

const annularStream = Buffer.concat(tableOut);
const brotli = zlib.brotliCompressSync(annularStream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

const rawActionStream = Buffer.from(actions.join('\n') + '\n');
const baselineBrotli = zlib.brotliCompressSync(rawActionStream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const ratio = rawActionStream.length / brotli.length;
const baselineRatio = rawActionStream.length / baselineBrotli.length;
console.log(`\nAnnular-key + brotli:    ${brotli.length} bytes (${ratio.toFixed(2)}x)`);
console.log(`Baseline brotli (raw):   ${baselineBrotli.length} bytes (${baselineRatio.toFixed(2)}x)`);

// ─── Lossless roundtrip ─────────────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const recCount = v;
[v, p] = readVarint(dec, p); const codeCount = v;
const decCodes = new Map();
for (let i = 0; i < codeCount; i++) {
  let symLen; [symLen, p] = readVarint(dec, p);
  const sym = dec.slice(p, p + symLen).toString('utf8'); p += symLen;
  let codeLen; [codeLen, p] = readVarint(dec, p);
  const code = dec.slice(p, p + codeLen).toString('utf8'); p += codeLen;
  decCodes.set(code, sym);
}
let dPad; [dPad, p] = readVarint(dec, p);
let bufLen; [bufLen, p] = readVarint(dec, p);
const bitStr = [...dec.slice(p, p + bufLen)].map(b => b.toString(2).padStart(8, '0')).join('').slice(0, -dPad || undefined);
const decoded = [];
let cur = '';
let recIdx = 0;
for (let i = 0; i < bitStr.length; i++) {
  cur += bitStr[i];
  if (decCodes.has(cur)) {
    decoded.push(decCodes.get(cur));
    cur = '';
    if (++recIdx >= recCount) break;
  }
}

const recStream = decoded.join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recStream).digest('hex');
const origSha = crypto.createHash('sha256').update(rawActionStream).digest('hex');
const roundtripOk = recSha === origSha;
console.log(`\nRoundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);

const receipt = {
  experiment: '06-annular-key',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  distinct_actions: distinct,
  shannon_entropy_bits: Number(H.toFixed(3)),
  avg_huffman_code_bits: Number(avgCodeLen.toFixed(3)),
  raw_action_stream_bytes: rawActionStream.length,
  huffman_packed_bytes: huffBuffer.length,
  annular_stream_bytes: annularStream.length,
  annular_brotli_bytes: brotli.length,
  baseline_brotli_bytes: baselineBrotli.length,
  baseline_ratio: Number(baselineRatio.toFixed(2)),
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  pass: roundtripOk && ratio > baselineRatio,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 06 — Annular Key (frequency-ring Huffman) — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : '❌ FAIL'}
**Generated:** ${receipt.generated_at}

## Frequency rings (top 5)

| Ring | Action | Count | % |
|---|---|---|---|
${sorted.slice(0, 5).map((s, i) => `| ${i+1} | ${s[0]} | ${s[1].toLocaleString()} | ${(s[1] / actions.length * 100).toFixed(1)}% |`).join('\n')}

## Information theory

| Metric | Value |
|---|---|
| Distinct actions | ${distinct} |
| Shannon entropy | ${H.toFixed(3)} bits/symbol |
| Avg Huffman code | ${avgCodeLen.toFixed(3)} bits/symbol |
| Entropy efficiency | ${(H / avgCodeLen * 100).toFixed(2)}% |

## Compression measurement (action column)

| Metric | Value |
|---|---|
| Raw action stream | ${rawActionStream.length.toLocaleString()} B |
| Baseline brotli q11 | ${baselineBrotli.length.toLocaleString()} B (${baselineRatio.toFixed(2)}×) |
| Huffman packed (no brotli) | ${huffBuffer.length.toLocaleString()} B |
| Annular + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Compression ratio** | **${ratio.toFixed(2)}×** |
| Lossless roundtrip | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `Annular Huffman code achieves ${ratio.toFixed(2)}× on the action stream, beating per-byte brotli (${baselineRatio.toFixed(2)}×). Average code length (${avgCodeLen.toFixed(2)} bits) is within ${((avgCodeLen - H) / H * 100).toFixed(2)}% of the Shannon entropy floor (${H.toFixed(2)} bits) — near-optimal symbol coding.` :
  `Annular Huffman achieves ${ratio.toFixed(2)}× but does NOT beat per-byte brotli (${baselineRatio.toFixed(2)}×) on this column. The action vocabulary distribution is fitting brotli's LZ77 matcher cleanly, and the explicit code-table overhead in the annular encoding offsets the Huffman win.`}

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/06-annular-key/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
