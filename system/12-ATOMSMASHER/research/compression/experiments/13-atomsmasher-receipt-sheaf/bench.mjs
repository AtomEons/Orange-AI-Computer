// Experiment 13 — AtomSmasher Receipt Sheaf (ARS, custom design, not Čech)
//
// Operator directive 2026-06-26: "create your own sheaf not based on Čech.
// the per-receipt component_id + 5-field residual overhead is a solvable X."
//
// ARS design:
//   Base space: receipt-DAG.
//   Stratification by action (engine family) — 38 strata observed.
//   Per stratum:
//     - extract STRUCTURAL TEMPLATE from payload_json (the common JSON layout)
//     - represent each receipt as (template_id, parameter_vector, action_id,
//       summary, id, ts) where parameter_vector holds only the VARYING numerical
//       bits between receipts of the same template
//   Encode:
//     - H^0: { distinct actions, templates, summary vocab, id vocab, ts deltas }
//     - H^1: per-receipt parameter realizations (the irreducible info)
//   Key fix vs Exp 08 (Čech): RLE the action sequence (avg run 1.48) →
//     component_id becomes nearly free; parameter vectors are tight numeric arrays.

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
  fs.writeFileSync(HYP, `# Experiment 13 — AtomSmasher Receipt Sheaf (ARS)

## Hypothesis
Custom sheaf not based on Čech closure. Stratify by action; extract per-action structural templates from payload_json; isolate numeric parameter vectors as irreducible H^1; encode action sequence via RLE (it has avg run length 1.48).

This addresses Experiment 08's overhead-bound shortfall: instead of per-receipt component_id + 5-vocab residual, we get template_id (rare changes) + tight parameter arrays.

## Predicted ratio
20–30× full corpus. Solving for X = the per-receipt overhead in Exp 08.

## Pass criterion
PASS if ratio > 18.05× plait baseline AND lossless via sha256 roundtrip.
`);
}

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Loaded ${receipts.length} receipts, ${corpusBytes.length} B`);

// ─── Step 1: extract STRUCTURAL TEMPLATE per receipt ────────────────────────
// Template = payload_json with all numeric values replaced by a placeholder.
// Parameters = the extracted numerics + their positions.
const NUMBER_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
function templateAndParams(payloadJson) {
  if (payloadJson == null) return { template: '\0NULL\0', params: [] };
  const s = String(payloadJson);
  const params = [];
  const template = s.replace(NUMBER_RE, (m) => { params.push(m); return ''; });
  return { template, params };
}

// Build per-receipt template+params + collect global vocabularies
const recTemplates = [];
const templateVocab = new Map(); // template string → template_id
const allParams = []; // flat list of all params (per-receipt arrays joined)
function lookup(m, k) { let v = m.get(k); if (v === undefined) { v = m.size; m.set(k, v); } return v; }

for (const r of receipts) {
  const { template, params } = templateAndParams(r.payload_json);
  const tid = lookup(templateVocab, template);
  recTemplates.push({ tid, params });
  for (const p of params) allParams.push(p);
}
console.log(`\nStructural templates extracted: ${templateVocab.size} distinct from ${receipts.length} receipts`);
console.log(`Total numeric parameters:        ${allParams.length}`);
console.log(`Template-collapse ratio:         ${(receipts.length / templateVocab.size).toFixed(2)}x`);

// ─── Step 2: per-action stratification + action RLE ─────────────────────────
const actionVocab = new Map();
for (const r of receipts) lookup(actionVocab, r.action);
const actionSeq = receipts.map(r => actionVocab.get(r.action));
// RLE the action sequence
const rlePairs = [];
let curA = actionSeq[0], runLen = 1;
for (let i = 1; i < actionSeq.length; i++) {
  if (actionSeq[i] === curA) runLen++;
  else { rlePairs.push([curA, runLen]); curA = actionSeq[i]; runLen = 1; }
}
rlePairs.push([curA, runLen]);
console.log(`\nAction sequence: ${actionVocab.size} distinct, ${rlePairs.length} RLE pairs (avg run ${(actionSeq.length / rlePairs.length).toFixed(2)})`);

// ─── Step 3: residual field vocabularies (id, status, summary, ts) ──────────
const residualFields = ['id', 'status', 'summary', 'created_at'];
const fieldVocabs = Object.fromEntries(residualFields.map(f => [f, new Map()]));
for (const r of receipts) for (const f of residualFields) lookup(fieldVocabs[f], r[f] == null ? '\0NULL\0' : String(r[f]));

// ─── Step 4: encode ARS stream ──────────────────────────────────────────────
function varint(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return Buffer.from(b); }
function readVarint(buf, ofs) { let n = 0, m = 1, b; do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80); return [n, ofs]; }
function writeStr(s) { const b = Buffer.from(s, 'utf8'); return [varint(b.length), b]; }

const out = [];
// Header
out.push(varint(receipts.length));

// Action vocab + RLE
out.push(varint(actionVocab.size));
for (const a of actionVocab.keys()) out.push(...writeStr(a));
out.push(varint(rlePairs.length));
for (const [aid, len] of rlePairs) out.push(varint(aid), varint(len));

// Template vocab
out.push(varint(templateVocab.size));
for (const t of templateVocab.keys()) out.push(...writeStr(t));

// Per-receipt: template_id + parameter array (variable length)
for (const rec of recTemplates) {
  out.push(varint(rec.tid));
  out.push(varint(rec.params.length));
  for (const p of rec.params) out.push(...writeStr(p));
}

// Residual fields (id, status, summary, ts)
out.push(varint(residualFields.length));
for (const f of residualFields) {
  out.push(...writeStr(f));
  out.push(varint(fieldVocabs[f].size));
  for (const v of fieldVocabs[f].keys()) out.push(...writeStr(v));
}
for (const r of receipts) {
  for (const f of residualFields) {
    const val = r[f] == null ? '\0NULL\0' : String(r[f]);
    out.push(varint(fieldVocabs[f].get(val)));
  }
}

const stream = Buffer.concat(out);
const brotli = zlib.brotliCompressSync(stream, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const ratio = corpusBytes.length / brotli.length;
console.log(`\nARS stream pre-brotli: ${stream.length} B`);
console.log(`ARS + brotli q11:      ${brotli.length} B`);
console.log(`Ratio vs raw corpus:   ${ratio.toFixed(2)}x`);

// ─── Step 5: lossless roundtrip ────────────────────────────────────────────
const dec = zlib.brotliDecompressSync(brotli);
let p = 0;
let v;
[v, p] = readVarint(dec, p); const dN = v;
[v, p] = readVarint(dec, p); const dActSize = v;
const dActions = [];
for (let i = 0; i < dActSize; i++) { let len; [len, p] = readVarint(dec, p); dActions.push(dec.slice(p, p + len).toString('utf8')); p += len; }
[v, p] = readVarint(dec, p); const dRleLen = v;
const dRle = [];
for (let i = 0; i < dRleLen; i++) { let aid, ln; [aid, p] = readVarint(dec, p); [ln, p] = readVarint(dec, p); dRle.push([aid, ln]); }
// Expand RLE to per-receipt action_id
const dActionSeq = [];
for (const [aid, ln] of dRle) for (let i = 0; i < ln; i++) dActionSeq.push(aid);

[v, p] = readVarint(dec, p); const dTemplSize = v;
const dTemplates = [];
for (let i = 0; i < dTemplSize; i++) { let len; [len, p] = readVarint(dec, p); dTemplates.push(dec.slice(p, p + len).toString('utf8')); p += len; }

const dRecTempl = [];
for (let i = 0; i < dN; i++) {
  let tid; [tid, p] = readVarint(dec, p);
  let pCount; [pCount, p] = readVarint(dec, p);
  const params = [];
  for (let j = 0; j < pCount; j++) { let len; [len, p] = readVarint(dec, p); params.push(dec.slice(p, p + len).toString('utf8')); p += len; }
  dRecTempl.push({ tid, params });
}

[v, p] = readVarint(dec, p); const dFCount = v;
const dFields = [];
const dFieldVocabs = {};
for (let i = 0; i < dFCount; i++) {
  let len; [len, p] = readVarint(dec, p); const f = dec.slice(p, p + len).toString('utf8'); p += len;
  dFields.push(f);
  [v, p] = readVarint(dec, p); const vSize = v;
  const inv = [];
  for (let j = 0; j < vSize; j++) { [len, p] = readVarint(dec, p); inv.push(dec.slice(p, p + len).toString('utf8')); p += len; }
  dFieldVocabs[f] = inv;
}
// Reconstruct
const decoded = [];
for (let i = 0; i < dN; i++) {
  const r = {};
  for (const f of dFields) {
    [v, p] = readVarint(dec, p);
    const val = dFieldVocabs[f][v];
    r[f] = val === '\0NULL\0' ? null : val;
  }
  // Reconstruct payload from template + params
  const tmpl = dTemplates[dRecTempl[i].tid];
  if (tmpl === '\0NULL\0') r.payload_json = null;
  else {
    let payload = tmpl;
    let pi = 0;
    payload = payload.replace(//g, () => dRecTempl[i].params[pi++]);
    r.payload_json = payload;
  }
  r.action = dActions[dActionSeq[i]];
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
if (!roundtripOk) {
  // Show first diff for debugging
  const orig = corpusBytes.toString('utf8');
  const minLen = Math.min(orig.length, decJsonl.length);
  for (let i = 0; i < minLen; i++) {
    if (orig[i] !== decJsonl[i]) {
      const ctx = 80;
      console.log(`First diff at byte ${i}:`);
      console.log(`  orig: ...${orig.slice(Math.max(0, i-ctx), i+ctx)}...`);
      console.log(`  dec:  ...${decJsonl.slice(Math.max(0, i-ctx), i+ctx)}...`);
      break;
    }
  }
}

const receipt = {
  experiment: '13-atomsmasher-receipt-sheaf',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  corpus_bytes_in: corpusBytes.length,
  num_receipts: receipts.length,
  template_count: templateVocab.size,
  template_collapse_ratio: Number((receipts.length / templateVocab.size).toFixed(2)),
  total_numeric_parameters: allParams.length,
  rle_pairs: rlePairs.length,
  avg_run_length: Number((actionSeq.length / rlePairs.length).toFixed(2)),
  ars_stream_bytes: stream.length,
  ars_brotli_bytes: brotli.length,
  ratio: Number(ratio.toFixed(2)),
  roundtrip_lossless: roundtripOk,
  beats_plait_baseline: ratio > 18.05,
  pass: roundtripOk && ratio > 18.05,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));

const resultMd = `# Experiment 13 — AtomSmasher Receipt Sheaf (ARS) — RESULT

**Status:** ${receipt.pass ? '✅ PASS' : roundtripOk ? '⚠️ LOSSLESS but below baseline' : '❌ FAIL (lossy)'}
**Generated:** ${receipt.generated_at}

## ARS topology

| Metric | Value |
|---|---|
| Receipts | ${receipts.length.toLocaleString()} |
| **Structural templates** | **${templateVocab.size}** (numerals replaced by placeholders) |
| Template-collapse ratio | ${(receipts.length / templateVocab.size).toFixed(2)}× |
| Total numeric parameters | ${allParams.length.toLocaleString()} |
| Action RLE pairs | ${rlePairs.length} (avg run ${(actionSeq.length / rlePairs.length).toFixed(2)}) |

## Compression

| Metric | Value |
|---|---|
| Raw corpus | ${corpusBytes.length.toLocaleString()} B |
| ARS pre-brotli | ${stream.length.toLocaleString()} B |
| ARS + Brotli q11 | ${brotli.length.toLocaleString()} B |
| **Ratio** | **${ratio.toFixed(2)}×** |
| Lossless | ${roundtripOk ? '✓' : '✗'} |

## Analysis

${receipt.pass ?
  `ARS beats Experiment 07 plait baseline (18.05×). Custom sheaf design — stratifying by action + extracting structural templates + RLE action sequence — addresses the per-receipt overhead that bounded Čech sheaf cohomology (Experiment 08 at 16.28×).` :
  roundtripOk ?
    `ARS at ${ratio.toFixed(2)}× is lossless but does not beat plait (18.05×). Template extraction gave ${(receipts.length / templateVocab.size).toFixed(2)}× collapse but per-receipt parameter vectors still dominate the byte count.` :
    `Lossy — REJECT.`}
`;
fs.writeFileSync(RESULT_FILE, resultMd);
console.log(`\nResult: ${RESULT_FILE}`);
