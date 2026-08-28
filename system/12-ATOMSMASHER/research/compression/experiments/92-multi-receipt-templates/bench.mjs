// Experiment 92 — Multi-receipt template inference.
// Find consecutive sequences of length 3-5 that recur (template-of-actions or template-of-shapes).
// Mine top-100 sequences. Replace each occurrence with template-id + variable values. Brotli the result.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const M19_BASELINE = 47.07;
const TOP_TEMPLATES = 100;
const SEQ_MIN = 3, SEQ_MAX = 5;

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
const detJsonl = detReceipts.map(r => JSON.stringify(r)).join('\n') + '\n';
const detBytes = Buffer.from(detJsonl, 'utf8');
const detSha = crypto.createHash('sha256').update(detBytes).digest('hex');

const tStart = Date.now();

// Build the "shape stream" per receipt: a token derived from (action, status, summary-template, payload-template, created_at-bucket).
// We pick action+status+summary_template+payload_template+created_at as a compact tuple key.

const NUM_RE = /-?\d+(?:\.\d+)?/g;
function templatize(s) { if (s == null) return '\0NULL\0'; return String(s).replace(NUM_RE, '\x01'); }
function templatizeJson(s) { if (s == null) return null; return s.replace(NUM_RE, '\x01'); }

// Per-receipt: numbers from summary + payload (in order)
function extractNums(s) { if (s == null) return []; const ms = String(s).match(NUM_RE); return ms ? [...ms] : []; }

const shapeKeys = [];  // string per receipt
const shapeMeta = []; // { sumNums, payNums, id, created_at_kept_in_shape }
for (const r of detReceipts) {
  const sumTpl = templatize(r.summary);
  const payTpl = templatizeJson(r.payload_json);
  const key = r.action + '\x03' + r.status + '\x03' + sumTpl + '\x03' + (payTpl ?? '\0N\0') + '\x03' + r.created_at;
  shapeKeys.push(key);
  shapeMeta.push({
    sumNums: extractNums(r.summary),
    payNums: r.payload_json ? extractNums(r.payload_json) : [],
  });
}

// Mine consecutive sequences length 3..5 of shapeKeys
const seqMap = new Map(); // seqKey -> { count, firstIdx, len }
for (let len = SEQ_MIN; len <= SEQ_MAX; len++) {
  for (let i = 0; i + len <= N; i++) {
    const k = shapeKeys.slice(i, i + len).join('\x04');
    if (!seqMap.has(k)) seqMap.set(k, { count: 0, len, sampleIdx: i });
    seqMap.get(k).count++;
  }
}

// Score: gain = (count - 1) * (len - 1)  (rough proxy for compression gain)
const ranked = [...seqMap.entries()]
  .filter(([, v]) => v.count >= 2)
  .map(([k, v]) => ({ k, ...v, gain: (v.count - 1) * (v.len - 1) }))
  .sort((a, b) => b.gain - a.gain);

// Pick top K templates, GREEDY non-overlapping coverage (prefer longer-first within score order).
const top = ranked.slice(0, TOP_TEMPLATES);
const templateList = top.map((t, ti) => ({ ti, k: t.k, len: t.len, seqShapes: t.k.split('\x04') }));

// Greedy cover: pass templates in order, for each scan corpus and claim non-overlapping matches.
const claimed = new Int8Array(N); // 0 = free, 1 = claimed start, 2 = claimed body
const matches = []; // { startIdx, templateId, len }
for (const tpl of templateList) {
  const seq = tpl.seqShapes;
  const len = tpl.len;
  for (let i = 0; i + len <= N; i++) {
    let free = true;
    for (let j = 0; j < len; j++) if (claimed[i + j]) { free = false; break; }
    if (!free) continue;
    let match = true;
    for (let j = 0; j < len; j++) if (shapeKeys[i + j] !== seq[j]) { match = false; break; }
    if (!match) continue;
    for (let j = 0; j < len; j++) claimed[i + j] = j === 0 ? 1 : 2;
    matches.push({ start: i, ti: tpl.ti, len });
  }
}

// Sort matches by start; produce position stream:
//   - position i: either "single shape #X" or "template T with start"
matches.sort((a, b) => a.start - b.start);

// Build the position stream: walk i=0..N, emit either template-id (with varlen) or single-shape-id
// Single-shape ids: build shape vocab of UNIQUE shapeKeys for shapes that remain singletons.
const singleShapesNeeded = new Set();
{
  let mi = 0;
  for (let i = 0; i < N; ) {
    if (mi < matches.length && matches[mi].start === i) {
      i += matches[mi].len; mi++;
    } else {
      singleShapesNeeded.add(shapeKeys[i]); i++;
    }
  }
}

// Build single-shape vocab (subset of all shapeKeys)
const singleShapeList = [...singleShapesNeeded];
const singleShapeMap = new Map(singleShapeList.map((k, i) => [k, i]));

// Position stream: tagged varints. Tag 0 = single-shape-idx; Tag 1 = template-id.
// Encode as: byte tag (0/1) + varint(idx). To be denser, interleave or pack into a bitmap + 2 varint streams.
const tagBits = new Uint8Array(Math.ceil(N / 8) + 8); // tag per OUTPUT step (we have fewer steps than N)
const singleIdxStream = [];
const templIdStream = [];
{
  let mi = 0, step = 0;
  for (let i = 0; i < N; ) {
    if (mi < matches.length && matches[mi].start === i) {
      tagBits[step >> 3] |= (1 << (step & 7)); // tag = 1 (template)
      templIdStream.push(matches[mi].ti);
      i += matches[mi].len; mi++;
    } else {
      // tag = 0 (single shape)
      singleIdxStream.push(singleShapeMap.get(shapeKeys[i]));
      i++;
    }
    step++;
  }
}
const totalSteps = singleIdxStream.length + templIdStream.length;
const tagBitsTrunc = tagBits.slice(0, Math.ceil(totalSteps / 8));

// Numbers stream — for EVERY receipt position (template or single), we need the nums (sumNums + payNums).
// Encode as flat varint stream of strings? Numbers come back as strings — encode them as strings joined with \x05.
const numStrStream = [];
for (let i = 0; i < N; i++) {
  numStrStream.push(shapeMeta[i].sumNums.join('\x06'));
  numStrStream.push(shapeMeta[i].payNums.join('\x06'));
}
const numsBlob = Buffer.from(numStrStream.join('\x05'), 'utf8');

// Encode template list (the seq shape strings)
const tplBlob = Buffer.from(templateList.map(t => t.k).join('\x07'), 'utf8');
// Encode single-shape vocab
const singleVocabBlob = Buffer.from(singleShapeList.join('\x07'), 'utf8');

const tagBitsBr = brotli11(Buffer.from(tagBitsTrunc));
const singleIdxBr = brotli11(Buffer.from(singleIdxStream.flatMap(varintU)));
const templIdBr = brotli11(Buffer.from(templIdStream.flatMap(varintU)));
const numsBr = brotli11(numsBlob);
const tplBr = brotli11(tplBlob);
const singleVocabBr = brotli11(singleVocabBlob);
const seedR = brotli11(Buffer.from(JSON.stringify({ seed: SEED, n: N, ts: TOP_TEMPLATES }), 'utf8'));

const encMs = Date.now() - tStart;
const total = tagBitsBr.length + singleIdxBr.length + templIdBr.length + numsBr.length + tplBr.length + singleVocabBr.length + seedR.length;
const ratio = detBytes.length / total;

const coveredByTemplates = matches.reduce((s, m) => s + m.len, 0);

console.log(`=== EXP 92: Multi-Receipt-Templates ===`);
console.log(`Total receipts:        ${N}`);
console.log(`Top templates used:    ${templateList.length}`);
console.log(`Matches:               ${matches.length}`);
console.log(`Positions covered:     ${coveredByTemplates}/${N} (${(coveredByTemplates/N*100).toFixed(1)}%)`);
console.log(`Single shapes:         ${singleShapeList.length} unique, ${singleIdxStream.length} positions`);
console.log(`tag bits:              ${tagBitsBr.length}`);
console.log(`single idx:            ${singleIdxBr.length}`);
console.log(`templ id:              ${templIdBr.length}`);
console.log(`numbers:               ${numsBr.length}`);
console.log(`tpl vocab:             ${tplBr.length}`);
console.log(`single vocab:          ${singleVocabBr.length}`);
console.log(`seed:                  ${seedR.length}`);
console.log(`TOTAL:                 ${total}`);
console.log(`Ratio:                 ${ratio.toFixed(3)}x`);
console.log(`vs M19 (${M19_BASELINE}x):  ${(ratio - M19_BASELINE).toFixed(3)}x`);

// ── Roundtrip ──
const tDecStart = Date.now();
const tagDec = zlib.brotliDecompressSync(tagBitsBr);
const sIdxBuf = zlib.brotliDecompressSync(singleIdxBr);
const tIdBuf = zlib.brotliDecompressSync(templIdBr);
const numsDec = zlib.brotliDecompressSync(numsBr).toString('utf8');
const tplDec = zlib.brotliDecompressSync(tplBr).toString('utf8').split('\x07');
const singleDec = zlib.brotliDecompressSync(singleVocabBr).toString('utf8').split('\x07');
const seedDec = JSON.parse(zlib.brotliDecompressSync(seedR).toString('utf8'));

const sIdxs = []; { let o = 0; while (o < sIdxBuf.length) { const [v, n] = readVarintU(sIdxBuf, o); sIdxs.push(v); o = n; } }
const tIds = []; { let o = 0; while (o < tIdBuf.length) { const [v, n] = readVarintU(tIdBuf, o); tIds.push(v); o = n; } }

const numStrings = numsDec.split('\x05');

// Rebuild shape-key sequence
const shapeKeysDec = new Array(N);
{
  let stepIdx = 0, sCur = 0, tCur = 0, pos = 0;
  while (pos < N) {
    const bit = (tagDec[stepIdx >> 3] >> (stepIdx & 7)) & 1;
    if (bit === 0) {
      shapeKeysDec[pos] = singleDec[sIdxs[sCur++]];
      pos++;
    } else {
      const tid = tIds[tCur++];
      const seqShapes = tplDec[tid].split('\x04');
      for (let j = 0; j < seqShapes.length; j++) shapeKeysDec[pos++] = seqShapes[j];
    }
    stepIdx++;
  }
}

// Reconstruct receipts
const reconstructed = [];
let numI = 0;
for (let i = 0; i < N; i++) {
  const [action, status, sumTpl, payTpl, created_at] = shapeKeysDec[i].split('\x03');
  const sumNumStr = numStrings[numI++];
  const payNumStr = numStrings[numI++];
  const sumNums = sumNumStr === '' ? [] : sumNumStr.split('\x06');
  const payNums = payNumStr === '' ? [] : payNumStr.split('\x06');

  let summary;
  if (sumTpl === '\0NULL\0') summary = null;
  else { let k = 0; summary = sumTpl.replace(/\x01/g, () => sumNums[k++]); }

  let payload_json;
  if (payTpl === '\0N\0') payload_json = null;
  else { let k = 0; payload_json = payTpl.replace(/\x01/g, () => payNums[k++]); }

  reconstructed.push({
    id: detId(seedDec.seed, i),
    action,
    status,
    summary,
    payload_json,
    created_at,
  });
}

const recJsonl = reconstructed.map(r => JSON.stringify(r)).join('\n') + '\n';
const recSha = crypto.createHash('sha256').update(recJsonl).digest('hex');
const lossless = recSha === detSha;
const decMs = Date.now() - tDecStart;

console.log(`Enc ms: ${encMs}, Dec ms: ${decMs}`);
console.log(`Roundtrip: ${lossless ? 'BYTE-EXACT' : 'MISMATCH'}`);
if (!lossless) {
  const det = detBytes.toString('utf8');
  for (let i = 0; i < Math.min(det.length, recJsonl.length); i++) {
    if (det[i] !== recJsonl[i]) {
      console.log(`First diff at byte ${i}:`);
      console.log(`  det: ...${det.slice(Math.max(0, i - 80), i + 80)}...`);
      console.log(`  rec: ...${recJsonl.slice(Math.max(0, i - 80), i + 80)}...`);
      break;
    }
  }
}

const summary = {
  experiment: '92-multi-receipt-templates',
  N,
  top_templates: TOP_TEMPLATES,
  templates_kept: templateList.length,
  matches,
  matches_count: matches.length,
  positions_covered_by_templates: coveredByTemplates,
  coverage_pct: Number(((coveredByTemplates / N) * 100).toFixed(2)),
  unique_single_shapes: singleShapeList.length,
  total_bytes: total,
  ratio: Number(ratio.toFixed(4)),
  vs_m19: Number((ratio - M19_BASELINE).toFixed(4)),
  enc_ms: encMs,
  dec_ms: decMs,
  lossless,
  raw_jsonl_bytes: detBytes.length,
};
// Slim down matches if huge
if (summary.matches_count > 200) delete summary.matches;
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
