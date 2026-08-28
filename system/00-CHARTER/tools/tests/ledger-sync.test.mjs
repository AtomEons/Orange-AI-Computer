#!/usr/bin/env bun
// Standalone test harness for ledger-sync.mjs (no framework import).
// Tests the pure block renderer + marker splicer without spawning the verifier.
// Run:  bun 00-CHARTER/tools/tests/ledger-sync.test.mjs

import {
  renderClosedBlock, spliceBetweenMarkers, MARK_START, MARK_END,
} from '../ledger-sync.mjs';

let pass = 0, fail = 0;
const T = (name, cond) => {
  if (cond) { pass++; console.log(`  PASS ${name}`); }
  else { fail++; console.log(`  FAIL ${name}`); }
};

const FIXED = new Date('2026-07-04T18:00:00.000Z');

// ---------- all-green payload ----------
const greenBlock = renderClosedBlock({ total: 58, green: 58, red: 0, reds: [] }, FIXED);
T('green block has start marker', greenBlock.includes(MARK_START));
T('green block has end marker', greenBlock.includes(MARK_END));
T('green block headline count', greenBlock.includes('58 / 58 test files GREEN (100%)'));
T('green block says full surface green', greenBlock.includes('Full surface green'));
T('green block has NO red table', !greenBlock.includes('STILL RED'));
T('green block stamps time', greenBlock.includes('2026-07-04T18:00:00.000Z'));

// ---------- red payload ----------
const redBlock = renderClosedBlock({
  total: 58, green: 52, red: 2,
  reds: [
    { file: '11-MIRAGE/atoms/store.test.mjs', code: 1, timedOut: false, tail: 'NOT NULL constraint failed' },
    { file: '08-HERMES/lease-engine.test.mjs', code: null, timedOut: true, tail: 'killed after 120000ms' },
  ],
}, FIXED);
T('red block headline count', redBlock.includes('52 / 58 test files GREEN'));
T('red block flags reds OPEN', redBlock.includes('2 RED remain OPEN'));
T('red block has STILL RED table', redBlock.includes('### STILL RED — not closed'));
T('red block lists mirage file', redBlock.includes('11-MIRAGE/atoms/store.test.mjs'));
T('red block lists hermes file', redBlock.includes('08-HERMES/lease-engine.test.mjs'));
T('red block shows timed out yes', /killed after 120000ms/.test(redBlock));
T('red block escapes pipes in tail', !/NOT NULL \| constraint/.test(redBlock));

// ---------- splice ----------
const doc = [
  '# Ledger',
  'some prose above',
  MARK_START,
  'OLD AUTO CONTENT',
  MARK_END,
  'some prose below',
].join('\n');
const { spliced, content } = spliceBetweenMarkers(doc, greenBlock);
T('splice succeeds when markers present', spliced === true);
T('splice preserves prose above', content.includes('some prose above'));
T('splice preserves prose below', content.includes('some prose below'));
T('splice replaced old content', !content.includes('OLD AUTO CONTENT'));
T('splice inserted new headline', content.includes('58 / 58 test files GREEN'));
T('splice has exactly one start marker', content.split(MARK_START).length - 1 === 1);
T('splice has exactly one end marker', content.split(MARK_END).length - 1 === 1);

// ---------- splice refuses when markers absent ----------
const noMarkers = '# Ledger\n\njust prose, no markers here\n';
const res2 = spliceBetweenMarkers(noMarkers, greenBlock);
T('splice refuses without markers', res2.spliced === false);
T('splice returns doc unchanged when no markers', res2.content === noMarkers);

// idempotency: splicing twice yields the same document
const once = spliceBetweenMarkers(doc, greenBlock).content;
const twice = spliceBetweenMarkers(once, greenBlock).content;
T('splice is idempotent', once === twice);

const total = pass + fail;
console.log(`Summary: ${pass} pass / ${fail} fail of ${total}`);
process.exit(fail === 0 ? 0 : 1);
