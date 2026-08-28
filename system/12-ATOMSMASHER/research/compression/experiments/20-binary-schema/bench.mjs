// Experiment 20 — Minimal Binary Schema Codec
//
// Goal: hit the theoretical ~27× floor by stripping every byte of structural
// overhead. No JSON, no braces, no key strings, no quotes. Just:
//   - Per-receipt: id_tail (8B) + 5 varints (action_id, status_id, sum_tpl_id, pay_tpl_id, ts_id) + nums
//   - Vocabs stored once (action, status, sum_tpl, pay_tpl, ts) — brotli-friendly
//   - Brotli final layer on the whole thing
//
// Lossless: rebuild JSON receipts from the binary frames + vocabs.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULT_FILE = path.join(ROOT, 'RESULT.md');

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

// ─── Build vocabs ───────────────────────────────────────────────────────────
const sumTpl = new Map();
const payTpl = new Map();
const actionVocab = new Map();
const statusVocab = new Map();
const tsVocab = new Map();

const recs = receipts.map(r => {
  const sT = templatize(r.summary);
  const pT = templatize(r.payload_json);
  // Detect intra-payload functional dependencies for mesh.compress
  // (ratio = round(raw_bytes/compressed_bytes, 2)) — fold them out
  let payNums = pT.nums;
  let folded_ratio_idx = -1;
  if (r.action === 'mesh.compress' && pT.nums.length === 3) {
    try {
      const p = JSON.parse(r.payload_json);
      if (typeof p.raw_bytes === 'number' && typeof p.compressed_bytes === 'number' && typeof p.ratio === 'number') {
        const computed = Number((p.raw_bytes / p.compressed_bytes).toFixed(2));
        if (computed === p.ratio) {
          // The "ratio" appears as one of the three nums; find which index
          for (let k = 0; k < pT.nums.length; k++) {
            if (parseFloat(pT.nums[k]) === p.ratio) { folded_ratio_idx = k; break; }
          }
          if (folded_ratio_idx >= 0) {
            payNums = pT.nums.filter((_, k) => k !== folded_ratio_idx);
          }
        }
      }
    } catch {}
  }
  // Summary-from-payload derivation: which summary numbers exist in payload nums?
  const paySet = new Set(payNums.concat(folded_ratio_idx >= 0 ? [pT.nums[folded_ratio_idx]] : []));
  const summDerivable = sT.nums.map(n => paySet.has(n));

  const sTid = lookup(sumTpl, sT.template);
  const pTid = lookup(payTpl, pT.template);
  const aId = lookup(actionVocab, r.action == null ? '\0NULL\0' : String(r.action));
  const sId = lookup(statusVocab, r.status == null ? '\0NULL\0' : String(r.status));
  const tId = lookup(tsVocab, r.created_at == null ? '\0NULL\0' : String(r.created_at));
  // ID tail
  const m = String(r.id).match(/^rcpt_([a-f0-9]{16})$/);
  return {
    sTid, pTid, aId, sId, tId,
    payNums, originalPayNumCount: pT.nums.length, folded_ratio_idx,
    summNums: sT.nums, summDerivable,
    idTail: m ? Buffer.from(m[1], 'hex') : null,
    fullId: m ? null : String(r.id),
  };
});

const allIdsMatch = recs.every(r => r.idTail !== null);
let derivableCount = 0, totalSummN = 0;
for (const rp of recs) for (const d of rp.summDerivable) { if (d) derivableCount++; totalSummN++; }
let foldedRatioCount = recs.filter(r => r.folded_ratio_idx >= 0).length;

console.log(`\nVocabs: sumTpl=${sumTpl.size}, payTpl=${payTpl.size}, action=${actionVocab.size}, status=${statusVocab.size}, ts=${tsVocab.size}`);
console.log(`Summary derivability: ${derivableCount}/${totalSummN} = ${(derivableCount/totalSummN*100).toFixed(1)}%`);
console.log(`Folded mesh.compress ratio fields: ${foldedRatioCount}/${recs.length}`);
console.log(`All IDs match rcpt_<16hex>: ${allIdsMatch}`);

// ─── Encode binary stream ────────────────────────────────────────────────────
const out = [varint(N)];

// Vocabs
out.push(varint(sumTpl.size));
for (const t of sumTpl.keys()) out.push(...writeStr(t));
out.push(varint(payTpl.size));
for (const t of payTpl.keys()) out.push(...writeStr(t));
for (const vocab of [actionVocab, statusVocab, tsVocab]) {
  out.push(varint(vocab.size));
  for (const v of vocab.keys()) out.push(...writeStr(v));
}
out.push(varint(allIdsMatch ? 1 : 0));

// Per-receipt: tightly packed
for (let i = 0; i < N; i++) {
  const rp = recs[i];
  // ID
  if (allIdsMatch) out.push(rp.idTail);
  else out.push(...writeStr(rp.fullId));
  // Field varints
  out.push(varint(rp.aId), varint(rp.sId), varint(rp.tId));
  out.push(varint(rp.sTid), varint(rp.pTid));
  // Folded ratio idx (or -1 means none folded)
  out.push(varint(rp.folded_ratio_idx + 1)); // 0 = none, >=1 = idx+1
  // Payload nums (post-folding)
  out.push(varint(rp.payNums.length));
  for (const n of rp.payNums) out.push(...writeStr(n));
  // Summary derivability mask + unique nums + payload refs
  let mask = 0;
  for (let k = 0; k < rp.summDerivable.length; k++) if (rp.summDerivable[k]) mask |= (1 << k);
  out.push(varint(mask));
  const uniqueNums = [], paylRefs = [];
  // For derivable summary numbers, the source value is in the FULL payload nums
  // (which equals payNums + the folded ratio if present)
  const fullPayNums = rp.payNums.slice();
  if (rp.folded_ratio_idx >= 0) fullPayNums.splice(rp.folded_ratio_idx, 0, receipts[i].payload_json ? JSON.parse(receipts[i].payload_json).ratio.toString() : '');
  for (let k = 0; k < rp.summNums.length; k++) {
    if (rp.summDerivable[k]) {
      paylRefs.push(fullPayNums.indexOf(rp.summNums[k]));
    } else {
      uniqueNums.push(rp.summNums[k]);
    }
  }
  out.push(varint(uniqueNums.length));
  for (const n of uniqueNums) out.push(...writeStr(n));
  out.push(varint(paylRefs.length));
  for (const r of paylRefs) out.push(varint(r));
}

const stream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const ratio = corpusBytes.length / brotli.length;
console.log(`\nPre-brotli: ${stream.length} B`);
console.log(`+ Brotli q11: ${brotli.length} B`);
console.log(`Ratio: ${ratio.toFixed(2)}x`);
console.log(`vs plait (18.05x): ${ratio > 18.05 ? `BEATS by +${(ratio - 18.05).toFixed(2)}x` : `below by ${(18.05 - ratio).toFixed(2)}x`}`);
console.log(`vs theoretical 27x floor: ${ratio > 27 ? 'BEATS!' : `gap = ${(27 - ratio).toFixed(2)}x`}`);

// ─── Decode + lossless verify ────────────────────────────────────────────────
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
  let id;
  if (dAllIdsMatch) {
    const tail = dec.slice(p, p + 8); p += 8;
    id = 'rcpt_' + tail.toString('hex');
  } else {
    let l; [l, p] = readVarint(dec, p);
    id = dec.slice(p, p + l).toString('utf8'); p += l;
  }
  let aId, sId, tId, sTid, pTid, foldedIdx;
  [aId, p] = readVarint(dec, p);
  [sId, p] = readVarint(dec, p);
  [tId, p] = readVarint(dec, p);
  [sTid, p] = readVarint(dec, p);
  [pTid, p] = readVarint(dec, p);
  [foldedIdx, p] = readVarint(dec, p);
  foldedIdx -= 1; // back to -1 = none
  let pN; [pN, p] = readVarint(dec, p);
  const payNums = [];
  for (let k = 0; k < pN; k++) { let l; [l, p] = readVarint(dec, p); payNums.push(dec.slice(p, p + l).toString('utf8')); p += l; }
  let mask; [mask, p] = readVarint(dec, p);
  let uN; [uN, p] = readVarint(dec, p);
  const uniqueNums = [];
  for (let k = 0; k < uN; k++) { let l; [l, p] = readVarint(dec, p); uniqueNums.push(dec.slice(p, p + l).toString('utf8')); p += l; }
  let rN; [rN, p] = readVarint(dec, p);
  const paylRefs = [];
  for (let k = 0; k < rN; k++) { let r; [r, p] = readVarint(dec, p); paylRefs.push(r); }

  // Reconstruct payload first (need it for summary derivable references)
  const pTmpl = dPayTpl[pTid];
  let payload_json;
  let fullPayNums = payNums.slice();
  if (pTmpl === '\0NULL\0') payload_json = null;
  else {
    // First reconstruct the unfolded payload nums (re-insert the derived ratio)
    if (foldedIdx >= 0) {
      // Need to compute ratio from raw_bytes/compressed_bytes
      // The template has placeholders for all 3 numerics in original order
      // After folding, we removed nums[foldedIdx]. So:
      //   - Before folding: [num0, num1, num2] in template-position order
      //   - After folding (foldedIdx=2 typically for "ratio"): [num0, num1]
      //   - To unfold: insert computed value back at foldedIdx
      // For mesh.compress, the template is like: {"raw_bytes":X,"compressed_bytes":Y,"ratio":Z}
      // where X = payNums[0], Y = payNums[1], Z would have been at foldedIdx.
      // Compute Z = round(X/Y, 2)
      const others = payNums.slice();
      const X = parseFloat(others[0]);
      const Y = parseFloat(others[1]);
      const Z = Number((X/Y).toFixed(2));
      // Insert at foldedIdx
      const insertStr = (Z === Math.trunc(Z)) ? String(Z) : Z.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
      // Match original format: from corpus we know ratio is written as e.g. "1.98" or "5"
      // Most are like 1.98, 0.95 (with 2 decimal places)
      // Try matching original format by inspecting the original payload's stringification
      fullPayNums = others.slice();
      // We need to reproduce the EXACT string the encoder saw. The encoder extracted with NUMBER_RE.
      // For ratios like 1.98, NUMBER_RE captures "1.98". For 2 (integer), "2".
      // Compute string with minimal representation:
      let zStr;
      if (Number.isInteger(Z)) zStr = String(Z);
      else zStr = Z.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
      // But the corpus might write 1.98 (2 decimals) consistently. Check sample:
      // Most mesh.compress have "ratio":1.98 or "ratio":1.45 — 2 decimals.
      // Use toFixed(2) but if integer, no decimals
      if (Number.isInteger(Z)) zStr = String(Z);
      else zStr = Z.toFixed(2);
      fullPayNums.splice(foldedIdx, 0, zStr);
    }
    let s = pTmpl;
    let nIdx = 0;
    s = s.replace(//g, () => fullPayNums[nIdx++]);
    payload_json = s;
  }
  // Reconstruct summary
  const sTmpl = dSumTpl[sTid];
  let summary;
  if (sTmpl === '\0NULL\0') summary = null;
  else {
    const phCount = (sTmpl.match(//g) || []).length;
    const sumNums = [];
    let dIdx = 0, uIdx = 0;
    for (let k = 0; k < phCount; k++) {
      if (mask & (1 << k)) sumNums.push(fullPayNums[paylRefs[dIdx++]]);
      else sumNums.push(uniqueNums[uIdx++]);
    }
    let s = sTmpl;
    let nIdx = 0;
    s = s.replace(//g, () => sumNums[nIdx++]);
    summary = s;
  }
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
  experiment: '20-binary-schema',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  vocab_sizes: { sumTpl: sumTpl.size, payTpl: payTpl.size, action: actionVocab.size, status: statusVocab.size, ts: tsVocab.size },
  summary_derivability_pct: Number((derivableCount/totalSummN*100).toFixed(1)),
  folded_ratio_count: foldedRatioCount,
  all_ids_match: allIdsMatch,
  pre_brotli_bytes: stream.length,
  brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  beats_plait: ratio > 18.05,
  pass: roundtripOk && ratio > 18.05,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 20 — Minimal Binary Schema Codec — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : roundtripOk ? '⚠️ lossless, below baseline' : '❌ lossy'}

## Compression

| Metric | Value |
|---|---|
| Raw corpus | ${corpusBytes.length.toLocaleString()} B |
| Pre-brotli (binary schema) | ${stream.length.toLocaleString()} B |
| + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Ratio** | **${ratio.toFixed(2)}×** |
| Lossless | ${roundtripOk ? '✓' : '✗'} |

## Folds applied
- Summary numerics derivable from payload: ${derivableCount.toLocaleString()} / ${totalSummN.toLocaleString()} = ${(derivableCount/totalSummN*100).toFixed(1)}%
- mesh.compress ratio folded out: ${foldedRatioCount} receipts
- ID stored as 8-byte tail
- All field strings extracted to vocabs (stored once)
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
