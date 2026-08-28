// Experiment 69 — Action-column RLE
// Hypothesis: RLE of high-cardinality but heavily-repeated columns frees brotli
// from re-tokenizing.
//
// IMPORTANT: corpus is sorted by id, not by action — RLE on natural order will
// produce short runs (often length 1). This experiment honestly measures that.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const RAW = corpusBytes.length;

console.log(`corpus bytes: ${RAW}`);
console.log(`corpus sha:   ${corpusSha}`);

// ── helpers ────────────────────────────────────────────────────────────────
function brotli11(b) {
  return zlib.brotliCompressSync(b, {
    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
  });
}
function brotliDec(b) { return zlib.brotliDecompressSync(b); }
function varintU(n) {
  const b = [];
  while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); }
  b.push(n & 0x7f);
  return b;
}
function readVarintU(buf, ofs) {
  let n = 0, m = 1, b;
  do { b = buf[ofs++]; n += (b & 0x7f) * m; m *= 128; } while (b & 0x80);
  return [n, ofs];
}

// ── parse corpus, preserving line order and exact line bytes ──────────────
const text = corpusBytes.toString('utf8');
const lines = text.split('\n');
const trailingNewline = lines[lines.length - 1] === '';
const dataLines = trailingNewline ? lines.slice(0, -1) : lines;
const N = dataLines.length;
console.log(`receipts: ${N}`);

// Track the exact action substring for each line so we can re-insert exactly.
// JSON.stringify ordering matters; we operate at string level for the action
// field but parse for the rest. To re-emit exactly, we strip the
// `"action":"<value>",` segment from each original line and store the
// remainder. On decode we splice the action back in at the same position.

const actionRegex = /^(\{"id":"[^"]+",)("action":"([^"]+)",)/;

const restLines = new Array(N);
const actionIdxStream = new Array(N);
const actionVocab = []; // ordered by first appearance
const actionIndex = new Map();

for (let i = 0; i < N; i++) {
  const ln = dataLines[i];
  const m = ln.match(actionRegex);
  if (!m) {
    throw new Error(`Line ${i} did not match action pattern: ${ln.slice(0, 120)}`);
  }
  const prefix = m[1];          // {"id":"...",
  const actionSeg = m[2];        // "action":"...",
  const actionVal = m[3];        // value
  const rest = ln.slice(prefix.length + actionSeg.length); // everything after action segment
  // rest line = prefix + rest, with action segment removed
  restLines[i] = prefix + rest;
  if (!actionIndex.has(actionVal)) {
    actionIndex.set(actionVal, actionVocab.length);
    actionVocab.push(actionVal);
  }
  actionIdxStream[i] = actionIndex.get(actionVal);
}
console.log(`unique actions: ${actionVocab.length}`);
if (actionVocab.length > 255) {
  throw new Error(`Action vocab > 255 — need 2-byte index, spec says 1-byte`);
}

// ── encode ────────────────────────────────────────────────────────────────
const t0 = performance.now();

// 1) Action vocabulary: join with \x02 separator, brotli q11
const vocabBlob = brotli11(Buffer.from(actionVocab.join('\x02'), 'utf8'));

// 2) Action RLE stream: (varint run_length, 1 byte idx) pairs
const rleBytes = [];
let runStart = 0;
let runIdx = actionIdxStream[0];
let runLen = 1;
let runCount = 0;
for (let i = 1; i < N; i++) {
  if (actionIdxStream[i] === runIdx) {
    runLen++;
  } else {
    rleBytes.push(...varintU(runLen));
    rleBytes.push(runIdx);
    runCount++;
    runIdx = actionIdxStream[i];
    runLen = 1;
  }
}
rleBytes.push(...varintU(runLen));
rleBytes.push(runIdx);
runCount++;
const rleBuf = Buffer.from(rleBytes);
// Spec says: RLE(action_stream) — NOT brotli'd. We'll emit it raw.
// (Quick experiment: also try brotli'd for the "rest" blob only, per spec.)

// 3) Rest of receipts: concat all rest-lines with \n, brotli q11
const restJoined = restLines.join('\n') + (trailingNewline ? '\n' : '');
const restBlob = brotli11(Buffer.from(restJoined, 'utf8'));

// 4) Header: varint(N), varint(actionVocab.length), varint(vocabBlob.len),
//    varint(rleBuf.len), varint(restBlob.len), varint(trailingNewline?1:0)
const header = [];
header.push(...varintU(N));
header.push(...varintU(actionVocab.length));
header.push(...varintU(vocabBlob.length));
header.push(...varintU(rleBuf.length));
header.push(...varintU(restBlob.length));
header.push(trailingNewline ? 1 : 0);
const headerBuf = Buffer.from(header);

const total = headerBuf.length + vocabBlob.length + rleBuf.length + restBlob.length;
const ratio = RAW / total;
const encode_ms = +(performance.now() - t0).toFixed(2);

console.log(`\n=== EXPERIMENT 69 — Action-column RLE ===`);
console.log(`header:        ${headerBuf.length}`);
console.log(`action vocab:  ${vocabBlob.length}`);
console.log(`action RLE:    ${rleBuf.length} bytes (${runCount} runs over ${N} rows; mean run len ${(N/runCount).toFixed(2)})`);
console.log(`rest (br q11): ${restBlob.length}`);
console.log(`TOTAL:         ${total}`);
console.log(`Ratio:         ${ratio.toFixed(2)}x`);

// ── decode ────────────────────────────────────────────────────────────────
const t1 = performance.now();

// We can hand-pack/unpack since we know layout. Read header.
const packed = Buffer.concat([headerBuf, vocabBlob, rleBuf, restBlob]);
let ofs = 0;
const [decN, o1] = readVarintU(packed, ofs); ofs = o1;
const [decVocabCount, o2] = readVarintU(packed, ofs); ofs = o2;
const [decVocabLen, o3] = readVarintU(packed, ofs); ofs = o3;
const [decRleLen, o4] = readVarintU(packed, ofs); ofs = o4;
const [decRestLen, o5] = readVarintU(packed, ofs); ofs = o5;
const decTrailingNL = packed[ofs++];

const decVocabBlob = packed.slice(ofs, ofs + decVocabLen); ofs += decVocabLen;
const decRleBuf = packed.slice(ofs, ofs + decRleLen); ofs += decRleLen;
const decRestBlob = packed.slice(ofs, ofs + decRestLen); ofs += decRestLen;

const decVocab = brotliDec(decVocabBlob).toString('utf8').split('\x02');
if (decVocab.length !== decVocabCount) {
  throw new Error(`vocab count mismatch: ${decVocab.length} != ${decVocabCount}`);
}

// Walk RLE → materialize one action index per row
const decActionIdx = new Array(decN);
{
  let p = 0, row = 0;
  while (p < decRleBuf.length) {
    const [rlen, np] = readVarintU(decRleBuf, p); p = np;
    const idx = decRleBuf[p++];
    for (let k = 0; k < rlen; k++) decActionIdx[row++] = idx;
  }
  if (row !== decN) throw new Error(`RLE expanded to ${row}, expected ${decN}`);
}

const decRestText = brotliDec(decRestBlob).toString('utf8');
const decRestLines = decTrailingNL
  ? decRestText.endsWith('\n')
    ? decRestText.slice(0, -1).split('\n')
    : decRestText.split('\n')
  : decRestText.split('\n');
if (decRestLines.length !== decN) {
  throw new Error(`rest lines: ${decRestLines.length} != ${decN}`);
}

// Reinsert action segment after the id segment
const restoredLines = new Array(decN);
const idPrefixRegex = /^(\{"id":"[^"]+",)/;
for (let i = 0; i < decN; i++) {
  const rest = decRestLines[i];
  const m = rest.match(idPrefixRegex);
  if (!m) throw new Error(`row ${i} rest has no id prefix: ${rest.slice(0, 120)}`);
  const prefix = m[1];
  const after = rest.slice(prefix.length);
  const actionVal = decVocab[decActionIdx[i]];
  restoredLines[i] = prefix + `"action":"${actionVal}",` + after;
}

const restoredText = restoredLines.join('\n') + (decTrailingNL ? '\n' : '');
const restoredBuf = Buffer.from(restoredText, 'utf8');
const restoredSha = crypto.createHash('sha256').update(restoredBuf).digest('hex');
const lossless = restoredSha === corpusSha;
const decode_ms = +(performance.now() - t1).toFixed(2);

console.log(`\nRoundtrip: ${lossless ? '✓ BYTE-EXACT' : '✗ MISMATCH'}`);
console.log(`restored sha: ${restoredSha}`);
console.log(`encode: ${encode_ms} ms · decode: ${decode_ms} ms`);

if (!lossless) {
  // Show first diff
  const det = corpusBytes;
  const rec = restoredBuf;
  console.log(`corpus len: ${det.length} · restored len: ${rec.length}`);
  const lim = Math.min(det.length, rec.length);
  for (let i = 0; i < lim; i++) {
    if (det[i] !== rec[i]) {
      console.log(`First diff at byte ${i}:`);
      const start = Math.max(0, i - 60);
      console.log(`  det: ...${det.slice(start, i + 60).toString('utf8')}...`);
      console.log(`  rec: ...${rec.slice(start, i + 60).toString('utf8')}...`);
      break;
    }
  }
}

// ── verdict ───────────────────────────────────────────────────────────────
const BASELINE = 47.07;
const delta = ratio - BASELINE;
console.log(`\nvs Method 19 (${BASELINE}x): ${delta >= 0 ? `+${delta.toFixed(2)}x` : delta.toFixed(2) + 'x'}`);

const summary = {
  experiment: '69-action-rle',
  ratio: +ratio.toFixed(2),
  encode_ms,
  decode_ms,
  lossless,
  notes: `Action-column RLE on corpus sorted-by-id. ${actionVocab.length} unique actions over ${N} rows produced ${runCount} runs (mean run length ${(N/runCount).toFixed(2)}). Rest brotli q11: ${restBlob.length}B, RLE raw: ${rleBuf.length}B, vocab brotli: ${vocabBlob.length}B, header: ${headerBuf.length}B. Total ${total}B vs baseline 44095B.`,
};
fs.writeFileSync(path.join(ROOT, 'summary.json'), JSON.stringify(summary, null, 2));
console.log(`\n--- summary.json ---`);
console.log(JSON.stringify(summary, null, 2));
