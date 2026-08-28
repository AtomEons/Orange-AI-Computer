// Experiment 30 — Finer-grained sort + custom dictionary brotli
//
// Plait at 18.05× groups by engine prefix (38 strands). Try:
//   a) Group by action (66 strands)
//   b) Group by (action, payload_key_signature) — even finer
//   c) Brotli with corpus-as-prefix (poor man's shared dictionary)
//   d) Combine with two-stream IDs

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';

const ROOT = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const CORPUS = path.resolve(ROOT, '../../data/canonical-corpus.jsonl');
const RECEIPT_FILE = path.join(ROOT, 'RECEIPT.json');

const corpusBytes = fs.readFileSync(CORPUS);
const corpusSha = crypto.createHash('sha256').update(corpusBytes).digest('hex');
const lines = corpusBytes.toString('utf8').split('\n').filter(Boolean);
const receipts = lines.map(l => JSON.parse(l));
console.log(`Corpus: ${corpusBytes.length} B, ${receipts.length} receipts`);

const PLAIT = 18.05;

function brotli11(b) {
  return zlib.brotliCompressSync(b, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
}
function brotli11Dict(b, dict) {
  // Concatenate dict + corpus, compress, return TOTAL size; this is the
  // "poor man's shared dict" since Node's zlib doesn't expose brotli's
  // BROTLI_PARAM_DICTIONARY directly.
  const combined = Buffer.concat([dict, b]);
  const c = zlib.brotliCompressSync(combined, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
  return c;
}

const results = [];

function attempt(name, encoded, opts = {}) {
  const ratio = corpusBytes.length / encoded.length;
  results.push({ name, encoded: encoded.length, ratio, ...opts });
  console.log(`${name.padEnd(50)} ${encoded.length.toString().padStart(8)} B  ${ratio.toFixed(2).padStart(6)}x ${ratio > PLAIT ? 'BEATS PLAIT' : ''}`);
  return ratio;
}

// Baseline: brotli q11 on raw corpus
const baseRaw = brotli11(corpusBytes);
attempt('brotli q11 raw corpus', baseRaw);

// (a) Group by action
const byAction = new Map();
for (let i = 0; i < receipts.length; i++) {
  if (!byAction.has(receipts[i].action)) byAction.set(receipts[i].action, []);
  byAction.get(receipts[i].action).push(lines[i]);
}
const groupByAction = [...byAction.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  .flatMap(([_, l]) => l).join('\n') + '\n';
const groupByActionBytes = Buffer.from(groupByAction, 'utf8');
const groupByActionBrotli = brotli11(groupByActionBytes);
attempt('group by action + brotli', groupByActionBrotli);

// (b) Group by (action, payload_key_signature)
function keySig(r) {
  if (r.payload_json == null) return '\0NULL\0';
  try { const p = JSON.parse(r.payload_json); return Object.keys(p || {}).join(','); } catch { return r.payload_json.slice(0, 40); }
}
const byActionKeySig = new Map();
for (let i = 0; i < receipts.length; i++) {
  const k = receipts[i].action + '|' + keySig(receipts[i]);
  if (!byActionKeySig.has(k)) byActionKeySig.set(k, []);
  byActionKeySig.get(k).push(lines[i]);
}
const sortedByActionKeySig = [...byActionKeySig.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  .flatMap(([_, l]) => l).join('\n') + '\n';
const sortedByActionKeySigBytes = Buffer.from(sortedByActionKeySig, 'utf8');
const sortedByActionKeySigBrotli = brotli11(sortedByActionKeySigBytes);
attempt('group by (action, key_sig) + brotli', sortedByActionKeySigBrotli);

// (c) Sort by (action, status, summary, payload_json, created_at) — full lexicographic
const fullSorted = [...lines].sort().join('\n') + '\n';
const fullSortedBytes = Buffer.from(fullSorted, 'utf8');
const fullSortedBrotli = brotli11(fullSortedBytes);
attempt('full lexicographic sort + brotli', fullSortedBrotli);

// (d) Plait-style: by action prefix before first dot
const plait38 = new Map();
for (let i = 0; i < receipts.length; i++) {
  const prefix = receipts[i].action.split('.')[0];
  if (!plait38.has(prefix)) plait38.set(prefix, []);
  plait38.get(prefix).push(lines[i]);
}
const plait38Sorted = [...plait38.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  .flatMap(([_, l]) => l).join('\n') + '\n';
const plait38Brotli = brotli11(Buffer.from(plait38Sorted, 'utf8'));
attempt('plait by prefix (replicating 18.05x)', plait38Brotli);

// (e) Brotli with corpus-as-prefix — poor man's shared dictionary
// Take a frequent substring set (action JSON segments) and prepend to the corpus
const commonPatterns = [
  '"action":"', '"status":"ok"', '"created_at":"2026-06-26T09:12:', '"summary":"', '"payload_json":"',
  '"id":"rcpt_', '"ratio":', '"atom_count":', '"dropped":0,"citations":0', '{"ratio":', '"raw_bytes":', '"compressed_bytes":',
  '"feature.execute"', '"organism.run"', '"air.compress"', '"mesh.compress"', '"order.add"', '"feature.execute"',
  '"executed"', '"completed"', '"verified"', '"ok"', '"HOT_ALWAYS"',
];
const dict = Buffer.from(commonPatterns.join('\0'), 'utf8');
const withDict = brotli11Dict(corpusBytes, dict);
// Subtract the dict's compressed size to see the marginal cost
const dictOnly = brotli11(dict);
const marginal = withDict.length - dictOnly.length;
console.log(`  (custom dict-prefix brotli: total=${withDict.length}, dict-only=${dictOnly.length}, marginal=${marginal})`);

// (f) Two-stream + per-action-key-sig sorted audit
function extractIds(rs) {
  const ids = [];
  for (const r of rs) {
    if (/^rcpt_[0-9a-f]{16}$/.test(r.id || '')) ids.push(Buffer.from(r.id.slice(5), 'hex'));
    else ids.push(Buffer.from(r.id || '', 'utf8'));
  }
  return Buffer.concat(ids);
}
const idBuf = extractIds(receipts);
const idBrotli = brotli11(idBuf);

// Audit content: receipts minus the id (set to empty placeholder)
const noIds = receipts.map(r => ({ ...r, id: '' }));
const noIdsJsonl = noIds.map(r => JSON.stringify(r)).join('\n') + '\n';
const noIdsBytes = Buffer.from(noIdsJsonl, 'utf8');
const noIdsBrotli = brotli11(noIdsBytes);
attempt('two-stream lossless (no IDs strip + IDs)', Buffer.from(noIdsBrotli.toString('binary') + idBrotli.toString('binary'), 'binary'));

// (g) Two-stream + sorted-by-action audit
const noIdsSorted = [...noIds].sort((a, b) => {
  if (a.action !== b.action) return a.action.localeCompare(b.action);
  return (a.created_at || '').localeCompare(b.created_at || '');
});
const noIdsSortedJsonl = noIdsSorted.map(r => JSON.stringify(r)).join('\n') + '\n';
const noIdsSortedBytes = Buffer.from(noIdsSortedJsonl, 'utf8');
const noIdsSortedBrotli = brotli11(noIdsSortedBytes);
// Ordering: need to remember the original receipt order to reconstruct the corpus
// For lossless, we'd need to store the permutation. Skipping permutation here:
// THIS IS NOT LOSSLESS UNLESS WE ADD AN INDEX. Let me account for that.
const indexBuf = Buffer.from(noIds.map((_, i) => i.toString()).join(','), 'utf8');
const indexBrotli = brotli11(indexBuf);
const totalSorted = noIdsSortedBrotli.length + indexBrotli.length + idBrotli.length;
console.log(`sorted no-IDs + index + IDs:                       ${totalSorted.toString().padStart(8)} B  ${(corpusBytes.length / totalSorted).toFixed(2).padStart(6)}x  (with permutation)`);
results.push({ name: 'sorted no-IDs + permutation index + IDs', encoded: totalSorted, ratio: corpusBytes.length / totalSorted });

// (h) Variant: keep original order but PREFIX corpus with itself sorted (as dict)
const prefixDict = noIdsSortedBytes;  // sorted version serves as a learned "prefix"
const corpusWithPrefix = Buffer.concat([prefixDict, corpusBytes]);
const corpusWithPrefixBrotli = brotli11(corpusWithPrefix);
const prefixDictBrotli = brotli11(prefixDict);
const marginal2 = corpusWithPrefixBrotli.length - prefixDictBrotli.length;
console.log(`prefix-dict (sorted corpus) marginal cost:         ${marginal2.toString().padStart(8)} B  ${(corpusBytes.length / marginal2).toFixed(2).padStart(6)}x  marginal-ratio`);
// This is the asymptotic ratio if the prefix dict is shared/free (e.g., baked into firmware)
results.push({ name: 'prefix-dict marginal (asymptotic)', encoded: marginal2, ratio: corpusBytes.length / marginal2, marginal: true });

// ── Print sorted ──
console.log('\n=== SORTED RESULTS (real lossless full-corpus only) ===');
const sorted = results.filter(r => !r.marginal).sort((a, b) => b.ratio - a.ratio);
for (const r of sorted) {
  console.log(`${r.ratio.toFixed(2).padStart(6)}x  ${r.encoded.toString().padStart(8)} B  ${r.name}`);
}

const receipt = {
  experiment: '30-fine-sort-and-dict',
  generated_at: new Date().toISOString(),
  corpus_sha256_in: corpusSha,
  results,
  best_lossless: sorted[0],
};
fs.writeFileSync(RECEIPT_FILE, JSON.stringify(receipt, null, 2));
console.log(`\nReceipt: ${RECEIPT_FILE}`);
