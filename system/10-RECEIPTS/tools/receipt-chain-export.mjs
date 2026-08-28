#!/usr/bin/env bun
// Orange5 DX — receipt-chain-export
//
// Exports the receipt hash-chain to a portable, self-verifying JSON bundle.
// For each receipt in the build corpus it records:
//   * chain ordinal (from `- **hash_chain:** #NNN`)
//   * receipt_id, title, date, status
//   * sha256 of the raw markdown bytes (content hash — makes the bundle portable
//     AND tamper-evident: re-hash the file, compare to the bundle)
//   * prior_receipt as declared, and the resolved predecessor by ordinal
// It then reports chain integrity HONESTLY: ordered links, gaps (missing
// ordinals), and duplicate ordinals. It does not "repair" anything or pretend a
// broken chain is intact.
//
// Markdown is truth; this reads the .md files read-only. No SQLite, no deps.
//
// Usage:
//   bun 10-RECEIPTS/tools/receipt-chain-export.mjs                 # JSON to stdout
//   bun 10-RECEIPTS/tools/receipt-chain-export.mjs --out bundle.json
//   bun 10-RECEIPTS/tools/receipt-chain-export.mjs --summary       # human summary
//   bun 10-RECEIPTS/tools/receipt-chain-export.mjs --pretty        # indented JSON
//
// Programmatic:  import { buildChainBundle, analyzeChain } from './receipt-chain-export.mjs'
//
// Mom's Law: real hashes over real bytes; chain breaks are reported, not hidden.

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parseReceipt, DEFAULT_DIR } from './receipt-search.mjs';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const RECEIPTS_DIR = DEFAULT_DIR;
export const BUNDLE_SCHEMA = 'orange5.receipt-chain.bundle.v1';

export function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Load every receipt as { ...parsed, sha256 } including its raw-byte hash.
export function loadChained(dir = RECEIPTS_DIR) {
  let names;
  try { names = readdirSync(dir).filter((n) => n.endsWith('.md')); }
  catch (e) { throw new Error(`cannot read receipt dir ${dir}: ${e.message}`); }
  const out = [];
  for (const name of names) {
    const full = join(dir, name);
    try {
      if (!statSync(full).isFile()) continue;
      const body = readFileSync(full, 'utf8');
      const rec = parseReceipt(name, body);
      out.push({
        file: rec.file,
        receiptId: rec.receiptId,
        title: rec.title,
        date: rec.date,
        status: rec.status,
        chain: rec.hashChain,           // may be null when the receipt has no chain field
        priorReceipt: rec.priorReceipt,
        sha256: sha256(body),
        bytes: body.length,
      });
    } catch { /* skip unreadable */ }
  }
  return out;
}

// Analyze chain integrity over the chained receipts. Honest: reports gaps and
// duplicates rather than smoothing them over.
export function analyzeChain(records) {
  const chained = records.filter((r) => Number.isFinite(r.chain)).sort((a, b) => a.chain - b.chain);
  const unchained = records.filter((r) => !Number.isFinite(r.chain)).map((r) => r.receiptId);

  const ordinals = chained.map((r) => r.chain);
  const seen = new Map();
  for (const r of chained) seen.set(r.chain, (seen.get(r.chain) ?? 0) + 1);
  const duplicates = [...seen.entries()].filter(([, n]) => n > 1).map(([ord, n]) => ({ ordinal: ord, count: n }));

  const min = ordinals.length ? ordinals[0] : null;
  const max = ordinals.length ? ordinals[ordinals.length - 1] : null;
  const present = new Set(ordinals);
  const gaps = [];
  if (min != null && max != null) {
    for (let i = min; i <= max; i++) if (!present.has(i)) gaps.push(i);
  }

  // link each chained receipt to the predecessor ordinal actually present.
  const links = chained.map((r, i) => ({
    ordinal: r.chain,
    receiptId: r.receiptId,
    sha256: r.sha256,
    predecessorOrdinal: i > 0 ? chained[i - 1].chain : null,
    predecessorId: i > 0 ? chained[i - 1].receiptId : null,
    declaredPrior: r.priorReceipt ?? null,
  }));

  return {
    chainedCount: chained.length,
    unchainedCount: unchained.length,
    unchained,
    min, max,
    contiguous: gaps.length === 0 && duplicates.length === 0 && chained.length > 0,
    gaps,
    duplicates,
    links,
  };
}

// Full portable bundle: metadata + records + integrity analysis.
export function buildChainBundle(dir = RECEIPTS_DIR, now = new Date()) {
  const records = loadChained(dir).sort((a, b) => {
    const ca = Number.isFinite(a.chain) ? a.chain : Infinity;
    const cb = Number.isFinite(b.chain) ? b.chain : Infinity;
    return ca - cb || a.file.localeCompare(b.file);
  });
  const integrity = analyzeChain(records);
  // a hash over all per-receipt hashes → single fingerprint for the whole bundle
  const bundleFingerprint = sha256(records.map((r) => `${r.chain ?? '-'}:${r.sha256}`).join('\n'));
  return {
    schema: BUNDLE_SCHEMA,
    generatedAt: now.toISOString(),
    sourceDir: dir,
    receiptCount: records.length,
    bundleFingerprint,
    integrity,
    receipts: records,
  };
}

// ---- CLI ----
function parseArgs(argv) {
  const o = { out: null, summary: false, pretty: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--out') o.out = argv[++i];
    else if (a === '--summary') o.summary = true;
    else if (a === '--pretty') o.pretty = true;
  }
  return o;
}

function main() {
  const o = parseArgs(process.argv.slice(2));
  const bundle = buildChainBundle();

  if (o.summary) {
    const it = bundle.integrity;
    console.log(`receipt-chain-export — ${bundle.receiptCount} receipts, ${it.chainedCount} chained (#${it.min}..#${it.max})`);
    console.log(`  contiguous: ${it.contiguous ? 'YES' : 'NO'}`);
    if (it.gaps.length) console.log(`  GAPS (missing ordinals): ${it.gaps.map((g) => '#' + g).join(', ')}`);
    if (it.duplicates.length) console.log(`  DUPLICATE ordinals: ${it.duplicates.map((d) => `#${d.ordinal}×${d.count}`).join(', ')}`);
    if (it.unchainedCount) console.log(`  unchained (no hash_chain field): ${it.unchainedCount}`);
    console.log(`  bundle fingerprint: ${bundle.bundleFingerprint}`);
    return;
  }

  const json = JSON.stringify(bundle, null, o.pretty ? 2 : 0);
  if (o.out) {
    writeFileSync(o.out, json);
    console.log(`[receipt-chain-export] wrote ${o.out}  (${bundle.receiptCount} receipts, fingerprint ${bundle.bundleFingerprint.slice(0, 12)}…)`);
  } else {
    console.log(json);
  }
}

if (import.meta.main) main();
