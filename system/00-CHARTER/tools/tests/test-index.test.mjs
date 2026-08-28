#!/usr/bin/env bun
// Standalone test harness for test-index.mjs (no framework import).
// Asserts REAL discovery invariants against the live tree (counts are not
// hardcoded — they must reconcile with themselves and with the verifier's rules).
// Run:  bun 00-CHARTER/tools/tests/test-index.test.mjs

import { indexTests, discover, classifyInvocation, EXTRA, SKIP_DIRS, ROOT } from '../test-index.mjs';

let pass = 0, fail = 0;
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

const idx = indexTests(ROOT);
console.log(`  (discovered ${idx.total} test files: ${idx.frameworkCount} bun test, ${idx.standaloneCount} bun)`);

// ---- real, non-fabricated ----
T('discovers a non-trivial number of tests', idx.total > 20);   // corpus is ~58
T('framework + standalone == total (reconciles)',
  idx.frameworkCount + idx.standaloneCount === idx.total);
T('entries length == total', idx.entries.length === idx.total);

// every discovered file is either a *.test.mjs or one of the EXTRA harnesses
const allValid = idx.entries.every((e) => e.file.endsWith('.test.mjs') || EXTRA.includes(e.file));
T('every entry is .test.mjs or an EXTRA', allValid === true);

// the two EXTRA harnesses are present (they exist on disk) and are standalone
for (const x of EXTRA) {
  const found = idx.entries.find((e) => e.file === x);
  T(`EXTRA present: ${x}`, !!found);
  if (found) T(`EXTRA classified standalone: ${x}`, found.invocation === 'bun');
}

// no entry sits under a skipped dir
const noSkipped = idx.entries.every((e) => {
  const top = e.file.split('/')[0];
  return !SKIP_DIRS.has(top) && !e.file.split('/').some((seg) => SKIP_DIRS.has(seg));
});
T('no entry under node_modules/.git/dist/19-ARCHIVE', noSkipped === true);

// discovery is sorted + de-duped
const files = discover(ROOT);
const sorted = [...files].sort();
T('discover() is sorted', JSON.stringify(files) === JSON.stringify(sorted));
T('discover() is de-duped', new Set(files).size === files.length);
T('discover() length == index total', files.length === idx.total);

// byPillar reconciles to the totals
const pillarTotal = Object.values(idx.byPillar).reduce((a, c) => a + c.total, 0);
T('byPillar totals reconcile', pillarTotal === idx.total);
const pillarFw = Object.values(idx.byPillar).reduce((a, c) => a + c.framework, 0);
T('byPillar framework reconciles', pillarFw === idx.frameworkCount);

// classifyInvocation is stable for a known framework file if one exists
const fwEntry = idx.entries.find((e) => e.invocation === 'bun test');
if (fwEntry) {
  T('classifyInvocation stable on a framework file',
    classifyInvocation(fwEntry.file, ROOT) === 'bun test');
} else {
  T('classifyInvocation stable on a framework file (none present — skip)', true);
}
const saEntry = idx.entries.find((e) => e.invocation === 'bun');
if (saEntry) {
  T('classifyInvocation stable on a standalone file',
    classifyInvocation(saEntry.file, ROOT) === 'bun');
}

// idempotent: two runs agree exactly
const idx2 = indexTests(ROOT);
T('indexTests is deterministic', idx2.total === idx.total &&
  JSON.stringify(idx2.entries) === JSON.stringify(idx.entries));

const total = pass + fail;
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
