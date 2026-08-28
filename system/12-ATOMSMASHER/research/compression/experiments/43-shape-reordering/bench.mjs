// Experiment 43 — Test multiple shape reordering strategies
//
// Method 8 (lex sort): 32,253 B brotli (-4,034 vs unsorted)
// Try more aggressive reorderings: cluster, suffix-sort, MTF, action+length, etc.

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');

const corpusBytes = fs.readFileSync(CORPUS);
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
const N = receipts.length;

const SEED = 'orange5-receipt-stream-v1';
function detId(s, i) { return 'rcpt_' + crypto.createHash('sha256').update(s + '||' + i).digest('hex').slice(0, 16); }
const detReceipts = receipts.map((r, i) => ({ ...r, id: detId(SEED, i) }));

const brotli11 = b => zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });

const otherIdx = [];
for (let i = 0; i < N; i++) if (detReceipts[i].action !== 'mesh.compress') otherIdx.push(i);
const shapeKey = r => JSON.stringify({ ...r, id: '' });
const unsortedShapes = new Set();
for (const i of otherIdx) unsortedShapes.add(shapeKey(detReceipts[i]));
const shapeList = [...unsortedShapes];
console.log(`Shapes to compress: ${shapeList.length}`);

const baseline = brotli11(Buffer.from(shapeList.join('\n') + '\n', 'utf8')).length;
const lexSorted = brotli11(Buffer.from([...shapeList].sort().join('\n') + '\n', 'utf8')).length;
console.log(`Baseline (insertion order): ${baseline} B`);
console.log(`Lex-sorted (Method 8):      ${lexSorted} B (Δ ${lexSorted - baseline})\n`);

function tryOrder(name, ordering) {
  const reordered = ordering.map(i => shapeList[i]).join('\n') + '\n';
  const br = brotli11(Buffer.from(reordered, 'utf8')).length;
  const delta = br - baseline;
  const vsLex = br - lexSorted;
  console.log(`${name.padEnd(45)} ${br.toString().padStart(6)} B   Δbase ${delta > 0 ? '+' : ''}${delta.toString().padStart(5)}   ΔlexSort ${vsLex > 0 ? '+' : ''}${vsLex}`);
  return br;
}

// B1: Reverse lex
tryOrder('B1: lex sort reversed', shapeList.map((_, i) => i).sort((a, b) => shapeList[b].localeCompare(shapeList[a])));

// B2: Sort by length then content
tryOrder('B2: by-length then lex', shapeList.map((_, i) => i).sort((a, b) => {
  if (shapeList[a].length !== shapeList[b].length) return shapeList[a].length - shapeList[b].length;
  return shapeList[a].localeCompare(shapeList[b]);
}));

// B3: Sort by action then summary then payload
tryOrder('B3: action→summary→payload', shapeList.map((_, i) => i).sort((a, b) => {
  const A = JSON.parse(shapeList[a]), B = JSON.parse(shapeList[b]);
  if (A.action !== B.action) return A.action.localeCompare(B.action);
  if ((A.summary || '') !== (B.summary || '')) return (A.summary || '').localeCompare(B.summary || '');
  return (A.payload_json || '').localeCompare(B.payload_json || '');
}));

// B4: Sort by action then payload_json then summary
tryOrder('B4: action→payload→summary', shapeList.map((_, i) => i).sort((a, b) => {
  const A = JSON.parse(shapeList[a]), B = JSON.parse(shapeList[b]);
  if (A.action !== B.action) return A.action.localeCompare(B.action);
  if ((A.payload_json || '') !== (B.payload_json || '')) return (A.payload_json || '').localeCompare(B.payload_json || '');
  return (A.summary || '').localeCompare(B.summary || '');
}));

// B5: Greedy nearest-neighbor by common prefix length (start from longest shape)
{
  const ordering = [];
  const used = new Set();
  // Start from shortest shape
  let start = 0;
  for (let i = 0; i < shapeList.length; i++) if (shapeList[i].length < shapeList[start].length) start = i;
  ordering.push(start); used.add(start);
  while (used.size < shapeList.length) {
    const cur = shapeList[ordering[ordering.length - 1]];
    let best = -1, bestSim = -1;
    for (let i = 0; i < shapeList.length; i++) {
      if (used.has(i)) continue;
      const t = shapeList[i];
      let cpl = 0;
      const max = Math.min(cur.length, t.length);
      while (cpl < max && cur[cpl] === t[cpl]) cpl++;
      if (cpl > bestSim) { bestSim = cpl; best = i; }
    }
    if (best === -1) break;
    used.add(best); ordering.push(best);
  }
  tryOrder('B5: greedy NN by common prefix', ordering);
}

// B6: Greedy NN by common SUFFIX
{
  const ordering = [];
  const used = new Set();
  ordering.push(0); used.add(0);
  while (used.size < shapeList.length) {
    const cur = shapeList[ordering[ordering.length - 1]];
    let best = -1, bestSim = -1;
    for (let i = 0; i < shapeList.length; i++) {
      if (used.has(i)) continue;
      const t = shapeList[i];
      let cpl = 0;
      const minL = Math.min(cur.length, t.length);
      while (cpl < minL && cur[cur.length - 1 - cpl] === t[t.length - 1 - cpl]) cpl++;
      if (cpl > bestSim) { bestSim = cpl; best = i; }
    }
    if (best === -1) break;
    used.add(best); ordering.push(best);
  }
  tryOrder('B6: greedy NN by common suffix', ordering);
}

// B7: action bucket → sort within bucket by lex
{
  const byAction = new Map();
  for (let i = 0; i < shapeList.length; i++) {
    const a = JSON.parse(shapeList[i]).action;
    if (!byAction.has(a)) byAction.set(a, []);
    byAction.get(a).push(i);
  }
  const ordering = [];
  // Process actions in order of bucket size (largest first → most LZ77 benefit)
  const acts = [...byAction.entries()].sort((a, b) => b[1].length - a[1].length);
  for (const [a, idxs] of acts) {
    idxs.sort((x, y) => shapeList[x].localeCompare(shapeList[y]));
    ordering.push(...idxs);
  }
  tryOrder('B7: action-bucket-largest-first → lex', ordering);
}

// B8: action bucket → sort by length within bucket
{
  const byAction = new Map();
  for (let i = 0; i < shapeList.length; i++) {
    const a = JSON.parse(shapeList[i]).action;
    if (!byAction.has(a)) byAction.set(a, []);
    byAction.get(a).push(i);
  }
  const ordering = [];
  const acts = [...byAction.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [a, idxs] of acts) {
    idxs.sort((x, y) => shapeList[x].length - shapeList[y].length || shapeList[x].localeCompare(shapeList[y]));
    ordering.push(...idxs);
  }
  tryOrder('B8: action-bucket → by length within', ordering);
}

// B9: Use prefix-of-3 chars as cluster key, sort within
{
  const byPrefix = new Map();
  const PREFIX_LEN = 30;
  for (let i = 0; i < shapeList.length; i++) {
    const p = shapeList[i].slice(0, PREFIX_LEN);
    if (!byPrefix.has(p)) byPrefix.set(p, []);
    byPrefix.get(p).push(i);
  }
  const prefixes = [...byPrefix.keys()].sort();
  const ordering = [];
  for (const p of prefixes) {
    const idxs = byPrefix.get(p).sort((a, b) => shapeList[a].localeCompare(shapeList[b]));
    ordering.push(...idxs);
  }
  tryOrder('B9: 30-char prefix cluster + lex within', ordering);
}

// B10: Custom-key brotli dict — prepend the most common substrings
{
  // Extract top 50 substrings of length 20-50 across all shapes
  const substrCounts = new Map();
  for (const s of shapeList) {
    for (let L = 30; L <= 80; L += 10) {
      for (let i = 0; i <= s.length - L; i += 7) {
        const sub = s.substr(i, L);
        substrCounts.set(sub, (substrCounts.get(sub) || 0) + 1);
      }
    }
  }
  const topSubs = [...substrCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 100);
  const dict = topSubs.map(([s, _]) => s).join('\0');
  const combined = dict + '\n' + shapeList.join('\n') + '\n';
  const fullBr = brotli11(Buffer.from(combined, 'utf8'));
  const dictBr = brotli11(Buffer.from(dict, 'utf8'));
  // Marginal = fullBr - dictBr (approximation; not exact but useful)
  console.log(`B10: top-100 substrings dict prefix      ${(fullBr.length - dictBr.length).toString().padStart(6)} B   approx marginal (dict=${dictBr.length} full=${fullBr.length})`);
}

// B11: try x2 concatenation — brotli's window may benefit from seeing same content twice
{
  const doubled = shapeList.join('\n') + '\n' + shapeList.join('\n') + '\n';
  const fullBr = brotli11(Buffer.from(doubled, 'utf8')).length;
  // Marginal ~= fullBr - baseline (approximate)
  console.log(`B11: corpus concat 2× (silly)            ${fullBr.toString().padStart(6)} B   total of 2 copies; marginal approx ${fullBr - baseline}`);
}

// B12: Sort by reverse string (suffix order = BWT-like)
{
  const indexed = shapeList.map((s, i) => ({ s, i }));
  indexed.sort((a, b) => {
    const ra = a.s.split('').reverse().join('');
    const rb = b.s.split('').reverse().join('');
    return ra.localeCompare(rb);
  });
  tryOrder('B12: sort by REVERSED string', indexed.map(x => x.i));
}

// ── Print sorted summary ──
console.log(`\nBaseline: ${baseline} | Lex sort (Method 8): ${lexSorted}`);
