// Experiment 41 — Break brotli on the "other shapes" stream
//
// Operator: "break by brotli — it's a perceived wall not impenetrable."
//
// Method 6's bottleneck is the 33,797 B brotli of 1,567 unique non-mesh shapes.
// Attack this stream with multiple alternative codecs and structural transforms.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execSync } from 'node:child_process';

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
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));

const brotli11 = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
function varintU(n) { const b = []; while (n >= 128) { b.push((n & 0x7f) | 0x80); n = Math.floor(n / 128); } b.push(n & 0x7f); return b; }

// Build other-receipts unique shapes (non-mesh)
const otherIdx = [];
for (let i = 0; i < N; i++) if (detReceipts[i].action !== 'mesh.compress') otherIdx.push(i);
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const shapeVocab = new Map();
const shapeList = [];
const otherShapeIdx = [];
for (const i of otherIdx) {
  const k = shapeKey(detReceipts[i]);
  if (!shapeVocab.has(k)) { shapeVocab.set(k, shapeList.length); shapeList.push(k); }
  otherShapeIdx.push(shapeVocab.get(k));
}
const shapesJsonl = shapeList.join('\n') + '\n';
const shapesBytes = Buffer.from(shapesJsonl, 'utf8');
console.log(`Unique non-mesh shapes: ${shapeList.length}, raw bytes ${shapesBytes.length}`);

const baselineBrotli = brotli11(shapesBytes);
console.log(`BASELINE: brotli q11 = ${baselineBrotli.length} B (${(shapesBytes.length / baselineBrotli.length).toFixed(2)}x)\n`);

const results = [];
function R(name, encoded, verify, notes = '') {
  const ratio = shapesBytes.length / encoded;
  results.push({ name, encoded, ratio: Number(ratio.toFixed(2)), verify, notes });
  const mark = verify === true ? '✓' : verify === false ? '✗' : '?';
  console.log(`${name.padEnd(50)} ${encoded.toString().padStart(7)} B  ${ratio.toFixed(2).padStart(6)}x  ${mark}  ${notes}`);
}

// ── A1: brotli with corpus as prefix dictionary (poor man's shared dict) ──
{
  // Take 50% of shapes as dict, encode 50%, measure marginal
  const mid = Math.floor(shapeList.length / 2);
  const dict = Buffer.from(shapeList.slice(0, mid).join('\n') + '\n');
  const target = Buffer.from(shapeList.slice(mid).join('\n') + '\n');
  const both = Buffer.concat([dict, target]);
  const dictOnly = brotli11(dict);
  const bothBr = brotli11(both);
  const marginal = bothBr.length - dictOnly.length;
  // For full corpus encoding: dict + marginal-coded second half
  const total = dictOnly.length + marginal;
  R('A1: brotli+dict 50/50 (marginal)', total, '?', `dict=${dictOnly.length} marg=${marginal}`);
}

// ── A2: Sort shapes by action prefix to maximize LZ77 ──────────────────
{
  const sortedShapes = [...shapeList].sort();
  const sortedBytes = Buffer.from(sortedShapes.join('\n') + '\n');
  const br = brotli11(sortedBytes);
  // Need inverse permutation to restore order
  const permutation = new Array(shapeList.length);
  const sortedIdx = new Map();
  for (let i = 0; i < sortedShapes.length; i++) sortedIdx.set(sortedShapes[i], i);
  for (let i = 0; i < shapeList.length; i++) permutation[i] = sortedIdx.get(shapeList[i]);
  const permBytes = Buffer.from(permutation.flatMap(varintU));
  const permBr = brotli11(permBytes);
  R('A2: sort shapes lex + brotli + perm', br.length + permBr.length, '?', `br=${br.length} perm=${permBr.length}`);
}

// ── A3: Group shapes by action prefix, brotli per-group ────────────────
{
  const byAction = new Map();
  for (let i = 0; i < shapeList.length; i++) {
    try {
      const a = JSON.parse(shapeList[i]).action;
      if (!byAction.has(a)) byAction.set(a, []);
      byAction.get(a).push(i);
    } catch {}
  }
  let total = 0;
  for (const [a, idxs] of byAction) {
    const grp = idxs.map(i => shapeList[i]).join('\n') + '\n';
    total += brotli11(Buffer.from(grp)).length;
  }
  R('A3: per-action grouped brotli', total, '?', `${byAction.size} action groups`);
}

// ── A4: MessagePack-style binary encoding ─────────────────────────────
{
  function encMsg(obj) {
    if (obj === null) return Buffer.from([0xc0]);
    if (typeof obj === 'boolean') return Buffer.from([obj ? 0xc3 : 0xc2]);
    if (typeof obj === 'number') {
      if (Number.isInteger(obj) && obj >= 0 && obj < 256) return Buffer.from([0xcc, obj]);
      if (Number.isInteger(obj) && obj >= 0 && obj < 65536) {
        const b = Buffer.alloc(3); b[0] = 0xcd; b.writeUInt16BE(obj, 1); return b;
      }
      if (Number.isInteger(obj) && obj >= 0 && obj < 2**32) {
        const b = Buffer.alloc(5); b[0] = 0xce; b.writeUInt32BE(obj, 1); return b;
      }
      const b = Buffer.alloc(9); b[0] = 0xcb; b.writeDoubleBE(obj, 1); return b;
    }
    if (typeof obj === 'string') {
      const u = Buffer.from(obj, 'utf8');
      if (u.length < 32) return Buffer.concat([Buffer.from([0xa0 | u.length]), u]);
      if (u.length < 256) return Buffer.concat([Buffer.from([0xd9, u.length]), u]);
      const lenBuf = Buffer.alloc(3); lenBuf[0] = 0xda; lenBuf.writeUInt16BE(u.length, 1);
      if (u.length >= 65536) {
        const lb = Buffer.alloc(5); lb[0] = 0xdb; lb.writeUInt32BE(u.length, 1);
        return Buffer.concat([lb, u]);
      }
      return Buffer.concat([lenBuf, u]);
    }
    if (Array.isArray(obj)) {
      const inner = Buffer.concat(obj.map(encMsg));
      if (obj.length < 16) return Buffer.concat([Buffer.from([0x90 | obj.length]), inner]);
      const lb = Buffer.alloc(3); lb[0] = 0xdc; lb.writeUInt16BE(obj.length, 1);
      return Buffer.concat([lb, inner]);
    }
    if (typeof obj === 'object') {
      const entries = Object.entries(obj);
      const inner = Buffer.concat(entries.flatMap(([k, v]) => [encMsg(k), encMsg(v)]));
      if (entries.length < 16) return Buffer.concat([Buffer.from([0x80 | entries.length]), inner]);
      const lb = Buffer.alloc(3); lb[0] = 0xde; lb.writeUInt16BE(entries.length, 1);
      return Buffer.concat([lb, inner]);
    }
    return Buffer.from([0xc0]);
  }
  const allMsg = Buffer.concat(shapeList.map(s => encMsg(JSON.parse(s))));
  const br = brotli11(allMsg);
  R('A4: MessagePack + brotli', br.length, '?', `msgpack=${allMsg.length}`);
}

// ── A5: Tokenize JSON into key/value stream ───────────────────────────
{
  // For each shape, extract (action, status, summary, payload_json, created_at)
  // and encode as tagged binary
  const allBytes = [];
  function writeStr(s) {
    const u = Buffer.from(s == null ? '' : String(s), 'utf8');
    allBytes.push(...varintU(u.length));
    for (const c of u) allBytes.push(c);
  }
  for (const s of shapeList) {
    const r = JSON.parse(s);
    writeStr(r.action);
    writeStr(r.status);
    writeStr(r.summary);
    writeStr(r.payload_json);
    writeStr(r.created_at);
  }
  const buf = Buffer.from(allBytes);
  const br = brotli11(buf);
  R('A5: field-tagged binary + brotli', br.length, '?', `raw=${buf.length}`);
}

// ── A6: A5 + sub-vocab per field ──────────────────────────────────────
{
  const aV = new Map(), stV = new Map(), sumV = new Map(), payV = new Map(), caV = new Map();
  function getIdx(m, v) { if (!m.has(v)) m.set(v, m.size); return m.get(v); }
  const allBytes = [];
  for (const s of shapeList) {
    const r = JSON.parse(s);
    allBytes.push(...varintU(getIdx(aV, r.action)));
    allBytes.push(...varintU(getIdx(stV, r.status)));
    allBytes.push(...varintU(getIdx(sumV, r.summary || '')));
    allBytes.push(...varintU(getIdx(payV, r.payload_json || '')));
    allBytes.push(...varintU(getIdx(caV, r.created_at)));
  }
  const buf = Buffer.from(allBytes);
  const seqBr = brotli11(buf);

  // Plus vocabularies
  const vocabSeq = [...aV.keys()].join('\x02') + '\x03' +
    [...stV.keys()].join('\x02') + '\x03' +
    [...sumV.keys()].join('\x02') + '\x03' +
    [...payV.keys()].join('\x02') + '\x03' +
    [...caV.keys()].join('\x02');
  const vBr = brotli11(Buffer.from(vocabSeq, 'utf8'));
  R('A6: field-vocab idx + brotli', seqBr.length + vBr.length, '?',
    `seq=${seqBr.length} vocabs=${vBr.length} (aV=${aV.size}, stV=${stV.size}, sumV=${sumV.size}, payV=${payV.size}, caV=${caV.size})`);
}

// ── A7: Templatize sum + pay then vocab + brotli ──────────────────────
{
  const NUM_RE = /-?\d+(?:\.\d+)?(?:e-?\d+)?/g;
  const aV = new Map(), stV = new Map(), sumTV = new Map(), payTV = new Map(), caV = new Map();
  function getIdx(m, v) { if (!m.has(v)) m.set(v, m.size); return m.get(v); }
  const numBytes = [];
  const allBytes = [];
  for (const s of shapeList) {
    const r = JSON.parse(s);
    allBytes.push(...varintU(getIdx(aV, r.action)));
    allBytes.push(...varintU(getIdx(stV, r.status)));
    const sumNums = []; const sumT = (r.summary || '').replace(NUM_RE, m => { sumNums.push(m); return '\x01'; });
    allBytes.push(...varintU(getIdx(sumTV, sumT)));
    allBytes.push(...varintU(sumNums.length));
    for (const n of sumNums) {
      const nb = Buffer.from(n, 'utf8'); allBytes.push(...varintU(nb.length)); for (const c of nb) allBytes.push(c);
    }
    const payNums = []; const payT = (r.payload_json || '').replace(NUM_RE, m => { payNums.push(m); return '\x01'; });
    allBytes.push(...varintU(getIdx(payTV, payT)));
    allBytes.push(...varintU(payNums.length));
    for (const n of payNums) {
      const nb = Buffer.from(n, 'utf8'); allBytes.push(...varintU(nb.length)); for (const c of nb) allBytes.push(c);
    }
    allBytes.push(...varintU(getIdx(caV, r.created_at)));
  }
  const buf = Buffer.from(allBytes);
  const seqBr = brotli11(buf);
  const vocabSeq = [...aV.keys()].join('\x02') + '\x03' +
    [...stV.keys()].join('\x02') + '\x03' +
    [...sumTV.keys()].join('\x02') + '\x03' +
    [...payTV.keys()].join('\x02') + '\x03' +
    [...caV.keys()].join('\x02');
  const vBr = brotli11(Buffer.from(vocabSeq, 'utf8'));
  R('A7: tplized field-vocab + brotli', seqBr.length + vBr.length, '?',
    `seq=${seqBr.length} vocabs=${vBr.length} (sumT=${sumTV.size}, payT=${payTV.size})`);
}

// ── A8: Self-brotli-with-dict (treat full shapesBytes as dict for tail half) ──
{
  // Brotli the corpus twice, measure if iterating helps
  const first = brotli11(shapesBytes);
  const second = brotli11(first);  // brotli already-compressed bytes
  R('A8: brotli twice (silly, just measuring)', second.length, '?', `should be ≥ first; if ≥ confirms incompressibility`);
}

// ── A9: Sort shapes by similarity (greedy nearest-neighbor) ───────────
{
  // For up to 200 shapes, compute pairwise edit distance proxy and greedy sort
  const subset = shapeList.slice(0, Math.min(500, shapeList.length));
  // Use prefix similarity as proxy
  const ordering = [0];
  const used = new Set([0]);
  for (let step = 1; step < subset.length; step++) {
    const prev = subset[ordering[ordering.length - 1]];
    let best = -1, bestSim = -1;
    for (let i = 0; i < subset.length; i++) {
      if (used.has(i)) continue;
      // Common prefix length
      let cpl = 0;
      const max = Math.min(prev.length, subset[i].length);
      while (cpl < max && prev[cpl] === subset[i][cpl]) cpl++;
      if (cpl > bestSim) { bestSim = cpl; best = i; }
    }
    if (best === -1) break;
    used.add(best); ordering.push(best);
  }
  const reordered = ordering.map(i => subset[i]).join('\n') + '\n';
  const br = brotli11(Buffer.from(reordered, 'utf8'));
  const orderingBytes = Buffer.from(ordering.flatMap(varintU));
  const orderingBr = brotli11(orderingBytes);
  const total = br.length + orderingBr.length;
  // Scale up to full corpus
  const projection = total * (shapeList.length / subset.length);
  R('A9: similarity-sort first 500 (projected)', Math.round(projection), '?',
    `actual_500=${total}, scaled to full`);
}

// ── A10: xz -9 -e on shapes ───────────────────────────────────────────
{
  try {
    const tmpIn = process.env.TEMP + '/shapes.bin';
    const tmpOut = process.env.TEMP + '/shapes.xz';
    fs.writeFileSync(tmpIn, shapesBytes);
    execSync(`xz -9 -e -k -f "${tmpIn}"`, { stdio: 'pipe' });
    const xzBytes = fs.readFileSync(tmpIn + '.xz');
    R('A10: xz -9 -e', xzBytes.length, '?', '');
    fs.unlinkSync(tmpIn); fs.unlinkSync(tmpIn + '.xz');
  } catch (e) {
    R('A10: xz -9 -e', baselineBrotli.length, '?', 'CLI failed: ' + e.message.slice(0, 60));
  }
}

// ── A11: brotli q11 vs brotli q11+text+lgwin=24 ──────────────────────
{
  const br1 = zlib.brotliCompressSync(shapesBytes, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_LGWIN]: 24 }});
  R('A11: brotli q11 text-mode lgwin24', br1.length, '?', `delta from baseline ${br1.length - baselineBrotli.length}`);
}

// ── A12: Compress shapes ordered by ACTION+SUMMARY similarity ─────────
{
  // Sort by (action, summary_prefix). Need inverse permutation.
  const indexed = shapeList.map((s, i) => ({ s, i, parsed: JSON.parse(s) }));
  indexed.sort((a, b) => {
    if (a.parsed.action !== b.parsed.action) return a.parsed.action.localeCompare(b.parsed.action);
    return (a.parsed.summary || '').localeCompare(b.parsed.summary || '');
  });
  const reordered = indexed.map(x => x.s).join('\n') + '\n';
  const br = brotli11(Buffer.from(reordered, 'utf8'));
  // Inverse perm: at output position k, original was at indexed[k].i
  const inverse = indexed.map(x => x.i);
  const invBr = brotli11(Buffer.from(inverse.flatMap(varintU)));
  R('A12: action+summary sorted + brotli + invperm', br.length + invBr.length, '?',
    `br=${br.length} invperm=${invBr.length}`);
}

// ── PRINT SORTED ──
console.log(`\n=== SORTED BY ENCODED SIZE (smaller = better) ===`);
const sorted = [...results].sort((a, b) => a.encoded - b.encoded);
for (const r of sorted) {
  const delta = r.encoded - baselineBrotli.length;
  console.log(`${r.encoded.toString().padStart(7)} B  ${r.ratio.toFixed(2).padStart(6)}x  Δ${delta > 0 ? '+' : ''}${delta.toString().padStart(6)}  ${r.name}`);
}
console.log(`\nBaseline (brotli q11): ${baselineBrotli.length} B`);
const best = sorted[0];
const breakBy = baselineBrotli.length - best.encoded;
console.log(`\nBest: ${best.name} = ${best.encoded} B (${breakBy > 0 ? 'BEATS baseline by ' + breakBy + ' B' : 'does not beat baseline'})`);

// ── Compute new full-codec ratio if best beats baseline ──
if (breakBy > 0) {
  // Method 6 was 53,601 B. Replace other-shapes (33,797 B) with best.
  const method6OtherShapes = 33797;
  const method6Total = 53601;
  const newTotal = method6Total - method6OtherShapes + best.encoded;
  const detSize = corpusBytes.length;
  console.log(`\nProjected Method 6 + (${best.name}) replacement:`);
  console.log(`  was: ${method6Total} B = 38.72x`);
  console.log(`  new: ${newTotal} B = ${(detSize / newTotal).toFixed(2)}x`);
}

const out = {
  experiment: '41-break-brotli',
  generated_at: new Date().toISOString(),
  baseline_brotli: baselineBrotli.length,
  results,
  sorted_results: sorted,
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(out, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
