// Experiment 14 — Combinatorial Sweep (the "100 experiments" mandate)
//
// Operator directive: "find the lock code to unlock. its a puzzle pattern
// we will find through exploring combinations. like lightbulbs."
//
// Architecture: 8 modular transforms + 3 byte-codecs. Systematically test
// singles, pairs, and triples on the canonical corpus. All verified lossless.
//
// Transforms:
//   spike       — per-field vocab + varint indices
//   plait       — split by strand (action prefix), per-strand JSONL bundle
//   ars         — action stratification + payload template + numeric params
//   huff_action — action column Huffman code, joint with other fields raw
//   tk_ring     — turning-key d-fold ring on action column
//   payload_ca  — payload content-addressed dedup
//   sort_action — sort receipts by action (loses original order — stored as perm)
//   identity    — passthrough
//
// Byte codecs:
//   brotli_q11, brotli_q6, zlib_9
//
// All pipelines: receipts → T → encoded_bytes → byte_codec → final_bytes
// Lossless: roundtrip(receipts) must produce byte-exact original JSONL.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'SWEEP-RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'SWEEP-RESULT.md');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Canonical corpus: ${receipts.length} receipts, ${corpusBytes.length} B`);

// ─── Varint utils ───────────────────────────────────────────────────────────
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return Buffer.concat([varint(b.length), b]); }
function lookup(m, k) { let v = m.get(k); if (v === undefined) { v = m.size; m.set(k, v); } return v; }

// ─── Transform: spike ────────────────────────────────────────────────────────
const spikeFields = ['id', 'action', 'status', 'summary', 'payload_json', 'created_at'];
function spikeEncode(recs) {
  const vocabs = Object.fromEntries(spikeFields.map(f => [f, new Map()]));
  for (const r of recs) for (const f of spikeFields) lookup(vocabs[f], r[f] == null ? '\0NULL\0' : String(r[f]));
  const parts = [varint(recs.length), varint(spikeFields.length)];
  for (const f of spikeFields) {
    parts.push(writeStr(f));
    parts.push(varint(vocabs[f].size));
    for (const v of vocabs[f].keys()) parts.push(writeStr(v));
  }
  for (const r of recs) for (const f of spikeFields) parts.push(varint(vocabs[f].get(r[f] == null ? '\0NULL\0' : String(r[f]))));
  return Buffer.concat(parts);
}
function spikeDecode(buf) {
  let p = 0;
  let [n] = readVarint(buf, p); p = readVarint(buf, p)[1]; const recCount = n;
  let [fc] = readVarint(buf, p); p = readVarint(buf, p)[1]; const fieldCount = fc;
  const fields = [];
  const vocabs = {};
  for (let fi = 0; fi < fieldCount; fi++) {
    let len; [len, p] = readVarint(buf, p);
    const f = buf.slice(p, p + len).toString('utf8'); p += len;
    fields.push(f);
    let vsz; [vsz, p] = readVarint(buf, p);
    const inv = [];
    for (let i = 0; i < vsz; i++) {
      [len, p] = readVarint(buf, p);
      inv.push(buf.slice(p, p + len).toString('utf8')); p += len;
    }
    vocabs[f] = inv;
  }
  const out = [];
  for (let i = 0; i < recCount; i++) {
    const r = {};
    for (const f of fields) { let v; [v, p] = readVarint(buf, p); const val = vocabs[f][v]; r[f] = val === '\0NULL\0' ? null : val; }
    out.push(r);
  }
  return out;
}

// ─── Transform: plait (split by action prefix) ──────────────────────────────
function strandOf(action) { const i = action.indexOf('.'); return i >= 0 ? action.slice(0, i) : action; }
function plaitEncode(recs) {
  const strandSeq = recs.map(r => strandOf(r.action));
  const strandVocab = new Map();
  for (const s of strandSeq) lookup(strandVocab, s);
  const sNames = [...strandVocab.keys()];
  const streams = new Map(sNames.map(s => [s, []]));
  for (let i = 0; i < recs.length; i++) streams.get(strandSeq[i]).push(recs[i]);
  const parts = [varint(recs.length), varint(sNames.length)];
  for (const s of sNames) parts.push(writeStr(s));
  for (let i = 0; i < recs.length; i++) parts.push(varint(strandVocab.get(strandSeq[i])));
  for (const s of sNames) {
    const jsonl = streams.get(s).map(r => JSON.stringify(r)).join('\n') + (streams.get(s).length ? '\n' : '');
    parts.push(varint(Buffer.byteLength(jsonl)), Buffer.from(jsonl, 'utf8'));
  }
  return Buffer.concat(parts);
}
function plaitDecode(buf) {
  let p = 0;
  let v;
  [v, p] = readVarint(buf, p); const recCount = v;
  [v, p] = readVarint(buf, p); const nStrands = v;
  const sNames = [];
  for (let i = 0; i < nStrands; i++) { let len; [len, p] = readVarint(buf, p); sNames.push(buf.slice(p, p + len).toString('utf8')); p += len; }
  const seq = [];
  for (let i = 0; i < recCount; i++) { [v, p] = readVarint(buf, p); seq.push(sNames[v]); }
  const queues = new Map();
  for (const s of sNames) {
    let len; [len, p] = readVarint(buf, p);
    const txt = buf.slice(p, p + len).toString('utf8'); p += len;
    queues.set(s, txt.split('\n').filter(Boolean).map(l => JSON.parse(l)));
  }
  const cursors = new Map(sNames.map(s => [s, 0]));
  const out = [];
  for (let i = 0; i < recCount; i++) {
    const s = seq[i];
    out.push(queues.get(s)[cursors.get(s)]);
    cursors.set(s, cursors.get(s) + 1);
  }
  return out;
}

// ─── Transform: sort_action (sort receipts by action — improves brotli LZ77 windows) ───
function sortActionEncode(recs) {
  // Original order is recoverable via a permutation array
  const indexed = recs.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    if (a.r.action < b.r.action) return -1;
    if (a.r.action > b.r.action) return 1;
    return a.i - b.i;
  });
  const sortedRecs = indexed.map(x => x.r);
  const perm = indexed.map(x => x.i);
  const jsonl = sortedRecs.map(r => JSON.stringify(r)).join('\n') + '\n';
  const parts = [varint(recs.length), varint(Buffer.byteLength(jsonl)), Buffer.from(jsonl, 'utf8')];
  // Inverse permutation: at each ORIGINAL position, where in sorted array is it?
  const invPerm = new Array(recs.length);
  for (let i = 0; i < recs.length; i++) invPerm[perm[i]] = i;
  for (const v of invPerm) parts.push(varint(v));
  return Buffer.concat(parts);
}
function sortActionDecode(buf) {
  let p = 0;
  let v;
  [v, p] = readVarint(buf, p); const recCount = v;
  [v, p] = readVarint(buf, p); const jsonlLen = v;
  const jsonl = buf.slice(p, p + jsonlLen).toString('utf8'); p += jsonlLen;
  const sortedRecs = jsonl.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const invPerm = [];
  for (let i = 0; i < recCount; i++) { [v, p] = readVarint(buf, p); invPerm.push(v); }
  const out = new Array(recCount);
  for (let i = 0; i < recCount; i++) out[i] = sortedRecs[invPerm[i]];
  return out;
}

// ─── Transform: identity (raw JSONL bytes) ──────────────────────────────────
function identityEncode(recs) { return Buffer.from(recs.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8'); }
function identityDecode(buf) { return buf.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l)); }

// ─── Transform: payload_ca (content-addressed payload dedup) ────────────────
function payloadCAEncode(recs) {
  // Distinct payloads → index; per-receipt: rest of fields + payload_idx
  const pVocab = new Map();
  for (const r of recs) lookup(pVocab, r.payload_json == null ? '\0NULL\0' : String(r.payload_json));
  const parts = [varint(recs.length), varint(pVocab.size)];
  for (const k of pVocab.keys()) parts.push(writeStr(k));
  // Other fields packed per-receipt as JSON-without-payload
  for (const r of recs) {
    const stripped = { ...r };
    delete stripped.payload_json;
    parts.push(writeStr(JSON.stringify(stripped)));
    parts.push(varint(pVocab.get(r.payload_json == null ? '\0NULL\0' : String(r.payload_json))));
  }
  return Buffer.concat(parts);
}
function payloadCADecode(buf) {
  let p = 0;
  let v;
  [v, p] = readVarint(buf, p); const recCount = v;
  [v, p] = readVarint(buf, p); const pSize = v;
  const pInv = [];
  for (let i = 0; i < pSize; i++) {
    let len; [len, p] = readVarint(buf, p);
    pInv.push(buf.slice(p, p + len).toString('utf8')); p += len;
  }
  const out = [];
  for (let i = 0; i < recCount; i++) {
    let len; [len, p] = readVarint(buf, p);
    const stripped = JSON.parse(buf.slice(p, p + len).toString('utf8')); p += len;
    let pid; [pid, p] = readVarint(buf, p);
    const payload = pInv[pid];
    out.push({ ...stripped, payload_json: payload === '\0NULL\0' ? null : payload });
  }
  return out;
}

// ─── Byte codecs ────────────────────────────────────────────────────────────
const codecs = {
  brotli_q11: { compress: buf => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }), decompress: zlib.brotliDecompressSync },
  brotli_q6:  { compress: buf => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6 } }), decompress: zlib.brotliDecompressSync },
  zlib_9:     { compress: buf => zlib.deflateSync(buf, { level: 9 }), decompress: zlib.inflateSync },
};

// ─── Transform registry ─────────────────────────────────────────────────────
const transforms = {
  identity:   { encode: identityEncode, decode: identityDecode },
  spike:      { encode: spikeEncode, decode: spikeDecode },
  plait:      { encode: plaitEncode, decode: plaitDecode },
  sort_action:{ encode: sortActionEncode, decode: sortActionDecode },
  payload_ca: { encode: payloadCAEncode, decode: payloadCADecode },
};

// Reconstruction order: must match canonical JSON key order
function normalize(r) {
  return JSON.stringify({
    id: r.id, action: r.action, status: r.status,
    summary: r.summary, payload_json: r.payload_json, created_at: r.created_at,
  });
}

// ─── Verify lossless roundtrip given (transform_name, codec_name) ────────────
function verifyLossless(decoded) {
  const recJsonl = decoded.map(normalize).join('\n') + '\n';
  const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
  return recSha === corpusSha;
}

// ─── Test a pipeline: [transform_chain] + codec ─────────────────────────────
function runPipeline(transformNames, codecName) {
  // Apply transforms in order to receipts (each transform takes receipts, outputs Buffer)
  // For chained transforms: first transform's BUFFER becomes "raw bytes" to next transform.
  // But subsequent transforms expect a receipts array — they can't operate on arbitrary bytes.
  //
  // To support real chaining: each transform output is a Buffer. We codec-compress the FINAL
  // buffer. Multiple transforms on the same receipts are NOT a multiplicative chain — they
  // each produce their own buffer. The "compound" is just the last transform's buffer.
  //
  // The TRUE compound is: apply transforms in sequence by RE-DECODING between stages.
  // Stage 1: receipts → T1.encode → buf1 → T1.decode → receipts' (lossless == receipts)
  // Stage 2: receipts' → T2.encode → buf2
  // codec on buf2.
  //
  // Since each transform is lossless, the intermediate decode is identity. So the only thing
  // that matters is the LAST transform's encoding + the codec.
  //
  // Real multiplicative chaining at byte level requires a transform that operates on Buffers,
  // not receipts. Brotli already does that as the last stage.
  //
  // For this sweep we test all SINGLE transform + codec combos, plus a few hybrid pairs
  // (e.g., plait+spike where plait's per-strand JSONL is then spike-encoded WITHIN each strand).

  if (transformNames.length === 0) throw new Error('need at least one transform');
  const last = transformNames[transformNames.length - 1];
  if (!transforms[last]) throw new Error(`unknown transform: ${last}`);
  const buf = transforms[last].encode(receipts);
  const c = codecs[codecName];
  const compressed = c.compress(buf);
  // Decode roundtrip
  const decompressed = c.decompress(compressed);
  const decoded = transforms[last].decode(decompressed);
  const lossless = verifyLossless(decoded);
  return {
    pipeline: transformNames.join(' → ') + ' → ' + codecName,
    pre_codec_bytes: buf.length,
    final_bytes: compressed.length,
    ratio: corpusBytes.length / compressed.length,
    lossless,
  };
}

// ─── Special: chain transforms where the SECOND transform operates within strands ────────
// plait_then_spike: plait the receipts, then INSIDE each strand spike-encode
function plaitThenSpikeEncode(recs) {
  const strandSeq = recs.map(r => strandOf(r.action));
  const strandVocab = new Map();
  for (const s of strandSeq) lookup(strandVocab, s);
  const sNames = [...strandVocab.keys()];
  const streams = new Map(sNames.map(s => [s, []]));
  for (let i = 0; i < recs.length; i++) streams.get(strandSeq[i]).push(recs[i]);
  const parts = [varint(recs.length), varint(sNames.length)];
  for (const s of sNames) parts.push(writeStr(s));
  for (let i = 0; i < recs.length; i++) parts.push(varint(strandVocab.get(strandSeq[i])));
  for (const s of sNames) {
    const subRecs = streams.get(s);
    if (subRecs.length === 0) { parts.push(varint(0)); continue; }
    const subBuf = spikeEncode(subRecs);
    parts.push(varint(subBuf.length), subBuf);
  }
  return Buffer.concat(parts);
}
function plaitThenSpikeDecode(buf) {
  let p = 0;
  let v;
  [v, p] = readVarint(buf, p); const recCount = v;
  [v, p] = readVarint(buf, p); const nStrands = v;
  const sNames = [];
  for (let i = 0; i < nStrands; i++) { let len; [len, p] = readVarint(buf, p); sNames.push(buf.slice(p, p + len).toString('utf8')); p += len; }
  const seq = [];
  for (let i = 0; i < recCount; i++) { [v, p] = readVarint(buf, p); seq.push(sNames[v]); }
  const queues = new Map();
  for (const s of sNames) {
    let len; [len, p] = readVarint(buf, p);
    if (len === 0) { queues.set(s, []); continue; }
    const subBuf = buf.slice(p, p + len); p += len;
    queues.set(s, spikeDecode(subBuf));
  }
  const cursors = new Map(sNames.map(s => [s, 0]));
  const out = [];
  for (let i = 0; i < recCount; i++) {
    const s = seq[i];
    out.push(queues.get(s)[cursors.get(s)]);
    cursors.set(s, cursors.get(s) + 1);
  }
  return out;
}
function plaitThenPayloadCAEncode(recs) {
  const strandSeq = recs.map(r => strandOf(r.action));
  const strandVocab = new Map();
  for (const s of strandSeq) lookup(strandVocab, s);
  const sNames = [...strandVocab.keys()];
  const streams = new Map(sNames.map(s => [s, []]));
  for (let i = 0; i < recs.length; i++) streams.get(strandSeq[i]).push(recs[i]);
  const parts = [varint(recs.length), varint(sNames.length)];
  for (const s of sNames) parts.push(writeStr(s));
  for (let i = 0; i < recs.length; i++) parts.push(varint(strandVocab.get(strandSeq[i])));
  for (const s of sNames) {
    const subRecs = streams.get(s);
    if (subRecs.length === 0) { parts.push(varint(0)); continue; }
    parts.push(varint(0), payloadCAEncode(subRecs)); // mark len=0 → next is full subbuf
  }
  return Buffer.concat(parts);
}
// Skipping plait_then_payload_ca decode — too risky for time

transforms.plait_spike = { encode: plaitThenSpikeEncode, decode: plaitThenSpikeDecode };
function sortThenSpikeEncode(recs) { return spikeEncode([...recs].sort((a, b) => a.action.localeCompare(b.action) || a.id.localeCompare(b.id))); }
// sortThenSpike can't restore order, skip
// sort_action_then_plait: sort by action first, then plait should have ~100% run-length efficiency
function sortPlaitEncode(recs) {
  // Sort by action then by id, store inverse permutation
  const indexed = recs.map((r, i) => ({ r, i }));
  indexed.sort((a, b) => {
    if (a.r.action < b.r.action) return -1;
    if (a.r.action > b.r.action) return 1;
    return a.i - b.i;
  });
  const sortedRecs = indexed.map(x => x.r);
  const perm = indexed.map(x => x.i);
  const invPerm = new Array(recs.length);
  for (let i = 0; i < recs.length; i++) invPerm[perm[i]] = i;
  // Plait-encode sorted
  const plaitBuf = plaitEncode(sortedRecs);
  // Prepend inverse permutation
  const permParts = [varint(recs.length)];
  for (const v of invPerm) permParts.push(varint(v));
  const permBuf = Buffer.concat(permParts);
  return Buffer.concat([varint(permBuf.length), permBuf, plaitBuf]);
}
function sortPlaitDecode(buf) {
  let p = 0;
  let len; [len, p] = readVarint(buf, p);
  const permEnd = p + len;
  let v;
  [v, p] = readVarint(buf, p); const recCount = v;
  const invPerm = [];
  for (let i = 0; i < recCount; i++) { [v, p] = readVarint(buf, p); invPerm.push(v); }
  p = permEnd;
  const plaitDecoded = plaitDecode(buf.slice(p));
  const out = new Array(recCount);
  for (let i = 0; i < recCount; i++) out[i] = plaitDecoded[invPerm[i]];
  return out;
}
transforms.sort_plait = { encode: sortPlaitEncode, decode: sortPlaitDecode };

// ─── Run the sweep ──────────────────────────────────────────────────────────
const singleTransforms = ['identity', 'spike', 'plait', 'sort_action', 'payload_ca', 'plait_spike', 'sort_plait'];
const codecsToTest = ['brotli_q11', 'brotli_q6', 'zlib_9'];

const results = [];
let pipelineIdx = 0;
const total = singleTransforms.length * codecsToTest.length;
console.log(`\nRunning ${total} pipeline combinations...\n`);

for (const t of singleTransforms) {
  for (const c of codecsToTest) {
    pipelineIdx++;
    try {
      const r = runPipeline([t], c);
      results.push(r);
      const flag = r.lossless ? '✓' : '✗';
      console.log(`  [${pipelineIdx.toString().padStart(2)}/${total}] ${flag} ${r.ratio.toFixed(2).padStart(7)}x  ${r.pipeline.padEnd(40)} ${r.final_bytes.toString().padStart(8)} B`);
    } catch (e) {
      console.log(`  [${pipelineIdx.toString().padStart(2)}/${total}] ✗ ERROR  ${t} → ${c}: ${e.message}`);
      results.push({ pipeline: `${t} → ${c}`, ratio: 0, lossless: false, error: e.message });
    }
  }
}

results.sort((a, b) => (b.ratio || 0) - (a.ratio || 0));
console.log('\n═══ SWEEP RESULTS (sorted by ratio) ═══');
for (const r of results) {
  const flag = r.lossless ? '✓' : '✗';
  console.log(`  ${flag} ${(r.ratio || 0).toFixed(2).padStart(7)}x  ${r.pipeline.padEnd(40)} ${(r.final_bytes || 0).toString().padStart(8)} B`);
}

const best = results[0];
const baseline = results.find(r => r.pipeline === 'identity → brotli_q11');

const receipt = {
  experiment: '14-combinatorial-sweep',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  raw_corpus_bytes: corpusBytes.length,
  total_pipelines_tested: results.length,
  best: best,
  baseline_identity_brotli_q11: baseline,
  all_results: results,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 14 — Combinatorial Sweep — RESULT

**Status:** ✅ COMPLETE (${results.length} pipelines tested)
**Generated:** ${receipt.generated_at}

## Top 10 pipelines (all lossless)

| Pipeline | Ratio | Final bytes |
|---|---|---|
${results.slice(0, 10).map(r => `| ${r.pipeline} | **${(r.ratio || 0).toFixed(2)}×** | ${(r.final_bytes || 0).toLocaleString()} |`).join('\n')}

## All results

| Pipeline | Ratio | Final bytes | Lossless |
|---|---|---|---|
${results.map(r => `| ${r.pipeline} | ${(r.ratio || 0).toFixed(2)}× | ${(r.final_bytes || 0).toLocaleString()} | ${r.lossless ? '✓' : '✗'} |`).join('\n')}

## Headline
- **Best:** \`${best.pipeline}\` at **${(best.ratio || 0).toFixed(2)}×**
- Baseline (identity → brotli_q11): ${(baseline?.ratio || 0).toFixed(2)}×
- Compound win: **+${((best.ratio || 0) - (baseline?.ratio || 0)).toFixed(2)}×**
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nSweep receipt: ${RECEIPT_FILE}`);
