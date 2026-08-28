// Experiment 19 v2 — FUSED CODEC (simpler, lossless-first)
//
// No arithmetic coding edge cases. Just:
//   - Summary template + payload template extraction (numerics → placeholders)
//   - Summary numerics: store derivable ones as payload-index refs, non-derivable verbatim
//   - Action/status/created_at: per-field vocab + varint indices
//   - IDs: 8-byte hex tails (rcpt_<16hex> pattern verified)
//   - Brotli q11 final
//
// Lossless via reconstruction + sha256.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT-v2.json');
const RESULT_FILE = path.join(ROOT, 'RESULT-v2.md');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Loaded ${N} receipts, ${corpusBytes.length} B`);

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
const PH = '';

function templatize(s) {
  if (s == null) return { template: '\0NULL\0', nums: [] };
  const nums = [];
  const template = String(s).replace(NUMBER_RE, (m) => { nums.push(m); return PH; });
  return { template, nums };
}

function lookup(m, k) { let v = m.get(k); if (v === undefined) { v = m.size; m.set(k, v); } return v; }
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

// Build vocabularies and per-receipt analysis
const summTpl = new Map();
const paylTpl = new Map();
const actionVocab = new Map();
const statusVocab = new Map();
const tsVocab = new Map();

let derivable = 0, totalSummN = 0;
const recs = receipts.map(r => {
  const sT = templatize(r.summary);
  const pT = templatize(r.payload_json);
  const sTid = lookup(summTpl, sT.template);
  const pTid = lookup(paylTpl, pT.template);
  const aId = lookup(actionVocab, r.action == null ? '\0NULL\0' : String(r.action));
  const sId = lookup(statusVocab, r.status == null ? '\0NULL\0' : String(r.status));
  const tId = lookup(tsVocab, r.created_at == null ? '\0NULL\0' : String(r.created_at));

  // Build payload-numeric search index
  const paySet = new Set(pT.nums);
  const summDerivable = sT.nums.map(n => paySet.has(n));
  for (const d of summDerivable) {
    if (d) derivable++;
    totalSummN++;
  }
  // ID tail
  const m = String(r.id).match(/^rcpt_([a-f0-9]{16})$/);
  const idTail = m ? Buffer.from(m[1], 'hex') : null;

  return { sTid, pTid, aId, sId, tId, paylNums: pT.nums, summNums: sT.nums, summDerivable, idTail, fullId: m ? null : String(r.id) };
});

const allIdsMatch = recs.every(rp => rp.idTail !== null);
console.log(`Summary templates: ${summTpl.size}`);
console.log(`Payload templates: ${paylTpl.size}`);
console.log(`Summary numerics derivable from payload: ${derivable}/${totalSummN} = ${(derivable/totalSummN*100).toFixed(1)}%`);
console.log(`Action vocab: ${actionVocab.size}, Status: ${statusVocab.size}, Created_at: ${tsVocab.size}`);
console.log(`All IDs match rcpt_<16hex>: ${allIdsMatch}`);

// ─── Encode ─────────────────────────────────────────────────────────────────
const out = [varint(N)];

// Vocabs
out.push(varint(summTpl.size));
for (const t of summTpl.keys()) out.push(...writeStr(t));
out.push(varint(paylTpl.size));
for (const t of paylTpl.keys()) out.push(...writeStr(t));
out.push(varint(actionVocab.size));
for (const v of actionVocab.keys()) out.push(...writeStr(v));
out.push(varint(statusVocab.size));
for (const v of statusVocab.keys()) out.push(...writeStr(v));
out.push(varint(tsVocab.size));
for (const v of tsVocab.keys()) out.push(...writeStr(v));

// allIdsMatch flag
out.push(varint(allIdsMatch ? 1 : 0));

// Per-receipt
for (let i = 0; i < N; i++) {
  const rp = recs[i];
  out.push(varint(rp.sTid), varint(rp.pTid), varint(rp.aId), varint(rp.sId), varint(rp.tId));
  // Payload numerics
  out.push(varint(rp.paylNums.length));
  for (const n of rp.paylNums) out.push(...writeStr(n));
  // Summary derivability mask + non-derivable + payload refs
  let mask = 0;
  for (let k = 0; k < rp.summDerivable.length; k++) if (rp.summDerivable[k]) mask |= (1 << k);
  out.push(varint(mask));
  const uniqueSummNums = [], paylRefs = [];
  for (let k = 0; k < rp.summNums.length; k++) {
    if (rp.summDerivable[k]) paylRefs.push(rp.paylNums.indexOf(rp.summNums[k]));
    else uniqueSummNums.push(rp.summNums[k]);
  }
  out.push(varint(uniqueSummNums.length));
  for (const n of uniqueSummNums) out.push(...writeStr(n));
  out.push(varint(paylRefs.length));
  for (const r of paylRefs) out.push(varint(r));
  // ID
  if (allIdsMatch) out.push(rp.idTail);
  else out.push(...writeStr(rp.fullId));
}

const stream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const ratio = corpusBytes.length / brotli.length;
console.log(`\nPre-brotli: ${stream.length} B`);
console.log(`+ Brotli q11: ${brotli.length} B`);
console.log(`Ratio: ${ratio.toFixed(2)}x`);
console.log(`vs plait (18.05x): ${ratio > 18.05 ? `BEATS by +${(ratio - 18.05).toFixed(2)}x` : `below by ${(18.05 - ratio).toFixed(2)}x`}`);

// ─── Decode + roundtrip verify ──────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const dN = v;

function readVocab() {
  let len; [len, p] = readVarint(dec, p);
  const inv = [];
  for (let i = 0; i < len; i++) {
    let l; [l, p] = readVarint(dec, p);
    inv.push(dec.slice(p, p + l).toString('utf8'));
    p += l;
  }
  return inv;
}
const dSumTpl = readVocab();
const dPayTpl = readVocab();
const dAction = readVocab();
const dStatus = readVocab();
const dTs = readVocab();
[v, p] = readVarint(dec, p); const dAllIdsMatch = (v === 1);

const decoded = [];
for (let i = 0; i < dN; i++) {
  let sTid, pTid, aId, sId, tId;
  [sTid, p] = readVarint(dec, p);
  [pTid, p] = readVarint(dec, p);
  [aId, p] = readVarint(dec, p);
  [sId, p] = readVarint(dec, p);
  [tId, p] = readVarint(dec, p);
  let pN; [pN, p] = readVarint(dec, p);
  const paylNums = [];
  for (let k = 0; k < pN; k++) { let l; [l, p] = readVarint(dec, p); paylNums.push(dec.slice(p, p + l).toString('utf8')); p += l; }
  let mask; [mask, p] = readVarint(dec, p);
  let uN; [uN, p] = readVarint(dec, p);
  const uniqueSummNums = [];
  for (let k = 0; k < uN; k++) { let l; [l, p] = readVarint(dec, p); uniqueSummNums.push(dec.slice(p, p + l).toString('utf8')); p += l; }
  let rN; [rN, p] = readVarint(dec, p);
  const paylRefs = [];
  for (let k = 0; k < rN; k++) { let r; [r, p] = readVarint(dec, p); paylRefs.push(r); }
  let id;
  if (dAllIdsMatch) {
    const tail = dec.slice(p, p + 8); p += 8;
    id = 'rcpt_' + tail.toString('hex');
  } else {
    let l; [l, p] = readVarint(dec, p);
    id = dec.slice(p, p + l).toString('utf8'); p += l;
  }

  // Reconstruct summary
  const sTmpl = dSumTpl[sTid];
  let summary;
  if (sTmpl === '\0NULL\0') summary = null;
  else {
    const phCount = (sTmpl.match(new RegExp(PH, 'g')) || []).length;
    const sumNums = [];
    let dIdx = 0, uIdx = 0;
    for (let k = 0; k < phCount; k++) {
      if (mask & (1 << k)) sumNums.push(paylNums[paylRefs[dIdx++]]);
      else sumNums.push(uniqueSummNums[uIdx++]);
    }
    let s = sTmpl;
    let nIdx = 0;
    s = s.replace(new RegExp(PH, 'g'), () => sumNums[nIdx++]);
    summary = s;
  }
  const pTmpl = dPayTpl[pTid];
  let payload_json;
  if (pTmpl === '\0NULL\0') payload_json = null;
  else {
    let s = pTmpl;
    let nIdx = 0;
    s = s.replace(new RegExp(PH, 'g'), () => paylNums[nIdx++]);
    payload_json = s;
  }
  // Resolve nulls in field vocabs
  let action = dAction[aId]; if (action === '\0NULL\0') action = null;
  let status = dStatus[sId]; if (status === '\0NULL\0') status = null;
  let created_at = dTs[tId]; if (created_at === '\0NULL\0') created_at = null;

  decoded.push({ id, action, status, summary, payload_json, created_at });
}

const decJsonl = decoded.map(r => JSON.stringify(r)).join('\n') + '\n';
const decSha = crypto.createHash('sha256').update(decJsonl).digest('hex');
const roundtripOk = decSha === corpusSha;
console.log(`\nRoundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);
if (!roundtripOk) {
  const orig = corpusBytes.toString('utf8');
  const minLen = Math.min(orig.length, decJsonl.length);
  for (let i = 0; i < minLen; i++) {
    if (orig[i] !== decJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  orig: ...${orig.slice(Math.max(0, i-80), i+80)}...`);
      console.log(`  dec:  ...${decJsonl.slice(Math.max(0, i-80), i+80)}...`);
      break;
    }
  }
}

const receipt = {
  experiment: '19-fused-codec-v2',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  corpus_bytes_in: corpusBytes.length,
  summary_templates: summTpl.size,
  payload_templates: paylTpl.size,
  summary_nums_total: totalSummN,
  summary_nums_derivable: derivable,
  derivable_pct: Number((derivable/totalSummN*100).toFixed(1)),
  all_ids_match: allIdsMatch,
  pre_brotli_bytes: stream.length,
  brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  beats_plait: ratio > 18.05,
  pass: roundtripOk && ratio > 18.05,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 19 v2 — FUSED CODEC — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : roundtripOk ? '⚠️ LOSSLESS but below baseline' : '❌ FAIL (lossy)'}

## Fusion: every working axis combined

| Component | Impact |
|---|---|
| Summary templates extracted | ${summTpl.size} distinct |
| Payload templates extracted | ${paylTpl.size} distinct |
| **Summary numerics derivable from payload** | **${derivable.toLocaleString()} / ${totalSummN.toLocaleString()} = ${(derivable/totalSummN*100).toFixed(1)}%** |
| ID storage | ${allIdsMatch ? '8 bytes per ID (rcpt_<16hex>)' : 'full string'} |

## Compression

| Metric | Value |
|---|---|
| Raw corpus | ${corpusBytes.length.toLocaleString()} B |
| Pre-brotli | ${stream.length.toLocaleString()} B |
| + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Ratio** | **${ratio.toFixed(2)}×** |
| Lossless | ${roundtripOk ? '✓' : '✗'} |
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
