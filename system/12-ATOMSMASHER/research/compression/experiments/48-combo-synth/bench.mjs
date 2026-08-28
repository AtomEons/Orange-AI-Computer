// Sweep 20 codec variations and tabulate

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verify } from './codec.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const receipts = corpusBytes.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Corpus: ${corpusBytes.length} B, ${N} receipts`);

// ── Variation matrix ──
const variations = [
  { name: 'V01: ALL wins (Method 10 reference)', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V02: ALL + brotli x1 (no twice)', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 1, stripAction: false, airDecomp: false } },
  { name: 'V03: ALL minus schemaFold', cfg: { detIds: true, dedupe: true, schemaFold: false, meshDecomp: true, sortStyle: 'b8', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V04: ALL minus meshDecomp', cfg: { detIds: true, dedupe: true, schemaFold: false, meshDecomp: false, sortStyle: 'b8', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V05: ALL minus dedupe', cfg: { detIds: true, dedupe: false, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V06: ALL minus detIds', cfg: { detIds: false, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V07: ALL minus sort (insertion order)', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'insertion', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V08: ALL with lex sort', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'lex', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V09: ALL with b4 sort (action→payload→summary)', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b4', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V10: ALL with rev-len sort', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'rev-len', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V11: ALL with by-length sort', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'by-length', brotliPasses: 2, stripAction: false, airDecomp: false } },
  { name: 'V12: ALL + stripAction', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 2, stripAction: true, airDecomp: false } },
  { name: 'V13: ALL + airDecomp', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 2, stripAction: false, airDecomp: true } },
  { name: 'V14: ALL + airDecomp + stripAction', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 2, stripAction: true, airDecomp: true } },
  { name: 'V15: brotli x3 on shapes', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 3, stripAction: false, airDecomp: false } },
  { name: 'V16: brotli x4 on shapes', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 4, stripAction: false, airDecomp: false } },
  { name: 'V17: MINIMAL (no wins, dedupe+brotli only)', cfg: { detIds: false, dedupe: true, schemaFold: false, meshDecomp: false, sortStyle: 'insertion', brotliPasses: 1, stripAction: false, airDecomp: false } },
  { name: 'V18: ALL + b4 + brotli x3 + airDecomp', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b4', brotliPasses: 3, stripAction: false, airDecomp: true } },
  { name: 'V19: ALL + lex + airDecomp', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'lex', brotliPasses: 2, stripAction: false, airDecomp: true } },
  { name: 'V20: ALL with brotli q11 once and stripAction', cfg: { detIds: true, dedupe: true, schemaFold: true, meshDecomp: true, sortStyle: 'b8', brotliPasses: 1, stripAction: true, airDecomp: false } },
];

const results = [];
console.log(`\nRunning ${variations.length} variations...\n`);
console.log(`${'V'.padEnd(60)} ${'total'.padStart(7)}   ${'ratio'.padStart(6)}  lossless`);
console.log('─'.repeat(95));

for (const { name, cfg } of variations) {
  try {
    const r = verify(receipts, cfg);
    const ratio = corpusBytes.length / r.total;
    results.push({ name, total: r.total, ratio: Number(ratio.toFixed(2)), lossless: r.lossless, components: r.components, cfg });
    const mark = r.lossless ? '✓' : '✗';
    console.log(`${name.padEnd(60)} ${r.total.toString().padStart(7)} B ${ratio.toFixed(2).padStart(6)}x   ${mark}`);
  } catch (e) {
    console.log(`${name.padEnd(60)} ERROR: ${e.message.slice(0, 50)}`);
    results.push({ name, error: e.message, cfg });
  }
}

console.log('\n=== SORTED BY RATIO (LOSSLESS ONLY) ===');
const lossless = results.filter(r => r.lossless).sort((a, b) => b.ratio - a.ratio);
for (const r of lossless) {
  console.log(`${r.ratio.toFixed(2).padStart(7)}x  ${r.total.toString().padStart(7)} B  ${r.name}`);
}

const champ = lossless[0];
console.log(`\n🏆 Champion: ${champ?.name}`);
console.log(`   Ratio: ${champ?.ratio.toFixed(2)}x   Total: ${champ?.total} B`);
console.log(`   Components: ${JSON.stringify(champ?.components)}`);

console.log('\n=== LOSSY VARIATIONS (excluded from leaderboard) ===');
const lossy = results.filter(r => r.lossless === false);
for (const r of lossy) {
  console.log(`  ${r.name} (ratio would be ${r.ratio?.toFixed(2)}x but failed roundtrip)`);
}

fs.writeFileSync(RECEIPT_FILE, JSON.stringify({
  experiment: '48-combo-synth',
  generated_at: '2026-06-27',
  total_variations: variations.length,
  results,
  champion: champ,
}, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
