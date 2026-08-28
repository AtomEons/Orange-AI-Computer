#!/usr/bin/env bun
// Standalone test harness for receipt-chain-export.mjs (no framework import).
// Tests sha256 + chain analysis on synthetic records, then smoke-tests the real
// corpus bundle. Writes only to a temp dir (never the real receipt corpus).
// Run:  bun 10-RECEIPTS/tools/tests/receipt-chain-export.test.mjs

import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  sha256, analyzeChain, buildChainBundle, loadChained, RECEIPTS_DIR, BUNDLE_SCHEMA,
} from '../receipt-chain-export.mjs';

let pass = 0, fail = 0;
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

// ---------- sha256 ----------
T('sha256 known vector (empty)', sha256('') === 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
T('sha256 known vector (abc)', sha256('abc') === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
T('sha256 is stable', sha256('orange5') === sha256('orange5'));
T('sha256 differs on change', sha256('a') !== sha256('b'));

// ---------- analyzeChain: contiguous ----------
const contig = analyzeChain([
  { chain: 1, receiptId: 'r1', sha256: 'h1', priorReceipt: null },
  { chain: 2, receiptId: 'r2', sha256: 'h2', priorReceipt: 'r1' },
  { chain: 3, receiptId: 'r3', sha256: 'h3', priorReceipt: 'r2' },
]);
T('contiguous chainedCount = 3', contig.chainedCount === 3);
T('contiguous min/max', contig.min === 1 && contig.max === 3);
T('contiguous flag true', contig.contiguous === true);
T('contiguous no gaps', contig.gaps.length === 0);
T('contiguous no duplicates', contig.duplicates.length === 0);
T('links predecessor set correctly', contig.links[2].predecessorId === 'r2' && contig.links[2].predecessorOrdinal === 2);
T('first link predecessor null', contig.links[0].predecessorOrdinal === null);

// ---------- analyzeChain: gap ----------
const gapped = analyzeChain([
  { chain: 1, receiptId: 'r1', sha256: 'h1' },
  { chain: 2, receiptId: 'r2', sha256: 'h2' },
  { chain: 5, receiptId: 'r5', sha256: 'h5' },
]);
T('gapped detects missing #3,#4', JSON.stringify(gapped.gaps) === JSON.stringify([3, 4]));
T('gapped contiguous = false', gapped.contiguous === false);

// ---------- analyzeChain: duplicate ordinal ----------
const dup = analyzeChain([
  { chain: 7, receiptId: 'a', sha256: 'ha' },
  { chain: 7, receiptId: 'b', sha256: 'hb' },
  { chain: 8, receiptId: 'c', sha256: 'hc' },
]);
T('duplicate ordinal detected', dup.duplicates.length === 1 && dup.duplicates[0].ordinal === 7 && dup.duplicates[0].count === 2);
T('duplicate makes contiguous false', dup.contiguous === false);

// ---------- analyzeChain: unchained handling ----------
const mixed = analyzeChain([
  { chain: 1, receiptId: 'r1', sha256: 'h1' },
  { chain: null, receiptId: 'nochain', sha256: 'h2' },
]);
T('unchained counted separately', mixed.unchainedCount === 1 && mixed.unchained[0] === 'nochain');
T('unchained excluded from chained', mixed.chainedCount === 1);

// empty corpus
const empty = analyzeChain([]);
T('empty chain contiguous=false', empty.contiguous === false);
T('empty chain min/max null', empty.min === null && empty.max === null);

// ---------- buildChainBundle on synthetic dir + round-trip hash verify ----------
const dir = mkdtempSync(join(tmpdir(), 'chain-'));
try {
  const write = (name, chain, status) => {
    const body = `# ${name}\n\n- **receipt_id:** ${name.replace('.md','')}\n- **status:** ${status}\n- **hash_chain:** #${String(chain).padStart(3,'0')}\n`;
    writeFileSync(join(dir, name), body);
    return { name, body };
  };
  const w1 = write('2026-06-23-a.md', 1, 'BUILD_GREEN');
  write('2026-06-24-b.md', 2, 'BUILD_GREEN');
  write('2026-06-25-c.md', 3, 'BUILD_GREEN');

  const FIXED = new Date('2026-07-04T00:00:00.000Z');
  const bundle = buildChainBundle(dir, FIXED);
  T('bundle schema tag', bundle.schema === BUNDLE_SCHEMA);
  T('bundle generatedAt fixed', bundle.generatedAt === '2026-07-04T00:00:00.000Z');
  T('bundle receiptCount = 3', bundle.receiptCount === 3);
  T('bundle integrity contiguous', bundle.integrity.contiguous === true);
  T('bundle has fingerprint', typeof bundle.bundleFingerprint === 'string' && bundle.bundleFingerprint.length === 64);

  // TAMPER-EVIDENCE: recompute sha256 of the real file bytes; must match bundle.
  const rec1 = bundle.receipts.find((r) => r.file === '2026-06-23-a.md');
  const rehash = sha256(readFileSync(join(dir, '2026-06-23-a.md'), 'utf8'));
  T('bundle sha256 matches on-disk bytes', rec1.sha256 === rehash);
  T('bundle sha256 equals expected', rec1.sha256 === sha256(w1.body));

  // portability: bundle serializes to valid JSON and reparses identically
  const out = join(dir, 'bundle.json');
  writeFileSync(out, JSON.stringify(bundle));
  T('bundle written to disk', existsSync(out));
  const reparsed = JSON.parse(readFileSync(out, 'utf8'));
  T('bundle round-trips through JSON', reparsed.bundleFingerprint === bundle.bundleFingerprint && reparsed.receiptCount === 3);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

// ---------- smoke: real corpus ----------
let realBundle = null, threw = false;
try { realBundle = buildChainBundle(RECEIPTS_DIR, new Date('2026-07-04T00:00:00.000Z')); }
catch { threw = true; }
T('real corpus bundle builds without throw', threw === false);
T('real corpus bundle non-empty', !!realBundle && realBundle.receiptCount > 0);
T('real corpus has chained receipts', !!realBundle && realBundle.integrity.chainedCount > 0);
if (realBundle) {
  const allHashed = realBundle.receipts.every((r) => typeof r.sha256 === 'string' && r.sha256.length === 64);
  T('every real receipt has a 64-hex sha256', allHashed === true);
  console.log(`  (real corpus: ${realBundle.receiptCount} receipts, ${realBundle.integrity.chainedCount} chained #${realBundle.integrity.min}..#${realBundle.integrity.max}, contiguous=${realBundle.integrity.contiguous}, gaps=${realBundle.integrity.gaps.length})`);
}

const total = pass + fail;
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
