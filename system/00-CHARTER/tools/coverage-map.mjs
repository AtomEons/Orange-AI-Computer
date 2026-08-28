#!/usr/bin/env bun
// Orange5 DX — coverage-map
//
// Maps which top-level pillars / numbered dirs HAVE test files vs which DO NOT.
// Every number is REAL: pillar dirs are enumerated from disk, test files are
// discovered with the same walk the verifier uses. Nothing is fabricated — a
// pillar with zero tests is reported as zero, not hidden.
//
// "Coverage" here means test-file presence per pillar (a structural map of
// where the test surface exists), NOT line/branch coverage. It answers:
// "which parts of Orange5 have a test surface and which are dark?"
//
// Usage:
//   bun 00-CHARTER/tools/coverage-map.mjs               # table: pillar -> tests
//   bun 00-CHARTER/tools/coverage-map.mjs --json        # machine-readable
//   bun 00-CHARTER/tools/coverage-map.mjs --gaps        # only pillars w/ 0 tests
//
// Programmatic:  import { coverageMap, listPillarDirs } from './coverage-map.mjs'
//
// Mom's Law: real presence/absence. Dark pillars are named, not glossed over.

import { readdirSync } from 'node:fs';
import { indexTests, SKIP_DIRS, ROOT } from './test-index.mjs';

export { ROOT };

// Top-level directories that represent pillars/areas. We include the numbered
// pillar dirs (e.g. "00-CHARTER", "08-HERMES") and any other real top dir that
// is not a build/vendor dir. This is the denominator for the coverage map.
export function listPillarDirs(root = ROOT) {
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((e) => e.isDirectory() && !SKIP_DIRS.has(e.name) && !e.name.startsWith('.'))
    .map((e) => e.name)
    .sort();
}

// Build the coverage map: for each pillar dir, the real test count (framework +
// standalone), and a covered flag. Pillars with tests that the discovery walk
// found but which are somehow not top-dirs are also surfaced under their pillar.
export function coverageMap(root = ROOT) {
  const dirs = listPillarDirs(root);
  const idx = indexTests(root);            // real discovery, matches verifier

  const counts = {};                        // pillar -> {framework, standalone, total}
  for (const e of idx.entries) {
    (counts[e.pillar] ??= { framework: 0, standalone: 0, total: 0 });
    counts[e.pillar].total++;
    if (e.invocation === 'bun test') counts[e.pillar].framework++;
    else counts[e.pillar].standalone++;
  }

  const rows = dirs.map((dir) => {
    const c = counts[dir] ?? { framework: 0, standalone: 0, total: 0 };
    return { pillar: dir, tests: c.total, framework: c.framework, standalone: c.standalone, covered: c.total > 0 };
  });

  // Any pillar that owns tests but is not in the top-dir list (defensive; e.g.
  // an EXTRA under a dir that got filtered) — surface it so counts reconcile.
  for (const [pillar, c] of Object.entries(counts)) {
    if (!rows.some((r) => r.pillar === pillar)) {
      rows.push({ pillar, tests: c.total, framework: c.framework, standalone: c.standalone, covered: c.total > 0 });
    }
  }
  rows.sort((a, b) => a.pillar.localeCompare(b.pillar));

  const covered = rows.filter((r) => r.covered);
  const gaps = rows.filter((r) => !r.covered);
  return {
    totalPillars: rows.length,
    coveredPillars: covered.length,
    gapPillars: gaps.length,
    totalTestFiles: idx.total,
    rows,
    gaps: gaps.map((r) => r.pillar),
  };
}

// ---- CLI ----
function main() {
  const args = process.argv.slice(2);
  const map = coverageMap();

  if (args.includes('--json')) {
    console.log(JSON.stringify(map, null, 2));
    return;
  }
  if (args.includes('--gaps')) {
    console.log(`coverage-map — ${map.gapPillars} pillar(s) with NO test files (of ${map.totalPillars}):`);
    for (const g of map.gaps) console.log(`  [ dark ] ${g}`);
    return;
  }

  const pctCovered = map.totalPillars > 0
    ? Math.round((map.coveredPillars / map.totalPillars) * 1000) / 10 : 0;
  console.log(`Orange5 coverage-map — ${map.coveredPillars}/${map.totalPillars} pillars have tests (${pctCovered}%), ${map.totalTestFiles} test files total`);
  console.log('='.repeat(72));
  for (const r of map.rows) {
    const tag = r.covered ? 'TESTS' : ' dark';
    const detail = r.covered ? `${r.tests} file(s)  (bun test ${r.framework}, bun ${r.standalone})` : '—';
    console.log(`  [${tag}] ${r.pillar.padEnd(26)} ${detail}`);
  }
  console.log('='.repeat(72));
  if (map.gapPillars) console.log(`  ${map.gapPillars} dark pillar(s): ${map.gaps.join(', ')}`);
}

if (import.meta.main) main();
