// Experiment 39 — Method 6: hybrid codec
//
// mesh.compress is special-cased: 1 template + (raw_bytes, comp_bytes) varint pairs.
// Ratio is derived via banker's rounding on decode.
// All other receipts go through Method 1 shape-dedupe.
// Verify byte-exact lossless against det-corpus.

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

const SEED = 'orange5-receipt-stream-v1';
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
function brotli11(b) { return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }); }
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }
function readVarintU(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function bankerRound(x) {
  const floor = Math.floor(x);
  const frac = x - floor;
  if (Math.abs(frac - 0.5) < 1e-9) return floor + (floor % 2);
  return Math.round(x);
}
function computeRatio(raw, comp) { return bankerRound((raw/comp) * 100) / 100; }

const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');
console.log(`Det-ID corpus: ${detBytes.length} B`);

// ── Extract mesh.compress receipts and their (raw, comp) ─────────────────
// Original mesh.compress: created_at + summary + payload pattern
// The summary template is "compressed bytes for prefix X" or similar. Let me check.

const meshIdx = [], otherIdx = [];
const meshPairs = [];  // [raw, comp] per mesh.compress receipt, in original order
const meshSummaries = []; // summary text per mesh.compress receipt
const meshCAs = []; // created_at per mesh.compress receipt
let meshTemplate = null;  // canonical template for mesh.compress payload

for (let i = 0; i < N; i++) {
  if (detReceipts[i].action === 'mesh.compress') {
    meshIdx.push(i);
    try {
      const p = JSON.parse(detReceipts[i].payload_json);
      meshPairs.push([p.raw_bytes, p.compressed_bytes]);
      meshSummaries.push(detReceipts[i].summary);
      meshCAs.push(detReceipts[i].created_at);
      // Capture the canonical template from the first mesh.compress
      if (meshTemplate === null) {
        meshTemplate = {
          status: detReceipts[i].status,
          // Extract template by replacing the numerics; for summary, save raw and templatize on decode
        };
      }
    } catch {}
  } else {
    otherIdx.push(i);
  }
}
console.log(`mesh.compress: ${meshIdx.length}`);
console.log(`other receipts: ${otherIdx.length}`);

// Mesh summary patterns: check if all the same modulo numbers
const NUM_RE = /-?\d+(?:\.\d+)?/g;
const meshSumTpls = meshSummaries.map(s => s == null ? null : s.replace(NUM_RE, '\x01'));
const distinctMeshSumTpls = new Set(meshSumTpls);
console.log(`Distinct mesh summary templates: ${distinctMeshSumTpls.size}`);

// Mesh summary numeric residuals
const meshSumNums = meshSummaries.map(s => s == null ? [] : (s.match(NUM_RE) || []));

// Mesh CA stream
const caVocab = new Map();
for (const ca of meshCAs) if (!caVocab.has(ca)) caVocab.set(ca, caVocab.size);
const meshCAIdx = meshCAs.map(c => caVocab.get(c));

// ── Build the mesh.compress encoded blob ─────────────────────────────────
// Single template for mesh.compress (since distinct summary templates may be small)
// Components:
//   1. Single mesh shape template (status + payload_tpl + summary_tpl + ca_dict)
//   2. (raw, comp) pairs varint
//   3. Summary numeric residuals (per receipt)
//   4. ca_idx sequence
//   5. mesh_idx positions in original corpus (sparse) — for reconstruction order

// Mesh template canonical form
const meshTplObj = {
  status: detReceipts[meshIdx[0]].status,
  summary_tpls: [...distinctMeshSumTpls],  // list, indexed by sum_tpl_idx
  payload_keys: ['raw_bytes', 'compressed_bytes', 'ratio'],
};
const meshTplBytes = Buffer.from(JSON.stringify(meshTplObj), 'utf8');

// Summary template index per receipt
const meshSumTplMap = new Map();
[...distinctMeshSumTpls].forEach((t, i) => meshSumTplMap.set(t, i));
const meshSumTplIdx = meshSumTpls.map(t => meshSumTplMap.get(t));

// Mesh data stream: for each mesh receipt: [sum_tpl_idx, sum_num_count, sum_nums..., raw, comp, ca_idx]
const meshDataBytes = [];
for (let j = 0; j < meshIdx.length; j++) {
  meshDataBytes.push(...varintU(meshSumTplIdx[j]));
  meshDataBytes.push(...varintU(meshSumNums[j].length));
  for (const n of meshSumNums[j]) {
    const nb = Buffer.from(n, 'utf8');
    meshDataBytes.push(...varintU(nb.length));
    for (const c of nb) meshDataBytes.push(c);
  }
  meshDataBytes.push(...varintU(meshPairs[j][0]));
  meshDataBytes.push(...varintU(meshPairs[j][1]));
  meshDataBytes.push(...varintU(meshCAIdx[j]));
}
const meshData = Buffer.from(meshDataBytes);

// Mesh CA dict
const caDictBytes = Buffer.from([...caVocab.keys()].join('\x02'), 'utf8');

// Brotli the components
const meshTplBr = brotli11(meshTplBytes);
const meshDataBr = brotli11(meshData);
const caDictBr = brotli11(caDictBytes);

console.log(`\nmesh.compress components:`);
console.log(`  template:    ${meshTplBr.length} B (raw ${meshTplBytes.length})`);
console.log(`  data stream: ${meshDataBr.length} B (raw ${meshData.length})`);
console.log(`  CA dict:     ${caDictBr.length} B (raw ${caDictBytes.length})`);

// ── Build the other-receipts shape dedupe ──────────────────────────────
const otherReceipts = otherIdx.map(i => detReceipts[i]);
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const shapeVocab = new Map();
const shapeList = [];
const otherShapeIdx = [];
for (const r of otherReceipts) {
  const k = shapeKey(r);
  if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
  otherShapeIdx.push(shapeVocab.get(k));
}
console.log(`\nOther-receipts unique shapes: ${shapeList.length}`);
const shapesBr = brotli11(Buffer.from(shapeList.join('\n') + '\n', 'utf8'));
const otherIdxBr = brotli11(Buffer.from(otherShapeIdx.flatMap(varintU)));

// ── Position map: bitmap of mesh-vs-other positions ──────────────────────
// For each of N positions, is it mesh.compress (1) or other (0)?
const posBitmap = new Uint8Array(Math.ceil(N / 8));
for (const i of meshIdx) posBitmap[i >> 3] |= 1 << (7 - (i & 7));
const posBr = brotli11(Buffer.from(posBitmap));

// Seed
const seedR = brotli11(Buffer.from(JSON.stringify({seed: SEED, n: N}), 'utf8'));

const total = meshTplBr.length + meshDataBr.length + caDictBr.length + shapesBr.length + otherIdxBr.length + posBr.length + seedR.length;
const ratio = detBytes.length / total;
console.log(`\n=== METHOD 6: hybrid (mesh-decomp + others-dedupe) ===`);
console.log(`mesh template:   ${meshTplBr.length}`);
console.log(`mesh data:       ${meshDataBr.length}`);
console.log(`mesh CA dict:    ${caDictBr.length}`);
console.log(`other shapes:    ${shapesBr.length}`);
console.log(`other shape idx: ${otherIdxBr.length}`);
console.log(`position bitmap: ${posBr.length}`);
console.log(`seed:            ${seedR.length}`);
console.log(`TOTAL:           ${total} B`);
console.log(`Ratio:           ${ratio.toFixed(2)}x`);
console.log(`vs Method 5 (35.12x): ${ratio > 35.12 ? `BEATS by +${(ratio-35.12).toFixed(2)}x` : `below by ${(35.12-ratio).toFixed(2)}x`}`);

// ── ROUNDTRIP ──────────────────────────────────────────────────────────
// Decode all components
const meshTplDec = JSON.parse(zlib.brotliDecompressSync(meshTplBr).toString('utf8'));
const caDictDec = zlib.brotliDecompressSync(caDictBr).toString('utf8').split('\x02');
const meshDataDec = zlib.brotliDecompressSync(meshDataBr);
const shapesDec = zlib.brotliDecompressSync(shapesBr).toString('utf8').split('\n').filter(Boolean);
const otherIdxDec = (() => {
  const r = []; let o = 0; const b = Buffer.from(otherShapeIdx.flatMap(varintU));
  while (o < b.length) { const [v, n] = readVarintU(b, o); r.push(v); o = n; } return r;
})();
const posBitmapDec = zlib.brotliDecompressSync(posBr);
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

// Parse meshDataDec
const meshRecv = [];
let ofs = 0;
for (let j = 0; j < meshIdx.length; j++) {
  const [sumTplIdx, n1] = readVarintU(meshDataDec, ofs); ofs = n1;
  const [sumNumCount, n2] = readVarintU(meshDataDec, ofs); ofs = n2;
  const sumNums = [];
  for (let k = 0; k < sumNumCount; k++) {
    const [slen, n3] = readVarintU(meshDataDec, ofs); ofs = n3;
    sumNums.push(meshDataDec.slice(ofs, ofs + slen).toString('utf8'));
    ofs += slen;
  }
  const [raw, n4] = readVarintU(meshDataDec, ofs); ofs = n4;
  const [comp, n5] = readVarintU(meshDataDec, ofs); ofs = n5;
  const [caIdx, n6] = readVarintU(meshDataDec, ofs); ofs = n6;
  meshRecv.push({ sumTplIdx, sumNums, raw, comp, caIdx });
}

// Reconstruct: walk positions, for each position decide mesh-or-other, fill from streams
const reconstructed = [];
let meshCursor = 0, otherCursor = 0;
for (let i = 0; i < N; i++) {
  const isMesh = (posBitmapDec[i >> 3] >> (7 - (i & 7))) & 1;
  if (isMesh) {
    const m = meshRecv[meshCursor++];
    // Reconstruct summary
    let summaryTpl = meshTplDec.summary_tpls[m.sumTplIdx];
    if (summaryTpl == null) summaryTpl = null;
    let summary = null;
    if (summaryTpl !== null) {
      let ni = 0;
      summary = summaryTpl.replace(/\x01/g, () => m.sumNums[ni++]);
    }
    // Reconstruct payload_json
    const ratioVal = computeRatio(m.raw, m.comp);
    const payload = { raw_bytes: m.raw, compressed_bytes: m.comp, ratio: ratioVal };
    const ca = caDictDec[m.caIdx];
    reconstructed.push({
      id: detId(seedDec.seed, i),
      action: 'mesh.compress',
      status: meshTplDec.status,
      summary,
      payload_json: JSON.stringify(payload),
      created_at: ca,
    });
  } else {
    const shape = JSON.parse(shapesDec[otherIdxDec[otherCursor++]]);
    shape.id = detId(seedDec.seed, i);
    reconstructed.push(shape);
  }
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT vs det' : '✗ MISMATCH'}`);
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`  First diff at byte ${i}:`);
      console.log(`    det: ...${det.slice(Math.max(0, i-100), i+100)}...`);
      console.log(`    rec: ...${recJsonl.slice(Math.max(0, i-100), i+100)}...`);
      break;
    }
  }
}

const out = {
  experiment: '39-method6-hybrid',
  generated_at: new Date().toISOString(),
  mesh_count: meshIdx.length,
  other_count: otherIdx.length,
  other_unique_shapes: shapeList.length,
  distinct_mesh_summary_templates: distinctMeshSumTpls.size,
  components: {
    mesh_template: meshTplBr.length,
    mesh_data: meshDataBr.length,
    mesh_ca_dict: caDictBr.length,
    other_shapes: shapesBr.length,
    other_idx: otherIdxBr.length,
    position_bitmap: posBr.length,
    seed: seedR.length,
  },
  total,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: lossless,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(out, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
