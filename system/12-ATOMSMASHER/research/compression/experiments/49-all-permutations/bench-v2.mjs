// Exp 49 v2 — Smarter sweep with incremental progress save
//
// All permutations of: 6 boolean flags × 6 sort styles × {1, 2} brotli passes
// = 64 × 6 × 2 = 768 permutations
//
// Saves partial results every 50 iterations so we don't lose progress on kill.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { verify } from '../48-combo-synth/codec.mjs';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT-v2.json');
const PARTIAL_FILE = path.join(ROOT, 'partial-results.json');

const corpusBytes = fs.readFileSync(CORPUS);
const receipts = corpusBytes.toString('utf8').split('\n').filter(Boolean).map(l => JSON.parse(l));
const N = receipts.length;
console.log(`Corpus: ${corpusBytes.length} B, ${N} receipts`);

const SORT_STYLES = ['insertion', 'lex', 'b8', 'b4', 'rev-len', 'by-length'];
const BROTLI_PASSES = [1, 2];

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
  if ((i + 1) % 25 === 0) {
    const elapsed = (Date.now() - t0) / 1000;
    const rate = (i + 1) / elapsed;
    const eta = (allCfgs.length - i - 1) / rate;
    const bestLossless = results.filter(r => r.lossless).sort((a, b) => b.ratio - a.ratio)[0];
    console.log(`  ${i+1}/${allCfgs.length}  (${rate.toFixed(2)}/s, ETA ${eta.toFixed(0)}s)  lossless=${losslessCount}  lossy=${lossyCount}  errs=${errs}  best=${bestLossless?.ratio.toFixed(2) || 'none'}x`);
    // Save partial results
    fs.writeFileSync(PARTIAL_FILE, JSON.stringify({ progress: i + 1, total: allCfgs.length, results }, null, 2));
  }
}

console.log(`\nDone in ${((Date.now() - t0)/1000).toFixed(0)}s. Lossless: ${losslessCount}, Lossy: ${lossyCount}, Errors: ${errs}\n`);

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

const flagNames = ['detIds', 'dedupe', 'schemaFold', 'meshDecomp', 'stripAction', 'airDecomp'];
console.log(`\n=== FLAG CONTRIBUTION ===`);
for (const f of flagNames) {
  const withF = lossless.filter(r => r.cfg[f] === true);
  const withoutF = lossless.filter(r => r.cfg[f] === false);
  const bw = withF[0]?.ratio || 0;
  const bwo = withoutF[0]?.ratio || 0;
  console.log(`  ${f.padEnd(14)} with=${bw.toFixed(3).padStart(7)}x   without=${bwo.toFixed(3).padStart(7)}x   Δ=${(bw - bwo).toFixed(3)}`);
}

console.log(`\n=== BEST PER SORT STYLE ===`);
for (const ss of SORT_STYLES) {
  const best = lossless.find(r => r.cfg.sortStyle === ss);
  if (best) console.log(`  ${ss.padEnd(12)} ${best.ratio.toFixed(3)}x`);
}

console.log(`\n=== BEST PER BROTLI PASSES ===`);
for (const bp of BROTLI_PASSES) {
  const best = lossless.find(r => r.cfg.brotliPasses === bp);
  if (best) console.log(`  passes=${bp}  ${best.ratio.toFixed(3)}x`);
}

const champ = lossless[0];
console.log(`\n🏆 CHAMPION:`);
console.log(`   ${champ.ratio.toFixed(3)}x   ${champ.total} B   ${JSON.stringify(champ.cfg)}`);

fs.writeFileSync(RECEIPT_FILE, JSON.stringify({
  experiment: '49-all-permutations-v2',
  generated_at: '2026-06-27',
  total_permutations: allCfgs.length,
  lossless_count: losslessCount,
  lossy_count: lossyCount,
  errors: errs,
  champion: champ,
  top_30_lossless: lossless.slice(0, 30),
  top_10_lossy: lossy,
  flag_contribution: Object.fromEntries(flagNames.map(f => {
    const withF = lossless.filter(r => r.cfg[f] === true)[0]?.ratio || 0;
    const withoutF = lossless.filter(r => r.cfg[f] === false)[0]?.ratio || 0;
    return [f, { withFlag: withF, withoutFlag: withoutF, delta: withF - withoutF }];
  })),
}, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
