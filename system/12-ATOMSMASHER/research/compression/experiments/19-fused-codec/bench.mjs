// Experiment 19 — FUSED CODEC (combine every working axis we found)
//
// Operator: "you got lazy. find the massive jump."
//
// Fuse every win into one codec:
//   1. Summary template extraction — discover summary as f(action, payload_params)
//   2. Payload template extraction (Exp 13) — strip numerics into params
//   3. Markov range coding on small-vocab fields (action, status, created_at)
//   4. Timestamp delta encoding (instead of full ISO strings)
//   5. ID handling: store ONLY the irreducible 8 bytes (16-hex tail)
//   6. Schema folding (Exp 18) — strip derived fields
//   7. Brotli final layer

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

// ─── STAGE A: Extract summary + payload templates jointly ───────────────────
// Goal: detect summary as a "format-string + numerics" pattern that shares
// numerics with the payload. For each (action), find which summary tokens
// are constants vs which are numbers; for each number, check if it appears
// in the payload.

const NUMBER_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;

function extractNumbersFromString(s) {
  return (String(s).match(NUMBER_RE) || []).map(x => x);
}
function templatize(s) {
  if (s == null) return { template: '\0NULL\0', nums: [] };
  const nums = [];
  const template = String(s).replace(NUMBER_RE, (m) => {
    nums.push(m);
    return '';
  });
  return { template, nums };
}

// For each receipt, extract summary template + summary numerics + payload template + payload numerics.
const summTemplates = new Map();
const paylTemplates = new Map();
function lookup(m, k) { let v = m.get(k); if (v === undefined) { v = m.size; m.set(k, v); } return v; }

let derivableSummaryNums = 0;
let totalSummaryNums = 0;
const recProcessed = receipts.map(r => {
  const sT = templatize(r.summary);
  const pT = templatize(r.payload_json);
  const sTid = lookup(summTemplates, sT.template);
  const pTid = lookup(paylTemplates, pT.template);
  // For each number in summary, check if it appears in payload nums
  const paylSet = new Set(pT.nums);
  const summDerivable = sT.nums.map(n => paylSet.has(n));
  for (const d of summDerivable) {
    if (d) derivableSummaryNums++;
    totalSummaryNums++;
  }
  return { r, sTid, pTid, summNums: sT.nums, paylNums: pT.nums, summDerivable };
});

console.log(`\nSummary templates: ${summTemplates.size}`);
console.log(`Payload templates: ${paylTemplates.size}`);
console.log(`Summary numerics: ${totalSummaryNums} total, ${derivableSummaryNums} derivable from payload (${(derivableSummaryNums / totalSummaryNums * 100).toFixed(1)}%)`);

// For each summary-numeric, store ONLY indices into payload-numerics or the value if not derivable
// Encoding strategy: for each receipt, store
//   summDerivableMask : bitmask of which summary-numerics are derivable
//   summUniqueNums    : the summary-numerics that are NOT derivable (verbatim)
//   paylNumIndex      : for derivable ones, store which payload-num index matches
//                       (most of the time it'll be the first occurrence)

// ─── STAGE B: per-field vocabs for action, status, created_at, id-suffix ────
const FIELDS_VOCAB = ['action', 'status', 'created_at'];
const vocabs = Object.fromEntries(FIELDS_VOCAB.map(f => [f, new Map()]));
const seqs = Object.fromEntries(FIELDS_VOCAB.map(f => [f, []]));
for (const r of receipts) {
  for (const f of FIELDS_VOCAB) {
    const val = r[f] == null ? '\0NULL\0' : String(r[f]);
    seqs[f].push(lookup(vocabs[f], val));
  }
}
console.log(`\nField vocabs: action=${vocabs.action.size}, status=${vocabs.status.size}, created_at=${vocabs.created_at.size}`);

// IDs: extract `rcpt_` prefix + 16-hex tail. Store the tails as 8 bytes each.
const idTails = receipts.map(r => {
  const m = String(r.id).match(/^rcpt_([a-f0-9]{16})$/);
  return m ? m[1] : null;
});
const allIdsMatch = idTails.every(t => t !== null);
console.log(`IDs: ${allIdsMatch ? 'ALL match rcpt_<16hex> pattern (8 bytes irreducible each)' : 'SOME do not match - falling back to full string'}`);

// ─── Range coder (lossless integer arithmetic) ──────────────────────────────
function arithmeticCode(symbols, V, cumFn) {
  const TOP = 0xFFFFFFFF >>> 0, HALF = 0x80000000 >>> 0, QTR = 0x40000000 >>> 0, TQTR = 0xC0000000 >>> 0;
  let low = 0, high = TOP, pending = 0;
  const outBits = [];
  function emit(b) { outBits.push(b); }
  function epw(b) { emit(b); for (let i = 0; i < pending; i++) emit(1 - b); pending = 0; }
  for (let i = 0; i < symbols.length; i++) {
    const cum = cumFn(i, symbols);
    const sym = symbols[i];
    const cumTot = cum[V];
    const rng = (high - low + 1);
    high = (low + Math.floor((rng * cum[sym + 1]) / cumTot) - 1) >>> 0;
    low = (low + Math.floor((rng * cum[sym]) / cumTot)) >>> 0;
    while (true) {
      if (high < HALF) epw(0);
      else if (low >= HALF) { epw(1); low = (low - HALF) >>> 0; high = (high - HALF) >>> 0; }
      else if (low >= QTR && high < TQTR) { pending++; low = (low - QTR) >>> 0; high = (high - QTR) >>> 0; }
      else break;
      low = (low << 1) >>> 0;
      high = ((high << 1) | 1) >>> 0;
    }
  }
  pending++;
  if (low < QTR) epw(0); else epw(1);
  const nBytes = Math.ceil(outBits.length / 8);
  const buf = Buffer.alloc(nBytes);
  for (let i = 0; i < outBits.length; i++) if (outBits[i]) buf[i >> 3] |= 1 << (7 - (i & 7));
  return { buf, nBits: outBits.length };
}
function arithmeticDecode(buf, nBits, count, V, cumFn) {
  const TOP = 0xFFFFFFFF >>> 0, HALF = 0x80000000 >>> 0, QTR = 0x40000000 >>> 0, TQTR = 0xC0000000 >>> 0;
  let low = 0, high = TOP, value = 0, bitIdx = 0;
  function rb() { if (bitIdx >= nBits) return 0; const b = (buf[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1; bitIdx++; return b; }
  for (let i = 0; i < 32; i++) value = ((value << 1) | rb()) >>> 0;
  const out = [];
  for (let i = 0; i < count; i++) {
    const cum = cumFn(i, out);
    const cumTot = cum[V];
    const rng = (high - low + 1);
    const targ = Math.floor((((value - low) >>> 0) + 1) * cumTot - 1) / rng;
    let sym = 0;
    while (cum[sym + 1] <= targ) sym++;
    out.push(sym);
    high = (low + Math.floor((rng * cum[sym + 1]) / cumTot) - 1) >>> 0;
    low = (low + Math.floor((rng * cum[sym]) / cumTot)) >>> 0;
    while (true) {
      if (high < HALF) {} else if (low >= HALF) { low = (low - HALF) >>> 0; high = (high - HALF) >>> 0; value = (value - HALF) >>> 0; }
      else if (low >= QTR && high < TQTR) { low = (low - QTR) >>> 0; high = (high - QTR) >>> 0; value = (value - QTR) >>> 0; }
      else break;
      low = (low << 1) >>> 0; high = ((high << 1) | 1) >>> 0; value = ((value << 1) | rb()) >>> 0;
    }
  }
  return out;
}
function buildMarkovCum(seq, V) {
  const iidCounts = new Map();
  for (const s of seq) iidCounts.set(s, (iidCounts.get(s) || 0) + 1);
  const condCounts = new Map();
  for (let i = 1; i < seq.length; i++) {
    const prev = seq[i - 1], cur = seq[i];
    if (!condCounts.has(prev)) condCounts.set(prev, new Map());
    const m = condCounts.get(prev);
    m.set(cur, (m.get(cur) || 0) + 1);
  }
  const cumIID = new Array(V + 1).fill(0);
  for (let s = 0; s < V; s++) cumIID[s + 1] = cumIID[s] + ((iidCounts.get(s) || 0) + 1);
  const cumCond = new Map();
  for (let prev = 0; prev < V; prev++) {
    const m = condCounts.get(prev);
    const cum = new Array(V + 1).fill(0);
    for (let s = 0; s < V; s++) cum[s + 1] = cum[s] + ((m?.get(s) || 0) + 1);
    cumCond.set(prev, cum);
  }
  return { cumIID, cumCond, condCounts, iidCounts };
}

function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

// ─── ASSEMBLE FUSED CODEC ───────────────────────────────────────────────────
const out = [];

// Header
out.push(varint(N));

// Summary template vocab
out.push(varint(summTemplates.size));
for (const t of summTemplates.keys()) out.push(...writeStr(t));

// Payload template vocab
out.push(varint(paylTemplates.size));
for (const t of paylTemplates.keys()) out.push(...writeStr(t));

// Action / status / created_at vocabs (for Markov coder + reconstruction)
for (const f of FIELDS_VOCAB) {
  out.push(varint(vocabs[f].size));
  for (const v of vocabs[f].keys()) out.push(...writeStr(v));
}

// Markov-code action, status, created_at sequences
const markovBufs = {};
for (const f of FIELDS_VOCAB) {
  const V = vocabs[f].size;
  const m = buildMarkovCum(seqs[f], V);
  const cumFn = (i, syms) => i === 0 ? m.cumIID : m.cumCond.get(syms[i - 1]);
  const { buf, nBits } = arithmeticCode(seqs[f], V, cumFn);
  // Serialize model conditional counts (sparse triples) for decoder
  const modelParts = [varint(V)];
  for (let s = 0; s < V; s++) modelParts.push(varint(m.iidCounts.get(s) || 0));
  const triples = [];
  for (let prev = 0; prev < V; prev++) {
    const cm = m.condCounts.get(prev);
    if (!cm) continue;
    for (const [cur, c] of cm) triples.push([prev, cur, c]);
  }
  modelParts.push(varint(triples.length));
  for (const [prev, cur, c] of triples) modelParts.push(varint(prev), varint(cur), varint(c));
  const modelBuf = Buffer.concat(modelParts);
  markovBufs[f] = { buf, nBits, modelBuf };
  // Pack into stream
  out.push(varint(modelBuf.length), modelBuf, varint(nBits), varint(buf.length), buf);
}

// Per-receipt body:
//  sTid (varint) | pTid (varint)
//  paylNumsCount (varint) | paylNums[] (varint(len), bytes)
//  summDerivableMask (varint = bitmask)
//  summUniqueNums[] (varint(len), bytes) for non-derivable summary numerics
//  paylNumIndex[] (varint) for derivable summary numerics — index into paylNums
//  idTail (8 raw bytes if allIdsMatch, else full string)

for (let i = 0; i < N; i++) {
  const rp = recProcessed[i];
  out.push(varint(rp.sTid), varint(rp.pTid));
  // payload numerics
  out.push(varint(rp.paylNums.length));
  for (const n of rp.paylNums) out.push(...writeStr(n));
  // summary derivability mask
  let mask = 0;
  for (let k = 0; k < rp.summDerivable.length; k++) if (rp.summDerivable[k]) mask |= (1 << k);
  out.push(varint(mask));
  // unique summary numerics + payload-num indices
  const uniqueSummNums = [];
  const paylRefs = [];
  for (let k = 0; k < rp.summNums.length; k++) {
    if (rp.summDerivable[k]) {
      // Find first occurrence in payload nums (deterministic)
      const idx = rp.paylNums.indexOf(rp.summNums[k]);
      paylRefs.push(idx);
    } else {
      uniqueSummNums.push(rp.summNums[k]);
    }
  }
  out.push(varint(uniqueSummNums.length));
  for (const n of uniqueSummNums) out.push(...writeStr(n));
  out.push(varint(paylRefs.length));
  for (const r of paylRefs) out.push(varint(r));
  // ID tail (8 bytes raw)
  if (allIdsMatch) {
    const tail = Buffer.from(idTails[i], 'hex');
    out.push(tail);
  } else {
    out.push(...writeStr(String(receipts[i].id)));
  }
}

const stream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const ratio = corpusBytes.length / brotli.length;
console.log(`\n=== FUSED CODEC ===`);
console.log(`  Pre-brotli stream: ${stream.length} B`);
console.log(`  Brotli q11:        ${brotli.length} B`);
console.log(`  Compression ratio: ${ratio.toFixed(2)}x`);
console.log(`  vs plait (18.05x): ${ratio > 18.05 ? `BEATS by ${(ratio - 18.05).toFixed(2)}x` : `BELOW by ${(18.05 - ratio).toFixed(2)}x`}`);

// ─── DECODE + ROUNDTRIP VERIFICATION ─────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const dN = v;

[v, p] = readVarint(dec, p); const dSumTSize = v;
const dSumT = [];
for (let i = 0; i < dSumTSize; i++) { let l; [l, p] = readVarint(dec, p); dSumT.push(dec.slice(p, p + l).toString('utf8')); p += l; }

[v, p] = readVarint(dec, p); const dPayTSize = v;
const dPayT = [];
for (let i = 0; i < dPayTSize; i++) { let l; [l, p] = readVarint(dec, p); dPayT.push(dec.slice(p, p + l).toString('utf8')); p += l; }

// Read field vocabs + markov-coded sequences
const dFieldData = {};
for (const f of FIELDS_VOCAB) {
  [v, p] = readVarint(dec, p); const V = v;
  const inv = [];
  for (let i = 0; i < V; i++) { let l; [l, p] = readVarint(dec, p); inv.push(dec.slice(p, p + l).toString('utf8')); p += l; }
  // model
  let mLen; [mLen, p] = readVarint(dec, p);
  const modelBuf = dec.slice(p, p + mLen); p += mLen;
  let mp = 0;
  let mv;
  [mv, mp] = readVarint(modelBuf, mp); const dV = mv;
  const iidCounts = new Map();
  for (let s = 0; s < dV; s++) { [mv, mp] = readVarint(modelBuf, mp); iidCounts.set(s, mv); }
  const condCounts = new Map();
  let nt; [nt, mp] = readVarint(modelBuf, mp);
  for (let t = 0; t < nt; t++) {
    let prev, cur, c;
    [prev, mp] = readVarint(modelBuf, mp);
    [cur, mp] = readVarint(modelBuf, mp);
    [c, mp] = readVarint(modelBuf, mp);
    if (!condCounts.has(prev)) condCounts.set(prev, new Map());
    condCounts.get(prev).set(cur, c);
  }
  const cumIID = new Array(dV + 1).fill(0);
  for (let s = 0; s < dV; s++) cumIID[s + 1] = cumIID[s] + ((iidCounts.get(s) || 0) + 1);
  const cumCond = new Map();
  for (let prev = 0; prev < dV; prev++) {
    const m = condCounts.get(prev);
    const cum = new Array(dV + 1).fill(0);
    for (let s = 0; s < dV; s++) cum[s + 1] = cum[s] + ((m?.get(s) || 0) + 1);
    cumCond.set(prev, cum);
  }
  // Read encoded sequence
  let nBits; [nBits, p] = readVarint(dec, p);
  let dataLen; [dataLen, p] = readVarint(dec, p);
  const dataBuf = dec.slice(p, p + dataLen); p += dataLen;
  const cumFn = (i, syms) => i === 0 ? cumIID : cumCond.get(syms[i - 1]);
  const decoded = arithmeticDecode(dataBuf, nBits, dN, dV, cumFn);
  dFieldData[f] = { inv, sequence: decoded };
}

// Per-receipt body
const recoveredReceipts = [];
for (let i = 0; i < dN; i++) {
  let sTid; [sTid, p] = readVarint(dec, p);
  let pTid; [pTid, p] = readVarint(dec, p);
  let paylN; [paylN, p] = readVarint(dec, p);
  const paylNums = [];
  for (let k = 0; k < paylN; k++) { let l; [l, p] = readVarint(dec, p); paylNums.push(dec.slice(p, p + l).toString('utf8')); p += l; }
  let mask; [mask, p] = readVarint(dec, p);
  let uniqueN; [uniqueN, p] = readVarint(dec, p);
  const uniqueSummNums = [];
  for (let k = 0; k < uniqueN; k++) { let l; [l, p] = readVarint(dec, p); uniqueSummNums.push(dec.slice(p, p + l).toString('utf8')); p += l; }
  let paylRefN; [paylRefN, p] = readVarint(dec, p);
  const paylRefs = [];
  for (let k = 0; k < paylRefN; k++) { let r; [r, p] = readVarint(dec, p); paylRefs.push(r); }
  // ID tail
  let id;
  if (allIdsMatch) {
    const tail = dec.slice(p, p + 8); p += 8;
    id = 'rcpt_' + tail.toString('hex');
  } else {
    let l; [l, p] = readVarint(dec, p);
    id = dec.slice(p, p + l).toString('utf8'); p += l;
  }

  // Reconstruct summary from template + nums
  const summTmpl = dSumT[sTid];
  let summary;
  if (summTmpl === '\0NULL\0') summary = null;
  else {
    // Walk through template, fill placeholders in order: derivable from paylRefs / uniqueSumNums
    const sumNums = [];
    let derivIdx = 0, uniqIdx = 0;
    // Count placeholders in template
    const phCount = (summTmpl.match(/\x01/g) || []).length;
    for (let k = 0; k < phCount; k++) {
      if (mask & (1 << k)) {
        sumNums.push(paylNums[paylRefs[derivIdx++]]);
      } else {
        sumNums.push(uniqueSummNums[uniqIdx++]);
      }
    }
    let s = summTmpl;
    let nIdx = 0;
    s = s.replace(/\x01/g, () => sumNums[nIdx++]);
    summary = s;
  }
  // Reconstruct payload from template + nums
  const payTmpl = dPayT[pTid];
  let payload_json;
  if (payTmpl === '\0NULL\0') payload_json = null;
  else {
    let s = payTmpl;
    let nIdx = 0;
    s = s.replace(/\x01/g, () => paylNums[nIdx++]);
    payload_json = s;
  }
  recoveredReceipts.push({
    id,
    action: dFieldData.action.inv[dFieldData.action.sequence[i]],
    status: dFieldData.status.inv[dFieldData.status.sequence[i]],
    summary,
    payload_json,
    created_at: dFieldData.created_at.inv[dFieldData.created_at.sequence[i]],
  });
  // Handle nulls
  for (const f of FIELDS_VOCAB) {
    if (recoveredReceipts[i][f] === '\0NULL\0') recoveredReceipts[i][f] = null;
  }
}

const decJsonl = recoveredReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const decSha = crypto.createHash('sha256').update(decJsonl).digest('hex');
const roundtripOk = decSha === corpusSha;
console.log(`  Roundtrip: ${roundtripOk ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);
if (!roundtripOk) {
  const orig = corpusBytes.toString('utf8');
  const minLen = Math.min(orig.length, decJsonl.length);
  for (let i = 0; i < minLen; i++) {
    if (orig[i] !== decJsonl[i]) {
      console.log(`  First diff at byte ${i}:`);
      console.log(`    orig: ...${orig.slice(Math.max(0, i-80), i+80)}...`);
      console.log(`    dec:  ...${decJsonl.slice(Math.max(0, i-80), i+80)}...`);
      break;
    }
  }
}

const receipt = {
  experiment: '19-fused-codec',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  corpus_bytes_in: corpusBytes.length,
  summary_templates: summTemplates.size,
  payload_templates: paylTemplates.size,
  summary_nums_total: totalSummaryNums,
  summary_nums_derivable: derivableSummaryNums,
  summary_derivable_pct: Number((derivableSummaryNums / totalSummaryNums * 100).toFixed(1)),
  all_ids_match_pattern: allIdsMatch,
  pre_brotli_bytes: stream.length,
  brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  beats_plait: ratio > 18.05,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 19 — FUSED CODEC — RESULT

**Status:** ${roundtripOk ? (ratio > 18.05 ? '✅ PASS' : '⚠️ LOSSLESS but below baseline') : '❌ FAIL (lossy)'}
**Generated:** ${receipt.generated_at}

## Components fused
1. Summary template extraction (numerics replaced by placeholders)
2. Payload template extraction
3. Summary-from-payload derivation (which summary numbers exist in payload?)
4. Markov range coding on action / status / created_at
5. ID tail-only encoding (8 bytes vs ~21-byte full string)
6. Brotli final layer

## Findings

| Metric | Value |
|---|---|
| Summary templates | ${summTemplates.size.toLocaleString()} distinct (from 6,224 receipts) |
| Payload templates | ${paylTemplates.size.toLocaleString()} distinct |
| Summary numerics derivable from payload | **${derivableSummaryNums.toLocaleString()} / ${totalSummaryNums.toLocaleString()} (${(derivableSummaryNums / totalSummaryNums * 100).toFixed(1)}%)** |
| All IDs match \`rcpt_<16hex>\` pattern | ${allIdsMatch ? 'YES — 8 bytes per ID' : 'NO — full string per ID'} |

## Compression measurement

| Metric | Value |
|---|---|
| Raw corpus | ${corpusBytes.length.toLocaleString()} B |
| Fused pre-brotli | ${stream.length.toLocaleString()} B |
| Fused + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Ratio** | **${ratio.toFixed(2)}×** |
| Lossless roundtrip | ${roundtripOk ? '✓' : '✗'} |

## Reproduction

\`\`\`
bun 12-ATOMSMASHER/research/compression/experiments/19-fused-codec/bench.mjs
\`\`\`
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
