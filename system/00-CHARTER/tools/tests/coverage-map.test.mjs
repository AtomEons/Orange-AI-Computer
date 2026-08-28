#!/usr/bin/env bun
// Standalone test harness for coverage-map.mjs (no framework import).
// Asserts REAL pillar coverage against the live tree — counts reconcile with
// test-index (single source of discovery truth), nothing hardcoded/fabricated.
// Run:  bun 00-CHARTER/tools/tests/coverage-map.test.mjs

import { coverageMap, listPillarDirs, ROOT } from '../coverage-map.mjs';
import { indexTests } from '../test-index.mjs';

let pass = 0, fail = 0;
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

const map = coverageMap(ROOT);
const idx = indexTests(ROOT);
console.log(`  (pillars: ${map.coveredPillars}/${map.totalPillars} covered; ${map.totalTestFiles} test files)`);

// ---- real, reconciled ----
T('lists a non-trivial number of pillars', map.totalPillars > 5);
T('covered + gaps == total pillars', map.coveredPillars + map.gapPillars === map.totalPillars);
T('totalTestFiles matches test-index total', map.totalTestFiles === idx.total);

// sum of per-pillar test counts across rows == total discovered files
const rowSum = map.rows.reduce((a, r) => a + r.tests, 0);
T('sum of per-pillar tests == total files', rowSum === idx.total);

// covered flag is consistent with tests>0
const flagConsistent = map.rows.every((r) => r.covered === (r.tests > 0));
T('covered flag == (tests > 0) for every row', flagConsistent === true);

// per-row framework+standalone reconciles to that row's total
const rowReconcile = map.rows.every((r) => r.framework + r.standalone === r.tests);
T('per-row framework+standalone == tests', rowReconcile === true);

// gaps list matches the rows flagged uncovered
const gapsFromRows = map.rows.filter((r) => !r.covered).map((r) => r.pillar).sort();
T('gaps list matches uncovered rows', JSON.stringify([...map.gaps].sort()) === JSON.stringify(gapsFromRows));

// 00-CHARTER now HAS tests (this very tools/tests dir lives under it), so it
// must be reported covered — a concrete real-count anchor.
const charter = map.rows.find((r) => r.pillar === '00-CHARTER');
T('00-CHARTER row present', !!charter);
T('00-CHARTER is covered (our tests live here)', !!charter && charter.covered === true);

// listPillarDirs excludes vendor/build/hidden dirs
const dirs = listPillarDirs(ROOT);
T('pillar dirs exclude node_modules', !dirs.includes('node_modules'));
T('pillar dirs exclude dist', !dirs.includes('dist'));
T('pillar dirs exclude .git', !dirs.includes('.git'));
T('pillar dirs exclude 19-ARCHIVE', !dirs.includes('19-ARCHIVE'));
T('no hidden dirs in pillar list', dirs.every((d) => !d.startsWith('.')));

// every covered pillar actually appears in the discovered entries
const pillarsWithTests = new Set(idx.entries.map((e) => e.pillar));
const coveredMatch = map.rows.filter((r) => r.covered).every((r) => pillarsWithTests.has(r.pillar));
T('every covered pillar has a discovered test', coveredMatch === true);

// determinism
const map2 = coverageMap(ROOT);
T('coverageMap is deterministic', JSON.stringify(map2.rows) === JSON.stringify(map.rows));

const total = pass + fail;
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
