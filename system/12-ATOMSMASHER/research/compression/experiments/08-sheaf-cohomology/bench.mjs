// Experiment 08 — Čech-Closure Sheaf Cohomology Approximation
//
// Grounded in Rieser arXiv:2109.13867v2 — sheaf theory on graphs/digraphs.
// Build receipts as a Čech closure space; equivalence edges via shared
// payload_pattern (the "interior" relation). Connected components in this
// closure are H^0 of the constant sheaf: the global sections / shared substrate.
//
// Compression:
//   - Store one representative payload per H^0 component
//   - Store per-receipt component_id (varint)
//   - Per-receipt non-shared residual (id, summary, action, ts)
//   - Brotli final layer
//
// Lossless via component-lookup + residual reconstruction.

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
  fs.writeFileSync(HYP, `# Experiment 08 — Čech-Closure Sheaf Cohomology Approximation

## Hypothesis
Following Rieser (arXiv:2109.13867v2), build a Čech closure space on the receipts. Edges are payload_pattern equivalence (interior cover). Connected components = H^0(G; constant sheaf) = the global sections / "what is invariantly shared." Encode as (component representatives, per-receipt component_id, per-receipt non-shared residual). Brotli final.

## Predicted ratio
Higher than payload-dedup ratio (2.03× standalone) because we group ALL receipt fields by component, not just payload bytes.

## Pass criterion
PASS if total compound (with brotli) beats Experiment 07 plait/braid baseline (18.05× full corpus).
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts, ${corpusBytes.length} B`);

// ─── Build Čech closure: equivalence by payload_pattern hash ────────────────
function payloadHash(r) {
  return crypto.createHash('sha256').update(String(r.payload_json || '')).digest('hex').slice(0, 16);
}
const phashes = receipts.map(payloadHash);

// Union-Find for fast connected-component computation
class UnionFind {
  constructor(n) { this.parent = new Int32Array(n); for (let i = 0; i < n; i++) this.parent[i] = i; this.rank = new Int8Array(n); }
  find(x) { while (this.parent[x] !== x) { this.parent[x] = this.parent[this.parent[x]]; x = this.parent[x]; } return x; }
  union(x, y) { const rx = this.find(x), ry = this.find(y); if (rx === ry) return; if (this.rank[rx] < this.rank[ry]) this.parent[rx] = ry; else if (this.rank[rx] > this.rank[ry]) this.parent[ry] = rx; else { this.parent[ry] = rx; this.rank[rx]++; } }
}
const uf = new UnionFind(receipts.length);
// Add edges for receipts with identical payload_pattern hash
const hashToFirstIdx = new Map();
for (let i = 0; i < receipts.length; i++) {
  const h = phashes[i];
  if (hashToFirstIdx.has(h)) uf.union(i, hashToFirstIdx.get(h));
  else hashToFirstIdx.set(h, i);
}

// Compute components
const componentOf = new Int32Array(receipts.length);
const componentRep = new Map(); // component_root → component_id
const componentReceipts = new Map(); // component_id → first-receipt-index (representative)
for (let i = 0; i < receipts.length; i++) {
  const root = uf.find(i);
  if (!componentRep.has(root)) {
    const cid = componentRep.size;
    componentRep.set(root, cid);
    componentReceipts.set(cid, i);
  }
  componentOf[i] = componentRep.get(root);
}
const numComponents = componentRep.size;
console.log(`\nČech closure components: ${numComponents} of ${receipts.length} receipts`);
console.log(`Compression-via-H^0:     ${(receipts.length / numComponents).toFixed(2)}x equivalence-class collapse`);
console.log(`Largest 5 component sizes:`);
const compSizes = new Array(numComponents).fill(0);
for (let i = 0; i < receipts.length; i++) compSizes[componentOf[i]]++;
const sorted = [...compSizes.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5);
for (const [cid, sz] of sorted) console.log(`  C${cid}: ${sz} receipts`);

// ─── Encode: vocab + components + per-receipt (component_id + residual) ─────
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

// Per-receipt residual fields (everything that is NOT the shared component payload)
const residualFields = ['id', 'action', 'status', 'summary', 'created_at'];
const fieldVocabs = Object.fromEntries(residualFields.map(f => [f, new Map()]));
function lookup(map, key) { let v = map.get(key); if (v === undefined) { v = map.size; map.set(key, v); } return v; }
for (const r of receipts) for (const f of residualFields) lookup(fieldVocabs[f], r[f] == null ? '\0NULL\0' : String(r[f]));

const out = [];
// Header
out.push(varint(receipts.length), varint(numComponents));
// Field vocabularies for residuals
out.push(varint(residualFields.length));
for (const f of residualFields) {
  out.push(...writeStr(f));
  out.push(varint(fieldVocabs[f].size));
  for (const v of fieldVocabs[f].keys()) out.push(...writeStr(v));
}
// Component representatives (payloads): one per component
for (let cid = 0; cid < numComponents; cid++) {
  const repIdx = componentReceipts.get(cid);
  const payload = String(receipts[repIdx].payload_json || '');
  const isNull = receipts[repIdx].payload_json == null ? 1 : 0;
  out.push(varint(isNull));
  out.push(...writeStr(payload));
}
// Per-receipt: component_id + residual field indices
for (const r of receipts) {
  out.push(varint(componentOf[receipts.indexOf(r)])); // O(n) — fix below
}
// Optimize: index map
const receiptIdx = new Map(receipts.map((r, i) => [r, i]));
// Rebuild last per-receipt section
const out2 = out.slice(0, out.length - receipts.length);
for (let i = 0; i < receipts.length; i++) out2.push(varint(componentOf[i]));
for (const r of receipts) {
  for (const f of residualFields) {
    const val = r[f] == null ? '\0NULL\0' : String(r[f]);
    out2.push(varint(fieldVocabs[f].get(val)));
  }
}

const stream = Buffer.concat(out2);
const brotli = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const ratio = corpusBytes.length / brotli.length;
console.log(`\nSheaf stream pre-brotli: ${stream.length} B`);
console.log(`Sheaf + brotli q11:      ${brotli.length} B`);
console.log(`Ratio vs raw corpus:     ${ratio.toFixed(2)}x`);

// ─── Lossless roundtrip ─────────────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const dN = v;
[v, p] = readVarint(dec, p); const dNumComp = v;
[v, p] = readVarint(dec, p); const fCount = v;
const dFields = [];
const dFieldVocabs = {};
for (let i = 0; i < fCount; i++) {
  let len; [len, p] = readVarint(dec, p);
  const f = dec.slice(p, p + len).toString('utf8'); p += len;
  dFields.push(f);
  let vSize; [vSize, p] = readVarint(dec, p);
  const inv = [];
  for (let j = 0; j < vSize; j++) {
    [len, p] = readVarint(dec, p);
    inv.push(dec.slice(p, p + len).toString('utf8'));
    p += len;
  }
  dFieldVocabs[f] = inv;
}
// Component payloads
const compPayloads = [];
for (let cid = 0; cid < dNumComp; cid++) {
  let isNull; [isNull, p] = readVarint(dec, p);
  let len; [len, p] = readVarint(dec, p);
  const payload = dec.slice(p, p + len).toString('utf8'); p += len;
  compPayloads.push(isNull ? null : payload);
}
// Per-receipt component ids
const dCompOf = new Int32Array(dN);
for (let i = 0; i < dN; i++) { [v, p] = readVarint(dec, p); dCompOf[i] = v; }
// Per-receipt residuals
const decoded = [];
for (let i = 0; i < dN; i++) {
  const r = {};
  for (const f of dFields) {
    [v, p] = readVarint(dec, p);
    const val = dFieldVocabs[f][v];
    r[f] = val === '\0NULL\0' ? null : val;
  }
  r.payload_json = compPayloads[dCompOf[i]];
  decoded.push({
    id: r.id,
    action: r.action,
    status: r.status,
    summary: r.summary,
    payload_json: r.payload_json,
    created_at: r.created_at,
  });
}

const decJsonl = decoded.map(r => JSON.stringify(r)).join('\n') + '\n';
const decSha = crypto.createHash('sha256').update(decJsonl).digest('hex');
const roundtripOk = decSha === corpusSha;
console.log(`Roundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);

const receipt = {
  experiment: '08-sheaf-cohomology',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  corpus_bytes_in: corpusBytes.length,
  num_receipts: receipts.length,
  num_components: numComponents,
  h0_dimension: numComponents,
  h0_collapse_ratio: Number((receipts.length / numComponents).toFixed(2)),
  largest_5_components: sorted.map(([cid, sz]) => ({ component_id: cid, size: sz })),
  field_vocab_sizes: Object.fromEntries(residualFields.map(f => [f, fieldVocabs[f].size])),
  sheaf_stream_bytes: stream.length,
  sheaf_brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  beats_plait_baseline: ratio > 18.05,
  pass: roundtripOk && ratio > 18.05,
  reference: 'Rieser 2025 arXiv:2109.13867v2 — Grothendieck topologies and sheaf theory for Čech closure spaces',
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 08 — Čech-Closure Sheaf Cohomology Approximation — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : roundtripOk ? '⚠️ LOSSLESS but below baseline' : '❌ FAIL (lossy)'}
**Generated:** ${receipt.generated_at}

## Method

Build the receipt corpus as a Čech closure space (Rieser 2025). Edges by payload_pattern equivalence; connected components = H^0(G; constant sheaf) = the "shared substrate."

Encode each H^0 component once + per-receipt (component_id, residual field indices). Brotli q11 final.

## Topology of the closure space

| Metric | Value |
|---|---|
| Vertices (receipts) | ${receipts.length.toLocaleString()} |
| H^0 components | ${numComponents.toLocaleString()} |
| **H^0 collapse ratio** | **${(receipts.length / numComponents).toFixed(2)}×** equivalence-class reduction |
| Largest component | C${sorted[0][0]}: ${sorted[0][1].toLocaleString()} receipts |
| 2nd largest | C${sorted[1][0]}: ${sorted[1][1].toLocaleString()} receipts |

## Compression

| Metric | Value |
|---|---|
| Raw corpus | ${corpusBytes.length.toLocaleString()} B |
| Sheaf stream pre-brotli | ${stream.length.toLocaleString()} B |
| Sheaf + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Ratio** | **${ratio.toFixed(2)}×** |
| Lossless | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `Sheaf-cohomology encoding beats Experiment 07 plait baseline (18.05×). H^0 has dimension ${numComponents} — meaning the receipt corpus collapses to ${numComponents} payload equivalence classes, ${(receipts.length / numComponents).toFixed(2)}× fewer than the raw count. Storing one representative per class + per-receipt residual + brotli reaches ${ratio.toFixed(2)}× total.` :
  roundtripOk ?
    `Sheaf encoding at ${ratio.toFixed(2)}× is lossless but does not beat Experiment 07 plait (18.05×). H^0 collapse (${(receipts.length / numComponents).toFixed(2)}×) does extract real equivalence structure, but the per-receipt residual overhead (5 vocab indices × 6,224 receipts) exceeds the savings from payload-pattern sharing.` :
    `Lossy roundtrip — REJECT.`}

## Reference
Rieser, A. (2025). "Grothendieck Topologies and Sheaf Theory for Data and Graphs: An Approach Through Čech Closure Spaces." arXiv:2109.13867v2.

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/08-sheaf-cohomology/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
