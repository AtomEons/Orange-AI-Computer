// Experiment 49 — All 768 codec permutations
//
// 8 toggles: detIds × dedupe × schemaFold × meshDecomp × stripAction × airDecomp × sortStyle × brotliPasses
//   = 2 × 2 × 2 × 2 × 2 × 2 × 6 × 4 = 768
//
// For each: encode, decode, verify byte-exact lossless, record ratio.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verify } from '../48-combo-synth/codec.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');
const RESULTS_FILE = path.join(ROOT, 'all-results.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const receipts = corpusBytes.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Corpus: ${corpusBytes.length} B, ${N} receipts`);

const SORT_STYLES = ['insertion', 'lex', 'b8', 'b4', 'rev-len', 'by-length'];
const BROTLI_PASSES = [1, 2, 3, 4];

// Generate all permutations
const allCfgs = [];
for (const detIds of [false, true])
for (const dedupe of [false, true])
for (const schemaFold of [false, true])
for (const meshDecomp of [false, true])
for (const stripAction of [false, true])
for (const airDecomp of [false, true])
for (const sortStyle of SORT_STYLES)
for (const brotliPasses of BROTLI_PASSES)
  allCfgs.push({ detIds, dedupe, schemaFold, meshDecomp, stripAction, airDecomp, sortStyle, brotliPasses });

console.log(`Total permutations: ${allCfgs.length}\n`);

const t0 = Date.now();
const results = [];
let errs = 0, lossyCount = 0, losslessCount = 0;

for (let i = 0; i < allCfgs.length; i++) {
  const cfg = allCfgs[i];
  try {
    const r = verify(receipts, cfg);
    const ratio = corpusBytes.length / r.total;
    results.push({ cfg, total: r.total, ratio: Number(ratio.toFixed(3)), lossless: r.lossless });
    if (r.lossless) losslessCount++; else lossyCount++;
  } catch (e) {
    results.push({ cfg, error: e.message.slice(0, 80) });
    errs++;
  }
  if ((i + 1) % 50 === 0) {
    const elapsed = (Date.now() - t0) / 1000;
    const rate = (i + 1) / elapsed;
    const eta = (allCfgs.length - i - 1) / rate;
    console.log(`  Progress: ${i + 1}/${allCfgs.length}  (${(rate).toFixed(1)}/s, ETA ${eta.toFixed(0)}s)  lossless=${losslessCount}  lossy=${lossyCount}  errs=${errs}`);
  }
}

const elapsedTotal = (Date.now() - t0) / 1000;
console.log(`\nDone in ${elapsedTotal.toFixed(0)}s. Lossless: ${losslessCount}, Lossy: ${lossyCount}, Errors: ${errs}\n`);

// Sort lossless by ratio
const lossless = results.filter(r => r.lossless).sort((a, b) => b.ratio - a.ratio);

console.log(`=== TOP 30 LOSSLESS PERMUTATIONS ===`);
for (const r of lossless.slice(0, 30)) {
  const c = r.cfg;
  const flags = `${c.detIds?'D':'.'}${c.dedupe?'d':'.'}${c.schemaFold?'s':'.'}${c.meshDecomp?'m':'.'}${c.stripAction?'a':'.'}${c.airDecomp?'A':'.'}`;
  console.log(`${r.ratio.toFixed(3).padStart(7)}x  ${r.total.toString().padStart(7)} B  ${flags}  sort=${c.sortStyle.padEnd(10)}  br=${c.brotliPasses}`);
}

console.log(`\n=== TOP 10 LOSSY (counterfactual best ratios) ===`);
const lossy = results.filter(r => r.lossless === false).sort((a, b) => b.ratio - a.ratio).slice(0, 10);
for (const r of lossy) {
  const c = r.cfg;
  const flags = `${c.detIds?'D':'.'}${c.dedupe?'d':'.'}${c.schemaFold?'s':'.'}${c.meshDecomp?'m':'.'}${c.stripAction?'a':'.'}${c.airDecomp?'A':'.'}`;
  console.log(`${r.ratio.toFixed(3).padStart(7)}x  ${r.total.toString().padStart(7)} B  ${flags}  sort=${c.sortStyle.padEnd(10)}  br=${c.brotliPasses}  [LOSSY]`);
}

// Attribute contribution: for each flag, what's the best lossless WITH it vs WITHOUT it
const flagNames = ['detIds', 'dedupe', 'schemaFold', 'meshDecomp', 'stripAction', 'airDecomp'];
console.log(`\n=== FLAG CONTRIBUTION (best lossless ratio with/without each flag) ===`);
for (const f of flagNames) {
  const withFlag = lossless.filter(r => r.cfg[f] === true);
  const withoutFlag = lossless.filter(r => r.cfg[f] === false);
  const bestWith = withFlag[0]?.ratio || 0;
  const bestWithout = withoutFlag[0]?.ratio || 0;
  const delta = bestWith - bestWithout;
  console.log(`  ${f.padEnd(14)} best w/  flag = ${bestWith.toFixed(3).padStart(7)}x   best w/o = ${bestWithout.toFixed(3).padStart(7)}x   Δ = ${delta > 0 ? '+' : ''}${delta.toFixed(3)}`);
}

// Sort style breakdown
console.log(`\n=== BEST LOSSLESS PER SORT STYLE ===`);
for (const ss of SORT_STYLES) {
  const best = lossless.find(r => r.cfg.sortStyle === ss);
  if (best) console.log(`  ${ss.padEnd(12)} best = ${best.ratio.toFixed(3)}x   total=${best.total}`);
}

// Brotli passes breakdown
console.log(`\n=== BEST LOSSLESS PER BROTLI PASSES ===`);
for (const bp of BROTLI_PASSES) {
  const best = lossless.find(r => r.cfg.brotliPasses === bp);
  if (best) console.log(`  passes=${bp}  best = ${best.ratio.toFixed(3)}x   total=${best.total}`);
}

const champ = lossless[0];
console.log(`\n🏆 OVERALL CHAMPION (byte-exact lossless):`);
console.log(`   ${champ.ratio.toFixed(3)}x   ${champ.total} B`);
console.log(`   Cfg: ${JSON.stringify(champ.cfg)}`);

fs.writeFileSync(RECEIPT_FILE, JSON.stringify({
  experiment: '49-all-permutations',
  total_permutations: allCfgs.length,
  lossless_count: losslessCount,
  lossy_count: lossyCount,
  errors: errs,
  champion: champ,
  top_30_lossless: lossless.slice(0, 30),
  top_10_lossy: lossy,
}, null, 2));
fs.writeFileSync(RESULTS_FILE, JSON.stringify(results, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
console.log(`Full results: ${RESULTS_FILE}`);
