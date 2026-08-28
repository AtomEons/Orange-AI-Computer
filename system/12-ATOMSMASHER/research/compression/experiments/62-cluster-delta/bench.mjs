// Experiment 62 — Cluster-prototype + delta encoding (lossless)
//
// Idea: 1,567 unique shapes have many near-duplicates (Jaccard 0.9 → 955 clusters).
// Encode each shape as (cluster_prototype_idx, delta_from_prototype).
// Verify byte-exact roundtrip.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
const SEED = 'orange5-receipt-stream-v1';

function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detBytes = Buffer.from(detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
const M19_BASELINE = 44095;

// Build the Method 19 shape dict (non-mesh, deduped, nested-payload, no id)
const meshIdx = [], otherIdx = [];
for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') meshIdx.push(i); else otherIdx.push(i);
}
const otherReceipts = otherIdx.map(i => {
  const r = detReceipts[i];
  const obj = { action: r.action, status: r.status, summary: r.summary };
  if (r.payload_json != null) { try { obj.payload = JSON.parse(r.payload_json); } catch { obj.payload_raw = r.payload_json; } } else obj.payload = null;
  obj.created_at = r.created_at;
  return obj;
});
const shapeKey = r => JSON.stringify(r);
const vocab = new Map();
const shapes = [];
const otherShapeIdx = [];
for (const r of otherReceipts) {
  const k = shapeKey(r);
  if (!vocab.has(k)) { vocab.set(k, shapes.length); shapes.push(k); }
  otherShapeIdx.push(vocab.get(k));
}
console.log(`Unique shapes: ${shapes.length}`);

// ── A: Build trigram fingerprints + greedy cluster ──
function trigramSet(s) {
  const set = new Set();
  for (let i = 0; i <= s.length - 3; i++) set.add(s.substr(i, 3));
  return set;
}
function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

const trigrams = shapes.map(trigramSet);
const cluster = new Array(shapes.length).fill(-1);
const clusterPrototype = [];

for (let i = 0; i < shapes.length; i++) {
  if (cluster[i] !== -1) continue;
  const cid = clusterPrototype.length;
  cluster[i] = cid;
  clusterPrototype.push(i);
  // Find others to join this cluster
  for (let j = i + 1; j < shapes.length; j++) {
    if (cluster[j] !== -1) continue;
    if (jaccard(trigrams[i], trigrams[j]) >= 0.9) cluster[j] = cid;
  }
}
console.log(`Clusters (Jaccard≥0.9): ${clusterPrototype.length}`);

// ── B: For each shape, compute delta from prototype ──
// Use simple common-prefix + common-suffix + middle-replacement
function delta(proto, target) {
  // Find common prefix
  let p = 0;
  const maxP = Math.min(proto.length, target.length);
  while (p < maxP && proto[p] === target[p]) p++;
  // Find common suffix
  let s = 0;
  const maxS = Math.min(proto.length - p, target.length - p);
  while (s < maxS && proto[proto.length - 1 - s] === target[target.length - 1 - s]) s++;
  // Middle differs
  const middle = target.slice(p, target.length - s);
  return { p, s, middle };  // prototype[p..proto.length-s] is replaced by `middle`
}
function applyDelta(proto, p, s, middle) {
  return proto.slice(0, p) + middle + proto.slice(proto.length - s);
}

// Compute deltas
const deltas = shapes.map((shape, i) => {
  const cid = cluster[i];
  const proto = shapes[clusterPrototype[cid]];
  if (i === clusterPrototype[cid]) return { cid, p: 0, s: 0, middle: '' }; // self
  return { cid, ...delta(proto, shape) };
});

// Stats: how much do deltas save vs full shape?
let totalRawShapes = 0, totalDeltaBytes = 0;
for (let i = 0; i < shapes.length; i++) {
  totalRawShapes += shapes[i].length;
  // Delta cost: 3 varints (cid, p, s) + middle.length
  const d = deltas[i];
  totalDeltaBytes += varintU(d.cid).length + varintU(d.p).length + varintU(d.s).length + d.middle.length + 2; // +2 sentinel
}
console.log(`Total raw shapes: ${totalRawShapes} B`);
console.log(`Total delta-encoded shapes: ${totalDeltaBytes} B`);
console.log(`(prototype set has ${clusterPrototype.length} shapes that need full encoding)`);

let prototypeRawBytes = 0;
for (const pi of clusterPrototype) prototypeRawBytes += shapes[pi].length;
console.log(`Prototype raw bytes: ${prototypeRawBytes} B`);

// ── C: Encode prototypes + deltas, brotli, measure ──
// Format:
//   - prototypes: joined by '\n', brotli'd
//   - deltas: for each shape, varint(cid) + varint(p) + varint(s) + varint(middle_len) + middle_bytes, brotli'd

const protoBlob = brotli11(brotli11(Buffer.from(clusterPrototype.map(pi => shapes[pi]).join('\n') + '\n', 'utf8')));
console.log(`\nPrototypes brotli x2: ${protoBlob.length} B`);

const deltaBytes = [];
for (const d of deltas) {
  deltaBytes.push(...varintU(d.cid));
  deltaBytes.push(...varintU(d.p));
  deltaBytes.push(...varintU(d.s));
  const midBuf = Buffer.from(d.middle, 'utf8');
  deltaBytes.push(...varintU(midBuf.length));
  for (const c of midBuf) deltaBytes.push(c);
}
const deltaBlob = brotli11(brotli11(Buffer.from(deltaBytes)));
console.log(`Deltas brotli x2: ${deltaBlob.length} B`);
console.log(`Total shape encoding: ${protoBlob.length + deltaBlob.length} B`);
console.log(`vs Method 19 shape blob: 30,057 B`);

// ── D: Roundtrip verify (just shapes, in isolation) ──
const protoDec = zlib.brotliDecompressSync(zlib.brotliDecompressSync(protoBlob)).toString('utf8').split('\n').filter(Boolean);
const deltaDec = zlib.brotliDecompressSync(zlib.brotliDecompressSync(deltaBlob));
const deltasOut = [];
{ let ofs = 0;
  while (ofs < deltaDec.length) {
    const [cid, n1] = readVarintU(deltaDec, ofs); ofs = n1;
    const [p, n2] = readVarintU(deltaDec, ofs); ofs = n2;
    const [s, n3] = readVarintU(deltaDec, ofs); ofs = n3;
    const [mlen, n4] = readVarintU(deltaDec, ofs); ofs = n4;
    const middle = deltaDec.slice(ofs, ofs + mlen).toString('utf8'); ofs += mlen;
    deltasOut.push({ cid, p, s, middle });
  } }

let mismatch = false;
const restoredShapes = [];
for (let i = 0; i < deltasOut.length; i++) {
  const d = deltasOut[i];
  const proto = protoDec[d.cid];
  const restored = applyDelta(proto, d.p, d.s, d.middle);
  restoredShapes.push(restored);
  if (restored !== shapes[i]) { mismatch = true; console.log(`MISMATCH at shape ${i}: cluster=${d.cid}\n  orig: ${shapes[i].slice(0, 200)}\n  rest: ${restored.slice(0, 200)}`); break; }
}
console.log(`Shape roundtrip: ${!mismatch ? '✓' : '✗'}`);

// Project: if I plug this into Method 19, what's the new total?
if (!mismatch) {
  const newM19 = M19_BASELINE - 30057 + (protoBlob.length + deltaBlob.length);
  console.log(`\nProjected Method 21 = Method 19 + cluster-delta: ${newM19} B = ${(detBytes.length / newM19).toFixed(3)}x`);
  if (newM19 < M19_BASELINE) console.log(`  BEATS Method 19 (47.071x) by +${(detBytes.length / newM19 - 47.071).toFixed(3)}x`);
  else console.log(`  loses to Method 19 by ${(47.071 - detBytes.length / newM19).toFixed(3)}x`);
}

fs.writeFileSync(RECEIPT_FILE, JSON.stringify({
  experiment: '62-cluster-delta',
  shapes: shapes.length,
  clusters: clusterPrototype.length,
  protoBlob: protoBlob.length,
  deltaBlob: deltaBlob.length,
  total: protoBlob.length + deltaBlob.length,
  m19_baseline_shapes: 30057,
  shape_roundtrip_lossless: !mismatch,
}, null, 2));
