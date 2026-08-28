#!/usr/bin/env bun
// Orange5 DX — test-index
//
// Discovers EVERY test file across the Orange5 surface and lists each with its
// invocation type — `bun test` (framework files importing bun:test/node:test)
// vs `bun` (standalone print-harness files). REAL counts, discovered from disk;
// nothing is fabricated.
//
// Discovery is deliberately IDENTICAL to 00-CHARTER/orange5-full-verifier.mjs so
// this index matches the verifier's ground truth exactly:
//   * walk the tree for `*.test.mjs`
//   * skip node_modules, .git, dist, 19-ARCHIVE
//   * add the two EXTRA non-.test harness scripts the verifier also runs
//   * framework = file matches import/require of 'bun:test' or 'node:test'
// The verifier runs on import (top-level await + process.exit), so it cannot be
// imported without executing it; this module re-implements the SAME rules read
// from the same constants documented in the verifier. It reads files read-only.
//
// Usage:
//   bun 00-CHARTER/tools/test-index.mjs                 # human table + totals
//   bun 00-CHARTER/tools/test-index.mjs --json          # machine-readable
//   bun 00-CHARTER/tools/test-index.mjs --framework     # only `bun test` files
//   bun 00-CHARTER/tools/test-index.mjs --standalone    # only `bun` files
//   bun 00-CHARTER/tools/test-index.mjs --by-pillar     # counts grouped by top dir
//
// Programmatic:  import { indexTests, discover, classifyInvocation } from './test-index.mjs'
//
// Mom's Law: the count is real. Discovered from the filesystem, matching the verifier.

import { readdirSync, statSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
// These MUST mirror the verifier. If the verifier changes them, mirror here.
export const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '19-ARCHIVE']);
export const EXTRA = [
  '06-ORANGELLM/tests/run-boundary-tests.mjs',
  '09-SCHEMAS/tests/validate-schemas.mjs',
];

function walk(dir, acc) {
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      walk(join(dir, e.name), acc);
    } else if (e.isFile() && e.name.endsWith('.test.mjs')) {
      acc.push(join(dir, e.name));
    }
  }
  return acc;
}

// Repo-relative, de-duped, sorted list of every discovered test file.
export function discover(root = ROOT) {
  const found = walk(root, []);
  for (const x of EXTRA) {
    const full = join(root, x);
    try { statSync(full); if (!found.includes(full)) found.push(full); } catch { /* absent */ }
  }
  return [...new Set(found.map((f) => relative(root, f).split(sep).join('/')))].sort();
}

// Framework vs standalone — same predicate as the verifier.
export function classifyInvocation(relPath, root = ROOT) {
  let framework = false;
  try {
    const src = readFileSync(join(root, relPath), 'utf8');
    framework = /from\s+['"](?:node:test|bun:test)['"]/.test(src) ||
                /require\(\s*['"](?:node:test|bun:test)['"]\s*\)/.test(src);
  } catch { /* unreadable -> treat as standalone */ }
  return framework ? 'bun test' : 'bun';
}

// Top-level pillar dir (e.g. "08-HERMES") for grouping.
function pillarOf(relPath) {
  const first = relPath.split('/')[0];
  return first || '(root)';
}

export function indexTests(root = ROOT) {
  const files = discover(root);
  const entries = files.map((relPath) => ({
    file: relPath,
    invocation: classifyInvocation(relPath, root),
    pillar: pillarOf(relPath),
    isExtra: EXTRA.includes(relPath),
  }));
  const framework = entries.filter((e) => e.invocation === 'bun test');
  const standalone = entries.filter((e) => e.invocation === 'bun');
  const byPillar = {};
  for (const e of entries) {
    (byPillar[e.pillar] ??= { total: 0, framework: 0, standalone: 0 });
    byPillar[e.pillar].total++;
    if (e.invocation === 'bun test') byPillar[e.pillar].framework++;
    else byPillar[e.pillar].standalone++;
  }
  return {
    total: entries.length,
    frameworkCount: framework.length,
    standaloneCount: standalone.length,
    byPillar,
    entries,
  };
}

// ---- CLI ----
function main() {
  const args = process.argv.slice(2);
  const idx = indexTests();

  if (args.includes('--json')) {
    console.log(JSON.stringify(idx, null, 2));
    return;
  }
  if (args.includes('--by-pillar')) {
    console.log(`test-index by pillar — ${idx.total} total (${idx.frameworkCount} bun test / ${idx.standaloneCount} bun)`);
    for (const [pillar, c] of Object.entries(idx.byPillar).sort()) {
      console.log(`  ${pillar.padEnd(22)} ${String(c.total).padStart(3)}  (bun test ${c.framework}, bun ${c.standalone})`);
    }
    return;
  }

  let list = idx.entries;
  if (args.includes('--framework')) list = list.filter((e) => e.invocation === 'bun test');
  if (args.includes('--standalone')) list = list.filter((e) => e.invocation === 'bun');

  console.log(`Orange5 test-index — ${idx.total} test files discovered  (bun test: ${idx.frameworkCount}, bun: ${idx.standaloneCount})`);
  console.log('='.repeat(70));
  for (const e of list) {
    const inv = e.invocation === 'bun test' ? 'bun test' : 'bun     ';
    console.log(`  [${inv}] ${e.file}${e.isExtra ? '   (EXTRA harness)' : ''}`);
  }
  console.log('='.repeat(70));
  console.log(`  showing ${list.length} of ${idx.total}`);
}

if (import.meta.main) main();
